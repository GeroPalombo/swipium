// Review round 2: DirectDriver.screenSize() caches size + rotation for a short TTL instead of
// running `wm size` + `dumpsys input` on every swipe, and stays correct after a rotation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const res = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const answers = new Map<string, string>();
const runMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return { ...actual, run: runMock };
});

const { DirectDriver, SCREEN_SIZE_TTL_MS, invalidateScreenSizeCache } = await import('../src/drivers/DirectDriver.js');

const calls = (sub: string) => runMock.mock.calls.filter((c) => (c[1] as string[]).slice(3).join(' ') === sub).length;

beforeEach(() => {
  answers.clear();
  runMock.mockReset();
  runMock.mockImplementation((_cmd: string, args: string[]) => Promise.resolve(res(answers.get(args.slice(3).join(' ')) ?? '')));
  answers.set('wm size', 'Physical size: 1080x2400\n');
  answers.set('dumpsys input', '  SurfaceOrientation: 0\n');
});
afterEach(() => vi.useRealTimers());

describe('DirectDriver screenSize cache', () => {
  it('reuses size + rotation within the TTL (one wm size / dumpsys input for a burst of swipes)', async () => {
    const d = new DirectDriver('emulator-5554');
    for (let i = 0; i < 5; i++) expect(await d.screenSize()).toEqual({ width: 1080, height: 2400 });
    expect(calls('wm size')).toBe(1);
    expect(calls('dumpsys input')).toBe(1);
  });

  it('re-reads after the TTL, so a device-side rotation is picked up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const d = new DirectDriver('emulator-5554');
    expect(await d.screenSize()).toEqual({ width: 1080, height: 2400 });
    answers.set('dumpsys input', '  SurfaceOrientation: 1\n');
    expect(await d.screenSize()).toEqual({ width: 1080, height: 2400 }); // cached
    vi.setSystemTime(Date.now() + SCREEN_SIZE_TTL_MS + 1);
    expect(await d.screenSize()).toEqual({ width: 2400, height: 1080 });
  });

  it('invalidateScreenSizeCache (Swipium orientation change) drops the cache immediately, per device or globally', async () => {
    const d = new DirectDriver('emulator-5554');
    const other = new DirectDriver('emulator-5556');
    await d.screenSize();
    await other.screenSize();
    answers.set('dumpsys input', '  SurfaceOrientation: 3\n');
    invalidateScreenSizeCache('emulator-5554');
    expect(await d.screenSize()).toEqual({ width: 2400, height: 1080 });
    expect(await other.screenSize()).toEqual({ width: 1080, height: 2400 }); // other device untouched
    invalidateScreenSizeCache();
    expect(await other.screenSize()).toEqual({ width: 2400, height: 1080 });
  });

  it('switching device and failed reads are never served from cache', async () => {
    const d = new DirectDriver('emulator-5554');
    await d.screenSize();
    answers.set('wm size', 'Physical size: 720x1280\n');
    d.useDevice('emulator-5556');
    expect(await d.screenSize()).toEqual({ width: 720, height: 1280 });
    const e = new DirectDriver('x');
    answers.set('wm size', 'garbage');
    expect(await e.screenSize()).toBeNull();
    answers.set('wm size', 'Physical size: 1080x2400\n');
    expect(await e.screenSize()).toEqual({ width: 1080, height: 2400 });
  });
});
