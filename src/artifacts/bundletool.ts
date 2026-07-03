// bundletool integration (roadmap §4.3 / hardening P0.2) — an .aab is not installable; it must be
// converted to a universal APK first. This module detects bundletool (a `bundletool` launcher on
// PATH, a `$BUNDLETOOL_JAR` run via java, or a jar in common locations), builds a universal APK
// set with the debug keystore, extracts universal.apk, and caches it under .swipium/artifacts/.
//
// Detection + command construction are pure/testable; execution is guarded behind tool presence.

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { which } from '../lib/android.js';
import { run } from '../lib/spawn.js';
import type { FailureCode } from '../oracle/failures.js';

export interface BundletoolLauncher {
  /** How bundletool is invoked: as a PATH binary, or `java -jar <jar>`. */
  kind: 'bin' | 'jar';
  /** Executable to spawn. */
  cmd: string;
  /** Args that must precede the bundletool subcommand (e.g. ['-jar', '/path/bundletool.jar']). */
  prefix: string[];
  /** Human description for logs/reports. */
  describe: string;
}

const JAR_CANDIDATES = (): string[] => {
  const home = homedir();
  return [
    process.env.BUNDLETOOL_JAR ?? '',
    join(home, 'bundletool.jar'),
    join(home, 'Downloads', 'bundletool.jar'),
    '/usr/local/bin/bundletool.jar',
    '/opt/homebrew/bin/bundletool.jar',
  ].filter(Boolean);
};

/** Find a usable bundletool launcher, or null if none is available. */
export async function findBundletool(): Promise<BundletoolLauncher | null> {
  if (await which('bundletool')) {
    return { kind: 'bin', cmd: 'bundletool', prefix: [], describe: 'bundletool (PATH)' };
  }
  const hasJava = await which('java');
  if (hasJava) {
    for (const jar of JAR_CANDIDATES()) {
      if (existsSync(jar)) return { kind: 'jar', cmd: 'java', prefix: ['-jar', jar], describe: `java -jar ${jar}` };
    }
  }
  return null;
}

/** Where the converted universal APK is cached for a given .aab. */
export function universalApkCachePath(projectRoot: string, aabPath: string): string {
  const base = basename(aabPath).replace(/\.aab$/i, '');
  return join(projectRoot, '.swipium', 'artifacts', `${base}-universal.apk`);
}

export interface ConvertResult {
  ok: boolean;
  apkPath?: string;
  apksPath?: string;
  command?: string;
  failureCode?: FailureCode;
  error?: string;
  fromCache?: boolean;
}

/** The bundletool build-apks argv for a universal APK set (pure — for tests + logging). */
export function buildApksArgs(launcher: BundletoolLauncher, aabPath: string, apksOut: string): string[] {
  return [...launcher.prefix, 'build-apks', '--bundle', aabPath, '--output', apksOut, '--overwrite', '--mode', 'universal'];
}

/** Release keystore inputs for signing the APK set. Absent → bundletool uses the default debug keystore (emulator/dev OK). */
export interface AabSigning {
  ks: string;
  ksPass?: string; // e.g. "pass:..." or "file:..."
  ksKeyAlias: string;
  keyPass?: string;
}

/** PURE: signing args for build-apks (empty → debug keystore fallback). */
export function signingArgs(signing?: AabSigning): string[] {
  if (!signing) return [];
  const out = ['--ks', signing.ks, '--ks-key-alias', signing.ksKeyAlias];
  if (signing.ksPass) out.push('--ks-pass', signing.ksPass);
  if (signing.keyPass) out.push('--key-pass', signing.keyPass);
  return out;
}

/** PURE: build-apks argv for a DEVICE-SPECIFIC APK set (--connected-device), optionally targeting one serial + signing. */
export function buildApksConnectedArgs(
  launcher: BundletoolLauncher,
  aabPath: string,
  apksOut: string,
  opts: { deviceId?: string; signing?: AabSigning } = {},
): string[] {
  const args = [...launcher.prefix, 'build-apks', '--bundle', aabPath, '--output', apksOut, '--overwrite', '--connected-device'];
  if (opts.deviceId) args.push('--device-id', opts.deviceId);
  args.push(...signingArgs(opts.signing));
  return args;
}

