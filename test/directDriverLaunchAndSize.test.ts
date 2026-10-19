// DirectDriver, adb faked through lib/spawn.run:
//  - launchAppWithArgs / openUrl throw on an `Error:` line from `am start` (it exits 0 then)
//  - screenSize() ignores a dump taken before a Swipium orientation change
//  - a size read while the rotation is unknown is never cached
//  - SWIPIUM_ANDROID_DUMPER other than "agent" counts as off (the exec-out hint still shows)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const res = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const answers = new Map<string, string | Error>();
const runMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawn.js')>()),
  run: runMock,
}));

const { DirectDriver, amStartError, invalidateScreenSizeCache } = await import('../src/drivers/DirectDriver.js');

/** The adb args after `-s <serial> shell`, joined. */
const sub = (args: string[]) => args.slice(3).join(' ');
const calls = (s: string) => runMock.mock.calls.filter((c) => sub(c[1] as string[]) === s).length;

beforeEach(() => {
  answers.clear();
  runMock.mockReset();
  runMock.mockImplementation((_cmd: string, args: string[]) => {
    const key = (args[2] === 'exec-out' ? args.slice(2) : args.slice(3)).join(' ');
    const a = [...answers.entries()].find(([k]) => key.startsWith(k))?.[1] ?? '';
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(res(a));
  });
  answers.set('cmd package resolve-activity', 'com.acme.app/.MainActivity\n');
  answers.set('wm size', 'Physical size: 1080x2400\n');
  answers.set('dumpsys input', '  SurfaceOrientation: 0\n');
});
afterEach(() => {
  delete process.env.SWIPIUM_ANDROID_DUMPER;
});

describe('am start errors', () => {
  it('amStartError reads the Error lines only', () => {
    expect(amStartError('Starting: Intent { ... }\nStatus: ok\n')).toBeUndefined();
    expect(amStartError('Warning: Activity not started, its current task has been brought to the front\n')).toBeUndefined();
    expect(amStartError('Starting: Intent\nError type 3\nError: Activity class {x/.Y} does not exist.\n')).toBe(
      'Error type 3; Error: Activity class {x/.Y} does not exist.',
    );
  });

  it('launchAppWithArgs throws when am start reports an Error', async () => {
    answers.set(
      'am start -W -S -n',
      'Starting: Intent { cmp=com.acme.app/.MainActivity }\nError: Activity not started, unknown error code -96\n',
    );
    await expect(new DirectDriver('emulator-5554').launchAppWithArgs('com.acme.app', { debug: true })).rejects.toThrow(
      /Could not launch com\.acme\.app with arguments: Error: Activity not started/,
    );
    answers.set('am start -W -S -n', 'Status: ok\nLaunchState: COLD\n');
    await expect(new DirectDriver('emulator-5554').launchAppWithArgs('com.acme.app', { debug: true })).resolves.toBeUndefined();
  });

  it('openUrl throws when no activity handles the URL', async () => {
    answers.set(
      'am start -a android.intent.action.VIEW',
      'Starting: Intent { act=android.intent.action.VIEW dat=acme://x }\nError: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW dat=acme://x flg=0x10000000 }\n',
    );
    await expect(new DirectDriver('emulator-5554').openUrl('acme://x')).rejects.toThrow(
      /Could not open acme:\/\/x: Error: Activity not started, unable to resolve Intent/,
    );
    answers.set('am start -a android.intent.action.VIEW', 'Starting: Intent { act=android.intent.action.VIEW dat=acme://x }\n');
    await expect(new DirectDriver('emulator-5554').openUrl('acme://x')).resolves.toBeUndefined();
  });

  it('reads the Error lines from stderr too (Android 7+ prints them there)', async () => {
    runMock.mockImplementation(() =>
      Promise.resolve({
        code: 0,
        stdout: 'Starting: Intent { act=android.intent.action.VIEW dat=acme://x }\n',
        stderr: 'Error: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW dat=acme://x }\n',
        timedOut: false,
      }),
    );
    await expect(new DirectDriver('emulator-5554').openUrl('acme://x')).rejects.toThrow(/unable to resolve Intent/);
  });
});

const dump = (rotation: number, w: number, h: number) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${rotation}"><node bounds="[0,0][${w},${h}]" class="android.widget.FrameLayout"/></hierarchy>`;

describe('screenSize after an orientation change', () => {
  it('a dump from before invalidateScreenSizeCache is not reused', async () => {
    const d = new DirectDriver('emulator-7001');
    answers.set('exec-out uiautomator dump', dump(0, 1080, 2400));
    await d.dumpXml();
    expect(await d.screenSize()).toEqual({ width: 1080, height: 2400 }); // fresh dump answers
    expect(calls('wm size')).toBe(0);
    answers.set('dumpsys input', '  SurfaceOrientation: 1\n');
    invalidateScreenSizeCache('emulator-7001'); // qa_orientation rotated the device
    expect(await d.screenSize()).toEqual({ width: 2400, height: 1080 });
    expect(calls('wm size')).toBe(1);
  });

  it('an unknown rotation (dumpsys input failed) answers once but is not cached', async () => {
    const d = new DirectDriver('emulator-7002');
    answers.set('dumpsys input', new Error('`adb shell dumpsys input` exited 1: device offline'));
    expect(await d.screenSize()).toEqual({ width: 1080, height: 2400 });
    answers.set('dumpsys input', '  SurfaceOrientation: 1\n');
    expect(await d.screenSize()).toEqual({ width: 2400, height: 1080 });
    expect(calls('wm size')).toBe(2);
    expect(await d.screenSize()).toEqual({ width: 2400, height: 1080 }); // now cached
    expect(calls('wm size')).toBe(2);
  });
});

describe('SWIPIUM_ANDROID_DUMPER', () => {
  it('a value other than "agent" is off: the idle-state hint still points at the agent', async () => {
    process.env.SWIPIUM_ANDROID_DUMPER = '0';
    answers.set('exec-out uiautomator dump', 'ERROR: could not get idle state.');
    await expect(new DirectDriver('emulator-7003').dumpXml({ attempts: 1 })).rejects.toThrow(
      /SWIPIUM_ANDROID_DUMPER=agent dumps such screens/,
    );
  });
});
