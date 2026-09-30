// Minimal advisory file lock for cross-process coordination on the small shared JSON files
// under ~/.swipium (registry.json, processes.json) and .swipium/app-map.json. Two concurrent
// server instances are common (multiple MCP clients), and an unlocked read-modify-write lets them
// clobber each other's entries. The lock is a DIRECTORY (mkdir is atomic on POSIX and Windows):
// whoever creates it holds it. Each acquisition writes an OWNER file (`<lockPath>/owner` =
// `pid:token`, created exclusively) so release can verify the lock is still ours. A holder that
// stalled past the stale threshold and was taken over must NOT delete the new owner's lock.
//
// Stale takeover (holder crashed mid-write) is CLAIM-then-MOVE (H8, review round 2):
//  1. claim: the taker creates `<lockPath>/.takeover` EXCLUSIVELY ('wx', with its own token).
//     Only one taker can claim a given lock-directory instance, and the lock path never
//     disappears during a failed claim, so a newcomer can't slip in;
//  2. verify: the claimed directory must still be exactly the lock it judged stale (same owner,
//     still old before the claim, same inode after it). If a racing waiter already replaced it with a FRESH lock, the claim is dropped
//     and the fresh lock is left untouched (it never moved);
//  3. move: rename the lock to a unique tombstone (`<lockPath>.stale-<pid>-<uuid>`), confirm the
//     tombstone carries OUR claim (i.e. we moved the instance we verified), delete it, retry mkdir.
// Residual race: between verify and move the path can only change if the presumed-dead holder
// wakes up and releases, and a new holder re-creates the lock, inside that window. The post-move
// claim check catches it: the moved lock is renamed back. If that restore fails because yet
// another contender already created the path, the taker does NOT proceed (takeover failed > it
// goes back to waiting) and does NOT delete the moved lock. It stays as a tombstone (never
// treated as safe to rm while it may belong to a live holder) and is swept once older than the
// stale threshold; the displaced holder is warned at release and removes its own tombstone.
// Orphaned tombstones / claims (a taker crashed mid-takeover) are swept / expired as stale.
//
// Two variants:
//  - withFileLock (sync): for the tiny synchronous JSON rewrites (registry/processes/app-map
//    save). Waits are short synchronous sleeps (Atomics.wait, 25 ms slices, ≤ MAX_WAIT_MS total),
//    so the critical section MUST be short: a sync fn cannot be heartbeated (no timer can fire
//    while it runs). Slow work (e.g. the app-map static scan) belongs OUTSIDE the lock.
//  - withFileLockAsync: for async critical sections. Waits yield to the event loop and a heartbeat
//    refreshes the lock's mtime every staleMs/3 so a long holder is never judged stale.
// On timeout both variants fail rather than proceed unlocked (that would reintroduce clobbers).

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { log } from './logger.js';

export const STALE_LOCK_MS = 10_000;
const MAX_WAIT_MS = 2_000;
const RETRY_SLEEP_MS = 25;
/** 'retry' (lock vanished / stale takeover attempted) loops without sleeping at most this many
 *  times in a row; after that it sleeps like 'busy'. A takeover that can never succeed (EACCES on
 *  the claim, rename failure, a fresh claim from a crashed taker) must not busy-spin, since it would
 *  block the event loop forever (the deadline is checked on EVERY iteration too). */
const MAX_IMMEDIATE_RETRIES = 3;
const OWNER_FILE = 'owner';
const TOMBSTONE_MARK = '.stale-';
const CLAIM_FILE = '.takeover';

/** Test seams for simulating contender interleavings inside a takeover. Never set in production. */
export const lockHooks: { beforeTakeoverMove?: () => void; beforeTakeoverRestore?: () => void } = {};

export interface FileLockOptions {
  /** A lock whose mtime is older than this is considered abandoned (default 10 s). */
  staleMs?: number;
  /** Give up (throw) after waiting this long (default 2 s). */
  maxWaitMs?: number;
}

/** Synchronous sleep without spinning the CPU (Node allows Atomics.wait on the main thread).
 *  Only ever called with short slices (RETRY_SLEEP_MS / rename backoff). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The `pid:token` string of the lock's current owner, or null when absent/unreadable. */
function currentOwner(lockPath: string): string | null {
  try {
    return readFileSync(join(lockPath, OWNER_FILE), 'utf8');
  } catch {
    return null;
  }
}

/** What a waiter saw when it judged a lock stale. The takeover verifies the lock it moved is
 *  still exactly this one (a racing waiter may have replaced it with a fresh lock meanwhile). */
export interface StaleObservation {
  owner: string | null;
  mtimeMs: number;
}

function readFileOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Remove our takeover claim from `dir` (only if it is still ours). */
function dropClaim(dir: string, claimToken: string): void {
  const claim = join(dir, CLAIM_FILE);
  if (readFileOrNull(claim) === claimToken) rmSync(claim, { force: true });
}

/** A claim left by a taker that crashed mid-takeover would block every future takeover of that
 *  lock: expire it once older than the stale threshold (moved aside atomically, then removed). */
