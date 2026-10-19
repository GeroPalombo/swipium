// CLI usage contract: --help prints usage to stdout and exits 0 for every subcommand; a usage
// error names its reason on stderr (with the usage) and exits 2; a subcommand one edit away from
// a real one gets a "did you mean" hint.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `init --apply` ends with a live `swipium verify`; never reached here, but keep it stubbed.
vi.mock('../src/cli/verify.js', () => ({ runVerify: vi.fn(async () => {}) }));

const { didYouMean, parseCommand, SUBCOMMANDS, USAGE } = await import('../src/cli/main.js');
const { runSuite } = await import('../src/cli/suite.js');
const { runInit } = await import('../src/cli/init.js');

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(fn: () => Promise<void>): Promise<{ code: number | string | undefined; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  const prev = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
    return { code: process.exitCode, out: out.join(''), err: err.join('') };
  } finally {
    process.exitCode = prev;
  }
}

describe('didYouMean', () => {
  it('suggests the single candidate one edit away (insert, delete, substitute, adjacent swap)', () => {
    expect(didYouMean('lnt', ['lint', 'compile', 'init'])).toBe('lint');
    expect(didYouMean('suiite', SUBCOMMANDS)).toBe('suite');
    expect(didYouMean('scam', SUBCOMMANDS)).toBe('scan');
    expect(didYouMean('sutie', SUBCOMMANDS)).toBe('suite');
    expect(didYouMean('REPORT', SUBCOMMANDS)).toBe('report');
  });

  it('suggests nothing for distant, too-short, or ambiguous input', () => {
    expect(didYouMean('plan', SUBCOMMANDS)).toBeUndefined();
    expect(didYouMean('ci', SUBCOMMANDS)).toBeUndefined();
    expect(didYouMean('x', ['xy'])).toBeUndefined();
    expect(didYouMean('bat', ['cat', 'hat'])).toBeUndefined();
  });

  it('parseCommand carries the suggestion for a typo of a subcommand', () => {
    expect(parseCommand(['sutie'])).toEqual({ kind: 'unknown', cmd: 'sutie', suggestion: 'suite' });
    expect(parseCommand(['plan'])).toEqual({ kind: 'unknown', cmd: 'plan' });
  });
});

describe('swipium --help text', () => {
  it('lists init flows, suite --strict/--force, report --max-age, and per-command help', () => {
    expect(USAGE).toContain('swipium init flows [--root <dir>] [--force]');
    expect(USAGE).toContain('--strict');
    expect(USAGE).toMatch(/suite[\s\S]*--force/);
    expect(USAGE).toContain('--max-age');
    expect(USAGE).toContain('Run `swipium <command> --help` for details.');
  });
});

describe('swipium suite usage', () => {
  it('--help / -h prints usage and exits 0 for bare suite and every subcommand', async () => {
    for (const args of [['--help'], ['-h'], ['lint', '--help'], ['compile', '-h'], ['init', '--help'], ['lint', '--strict', '-h']]) {
      const r = await run(() => runSuite(args));
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.out).toContain('Usage: swipium suite');
      expect(r.err).toBe('');
    }
  });

  it('an unknown subcommand names itself (with a hint) on stderr and exits 2', async () => {
    const r = await run(() => runSuite(['lnt']));
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain('unknown subcommand "lnt" (did you mean "lint"?)');
    expect(r.err).toContain('Usage: swipium suite');
  });

  it('no subcommand is a usage error on stderr', async () => {
    const r = await run(() => runSuite([]));
    expect(r.code).toBe(2);
    expect(r.err).toContain('missing subcommand');
  });

  it('compile --suite with no value is a usage error, not a default-suite compile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swipium-suite-cli-'));
    for (const args of [
      ['compile', '--suite'],
      ['compile', root, '--suite'],
      ['compile', '--suite', '--force'],
    ]) {
      const r = await run(() => runSuite(args));
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toContain('--suite expects a value');
      expect(r.out).toBe('');
    }
  });

  it('an unknown option and a missing project root go to stderr with exit 2', async () => {
    const bad = await run(() => runSuite(['lint', '--stric']));
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('unknown option --stric');
    const missing = await run(() => runSuite(['lint', '/definitely/not/a/real/dir']));
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('project root not found');
    expect(missing.out).toBe('');
  });
});

describe('swipium init usage', () => {
  it('an unknown client names itself (with a hint) on stderr and exits 2', async () => {
    const r = await run(() => runInit(['foo']));
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain('unknown client "foo"');
    expect(r.err).toContain('Usage: swipium init');
    const typo = await run(() => runInit(['clade']));
    expect(typo.err).toContain('unknown client "clade" (did you mean "claude"?)');
  });

  it('no client is a usage error on stderr; --help is usage on stdout with exit 0', async () => {
    const r = await run(() => runInit([]));
    expect(r.code).toBe(2);
    expect(r.err).toContain('missing client');
    const help = await run(() => runInit(['--help']));
    expect(help.code).toBeUndefined();
    expect(help.out).toContain('Usage: swipium init');
    expect(help.err).toBe('');
  });

  it('a bad --scope and a missing init flows root go to stderr with exit 2', async () => {
    const scope = await run(() => runInit(['claude', '--scope', 'global']));
    expect(scope.code).toBe(2);
    expect(scope.err).toContain('unknown --scope "global"');
    const flows = await run(() => runInit(['flows', '--root', '/definitely/not/a/real/dir']));
    expect(flows.code).toBe(2);
    expect(flows.err).toContain('path not found');
    expect(flows.out).toBe('');
  });
});
