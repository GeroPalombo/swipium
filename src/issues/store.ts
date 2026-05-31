// SWIPIUM Issue Log — persistence (SWIPIUM-REQ-07 "New storage").
//
// `.swipium/issues-log.jsonl`   — canonical, append-only event ledger. NEVER pruned by default.
// `.swipium/issues/index.json`  — derived cache, rebuildable from the log if deleted/corrupt.
// `.swipium/issues/policy.json` — classifier + retention + source-revision policy.
// `.swipium/issues/artifacts/`  — large evidence files (may follow normal retention).
//
// The log is the source of truth: the index is always recomputable via rebuildRecords(). Writes are
// append-only for events and atomic (temp + rename) for the index. Best-effort I/O — corrupt files
// degrade to a rebuild, never throw on read.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignored } from '../lib/gitignore.js';
import type { ClassifierPolicy } from './classify.js';
import { rebuildRecords } from './recurrence.js';
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
  return { path, count: events.length };
}

/** Atomically write the derived index (temp + rename). */
export function saveIndex(root: string, index: IssueIndex): { path: string; resourceUri: string } {
  mkdirSync(issuesDir(root), { recursive: true });
  ensureGitignored(root);
  const path = issuesIndexPath(root);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, path);
  return { path, resourceUri: issuesResourceUri(root) };
}

/** Load the index from disk; null when absent/corrupt (caller should rebuild). */
export function loadIndex(root: string): IssueIndex | null {
  try {
    const path = issuesIndexPath(root);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as IssueIndex;
    if (raw.schemaVersion !== ISSUE_SCHEMA_VERSION || !Array.isArray(raw.records)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Rebuild the index from the canonical log and persist it. The log is always authoritative. */
export function rebuildIndex(root: string, now: string, appId?: string): IssueIndex {
  const events = readEvents(root);
  const records = rebuildRecords(events);
  const index: IssueIndex = { schemaVersion: ISSUE_SCHEMA_VERSION, updatedAt: now, appId, records };
  if (events.length > 0) saveIndex(root, index);
  return index;
}

/** Get the current index, rebuilding from the log when the cache is missing/stale/corrupt. */
export function getIndex(root: string, now: string, appId?: string): IssueIndex {
  const cached = loadIndex(root);
  if (cached) return cached;
  const events = readEvents(root);
  if (events.length === 0) return emptyIndex(now, appId);
  return rebuildIndex(root, now, appId);
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
  return index.records.find(
    (r) => (key.issueId && r.issueId === key.issueId) || (key.fingerprint && r.fingerprint === key.fingerprint),
  );
}
