// iOS Simulator helpers via `xcrun simctl`. Local, macOS host only. Covers
// the lifecycle + screenshot + deep links + privacy/erase that simctl supports natively. UI-tree
// reads and input injection are NOT available through simctl (they need an XCUITest backend, a
// attach WebDriverAgent for structured iOS automation, so SimctlDriver reports those as
// unsupported rather than faking them.
// All spawns use arg arrays (injection-safe). Tool/binary names (xcrun/simctl/plutil) are CLI
// invocations, not configuration to surface.

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './spawn.js';
import { CancelledError, currentSignal } from './abortScope.js';
import type { FailureCode } from '../oracle/failures.js';

export interface Simulator {
  udid: string;
  name: string;
  state: string; // 'Booted' | 'Shutdown' | …
  runtime: string; // e.g. 'iOS 18.0'
}

const X = 'xcrun';

/** Is the simulator toolchain usable on this host (macOS + the `xcrun simctl` command-line tools)? */
export async function simctlAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const r = await run(X, ['simctl', 'help'], { timeoutMs: 8000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

function prettyRuntime(key: string): string {
  // runtime key '<reverse-dns>.SimRuntime.iOS-18-0' > 'iOS 18.0'
  const m = key.match(/SimRuntime\.([A-Za-z]+)-([\d-]+)$/);
  return m ? `${m[1]} ${m[2].replace(/-/g, '.')}` : key;
}

export async function listSimulators(): Promise<Simulator[]> {
  const r = await run(X, ['simctl', 'list', 'devices', 'available', '--json'], { timeoutMs: 15000 });
  const out: Simulator[] = [];
  try {
    const j = JSON.parse(r.stdout) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> };
    for (const [rt, list] of Object.entries(j.devices)) {
      for (const d of list) out.push({ udid: d.udid, name: d.name, state: d.state, runtime: prettyRuntime(rt) });
    }
  } catch {
    /* malformed */
  }
  return out;
}

/** Full simctl boot + bootstatus wait (each step up to 120 s). Internal: always go through boot(). */
async function bootAndWait(udid: string): Promise<void> {
  // 'Unable to boot ... current state: Booted' is fine; treat already-booted as success.
  const r = await run(X, ['simctl', 'boot', udid], { timeoutMs: 120000 });
  if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) {
    throw new Error(`boot failed: ${r.timedOut ? 'timed out after 120 s' : r.stderr.trim() || r.stdout.trim()}`);
  }
  const ready = await run(X, ['simctl', 'bootstatus', udid, '-b'], { timeoutMs: 120000 });
  if (ready.code !== 0) {
    throw new Error(`bootstatus failed: ${ready.timedOut ? 'timed out after 120 s' : ready.stderr.trim() || ready.stdout.trim()}`);
  }
}

/** How long a tool call (qa_ios boot) waits for a simulator boot in-call. One call must stay under
 *  common client tool timeouts (Codex: 60 s); a slower cold boot returns status:"booting" and the
 *  agent polls qa_wait { for:"simulator_booted" } while the boot keeps going in the background. */
export const SIMULATOR_BOOT_CALL_WAIT_MS = 40_000;

interface BootRecord {
  udid: string;
  startedAt: number;
  state: 'booting' | 'failed';
  error?: string;
  promise: Promise<void>;
}

/** Boots started by this process, keyed by UDID. A record lives while the boot runs and after it
 *  FAILED (so a poll can report why); a finished boot drops its record (simctl is then the truth). */
const boots = new Map<string, BootRecord>();

function trackedBoot(udid: string): BootRecord {
  const cur = boots.get(udid);
  if (cur && cur.state === 'booting') return cur;
  const rec: BootRecord = { udid, startedAt: Date.now(), state: 'booting', promise: Promise.resolve() };
  rec.promise = bootAndWait(udid).then(
    () => {
      if (boots.get(udid) === rec) boots.delete(udid);
    },
    (e: unknown) => {
      rec.state = 'failed';
      rec.error = String((e as Error)?.message ?? e);
      throw e;
    },
  );
  rec.promise.catch(() => {}); // a boot nobody awaits any more must not become an unhandled rejection
  boots.set(udid, rec);
  return rec;
}