/** PURE: install-apks argv for pushing a device-specific APK set to a connected device. */
export function installApksArgs(launcher: BundletoolLauncher, apksPath: string, opts: { deviceId?: string } = {}): string[] {
  const args = [...launcher.prefix, 'install-apks', '--apks', apksPath];
  if (opts.deviceId) args.push('--device-id', opts.deviceId);
  return args;
}

/** PURE: classify a bundletool stderr/stdout for a given phase into a typed blocker. */
export function classifyBundletoolError(output: string, phase: 'build' | 'install'): FailureCode {
  if (/keystore|jarsigner|failed to (?:read|load) key|SigningConfig|password was incorrect|key.*alias/i.test(output))
    return 'ANDROID_SIGNING_FAILED';
  if (phase === 'install') {
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match|INCONSISTENT_CERTIFICATES/i.test(output))
      return 'ANDROID_SIGNATURE_CONFLICT';
    if (/INSTALL_FAILED_OLDER_SDK|INSTALL_FAILED_VERSION_DOWNGRADE/i.test(output)) return 'ANDROID_MIN_SDK_INCOMPATIBLE';
    if (/INSTALL_FAILED_NO_MATCHING_ABIS/i.test(output)) return 'APK_ARCH_INCOMPATIBLE';
    return 'AAB_INSTALL_FAILED';
  }
  if (/No connected (?:Android )?device|Unable to connect to (?:adb|device)|connected device/i.test(output))
    return 'AAB_DEVICE_SPEC_FAILED';
  return 'AAB_BUILD_APKS_FAILED';
}

export interface ApkSetResult {
  ok: boolean;
  apksPath?: string;
  /** Combined bundletool log (build + install) for artifact storage. */
  logText: string;
  buildCommand?: string;
  installCommand?: string;
  installed?: boolean;
  failureCode?: FailureCode;
  error?: string;
}

/**
 * Build a DEVICE-SPECIFIC APK set for a connected device and (optionally) install it via
 * bundletool install-apks. This is the first-class .aab path for a real run (vs the universal
 * APK fallback in convertAabToApk). Returns typed blockers + the combined log so the caller can
 * persist it as an artifact. Debug keystore is the default when no release signing is supplied.
 */
