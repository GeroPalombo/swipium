// Persistence + validation for the App Knowledge Map (SWIPIUM-REQ-01). The canonical map lives at
// `.swipium/app-map.json`; timestamped snapshots accumulate under `.swipium/app-map.history/`; the
// code-symbol + feature indexes live under `.swipium/app-map.index/`. Loading ALWAYS routes through
// migrateAppMap() so an older on-disk shape keeps working. We never commit the map automatically
// (Non-Goals) — but we DO keep `.swipium/` out of the user's VCS via ensureGitignored().

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignored } from '../lib/gitignore.js';
import { fileHash } from './fsWalk.js';
import { migrateAppMap, type MigrationResult } from './migrations.js';
import { APP_MAP_SCHEMA_VERSION, type AppKnowledgeMap, type ProjectIdentity } from './schema.js';
import { validateIssueSummary } from './issues.js';
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
    const snaps = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
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

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
}

/**
 * Validate schema, provenance completeness, missing links, stale fingerprints, and impossible
 * states (SWIPIUM-REQ-01 qa_app_map_validate — "Must be part of npm test").
 */
export function validateAppMap(map: AppKnowledgeMap, opts: { checkFingerprint?: boolean; root?: string } = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (code: string, detail: string) => issues.push({ severity: 'error', code, detail });
  const warn = (code: string, detail: string) => issues.push({ severity: 'warning', code, detail });

  if (map.schemaVersion !== APP_MAP_SCHEMA_VERSION) err('SCHEMA_VERSION', `schemaVersion ${map.schemaVersion} != ${APP_MAP_SCHEMA_VERSION}`);
  if (!map.project?.root) err('NO_PROJECT_ROOT', 'project.root is required');

  const staticIds = new Set(map.staticTopology.screens.map((s) => s.id));
  const runtimeIds = new Set(map.runtimeTopology.screens.map((s) => s.id));

  // duplicate ids
  if (staticIds.size !== map.staticTopology.screens.length) err('DUP_STATIC_ID', 'duplicate static screen ids');
  if (runtimeIds.size !== map.runtimeTopology.screens.length) err('DUP_RUNTIME_ID', 'duplicate runtime screen ids');

  // missing links: runtime → static
  for (const r of map.runtimeTopology.screens) {
    if (r.linkedStaticScreenId && !staticIds.has(r.linkedStaticScreenId)) err('DANGLING_LINK', `runtime ${r.id} links to unknown static ${r.linkedStaticScreenId}`);
    if (r.unmapped && r.linkedStaticScreenId) err('IMPOSSIBLE_UNMAPPED', `runtime ${r.id} is both unmapped and linked`);
  }

  // confidence ranges + feature integrity
  for (const f of map.features) {
    if (f.confidence < 0 || f.confidence > 1) err('CONFIDENCE_RANGE', `feature ${f.id} confidence ${f.confidence} out of [0,1]`);
    if (f.status !== 'fact' && f.status !== 'hypothesis') err('FEATURE_STATUS', `feature ${f.id} bad status ${f.status}`);
    if (f.testCoverage === 'covered' && f.runtimeScreens.length === 0) warn('COVERAGE_NO_RUNTIME', `feature ${f.id} marked covered but has no runtime screens`);
    for (const s of f.staticScreens) if (!staticIds.has(s)) warn('FEATURE_DANGLING_SCREEN', `feature ${f.id} references unknown static screen ${s}`);
  }

  // derived issue summaries (SWIPIUM-REQ-08) must be structurally valid where present.
  for (const s of map.runtimeTopology.screens) for (const e of validateIssueSummary(s.issueSummary, `runtime ${s.id}`)) err('ISSUE_SUMMARY', e);
  for (const s of map.staticTopology.screens) for (const e of validateIssueSummary(s.issueSummary, `static ${s.id}`)) err('ISSUE_SUMMARY', e);
  for (const f of map.features) for (const e of validateIssueSummary(f.issueSummary, `feature ${f.id}`)) err('ISSUE_SUMMARY', e);

  // provenance completeness: a map with content should carry at least one provenance entry.
  const hasContent = map.staticTopology.screens.length > 0 || map.runtimeTopology.screens.length > 0 || map.features.length > 0;
  if (hasContent && map.provenance.length === 0) warn('NO_PROVENANCE', 'map has content but no provenance entries');

  // impossible coverage counts
  if (map.coverage.runtimeScreens !== map.runtimeTopology.screens.length) warn('COVERAGE_COUNT', `coverage.runtimeScreens=${map.coverage.runtimeScreens} != ${map.runtimeTopology.screens.length}`);
  if (map.coverage.staticScreens !== map.staticTopology.screens.length) warn('COVERAGE_COUNT', `coverage.staticScreens=${map.coverage.staticScreens} != ${map.staticTopology.screens.length}`);

  // stale fingerprints (optional — needs filesystem access)
  if (opts.checkFingerprint && opts.root) {
    let stale = 0;
    for (const f of map.sourceFingerprint.files) {
      const h = fileHash(join(opts.root, f.path));
      if (!h) stale++;
      else if (h.hash !== f.hash) stale++;
    }
    if (stale) warn('STALE_FINGERPRINT', `${stale}/${map.sourceFingerprint.files.length} fingerprinted files changed or vanished — rebuild the map`);
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  return { ok: errors === 0, errors, warnings, issues };
}
