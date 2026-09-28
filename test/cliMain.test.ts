// D1: `swipium --help`, `--version`, and unknown subcommands must not start (and hang) the
// stdio server. Only no subcommand / `serve` starts it.

import { describe, expect, it } from 'vitest';
import { parseCommand, USAGE } from '../src/cli/main.js';
import { SWIPIUM_VERSION } from '../src/version.js';

describe('swipium CLI dispatch', () => {
  it('starts the server only with no subcommand or `serve`', () => {
    expect(parseCommand([])).toEqual({ kind: 'serve' });
    expect(parseCommand(['serve'])).toEqual({ kind: 'serve' });
  });

  it('--help / -h / --version / -v print and exit', () => {
    expect(parseCommand(['--help']).kind).toBe('help');
    expect(parseCommand(['-h']).kind).toBe('help');
    expect(parseCommand(['--version']).kind).toBe('version');
    expect(parseCommand(['-v']).kind).toBe('version');
  });

  it('unknown subcommands and flags are errors, not a silent server', () => {
    expect(parseCommand(['plan'])).toEqual({ kind: 'unknown', cmd: 'plan' });
    expect(parseCommand(['ci'])).toEqual({ kind: 'unknown', cmd: 'ci' });
    // Unknown --flags with no subcommand serve (1.5 behaviour; see test/cliServe.test.ts).
    expect(parseCommand(['--stdio'], () => undefined).kind).toBe('serve');
  });

  it('routes known subcommands with their args', () => {
    expect(parseCommand(['init', 'claude', '--apply'])).toEqual({ kind: 'sub', cmd: 'init', rest: ['claude', '--apply'] });
    expect(parseCommand(['report', '--latest', '--format', 'junit'])).toEqual({
      kind: 'sub',
      cmd: 'report',
      rest: ['--latest', '--format', 'junit'],
    });
  });

  it('usage lists every subcommand (incl. report) and the version, and no phantom commands', () => {
    expect(USAGE).toContain(SWIPIUM_VERSION);
    for (const c of ['init', 'scan', 'suite', 'verify', 'report --format junit|sarif|github-summary|markdown|json', 'cursor', 'vscode']) {
      expect(USAGE).toContain(c);
    }
    expect(USAGE).not.toMatch(/swipium (plan|ci)\b/);
  });
});
