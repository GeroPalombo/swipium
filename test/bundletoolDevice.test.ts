// qa_bundletool connectedDevice targets exactly one resolved device (explicit serial, the session's
// own device, the SWIPIUM_DEVICE pin, else the only online one), refuses a physical phone before
// consent, and always passes --device-id. The device APK set cache is keyed by device id and ABI.
// Hermetic: adb and getprop are mocked.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-bundletool-home-'));
delete process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;

const env = vi.hoisted(() => ({ online: [] as string[] }));
vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  adbDevices: vi.fn(async () => [...env.online]),
}));
// getprop: emulator-N and "pixel-emu" are emulators; anything else is a physical phone.
vi.mock('../src/lib/spawn.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spawn.js')>()),
  run: vi.fn(async (_bin: string, args: string[]) => {
    const serial = args[0] === '-s' ? args[1] : '';
    if (args.includes('getprop')) {
      const emu = /^emulator-|^pixel-emu$/.test(serial);
      return {
        code: 0,
        stdout: `[ro.kernel.qemu]: [${emu ? '1' : '0'}]\n[ro.hardware]: [${emu ? 'ranchu' : 'qcom'}]\n[sys.boot_completed]: [1]\n`,
        stderr: '',
        timedOut: false,
      };
    }
    return { code: 1, stdout: '', stderr: 'mocked', timedOut: false };
  }),
}));

const { resolveApkSetDevice } = await import('../src/tools/bundletool.js');
const { deviceApkSetCachePath, buildApksConnectedArgs } = await import('../src/artifacts/bundletool.js');
type Session = import('../src/session/store.js').Session;

const session = (device?: string) => ({ id: 's1', root: '/p', device, mutations: [] }) as unknown as Session;
const sc = (r: { structuredContent?: unknown }) => (r.structuredContent ?? {}) as Record<string, unknown>;

afterEach(() => {
  env.online = [];
  delete process.env.SWIPIUM_DEVICE;
});

describe('resolveApkSetDevice', () => {
  it('a lone USB phone is refused before consent, never targeted', async () => {
    env.online = ['R58M123ABC'];
    const r = await resolveApkSetDevice(session(), undefined);
    expect('error' in r && sc(r.error).failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
  });

  it('an explicit physical serial is refused too', async () => {
    env.online = ['emulator-5554', 'R58M123ABC'];
    const r = await resolveApkSetDevice(session(), 'R58M123ABC');
    expect('error' in r && sc(r.error).failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
  });

  it('the session device wins over other online devices', async () => {
    env.online = ['emulator-5556', 'emulator-5554'];
    expect(await resolveApkSetDevice(session('emulator-5554'), undefined)).toEqual({ deviceId: 'emulator-5554' });
  });

  it('the only online emulator is used and named', async () => {
    env.online = ['pixel-emu'];
    expect(await resolveApkSetDevice(session(), undefined)).toEqual({ deviceId: 'pixel-emu' });
  });

  it('several devices and no session device asks for one instead of letting bundletool pick', async () => {
    env.online = ['emulator-5554', 'emulator-5556'];
    const r = await resolveApkSetDevice(session(), undefined);
    expect('error' in r && sc(r.error).failureCode).toBe('MULTIPLE_DEVICES');
  });

  it('an offline session device is not swapped for another online device', async () => {
    env.online = ['emulator-5556'];
    const r = await resolveApkSetDevice(session('emulator-5554'), undefined);
    expect('error' in r && sc(r.error).failureCode).toBe('NO_DEVICE');
  });

  it('an iOS simulator session needs an explicit serial', async () => {
    env.online = ['emulator-5554'];
    const ios = session('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE');
    const r = await resolveApkSetDevice(ios, undefined);
    expect('error' in r && String(sc(r.error).what)).toMatch(/iOS simulator/);
    expect(await resolveApkSetDevice(ios, 'emulator-5554')).toEqual({ deviceId: 'emulator-5554' });
  });

  it('SWIPIUM_DEVICE refuses another explicit device and picks the pinned one by default', async () => {
    env.online = ['emulator-5554', 'emulator-5556'];
    process.env.SWIPIUM_DEVICE = 'emulator-5556';
    const r = await resolveApkSetDevice(session(), 'emulator-5554');
    expect('error' in r && sc(r.error).failureCode).toBe('DEVICE_PINNED');
    expect(await resolveApkSetDevice(session(), undefined)).toEqual({ deviceId: 'emulator-5556' });
  });
});

describe('device APK set cache and argv', () => {
  it('the cache path is keyed by device id and ABI', () => {
    const a = deviceApkSetCachePath('/p/app.aab', '/p', 'emulator-5554', 'arm64-v8a');
    const b = deviceApkSetCachePath('/p/app.aab', '/p', 'emulator-5554', 'x86_64');
    expect(a).toBe('/p/.swipium/artifacts/app-emulator-5554-arm64-v8a.apks');
    expect(a).not.toBe(b);
    expect(deviceApkSetCachePath('/p/app.aab', '/p', 'emulator-5556', 'arm64-v8a')).not.toBe(a);
  });

  it('build-apks gets --device-id', () => {
    const args = buildApksConnectedArgs({ cmd: 'bundletool', prefix: [], describe: 'bundletool' }, '/p/app.aab', '/o.apks', {
      deviceId: 'emulator-5554',
    });
    expect(args.slice(args.indexOf('--device-id'), args.indexOf('--device-id') + 2)).toEqual(['--device-id', 'emulator-5554']);
  });
});
