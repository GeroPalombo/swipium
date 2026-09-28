// SWIPIUM Issue Log — persistence (SWIPIUM-REQ-07 "New storage").
//
// `.swipium/issues-log.jsonl`   — canonical, append-only event ledger. NEVER pruned by default.
// `.swipium/issues/index.json`  — derived cache, rebuildable from the log if deleted/corrupt.
// `.swipium/issues/policy.json` — classifier + retention + source-revision policy.
// `.swipium/issues/artifacts/`  — large evidence files (may follow normal retention).
//
// The log is the source of truth: the index is always recomputable via rebuildRecords(). Writes are
// append-only for events and atomic (unique temp + rename) for the index. Best-effort I/O — corrupt
// files degrade to a rebuild, never throw on read.
//
// Concurrency: several MCP server instances (and the CI CLI) can share one project. Every
// read-modify-write of the ledger runs under withLedgerLock(), and the cached index records the
// log's size/mtime it was derived from — a cache whose stamp no longer matches the log (another
// process appended) is rebuilt instead of trusted.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignored } from '../lib/gitignore.js';
import { withFileLock } from '../lib/lockfile.js';
import type { ClassifierPolicy } from './classify.js';
import { liftSuppression, rebuildRecords, suppressionExpired } from './recurrence.js';
import type { IssueEvent, IssueIndex, IssueRecord } from './schema.js';
import { ISSUE_SCHEMA_VERSION, emptyIndex, validateEvent } from './schema.js';

const SWIPIUM = '.swipium';

export function issuesLogPath(root: string): string {
  return join(root, SWIPIUM, 'issues-log.jsonl');
}
export function issuesDir(root: string): string {
  return join(root, SWIPIUM, 'issues');
}
export function issuesIndexPath(root: string): string {
  return join(issuesDir(root), 'index.json');
}
export function issuesPolicyPath(root: string): string {
  return join(issuesDir(root), 'policy.json');
}
export function issuesArtifactsDir(root: string): string {
  return join(issuesDir(root), 'artifacts');
}
export function issuesProjectId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}
export function issuesResourceUri(root: string): string {
  return `swipium://project/${issuesProjectId(root)}/issues`;
}

/** The on-disk policy file (`.swipium/issues/policy.json`). */
export interface IssuePolicyFile extends ClassifierPolicy {
  schemaVersion?: number;
  allowGitMetadataRead?: boolean;
  sourceRevision?: { provider?: string; commit?: string; buildVersion?: string };
  retention?: { keepIssueEvents?: 'forever' | number; pruneEvidenceAfterDays?: number };
}

export const DEFAULT_POLICY: IssuePolicyFile = {
  schemaVersion: 1,
  allowGitMetadataRead: false,
  retention: { keepIssueEvents: 'forever', pruneEvidenceAfterDays: 90 },
};

/** Load the policy file, merged over defaults. Best-effort — corrupt file → defaults. */
export function loadPolicy(root: string): IssuePolicyFile {
  try {
    const path = issuesPolicyPath(root);
    if (!existsSync(path)) return { ...DEFAULT_POLICY };
    const raw = JSON.parse(readFileSync(path, 'utf8')) as IssuePolicyFile;
    return { ...DEFAULT_POLICY, ...raw, retention: { ...DEFAULT_POLICY.retention, ...raw.retention } };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

/** Read all events from the append-only log, skipping unparsable/invalid lines. */
export function readEvents(root: string): IssueEvent[] {
  const path = issuesLogPath(root);
  if (!existsSync(path)) return [];
  const out: IssueEvent[] = [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as IssueEvent;
      if (validateEvent(ev).length === 0) out.push(ev);
    } catch {
      /* skip a corrupt line — the log stays usable */
    }
  }
  return out;
}

/** Append one or more events to the canonical log (creating dirs + gitignore on first write). */
export function appendEvents(root: string, events: IssueEvent[]): { path: string; count: number } {
  if (events.length === 0) return { path: issuesLogPath(root), count: 0 };
  mkdirSync(join(root, SWIPIUM), { recursive: true });
  ensureGitignored(root);
  const path = issuesLogPath(root);
  const payload = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(path, payload);
  // Retention (policy.retention.pruneEvidenceAfterDays, default 90): large evidence files under
  // .swipium/issues/artifacts/ older than N days are pruned on ledger write. The append-only event
  // log itself is never pruned here (keepIssueEvents).
  pruneEvidence(root, loadPolicy(root).retention?.pruneEvidenceAfterDays);
  return { path, count: events.length };
}

/** Delete evidence files under `.swipium/issues/artifacts/` whose mtime is older than `days`
 *  (recursively; emptied sub-dirs removed). `days` ≤ 0 / non-finite = disabled. Best-effort: returns
 *  the number of files deleted and never throws. */
export function pruneEvidence(root: string, days: number | undefined, now: number = Date.now()): number {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return 0;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let deleted = 0;
  const walk = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let remaining = entries.length;
    for (const e of entries) {
      const p = join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (walk(p)) {
            rmSync(p, { recursive: true, force: true });
            remaining--;
          }
        } else if (statSync(p).mtimeMs < cutoff) {
          rmSync(p, { force: true });
          deleted++;
          remaining--;
        }
      } catch {
        /* vanished / unreadable — skip */
      }
    }
    return remaining === 0; // caller may remove an emptied sub-dir
  };
  walk(issuesArtifactsDir(root));
  return deleted;
}

