// Persistence for the App Knowledge Map. The canonical map lives at
// `.swipium/app-map.json`; timestamped snapshots accumulate under `.swipium/app-map.history/`; the
// code-symbol + feature indexes live under `.swipium/app-map.index/`. Loading ALWAYS routes through
// migrateAppMap() so an older on-disk shape keeps working. We never commit the map automatically
// (Non-Goals) — but we DO keep `.swipium/` out of the user's VCS via ensureGitignored().

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignored } from '../lib/gitignore.js';
import { cleanupOrphanTmpFiles, withFileLock, withFileLockAsync, writeFileAtomicSync } from '../lib/lockfile.js';
import { migrateAppMap, type MigrationResult } from './migrations.js';
import type { AppKnowledgeMap, ProjectIdentity } from './schema.js';
import type { CodeIndex } from './codeIndex.js';
import type { FeatureNode } from './schema.js';

const SWIPIUM = '.swipium';

/** Stable per-project id used in the MCP resource URI (mirrors the session store's project hash). */
export function projectId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

export function appMapPath(root: string): string {
  return join(root, SWIPIUM, 'app-map.json');
}
export function appMapHistoryDir(root: string): string {
  return join(root, SWIPIUM, 'app-map.history');
}
export function appMapIndexDir(root: string): string {
  return join(root, SWIPIUM, 'app-map.index');
}
export function appMapResourceUri(root: string): string {
  return `swipium://project/${projectId(root)}/app-map`;
}

/** Run a load→mutate→save cycle over app-map.json under the cross-process advisory lock. Every
 *  WRITE cycle (buildAppMap, linkAutomationSuite, qa_app_map_update, the suite mirror) wraps its
 *  whole cycle in this — locking only the save would still let two writers load the same base map
 *  and clobber each other. saveAppMap itself never locks, so there is no nested acquisition. */
export function withAppMapLock<T>(root: string, fn: () => T): T {
  mkdirSync(join(root, SWIPIUM), { recursive: true }); // the lock dir's parent must exist before mkdir(lock)
  return withFileLock(join(root, SWIPIUM, 'app-map.lock'), fn);
}

/** Async twin of withAppMapLock for async critical sections: the lock is heartbeated while `fn`
 *  runs, so a long holder is never judged stale and taken over (H8). */
export function withAppMapLockAsync<T>(root: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(join(root, SWIPIUM), { recursive: true });
  return withFileLockAsync(join(root, SWIPIUM, 'app-map.lock'), fn);
}

export interface LoadResult {
  map: AppKnowledgeMap | null;
  existed: boolean;
  migration?: MigrationResult;
}

/** Newest parseable history snapshot (torn/corrupt snapshots are skipped), or null when none. */
function recoverFromHistory(root: string): { raw: unknown; file: string } | null {
  try {
    const dir = appMapHistoryDir(root);
    if (!existsSync(dir)) return null;
    const snaps = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    for (const file of snaps) {
      try {
        return { raw: JSON.parse(readFileSync(join(dir, file), 'utf8')), file };
      } catch {
        /* torn snapshot — try the next-older one */
      }
    }
  } catch {
    /* best-effort — fall through to a fresh map */
  }
  return null;
}

/** Load + migrate the map if present. Returns map:null when no file exists (caller builds fresh). */
export function loadAppMap(root: string, fallbackProject: ProjectIdentity, at: string): LoadResult {
  const path = appMapPath(root);
  if (!existsSync(path)) return { map: null, existed: false };
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // corrupt canonical file → restore the newest parseable history snapshot instead of silently
    // resetting to a fresh map; fresh only when no snapshot parses either. Flagged via migration.
    const recovered = recoverFromHistory(root);
    const migration = migrateAppMap(recovered?.raw ?? null, fallbackProject, at);
    if (recovered) migration.recoveredFrom = recovered.file;
    return { map: migration.map, existed: true, migration };
  }
  const migration = migrateAppMap(raw, fallbackProject, at);
  return { map: migration.map, existed: true, migration };
}

function safeStamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

export interface SaveResult {
  path: string;
  historyPath: string;
  resourceUri: string;
}

/** Write the canonical map + a timestamped history snapshot. Keeps the last 30 snapshots.
 *  Lock-free by design: callers hold withAppMapLock() across their full load→mutate→save cycle. */
export function saveAppMap(root: string, map: AppKnowledgeMap): SaveResult {
  mkdirSync(join(root, SWIPIUM), { recursive: true });
  mkdirSync(appMapHistoryDir(root), { recursive: true });
  ensureGitignored(root);
  const path = appMapPath(root);
  const json = JSON.stringify(map, null, 2);
  // Atomic write (unique tmp + rename, retried on transient Windows sharing violations) so a crash
  // mid-write never leaves a truncated app-map.json. Tmp residue from a writer that crashed between
  // write and rename is swept once it is old enough not to belong to a live writer.
  writeFileAtomicSync(path, json);
  cleanupOrphanTmpFiles(join(root, SWIPIUM), 'app-map.json');
  const historyPath = join(appMapHistoryDir(root), `${safeStamp(map.updatedAt)}.json`);
  writeFileAtomicSync(historyPath, json);
  pruneHistory(root);
  return { path, historyPath, resourceUri: appMapResourceUri(root) };
}

function pruneHistory(root: string): void {
  try {
    const dir = appMapHistoryDir(root);
    if (!existsSync(dir)) return;
    const snaps = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const stale of snaps.slice(0, Math.max(0, snaps.length - 30))) rmSync(join(dir, stale), { force: true });
  } catch {
    /* best-effort */
  }
}

export function saveIndexes(root: string, codeIndex: CodeIndex | null, features: FeatureNode[]): void {
  try {
    mkdirSync(appMapIndexDir(root), { recursive: true });
    if (codeIndex) writeFileSync(join(appMapIndexDir(root), 'code-symbols.json'), JSON.stringify(codeIndex, null, 2));
    writeFileSync(join(appMapIndexDir(root), 'feature-index.json'), JSON.stringify({ schemaVersion: 1, features }, null, 2));
  } catch {
    /* best-effort: indexes are a cache, not the source of truth */
  }
}

export function loadCodeIndex(root: string): CodeIndex | null {
  const p = join(appMapIndexDir(root), 'code-symbols.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CodeIndex;
  } catch {
    return null;
  }
}
