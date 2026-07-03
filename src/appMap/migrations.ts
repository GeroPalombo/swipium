// Schema migration + versioning for long-lived project QA knowledge (SWIPIUM-REQ-01 "No schema
// migration/versioning exists" gap). Loading a map ALWAYS routes through migrate(): an unknown or
// older shape is normalized to APP_MAP_SCHEMA_VERSION, filling any newly-added fields with safe
// defaults so a map written by an older Swipium keeps working. Acceptance: "Map schema migration
// tests cover at least v1 -> latest."

import { APP_MAP_SCHEMA_VERSION, emptyAppMap, type AppKnowledgeMap, type ProjectIdentity } from './schema.js';

export interface MigrationResult {
  map: AppKnowledgeMap;
  migratedFrom: number | 'unknown';
  applied: string[]; // names of migrations applied
}

/** Per-version upgrade steps. Add an entry when bumping APP_MAP_SCHEMA_VERSION. */
const MIGRATIONS: Record<number, { to: number; name: string; up: (m: Record<string, unknown>) => Record<string, unknown> }> = {
  // 0 → 1: pre-schema / legacy blobs. Normalize by merging onto an empty v1 map so every required
  // top-level field exists. Known legacy fields are carried over where the shape is compatible.
  0: {
    to: 1,
    name: 'v0->v1 normalize legacy blob',
    up: (m) => {
      const project = (m.project as ProjectIdentity) ?? null;
      const base = emptyAppMap(
        project ?? {
          root: (m.root as string) ?? '',
          gitRemote: null,
          packageName: null,
          workspaceTarget: null,
          framework: (m.framework as ProjectIdentity['framework']) ?? 'unknown',
          platforms: [],
        },
        (m.generatedAt as string) ?? (m.updatedAt as string) ?? '1970-01-01T00:00:00.000Z',
      ) as unknown as Record<string, unknown>;
      // carry over any top-level fields that already match the v1 shape
      for (const k of Object.keys(base)) {
        if (k === 'schemaVersion') continue;
        if (m[k] !== undefined && m[k] !== null) base[k] = m[k];
      }
      base.schemaVersion = 1;
      return base;
    },
  },
};

function detectVersion(raw: Record<string, unknown>): number | 'unknown' {
  const v = raw.schemaVersion;
  if (typeof v === 'number') return v;
  // No version field at all → treat as legacy v0.
  return raw && typeof raw === 'object' ? 0 : 'unknown';
}

/**
 * Bring any parsed map blob up to the current schema version. Never throws on a malformed blob:
 * a totally unrecognizable input yields a fresh empty map for `fallbackProject`.
 */
export function migrateAppMap(raw: unknown, fallbackProject: ProjectIdentity, at: string): MigrationResult {
  if (!raw || typeof raw !== 'object') {
    return { map: emptyAppMap(fallbackProject, at), migratedFrom: 'unknown', applied: ['fresh (unparseable input)'] };
  }
  let cur = raw as Record<string, unknown>;
  const from = detectVersion(cur);
  const applied: string[] = [];

  let version = from === 'unknown' ? 0 : from;
  if (from === 'unknown') {
    // wrap whatever we got as a legacy blob so the v0->v1 step can normalize it
    cur = { ...cur, schemaVersion: 0 };
  }

  // run forward migrations until we reach the latest version
  let guard = 0;
  while (version < APP_MAP_SCHEMA_VERSION && guard++ < 50) {
    const step = MIGRATIONS[version];
    if (!step) break; // no migration defined — stop and patch defaults below
    cur = step.up(cur);
    applied.push(step.name);
    version = step.to;
  }

  // Defensive: ensure every required top-level field exists (additive forward-compat).
  const filled = fillDefaults(cur, fallbackProject, at);
  filled.schemaVersion = APP_MAP_SCHEMA_VERSION;
  return { map: filled as unknown as AppKnowledgeMap, migratedFrom: from, applied: applied.length ? applied : ['none (already latest)'] };
}

/** Merge a (possibly partial) map onto an empty map so all required fields are present. */
function fillDefaults(cur: Record<string, unknown>, fallbackProject: ProjectIdentity, at: string): Record<string, unknown> {
  const project = (cur.project as ProjectIdentity) ?? fallbackProject;
  const base = emptyAppMap(project, (cur.generatedAt as string) ?? at) as unknown as Record<string, unknown>;
  for (const k of Object.keys(base)) {
    if (k === 'schemaVersion' || k === 'project') continue;
    if (cur[k] !== undefined && cur[k] !== null) base[k] = cur[k];
  }
  base.updatedAt = (cur.updatedAt as string) ?? at;
  return base;
}