/**
 * Boot `udid` and wait until it is fully booted (bootstatus). No in-call bound: for internal callers
 * that run inside background jobs (qa_test_this, the qa_prepare_ios_target job). Joins a boot that
 * is already in flight for the same UDID instead of starting a second one.
 */
export async function boot(udid: string): Promise<void> {
  await trackedBoot(udid).promise;
}

/** Is a boot started by this process still running for `udid`? */
export function bootInFlight(udid: string): boolean {
  return boots.get(udid)?.state === 'booting';
}

export interface BoundedBootResult {
  booted: boolean;
  /** ms since this boot started (a joined boot counts from its own start). */
  elapsedMs: number;
}

/**
 * Tool-facing boot: start (or join) the boot and wait at most `waitMs`. booted:false means the
 * boot is still running in the background (poll simulatorBootState / qa_wait). A boot failure
 * rejects like boot(). Cancellation of the current call (abortScope) rejects with CancelledError
 * and leaves the boot running: a half-booted simulator is not a state worth killing.
 */
export async function bootWithin(udid: string, waitMs: number): Promise<BoundedBootResult> {
  const rec = trackedBoot(udid);
  let timer: NodeJS.Timeout | undefined;
  const signal = currentSignal();
  let onAbort: (() => void) | undefined;
  try {
    const outcome = await Promise.race([
      rec.promise.then(() => 'booted' as const),
      new Promise<'waiting'>((resolve) => {
        timer = setTimeout(() => resolve('waiting'), Math.max(0, waitMs));
      }),
      new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        onAbort = () => reject(new CancelledError());
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    return { booted: outcome === 'booted', elapsedMs: Date.now() - rec.startedAt };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export type SimulatorBootState =
  | { state: 'booted'; udid: string; name?: string }
  | { state: 'booting'; udid: string; name?: string; elapsedMs?: number }
  | { state: 'failed'; udid: string; name?: string; error: string }
  | { state: 'shutdown'; udid: string; name?: string; simctlState: string }
  | { state: 'unknown'; udid: string };

/**
 * Non-blocking boot probe for polling (qa_wait { for:"simulator_booted" }). A boot started by this
 * process answers from its record; otherwise simctl decides: a Booted device is booted once
 * `simctl bootstatus` (no -b, so it never boots anything) returns within `probeMs`.
 */
export async function simulatorBootState(udid: string, probeMs = 3000): Promise<SimulatorBootState> {
  const rec = boots.get(udid);
  if (rec?.state === 'booting') return { state: 'booting', udid, elapsedMs: Date.now() - rec.startedAt };
  if (rec?.state === 'failed') return { state: 'failed', udid, error: rec.error ?? 'boot failed' };
  const sim = (await listSimulators()).find((s) => s.udid === udid);
  if (!sim) return { state: 'unknown', udid };
  if (/^booting$/i.test(sim.state)) return { state: 'booting', udid, name: sim.name };
  if (!/^booted$/i.test(sim.state)) return { state: 'shutdown', udid, name: sim.name, simctlState: sim.state };
  const r = await run(X, ['simctl', 'bootstatus', udid], { timeoutMs: Math.max(250, probeMs), signal: currentSignal() });
  return r.code === 0 && !r.timedOut ? { state: 'booted', udid, name: sim.name } : { state: 'booting', udid, name: sim.name };
}

/** Test seam: forget every tracked boot. */
export function resetBootTrackingForTests(): void {
  boots.clear();
}

export async function shutdown(udid: string): Promise<void> {
  const r = await run(X, ['simctl', 'shutdown', udid], { timeoutMs: 60000 });
  if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) throw new Error(`shutdown failed: ${r.stderr.trim()}`);
}

export async function installApp(udid: string, appPath: string): Promise<void> {
  await run(X, ['simctl', 'install', udid, appPath], { timeoutMs: 120000, rejectOnNonZero: true });
}

export async function uninstallApp(udid: string, bundleId: string): Promise<void> {
  await run(X, ['simctl', 'uninstall', udid, bundleId], { timeoutMs: 60000 });
}

export function classifyIosInstallFailure(message: string): FailureCode {
  if (
    /wrong architecture|unsupported architecture|missing required architecture|mach-o/i.test(message) ||
    /not built .*simulator|built for .*device|built for iOS(?! Simulator)|iphoneos/i.test(message)
  ) {
    return 'WRONG_ARCH';
  }
  return 'INSTALL_FAILED';
}

export async function launchApp(udid: string, bundleId: string): Promise<void> {
  await run(X, ['simctl', 'launch', udid, bundleId], { timeoutMs: 30000, rejectOnNonZero: true });
}

export async function launchAppWithArgs(udid: string, bundleId: string, args: Record<string, unknown>): Promise<void> {
  const argv = Object.entries(args).flatMap(([key, value]) => [`--${key}`, String(value)]);
  await run(X, ['simctl', 'launch', '--terminate-running-process', udid, bundleId, ...argv], { timeoutMs: 30000, rejectOnNonZero: true });
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  // Not-running is not an error for our purposes.
  await run(X, ['simctl', 'terminate', udid, bundleId], { timeoutMs: 15000 });
}

export async function isInstalled(udid: string, bundleId: string): Promise<boolean> {
  const r = await run(X, ['simctl', 'get_app_container', udid, bundleId], { timeoutMs: 10000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** Erase requires the device be shut down first. */
export async function erase(udid: string): Promise<void> {
  await shutdown(udid).catch(() => {});
  await run(X, ['simctl', 'erase', udid], { timeoutMs: 60000, rejectOnNonZero: true });
}

export async function screenshot(udid: string): Promise<Buffer> {
  // NOTE: `simctl io screenshot -` (stdout) is unreliable across toolchain versions (it can try to
  // "save" to a file literally named "-" on a read-only volume). Write to a temp file + read back.
  const tmp = join(tmpdir(), `swipium-ios-${udid}-${Date.now()}.png`);
  try {
    await run(X, ['simctl', 'io', udid, 'screenshot', '--type', 'png', tmp], { timeoutMs: 20000, rejectOnNonZero: true });
    return readFileSync(tmp);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

export async function openUrl(udid: string, url: string): Promise<void> {
  await run(X, ['simctl', 'openurl', udid, url], { timeoutMs: 15000, rejectOnNonZero: true });
}

export function simulatorLogArgs(udid: string, opts: { last?: string; bundleId?: string } = {}): string[] {
  const args = ['simctl', 'spawn', udid, 'log', 'show', '--style', 'compact', '--last', opts.last ?? '5m'];
  if (opts.bundleId) {
    args.push(
      '--predicate',
      `eventMessage CONTAINS[c] "${opts.bundleId}" OR processImagePath CONTAINS[c] "${opts.bundleId}" OR subsystem CONTAINS[c] "${opts.bundleId}"`,
    );
  }
  return args;
}

export async function simulatorLogs(udid: string, opts: { last?: string; bundleId?: string } = {}): Promise<string> {
  const r = await run(X, simulatorLogArgs(udid, opts), { timeoutMs: 20000, rejectOnNonZero: true });
  return [r.stdout, r.stderr].filter(Boolean).join('\n');
}

/** Reset a privacy permission (service e.g. location, photos, camera, contacts, all). */
export async function privacyReset(udid: string, service: string, bundleId?: string): Promise<void> {
  const args = ['simctl', 'privacy', udid, 'reset', service];
  if (bundleId) args.push(bundleId);
  await run(X, args, { timeoutMs: 15000, rejectOnNonZero: true });
}

export async function privacySet(udid: string, action: 'grant' | 'revoke' | 'reset', service: string, bundleId?: string): Promise<void> {
  const args = ['simctl', 'privacy', udid, action, service];
  if (bundleId) args.push(bundleId);
  await run(X, args, { timeoutMs: 15000, rejectOnNonZero: true });
}

/** Read CFBundleIdentifier from a built .app via plutil. */
export async function bundleIdFromApp(appPath: string): Promise<string | null> {
  try {
    const r = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${appPath}/Info.plist`], { timeoutMs: 8000 });
    const id = r.stdout.trim();
    return id && r.code === 0 ? id : null;
  } catch {
    return null;
  }
}
