// SWIP-01 — `adb shell input text` device-shell escaping. `adb shell` space-joins its
// trailing args into ONE string re-parsed by the device-side /system/bin/sh, so every
// shell metacharacter in typed text must be backslash-escaped or the device shell
// corrupts the text (or executes it). Mocks the lib/spawn.run seam (same pattern as
// doctor.test.ts) to capture the exact argv DirectDriver hands to adb.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const ok: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false };

const runMock = vi.hoisted(() => vi.fn(() => Promise.resolve(ok)));

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return { ...actual, run: runMock };
});

const { DirectDriver, adbInputTextChunks, escapeAdbInputText, deviceShellQuote } = await import('../src/drivers/DirectDriver.js');
const { classifyFlowDriverError } = await import('../src/flows/run.js');

/** Types `payload` and returns the final adb argv element (the escaped text). */
async function escapedArg(payload: string): Promise<string> {
  runMock.mockClear();
  await new DirectDriver('SERIAL').inputText(payload);
  expect(runMock).toHaveBeenCalledTimes(1);
  const [cmd, args] = runMock.mock.calls[0] as unknown as [string, string[]];
  expect(cmd).toBe('adb');
  expect(args.slice(0, -1)).toEqual(['-s', 'SERIAL', 'shell', 'input', 'text']);
  return args[args.length - 1];
}

describe('DirectDriver.inputText device-shell escaping', () => {
  beforeEach(() => runMock.mockClear());

  it.each([
    ['&', '\\&'],
    ['|', '\\|'],
    [';', '\\;'],
    ['"', '\\"'],
    ["'", "\\'"],
    ['$', '\\$'],
    ['(', '\\('],
    [')', '\\)'],
    ['<', '\\<'],
    ['>', '\\>'],
    ['\\', '\\\\'],
    ['*', '\\*'],
    ['`', '\\`'],
    ['?', '\\?'],
    ['!', '\\!'],
    ['#', '\\#'],
    ['~', '\\~'],
    ['^', '\\^'],
    ['{', '\\{'],
    ['}', '\\}'],
    ['[', '\\['],
    [']', '\\]'],
    [' ', '%s'],
  ])('escapes %j as %j', async (raw, escaped) => {
    expect(await escapedArg(`a${raw}b`)).toBe(`a${escaped}b`);
  });

  it('escapes a realistic password without corrupting it', async () => {
    expect(await escapedArg('P@ss&w0rd!$')).toBe('P@ss\\&w0rd\\!\\$');
  });

  it('escapes backslashes before metacharacters so escapes are not doubled', async () => {
    // A literal `\$` in the text must reach the device as `\\\$` (escaped backslash, escaped $).
    expect(await escapedArg('c:\\path $HOME')).toBe('c:\\\\path%s\\$HOME');
  });

  it('escapes injection payloads into inert literals', async () => {
    expect(await escapedArg('x; rm -rf /')).toBe('x\\;%srm%s-rf%s/');
    expect(await escapedArg('$(reboot)')).toBe('\\$\\(reboot\\)');
    expect(await escapedArg('`id` && echo pwned > /tmp/x')).toBe('\\`id\\`%s\\&\\&%secho%spwned%s\\>%s/tmp/x');
  });

  it('leaves shell-safe characters untouched', async () => {
    expect(await escapedArg('user@example.com_2024-ok:%d+=,.')).toBe('user@example.com_2024-ok:%d+=,.');
  });

  it('escapes brace/glob expansion so {a,b} and [s]dcard reach the device literally', async () => {
    expect(await escapedArg('{a,b}')).toBe('\\{a,b\\}');
    expect(await escapedArg('[s]dcard')).toBe('\\[s\\]dcard');
  });

  it('splits a literal "%s" across two input text calls (sendText rewrites every %s to a space)', async () => {
    runMock.mockClear();
    await new DirectDriver('SERIAL').inputText('ab%scd');
    const sent = runMock.mock.calls.map((c) => (c as unknown as [string, string[]])[1].at(-1));
    expect(sent).toEqual(['ab%', 'scd']);
    expect(adbInputTextChunks('%s%s')).toEqual(['%', 's%', 's']);
    expect(adbInputTextChunks('50% off')).toEqual(['50% off']);
  });

  it('empty text is a no-op (no `input text` with a missing argument)', async () => {
    await new DirectDriver('SERIAL').inputText('');
    expect(runMock).not.toHaveBeenCalled();
  });

  it.each([['héllo'], ['emoji 😀'], ['line\nbreak'], ['tab\there']])(
    'rejects undeliverable payload %j without spawning adb',
    async (payload) => {
      const d = new DirectDriver('SERIAL');
      await expect(d.inputText(payload)).rejects.toThrow(/TEXT_INPUT_UNSUPPORTED/);
      expect(runMock).not.toHaveBeenCalled();
    },
  );

  it('names the unsupported characters and classifies as TEXT_INPUT_UNSUPPORTED', async () => {
    const err = await new DirectDriver('SERIAL').inputText('héllo\n').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('"é"');
    expect((err as Error).message).toContain('"\\n"');
    expect(classifyFlowDriverError(err)).toBe('TEXT_INPUT_UNSUPPORTED');
  });
});

