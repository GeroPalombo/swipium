// Thin adb/emulator helpers used by qa_doctor and DirectDriver.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from './spawn.js';
import { registerManagedProcess } from '../session/processRegistry.js';
import type { FailureCode } from '../oracle/failures.js';

const MIN_APK_BYTES = 1024 * 1024;

export function androidHome(): string {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library/Android/sdk');
}

export function findAapt2(): string | null {
  const bt = join(androidHome(), 'build-tools');
  if (!existsSync(bt)) return null;
  for (const v of readdirSync(bt).sort().reverse()) {
    const p = join(bt, v, 'aapt2');
    if (existsSync(p)) return p;
  }
  return null;
}

/** Extract the applicationId from an APK via aapt2 badging. */
export async function apkPackageId(apk: string): Promise<string | null> {
  const aapt2 = findAapt2();
  if (!aapt2) return null;
  try {
    const r = await run(aapt2, ['dump', 'badging', apk], { timeoutMs: 30000 });
    return r.stdout.match(/package: name='([^']+)'/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface ApkResolution {
  apk?: string;
  error?: string;
}

/** Explicit path, else newest usable (>1MB) .apk under projectRoot or projectRoot/apps/android. */
export function resolveApk(projectRoot: string, explicit?: string): ApkResolution {
  if (explicit && explicit.trim()) {
    const p = explicit.trim();
    if (!existsSync(p)) return { error: `APK not found: ${p}` };
    if (statSync(p).size < MIN_APK_BYTES) return { error: `APK looks like an LFS pointer (<1MB): ${p}` };
    return { apk: p };
  }
  let best: { p: string; m: number } | undefined;
  for (const dir of [projectRoot, join(projectRoot, 'apps', 'android')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.apk')) continue;
      const p = join(dir, f);
      const s = statSync(p);
      if (s.size >= MIN_APK_BYTES && (!best || s.mtimeMs > best.m)) best = { p, m: s.mtimeMs };
    }
  }
  return best ? { apk: best.p } : { error: `No usable APK (>1MB) under ${projectRoot} or apps/android. Pass apk explicitly.` };
}

/**
 * Boot an AVD headless. Returns the ChildProcess so the caller can `kill()` it on cancel.
 * We `unref()` it so a running emulator does NOT keep the MCP process alive after the
 * client disconnects (unref does not prevent kill — the caller still holds the handle).
 * `detached:true` + `stdio:'ignore'` so it survives an intentional server exit as an
 * orphan rather than being torn down mid-run. NOTE: deliberate session/shutdown teardown
 * (track + kill booted emulators on session-close) is a follow-up lifecycle pass.
 */
export function bootEmulator(avd: string, headless = true): ChildProcess {
  const args = ['-avd', avd, '-no-audio', '-no-snapshot', '-no-boot-anim', '-gpu', 'swiftshader_indirect'];
  if (headless) args.push('-no-window'); // omit for a visible window (local supervised QA)
  const child = spawn('emulator', args, { detached: true, stdio: 'ignore' });
  child.unref();
  // Tracked for crash visibility only: the orphan reaper ADOPTS emulators (never kills them),
  // since an orphaned emulator stays booted and remains usable via adb for the next run.
  registerManagedProcess(child.pid, 'emulator');
  return child;
}

/** Free bytes on the device /data partition (parsed from `df`), or null. */
export async function deviceFreeDataBytes(serial: string): Promise<number | null> {
  try {
    const r = await run('adb', ['-s', serial, 'shell', 'df', '/data'], { timeoutMs: 8000 });
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    const data = lines[lines.length - 1]; // the mount row
    const cols = data.trim().split(/\s+/);
    // Filesystem  1K-blocks  Used  Available  Use%  Mounted  → Available is index 3
    const availKb = Number(cols[3]);
    return Number.isFinite(availKb) ? availKb * 1024 : null;
  } catch {
    return null;
  }
}

