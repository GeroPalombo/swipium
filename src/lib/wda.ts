import { XMLParser } from 'fast-xml-parser';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './spawn.js';
import type { FailureCode } from '../oracle/failures.js';

export interface WdaStatus {
  reachable: boolean;
  ready: boolean;
  message?: string;
  build?: Record<string, unknown>;
  os?: Record<string, unknown>;
  ios?: Record<string, unknown>;
  error?: string;
}

export interface WdaSession {
  sessionId: string;
  capabilities?: Record<string, unknown>;
}

export interface WdaSessionOptions {
  bundleId?: string;
  udid?: string;
  capabilities?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface WdaElementRef {
  elementId: string;
}

export interface WdaActiveAppInfo {
  bundleId?: string;
  name?: string;
  pid?: number;
}

export interface ManagedWdaOptions {
  projectPath: string;
  udid: string;
  derivedDataPath?: string;
  scheme?: string;
  developmentTeam?: string;
  allowProvisioningUpdates?: boolean;
  allowProvisioningDeviceRegistration?: boolean;
  authenticationKeyPath?: string;
  authenticationKeyId?: string;
  authenticationKeyIssuerId?: string;
  bundleId?: string;
  codeSignStyle?: 'Automatic' | 'Manual';
}

export interface WdaProjectDiscovery {
  candidates: string[];
  searchedRoots: string[];
}

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
type PointTapRoute = 'modern' | 'legacy';
const pointTapRouteBySession = new Map<string, PointTapRoute>();

export class WdaHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, message: string, body: string) {
    super(`WDA HTTP ${status}: ${message}`);
    this.name = 'WdaHttpError';
    this.status = status;
    this.body = body;
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function wdaRouteKey(baseUrl: string, sessionId: string, route: string): string {
  return `${normalizeUrl(baseUrl)}:${sessionId}:${route}`;
}

function isMissingWdaRoute(e: unknown): boolean {
  if (!(e instanceof WdaHttpError)) return false;
  if (e.status === 404) return true;
  return /unknown command|unknown route|unhandled endpoint|not found|unsupported/i.test(e.message);
}

async function wdaFetch<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${normalizeUrl(baseUrl)}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.text()) || '{}';
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`WDA returned non-JSON ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = typeof (json as { value?: { message?: unknown }; message?: unknown }).value?.message === 'string'
      ? (json as { value: { message: string } }).value.message
      : typeof (json as { message?: unknown }).message === 'string'
        ? (json as { message: string }).message
        : body.slice(0, 200);
    throw new WdaHttpError(res.status, msg, body);
  }
  return json as T;
}

function valueOf<T>(json: unknown): T {
  return (json as { value?: T }).value ?? (json as T);
}

function settingsCapabilities(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!settings) return {};
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [`settings[${key}]`, value]),
  );
}

export async function checkWda(baseUrl: string, timeoutMs = 5000): Promise<WdaStatus> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${normalizeUrl(baseUrl)}/status`, { signal: controller.signal });
    const body = (await res.text()) || '{}';
    const json = JSON.parse(body) as { value?: Record<string, unknown>; status?: number };
    const value = (json.value ?? json) as Record<string, unknown>;
    return {
      reachable: res.ok,
      ready: res.ok && (value.ready === true || json.status === 0 || value.state === 'success'),
      message: typeof value.message === 'string' ? value.message : undefined,
      build: typeof value.build === 'object' && value.build ? value.build as Record<string, unknown> : undefined,
      os: typeof value.os === 'object' && value.os ? value.os as Record<string, unknown> : undefined,
      ios: typeof value.ios === 'object' && value.ios ? value.ios as Record<string, unknown> : undefined,
    };
  } catch (e) {
    return { reachable: false, ready: false, error: String((e as Error).message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

export async function waitForWdaReady(baseUrl: string, timeoutMs: number, intervalMs = 1000): Promise<{ ready: boolean; status: WdaStatus; durationMs: number }> {
  const started = Date.now();
  let status: WdaStatus = { reachable: false, ready: false, error: 'not checked yet' };
  while (Date.now() - started < timeoutMs) {
    status = await checkWda(baseUrl, Math.min(1500, Math.max(250, intervalMs)));
    if (status.ready) return { ready: true, status, durationMs: Date.now() - started };
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  return { ready: false, status, durationMs: Date.now() - started };
}

export async function xcodeAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
  if (process.platform !== 'darwin') return { available: false, error: 'WDA requires macOS with Xcode command line tools.' };
  try {
    const r = await run('xcodebuild', ['-version'], { timeoutMs: 8000 });
    return r.code === 0 ? { available: true, version: r.stdout.trim() } : { available: false, error: r.stderr.trim() || r.stdout.trim() };
  } catch (e) {
    return { available: false, error: String(e) };
  }
}

export function discoverWdaProjects(root: string, extraCandidates: string[] = []): WdaProjectDiscovery {
  const directCandidates = [
    ...extraCandidates,
    process.env.WDA_PROJECT_PATH,
    process.env.WEBDRIVERAGENT_PROJECT,
    join(root, 'WebDriverAgent.xcodeproj'),
    join(root, 'WebDriverAgent', 'WebDriverAgent.xcodeproj'),
    join(root, 'ios', 'WebDriverAgent.xcodeproj'),
    join(root, 'ios', 'WebDriverAgent', 'WebDriverAgent.xcodeproj'),
    join(root, 'node_modules', 'appium-webdriveragent', 'WebDriverAgent.xcodeproj'),
    join(root, 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent', 'WebDriverAgent.xcodeproj'),
  ].filter((p): p is string => !!p && p.trim().length > 0);
  const found = new Set<string>();
  for (const p of directCandidates) {
    if (existsSync(p) && /WebDriverAgent\.xcodeproj$/i.test(p)) found.add(p);
  }

  const searchedRoots = [root];
  const skip = new Set(['.git', 'dist', 'build', 'DerivedData', '.swipium', 'node_modules']);
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.depth > 4) continue;
    let entries: string[];
    try {
      entries = readdirSync(cur.path);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = join(cur.path, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (/WebDriverAgent\.xcodeproj$/i.test(name)) {
        found.add(p);
        continue;
      }
      stack.push({ path: p, depth: cur.depth + 1 });
    }
  }

  return { candidates: [...found].sort(), searchedRoots };
}

export function managedWdaBuildArgs(opts: ManagedWdaOptions): string[] {
  return [
    '-project', opts.projectPath,
    '-scheme', opts.scheme ?? 'WebDriverAgentRunner',
    '-destination', `id=${opts.udid}`,
    ...(opts.derivedDataPath ? ['-derivedDataPath', opts.derivedDataPath] : []),
    ...(opts.allowProvisioningUpdates ? ['-allowProvisioningUpdates'] : []),
    ...(opts.allowProvisioningDeviceRegistration ? ['-allowProvisioningDeviceRegistration'] : []),
    ...(opts.authenticationKeyPath ? ['-authenticationKeyPath', opts.authenticationKeyPath] : []),
    ...(opts.authenticationKeyId ? ['-authenticationKeyID', opts.authenticationKeyId] : []),
    ...(opts.authenticationKeyIssuerId ? ['-authenticationKeyIssuerID', opts.authenticationKeyIssuerId] : []),
    ...(opts.developmentTeam ? [`DEVELOPMENT_TEAM=${opts.developmentTeam}`] : []),
    ...(opts.bundleId ? [`PRODUCT_BUNDLE_IDENTIFIER=${opts.bundleId}`] : []),
    ...(opts.codeSignStyle ? [`CODE_SIGN_STYLE=${opts.codeSignStyle}`] : []),
    'build-for-testing',
  ];
}

export function managedWdaStartArgs(opts: ManagedWdaOptions): string[] {
  return [
    '-project', opts.projectPath,
    '-scheme', opts.scheme ?? 'WebDriverAgentRunner',
    '-destination', `id=${opts.udid}`,
    ...(opts.derivedDataPath ? ['-derivedDataPath', opts.derivedDataPath] : []),
    ...(opts.developmentTeam ? [`DEVELOPMENT_TEAM=${opts.developmentTeam}`] : []),
    ...(opts.bundleId ? [`PRODUCT_BUNDLE_IDENTIFIER=${opts.bundleId}`] : []),
    ...(opts.codeSignStyle ? [`CODE_SIGN_STYLE=${opts.codeSignStyle}`] : []),
    'test-without-building',
  ];
}

export function classifyWdaBuildFailure(log: string): FailureCode {
  if (/Signing for .* requires a development team|No profiles for|provisioning profile|Code signing is required|requires a provisioning profile|No signing certificate|No Accounts|Development Team/i.test(log)) {
    return 'WDA_SIGNING_FAILED';
  }
  return 'WDA_BUILD_FAILED';
}

export function classifyWdaConnectionFailure(message: string): FailureCode {
  if (/EADDRINUSE|address already in use|port .*in use|bind.*address/i.test(message)) return 'WDA_PORT_CONFLICT';
  if (/ECONNREFUSED|fetch failed|timed out|aborted|network|socket|unreachable/i.test(message)) return 'WDA_UNREACHABLE';
  if (/bundle id|bundle identifier|application.*not.*installed|app.*not.*installed|no such application|could not.*launch.*app|failed to launch.*app/i.test(message)) return 'BUNDLE_ID_NOT_FOUND';
  return 'WDA_SESSION_FAILED';
}

export async function createWdaSession(baseUrl: string, opts: WdaSessionOptions = {}): Promise<WdaSession> {
  const alwaysMatch: Record<string, unknown> = {
    ...(opts.capabilities ?? {}),
    ...settingsCapabilities(opts.settings),
  };
  if (opts.bundleId) alwaysMatch.bundleId = opts.bundleId;
  if (opts.udid) alwaysMatch.udid = opts.udid;
  const json = await wdaFetch<unknown>(baseUrl, '/session', {
    method: 'POST',
    body: JSON.stringify({ capabilities: { alwaysMatch } }),
  });
  const v = valueOf<Record<string, unknown>>(json);
  const sessionId = String((json as { sessionId?: unknown }).sessionId ?? v.sessionId ?? '');
  if (!sessionId) throw new Error('WDA did not return a sessionId.');
  return { sessionId, capabilities: typeof v.capabilities === 'object' && v.capabilities ? v.capabilities as Record<string, unknown> : undefined };
}

export function wdaSessionUdid(capabilities: Record<string, unknown> | undefined): string | undefined {
  if (!capabilities) return undefined;
  for (const key of ['udid', 'deviceUDID', 'deviceUdid', 'appium:udid', 'appium:deviceUDID']) {
    const value = capabilities[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export function wdaSessionUdidMismatch(capabilities: Record<string, unknown> | undefined, expectedUdid: string | undefined): string | undefined {
  if (!expectedUdid) return undefined;
  const actual = wdaSessionUdid(capabilities);
  return actual && actual !== expectedUdid ? actual : undefined;
}

export async function deleteWdaSession(baseUrl: string, sessionId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}`, { method: 'DELETE' });
}

export async function wdaScreenshot(baseUrl: string, sessionId: string): Promise<Buffer> {
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/screenshot`);
  return Buffer.from(String(valueOf<string>(json)), 'base64');
}

export async function wdaSource(baseUrl: string, sessionId: string): Promise<string> {
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/source`);
  return String(valueOf<string>(json));
}

export async function wdaActiveAppInfo(baseUrl: string, sessionId: string): Promise<WdaActiveAppInfo> {
  let json: unknown;
  try {
    json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/wda/activeAppInfo`);
  } catch {
    json = await wdaFetch<unknown>(baseUrl, '/wda/activeAppInfo');
  }
  const v = valueOf<Record<string, unknown>>(json);
  return {
    bundleId: typeof v.bundleId === 'string' ? v.bundleId : undefined,
    name: typeof v.name === 'string' ? v.name : undefined,
    pid: typeof v.pid === 'number' ? v.pid : undefined,
  };
}

export async function findWdaElement(baseUrl: string, sessionId: string, using: string, value: string): Promise<WdaElementRef> {
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/element`, {
    method: 'POST',
    body: JSON.stringify({ using, value }),
  });
  const v = valueOf<Record<string, unknown>>(json);
  const elementId = String(v[ELEMENT_KEY] ?? v.ELEMENT ?? v.elementId ?? '');
  if (!elementId) throw new Error(`WDA could not resolve element using ${using}=${value}.`);
  return { elementId };
}

export async function tapWdaElement(baseUrl: string, sessionId: string, elementId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/element/${elementId}/click`, { method: 'POST', body: '{}' });
}

export async function typeWdaElement(baseUrl: string, sessionId: string, elementId: string, text: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/element/${elementId}/value`, {
    method: 'POST',
    body: JSON.stringify({ value: [...text], text }),
  });
}

export async function typeWdaKeys(baseUrl: string, sessionId: string, text: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/wda/keys`, {
    method: 'POST',
    body: JSON.stringify({ value: [...text], text }),
  });
}

