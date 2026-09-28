// DirectDriver latency + safety (spawn mocked, no device):
//  #3  dumpXml honours the settle budget (timeout per attempt <= remaining, <= N attempts)
//  #5  screen size: 30 s cache, free size from a fresh dump root, rotation in a dump drops the cache
//  #6  imeState(): shown + frame in ONE adb shell
//  #11 app ids / permissions are validated (INVALID_ARGUMENT) and shell-quoted

import { beforeEach, describe, expect, it, vi } from 'vitest';

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const res = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const runMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return { ...actual, run: runMock };
});

const { DirectDriver, dumpRootScreen, SCREEN_SIZE_TTL_MS } = await import('../src/drivers/DirectDriver.js');
const { grantPermission, listPackages } = await import('../src/lib/device.js');

const sub = (c: unknown[]) => (c[1] as string[]).slice(3).join(' ');
const callsOf = (s: string) => runMock.mock.calls.filter((c) => sub(c) === s).length;
const xml = (rotation: number, w: number, h: number) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${rotation}"><node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][${w},${h}]"></node></hierarchy>`;

let answers: Map<string, string | (() => Promise<RunResult>)>;
beforeEach(() => {
  answers = new Map();
  runMock.mockReset();
  runMock.mockImplementation((_cmd: string, args: string[]) => {
    const a = answers.get(args.slice(3).join(' ')) ?? answers.get(args.slice(2).join(' '));
    if (typeof a === 'function') return a();
    return Promise.resolve(res(a ?? ''));
  });
  answers.set('wm size', 'Physical size: 1080x2400\n');
  answers.set('dumpsys input', '  SurfaceOrientation: 0\n');
});

describe('#3 dumpXml budget', () => {
  it('passes the remaining budget as the adb timeout and stops after opts.attempts', async () => {
    answers.set('exec-out uiautomator dump /dev/tty', 'ERROR: could not get idle state.');
    const d = new DirectDriver('emulator-5554');
    await expect(d.dumpXml({ timeoutMs: 3000, attempts: 2 })).rejects.toThrow(/after 2 attempt/);
    const dumps = runMock.mock.calls.filter((c) => (c[1] as string[]).includes('uiautomator'));
    expect(dumps).toHaveLength(2);
    for (const c of dumps) expect((c[2] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(3000);
  });

  it('default (no opts) keeps the 5-attempt behaviour', async () => {
    vi.useFakeTimers();
    try {
      answers.set('exec-out uiautomator dump /dev/tty', 'ERROR: null root node returned by UiTestAutomationBridge.');
      const d = new DirectDriver('emulator-5554');
      const p = d.dumpXml().catch((e: Error) => e);
      await vi.runAllTimersAsync();
      expect(String(await p)).toMatch(/after 5 attempt/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#5 screen size', () => {
  it('TTL is 30 s', () => {
    expect(SCREEN_SIZE_TTL_MS).toBe(30_000);
  });

  it('a fresh dump with a [0,0]-anchored root answers screenSize() with no wm size / dumpsys input', async () => {
    answers.set('exec-out uiautomator dump /dev/tty', xml(0, 1080, 2400));
    const d = new DirectDriver('emulator-5554');
    await d.dumpXml();
    expect(await d.screenSize()).toEqual({ width: 1080, height: 2400 });
    expect(callsOf('wm size')).toBe(0);
    expect(callsOf('dumpsys input')).toBe(0);
  });

  it('a dump reporting a different rotation drops the cached size', async () => {
    const d = new DirectDriver('emulator-5554');
    expect(await d.screenSize()).toEqual({ width: 1080, height: 2400 }); // cached, rotation 0
    answers.set('exec-out uiautomator dump /dev/tty', xml(1, 2400, 1080));
    await d.dumpXml();
    expect(await d.screenSize()).toEqual({ width: 2400, height: 1080 });
  });

  it('dumpRootScreen rejects roots that are not the screen (dialog windows, wrong aspect)', () => {
    expect(dumpRootScreen(xml(0, 1080, 2400))).toEqual({ width: 1080, height: 2400 });
    expect(dumpRootScreen(xml(1, 1080, 2400))).toBeNull();
    expect(dumpRootScreen(xml(0, 1080, 2400).replace('[0,0]', '[40,600]'))).toBeNull();
  });
});

describe('#6 imeState', () => {
  it('one adb shell returns shown + frame', async () => {
    answers.set(
      'shell dumpsys input_method; echo __SWIPIUM_IME_SEP__; dumpsys window InputMethod',
      'mInputShown=true\n__SWIPIUM_IME_SEP__\n  touchable region=SkRegion((0,1500,1080,2400))\n',
    );
    const d = new DirectDriver('emulator-5554');
    expect(await d.imeState()).toEqual({ shown: true, frame: [0, 1500, 1080, 2400] });
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

describe('#11 app id validation', () => {
  it('rejects an injected app id before any adb call (typed INVALID_ARGUMENT)', async () => {
    const d = new DirectDriver('emulator-5554');
    for (const op of [
      () => d.launchApp('com.x; rm -rf /sdcard'),
      () => d.terminateApp('com.x && reboot'),
      () => d.clearData('$(id)'),
      () => d.isInstalled('com.x|sh'),
      () => d.isRunning('com.x`id`'),
      () => d.launchAppWithArgs('com.x;id', {}),
    ]) {
      const err = (await op().catch((e: Error) => e)) as Error & { code?: string };
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('INVALID_ARGUMENT');
      expect(err.message).toMatch(/^INVALID_ARGUMENT/);
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('a valid app id is single-quoted for the device shell', async () => {
    const d = new DirectDriver('emulator-5554');
    await d.terminateApp('com.acme.shop.debug');
    expect(runMock.mock.calls[0][1]).toEqual(['-s', 'emulator-5554', 'shell', 'am', 'force-stop', `'com.acme.shop.debug'`]);
  });

  it('device.ts: permissions + package filters are validated / quoted', async () => {
    await expect(grantPermission('s', 'com.x', 'android.permission.CAMERA; reboot')).rejects.toThrow(/INVALID_ARGUMENT/);
    await expect(grantPermission('s', 'com.x;id', 'android.permission.CAMERA')).rejects.toThrow(/INVALID_ARGUMENT/);
    expect(runMock).not.toHaveBeenCalled();
    await grantPermission('s', 'com.x.y', 'android.permission.CAMERA');
    expect(runMock.mock.calls[0][1]).toEqual(['-s', 's', 'shell', 'pm', 'grant', `'com.x.y'`, `'android.permission.CAMERA'`]);
    await listPackages('s', { filter: 'shop;reboot' });
    expect((runMock.mock.calls[1][1] as string[]).at(-1)).toBe(`'shop;reboot'`);
  });
});
