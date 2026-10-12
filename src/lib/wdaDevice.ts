// Which simulator does a WebDriverAgent belong to? Every simulator's WDA defaults to the same
// port (8100), so a WDA that answers /status ready may be driving ANOTHER simulator (another
// agent's, another Swipium instance's). Reusing or attaching to it would drive the wrong device
// and tear down its owner's WDA session. These helpers identify the owner before any reuse or
// session creation, and give each managed WDA its own loopback port.

import { connect, createServer } from 'node:net';
import { run } from './spawn.js';
import { checkWda, isLoopbackWdaUrl, type WdaStatus } from './wda.js';
import * as sim from './simctl.js';
import { registeredWdasForDevice } from '../session/processRegistry.js';

/** A simulator app runs from ~/Library/Developer/CoreSimulator/Devices/<UDID>/…, so the process
 *  listening on the WDA port names its simulator in its executable path. */
const SIMULATOR_PATH_RE = /\/CoreSimulator\/Devices\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\//i;

/** The TCP port of a WDA URL (explicit, else the scheme default). */
export function wdaUrlPort(url: string): number | undefined {
  try {
    const u = new URL(url);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 0);
    return port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** `url` with its port replaced. */
export function wdaUrlWithPort(url: string, port: number): string {
  const u = new URL(url);
  u.port = String(port);
  return u.toString().replace(/\/+$/, '');
}

/** PURE: the simulator UDID in a process command line (a simulator app's executable path), if any. */
export function simulatorUdidFromCommand(command: string): string | undefined {
  return command.match(SIMULATOR_PATH_RE)?.[1];
}

/** The process listening on a loopback WDA URL's port (lsof + ps, macOS only): `udid` is its
 *  simulator when it runs in one. `inspected` is false when lsof / ps failed or timed out (a loaded
 *  host), so "no simulator found" proves nothing; true when the listener was seen and is not a
 *  simulator process (or nothing listens), or the URL cannot be inspected at all (not loopback). */
async function inspectWdaListener(url: string): Promise<{ udid?: string; inspected: boolean }> {
  if (process.platform !== 'darwin' || !isLoopbackWdaUrl(url)) return { inspected: true };
  const port = wdaUrlPort(url);
  if (!port) return { inspected: true };
  const ls = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeoutMs: 4000 }).catch(() => undefined);
  // lsof exits 1 with no output when nothing listens; a timeout / spawn error leaves no result.
  if (!ls || ls.timedOut) return { inspected: false };
  const pids = (ls.stdout ?? '').split(/\s+/).filter((p) => /^\d+$/.test(p));
  let inspected = true;
  for (const pid of pids.slice(0, 5)) {
    const ps = await run('ps', ['-ww', '-o', 'command=', '-p', pid], { timeoutMs: 3000 }).catch(() => undefined);
    if (!ps || ps.timedOut) inspected = false;
    const udid = simulatorUdidFromCommand(ps?.stdout ?? '');
    if (udid) return { udid, inspected: true };
  }
  return { inspected };
}

/** The simulator whose process listens on a loopback WDA URL's port (lsof + ps, macOS only).
 *  Undefined when it cannot be told (not loopback, no listener, not a simulator process). */
export async function wdaListenerSimulatorUdid(url: string): Promise<string | undefined> {
  return (await inspectWdaListener(url)).udid;
}

export interface WdaOwnership {
  /** match: this WDA runs in the expected simulator; other: it provably belongs to another device;
   *  unverified: a local listener could not be inspected (lsof / ps failed or timed out), so it may
   *  be another simulator's: never reuse or attach it as this simulator's;
   *  unknown: could not be told (e.g. an external WDA that is not a local simulator process). */
  owner: 'match' | 'other' | 'unverified' | 'unknown';
  /** The simulator the WDA runs in, when known. */
  deviceUdid?: string;
  reason: string;
}

/** PURE: do two iOS versions agree on major.minor ("18.4" vs "18.4.1")? */
export function sameIosVersion(a: string, b: string): boolean {
  const mm = (v: string) =>
    v
      .split('.')
      .slice(0, 2)
      .map((n) => Number(n) || 0);
  const [x, y] = [mm(a), mm(b)];
  return x[0] === y[0] && (x[1] ?? 0) === (y[1] ?? 0);
}

/** The runtime ("iOS 18.4") of a simulator, from simctl. */
export async function simulatorRuntime(udid: string): Promise<string | undefined> {
  const sims = await sim.listSimulators().catch(() => []);
  return sims.find((s) => s.udid.toUpperCase() === udid.toUpperCase())?.runtime;
}

