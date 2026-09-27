// B6: the WDA-less simulator must report its screen size in POINTS (the unit `idb ui tap` and
// WebDriverAgent take), so captureCoordinateSpace derives the real 3x scale and every
// devicePoint a visual tool returns is tappable. Hermetic: spawn/which/simctl are mocked.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const state: { idb: boolean; idbStdout: string; plistScale: number | null; deviceName: string; px: [number, number]; calls: string[][] } = {
  idb: false,
  idbStdout: '',
  plistScale: null,
  deviceName: 'iPhone 15 Pro',
  px: [1179, 2556],
  calls: [],
};

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return {
    ...actual,
    run: async (cmd: string, args: string[]) => {
      state.calls.push([cmd, ...args]);
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });
      if (cmd === 'idb' && args[0] === 'describe') return ok(state.idbStdout);
      if (cmd === 'xcrun' && args.join(' ') === 'simctl list devices --json')
        return ok(
          JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-18-4': [
                { udid: 'SIM-1', name: state.deviceName, state: 'Booted', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.X' },
              ],
            },
          }),
        );
      if (cmd === 'xcrun' && args.join(' ') === 'simctl list devicetypes --json')
        return ok(
          JSON.stringify({
            devicetypes: [
              { identifier: 'com.apple.CoreSimulator.SimDeviceType.X', name: state.deviceName, bundlePath: '/Profiles/X.simdevicetype' },
            ],
          }),
        );
      if (cmd === 'plutil')
        return state.plistScale == null
          ? { code: 1, stdout: '', stderr: 'no such file', timedOut: false }
          : ok(JSON.stringify({ mainScreenScale: state.plistScale, mainScreenWidth: 1179 }));
      return { code: 1, stdout: '', stderr: '', timedOut: false };
    },
  };
});
vi.mock('../src/lib/android.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/android.js')>();
  return { ...actual, which: async (bin: string) => bin === 'idb' && state.idb };
});
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return { ...actual, screenshot: async () => pngHeader(state.px[0], state.px[1]) };
});

const { SimctlDriver, parseIdbDescribeScale, scaleFromDeviceName, scaleFromPixels } = await import('../src/drivers/SimctlDriver.js');
const { captureCoordinateSpace, toDevicePoint } = await import('../src/lib/coordSpace.js');

beforeEach(() => {
  state.idb = false;
  state.idbStdout = '';
  state.plistScale = null;
  state.deviceName = 'iPhone 15 Pro';
  state.px = [1179, 2556];
  state.calls = [];
});

describe('SimctlDriver point-size screen (B6)', () => {
  it('uses idb describe when idb is on PATH: 1179×2556 px @3x → 393×852 pt', async () => {
    state.idb = true;
    state.idbStdout = JSON.stringify({
      screen_dimensions: { width: 1179, height: 2556, density: 3.0, width_points: 393, height_points: 852 },
    });
    const d = new SimctlDriver('SIM-1');
    expect(await d.screenSize()).toEqual({ width: 393, height: 852 });
    expect((await d.pointScale()).source).toBe('idb');
    expect(state.calls).toContainEqual(['idb', 'describe', '--udid', 'SIM-1', '--json']);
  });

  it('falls back to the device type profile.plist mainScreenScale without idb', async () => {
    state.plistScale = 3;
    state.deviceName = 'Some Future Device';
    const d = new SimctlDriver('SIM-1');
    expect(await d.screenSize()).toEqual({ width: 393, height: 852 });
    expect((await d.pointScale()).source).toBe('device_type');
  });

  it('falls back to the name heuristic, then the pixel heuristic', async () => {
    const d = new SimctlDriver('SIM-1');
    expect(await d.screenSize()).toEqual({ width: 393, height: 852 });
    expect((await d.pointScale()).source).toBe('name_heuristic');

    state.deviceName = 'Mystery';
    const d2 = new SimctlDriver('SIM-1');
    expect(await d2.screenSize()).toEqual({ width: 393, height: 852 });
    expect((await d2.pointScale()).source).toBe('pixel_heuristic');
  });

  it('declares scale 3 in the coordinate space so devicePoints are points (consistent with WDA)', async () => {
    state.idb = true;
    state.idbStdout = JSON.stringify({
      screen_dimensions: { width: 1179, height: 2556, density: 3.0, width_points: 393, height_points: 852 },
    });
    const d = new SimctlDriver('SIM-1');
    const cs = await captureCoordinateSpace(d, pngHeader(1179, 2556));
    expect(cs.scale).toBe(3);
    expect(cs.device).toEqual({ width: 393, height: 852 });
    // bottom-right-ish screenshot pixel → on-screen point (would be off-screen if left in px)
    expect(toDevicePoint(cs, 1170, 2400)).toEqual({ x: 390, y: 800 });
  });

  it('parses idb describe and the documented heuristics', () => {
    expect(
      parseIdbDescribeScale('{"screen_dimensions":{"width":750,"height":1334,"density":2,"width_points":375,"height_points":667}}'),
    ).toBe(2);
    expect(parseIdbDescribeScale('{"screen_dimensions":{"density":3}}')).toBe(3);
    expect(parseIdbDescribeScale('not json')).toBeNull();
    expect(scaleFromDeviceName('iPhone 16 Pro Max')).toBe(3);
    expect(scaleFromDeviceName('iPhone 15 Plus')).toBe(3);
    expect(scaleFromDeviceName('iPhone 16')).toBe(3);
    expect(scaleFromDeviceName('iPhone SE (3rd generation)')).toBe(2);
    expect(scaleFromDeviceName('iPhone 11')).toBe(2);
    expect(scaleFromDeviceName('iPhone 11 Pro')).toBe(3);
    expect(scaleFromDeviceName('iPhone XR')).toBe(2);
    expect(scaleFromDeviceName('iPad Pro 13-inch (M4)')).toBe(2);
    expect(scaleFromDeviceName('Apple Watch')).toBeNull();
    expect(scaleFromPixels({ width: 1179, height: 2556 })).toBe(3);
    expect(scaleFromPixels({ width: 2556, height: 1179 })).toBe(3);
    expect(scaleFromPixels({ width: 750, height: 1334 })).toBe(2);
    expect(scaleFromPixels({ width: 2064, height: 2752 })).toBe(2);
  });
});
