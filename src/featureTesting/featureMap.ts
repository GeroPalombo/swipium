// Feature coverage CACHE (Vision Gap Fix 11 — a DERIVED, disposable cache, NOT a source of truth).
// The single durable QA business-context layer is the App Knowledge Map (.swipium/app-map.json) plus
// the persistent test suite (.swipium/test-suite.json); both are written on every feature run. This
// file only memoizes the last per-feature coverage snapshot (runtime/static screens, generated cases
// and outcomes, blockers, automation readiness, evidence) for fast re-display. It can be deleted and
// regenerated at any time without losing QA knowledge. Best-effort + bounded.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FeatureCoverageStatus = 'covered' | 'partial' | 'blocked' | 'not_tested';

export interface FeatureCaseRecord {
  id: string;
  title: string;
  status: 'not_run' | 'pass' | 'fail' | 'blocked' | 'skipped';
  creativity: string;
}

export interface FeatureCoverage {
  featureId: string;
  title: string;
  query: string;
  status: FeatureCoverageStatus;
  lastTestedAt?: string;
  runtimeScreens: string[];
  staticScreens: string[];
  linkConfidence: number;
  cases: FeatureCaseRecord[];
  blockers: string[];
  coverageGaps: string[];
  automationReadiness: string;
  evidence: string[];
}

export interface FeatureMap {
  schemaVersion: 1;
  appId: string;
  features: FeatureCoverage[];
}

function safeName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 120) || 'unknown-app'
  );
}

/** Cache dir — under `.swipium/cache/` to make its disposable/derived status explicit (Fix 11). */
export function featureCoverageCacheDir(root: string): string {
  return join(root, '.swipium', 'cache', 'feature-coverage');
}

export function featureMapPath(root: string, appId?: string): string {
  return join(featureCoverageCacheDir(root), `${safeName(appId ?? 'unknown-app')}.json`);
}

export function loadFeatureMap(root: string, appId?: string): FeatureMap {
  const path = featureMapPath(root, appId);
  if (!existsSync(path)) return { schemaVersion: 1, appId: appId ?? 'unknown-app', features: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FeatureMap;
    return {
      schemaVersion: 1,
      appId: parsed.appId ?? appId ?? 'unknown-app',
      features: Array.isArray(parsed.features) ? parsed.features : [],
    };
  } catch {
    return { schemaVersion: 1, appId: appId ?? 'unknown-app', features: [] };
  }
}

/** Upsert a feature's coverage (by featureId) and persist. Returns the file path. */
export function upsertFeatureCoverage(root: string, appId: string | undefined, coverage: FeatureCoverage): string {
  const path = featureMapPath(root, appId);
  const map = loadFeatureMap(root, appId);
  map.appId = appId ?? map.appId ?? 'unknown-app';
  const idx = map.features.findIndex((f) => f.featureId === coverage.featureId);
  if (idx >= 0) map.features[idx] = coverage;
  else map.features.push(coverage);
  map.features = map.features.slice(-200);
  mkdirSync(featureCoverageCacheDir(root), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2));
  return path;
}

export function findFeatureCoverage(root: string, appId: string | undefined, featureId: string): FeatureCoverage | undefined {
  return loadFeatureMap(root, appId).features.find((f) => f.featureId === featureId);
}