function expireStaleClaim(lockPath: string, staleMs: number): void {
  const claim = join(lockPath, CLAIM_FILE);
  try {
    if (Date.now() - statSync(claim).mtimeMs <= staleMs) return;
    const lockStat = statSync(lockPath);
    const dead = `${claim}.dead-${randomUUID()}`;
    renameSync(claim, dead);
    rmSync(dead, { force: true });
    // Removing the claim bumped the lock dir's mtime; keep it looking as stale as it is.
    utimesSync(lockPath, lockStat.atime, lockStat.mtime);
  } catch {
    /* gone or raced another expirer */
  }
}

/** Take over a lock judged stale (claim > verify > move; see the header). Returns true when the
 *  stale lock was removed (the caller should retry mkdir), false when the takeover failed and the
 *  caller must go back to waiting: the lock was already gone, another taker holds the claim, a
 *  racing waiter replaced it with a fresh lock (left untouched), or the moved lock turned out not
 *  to be the verified one (restored, or kept as a tombstone if the path was re-created meanwhile).
 *  Exported for tests. */
export function takeOverStaleLock(lockPath: string, observed: StaleObservation, staleMs: number = STALE_LOCK_MS): boolean {
  const claimToken = `${process.pid}:${randomUUID()}`;
  // Identify the instance BEFORE claiming (writing the claim bumps the directory's mtime).
  let before: { ino: number; dev: number };
  try {
    const st = statSync(lockPath);
    if (currentOwner(lockPath) !== observed.owner || Date.now() - st.mtimeMs <= staleMs) return false; // replaced/refreshed
    before = { ino: st.ino, dev: st.dev };
  } catch {
    return false; // already gone
  }
  try {
    writeFileSync(join(lockPath, CLAIM_FILE), claimToken, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') expireStaleClaim(lockPath, staleMs);
    return false; // lock gone (ENOENT) or another taker is mid-takeover
  }
  let isSame = false;
  try {
    const st = statSync(lockPath);
    isSame = st.ino === before.ino && st.dev === before.dev && currentOwner(lockPath) === observed.owner;
  } catch {
    isSame = false;
  }
  if (!isSame) {
    // We claimed a FRESH lock (a racing waiter won the takeover and re-acquired after our
    // observation). It never moved: just withdraw the claim.
    dropClaim(lockPath, claimToken);
    return false;
  }
  lockHooks.beforeTakeoverMove?.();
  const tomb = `${lockPath}${TOMBSTONE_MARK}${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, tomb); // atomic
  } catch {
    return false; // released meanwhile
  }
  if (readFileOrNull(join(tomb, CLAIM_FILE)) !== claimToken) {
    // The path was replaced between verify and move: we moved someone else's (possibly live) lock.
    lockHooks.beforeTakeoverRestore?.();
    try {
      renameSync(tomb, lockPath); // put it back untouched
    } catch {
      // Another contender already re-created the path. Do NOT delete the moved lock (it may belong
      // to a live holder) and do NOT proceed as owner: the takeover failed. The tombstone is swept
      // once stale; its holder is warned at release.
      log('error', 'file lock takeover moved a replaced lock and could not restore it; left as tombstone, not acquiring', {
        lockPath,
        tomb,
      });
    }
    return false;
  }
  rmSync(tomb, { recursive: true, force: true });
  return true;
}

/** Remove tombstones left by a taker that crashed between rename and rm. Best-effort. */
export function sweepLockTombstones(lockPath: string, staleMs: number = STALE_LOCK_MS): number {
  let removed = 0;
  try {
    const dir = dirname(lockPath);
    const prefix = `${basename(lockPath)}${TOMBSTONE_MARK}`;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const p = join(dir, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > staleMs) {
          rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* raced another sweeper */
      }
    }
  } catch {
    /* parent missing/unreadable, nothing to sweep */
  }
  return removed;
}

type AttemptResult = 'acquired' | 'busy' | 'retry';

/** One acquisition attempt: mkdir, else stale-check/takeover. Never sleeps. */
function tryAcquire(lockPath: string, token: string, staleMs: number): AttemptResult {
  try {
    mkdirSync(lockPath); // atomic: throws EEXIST if another process holds the lock
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    let observed: StaleObservation;
    try {
      observed = { owner: currentOwner(lockPath), mtimeMs: statSync(lockPath).mtimeMs };
    } catch {
      return 'retry'; // lock released between attempts, retry immediately
    }
    if (Date.now() - observed.mtimeMs > staleMs) {
      // stale: the holder crashed or stalled; take over atomically, then retry mkdir
      takeOverStaleLock(lockPath, observed, staleMs);
      return 'retry';
    }
    return 'busy';
  }
  // We created the dir. Record ownership EXCLUSIVELY ('wx'): if an owner file already exists the
  // directory is not really ours (a takeover restore swapped a live lock into this path).
  try {
    writeFileSync(join(lockPath, OWNER_FILE), token, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'busy';
    rmSync(lockPath, { recursive: true, force: true });
    throw e;
  }
  // Re-check ownership after acquiring: the lock we hold must carry OUR token.
  if (currentOwner(lockPath) !== token) return 'busy';
  sweepLockTombstones(lockPath, staleMs);
  return 'acquired';
}

function release(lockPath: string, token: string): void {
  // Verify-then-release: only remove the lock while the owner file still holds OUR token. If fn()
  // stalled past the stale threshold another process legitimately took the lock over, and deleting it
  // here would let a THIRD process acquire while the new owner still runs.
  if (currentOwner(lockPath) === token) {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* already removed (stale takeover raced our release) */
    }
  } else {
    log(
      'warn',
      'file lock was taken over while held: this holder stalled past the stale threshold (or was displaced by a takeover race) and its work may have raced the new holder',
      { lockPath },
    );
    removeOwnTombstones(lockPath, token);
  }
}

/** A displaced holder's lock may survive as a tombstone (see takeOverStaleLock): remove the ones
 *  carrying OUR token. They are ours, so this can never touch another holder's lock. */
function removeOwnTombstones(lockPath: string, token: string): void {
  try {
    const dir = dirname(lockPath);
    const prefix = `${basename(lockPath)}${TOMBSTONE_MARK}`;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const p = join(dir, name);
      if (currentOwner(p) === token) rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
}

function newToken(): string {
  // Ownership token: verify identity before acting (the same spirit as processRegistry's
  // serverStillAlive pid+command check).
  return `${process.pid}:${randomUUID()}`;
}

function timeoutError(lockPath: string): Error {
  log('error', 'file lock wait timed out, refusing unlocked registry mutation', { lockPath });
  return new Error(`Timed out waiting for file lock ${lockPath}`);
}

/** Run a SHORT synchronous `fn` while holding the advisory lock at `lockPath` (a directory that
 *  must not pre-exist). Retries for up to maxWaitMs (blocking in 25 ms slices), taking over locks
 *  older than staleMs. fn cannot be heartbeated, so keep it well under staleMs. */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  const deadline = Date.now() + (opts.maxWaitMs ?? MAX_WAIT_MS);
  const token = newToken();
  let immediate = 0;
  for (;;) {
    const r = tryAcquire(lockPath, token, staleMs);
    if (r === 'acquired') break;
    if (Date.now() > deadline) throw timeoutError(lockPath);
    if (r === 'retry' && immediate++ < MAX_IMMEDIATE_RETRIES) continue;
    immediate = 0;
    sleepSync(RETRY_SLEEP_MS);
  }
  try {
    return fn();
  } finally {
    release(lockPath, token);
  }
}

/** Async variant: waits yield to the event loop, and a heartbeat refreshes the lock's mtime every
 *  staleMs/3 while `fn` runs so a long (async) critical section is never judged stale. */
export async function withFileLockAsync<T>(lockPath: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  const deadline = Date.now() + (opts.maxWaitMs ?? MAX_WAIT_MS);
  const token = newToken();
  let immediate = 0;
  for (;;) {
    const r = tryAcquire(lockPath, token, staleMs);
    if (r === 'acquired') break;
    if (Date.now() > deadline) throw timeoutError(lockPath);
    if (r === 'retry' && immediate++ < MAX_IMMEDIATE_RETRIES) continue;
    immediate = 0;
    await new Promise((res) => setTimeout(res, RETRY_SLEEP_MS));
  }
  const heartbeat = setInterval(
    () => {
      // Only refresh a lock that is still ours. Never keep a thief's lock alive on its behalf.
      if (currentOwner(lockPath) !== token) return;
      try {
        const now = new Date();
        utimesSync(lockPath, now, now);
      } catch {
        /* lock vanished; release will log */
      }
    },
    Math.max(10, Math.floor(staleMs / 3)),
  );
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    release(lockPath, token);
  }
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** renameSync that tolerates transient Windows sharing violations (antivirus/indexer briefly
 *  holding the target): retries EPERM/EBUSY/EACCES with short backoff (≤ ~310 ms total). On
 *  POSIX those errors are permanent, so it throws immediately. */
export function renameWithRetry(
  from: string,
  to: string,
  opts: { isWindows?: boolean; renameFn?: (a: string, b: string) => void; delaysMs?: number[] } = {},
): void {
  const rename = opts.renameFn ?? renameSync;
  const isWindows = opts.isWindows ?? process.platform === 'win32';
  const delays = opts.delaysMs ?? [10, 20, 40, 80, 160];
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!isWindows || !RENAME_RETRY_CODES.has(code) || attempt >= delays.length) throw e;
      sleepSync(delays[attempt]);
    }
  }
}

/** Atomic file write: unique tmp sibling + rename (with Windows retry). Removes the tmp on failure. */
export function writeFileAtomicSync(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameWithRetry(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Delete `<baseName>.*.tmp` siblings older than maxAgeMs (residue of a writer that crashed
 *  between write and rename). Young tmp files may belong to a live writer and are kept. */
export function cleanupOrphanTmpFiles(dir: string, baseName: string, maxAgeMs: number = 10 * 60_000): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${baseName}.`) || !name.endsWith('.tmp')) continue;
      const p = join(dir, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {
        /* raced another cleaner */
      }
    }
  } catch {
    /* dir missing, nothing to clean */
  }
  return removed;
}
