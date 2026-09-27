import { XMLParser } from 'fast-xml-parser';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  /** Re-create a session over an app that is ALREADY running (restart rebind / invalid-session
   * recovery): sends `forceAppLaunch:false` (don't relaunch it) + `shouldTerminateApp:false`
   * (don't terminate it when this session is later replaced/deleted). Overrides config caps.
   * Only meaningful with `bundleId`. See createWdaSession. */
  reuseRunningApp?: boolean;
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

/** Per-call options for WDA HTTP requests. Threaded implicitly (AsyncLocalStorage) so every
 * helper below inherits the caller's cancellation signal without a parameter on each one. */
export interface WdaCallOptions {
  /** Job/tool cancellation — aborts the in-flight HTTP request. */
  signal?: AbortSignal;
  /** Overrides the per-endpoint default timeout (wdaRequestTimeoutMs). */
  timeoutMs?: number;
}

const wdaCallContext = new AsyncLocalStorage<WdaCallOptions>();

/** Run `fn` with WDA call options (signal/timeout) applied to every wdaFetch inside it. */
export function withWdaCall<T>(call: WdaCallOptions, fn: () => Promise<T>): Promise<T> {
  // Nested calls inherit the outer options; only the fields given here override them.
  const outer = wdaCallContext.getStore() ?? {};
  return wdaCallContext.run({ signal: call.signal ?? outer.signal, timeoutMs: call.timeoutMs ?? outer.timeoutMs }, fn);
}

/** Typing endpoints get this much extra time per character (WDA types key by key, and slow
 * simulators manage ~10–30 chars/s), capped at TYPING_TIMEOUT_CAP_MS. */
export const TYPING_TIMEOUT_PER_CHAR_MS = 50;
export const TYPING_TIMEOUT_CAP_MS = 5 * 60_000;
const BASE_TIMEOUT_MS = 15_000;

/** Number of characters a typing request (element/value, /wda/keys) will send. */
function typedLength(body: unknown): number {
  if (typeof body !== 'string' || !body) return 0;
  try {
    const j = JSON.parse(body) as { text?: unknown; value?: unknown };
    if (Array.isArray(j.value)) return j.value.reduce<number>((n, v) => n + [...String(v)].length, 0);
    if (typeof j.text === 'string') return [...j.text].length;
  } catch {
    // not JSON — no scaling
  }
  return 0;
}

/** Default HTTP timeout per endpoint: page source is WDA's slowest call; session creation may
 * launch the app; typing scales with the text length (15 s + 50 ms/char, ≤ 5 min); everything
 * else (taps, finds) must answer within seconds. */
