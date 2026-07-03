// Cross-restart registry of the long-lived child processes Swipium spawns (Metro bundler,
// managed WDA xcodebuild, screen recorders, emulators) in ~/.swipium/processes.json, so a
// crashed server's orphans can be reaped on the next startup (P0 §2 "orphaned processes").
//
// Safety rules:
//  - Every entry records the OWNING server pid. A child whose owner is still a live
//    node/swipium process belongs to a concurrent server instance and is never touched.
//  - Before signalling, the child's command line is re-checked via `ps` so a PID recycled
//    by the OS to an unrelated process is never killed.
//  - Emulators are ADOPTED, not killed — an orphaned emulator stays booted and remains
//    usable via adb for the next run.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { withFileLock } from '../lib/lockfile.js';
import { log } from '../lib/logger.js';

export type ManagedProcessKind = 'metro' | 'wda' | 'recording' | 'emulator';

export interface ManagedProcessEntry {
  pid: number;
  kind: ManagedProcessKind;
  serverPid: number;
  sessionId?: string;
  startedAt: number;
}

const REGISTRY_DIR = join(homedir(), '.swipium');
const PROCESSES_FILE = join(REGISTRY_DIR, 'processes.json');
const PROCESSES_LOCK = `${PROCESSES_FILE}.lock`;
const MAX_ENTRIES = 100;

/** What the child's `ps` command line must look like before we dare signal it. */
const KIND_COMMAND_RE: Record<ManagedProcessKind, RegExp> = {
  metro: /metro|expo|react-native|npx|node/i,
  wda: /xcodebuild/i,
  recording: /screenrecord|recordvideo|simctl|adb/i,
  emulator: /emulator|qemu/i,
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The live command line for `pid`, or null when it is gone / unreadable (POSIX `ps`). */
function psCommand(pid: number): string | null {
  try {
    const out = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (out.status !== 0 || !out.stdout?.trim()) return null;
    return out.stdout.trim();
  } catch {
    return null;
  }
}

function readEntries(): ManagedProcessEntry[] {
  try {
    if (!existsSync(PROCESSES_FILE)) return [];
    const parsed: unknown = JSON.parse(readFileSync(PROCESSES_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is ManagedProcessEntry => typeof (e as ManagedProcessEntry)?.pid === 'number');
  } catch (e) {
    log('warn', 'managed-process registry unreadable — starting fresh', { file: PROCESSES_FILE, err: String(e) });
    return [];
  }
}

function writeEntries(entries: ManagedProcessEntry[]): void {
  const tmp = `${PROCESSES_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2));
  renameSync(tmp, PROCESSES_FILE); // atomic on the same filesystem
}

function mutateEntries(fn: (entries: ManagedProcessEntry[]) => ManagedProcessEntry[]): void {
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true });
    withFileLock(PROCESSES_LOCK, () => writeEntries(fn(readEntries())));
  } catch (e) {
    log('error', 'failed to update managed-process registry — a crash may leave this child unreaped', {
      file: PROCESSES_FILE,
      err: String(e),
    });
  }
}

/** Record a long-lived child we spawned so a future server instance can reap it if we crash. */
export function registerManagedProcess(pid: number | undefined, kind: ManagedProcessKind, sessionId?: string): void {
  if (!pid || pid <= 0) return;
  mutateEntries((entries) => [
    ...entries.filter((e) => e.pid !== pid),
    { pid, kind, serverPid: process.pid, sessionId, startedAt: Date.now() },
  ]);
}

/** Remove a child we stopped (or that finished) from the registry. */
export function unregisterManagedProcess(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  mutateEntries((entries) => entries.filter((e) => e.pid !== pid));
}

/** SIGTERM the child's process group (detached children lead their own group), else the pid. */
function killTree(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    /* not a group leader, or group already gone — fall back to the pid itself */
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** True when `serverPid` is a live process that plausibly IS a Swipium/node server. The `ps`
 *  check guards against an OS-recycled server pid making us "adopt" a real orphan forever. */
function serverStillAlive(serverPid: number): boolean {
  if (serverPid === process.pid) return false; // our pid at startup = a recycled dead server's
  if (!pidAlive(serverPid)) return false;
  const cmd = psCommand(serverPid);
  return cmd != null && /node|swipium/i.test(cmd);
}

/** Is this child pid registered to a DIFFERENT, still-live server instance? (adopt, don't touch) */
export function pidOwnedByLiveServer(pid: number): boolean {
  const entry = readEntries().find((e) => e.pid === pid);
  return !!entry && serverStillAlive(entry.serverPid);
}

export type ReclaimOutcome = 'killed' | 'adopted' | 'gone' | 'recycled';

/** Verify (via `ps`) that `pid` still runs a command matching `kind`, then kill or adopt it.
 *  Never signals a pid whose command no longer matches — that pid was recycled by the OS. */
export function reclaimPid(pid: number, kind: ManagedProcessKind): ReclaimOutcome {
  if (!pidAlive(pid)) return 'gone';
  const cmd = psCommand(pid);
  if (!cmd || !KIND_COMMAND_RE[kind].test(cmd)) return 'recycled';
  if (kind === 'emulator') return 'adopted'; // still a real emulator — leave it booted (usable via adb)
  return killTree(pid) ? 'killed' : 'gone';
}

/** Startup sweep (called once from startServer): reap children whose owning server died. */
export function reapOrphanedProcesses(): void {
  mutateEntries((entries) => {
    const keep: ManagedProcessEntry[] = [];
    for (const e of entries) {
      if (serverStillAlive(e.serverPid)) {
        keep.push(e); // a live concurrent server owns it — not ours to touch
        continue;
      }
      const outcome = reclaimPid(e.pid, e.kind);
      if (outcome === 'killed') {
        log('warn', 'reaped orphaned child process from a previous server run', { pid: e.pid, kind: e.kind, sessionId: e.sessionId });
      } else if (outcome === 'adopted') {
        log('info', 'adopted orphaned emulator (left booted; reachable via adb)', { pid: e.pid, sessionId: e.sessionId });
      } else if (outcome === 'recycled') {
        log('info', 'dropped orphan entry: PID was recycled by an unrelated process — not signalled', { pid: e.pid, kind: e.kind });
      }
      // In every non-live-owner case the entry is dropped: it has been handled.
    }
    return keep;
  });
}