/**
 * Which device a reachable WDA drives, compared with `udid`. First the simulator path of the
 * process listening on its port; else the iOS version WDA reports (/status os.version) against the
 * simulator's runtime (a different version proves a different device; the same one proves nothing).
 */
export async function wdaDeviceOwnership(
  url: string,
  status: Pick<WdaStatus, 'os' | 'ios'>,
  udid: string,
  runtime: (udid: string) => Promise<string | undefined> = simulatorRuntime,
): Promise<WdaOwnership> {
  const seen = await inspectWdaListener(url).catch(() => ({ inspected: false }) as { udid?: string; inspected: boolean });
  const listener = seen.udid;
  if (listener) {
    return listener.toUpperCase() === udid.toUpperCase()
      ? { owner: 'match', deviceUdid: listener, reason: `the WDA at ${url} runs inside simulator ${listener}` }
      : { owner: 'other', deviceUdid: listener, reason: `the WDA at ${url} runs inside simulator ${listener}, not ${udid}` };
  }
  const reported = [status.os?.version, status.ios?.simulatorVersion].find((v): v is string => typeof v === 'string' && !!v.trim());
  const rt = reported ? await runtime(udid).catch(() => undefined) : undefined;
  const rtVersion = rt?.match(/(\d+(?:\.\d+)*)/)?.[1];
  if (reported && rtVersion && !sameIosVersion(reported, rtVersion)) {
    return { owner: 'other', reason: `the WDA at ${url} reports iOS ${reported}, but simulator ${udid} runs ${rt}` };
  }
  // A local listener that could not be inspected (host under load) may be another simulator's WDA
  // on the same runtime: not the same as an external WDA that provably is not a simulator process.
  if (!seen.inspected)
    return { owner: 'unverified', reason: `could not tell which simulator the WDA at ${url} runs in (lsof / ps failed or timed out)` };
  return { owner: 'unknown', reason: `could not tell which device the WDA at ${url} drives` };
}