export function wdaRequestTimeoutMs(method: string, path: string, body?: unknown): number {
  if (/\/source(\?|$)/.test(path)) return 30_000;
  if (method === 'POST' && /^\/session\/?$/.test(path)) return 60_000;
  if (/\/screenshot$/.test(path)) return 20_000;
  if (method === 'POST' && /\/element\/[^/]+\/value$|\/wda\/keys$/.test(path)) {
    return Math.min(TYPING_TIMEOUT_CAP_MS, BASE_TIMEOUT_MS + TYPING_TIMEOUT_PER_CHAR_MS * typedLength(body));
  }
  return BASE_TIMEOUT_MS;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any(signals);
  // Node 20.0-20.2 lack AbortSignal.any — forward the first abort manually.
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

/** True when WDA says the session id is gone (WDA restarted / session reaped). */
export function isInvalidWdaSession(e: unknown): boolean {
  const msg = e instanceof WdaHttpError ? `${e.message} ${e.body}` : String((e as Error)?.message ?? e);
  return /invalid session id|session (?:id )?(?:\S+ )?(?:does not exist|not found)|no such session/i.test(msg);
}

async function wdaFetch<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const call = wdaCallContext.getStore() ?? {};
  const timeoutMs = call.timeoutMs ?? wdaRequestTimeoutMs(method, path, init?.body);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = anySignal([timeout, ...(call.signal ? [call.signal] : []), ...(init?.signal ? [init.signal] : [])]);
  let res: Response;
  let body: string;
  try {
    res = await fetch(`${normalizeUrl(baseUrl)}${path}`, {
      ...init,
      signal,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    body = (await res.text()) || '{}';
  } catch (e) {
    if (timeout.aborted) throw new Error(`WDA ${method} ${path} timed out after ${timeoutMs}ms`, { cause: e });
    if (signal.aborted) throw new Error(`WDA ${method} ${path} aborted (cancelled)`, { cause: e });
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`WDA returned non-JSON ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg =
      typeof (json as { value?: { message?: unknown }; message?: unknown }).value?.message === 'string'
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
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [`settings[${key}]`, value]));
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
      build: typeof value.build === 'object' && value.build ? (value.build as Record<string, unknown>) : undefined,
      os: typeof value.os === 'object' && value.os ? (value.os as Record<string, unknown>) : undefined,
      ios: typeof value.ios === 'object' && value.ios ? (value.ios as Record<string, unknown>) : undefined,
    };
  } catch (e) {
    return { reachable: false, ready: false, error: String((e as Error).message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

export async function waitForWdaReady(
  baseUrl: string,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<{ ready: boolean; status: WdaStatus; durationMs: number }> {
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
    '-project',
    opts.projectPath,
    '-scheme',
    opts.scheme ?? 'WebDriverAgentRunner',
    '-destination',
    `id=${opts.udid}`,
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
    '-project',
    opts.projectPath,
    '-scheme',
    opts.scheme ?? 'WebDriverAgentRunner',
    '-destination',
    `id=${opts.udid}`,
    ...(opts.derivedDataPath ? ['-derivedDataPath', opts.derivedDataPath] : []),
    ...(opts.developmentTeam ? [`DEVELOPMENT_TEAM=${opts.developmentTeam}`] : []),
    ...(opts.bundleId ? [`PRODUCT_BUNDLE_IDENTIFIER=${opts.bundleId}`] : []),
    ...(opts.codeSignStyle ? [`CODE_SIGN_STYLE=${opts.codeSignStyle}`] : []),
    'test-without-building',
  ];
}

export function classifyWdaBuildFailure(log: string): FailureCode {
  if (
    /Signing for .* requires a development team|No profiles for|provisioning profile|Code signing is required|requires a provisioning profile|No signing certificate|No Accounts|Development Team/i.test(
      log,
    )
  ) {
    return 'WDA_SIGNING_FAILED';
  }
  return 'WDA_BUILD_FAILED';
}

export function classifyWdaConnectionFailure(message: string): FailureCode {
  if (/EADDRINUSE|address already in use|port .*in use|bind.*address/i.test(message)) return 'WDA_PORT_CONFLICT';
  if (/ECONNREFUSED|fetch failed|timed out|aborted|network|socket|unreachable/i.test(message)) return 'WDA_UNREACHABLE';
  if (
    /bundle id|bundle identifier|application.*not.*installed|app.*not.*installed|no such application|could not.*launch.*app|failed to launch.*app/i.test(
      message,
    )
  )
    return 'BUNDLE_ID_NOT_FOUND';
  return 'WDA_SESSION_FAILED';
}

/** Capabilities that make WDA attach to a running app without relaunching it, and leave it
 * running when the session is torn down. Names verified against appium/WebDriverAgent
 * (FBCapabilities.m: FB_CAP_FORCE_APP_LAUNCH / FB_CAP_SHOULD_TERMINATE_APP; both read from the
 * W3C `capabilities.alwaysMatch`/`firstMatch` via FBParseCapabilities — `desiredCapabilities` is
 * ignored). */
export const WDA_REUSE_RUNNING_APP_CAPABILITIES = Object.freeze({ forceAppLaunch: false, shouldTerminateApp: false });

/**
 * POST /session. App-lifecycle rules (WebDriverAgent FBSessionCommands.handleCreateSession):
 *  - A new session FIRST kills the active one; that teardown terminates the old session's app when
 *    the OLD session's `shouldTerminateApp` (default YES, reset per session) is set — the NEW
 *    request's caps are applied only afterwards. So every bundle-bound session defaults to
 *    `shouldTerminateApp:false` (a caller/config value wins), otherwise a later rebind/recovery
 *    would kill the app no matter what that later request sends. Launch behaviour is unchanged.
 *  - `forceAppLaunch` defaults to YES (a running app is relaunched). `reuseRunningApp` forces
 *    `forceAppLaunch:false` + `shouldTerminateApp:false` for rebind/recovery.
 */
export async function createWdaSession(baseUrl: string, opts: WdaSessionOptions = {}): Promise<WdaSession> {
  const alwaysMatch: Record<string, unknown> = {
    ...(opts.capabilities ?? {}),
    ...settingsCapabilities(opts.settings),
  };
  if (opts.bundleId) {
    alwaysMatch.bundleId = opts.bundleId;
    if (opts.reuseRunningApp) Object.assign(alwaysMatch, WDA_REUSE_RUNNING_APP_CAPABILITIES);
    else if (alwaysMatch.shouldTerminateApp === undefined) alwaysMatch.shouldTerminateApp = false;
  }
  if (opts.udid) alwaysMatch.udid = opts.udid;
  const json = await wdaFetch<unknown>(baseUrl, '/session', {
    method: 'POST',
    body: JSON.stringify({ capabilities: { alwaysMatch } }),
  });
  const v = valueOf<Record<string, unknown>>(json);
  const sessionId = String((json as { sessionId?: unknown }).sessionId ?? v.sessionId ?? '');
  if (!sessionId) throw new Error('WDA did not return a sessionId.');
  return {
    sessionId,
    capabilities: typeof v.capabilities === 'object' && v.capabilities ? (v.capabilities as Record<string, unknown>) : undefined,
  };
}

export function wdaSessionUdid(capabilities: Record<string, unknown> | undefined): string | undefined {
  if (!capabilities) return undefined;
  for (const key of ['udid', 'deviceUDID', 'deviceUdid', 'appium:udid', 'appium:deviceUDID']) {
    const value = capabilities[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export function wdaSessionUdidMismatch(
  capabilities: Record<string, unknown> | undefined,
  expectedUdid: string | undefined,
): string | undefined {
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

/** Screen size in points via GET /session/:id/window/size — far cheaper than dumping the
 * full page source (one of WDA's slowest endpoints). Older WDA builds may not serve it. */
export async function wdaWindowSize(baseUrl: string, sessionId: string): Promise<{ width: number; height: number }> {
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/window/size`);
  const v = valueOf<{ width?: unknown; height?: unknown }>(json);
  const width = Number(v?.width);
  const height = Number(v?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(`WDA /window/size returned no usable size: ${JSON.stringify(v).slice(0, 200)}`);
  }
  return { width, height };
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

/** Read one element attribute (e.g. `type` → XCUIElementTypeSecureTextField). Empty string when unset. */
export async function wdaElementAttribute(baseUrl: string, sessionId: string, elementId: string, name: string): Promise<string> {
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/element/${elementId}/attribute/${name}`);
  const v = valueOf<unknown>(json);
  return v == null ? '' : String(v);
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
  throw new Error(
    `No keyboard-focused element found after trying ${WDA_FOCUSED_PREDICATES.join(', ')}: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
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

export async function dragWdaPoint(
  baseUrl: string,
  sessionId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  duration = 0.3,
): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/wda/dragfromtoforduration`, {
    method: 'POST',
    body: JSON.stringify({ fromX: x1, fromY: y1, toX: x2, toY: y2, duration }),
  });
}

export async function pressWdaHome(baseUrl: string, sessionId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/wda/homescreen`, { method: 'POST', body: '{}' });
}

// iOS "back" lives in WdaDriver.pressKey('back') (nav-bar back button, else a left-edge swipe).
// There is deliberately no pressWdaBack helper: WDA has no /session/:id/back route (it 404s).

export async function acceptWdaAlert(baseUrl: string, sessionId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/alert/accept`, { method: 'POST', body: '{}' });
}

/** Soft keyboard shown? One cheap lookup by class name (no page-source dump). */
export async function wdaKeyboardShown(baseUrl: string, sessionId: string): Promise<boolean> {
  return (await wdaKeyboardElementId(baseUrl, sessionId)) !== undefined;
}

async function wdaKeyboardElementId(baseUrl: string, sessionId: string): Promise<string | undefined> {
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/elements`, {
    method: 'POST',
    body: JSON.stringify({ using: 'class name', value: 'XCUIElementTypeKeyboard' }),
  });
  const list = valueOf<unknown>(json);
  if (!Array.isArray(list) || !list.length) return undefined;
  const first = list[0] as Record<string, unknown>;
  const id = String(first[ELEMENT_KEY] ?? first.ELEMENT ?? first.elementId ?? '');
  return id || undefined;
}

/** On-screen keyboard rect in points [x1,y1,x2,y2], or null when no keyboard is shown. */
export async function wdaKeyboardFrame(baseUrl: string, sessionId: string): Promise<[number, number, number, number] | null> {
  const id = await wdaKeyboardElementId(baseUrl, sessionId);
  if (!id) return null;
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/element/${id}/rect`);
  const r = valueOf<{ x?: unknown; y?: unknown; width?: unknown; height?: unknown }>(json);
  const [x, y, w, h] = [r?.x, r?.y, r?.width, r?.height].map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return [x, y, x + w, y + h];
}

/** WDA's keyboard dismissal (POST /wda/keyboard/dismiss). */
export async function dismissWdaKeyboard(baseUrl: string, sessionId: string): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/wda/keyboard/dismiss`, { method: 'POST', body: '{}' });
}