export async function clearWdaElement(baseUrl: string, sessionId: string, elementId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/element/${elementId}/clear`, { method: 'POST', body: '{}' });
}

export const WDA_FOCUSED_PREDICATES = ['focused == 1', 'wdFocused == 1', 'hasKeyboardFocus == 1'] as const;

export async function findFocusedWdaElement(baseUrl: string, sessionId: string): Promise<WdaElementRef> {
  let lastErr: unknown;
  for (const predicate of WDA_FOCUSED_PREDICATES) {
    try {
      return await findWdaElement(baseUrl, sessionId, 'predicate string', predicate);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`No keyboard-focused element found after trying ${WDA_FOCUSED_PREDICATES.join(', ')}: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

export async function clearWdaFocusedByKeys(baseUrl: string, sessionId: string, approxLen = 40): Promise<void> {
  const count = Math.min(Math.max(approxLen + 2, 1), 200);
  await typeWdaKeys(baseUrl, sessionId, '\b'.repeat(count));
}

export async function tapWdaPoint(baseUrl: string, sessionId: string, x: number, y: number): Promise<void> {
  const modern = `/session/${sessionId}/wda/tap`;
  const legacy = `/session/${sessionId}/wda/tap/0`;
  const key = wdaRouteKey(baseUrl, sessionId, 'pointTap');
  const body = JSON.stringify({ x, y });
  const preferred = pointTapRouteBySession.get(key);
  if (preferred === 'legacy') {
    await wdaFetch(baseUrl, legacy, { method: 'POST', body });
    return;
  }
  try {
    await wdaFetch(baseUrl, modern, { method: 'POST', body });
    pointTapRouteBySession.set(key, 'modern');
  } catch (e) {
    if (preferred === 'modern' || !isMissingWdaRoute(e)) throw e;
    await wdaFetch(baseUrl, legacy, { method: 'POST', body });
    pointTapRouteBySession.set(key, 'legacy');
  }
}

export async function dragWdaPoint(baseUrl: string, sessionId: string, x1: number, y1: number, x2: number, y2: number, duration = 0.3): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/wda/dragfromtoforduration`, {
    method: 'POST',
    body: JSON.stringify({ fromX: x1, fromY: y1, toX: x2, toY: y2, duration }),
  });
}

export async function pressWdaHome(baseUrl: string, sessionId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/wda/homescreen`, { method: 'POST', body: '{}' });
}