/**
 * Run a ledger read-modify-write under the project's cross-process issue lock
 * (`.swipium/issues/.lock`). NOT re-entrant: call it once at the outermost mutation.
 */
export function withLedgerLock<T>(root: string, fn: () => T): T {
  mkdirSync(issuesDir(root), { recursive: true });
  return withFileLock(join(issuesDir(root), '.lock'), fn);
}

/** Size + mtime of the canonical log, or null when absent. */
function logStamp(root: string): { logSize: number; logMtimeMs: number } | null {
  try {
    const st = statSync(issuesLogPath(root));
    return { logSize: st.size, logMtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Atomically write the derived index (unique temp + rename), stamped with the log's size/mtime. */
export function saveIndex(
  root: string,
  index: IssueIndex,
  stamp: { logSize: number; logMtimeMs: number } | null = logStamp(root),
): { path: string; resourceUri: string } {
  mkdirSync(issuesDir(root), { recursive: true });
  ensureGitignored(root);
  const path = issuesIndexPath(root);
  if (stamp) Object.assign(index, stamp);
  // Unique per writer: two processes sharing `index.json.tmp` could rename each other's half-file.
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, path);
  return { path, resourceUri: issuesResourceUri(root) };
}

/** Load the index from disk; null when absent/corrupt/stale versus the log (caller should rebuild). */
export function loadIndex(root: string): IssueIndex | null {
  try {
    const path = issuesIndexPath(root);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as IssueIndex;
    if (raw.schemaVersion !== ISSUE_SCHEMA_VERSION || !Array.isArray(raw.records)) return null;
    // Stale check: another process appended since this cache was written (or it predates stamps).
    const stamp = logStamp(root);
    if (stamp && (raw.logSize !== stamp.logSize || raw.logMtimeMs !== stamp.logMtimeMs)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Rebuild the index from the canonical log and persist it. The log is always authoritative. */
export function rebuildIndex(root: string, now: string, appId?: string): IssueIndex {
  // Stamp BEFORE reading: this may run outside the ledger lock (read paths), and a stamp taken after
  // a concurrent append would bless records that don't include it. An early stamp only ever makes
  // the cache look stale (one extra rebuild), never fresher than it is.
  const stamp = logStamp(root);
  const events = readEvents(root);
  const records = rebuildRecords(events);
  const index: IssueIndex = { schemaVersion: ISSUE_SCHEMA_VERSION, updatedAt: now, appId, records };
  if (events.length > 0) {
    try {
      saveIndex(root, index, stamp);
    } catch {
      /* cache write is best-effort — the log stays authoritative */
    }
  }
  return index;
}

/** Get the current index, rebuilding from the log when the cache is missing/stale/corrupt. */
export function getIndex(root: string, now: string, appId?: string): IssueIndex {
  const index = loadIndex(root) ?? (readEvents(root).length === 0 ? emptyIndex(now, appId) : rebuildIndex(root, now, appId));
  // Enforce `suppressedUntil`: an expired suppression is shown in its pre-suppression lane from
  // `now` on (the next event on the issue makes that durable in the log — see foldEvent).
  index.records = index.records.map((r) => (suppressionExpired(r, now) ? liftSuppression(r) : r));
  return index;
}

/**
 * Count events already in the log for an issue. Used to allocate a monotonic per-issue sequence so
 * event ids stay unique even when several observations share the same timestamp.
 */
export function eventCountForIssue(root: string, issueId: string): number {
  let n = 0;
  for (const e of readEvents(root)) if (e.issueId === issueId) n += 1;
  return n;
}

/** Find an index record by issue id or fingerprint. */
export function findRecord(index: IssueIndex, key: { issueId?: string; fingerprint?: string }): IssueRecord | undefined {
  return index.records.find((r) => (key.issueId && r.issueId === key.issueId) || (key.fingerprint && r.fingerprint === key.fingerprint));
}
