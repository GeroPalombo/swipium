// android-device (2.3.0): emulator boot argv, launch via `am start -W` + foreground polling,
// on-device filtered foregroundOwner, one-shell orientation + cached density and the
// simulator reusing known PNG dims. Hermetic: adb/simctl are mocked.

import { describe, expect, it, vi, beforeEach } from 'vitest';

type Reply = { code: number; stdout: string; stderr: string; timedOut: boolean };
const state: { calls: string[][]; reply: (args: string[]) => Reply | undefined; shots: number } = {
  calls: [],
  reply: () => undefined,
  shots: 0,
};
const ok = (stdout: string): Reply => ({ code: 0, stdout, stderr: '', timedOut: false });

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return {
    ...actual,
    run: async (cmd: string, args: string[], opts: { rejectOnNonZero?: boolean } = {}) => {
      state.calls.push([cmd, ...args]);
      const r = state.reply(args) ?? ok('');
      if (opts.rejectOnNonZero && r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr}`);
      return r;
    },
  };
});
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return {
    ...actual,
    screenshot: async () => {
      state.shots++;
      return Buffer.alloc(0);
    },
  };
});

const { emulatorBootArgs } = await import('../src/lib/android.js');
const { DirectDriver } = await import('../src/drivers/DirectDriver.js');
const { SimctlDriver } = await import('../src/drivers/SimctlDriver.js');
const { waitForForeground, waitForLaunch } = await import('../src/lib/launchWait.js');
const { getOrientation } = await import('../src/lib/device.js');

beforeEach(() => {
  state.calls = [];
  state.reply = () => undefined;
  state.shots = 0;
});

describe('emulatorBootArgs', () => {
  it('defaults: snapshot quick-boot without saving, gpu auto, headless', () => {
    expect(emulatorBootArgs('Pixel', true, {})).toEqual([
      '-avd',
      'Pixel',
      '-no-audio',
      '-no-snapshot-save',
      '-no-boot-anim',
      '-gpu',
      'auto',
      '-no-window',
    ]);
  });
  it('SWIPIUM_EMULATOR_GPU overrides the renderer; COLD_BOOT=1 adds -no-snapshot-load; windowed omits -no-window', () => {
    const a = emulatorBootArgs('Pixel', false, { SWIPIUM_EMULATOR_GPU: 'swiftshader_indirect', SWIPIUM_EMULATOR_COLD_BOOT: '1' });
    expect(a).toContain('-no-snapshot-load');
    expect(a[a.indexOf('-gpu') + 1]).toBe('swiftshader_indirect');
    expect(a).not.toContain('-no-window');
    expect(a).not.toContain('-no-snapshot');
    expect(emulatorBootArgs('Pixel', true, { SWIPIUM_EMULATOR_GPU: '  ', SWIPIUM_EMULATOR_COLD_BOOT: '0' })).not.toContain(
      '-no-snapshot-load',
    );
  });
});

describe('DirectDriver.launchApp', () => {
  it('resolves the launcher activity and uses am start -W with launcher intent flags', async () => {
    state.reply = (args) => (args.includes('resolve-activity') ? ok('priority=0\ncom.example.app/.MainActivity\n') : ok('Status: ok\n'));
    await new DirectDriver('emulator-5554').launchApp('com.example.app');
    const start = state.calls.find((c) => c.includes('am'));
    expect(start).toEqual([
      'adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-f',
      '0x10200000',
      '-n',
      "'com.example.app/.MainActivity'",
    ]);
    expect(state.calls.some((c) => c.includes('monkey'))).toBe(false);
  });
  it('falls back to monkey when resolution fails or am start reports an Error', async () => {
    state.reply = (args) => (args.includes('resolve-activity') ? ok('No activity found\n') : undefined);
    await new DirectDriver('e').launchApp('com.example.app');
    expect(state.calls.at(-1)).toContain('monkey');

    state.calls = [];
    state.reply = (args) =>
      args.includes('resolve-activity')
        ? ok('com.example.app/.Main\n')
        : args.includes('am')
          ? ok('Error: Activity class does not exist.\n')
          : undefined;
    await new DirectDriver('e').launchApp('com.example.app');
    expect(state.calls.map((c) => c.includes('monkey'))).toEqual([false, false, true]);
  });
});

describe('waitForForeground', () => {
  it('returns as soon as the package owns the foreground', async () => {
    const seq = ['com.android.launcher/.Home', 'com.example.app/.Main'];
    const d = { foregroundOwner: vi.fn(async () => seq.shift() ?? 'com.example.app/.Main') };
    const t0 = Date.now();
    expect(await waitForForeground(d, 'com.example.app', 2500)).toBe('com.example.app/.Main');
    expect(d.foregroundOwner).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('gives up at the cap and returns the last owner seen', async () => {
    const d = { foregroundOwner: vi.fn(async () => 'com.other/.X') };
    expect(await waitForForeground(d, 'com.example.app', 300)).toBe('com.other/.X');
    expect(d.foregroundOwner.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('prepare paths re-check once ~1 s later, so an early crash is still reported', async () => {
    const seq = ['com.example.app/.Main', 'com.android.launcher/.Home'];
    const d = { foregroundOwner: vi.fn(async () => seq.shift() ?? 'com.android.launcher/.Home') };
    const t0 = Date.now();
    expect(await waitForLaunch(d, 'com.example.app', 2500)).toBe('com.android.launcher/.Home');
    expect(d.foregroundOwner).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    // never came up: no re-check
    const never = { foregroundOwner: vi.fn(async () => 'com.other/.X') };
    await waitForLaunch(never, 'com.example.app', 300);
    expect(never.foregroundOwner.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('DirectDriver.foregroundOwner', () => {
  it('greps on the device and keeps the same parse (API 36 has only mCurrentFocus)', async () => {
    state.reply = () =>
      ok(
        '    topResumedActivity=ActivityRecord{2343 u0 com.android.settings/.Settings t48}\n' +
          '  mCurrentFocus=Window{4caf635 u0 com.android.settings/com.android.settings.Settings}\n',
      );
    expect(await new DirectDriver('e').foregroundOwner()).toBe('com.android.settings/com.android.settings.Settings');
    expect(state.calls[0].at(-1)).toMatch(/^dumpsys activity activities \| grep -E .*\|\| true$/);
  });
  it('prefers mResumedActivity when present; empty output is unknown', async () => {
    state.reply = () =>
      ok('    mResumedActivity: ActivityRecord{1 u0 com.example.app/.Main t3}\n  mCurrentFocus=Window{2 u0 com.other/com.other.X}\n');
    expect(await new DirectDriver('e').foregroundOwner()).toBe('com.example.app/.Main');
    state.reply = () => ok('');
    expect(await new DirectDriver('e').foregroundOwner()).toBe('unknown');
  });
});

describe('device metrics', () => {
  it('getOrientation reads both settings in one adb shell', async () => {
    state.reply = () => ok('1\n0\n');
    expect(await getOrientation('e')).toEqual({ rotation: 1, auto: false });
    expect(state.calls).toHaveLength(1);
  });
  it('DirectDriver caches density per device, not failures', async () => {
    state.reply = () => ok('Physical density: 420\n');
    const d = new DirectDriver('e');
    expect(await d.screenDensity()).toBe(420);
    expect(await d.screenDensity()).toBe(420);
    expect(state.calls).toHaveLength(1);
    d.useDevice('f');
    state.reply = () => ok('garbage');
    expect(await d.screenDensity()).toBeNull();
    state.reply = () => ok('Physical density: 320\n');
    expect(await d.screenDensity()).toBe(320);
    expect(state.calls).toHaveLength(3);
  });
  it('SimctlDriver.screenSize uses known PNG dims instead of another screenshot', async () => {
    const d = new SimctlDriver('SIM-1');
    // 3x heuristics: 1179 px wide is a 3x device.
    const size = await d.screenSize({ width: 1179, height: 2556 });
    expect(size).toEqual({ width: 393, height: 852 });
    expect(state.shots).toBe(0);
  });
});