export async function pressWdaBack(baseUrl: string, sessionId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/back`, { method: 'POST', body: '{}' });
}

export async function acceptWdaAlert(baseUrl: string, sessionId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/alert/accept`, { method: 'POST', body: '{}' });
}

export async function dismissWdaAlert(baseUrl: string, sessionId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/alert/dismiss`, { method: 'POST', body: '{}' });
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function iosBounds(attrs: Record<string, unknown>): string {
  const x = Number(attrs.x ?? 0);
  const y = Number(attrs.y ?? 0);
  const w = Number(attrs.width ?? 0);
  const h = Number(attrs.height ?? 0);
  return `[${Math.round(x)},${Math.round(y)}][${Math.round(x + w)},${Math.round(y + h)}]`;
}

function normalizeNode(node: Record<string, unknown>): Record<string, unknown> {
  const type = String(node.type ?? node.name ?? 'XCUIElementTypeOther');
  const id = String(node.identifier ?? '');
  const label = String(node.label ?? node.name ?? '');
  const value = String(node.value ?? '');
  const enabled = node.enabled == null ? true : bool(node.enabled);
  const visible = node.visible == null ? true : bool(node.visible);
  const typeLooksInteractive = /Button|Cell|Link|Switch|Tab|Image|TextField|SecureTextField/i.test(type);
  const clickable = node.hittable == null ? enabled && visible && typeLooksInteractive : bool(node.hittable);
  const childValues = Object.entries(node)
    .filter(([k]) => k === 'children' || k.startsWith('XCUIElementType'))
    .flatMap(([, v]) => Array.isArray(v) ? v : v ? [v] : []);
  const out: Record<string, unknown> = {
    class: type,
    text: value || label,
    'content-desc': label,
    'resource-id': id,
    bounds: iosBounds(node),
    clickable,
    'long-clickable': false,
    scrollable: /ScrollView|Table|CollectionView|Picker|WebView/i.test(type),
    focusable: /TextField|SecureTextField|TextView/i.test(type),
    focused: bool(node.focused),
    enabled,
    password: /SecureTextField/i.test(type),
  };
  if (childValues.length) out.node = childValues.map((c) => normalizeNode(c as Record<string, unknown>));
  return out;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nodeXml(node: Record<string, unknown>): string {
  const children = Array.isArray(node.node) ? node.node as Record<string, unknown>[] : [];
  const attrs = Object.entries(node)
    .filter(([k]) => k !== 'node')
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(' ');
  return `<node ${attrs}>${children.map(nodeXml).join('')}</node>`;
}

export function normalizeWdaSource(xml: string): string {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: (name) => name.startsWith('XCUIElementType') || name === 'children' });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rootKey = Object.keys(doc).find((k) => k.startsWith('XCUIElementType'));
  if (!rootKey) return xml;
  const rootRaw = doc[rootKey];
  const root = (Array.isArray(rootRaw) ? rootRaw[0] : rootRaw) as Record<string, unknown>;
  const normalized = normalizeNode({ ...root, type: root.type ?? rootKey });
  return `<hierarchy>${nodeXml(normalized)}</hierarchy>`;
}
