// B1 quick boot: `-no-snapshot-save` never creates the AVD's quick-boot snapshot, so after a cold
// boot Swipium saves `default_boot` once (ensureQuickbootSnapshot); a snapshot restore is detected
// from the guest uptime. Also: prepareAndroid marks the session snapshot stale after the boot and
// the launch (R2). adb is faked.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-qb-home-'));
process.env.HOME = fakeHome;

const env = vi.hoisted(() => ({ uptime: '25.0 30.0', saveOut: '', saveCode: 0 as number | null, calls: [] as string[][] }));

vi.mock('../src/lib/spawn.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spawn.js')>()),
  run: vi.fn(async (_bin: string, args: string[]) => {
    env.calls.push(args);
    if (args.includes('/proc/uptime')) return { code: 0, stdout: env.uptime, stderr: '', timedOut: false };
    if (args.includes('emu')) return { code: env.saveCode, stdout: env.saveOut, stderr: '', timedOut: false };
    const emu = /^emulator-/.test(args[1] ?? '');
    return { code: 0, stdout: `[ro.kernel.qemu]: [${emu ? '1' : '0'}]\n[sys.boot_completed]: [1]\n`, stderr: '', timedOut: false };
  }),
}));

const android = await import('../src/lib/android.js');
const { bootWasCold, ensureQuickbootSnapshot } = android;
const { SessionStore } = await import('../src/session/store.js');
const { actionSeq } = await import('../src/snapshot/fresh.js');

// Snapshot saves only (`emu avd name`, which looks for an already-running AVD, is not a save).
const saves = () => env.calls.filter((a) => a.includes('emu') && a.includes('snapshot'));

beforeEach(() => {
  env.uptime = '25.0 30.0';
  env.saveOut = '';
  env.saveCode = 0;
  env.calls = [];
});
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

describe('bootWasCold', () => {
  it('a cold boot cannot have more uptime than the time since spawn; a snapshot restore does', () => {
    expect(bootWasCold(20.2, 21_000)).toBe(true); // measured cold boot: 20.2 s uptime after 21 s
    expect(bootWasCold(22.9, 3_400)).toBe(false); // measured snapshot restore: 22.9 s uptime after 3.4 s
  });
});

describe('ensureQuickbootSnapshot', () => {
  it('saves default_boot after a cold boot (success prints nothing)', async () => {
    env.uptime = '20.0 30.0';
    expect(await ensureQuickbootSnapshot('emulator-5556', Date.now() - 21_000, {})).toBe('snapshot_saved');
    expect(saves()).toEqual([['-s', 'emulator-5556', 'emu', 'avd', 'snapshot', 'save', 'default_boot']]);
  });

  it('does not save when the boot restored a snapshot', async () => {
    expect(await ensureQuickbootSnapshot('emulator-5556', Date.now() - 3_400, {})).toBe('snapshot_loaded');
    expect(saves()).toEqual([]);
  });

  it('reports save_failed on a KO / error answer', async () => {
    env.uptime = '20.0 30.0';
    env.saveOut = 'KO: snapshot save failed';
    expect(await ensureQuickbootSnapshot('emulator-5556', Date.now() - 21_000, {})).toBe('save_failed');
    env.saveOut = '';
    env.saveCode = 1;
    expect(await ensureQuickbootSnapshot('emulator-5556', Date.now() - 21_000, {})).toBe('save_failed');
  });

  it('SWIPIUM_EMULATOR_COLD_BOOT=1 skips it without any adb call', async () => {
    expect(await ensureQuickbootSnapshot('emulator-5556', Date.now(), { SWIPIUM_EMULATOR_COLD_BOOT: '1' })).toBe('skipped');
    expect(env.calls).toEqual([]);
  });
});

describe('prepareAndroid boot', () => {
  it('records the quick-boot outcome and marks the stored snapshot stale after boot and launch', async () => {
    // 1st call: is the AVD already running (bind it instead of booting)? 2nd: serials before the boot.
    vi.spyOn(android, 'adbDevices')
      .mockResolvedValueOnce(['emulator-5554'])
      .mockResolvedValueOnce(['emulator-5554'])
      .mockResolvedValue(['emulator-5554', 'emulator-5556']);
    vi.spyOn(android, 'bootEmulator').mockReturnValue({ kill: () => true } as never);
    vi.spyOn(android, 'waitForBoot').mockResolvedValue(true);
    env.uptime = '0.5 1.0'; // cold
    const { prepareAndroid } = await import('../src/services/prepareAndroid.js');
    const root = mkdtempSync(join(tmpdir(), 'swipium-qb-root-'));
    writeFileSync(join(root, 'app.apk'), 'PK');
    const store = new SessionStore();
    const s = store.create(root);
    const before = actionSeq(s);
    const d = {
      useDevice: () => {},
      disableAnimations: async () => {},
      isInstalled: async () => true,
      launchApp: async () => {},
      foregroundOwner: async () => 'com.example.app/.Main',
    };
    const res = await prepareAndroid(store, s, d as never, { needBoot: true, bootTarget: 'Pixel_9XL', resolvedAppId: 'com.example.app' });
    expect(res).toMatchObject({ ok: true, device: 'emulator-5556', launchedOk: true });
    expect(saves()).toHaveLength(1);
    expect(JSON.stringify(s)).toContain('"quickboot":"snapshot_saved"');
    expect(actionSeq(s)).toBe(before + 2);
    rmSync(root, { recursive: true, force: true });
  });
});
