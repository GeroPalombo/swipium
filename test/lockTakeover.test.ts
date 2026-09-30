// H8 — lockfile stale-takeover race, heartbeat, tombstones, atomic-write helpers, and the app-map
// build keeping its slow static scan OUTSIDE the (synchronous, un-heartbeatable) lock.
//
// Before the fix: two waiters that both judged a lock stale each rmSync'd it — the second one's
// delayed rm deleted the FIRST waiter's fresh lock, so both "held" it. A long holder was never
// refreshed, so any critical section > STALE_LOCK_MS was stolen mid-flight.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lockHooks,
  cleanupOrphanTmpFiles,
  renameWithRetry,
  sweepLockTombstones,
  takeOverStaleLock,
  withFileLock,
  withFileLockAsync,
  writeFileAtomicSync,
} from '../src/lib/lockfile.js';
import { buildAppMap, buildHooks } from '../src/appMap/build.js';

let roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swipium-lock-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
  roots = [];
  buildHooks.onStaticScan = undefined;
  lockHooks.beforeTakeoverMove = undefined;
  lockHooks.beforeTakeoverRestore = undefined;
});

function makeStaleLock(lock: string, owner: string, ageMs = 60_000): void {
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), owner);
  const old = new Date(Date.now() - ageMs);
  utimesSync(lock, old, old);
}

describe('atomic stale takeover (H8)', () => {
  it('two waiters that both judged the lock stale: only one takes it over; the second never deletes the fresh lock', () => {
    const lock = join(tempRoot(), 'x.lock');
    makeStaleLock(lock, '99999:dead');
    // Both waiters observed the SAME stale lock before either acted.
    const observed = { owner: '99999:dead', mtimeMs: statSync(lock).mtimeMs };

    // Waiter A wins the takeover and immediately re-acquires (fresh lock, its own owner).
    expect(takeOverStaleLock(lock, observed)).toBe(true);
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), '1:waiter-A');

    // Waiter B acts on its (now outdated) stale observation — it must NOT destroy A's lock.
    expect(takeOverStaleLock(lock, observed)).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('1:waiter-A');
    // …and leaves no tombstone behind.
    expect(readdirSync(join(lock, '..')).filter((f) => f.includes('.stale-'))).toEqual([]);
  });

  it('withFileLock still reclaims a genuinely dead holder via the tombstone path', () => {
    const lock = join(tempRoot(), 'y.lock');
    makeStaleLock(lock, '99999:dead');
    expect(withFileLock(lock, () => 'ran')).toBe('ran');
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(join(lock, '..'))).toEqual([]);
  });

  it('refuses a directory whose owner file already exists (exclusive owner write)', () => {
    const lock = join(tempRoot(), 'z.lock');
    // A live lock with an owner — a fresh waiter must time out, not share it.
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), '2:live');
    expect(() => withFileLock(lock, () => 'nope', { maxWaitMs: 60 })).toThrow(/Timed out/);
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('2:live');
  });

  it('sweeps orphaned tombstones left by a taker that crashed between rename and rm', () => {
    const root = tempRoot();
    const lock = join(root, 'w.lock');
    const orphan = `${lock}.stale-123-abc`;
    makeStaleLock(orphan, '123:crashed-taker');
    const young = `${lock}.stale-456-def`;
    mkdirSync(young); // a live taker mid-takeover — too young to sweep
    expect(sweepLockTombstones(lock)).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(young)).toBe(true);
    // Acquisition sweeps too.
    makeStaleLock(orphan, '123:crashed-taker');
    withFileLock(lock, () => undefined);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe('takeover contender interleavings (review round 2)', () => {
  const tombs = (lock: string) => readdirSync(join(lock, '..')).filter((f) => f.includes('.stale-'));

  it('a taker that claimed the stale lock: a concurrent taker cannot claim it too', () => {
    const lock = join(tempRoot(), 'c.lock');
    makeStaleLock(lock, '99999:dead');
    const observed = { owner: '99999:dead', mtimeMs: statSync(lock).mtimeMs };
    let inner: boolean | undefined;
    // While A is between claim and move, B tries the same takeover.
    lockHooks.beforeTakeoverMove = () => {
      lockHooks.beforeTakeoverMove = undefined;
      inner = takeOverStaleLock(lock, observed);
    };
    expect(takeOverStaleLock(lock, observed)).toBe(true);
    expect(inner).toBe(false);
    expect(existsSync(lock)).toBe(false);
    expect(tombs(lock)).toEqual([]);
  });

  it('holder wakes + releases and A re-acquires between verify and move: the moved lock is restored untouched', () => {
    const lock = join(tempRoot(), 'r.lock');
    makeStaleLock(lock, '99999:dead');
    const observed = { owner: '99999:dead', mtimeMs: statSync(lock).mtimeMs };
    lockHooks.beforeTakeoverMove = () => {
      rmSync(lock, { recursive: true, force: true }); // D wakes and releases
      mkdirSync(lock); // A acquires fresh
      writeFileSync(join(lock, 'owner'), '1:A');
    };
    expect(takeOverStaleLock(lock, observed)).toBe(false); // B does not proceed
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('1:A'); // A still holds the path
    expect(tombs(lock)).toEqual([]);
  });

  it('four contenders: restore blocked by C → B neither proceeds nor deletes A’s moved lock; no two path owners', () => {
    const lock = join(tempRoot(), 'f.lock');
    makeStaleLock(lock, '99999:dead');
    const observed = { owner: '99999:dead', mtimeMs: statSync(lock).mtimeMs };
    lockHooks.beforeTakeoverMove = () => {
      rmSync(lock, { recursive: true, force: true }); // D releases late
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), '1:A'); // A acquires
    };
    lockHooks.beforeTakeoverRestore = () => {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), '3:C'); // C acquires the vacated path before B restores
    };
    expect(takeOverStaleLock(lock, observed)).toBe(false); // B: takeover failed → back to waiting
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('3:C'); // exactly one path owner
    const t = tombs(lock);
    expect(t).toHaveLength(1); // A's lock content kept as a tombstone, not rm'd as "safe"
    expect(readFileSync(join(lock, '..', t[0], 'owner'), 'utf8')).toBe('1:A');
    // B (via withFileLock) keeps waiting on C's live lock instead of acquiring.
    lockHooks.beforeTakeoverMove = undefined;
    lockHooks.beforeTakeoverRestore = undefined;
    expect(() => withFileLock(lock, () => 'B', { maxWaitMs: 60 })).toThrow(/Timed out/);
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('3:C');
  });

  it('a crashed taker’s leftover claim expires once stale, so the lock is not wedged forever', () => {
    const lock = join(tempRoot(), 'w2.lock');
    makeStaleLock(lock, '99999:dead');
    writeFileSync(join(lock, '.takeover'), '777:crashed');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(lock, '.takeover'), old, old);
    utimesSync(lock, old, old);
    expect(withFileLock(lock, () => 'ran', { maxWaitMs: 500 })).toBe('ran');
  });
});

