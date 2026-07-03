// Minimal advisory file lock for cross-process coordination on the small shared JSON files
// under ~/.swipium (registry.json, processes.json). Two concurrent server instances are
// common (multiple MCP clients), and an unlocked read-modify-write lets them clobber each
// other's entries. The lock is a DIRECTORY (mkdir is atomic on POSIX and Windows): whoever
// creates it holds it. A stale lock (holder crashed mid-write) is taken over after STALE_MS.
// Waiting is a short synchronous spin — callers do tiny sync JSON rewrites — and on timeout
// we fail the write rather than proceeding unlocked and reintroducing read-modify-write clobbers.

import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import { log } from './logger.js';

const STALE_LOCK_MS = 10_000;
const MAX_WAIT_MS = 2_000;
const RETRY_SLEEP_MS = 25;

/** Synchronous sleep without spinning the CPU (Node allows Atomics.wait on the main thread). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` while holding the advisory lock at `lockPath` (a directory that must not pre-exist).
 *  Retries for up to MAX_WAIT_MS, taking over locks older than STALE_LOCK_MS (crashed holder). */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + MAX_WAIT_MS;
  let locked = false;
  while (!locked) {
    try {
      mkdirSync(lockPath); // atomic: throws EEXIST if another process holds the lock
      locked = true;
    } catch {
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          rmdirSync(lockPath); // stale — the holder crashed; take over
          continue;
        }
      } catch {
        /* lock released between attempts — retry immediately */
        continue;
      }
      if (Date.now() > deadline) {
        log('error', 'file lock wait timed out — refusing unlocked registry mutation', { lockPath });
        throw new Error(`Timed out waiting for file lock ${lockPath}`);
      }
      sleepSync(RETRY_SLEEP_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (locked) {
      try {
        rmdirSync(lockPath);
      } catch {
        /* already removed (e.g. stale takeover by another process) */
      }
    }
  }
}
