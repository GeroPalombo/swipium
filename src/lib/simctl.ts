// iOS Simulator helpers (PHASE3-PLAN Phase 11) via `xcrun simctl` — local, macOS host only. Covers
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
  // runtime key '<reverse-dns>.SimRuntime.iOS-18-0' → 'iOS 18.0'
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

export async function boot(udid: string): Promise<void> {
  // 'Unable to boot ... current state: Booted' is fine — treat already-booted as success.
  const r = await run(X, ['simctl', 'boot', udid], { timeoutMs: 120000 });
  if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) {
    throw new Error(`boot failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const ready = await run(X, ['simctl', 'bootstatus', udid, '-b'], { timeoutMs: 120000 });
  if (ready.code !== 0) {
    throw new Error(`bootstatus failed: ${ready.stderr.trim() || ready.stdout.trim()}`);
  }
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
    args.push('--predicate', `eventMessage CONTAINS[c] "${opts.bundleId}" OR processImagePath CONTAINS[c] "${opts.bundleId}" OR subsystem CONTAINS[c] "${opts.bundleId}"`);
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