export async function buildAndInstallApkSet(
  aabPath: string,
  projectRoot: string,
  opts: { deviceId?: string; signing?: AabSigning; install?: boolean; signal?: AbortSignal; timeoutMs?: number; force?: boolean } = {},
): Promise<ApkSetResult> {
  const launcher = await findBundletool();
  if (!launcher) {
    return {
      ok: false,
      logText: '',
      failureCode: 'BUNDLETOOL_MISSING',
      error: 'bundletool not found (install it, set $BUNDLETOOL_JAR, or build an APK directly).',
    };
  }
  const base = basename(aabPath).replace(/\.aab$/i, '');
  const apksOut = join(projectRoot, '.swipium', 'artifacts', `${base}-${opts.deviceId ? sanitize(opts.deviceId) : 'device'}.apks`);
  mkdirSync(join(projectRoot, '.swipium', 'artifacts'), { recursive: true });
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  let logText = '';

  if (!opts.force && existsSync(apksOut)) {
    try {
      if (statSync(apksOut).mtimeMs >= statSync(aabPath).mtimeMs && !opts.install) {
        return { ok: true, apksPath: apksOut, logText: 'using cached device APK set\n', installed: false };
      }
    } catch {
      /* rebuild */
    }
  }

  const buildArgs = buildApksConnectedArgs(launcher, aabPath, apksOut, { deviceId: opts.deviceId, signing: opts.signing });
  const buildCommand = `${launcher.cmd} ${buildArgs.join(' ')}`;
  logText += `=== build-apks (connected device) ===\n${buildCommand}\n`;
  const built = await run(launcher.cmd, buildArgs, { signal: opts.signal, timeoutMs });
  logText += built.stdout + built.stderr + '\n';
  if (built.code !== 0) {
    return {
      ok: false,
      apksPath: existsSync(apksOut) ? apksOut : undefined,
      logText,
      buildCommand,
      failureCode: classifyBundletoolError(built.stdout + built.stderr, 'build'),
      error: built.stderr.trim() || built.stdout.trim() || `bundletool build-apks exited ${built.code}`,
    };
  }

  if (!opts.install) {
    return { ok: true, apksPath: apksOut, logText, buildCommand, installed: false };
  }

  const installArgs = installApksArgs(launcher, apksOut, { deviceId: opts.deviceId });
  const installCommand = `${launcher.cmd} ${installArgs.join(' ')}`;
  logText += `=== install-apks ===\n${installCommand}\n`;
  const installed = await run(launcher.cmd, installArgs, { signal: opts.signal, timeoutMs });
  logText += installed.stdout + installed.stderr + '\n';
  if (installed.code !== 0) {
    return {
      ok: false,
      apksPath: apksOut,
      logText,
      buildCommand,
      installCommand,
      failureCode: classifyBundletoolError(installed.stdout + installed.stderr, 'install'),
      error: installed.stderr.trim() || installed.stdout.trim() || `bundletool install-apks exited ${installed.code}`,
    };
  }
  return { ok: true, apksPath: apksOut, logText, buildCommand, installCommand, installed: true };
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Convert an .aab to an installable universal .apk, caching the result. Returns a typed blocker
 * (AAB_NEEDS_BUNDLETOOL / AAB_BUILD_APKS_FAILED) instead of throwing, so callers can surface it.
 */
export async function convertAabToApk(
  aabPath: string,
  projectRoot: string,
  opts: { signal?: AbortSignal; force?: boolean; timeoutMs?: number } = {},
): Promise<ConvertResult> {
  const apkPath = universalApkCachePath(projectRoot, aabPath);
  // Cache hit: a fresh universal APK newer than the .aab.
  if (!opts.force && existsSync(apkPath)) {
    try {
      if (statSync(apkPath).mtimeMs >= statSync(aabPath).mtimeMs) return { ok: true, apkPath, fromCache: true };
    } catch {
      /* fall through to rebuild */
    }
  }

  const launcher = await findBundletool();
  if (!launcher) {
    return {
      ok: false,
      failureCode: 'AAB_NEEDS_BUNDLETOOL',
      error: 'bundletool not found (install it, set $BUNDLETOOL_JAR, or build an APK directly).',
    };
  }

  mkdirSync(join(projectRoot, '.swipium', 'artifacts'), { recursive: true });
  const apksOut = apkPath.replace(/\.apk$/, '.apks');
  const args = buildApksArgs(launcher, aabPath, apksOut);
  const command = `${launcher.cmd} ${args.join(' ')}`;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  const built = await run(launcher.cmd, args, { signal: opts.signal, timeoutMs });
  if (built.code !== 0) {
    return {
      ok: false,
      failureCode: 'AAB_BUILD_APKS_FAILED',
      error: built.stderr.trim() || built.stdout.trim() || `bundletool exited ${built.code}`,
      command,
    };
  }

  // The .apks is a zip containing universal.apk — extract it (prefer `unzip`, else bundletool can't).
  const extracted = await extractUniversalApk(apksOut, apkPath, opts.signal);
  if (!extracted) {
    return {
      ok: false,
      failureCode: 'AAB_BUILD_APKS_FAILED',
      error: 'built .apks but could not extract universal.apk (need `unzip` on PATH).',
      command,
      apksPath: apksOut,
    };
  }
  return { ok: true, apkPath, apksPath: apksOut, command };
}

/** Extract universal.apk from a bundletool .apks zip into `outApk`. Returns success. */
async function extractUniversalApk(apksPath: string, outApk: string, signal?: AbortSignal): Promise<boolean> {
  if (!(await which('unzip'))) return false;
  const dir = join(outApk, '..');
  // unzip the universal apk (named universal.apk inside the .apks) into the artifacts dir.
  const r = await run('unzip', ['-o', '-j', apksPath, 'universal.apk', '-d', dir], { signal, timeoutMs: 60_000 });
  if (r.code !== 0) return false;
  const produced = join(dir, 'universal.apk');
  if (!existsSync(produced)) {
    // Some bundletool versions nest it; find any .apk and rename.
    const any = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.apk') && f.includes('universal'));
    if (!any) return false;
    return existsSync(join(dir, any));
  }
  // Rename universal.apk → the cache name.
  const { renameSync } = await import('node:fs');
  try {
    renameSync(produced, outApk);
  } catch {
    return existsSync(produced);
  }
  return existsSync(outApk);
}