describe('heartbeat (H8)', () => {
  it('keeps a long async holder alive: a waiter cannot take it over while it runs', async () => {
    const lock = join(tempRoot(), 'hb.lock');
    const staleMs = 150;
    const events: string[] = [];
    const holder = withFileLockAsync(
      lock,
      async () => {
        events.push('A:start');
        await new Promise((r) => setTimeout(r, staleMs * 4)); // 4× the stale threshold
        events.push('A:end');
      },
      { staleMs },
    );
    await new Promise((r) => setTimeout(r, 30));
    const waiter = withFileLockAsync(
      lock,
      async () => {
        events.push('B:run');
      },
      { staleMs, maxWaitMs: 3_000 },
    );
    await Promise.all([holder, waiter]);
    // Without the heartbeat B would have judged A stale at ~150 ms and run inside A's section.
    expect(events).toEqual(['A:start', 'A:end', 'B:run']);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('atomic write helpers (H8)', () => {
  it('renameWithRetry retries transient Windows sharing violations, then succeeds', () => {
    let calls = 0;
    renameWithRetry('a', 'b', {
      isWindows: true,
      delaysMs: [1, 1, 1],
      renameFn: () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
      },
    });
    expect(calls).toBe(3);
  });

  it('renameWithRetry does not retry on POSIX or on non-transient errors', () => {
    let calls = 0;
    const fail = (code: string) => () => {
      calls++;
      throw Object.assign(new Error(code), { code });
    };
    expect(() => renameWithRetry('a', 'b', { isWindows: false, renameFn: fail('EPERM') })).toThrow('EPERM');
    expect(calls).toBe(1);
    calls = 0;
    expect(() => renameWithRetry('a', 'b', { isWindows: true, renameFn: fail('ENOENT'), delaysMs: [1] })).toThrow('ENOENT');
    expect(calls).toBe(1);
  });

  it('writeFileAtomicSync leaves no tmp; cleanupOrphanTmpFiles removes only OLD tmp residue', () => {
    const dir = tempRoot();
    const target = join(dir, 'app-map.json');
    writeFileAtomicSync(target, '{"ok":true}');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}');
    expect(readdirSync(dir)).toEqual(['app-map.json']);

    const oldTmp = join(dir, 'app-map.json.123.tmp');
    const youngTmp = join(dir, 'app-map.json.456.aa.tmp');
    writeFileSync(oldTmp, 'x');
    writeFileSync(youngTmp, 'y');
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(oldTmp, old, old);
    expect(cleanupOrphanTmpFiles(dir, 'app-map.json')).toBe(1);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(youngTmp)).toBe(true);
  });
});

describe('buildAppMap lock scope (H8)', () => {
  it('runs the static scan OUTSIDE the app-map lock (only load→merge→save is locked)', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '1', 'react-native': '1' } }));
    const lock = join(root, '.swipium', 'app-map.lock');
    let lockHeldDuringScan: boolean | null = null;
    buildHooks.onStaticScan = () => {
      lockHeldDuringScan = existsSync(lock);
    };
    const res = buildAppMap(root, { mode: 'static_only', at: '2026-09-28T00:00:00.000Z' });
    expect(res.rescanned).toBe(true);
    expect(lockHeldDuringScan).toBe(false);
    expect(existsSync(join(root, '.swipium', 'app-map.json'))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('skips the pre-scan for a runtime_merge over an existing map', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '1' } }));
    buildAppMap(root, { mode: 'static_only', at: '2026-09-28T00:00:00.000Z' });
    let scans = 0;
    buildHooks.onStaticScan = () => scans++;
    const res = buildAppMap(root, { mode: 'runtime_merge', at: '2026-09-28T00:01:00.000Z' });
    expect(res.rescanned).toBe(false);
    expect(scans).toBe(0);
  });
});