/** Device supported ABIs (ro.product.cpu.abilist). */
export async function deviceAbis(serial: string): Promise<string[]> {
  try {
    const r = await run('adb', ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abilist'], { timeoutMs: 5000 });
    return r.stdout
      .trim()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface ApkBadging {
  packageId: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  abis: string[];
}

/** PURE: parse `aapt2 dump badging` stdout into structured metadata (testable without aapt2). */
export function parseAaptBadging(stdout: string): ApkBadging {
  const pkg = stdout.match(/package: name='([^']+)'/);
  const vCode = stdout.match(/versionCode='(\d+)'/);
  const vName = stdout.match(/versionName='([^']*)'/);
  const minSdk = stdout.match(/sdkVersion:'(\d+)'/);
  const nativeLine = stdout.match(/native-code:\s*(.*)/);
  const abis = nativeLine ? [...nativeLine[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  return {
    packageId: pkg?.[1] ?? null,
    versionName: vName?.[1] ?? null,
    versionCode: vCode ? Number(vCode[1]) : null,
    minSdk: minSdk ? Number(minSdk[1]) : null,
    abis,
  };
}

/** Full APK metadata in a SINGLE aapt2 call (packageId + versionName/Code + minSdk + ABIs). */
export async function apkBadging(apk: string): Promise<ApkBadging | null> {
  const aapt2 = findAapt2();
  if (!aapt2) return null;
  try {
    const r = await run(aapt2, ['dump', 'badging', apk], { timeoutMs: 30000 });
    return parseAaptBadging(r.stdout);
  } catch {
    return null;
  }
}

/** APK minSdkVersion via aapt2 badging (null when aapt2/the field is unavailable). */
export async function apkMinSdk(apk: string): Promise<number | null> {
  const aapt2 = findAapt2();
  if (!aapt2) return null;
  try {
    const r = await run(aapt2, ['dump', 'badging', apk], { timeoutMs: 30000 });
    const m = r.stdout.match(/sdkVersion:'(\d+)'/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Device API level (ro.build.version.sdk), or null. */
export async function deviceSdk(serial: string): Promise<number | null> {
  try {
    const r = await run('adb', ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'], { timeoutMs: 5000 });
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** PURE: is an APK's minSdk satisfied by a device API level? Unknown values → compatible (don't block on missing info). */
export function minSdkCompatible(apkMinSdk: number | null, deviceApiLevel: number | null): boolean {
  if (apkMinSdk == null || deviceApiLevel == null) return true;
  return deviceApiLevel >= apkMinSdk;
}

/**
 * PURE: classify a failed `adb install` into a typed blocker. adb reports a `Failure [REASON]`
 * token (or a human message) on the stderr that `run()` folds into the thrown Error message.
 * Mapping these lets prepareAndroid say WHO must fix it instead of a generic launch failure.
 */
export function classifyAndroidInstallError(message: string): FailureCode {
  const m = message;
  if (
    /INSTALL_FAILED_UPDATE_INCOMPATIBLE|INCONSISTENT_CERTIFICATES|signatures do not match|INSTALL_FAILED_SHARED_USER_INCOMPATIBLE|DUPLICATE_PACKAGE/i.test(
      m,
    )
  )
    return 'ANDROID_SIGNATURE_CONFLICT';
  if (
    /INSTALL_FAILED_VERSION_DOWNGRADE|INSTALL_FAILED_OLDER_SDK|INSTALL_FAILED_DEPRECATED_SDK_VERSION|requires (?:a )?newer (?:sdk|version)|requires .*API level/i.test(
      m,
    )
  )
    return 'ANDROID_MIN_SDK_INCOMPATIBLE';
  if (/INSTALL_FAILED_NO_MATCHING_ABIS|no matching abis|INSTALL_FAILED_CPU_ABI_INCOMPATIBLE/i.test(m)) return 'APK_ARCH_INCOMPATIBLE';
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE|not enough space|no space left/i.test(m)) return 'INSTALL_FAILED';
  return 'INSTALL_FAILED';
}

/** Native ABIs an APK ships (empty = pure/no native code → installs on any ABI). */
export async function apkNativeAbis(apk: string): Promise<string[]> {
  const aapt2 = findAapt2();
  if (!aapt2) return [];
  try {
    const r = await run(aapt2, ['dump', 'badging', apk], { timeoutMs: 30000 });
    const m = r.stdout.match(/native-code:\s*(.*)/);
    if (!m) return [];
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  } catch {
    return [];
  }
}

export function fmtBytes(n: number | null): string {
  if (n == null) return 'unknown';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

/** Wait until sys.boot_completed === 1 (or timeout). */
export async function waitForBoot(serial: string, timeoutMs = 180000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  try {
    await run('adb', ['-s', serial, 'wait-for-device'], { timeoutMs });
  } catch {
    /* keep polling below */
  }
  while (Date.now() < deadline) {
    try {
      const r = await run('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 5000 });
      if (r.stdout.trim() === '1') return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

export async function which(bin: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = await run(finder, [bin], { timeoutMs: 5000 });
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function firstLine(bin: string, args: string[]): Promise<string | null> {
  try {
    const r = await run(bin, args, { timeoutMs: 8000 });
    if (r.code !== 0) return null;
    return (r.stdout || r.stderr).split('\n')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Online device/emulator serials (state === "device"). */
export async function adbDevices(): Promise<string[]> {
  try {
    const r = await run('adb', ['devices'], { timeoutMs: 10000 });
    return r.stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.endsWith('device'))
      .map((l) => l.split(/\s+/)[0]);
  } catch {
    return [];
  }
}

export async function listAvds(): Promise<string[]> {
  try {
    const r = await run('emulator', ['-list-avds'], { timeoutMs: 10000 });
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
