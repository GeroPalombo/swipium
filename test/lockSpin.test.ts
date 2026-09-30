// Regression: a stale lock whose takeover can never succeed (claim write fails with EACCES) used
// to make withFileLock/withFileLockAsync spin forever ('retry' skipped the deadline and the
// sleep), blocking the event loop — and startup, since the orphan reaper takes this lock.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, withFileLockAsync } from '../src/lib/lockfile.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const dirs: string[] = [];

function staleUnwritableLock(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swipium-lockspin-'));
  dirs.push(dir);
  const lock = join(dir, 'x.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), '999999:dead');
  chmodSync(lock, 0o555); // the .takeover claim can't be created → takeover always fails
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  return lock;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, 'x.lock'), 0o755);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32' || isRoot)('lock retry on failed stale takeover', () => {
  it('sync: throws a timeout within ~1 s instead of spinning', () => {
    const lock = staleUnwritableLock();
    const t0 = Date.now();
    expect(() => withFileLock(lock, () => 1, { staleMs: 1_000, maxWaitMs: 200 })).toThrow(/Timed out/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('async: rejects within ~1 s and yields to the event loop meanwhile', async () => {
    const lock = staleUnwritableLock();
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    const t0 = Date.now();
    await expect(withFileLockAsync(lock, async () => 1, { staleMs: 1_000, maxWaitMs: 200 })).rejects.toThrow(/Timed out/);
    clearInterval(iv);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(ticks).toBeGreaterThan(3); // the event loop kept running while we waited
  });
});
