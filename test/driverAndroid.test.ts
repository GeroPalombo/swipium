// DirectDriver device-state parsing (rotation, IME frame) and keyboard hiding. The lib/spawn.run
// seam is mocked so every adb call is answered from canned dumpsys output.

import { describe, expect, it, vi, beforeEach } from 'vitest';

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const res = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const answers = new Map<string, string>();
const runMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return { ...actual, run: runMock };
});

const { DirectDriver, parseImeFrame, parseInputRotation } = await import('../src/drivers/DirectDriver.js');

beforeEach(() => {
  answers.clear();
  runMock.mockReset();
  runMock.mockImplementation((_cmd: string, args: string[]) => {
    const key = args.slice(3).join(' '); // drop -s SERIAL shell
    return Promise.resolve(res(answers.get(key) ?? ''));
  });
});

describe('rotation-aware screenSize (wm size is natural-orientation only)', () => {
  it('parses SurfaceOrientation and the newer viewport orientation line', () => {
    expect(parseInputRotation('    SurfaceOrientation: 1\n')).toBe(1);
    expect(
      parseInputRotation('  Viewport INTERNAL: displayId=0, uniqueId=local:1, port=0, orientation=3, logicalFrame=[0, 0, 2400, 1080]'),
    ).toBe(3);
    expect(parseInputRotation('nothing here')).toBeNull();
  });

  it('swaps width/height at 90/270 degrees and keeps them in portrait', async () => {
    answers.set('wm size', 'Physical size: 1080x2400\n');
    answers.set('dumpsys input', '  SurfaceOrientation: 1\n');
    expect(await new DirectDriver('emulator-5554').screenSize()).toEqual({ width: 2400, height: 1080 });
    answers.set('dumpsys input', '  SurfaceOrientation: 0\n');
    expect(await new DirectDriver('emulator-5554').screenSize()).toEqual({ width: 1080, height: 2400 });
    answers.set('wm size', 'Physical size: 1080x2400\nOverride size: 720x1600\n');
    answers.set('dumpsys input', '  SurfaceOrientation: 3\n');
    expect(await new DirectDriver('emulator-5554').screenSize()).toEqual({ width: 1600, height: 720 });
  });
});

describe('IME frame from dumpsys window InputMethod', () => {
  it('prefers the touchable region', () => {
    expect(
      parseImeFrame('    touchable region=SkRegion((0,1473,1080,2400))\n    Frames: parent=[0,0][1080,2400] frame=[0,0][1080,2400]'),
    ).toEqual([0, 1473, 1080, 2400]);
  });

  it('insets a near-full-screen IME window by its given visible insets (older builds)', () => {
    const dump =
      '    mFrame=[0,75][1080,1920] last=[0,75][1080,1920]\n    mGivenContentInsets=[0,1000][0,0] mGivenVisibleInsets=[0,1070][0,0]';
    expect(parseImeFrame(dump)).toEqual([0, 1145, 1080, 1920]);
  });

  it('uses a keyboard-sized frame as-is and returns null when absent', () => {
    expect(parseImeFrame('    Frames: parent=[0,0][1080,2400] display=[0,0][1080,2400] frame=[0,1500][1080,2400]')).toEqual([
      0, 1500, 1080, 2400,
    ]);
    expect(parseImeFrame('no window')).toBeNull();
  });
});

describe('hideKeyboard', () => {
  it('presses BACK only while the IME is shown', async () => {
    const d = new DirectDriver('emulator-5554');
    answers.set('dumpsys input_method', 'mInputShown=false');
    expect(await d.hideKeyboard()).toBe(false);
    expect(runMock.mock.calls.some((c) => (c[1] as string[]).includes('keyevent'))).toBe(false);
    answers.set('dumpsys input_method', 'mInputShown=true');
    expect(await d.hideKeyboard()).toBe(true);
    expect(runMock.mock.calls.some((c) => (c[1] as string[]).join(' ').endsWith('input keyevent 4'))).toBe(true);
  });
});