/** Current interface orientation string (e.g. PORTRAIT / LANDSCAPE). */
export async function wdaOrientation(baseUrl: string, sessionId: string): Promise<string> {
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/orientation`);
  return String(valueOf<unknown>(json) ?? '');
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

const IOS_TEXT_INPUT_RE = /XCUIElementType(?:Secure)?TextField\b|XCUIElementTypeSearchField\b|XCUIElementTypeTextView\b/;

/**
 * The accessibility identifier of a WDA source node. WDA's XML has no `identifier` attribute —
 * XCUITest reports `name` = accessibilityIdentifier when one is set, else the label. So `name`
 * counts as an id when it differs from the label (e.g. name="com.apple.settings.general",
 * label="General"); name === label (or no label) is just the label echoed back.
 */
export function wdaNodeIdentifier(node: Record<string, unknown>): string {
  if (node.identifier != null && String(node.identifier)) return String(node.identifier);
  const name = node.name == null ? '' : String(node.name);
  const label = node.label == null ? '' : String(node.label);
  return name && label && name !== label ? name : '';
}

function normalizeNode(node: Record<string, unknown>): Record<string, unknown> {
  const type = String(node.type ?? node.name ?? 'XCUIElementTypeOther');
  const id = wdaNodeIdentifier(node);
  const label = String(node.label ?? node.name ?? '');
  const value = String(node.value ?? '');
  const enabled = node.enabled == null ? true : bool(node.enabled);
  const visible = node.visible == null ? true : bool(node.visible);
  const textInput = IOS_TEXT_INPUT_RE.test(type);
  const typeLooksInteractive = textInput || /Button|Cell|Link|Switch|Tab|Image/i.test(type);
  const clickable = node.hittable == null ? enabled && visible && typeLooksInteractive : bool(node.hittable);
  const childValues = Object.entries(node)
    .filter(([k]) => k === 'children' || k.startsWith('XCUIElementType'))
    .flatMap(([, v]) => (Array.isArray(v) ? v : v ? [v] : []));
  const out: Record<string, unknown> = {
    class: type,
    text: value || label,
    'content-desc': label,
    'resource-id': id,
    bounds: iosBounds(node),
    clickable,
    'long-clickable': false,
    scrollable: /ScrollView|Table|CollectionView|Picker|WebView/i.test(type),
    focusable: textInput,
    focused: bool(node.focused),
    enabled,
    password: /SecureTextField/i.test(type),
    ...(textInput && node.placeholderValue != null ? { hint: String(node.placeholderValue) } : {}),
  };
  if (childValues.length) out.node = childValues.map((c) => normalizeNode(c as Record<string, unknown>));
  return out;
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function nodeXml(node: Record<string, unknown>): string {
  const children = Array.isArray(node.node) ? (node.node as Record<string, unknown>[]) : [];
  const attrs = Object.entries(node)
    .filter(([k]) => k !== 'node')
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(' ');
  return `<node ${attrs}>${children.map(nodeXml).join('')}</node>`;
}

export function normalizeWdaSource(xml: string): string {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => name.startsWith('XCUIElementType') || name === 'children',
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rootKey = Object.keys(doc).find((k) => k.startsWith('XCUIElementType'));
  if (!rootKey) return xml;
  const rootRaw = doc[rootKey];
  const root = (Array.isArray(rootRaw) ? rootRaw[0] : rootRaw) as Record<string, unknown>;
  const normalized = normalizeNode({ ...root, type: root.type ?? rootKey });
  return `<hierarchy>${nodeXml(normalized)}</hierarchy>`;
}
