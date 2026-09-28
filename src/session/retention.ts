// Retention for ~/.swipium/runs (pre-launch disk finding: session dirs were never deleted — one
// machine had 27,870 dirs / 283 MB; registry.json caps ENTRIES at 200 but the dirs stayed forever).
//
// Rule (both the automatic startup prune and `swipium gc`): a session dir under
// ~/.swipium/runs/<projectHash>/<sessionId> is deleted only when ALL hold:
//   - its last activity (newest mtime of the dir / its state.json) is older than `days`;
//   - it is NOT listed in ~/.swipium/registry.json (reloadable prior sessions stay);
//   - it is NOT live in this process;
//   - it is NOT among the newest `keepPerProject` sessions of its project (kept regardless of age).
// Thresholds: SWIPIUM_RETENTION_DAYS (default 30; "0"/"off" disables the automatic startup prune —
// `swipium gc` still works) and SWIPIUM_RETENTION_KEEP (default 20 per project).
// Async fs throughout so the background prune never blocks the server's event loop; every error is
// swallowed per entry (logged) — retention must never break a run.

import { readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { log } from '../lib/logger.js';

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_KEEP_PER_PROJECT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionOptions {
  /** Home dir holding `.swipium` (default: os.homedir() at call time). */
  home?: string;
  days?: number;
  keepPerProject?: number;
  dryRun?: boolean;
  now?: number;
  /** Session dirs live in this process — never deleted. */
  liveDirs?: Iterable<string>;
}

export interface RetentionResult {
  runsDir: string;
  days: number;
  keepPerProject: number;
  dryRun: boolean;
  scanned: number;
  /** Session dirs deleted (or that WOULD be deleted, in dry-run). */
  deleted: string[];
  bytesReclaimed: number;
  errors: number;
}

/** Positive integer from an env value, `null` for "off"/"0" (disabled), else `fallback`. */
function envInt(raw: string | undefined, fallback: number): number | null {
  if (raw == null || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === 'never') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n === 0 ? null : Math.floor(n);
}

/** SWIPIUM_RETENTION_DAYS (default 30). `null` = automatic pruning disabled ("0" / "off"). */
export function retentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  return envInt(env.SWIPIUM_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

/** SWIPIUM_RETENTION_KEEP (default 20): newest sessions per project kept regardless of age. */
export function retentionKeepFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.SWIPIUM_RETENTION_KEEP, DEFAULT_KEEP_PER_PROJECT) ?? 0;
}

async function registryDirs(swipiumDir: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(swipiumDir, 'registry.json'), 'utf8'));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((e) => (e as { dir?: unknown })?.dir)
        .filter((d): d is string => typeof d === 'string')
        .map((d) => resolve(d)),
    );
  } catch {
    return new Set();
  }
}

async function lastActivity(dir: string): Promise<number> {
  const d = await stat(dir);
  let t = d.mtimeMs;
  try {
    t = Math.max(t, (await stat(join(dir, 'state.json'))).mtimeMs);
  } catch {
    /* no state.json */
  }
  return t;
}

/** Total bytes under `p` (files only; best-effort). */
export async function dirSize(p: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const child = join(p, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(child);
      else if (e.isFile()) total += (await stat(child)).size;
    } catch {
      /* vanished */
    }
  }
  return total;
}

/** Prune old session dirs under <home>/.swipium/runs (see the header for the rule). Never throws. */
export async function pruneSessionRuns(opts: RetentionOptions = {}): Promise<RetentionResult> {
  const swipiumDir = join(opts.home ?? homedir(), '.swipium');
  const runsDir = join(swipiumDir, 'runs');
  const days = opts.days ?? retentionDaysFromEnv() ?? DEFAULT_RETENTION_DAYS;
  const keepPerProject = opts.keepPerProject ?? retentionKeepFromEnv();
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? Date.now();
  const cutoff = now - days * DAY_MS;
  const result: RetentionResult = { runsDir, days, keepPerProject, dryRun, scanned: 0, deleted: [], bytesReclaimed: 0, errors: 0 };
  const registered = await registryDirs(swipiumDir);
  const live = new Set([...(opts.liveDirs ?? [])].map((d) => resolve(d)));

  let projects;
  try {
    projects = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return result; // no runs dir yet
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projectDir = join(runsDir, p.name);
    let sessions: Array<{ dir: string; at: number }> = [];
    try {
      const entries = await readdir(projectDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = join(projectDir, e.name);
        try {
          sessions.push({ dir, at: await lastActivity(dir) });
        } catch {
          result.errors++;
        }
      }
    } catch (e) {
      result.errors++;
      log('warn', 'retention: unreadable project runs dir — skipped', { dir: projectDir, err: String(e) });
      continue;
    }
    result.scanned += sessions.length;
    sessions = sessions.sort((a, b) => b.at - a.at);
    const candidates = sessions
      .slice(keepPerProject)
      .filter((x) => x.at < cutoff && !registered.has(resolve(x.dir)) && !live.has(resolve(x.dir)));
    for (const c of candidates) {
      try {
        result.bytesReclaimed += await dirSize(c.dir);
        if (!dryRun) await rm(c.dir, { recursive: true, force: true });
        result.deleted.push(c.dir);
      } catch (e) {
        result.errors++;
        log('warn', 'retention: failed to delete old session dir', { dir: c.dir, err: String(e) });
      }
    }
    if (!dryRun && candidates.length && candidates.length === sessions.length) {
      await rmdir(projectDir).catch(() => undefined); // only succeeds when empty
    }
  }
  return result;
}

let startupPruneScheduled = false;

/** Schedule ONE background prune per process (called when the session store starts). Honors
 *  SWIPIUM_RETENTION_DAYS ("0"/"off" disables). Non-blocking; errors are logged, never thrown. */
export function scheduleStartupPrune(liveDirs: () => Iterable<string>, delayMs = 15_000): void {
  if (startupPruneScheduled) return;
  startupPruneScheduled = true;
  const days = retentionDaysFromEnv();
  if (days == null) return;
  const timer = setTimeout(() => {
    pruneSessionRuns({ days, liveDirs: liveDirs() })
      .then((r) => {
        if (r.deleted.length)
          log('info', 'retention: pruned old session dirs', {
            deleted: r.deleted.length,
            bytesReclaimed: r.bytesReclaimed,
            days: r.days,
            keepPerProject: r.keepPerProject,
          });
      })
      .catch((e) => log('warn', 'retention: startup prune failed', { err: String(e) }));
  }, delayMs);
  timer.unref?.(); // never keep the process alive for housekeeping
}
