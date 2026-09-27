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
//  - Managed WDA (xcodebuild test-without-building) is deliberately NOT stopped on a graceful
//    shutdown either (only Metro and screen recorders are — see startServer), so the next server
//    can resume the iOS session on the same WDA. At startup an orphaned WDA entry is ADOPTED when
//    it is younger than WDA_ADOPT_MAX_AGE_MS (12 h) AND its recorded endpoint answers GET /status
//    ready; adoption keeps the entry and re-owns it (serverPid = this server), so `qa_wda stop`
//    can still stop it and a later crash/restart applies the same rule. An older, unhealthy, or
//    endpoint-less WDA entry is reaped like any other orphan.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { withFileLock, writeFileAtomicSync } from '../lib/lockfile.js';
import { log } from '../lib/logger.js';
import { checkWda } from '../lib/wda.js';

export type ManagedProcessKind = 'metro' | 'wda' | 'recording' | 'emulator';

export interface ManagedProcessEntry {
  pid: number;
  kind: ManagedProcessKind;
  serverPid: number;
  sessionId?: string;
  startedAt: number;
  /** kind 'wda': the WDA base URL, probed (GET /status) before an orphan is adopted. */
  endpoint?: string;
}

/** An orphaned managed WDA older than this is reaped even when healthy (bounded lifetime). */
export const WDA_ADOPT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const WDA_ADOPT_PROBE_TIMEOUT_MS = 1500;

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
  writeFileAtomicSync(PROCESSES_FILE, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2)); // tmp + rename (Windows-retried)
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
export function registerManagedProcess(
  pid: number | undefined,
  kind: ManagedProcessKind,
  sessionId?: string,
  extra: { endpoint?: string } = {},
): void {
  if (!pid || pid <= 0) return;
  mutateEntries((entries) => [
    ...entries.filter((e) => e.pid !== pid),
    { pid, kind, serverPid: process.pid, sessionId, startedAt: Date.now(), ...(extra.endpoint ? { endpoint: extra.endpoint } : {}) },
  ]);
}

/** A managed WDA this server adopted at startup (or started itself) for `sessionId`, per the
 *  registry — lets `qa_wda stop` stop a WDA started by a previous server run. */
export function registeredWdaForSession(sessionId: string): ManagedProcessEntry | undefined {
  return readEntries()
    .filter((e) => e.kind === 'wda' && e.sessionId === sessionId && e.serverPid === process.pid)
    .pop();
}

/** Remove a child we stopped (or that finished) from the registry. */
export function unregisterManagedProcess(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  mutateEntries((entries) => entries.filter((e) => e.pid !== pid));
}

/** OS primitives, injectable for tests (fake pids / `ps` / signals / WDA /status). */
export interface ProcessOps {
  pidAlive(pid: number): boolean;
  psCommand(pid: number): string | null;
  killTree(pid: number): boolean;
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

const REAL_OPS: ProcessOps = { pidAlive, psCommand, killTree };

/** True when `serverPid` is a live process that plausibly IS a Swipium/node server. The `ps`
 *  check guards against an OS-recycled server pid making us "adopt" a real orphan forever. */
function serverStillAlive(serverPid: number, ops: ProcessOps = REAL_OPS): boolean {
  if (serverPid === process.pid) return false; // our pid at startup = a recycled dead server's
  if (!ops.pidAlive(serverPid)) return false;
  const cmd = ops.psCommand(serverPid);
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
export function reclaimPid(pid: number, kind: ManagedProcessKind, ops: ProcessOps = REAL_OPS): ReclaimOutcome {
  if (!ops.pidAlive(pid)) return 'gone';
  const cmd = ops.psCommand(pid);
  if (!cmd || !KIND_COMMAND_RE[kind].test(cmd)) return 'recycled';
  if (kind === 'emulator') return 'adopted'; // still a real emulator — leave it booted (usable via adb)
  return ops.killTree(pid) ? 'killed' : 'gone';
}

export interface ReapOptions {
  ops?: ProcessOps;
  now?: number;
  /** Is the WDA at this base URL healthy (GET /status ready)? */
  wdaHealthy?: (endpoint: string) => Promise<boolean>;
}

async function defaultWdaHealthy(endpoint: string): Promise<boolean> {
  return (await checkWda(endpoint, WDA_ADOPT_PROBE_TIMEOUT_MS)).ready;
}

/** Orphaned WDA entries eligible for adoption: owner dead, < 12 h old, endpoint recorded, pid
 *  still a live xcodebuild (ps-checked), and /status healthy. Probed concurrently, before the lock. */
async function adoptableWdaPids(entries: ManagedProcessEntry[], opts: Required<ReapOptions>): Promise<Set<number>> {
  const candidates = entries.filter(
    (e) =>
      e.kind === 'wda' &&
      typeof e.endpoint === 'string' &&
      opts.now - e.startedAt < WDA_ADOPT_MAX_AGE_MS &&
      !serverStillAlive(e.serverPid, opts.ops) &&
      opts.ops.pidAlive(e.pid) &&
      KIND_COMMAND_RE.wda.test(opts.ops.psCommand(e.pid) ?? ''),
  );
  const healthy = await Promise.all(candidates.map((e) => opts.wdaHealthy(e.endpoint!).catch(() => false)));
  return new Set(candidates.filter((_, i) => healthy[i]).map((e) => e.pid));
}

/** Startup sweep (called once from startServer): reap children whose owning server died —
 *  except a young, healthy managed WDA, which is adopted (see the header comment). */
export async function reapOrphanedProcesses(options: ReapOptions = {}): Promise<void> {
  const opts: Required<ReapOptions> = {
    ops: options.ops ?? REAL_OPS,
    now: options.now ?? Date.now(),
    wdaHealthy: options.wdaHealthy ?? defaultWdaHealthy,
  };
  const adoptable = await adoptableWdaPids(readEntries(), opts);
  mutateEntries((entries) => {
    const keep: ManagedProcessEntry[] = [];
    for (const e of entries) {
      if (serverStillAlive(e.serverPid, opts.ops)) {
        keep.push(e); // a live concurrent server owns it — not ours to touch
        continue;
      }
      if (e.kind === 'wda' && adoptable.has(e.pid)) {
        // Re-own it (startedAt kept, so the 12 h cap counts from the WDA's real start).
        keep.push({ ...e, serverPid: process.pid });
        log('info', 'adopted managed WDA from a previous server run (healthy, < 12 h old)', {
          pid: e.pid,
          endpoint: e.endpoint,
          sessionId: e.sessionId,
        });
        continue;
      }
      const outcome = reclaimPid(e.pid, e.kind, opts.ops);
      if (outcome === 'killed') {
        log('warn', 'reaped orphaned child process from a previous server run', { pid: e.pid, kind: e.kind, sessionId: e.sessionId });
      } else if (outcome === 'adopted') {
        log('info', 'adopted orphaned emulator (left booted; reachable via adb)', { pid: e.pid, sessionId: e.sessionId });
      } else if (outcome === 'recycled') {
        log('info', 'dropped orphan entry: PID was recycled by an unrelated process — not signalled', { pid: e.pid, kind: e.kind });
      }
      // In every other non-live-owner case the entry is dropped: it has been handled.
    }
    return keep;
  });
}
