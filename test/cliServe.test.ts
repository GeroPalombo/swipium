// Regression (2.0.0 launch review): `swipium --stdio` (flags MCP configs/registries pass) must
// start the server as 1.5 did — with a stderr warning — while an unknown bare word still exits 2.
// The usage text documents every `swipium report` format and flag.
import { describe, expect, it } from 'vitest';
import { parseCommand, USAGE } from '../src/cli/main.js';
import { REPORT_USAGE } from '../src/cli/report.js';

describe('swipium CLI: unknown flags serve, unknown words error', () => {
  it('unknown --flags with no subcommand → serve + warning', () => {
    const warnings: string[] = [];
    const parsed = parseCommand(['--stdio', '--foo=1'], (m) => warnings.push(m));
    expect(parsed).toEqual({ kind: 'serve', ignoredFlags: ['--stdio', '--foo=1'] });
    expect(warnings.join('')).toMatch(/ignoring unrecognized flag\(s\) --stdio --foo=1/);
  });

  it('unknown bare word → unknown (usage + exit 2), no warning', () => {
    const warnings: string[] = [];
    expect(parseCommand(['stdio'], (m) => warnings.push(m))).toEqual({ kind: 'unknown', cmd: 'stdio' });
    expect(warnings).toEqual([]);
  });

  it('help/version flags still win over the serve fallback', () => {
    expect(parseCommand(['--help'], () => undefined).kind).toBe('help');
    expect(parseCommand(['-v'], () => undefined).kind).toBe('version');
  });

  it('usage lists all report formats and flags the report CLI actually accepts', () => {
    for (const f of ['markdown', 'json', '--root', '--session', '--report', '--out', '--fail-on-gate', '--latest']) {
      expect(USAGE, f).toContain(f);
      expect(REPORT_USAGE, f).toContain(f);
    }
  });
});
