// prepareAndroid must never install on a physical phone (P0 #1): after booting an AVD it waits for a
// NEW emulator serial (not one already online, and verified as an emulator), and an explicit
// physical serial is refused. It also always waits for sys.boot_completed on a pre-existing
// emulator that adb already lists as `device` (P2 #11). adb / getprop are faked.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-prep-home-'));
process.env.HOME = fakeHome;

const env = vi.hoisted(() => ({
  polls: [] as string[][],
  pollIdx: 0,
  bootWaits: [] as string[],
  booted: true,
}));

vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  adbDevices: vi.fn(async () => env.polls[Math.min(env.pollIdx++, env.polls.length - 1)] ?? []),
  bootEmulator: vi.fn(() => ({ kill: () => {} })),
  waitForBoot: vi.fn(async (serial: string) => {
    env.bootWaits.push(serial);
    return env.booted;
  }),
  deviceFreeDataBytes: vi.fn(async () => null),
  apkNativeAbis: vi.fn(async () => []),
  apkMinSdk: vi.fn(async () => null),
  deviceSdk: vi.fn(async () => null),
}));
vi.mock('../src/lib/spawn.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spawn.js')>()),
  run: vi.fn(async (_bin: string, args: string[]) => {
    const serial = args[0] === '-s' ? args[1] : '';
    const emu = /^emulator-/.test(serial);
    return { code: 0, stdout: `[ro.kernel.qemu]: [${emu ? '1' : '0'}]\n[sys.boot_completed]: [1]\n`, stderr: '', timedOut: false };
  }),
}));

const { SessionStore } = await import('../src/session/store.js');
const { prepareAndroid } = await import('../src/services/prepareAndroid.js');

const root = mkdtempSync(join(tmpdir(), 'swipium-prep-root-'));
const apk = join(root, 'app.apk');
writeFileSync(apk, 'PK');

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function fakeDriver() {
  const d = {
    serial: undefined as string | undefined,
    installedOn: [] as string[],
    kind: 'direct' as const,
    useDevice(s: string) {
      d.serial = s;
    },
    disableAnimations: async () => {},
    adbReverseMetro: async () => {},
    isInstalled: async () => false,
    installApp: async () => {
      d.installedOn.push(d.serial!);
    },
    launchApp: async () => {},
    foregroundOwner: async () => 'com.example.app/.Main',
  };
  return d;
}

beforeEach(() => {
  env.polls = [];
  env.pollIdx = 0;
  env.bootWaits = [];
  env.booted = true;
});

describe('prepareAndroid target selection', () => {
  it('boots an AVD with a phone online → installs on the NEW emulator serial, never the phone', async () => {
    // before boot: phone only; then the phone + the booting emulator appear.
    env.polls = [['R58M123ABC'], ['R58M123ABC'], ['R58M123ABC', 'emulator-5554']];
    const store = new SessionStore();
    const s = store.create(root);
    const d = fakeDriver();
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    try {
      const res = await prepareAndroid(store, s, d as never, {
        needBoot: true,
        bootTarget: 'Pixel_7',
        resolvedAppId: 'com.example.app',
        apkPath: apk,
      });
      expect(res.ok).toBe(true);
      expect(res.device).toBe('emulator-5554');
      expect(d.installedOn).toEqual(['emulator-5554']);
      expect(s.device).toBe('emulator-5554');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a phone that appears during the boot is not mistaken for the emulator', async () => {
    env.polls = [[], ['R58M123ABC'], ['R58M123ABC', 'emulator-5556']];
    const store = new SessionStore();
    const s = store.create(root);
    const d = fakeDriver();
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    try {
      const res = await prepareAndroid(store, s, d as never, {
        needBoot: true,
        bootTarget: 'Pixel_7',
        resolvedAppId: 'com.example.app',
        apkPath: apk,
      });
      expect(res.device).toBe('emulator-5556');
      expect(d.installedOn).not.toContain('R58M123ABC');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an explicit physical serial is refused before anything is installed', async () => {
    const store = new SessionStore();
    const s = store.create(root);
    const d = fakeDriver();
    const res = await prepareAndroid(store, s, d as never, {
      needBoot: false,
      serial: 'R58M123ABC',
      resolvedAppId: 'com.example.app',
      apkPath: apk,
    });
    expect(res).toMatchObject({ ok: false, failureCode: 'PHYSICAL_DEVICE_UNSUPPORTED' });
    expect(d.installedOn).toEqual([]);
    expect(s.device).toBeUndefined();
  });

  it('a pre-existing emulator always waits for sys.boot_completed; not booted → DEVICE_NOT_READY, no install', async () => {
    const store = new SessionStore();
    const s = store.create(root);
    const ok = fakeDriver();
    await prepareAndroid(store, s, ok as never, {
      needBoot: false,
      serial: 'emulator-5554',
      resolvedAppId: 'com.example.app',
      apkPath: apk,
    });
    expect(env.bootWaits).toContain('emulator-5554');
    expect(ok.installedOn).toEqual(['emulator-5554']);

    env.booted = false;
    const late = fakeDriver();
    const res = await prepareAndroid(store, s, late as never, {
      needBoot: false,
      serial: 'emulator-5554',
      resolvedAppId: 'com.example.app',
      apkPath: apk,
    });
    expect(res).toMatchObject({ ok: false, failureCode: 'DEVICE_NOT_READY' });
    expect(late.installedOn).toEqual([]);
  });
});
