// SWIP-11: run() writes opts.input to child.stdin. A child that exits before draining stdin
// emits EPIPE on the stdin Writable; without a stream 'error' listener that was an uncaught
// exception that killed the whole stdio MCP server process. These tests drive both the
// broken-pipe path and the happy path through the real spawn.

import { describe, expect, it } from 'vitest';
import { run } from '../src/lib/spawn.js';

describe('run() stdin handling (SWIP-11)', () => {
  it('survives a child that exits before draining stdin (EPIPE) without crashing', async () => {
    // `false` exits immediately and never reads stdin; a 1 MiB payload guarantees the write
    // outlives the child, so child.stdin emits EPIPE. The promise must still settle cleanly
    // via the 'close' handler with the child's real exit code.
    const res = await run('false', [], { input: 'x'.repeat(1 << 20), timeoutMs: 10_000 });
    expect(res.code).toBe(1);
    expect(res.timedOut).toBe(false);
  });

  it('still delivers stdin to a cooperating child', async () => {
    const res = await run('cat', [], { input: 'hi', timeoutMs: 10_000 });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('hi');
  });
});

describe('run() redactArgs (H2)', () => {
  it('keeps sensitive argv out of the non-zero-exit error, including echoed stderr', async () => {
    const err = (await run('sh', ['-c', 'echo "bad arg: $1" >&2; exit 3', 'sh', 'hunter2-secret'], {
      rejectOnNonZero: true,
      redactArgs: [3],
      timeoutMs: 10_000,
    }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/exited 3/);
    expect(err.message).toContain('bad arg:');
    expect(err.message).not.toContain('hunter2-secret');
    expect(err.message).toContain('«redacted»');
  });

  it('redactArgs:true hides every arg; without it the argv is still shown', async () => {
    const all = (await run('sh', ['-c', 'exit 2', 'x', 'topsecret'], { rejectOnNonZero: true, redactArgs: true }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(all.message).not.toContain('topsecret');
    const plain = (await run('sh', ['-c', 'exit 2', 'x', 'visible-arg'], { rejectOnNonZero: true }).catch((e: unknown) => e)) as Error;
    expect(plain.message).toContain('visible-arg');
  });
});
