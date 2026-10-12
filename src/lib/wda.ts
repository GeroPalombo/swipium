import { XMLParser } from 'fast-xml-parser';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { run } from './spawn.js';
import { currentSignal, sleepOrCancel, throwIfCancelled } from './abortScope.js';
import type { FailureCode } from '../oracle/failures.js';

/** Is `raw` a loopback WebDriverAgent URL (http/https to 127.0.0.0/8, localhost, or ::1)?
 *  Note: WHATWG `URL.hostname` keeps the brackets for IPv6 ("[::1]"). */
export function isLoopbackWdaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** User-level pre-approval of remote (non-loopback) WDA URLs: SWIPIUM_ALLOW_REMOTE_WDA, a
 *  comma-separated list of exact base URLs set in the USER's environment (MCP client config).
 *  The repository's .swipium/config.json can NOT pre-approve a remote WDA (a checkout must not
 *  be able to point iOS automation at someone else's machine). */
export const REMOTE_WDA_ENV = 'SWIPIUM_ALLOW_REMOTE_WDA';
export function remoteWdaAllowedByUser(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, '');
  const list = (env[REMOTE_WDA_ENV] ?? '').split(',').map(norm).filter(Boolean);
  return list.includes(norm(url));
}

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

/** Page-source attributes skipped by default (`/source?excluded_attributes=`). `visible` and
 * `accessible` are the costliest XCTest lookups; normalizeWdaSource treats a missing `visible` as
 * true and the snapshot parser drops off-screen nodes by bounds. Override (or set "" to keep
 * them) with ios.wda.settings.pageSourceExcludedAttributes. */
export const WDA_DEFAULT_EXCLUDED_ATTRIBUTES = 'visible,accessible';

/** WDA session settings applied unless the user sets them in ios.wda.settings (seconds).
 * WDA defaults are waitForIdleTimeout 10, animationCoolOffTimeout 2, accessibilityDeadline 0
 * (unbounded; the setting exists since WDA 16.8 and older builds ignore unknown settings).
 * The deadline stays under the 30 s /source HTTP timeout so a frozen app fails inside WDA.
 * respectSystemAlerts: a SpringBoard alert (a permission prompt) counts as the active app, so the
 * page source shows the alert and its buttons instead of the covered app (IOS-4). */
export const WDA_DEFAULT_SETTINGS: Readonly<Record<string, number | boolean>> = Object.freeze({
  waitForIdleTimeout: 1.5,
  animationCoolOffTimeout: 0.5,
  accessibilityDeadline: 20,
  respectSystemAlerts: true,
});

/** Excluded page-source attributes per WDA session (`baseUrl:sessionId`), set by createWdaSession. */
const excludedAttributesBySession = new Map<string, string>();

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

function sessionKey(baseUrl: string, sessionId: string): string {
  return `${normalizeUrl(baseUrl)}:${sessionId}`;
}

/** Per-call options for WDA HTTP requests. Threaded implicitly (AsyncLocalStorage) so every
 * helper below inherits the caller's cancellation signal without a parameter on each one. */
export interface WdaCallOptions {
  /** Job/tool cancellation. Aborts the in-flight HTTP request. */
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
 * simulators manage ~10-30 chars/s), capped at TYPING_TIMEOUT_CAP_MS. */
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
    // not JSON, no scaling
  }
  return 0;
}

/** IOS NEW-A: cap for creating a session for an app that was JUST launched (prepare's attach, the
 *  smoke's launch). A healthy WDA does that in a few seconds; one hung at session creation used to
 *  hold the run for the full 60 s default below and then drop to visual-only. */