/** AOSP InputShellCommand.sendText (frameworks/base services/core/.../input/InputShellCommand.java):
 * every `%` followed by `s` becomes a space; there is no escape for a literal "%s". */
function androidSendText(arg: string): string {
  const buff = [...arg];
  let escapeFlag = false;
  for (let i = 0; i < buff.length; i++) {
    if (escapeFlag) {
      escapeFlag = false;
      if (buff[i] === 's') {
        buff[i] = ' ';
        buff.splice(--i, 1);
      }
    }
    if (buff[i] === '%') escapeFlag = true;
  }
  return buff.join('');
}

/** Round-trip: escape → a real POSIX sh parses it (as the device-side sh re-parses the joined
 * `adb shell` string) → sendText. Must reproduce the input exactly, as exactly ONE argument. */
function roundTrip(text: string): { args: string[][]; typed: string } {
  const args: string[][] = [];
  let typed = '';
  for (const chunk of adbInputTextChunks(text)) {
    const cmd = `printf '%s\\0' ${escapeAdbInputText(chunk)}`;
    const out = execFileSync('/bin/sh', ['-c', cmd], { cwd: '/' }).toString();
    const parsed = out.split('\0').slice(0, -1);
    args.push(parsed);
    typed += androidSendText(parsed[0] ?? '');
  }
  return { args, typed };
}

describe('adb input text round-trip through /bin/sh + AOSP sendText', () => {
  const printable = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i));
  const cases = [
    ...printable.flatMap((c) => [`a${c}b`, `${c}x`, `x${c}`, c]),
    'p%sw',
    '%s%s',
    '%%s',
    '50% off',
    '{a,b}',
    '[s]dcard',
    'x{1..3}',
    '-n',
    '--',
    '=a',
    'a  b',
    'p@ss w0rd!',
    '/s*',
    '[a-z]',
    '~root',
    '$(id)',
    'a\\nb',
    'it\'s "quoted"',
    'P@ss&w0rd!$ %s {x} [y] `z`',
  ];

  it('every printable ASCII char and tricky string survives as exactly one literal argument', () => {
    const bad: string[] = [];
    for (const t of cases) {
      const { args, typed } = roundTrip(t);
      if (args.some((a) => a.length !== 1) || typed !== t)
        bad.push(`${JSON.stringify(t)} -> ${JSON.stringify(args)} / ${JSON.stringify(typed)}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('device-shell single quoting for deep links and launch extras', () => {
  it('quotes a URL so & ; and spaces survive the device sh as one argument', () => {
    for (const url of ['myapp://x?a=1&b=2;c=3 d', "https://e.com/it's", "x'y'\\z"]) {
      const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${deviceShellQuote(url)}`]).toString();
      expect(out.split('\0').slice(0, -1)).toEqual([url]);
    }
  });

  it('openUrl and launchAppWithArgs hand adb quoted tokens', async () => {
    runMock.mockClear();
    const d = new DirectDriver('SERIAL');
    await d.openUrl('myapp://deep?a=1&b=two words');
    expect((runMock.mock.calls[0] as unknown as [string, string[]])[1].at(-1)).toBe("'myapp://deep?a=1&b=two words'");

    runMock.mockClear();
    runMock.mockImplementationOnce(() => Promise.resolve({ ...ok, stdout: 'priority=0\ncom.app/.MainActivity\n' }));
    await d.launchAppWithArgs('com.app', { q: 'a&b; c', n: 3, on: true });
    const argv = (runMock.mock.calls[1] as unknown as [string, string[]])[1];
    expect(argv).toContain("'a&b; c'");
    expect(argv).toContain("'q'");
    expect(argv).toContain("'com.app/.MainActivity'");
  });
});

describe('H2: a failed `input text` never leaks the typed text', () => {
  it('rethrows without the argv or the text, keeping exit code and stderr', async () => {
    const { run: realRun } = await vi.importActual<typeof import('../src/lib/spawn.js')>('../src/lib/spawn.js');
    // Real spawn through a stand-in "adb" (sh) that fails the way adb does, echoing its argv.
    runMock.mockImplementationOnce(((_cmd: string, args: string[], opts: Record<string, unknown>) =>
      realRun('sh', ['-c', 'echo "error: device offline for $*" >&2; exit 1', 'adb', ...args], {
        ...opts,
        redactArgs: Array.isArray(opts.redactArgs) ? (opts.redactArgs as number[]).map((i) => i + 3) : opts.redactArgs,
      })) as never);
    const pw = 'Tr0ub4dor&3 s3cret!';
    const err = (await new DirectDriver('emulator-5554').inputText(pw).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exited 1/);
    expect(err.message).toMatch(/device offline/);
    expect(err.message).not.toContain('Tr0ub4dor');
    expect(err.message).not.toContain(escapeAdbInputText(pw));
    expect(err.message).not.toContain('s3cret');
  });
});
