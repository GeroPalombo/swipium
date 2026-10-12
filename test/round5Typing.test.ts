// Round-5 typing (android R5-1, R5-2), hermetic on the real DirectDriver with adb mocked:
//  - long text: one UI dump that times out skips that read-back instead of turning checking off,
//    so a piece that lost characters is still found and deleted and resent at the next read-back;
//  - clearFocusedText(n, { byLength: true }) (the replace retry) clears by length with
//    CTRL+MOVE_END + DEL/FORWARD_DEL, never with the select-all that just failed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const adb = vi.hoisted(() => ({
  calls: [] as string[][],
  /** The focused EditText's value (caret at the end). */
  field: '',
  /** `input text` calls sent so far at each dump. */
  dumpsAt: [] as number[],
  /** Dumps time out while this many `input text` calls have been sent (all: every dump). */
  failDumpsAt: new Set<number>() as Set<number> | 'all',
  /** 1-based `input text` numbers that lose their last character. */
  dropOnText: new Set<number>(),
  texts: 0,
}));

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
        adb.dumpsAt.push(adb.texts);
        if (adb.failDumpsAt === 'all' || adb.failDumpsAt.has(adb.texts)) throw new Error(`\`adb ${line}\` exited null (timed out): `);
        return ok(
          `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
            `<node class="android.widget.EditText" package="com.example.app" text="${adb.field}" resource-id="" content-desc="" ` +
            `focused="true" bounds="[0,0][1080,200]" clickable="true" enabled="true"/></hierarchy>`,
        );
      }
      if (line.endsWith('input keycombination 113 29')) return ok();
      // DEL (67) deletes before the caret, which sits at the end.
      const dels = line.split(' ').filter((k) => k === '67').length;
      if (dels) adb.field = adb.field.slice(0, Math.max(0, adb.field.length - dels));
      for (const m of line.matchAll(/input text (\S+)/g)) {
        const t = m[1];
        adb.field += adb.dropOnText.has(++adb.texts) ? t.slice(0, -1) : t;
      }
      return ok();
    },
  };
});

const { DirectDriver } = await import('../src/drivers/DirectDriver.js');

beforeEach(() => {
  adb.calls.length = 0;
  adb.field = '';
  adb.dumpsAt = [];
  adb.failDumpsAt = new Set();
  adb.dropOnText = new Set();
  adb.texts = 0;
});
const shellLines = () => adb.calls.map((a) => a.slice(2).join(' '));

/** 200 letters: 5 pieces of 40, read back after pieces 2, 4 and 5. */
const LONG = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join('');

describe('long text read-back survives a dump timeout (R5-1)', () => {
  it('a timed-out read-back is skipped, and the next one still deletes and resends a piece that lost a char', async () => {
    adb.failDumpsAt = new Set([4]); // the read-back after piece 4
    adb.dropOnText = new Set([3]); // piece 3 loses its last char
    const d = new DirectDriver('emulator-5570');
    await d.inputText(LONG);
    expect(adb.field).toBe(LONG);
    // The recovery ran: a DEL batch, then pieces 3-5 sent again (5 + 3 = 8 `input text` calls).
    expect(shellLines().some((l) => / input keyevent 67/.test(l))).toBe(true);
    expect(shellLines().filter((l) => l.includes('input text'))).toHaveLength(8);
  }, 20000);

  it('checking turns off only after several timeouts in a row (typing still finishes)', async () => {
    adb.failDumpsAt = 'all';
    const d = new DirectDriver('emulator-5572');
    const text = LONG + LONG; // 10 pieces: read-backs after pieces 2, 4, 6, 8 and 10
    await d.inputText(text);
    expect(adb.field).toBe(text);
    // After a miss the next piece is read back (its pieces stay unchecked): pieces 2, 3 and 4,
    // three misses in a row, then no more dumps.
    expect([...new Set(adb.dumpsAt)]).toEqual([2, 3, 4]);
  });
});

describe('replace retry clears by length, not with select-all again (R5-2)', () => {
  it('byLength: CTRL+MOVE_END, then DEL and FORWARD_DEL by the real length; no CTRL+A', async () => {
    const d = new DirectDriver('emulator-5574');
    await d.clearFocusedText(); // first clear: probes and uses select-all
    adb.calls.length = 0;
    adb.field = 'left over text';
    await d.clearFocusedText(4, { byLength: true });
    const lines = shellLines();
    expect(lines.some((l) => l.includes('keycombination 113 29'))).toBe(false);
    const last = lines.at(-1)!;
    expect(last.startsWith('shell input keycombination 113 123 ; input keyevent 123 67')).toBe(true);
    // The real length (14) wins over the guess (4): 16 DEL and 16 FORWARD_DEL.
    expect(last.split(' ').filter((k) => k === '67')).toHaveLength(16);
    expect(last.split(' ').filter((k) => k === '112')).toHaveLength(16);
    expect(adb.field).toBe('');
  });
});
