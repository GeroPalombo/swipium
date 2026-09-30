// Device-parity adb helpers. Serial-based (Android/adb-specific)
// rather than on the Driver interface, so the iOS/native-backend swap seam stays lean. When iOS
// lands it provides its own device-parity implementations. All spawns use arg arrays, but `adb shell`
// re-joins them for the device-side sh, so app ids / permissions are validated AND quoted (M1).

import { run } from './spawn.js';
import { assertAndroidAppId, deviceShellQuote, shellAppId } from '../drivers/DirectDriver.js';

/** Android permission names (android.permission.CAMERA, com.example.permission.X). */
const PERMISSION_RE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)*$/;

/** Throw a typed INVALID_ARGUMENT error unless `perm` is a well-formed Android permission name. */
export function assertAndroidPermission(perm: string): string {
  if (typeof perm !== 'string' || !PERMISSION_RE.test(perm)) {
    const err = new Error(`INVALID_ARGUMENT: ${JSON.stringify(String(perm).slice(0, 80))} is not a valid Android permission name.`);
    (err as Error & { code?: string }).code = 'INVALID_ARGUMENT';
    throw err;
  }
  return perm;
}

/** Validated + device-shell-quoted permission name (typed INVALID_ARGUMENT otherwise). */
function shellPermission(perm: string): string {
  return deviceShellQuote(assertAndroidPermission(perm));
}

export interface DeviceProps {
  model: string | null;
  manufacturer: string | null;
  sdk: string | null;
  release: string | null;
  abis: string[];
  locale: string | null;
  timezone: string | null;
}

/** One `getprop` dump, parsed into the props we surface. */
export async function getDeviceProps(serial: string): Promise<DeviceProps> {
  const get = (out: string, key: string): string | null =>
    out.match(new RegExp(`\\[${key.replace(/\./g, '\\.')}\\]:\\s*\\[([^\\]]*)\\]`))?.[1] ?? null;
  try {
    const r = await run('adb', ['-s', serial, 'shell', 'getprop'], { timeoutMs: 8000 });
    const o = r.stdout;
    return {
      model: get(o, 'ro.product.model'),
      manufacturer: get(o, 'ro.product.manufacturer'),
      sdk: get(o, 'ro.build.version.sdk'),
      release: get(o, 'ro.build.version.release'),
      abis: (get(o, 'ro.product.cpu.abilist') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      locale: get(o, 'persist.sys.locale') ?? get(o, 'ro.product.locale'),
      timezone: get(o, 'persist.sys.timezone'),
    };
  } catch {
    return { model: null, manufacturer: null, sdk: null, release: null, abis: [], locale: null, timezone: null };
  }
}

export type Orientation = 'portrait' | 'landscape' | 'auto';

/** Current rotation 0..3 (0/2 portrait, 1/3 landscape) and whether auto-rotate is on. */
export async function getOrientation(serial: string): Promise<{ rotation: number; auto: boolean } | null> {
  try {
    const rot = await run('adb', ['-s', serial, 'shell', 'settings', 'get', 'system', 'user_rotation'], { timeoutMs: 5000 });
    const acc = await run('adb', ['-s', serial, 'shell', 'settings', 'get', 'system', 'accelerometer_rotation'], { timeoutMs: 5000 });
    const rotation = Number(rot.stdout.trim());
    return { rotation: Number.isFinite(rotation) ? rotation : 0, auto: acc.stdout.trim() === '1' };
  } catch {
    return null;
  }
}

export async function setOrientation(serial: string, o: Orientation): Promise<void> {
  if (o === 'auto') {
    await run('adb', ['-s', serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1'], {
      timeoutMs: 5000,
      rejectOnNonZero: true,
    });
    return;
  }
  // fixed orientation: disable auto-rotate, then pin user_rotation (0=portrait, 1=landscape).
  await run('adb', ['-s', serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'], {
    timeoutMs: 5000,
    rejectOnNonZero: true,
  });
  await run('adb', ['-s', serial, 'shell', 'settings', 'put', 'system', 'user_rotation', o === 'landscape' ? '1' : '0'], {
    timeoutMs: 5000,
    rejectOnNonZero: true,
  });
}

/** Installed packages (optionally third-party only / name-filtered). */
export async function listPackages(serial: string, opts: { thirdPartyOnly?: boolean; filter?: string } = {}): Promise<string[]> {
  const args = ['-s', serial, 'shell', 'pm', 'list', 'packages'];
  if (opts.thirdPartyOnly) args.push('-3');
  // `adb shell` re-parses the joined argv on the device: the free-form filter is quoted.
  if (opts.filter) args.push(deviceShellQuote(opts.filter));
  try {
    const r = await run('adb', args, { timeoutMs: 8000 });
    return r.stdout
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/** Best-effort runtime-permission state for a package (parsed from dumpsys). */
export async function listRuntimePermissions(serial: string, pkg: string): Promise<{ granted: string[]; denied: string[] }> {
  const granted: string[] = [];
  const denied: string[] = [];
  assertAndroidAppId(pkg); // argument error, not "no permissions"
  try {
    const r = await run('adb', ['-s', serial, 'shell', 'dumpsys', 'package', shellAppId(pkg)], { timeoutMs: 8000 });
    for (const m of r.stdout.matchAll(/(android\.permission\.[A-Z_]+):\s*granted=(true|false)/g)) {
      (m[2] === 'true' ? granted : denied).push(m[1]);
    }
  } catch {
    /* best-effort */
  }
  return { granted, denied };
}

export async function grantPermission(serial: string, pkg: string, perm: string): Promise<void> {
  await run('adb', ['-s', serial, 'shell', 'pm', 'grant', shellAppId(pkg), shellPermission(perm)], {
    timeoutMs: 6000,
    rejectOnNonZero: true,
  });
}

/** Spoof the device location via the emulator console (`emu geo fix <lon> <lat>`). Emulator-only. */
export async function setGeo(serial: string, lat: number, lng: number): Promise<void> {
  // arg order is longitude, then latitude.
  await run('adb', ['-s', serial, 'emu', 'geo', 'fix', String(lng), String(lat)], { timeoutMs: 8000, rejectOnNonZero: true });
}

export async function revokePermission(serial: string, pkg: string, perm: string): Promise<void> {
  await run('adb', ['-s', serial, 'shell', 'pm', 'revoke', shellAppId(pkg), shellPermission(perm)], {
    timeoutMs: 6000,
    rejectOnNonZero: true,
  });
}
