// Persistence for the App Knowledge Map (SWIPIUM-REQ-01). The canonical map lives at
// `.swipium/app-map.json`; timestamped snapshots accumulate under `.swipium/app-map.history/`; the
// code-symbol + feature indexes live under `.swipium/app-map.index/`. Loading ALWAYS routes through
// migrateAppMap() so an older on-disk shape keeps working. We never commit the map automatically
// (Non-Goals) — but we DO keep `.swipium/` out of the user's VCS via ensureGitignored().

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignored } from '../lib/gitignore.js';
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

export interface LoadResult {
  map: AppKnowledgeMap | null;
  existed: boolean;
  migration?: MigrationResult;
}

/** Load + migrate the map if present. Returns map:null when no file exists (caller builds fresh). */
export function loadAppMap(root: string, fallbackProject: ProjectIdentity, at: string): LoadResult {
  const path = appMapPath(root);
  if (!existsSync(path)) return { map: null, existed: false };
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // corrupt file → treat as fresh but flag via migration result
    const migration = migrateAppMap(null, fallbackProject, at);
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

/** Write the canonical map + a timestamped history snapshot. Keeps the last 30 snapshots. */
export function saveAppMap(root: string, map: AppKnowledgeMap): SaveResult {
  mkdirSync(join(root, SWIPIUM), { recursive: true });
  mkdirSync(appMapHistoryDir(root), { recursive: true });
  ensureGitignored(root);
  const path = appMapPath(root);
  const json = JSON.stringify(map, null, 2);
  writeFileSync(path, json);
  const historyPath = join(appMapHistoryDir(root), `${safeStamp(map.updatedAt)}.json`);
  writeFileSync(historyPath, json);
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