export const WDA_SESSION_CREATE_MS = 15_000;

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
  // Defensive fallback for runtimes without AbortSignal.any (Node >= 22.12 has it).
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
  // The per-call cancellation scope (abortScope) applies even outside withWdaCall, e.g. session
  // creation or helpers invoked directly by a driver method.
  const scoped = currentSignal();
  const signal = anySignal([
    timeout,
    ...(call.signal ? [call.signal] : []),
    ...(scoped && scoped !== call.signal ? [scoped] : []),
    ...(init?.signal ? [init.signal] : []),
  ]);
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
  // Cancellation (abortScope): a cancelled call throws CancelledError instead of polling /status
  // until the startup timeout.
  while (Date.now() - started < timeoutMs) {
    throwIfCancelled();
    status = await checkWda(baseUrl, Math.min(1500, Math.max(250, intervalMs)));
    if (status.ready) return { ready: true, status, durationMs: Date.now() - started };
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    await sleepOrCancel(Math.min(intervalMs, remaining));
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

function defaultGlobalNodeModules(env: NodeJS.ProcessEnv): string[] {
  return [
    env.npm_config_prefix ? join(env.npm_config_prefix, 'lib', 'node_modules') : undefined,
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules'),
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
  ].filter((p): p is string => !!p);
}

/** Standard user-level install locations of Appium's WebDriverAgent (appium-webdriveragent),
 *  most specific first: `$APPIUM_HOME` / `~/.appium` (the xcuitest driver's nested copy, then any
 *  appium-webdriveragent found by a bounded walk of its node_modules trees), then the global npm
 *  roots (`$npm_config_prefix`, next to the running node, Homebrew, /usr/local). These are
 *  installed by the user (not arriving with a repository checkout), so managed WDA may use them
 *  when no wdaProjectPath is given. `home` is injectable for tests. */
export function discoverAppiumWdaProjects(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  globalRoots: string[] = defaultGlobalNodeModules(env),
): string[] {
  const XCODEPROJ = 'WebDriverAgent.xcodeproj';
  const found: string[] = [];
  const add = (p: string) => {
    if (!found.includes(p) && existsSync(p)) found.push(p);
  };
  const appiumHomes = [env.APPIUM_HOME, join(home, '.appium')].filter((p): p is string => !!p && p.trim().length > 0);
  for (const ah of appiumHomes) {
    add(join(ah, 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent', XCODEPROJ));
    add(join(ah, 'node_modules', 'appium-webdriveragent', XCODEPROJ));
    // Bounded walk (~/.appium/**/appium-webdriveragent/WebDriverAgent.xcodeproj): only descend
    // node_modules chains and package dirs, at most 6 levels deep.
    const stack: Array<{ path: string; depth: number }> = [{ path: ah, depth: 0 }];
    let visited = 0;
    while (stack.length && visited < 5000) {
      const cur = stack.pop()!;
      visited++;
      if (cur.depth > 6) continue;
      let entries: string[];
      try {
        entries = readdirSync(cur.path);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.startsWith('.') && cur.depth > 0) continue;
        const p = join(cur.path, name);
        if (name === 'appium-webdriveragent') {
          add(join(p, XCODEPROJ));
          continue;
        }
        const parent = cur.path.split(/[\\/]/).pop() ?? '';
        // Descend node_modules dirs, the packages inside them, and @scope dirs' packages.
        if (name === 'node_modules' || parent === 'node_modules' || parent.startsWith('@')) {
          try {
            if (statSync(p).isDirectory()) stack.push({ path: p, depth: cur.depth + 1 });
          } catch {
            /* unreadable entry */
          }
        }
      }
    }
  }
  for (const root of globalRoots) {
    add(join(root, 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent', XCODEPROJ));
    add(join(root, 'appium', 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent', XCODEPROJ));
    add(join(root, 'appium-webdriveragent', XCODEPROJ));
  }
  return found;
}

/** Project-local WDA candidates PLUS the user-installed Appium WebDriverAgent that qa_wda
 *  setup/build/start auto-use, so doctor/status report the same discovery result setup acts on. */
export function discoverWdaProjectsWithAppium(root: string, extraCandidates: string[] = []): WdaProjectDiscovery {
  const local = discoverWdaProjects(root, extraCandidates);
  const appium = discoverAppiumWdaProjects();
  const appiumRoots = [process.env.APPIUM_HOME, join(homedir(), '.appium'), ...defaultGlobalNodeModules(process.env)].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  return {
    candidates: [...new Set([...local.candidates, ...appium])],
    searchedRoots: [...new Set([...local.searchedRoots, ...appiumRoots])],
  };
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

/** Simulator UDIDs are UUIDs (8-4-4-4-12 hex); device UDIDs are 8-16 or 40 hex. */
export function isSimulatorUdid(udid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(udid);
}

/** The newest `<scheme>_<platform>*.xctestrun` that a previous build-for-testing left under
 * `<derivedDataPath>/Build/Products` for the UDID's platform (iphonesimulator vs iphoneos). When it
 * exists, `test-without-building` can start WDA without building again. */
export function findWdaXctestrun(derivedDataPath: string, udid: string, scheme = 'WebDriverAgentRunner'): string | undefined {
  const dir = join(derivedDataPath, 'Build', 'Products');
  const prefix = `${scheme}_${isSimulatorUdid(udid) ? 'iphonesimulator' : 'iphoneos'}`;
  let best: { path: string; mtime: number } | undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.xctestrun')) continue;
    const p = join(dir, name);
    try {
      const mtime = statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    } catch {
      /* raced away */
    }
  }
  return best?.path;
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
  // WDA answered with an HTTP error, so it IS reachable: "Timed out attempting to launch app" is a
  // launch failure, not WDA_UNREACHABLE.
  if (/WDA HTTP \d{3}/.test(message) && !/bundle id|bundle identifier|not.*installed|no such application/i.test(message)) {
    return /launch/i.test(message) ? 'APP_LAUNCH_FAILED' : 'WDA_SESSION_FAILED';
  }
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
 * W3C `capabilities.alwaysMatch`/`firstMatch` via FBParseCapabilities; `desiredCapabilities` is
 * ignored). */
export const WDA_REUSE_RUNNING_APP_CAPABILITIES = Object.freeze({ forceAppLaunch: false, shouldTerminateApp: false });

/**
 * POST /session. App-lifecycle rules (WebDriverAgent FBSessionCommands.handleCreateSession):
 *  - A new session FIRST kills the active one; that teardown terminates the old session's app when
 *    the OLD session's `shouldTerminateApp` (default YES, reset per session) is set. The NEW
 *    request's caps are applied only afterwards. So every bundle-bound session defaults to
 *    `shouldTerminateApp:false` (a caller/config value wins), otherwise a later rebind/recovery
 *    would kill the app no matter what that later request sends. Launch behaviour is unchanged.
 *  - `forceAppLaunch` defaults to YES (a running app is relaunched). `reuseRunningApp` forces
 *    `forceAppLaunch:false` + `shouldTerminateApp:false` for rebind/recovery.
 */
export async function createWdaSession(baseUrl: string, opts: WdaSessionOptions = {}): Promise<WdaSession> {
  const { pageSourceExcludedAttributes, ...userSettings } = opts.settings ?? {};
  const settings: Record<string, unknown> = { ...WDA_DEFAULT_SETTINGS, ...userSettings };
  const alwaysMatch: Record<string, unknown> = {
    // WDA reads these two straight from the capabilities before launching the app.
    waitForIdleTimeout: settings.waitForIdleTimeout,
    accessibilityDeadline: settings.accessibilityDeadline,
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
  excludedAttributesBySession.set(
    sessionKey(baseUrl, sessionId),
    pageSourceExcludedAttributes === undefined
      ? WDA_DEFAULT_EXCLUDED_ATTRIBUTES
      : Array.isArray(pageSourceExcludedAttributes)
        ? pageSourceExcludedAttributes.join(',')
        : String(pageSourceExcludedAttributes ?? ''),
  );
  // WDA ignores `settings[...]` capabilities (an Appium driver convention) and resets its settings
  // on every new session, so apply them through the settings endpoint. Best effort: unknown keys
  // are skipped by WDA, and an old WDA without the route keeps its defaults.
  await wdaFetch(baseUrl, `/session/${sessionId}/appium/settings`, { method: 'POST', body: JSON.stringify({ settings }) }).catch(
    () => undefined,
  );
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
  excludedAttributesBySession.delete(sessionKey(baseUrl, sessionId));
  await wdaFetch(baseUrl, `/session/${sessionId}`, { method: 'DELETE' });
}

export async function wdaScreenshot(baseUrl: string, sessionId: string): Promise<Buffer> {
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/screenshot`);
  return Buffer.from(String(valueOf<string>(json)), 'base64');
}

/** Screen size in points via GET /session/:id/window/size. Far cheaper than dumping the
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

/** Page source XML. Skips the session's excluded attributes (WDA_DEFAULT_EXCLUDED_ATTRIBUTES unless
 * the user configured pageSourceExcludedAttributes; also the default for sessions created elsewhere). */
export async function wdaSource(baseUrl: string, sessionId: string): Promise<string> {
  const excluded = excludedAttributesBySession.get(sessionKey(baseUrl, sessionId)) ?? WDA_DEFAULT_EXCLUDED_ATTRIBUTES;
  const query = excluded ? `?excluded_attributes=${encodeURIComponent(excluded).replace(/%2C/gi, ',')}` : '';
  const json = await wdaFetch<unknown>(baseUrl, `/session/${sessionId}/source${query}`);
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

/** Read one element attribute (e.g. `type` > XCUIElementTypeSecureTextField). Empty string when unset. */
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

/** Coordinate tap (POST /session/:id/wda/tap, WDA >= 6.0). The pre-6.0 `/wda/tap/0` route was
 * removed upstream in 2024 and current Xcode cannot build those WDA versions, so no fallback. */
export async function tapWdaPoint(baseUrl: string, sessionId: string, x: number, y: number): Promise<void> {
  await wdaFetch(baseUrl, `/session/${sessionId}/wda/tap`, { method: 'POST', body: JSON.stringify({ x, y }) });
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

/** Home button. WebDriverAgent registers `/wda/homescreen` WITHOUT a session
 *  (FBCustomCommands.m: `[FBRoute POST:@"/wda/homescreen"].withoutSession`), so the
 *  `/session/:id/wda/homescreen` form 404s ("Unhandled endpoint"). */
export async function pressWdaHome(baseUrl: string): Promise<void> {
  await wdaFetch(baseUrl, '/wda/homescreen', { method: 'POST', body: '{}' });
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
 * The accessibility identifier of a WDA source node. WDA's XML has no `identifier` attribute:
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

type Rect = [number, number, number, number];

/** Context for sources fetched without `visible` (WDA_DEFAULT_EXCLUDED_ATTRIBUTES): content that
 * scrolled under the top or bottom bars (or the status bar above a navigation bar), under the
 * keyboard, or behind a later layer of its window (an alert or sheet) keeps on-screen bounds, so a
 * node whose center is off-screen or under one of those is not clickable, as WDA's own `visible`
 * would have said. */
interface VisibilityContext {
  screen: [number, number];
  /** Bars and the keyboard (barOccluders); a node inside one of them is exempt. */
  bars: Rect[];
  /** Later layers of the node's window (an alert, a sheet); they hide bar content too. */
  layers: Rect[];
  inBar: boolean;
}

/** Bars and the keyboard: they hide what lies under them, never their own content. */
const IOS_BAR_RE = /^XCUIElementType(?:NavigationBar|TabBar|Toolbar|Keyboard)$/;

function childNodes(node: Record<string, unknown>): Record<string, unknown>[] {
  return Object.entries(node)
    .filter(([k]) => k === 'children' || k.startsWith('XCUIElementType'))
    .flatMap(([, v]) => (Array.isArray(v) ? v : v ? [v] : [])) as Record<string, unknown>[];
}

function nodeRect(n: Record<string, unknown>): Rect {
  const x = Number(n.x ?? 0);
  const y = Number(n.y ?? 0);
  return [x, y, x + Number(n.width ?? 0), y + Number(n.height ?? 0)];
}

/** Bars extend to the screen edge they sit on: a top bar also covers the status bar above it. */
function barOccluders(root: Record<string, unknown>, screen: [number, number]): Rect[] {
  const out: Rect[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (IOS_BAR_RE.test(String(n.type ?? ''))) {
      const [, y1, , y2] = nodeRect(n);
      if (y2 > y1)
        out.push(y1 < screen[1] / 3 ? [0, 0, screen[0], y2] : y2 > (screen[1] * 2) / 3 ? [0, y1, screen[0], screen[1]] : nodeRect(n));
      continue;
    }
    stack.push(...childNodes(n));
  }
  return out;
}

/** The area a window layer covers. Single-child wrappers are skipped, since a sheet's container is
 * full-screen while the sheet itself starts lower. */
function layerRect(n: Record<string, unknown>): Rect {
  for (let kids = childNodes(n); kids.length === 1; kids = childNodes(n)) n = kids[0];
  return nodeRect(n);
}

function hiddenByContext(node: Record<string, unknown>, ctx: VisibilityContext | undefined): boolean {
  if (!ctx) return false;
  const [x1, y1, x2, y2] = nodeRect(node);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const covered = (rects: Rect[]) => rects.some(([a, b, c, d]) => cx >= a && cx <= c && cy >= b && cy <= d);
  if (covered(ctx.layers)) return true;
  if (ctx.inBar) return false;
  if (cx < 0 || cy < 0 || cx > ctx.screen[0] || cy > ctx.screen[1]) return true;
  return covered(ctx.bars);
}

/** Internal view-class names that a name-only node exposes instead of a label
 *  (`IOSCardsOverlay.OverlayVC.OverlayView`, `ChromeViewController.Viewport`, `AnnotationContainer`). */
const CLASS_NAME_LABEL_RE =
  /^(?:[A-Z][A-Za-z0-9_]*\.)+[A-Z][A-Za-z0-9_]*$|^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*(?:View|Container|Controller|Viewport|Overlay|Layer|Window|VC|Button)$/;
/** SF Symbol / asset names (`chevron`, `chevron.forward`, `apple.id`, `xmark`): one lowercase token.
 *  A spoken image label is a word or phrase in sentence case ("Close", "Search"). */
const SYMBOL_NAME_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
/** A row's disclosure chevron (`chevron`, `chevron.forward`): pure decoration whatever its type, and
 *  its SF Symbol label ("Forward") names nothing on screen (IOS-11 R3). */
const CHEVRON_RE = /^chevron(?:\.[a-z.]+)?$/;
/** A scroll view's position value ("0 %", "45%"): read by VoiceOver on scroll indicators, never a name. */
const SCROLL_POSITION_RE = /^\d{1,3}\s?%$/;
/** Types whose percentage value is real state (a slider's position, a progress bar). */
const PERCENT_VALUE_TYPE_RE = /Slider|ProgressIndicator|Stepper|TextField|TextView|SearchField/;

/** A label that names no visible text (IOS-11): an image's symbol/asset name, a chevron, or a
 *  view-class name a node exposes only through `name` (no `label`). Such nodes are listed as unlabeled. */
function decorativeLabel(type: string, node: Record<string, unknown>): boolean {
  const shown = String(node.label ?? node.name ?? '');
  // IOS-11 R4: Settings rows expose the chevron as the label, the name, or (no label) the value, and
  // not always on an Image / Other / StaticText node: a non-control node named "chevron" is decoration.
  const chevron = [shown || String(node.value ?? ''), String(node.name ?? '')].some((v) => CHEVRON_RE.test(v.trim()));
  if (chevron && !/Button|Cell|Link|Switch|Tab|Key\b|TextField|TextView|SearchField/.test(type)) return true;
  if (!shown) return false;
  if (type === 'XCUIElementTypeImage' && (node.label == null || SYMBOL_NAME_RE.test(shown))) return true;
  return node.label == null && node.value == null && CLASS_NAME_LABEL_RE.test(shown);
}

/** A scroll indicator (`XCUIElementTypeOther`, value "0 %", label "Vertical scroll bar, 2 pages" or
 *  none): not a target, and inside an alert it sits over the bottom button (IOS R3 NEW-8). */
function scrollIndicator(type: string, node: Record<string, unknown>): boolean {
  if (type !== 'XCUIElementTypeOther' || !SCROLL_POSITION_RE.test(String(node.value ?? '').trim())) return false;
  const label = String(node.label ?? node.name ?? '');
  return !label || /scroll bar/i.test(label);
}

function normalizeNode(node: Record<string, unknown>, ctx?: VisibilityContext): Record<string, unknown> {
  const type = String(node.type ?? node.name ?? 'XCUIElementTypeOther');
  const indicator = scrollIndicator(type, node);
  const decorative = indicator || decorativeLabel(type, node);
  // A name-only identifier (`PageFormatMenuButton`, before WDA fills the label) stays the id.
  // A chevron's name is not an identifier either (IOS-11).
  const nameId = node.name != null && !CHEVRON_RE.test(String(node.name).trim()) ? String(node.name) : '';
  const id = wdaNodeIdentifier(node) || (decorative && !indicator && node.label == null ? nameId : '');
  const label = decorative ? '' : String(node.label ?? node.name ?? '');
  // A scroll position ("0 %") is not a name: drop it unless the type carries a real percentage.
  const rawValue = String(node.value ?? '');
  const value =
    (SCROLL_POSITION_RE.test(rawValue.trim()) && !PERCENT_VALUE_TYPE_RE.test(type)) || (decorative && CHEVRON_RE.test(rawValue.trim()))
      ? ''
      : rawValue;
  const enabled = node.enabled == null ? true : bool(node.enabled);
  const isBar = IOS_BAR_RE.test(type);
  const visible = node.visible == null ? isBar || !hiddenByContext(node, ctx) : bool(node.visible);
  const textInput = IOS_TEXT_INPUT_RE.test(type);
  // Keyboard keys are tappable (IOS-8). Images are not: an icon / chevron inside a row is not its
  // own target, and listing each one as an unlabeled [button] flooded table rows (IOS-11).
  const typeLooksInteractive = textInput || /Button|Cell|Link|Switch|Tab|Key\b/i.test(type);
  const clickable = !indicator && (node.hittable == null ? enabled && visible && typeLooksInteractive : bool(node.hittable));
  const childValues = childNodes(node);
  const childCtx = ctx && !ctx.inBar && isBar ? { ...ctx, inBar: true } : ctx;
  // A window's children paint back to front: a later one (an alert, a sheet) hides earlier ones.
  const layered = !!ctx && type === 'XCUIElementTypeWindow' && childValues.length > 1;
  const ctxFor = (i: number): VisibilityContext | undefined =>
    layered ? { ...ctx!, layers: [...ctx!.layers, ...childValues.slice(i + 1).map(layerRect)] } : childCtx;
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
  if (childValues.length) out.node = childValues.map((c, i) => normalizeNode(c, ctxFor(i)));
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
  const typed = { ...root, type: root.type ?? rootKey };
  const [, , w, h] = nodeRect(typed);
  // Only for sources without `visible` (the lean default); a full source keeps WDA's verdict.
  const ctx =
    root.visible == null && w > 0 && h > 0
      ? { screen: [w, h] as [number, number], bars: [] as Rect[], layers: [] as Rect[], inBar: false }
      : undefined;
  if (ctx) ctx.bars = barOccluders(typed, ctx.screen);
  const normalized = normalizeNode(typed, ctx);
  return `<hierarchy>${nodeXml(normalized)}</hierarchy>`;
}
