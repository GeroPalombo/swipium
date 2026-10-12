// Round-4 typing (CR P5 M4, AND NEW-replace, AND-14, AND NEW R4-4), all hermetic:
//  - DirectDriver.clearFocusedText: select-all + DEL (probed once per device), the DEL / FORWARD_DEL
//    fallback on "Unknown command", and the wait after a focusing tap;
//  - careful inputText: <= 8-char pieces, each moved to the end, read back as it goes;
//  - a uiautomator dump that runs into the adb timeout fails once with DEVICE_UNRESPONSIVE (no retries);
//  - qa_act type at x,y in replace mode: leftover text in the focused field under the tap is retried
//    once (clear + careful retype), then fails with TEXT_INPUT_MISMATCH; a retry that lands passes
//    with retyped:true.
// adb is the mocked lib/spawn.run; qa_act runs on the in-memory server with a fake driver.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const adb = vi.hoisted(() => ({
  calls: [] as string[][],
  /** stdout for `input keycombination 113 29` (the probe). */
  comboStdout: '',
  /** The focused EditText's value (grows with `input text`). */
  field: '',
  dumpTimesOut: false,
}));

/** `input text` argv back to text: %s is a space, a backslash escapes the next char. */
const unescapeAdb = vi.hoisted(() => (s: string) => s.replace(/%s/g, ' ').replace(/\\(.)/g, '$1'));

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return {
    ...actual,
    run: async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd !== 'adb') return actual.run(cmd, args);
      adb.calls.push(args);
      const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
      const line = args.join(' ');
      if (line.includes('exec-out uiautomator dump')) {
        if (adb.dumpTimesOut) throw new Error(`\`adb ${line}\` exited null (timed out): `);
        return ok(
          `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
            `<node class="android.widget.EditText" package="com.example.app" text="${adb.field}" resource-id="" content-desc="" ` +
            `focused="true" bounds="[0,0][1080,200]" clickable="true" enabled="true"/></hierarchy>`,
        );
      }
      if (line.endsWith('input keycombination 113 29')) return ok(adb.comboStdout);
      for (const m of line.matchAll(/input text (\S+)/g)) adb.field += unescapeAdb(m[1]);
      return ok();
    },
  };
});

const { DirectDriver } = await import('../src/drivers/DirectDriver.js');
const { FakeDriver, dump, fillTextField, harness, structured } = await import('./actFixFake.js');

beforeEach(() => {
  adb.calls.length = 0;
  adb.comboStdout = '';
  adb.field = '';
  adb.dumpTimesOut = false;
});
const shellLines = () => adb.calls.map((a) => a.slice(2).join(' '));

describe('DirectDriver select-all clear (CR P5 M4, AND NEW-replace)', () => {
  it('probes keycombination once, then clears with one CTRL+A ; DEL call', async () => {
    const d = new DirectDriver('emulator-5554');
    await d.clearFocusedText();
    expect(shellLines()).toEqual(['shell input keycombination 113 29', 'shell input keyevent 67']);
    adb.calls.length = 0;
    await d.clearFocusedText();
    expect(shellLines()).toEqual(['shell input keycombination 113 29 ; input keyevent 67']);
  });

  it('falls back to DEL + FORWARD_DEL by length on "Unknown command" (older Android), and keeps the fallback', async () => {
    adb.comboStdout = 'Error: Unknown command: keycombination';
    adb.field = 'hello world';
    const d = new DirectDriver('emulator-5556');
    await d.clearFocusedText(4);
    const last = shellLines().at(-1)!;
    expect(last.startsWith('shell input keyevent 123 67')).toBe(true);
    // The real field length (11) wins over the caller's guess (4): 13 DEL and 13 FORWARD_DEL.
    expect(last.split(' ').filter((k) => k === '67')).toHaveLength(13);
    expect(last.split(' ').filter((k) => k === '112')).toHaveLength(13);
    adb.calls.length = 0;
    await d.clearFocusedText(4);
    expect(shellLines().some((l) => l.includes('keycombination'))).toBe(false);
  });

  it('waits until the focusing tap is about 0.9 s old before the select-all', async () => {
    const d = new DirectDriver('emulator-5558');
    await d.tapXY(10, 10);
    const t0 = Date.now();
    await d.clearFocusedText();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    const t1 = Date.now();
    await d.clearFocusedText(); // no tap since: no wait
    expect(Date.now() - t1).toBeLessThan(400);
  });
});

describe('careful inputText and a hung dump (AND-14, AND NEW R4-4)', () => {
  it('careful mode sends <= 8-char pieces, each moved to the end, and the field reads back whole', async () => {
    const d = new DirectDriver('emulator-5560');
    const text = 'The quick brown fox jumps';
    await d.inputText(text, { careful: true });
    const typing = shellLines().filter((l) => l.includes('input text'));
    expect(typing.length).toBe(Math.ceil(text.length / 8));
    for (const l of typing) {
      expect(l).toMatch(/^shell input (keyevent 123|keycombination 113 123) ; input text \S+$/);
      expect(unescapeAdb(l.replace(/^.* input text /, '')).length).toBeLessThanOrEqual(8);
    }
    expect(shellLines().some((l) => l.includes('uiautomator dump'))).toBe(true);
    expect(adb.field).toBe(text);
  });

  it('a dump that hits the adb timeout fails at once with DEVICE_UNRESPONSIVE (one attempt)', async () => {
    adb.dumpTimesOut = true;
    const d = new DirectDriver('emulator-5562');
    await expect(d.dumpXml()).rejects.toThrow(/DEVICE_UNRESPONSIVE/);
    expect(shellLines().filter((l) => l.includes('uiautomator dump'))).toHaveLength(1);
  });
});

describe('qa_act type at x,y: leftover text in the focused field (CR P5 M4, AND NEW-replace)', () => {
  const FIELD: [number, number, number, number] = [40, 300, 1040, 400];
  const screen = () =>
    dump([
      { cls: 'android.widget.TextView', text: 'Profile', bounds: [40, 100, 1040, 180], clickable: false },
      {
        cls: 'android.widget.EditText',
        text: 'old',
        id: 'com.example.app:id/name',
        bounds: FIELD,
        extra: 'focused="true" focusable="true"',
      },
    ]);

  /** A field whose select-all clear fails `failClears` times (the Compose caret race), then works. */
  class LeftoverDriver extends FakeDriver {
    inputs: Array<{ text: string; opts?: { careful?: boolean } }> = [];
    constructor(private failClears: number) {
      super(screen());
    }
    async clearFocusedText(len?: number, opts?: { byLength?: boolean }) {
      this.rec('clearFocusedText', len, opts);
      if (this.failClears-- > 0) return;
      this.xml = fillTextField(this.xml, 500, 350, '');
    }
    async inputText(text: string, opts?: { careful?: boolean }) {
      this.rec('inputText', text, opts);
      this.inputs.push({ text, opts });
      this.xml = fillTextField(this.xml, 500, 350, text, true);
    }
  }

  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness('round4-typing');
  });
  afterAll(async () => {
    await h.close();
  });

  it('retries once (clear + careful retype) and fails with TEXT_INPUT_MISMATCH when the text is still left over', async () => {
    const d = new LeftoverDriver(5);
    const sessionId = await h.start(d);
    const res = structured(await h.call('qa_act', { sessionId, action: 'type', target: { x: 500, y: 350 }, text: 'hello' }));
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('TEXT_INPUT_MISMATCH');
    expect(res.retrySafe).toBe(true);
    expect(d.got('clearFocusedText')).toHaveLength(2);
    // R5-2: the retry clears by length, not with the select-all that just failed.
    expect(d.got('clearFocusedText')[0].a[1]).toBeUndefined();
    expect(d.got('clearFocusedText')[1].a[1]).toEqual({ byLength: true });
    expect(d.inputs).toEqual([
      { text: 'hello', opts: undefined },
      { text: 'hello', opts: { careful: true } },
    ]);
  });

  it('a retry that clears passes with retyped:true', async () => {
    const d = new LeftoverDriver(1);
    const sessionId = await h.start(d);
    const res = structured(await h.call('qa_act', { sessionId, action: 'type', target: { x: 500, y: 350 }, text: 'hello' }));
    expect(res.ok).toBe(true);
    expect(res.retyped).toBe(true);
    expect(d.inputs).toHaveLength(2);
  });

  it('a clean replace types once, with no retry', async () => {
    const d = new LeftoverDriver(0);
    const sessionId = await h.start(d);
    const res = structured(await h.call('qa_act', { sessionId, action: 'type', target: { x: 500, y: 350 }, text: 'hello' }));
    expect(res.ok).toBe(true);
    expect(res.retyped).toBeUndefined();
    expect(d.inputs).toHaveLength(1);
  });
});