/** Is a loopback TCP port free (nothing answers on it, and it can be bound)? */
async function loopbackPortFree(port: number): Promise<boolean> {
  const answering = await new Promise<boolean>((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.setTimeout(500, () => {
      s.destroy();
      resolve(false);
    });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
  if (answering) return false;
  return new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

const WDA_PORT_BASE = 8101;
const WDA_PORT_SPAN = 800;

/** PURE: a stable per-simulator WDA port in 8101-8900 (FNV-1a of the UDID), so every session on
 *  the same simulator looks for its managed WDA on the same port. */
export function preferredWdaPort(udid: string): number {
  let h = 0x811c9dc5;
  for (const ch of udid.toUpperCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return WDA_PORT_BASE + (h % WDA_PORT_SPAN);
}

/** A free loopback port for a new managed WDA on `udid`: its preferred port, else the next free
 *  one after it (bounded probe). Its MJPEG stream port (mjpegPortFor) must be free too, or the
 *  runner starts without a screen stream. */
export async function freeWdaPort(udid: string, exclude: number[] = []): Promise<number | undefined> {
  const first = preferredWdaPort(udid) - WDA_PORT_BASE;
  for (let i = 0; i < 64; i++) {
    const port = WDA_PORT_BASE + ((first + i) % WDA_PORT_SPAN);
    if (exclude.includes(port)) continue;
    const mjpeg = mjpegPortFor(port);
    if ((await loopbackPortFree(port)) && (mjpeg === undefined || (await loopbackPortFree(mjpeg)))) return port;
  }
  return undefined;
}

/**
 * This simulator's own WDA when the one at `url` is not provably its own (unreachable, too slow to
 * answer, unidentifiable or another simulator's): probes its per-simulator port and the endpoints
 * recorded for its managed WDAs in the process registry (any server; a relocated start may sit on
 * another port), and returns the first one that answers and runs inside `udid`. Loopback only.
 */
export async function findOwnSimulatorWda(
  url: string,
  udid: string,
  runtime: (udid: string) => Promise<string | undefined> = simulatorRuntime,
  /** GOAL NEW-R4-3: collects this simulator's own WDA URLs that listen but did not answer /status. */
  unresponsive?: string[],
): Promise<{ url: string; status: WdaStatus; owner: WdaOwnership } | undefined> {
  if (!isLoopbackWdaUrl(url)) return undefined;
  const candidates = [wdaUrlWithPort(url, preferredWdaPort(udid))];
  for (const e of registeredWdasForDevice(udid)) {
    if (e.endpoint && isLoopbackWdaUrl(e.endpoint)) candidates.push(e.endpoint.replace(/\/+$/, ''));
  }
  const seen = new Set<string>([url.replace(/\/+$/, '')]);
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const status = await checkWda(candidate, 1500).catch((): WdaStatus => ({ reachable: false, ready: false }));
    if (!status.reachable) {
      if (unresponsive && (await ownButUnresponsive(candidate, status, udid))) unresponsive.push(candidate);
      continue;
    }
    const owner = await wdaDeviceOwnership(candidate, status, udid, runtime);
    if (owner.owner === 'match') return { url: candidate, status, owner };
  }
  return undefined;
}

/** A /status probe that timed out (not refused) on a port whose listener runs inside `udid`: this
 *  simulator's own WDA is up but hung (lsof / ps name the listener without WDA answering). */
async function ownButUnresponsive(url: string, status: WdaStatus, udid: string): Promise<boolean> {
  if (!/abort|timed? ?out/i.test(status.error ?? '')) return false;
  const seen = await inspectWdaListener(url).catch(() => ({ inspected: false }) as { udid?: string; inspected: boolean });
  return !!seen.udid && seen.udid.toUpperCase() === udid.toUpperCase();
}

/**
 * The WDA a run on simulator `udid` should use, resolved the way qa_prepare_ios_target and
 * qa_wda attach do: `url` (the session's own WDA for this simulator, else ios.wda.url / the
 * default) when it provably runs in `udid`, else this simulator's own managed WDA on its
 * per-simulator / registered port, else `url` with its status and ownership (owner `other` /
 * `unverified` = not usable for this simulator).
 */
export async function resolveSimulatorWda(
  url: string,
  udid: string,
  timeoutMs = 1500,
  runtime: (udid: string) => Promise<string | undefined> = simulatorRuntime,
): Promise<{ url: string; status: WdaStatus; owner?: WdaOwnership; ownUnresponsive?: string }> {
  const status = await checkWda(url, timeoutMs).catch((): WdaStatus => ({ reachable: false, ready: false }));
  const owner = status.reachable ? await wdaDeviceOwnership(url, status, udid, runtime).catch(() => undefined) : undefined;
  if (owner?.owner === 'match') return { url, status, owner };
  const unresponsive: string[] = [];
  if (!status.reachable && (await ownButUnresponsive(url, status, udid).catch(() => false))) unresponsive.push(url.replace(/\/+$/, ''));
  const own = await findOwnSimulatorWda(url, udid, runtime, unresponsive).catch(() => undefined);
  if (own) return own;
  // GOAL NEW-R4-3: name this simulator's own hung WDA, not only the URL that was probed first.
  return { url, status, ...(owner ? { owner } : {}), ...(unresponsive.length ? { ownUnresponsive: unresponsive[0] } : {}) };
}

/** WDA's MJPEG screen-stream port for a managed WDA on `wdaPort`: WDA defaults it to 9100 for every
 *  runner, so concurrent simulators collided there (only the first got a stream). wdaPort + 1000
 *  keeps 8100 > 9100 and gives each per-simulator port (8101-8900) its own (9101-9900). */
export function mjpegPortFor(wdaPort: number): number | undefined {
  const p = wdaPort + 1000;
  return p <= 65535 ? p : undefined;
}

/** Environment for the managed `xcodebuild test-without-building`: WDA listens on the URL's port
 *  (USE_PORT; xcodebuild forwards TEST_RUNNER_-prefixed variables to the test runner with the
 *  prefix stripped) and, for a 127.x URL, on loopback only (USE_IP) instead of every interface.
 *  Its MJPEG stream gets a per-port MJPEG_SERVER_PORT (mjpegPortFor). WDA builds that predate
 *  these variables ignore them. */
export function managedWdaEnv(url: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // `out`, not `env`: these are writes for xcodebuild, not env reads (test/codexEnv.test.ts scans `env.X`).
  const out: NodeJS.ProcessEnv = { ...base };
  const port = wdaUrlPort(url);
  if (port) {
    out.USE_PORT = String(port);
    out.TEST_RUNNER_USE_PORT = String(port);
    // The MJPEG server has no bind-address setting in WDA: it listens on every interface.
    const mjpeg = mjpegPortFor(port);
    if (mjpeg) {
      out.MJPEG_SERVER_PORT = String(mjpeg);
      out.TEST_RUNNER_MJPEG_SERVER_PORT = String(mjpeg);
    }
  }
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  if (/^127(\.\d{1,3}){3}$/.test(host)) {
    out.USE_IP = host;
    out.TEST_RUNNER_USE_IP = host;
  }
  return out;
}
