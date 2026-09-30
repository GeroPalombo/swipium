// App map builder (qa_app_map_build orchestration). Resolves project identity, runs
// the framework-aware static scan, loads + migrates any existing map, optionally merges a runtime
// explore graph, recomputes coverage/confidence, and persists. Additive: a static rescan refreshes
// the static topology while PRESERVING runtime observations, tickets, the test suite, and automation
// links. Pure-ish: filesystem I/O is confined to staticScan/codeIndex/store; this composes them.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectFramework, type Framework } from '../context/detect.js';
import type { SerializedGraph } from '../explore/graph.js';
import { buildCodeIndex, type CodeIndex } from './codeIndex.js';
import { inferFeatures } from './featureModel.js';
import { addProvenance, makeProvenance, recomputeConfidence } from './provenance.js';
import { applyIssueSummariesToAppMap } from './issues.js';
import { mergeRuntimeGraph, computeUnvisitedStaticScreens, type MergeResult } from './runtimeMerge.js';
import { applyFirstRunPatches, type FirstRunApplyResult } from './firstRunApply.js';
import type { AppMapPatch } from '../firstRun/types.js';
import { emptyAppMap, type AppKnowledgeMap, type ProjectIdentity } from './schema.js';
import { hasFormLibrary, staticScan } from './staticScan.js';
import { appMapPath, loadAppMap, saveAppMap, saveIndexes, withAppMapLock, type SaveResult } from './store.js';
import { rememberProject } from './projectRegistry.js';
import type { MigrationResult } from './migrations.js';

export type BuildMode = 'static_only' | 'runtime_merge' | 'full';

export interface BuildOptions {
  mode: BuildMode;
  at: string; // ISO timestamp (caller supplies — keeps this testable/deterministic)
  includeCodeIndex?: boolean; // default true
  forceRescan?: boolean; // default false
  sessionId?: string;
  exploreGraph?: SerializedGraph | null; // runtime graph to merge
  firstRunPatches?: AppMapPatch[] | null; // first-run classifications to fold into the durable map
  appIdentityHints?: {
    androidPackage?: string | null;
    iosBundleId?: string | null;
    artifactHash?: string | null;
    environment?: string | null;
  };
  persist?: boolean; // default true — write to disk
}

export interface BuildResult {
  map: AppKnowledgeMap;
  codeIndex: CodeIndex | null;
  mergeResult?: MergeResult;
  firstRunApply?: FirstRunApplyResult;
  migration?: MigrationResult;
  save?: SaveResult;
  rescanned: boolean;
}

function gitRemote(root: string): string | null {
  try {
    const cfg = readFileSync(join(root, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function platformsFor(fw: Framework): Array<'android' | 'ios'> {
  switch (fw) {
    case 'native-android':
      return ['android'];
    case 'native-ios':
      return ['ios'];
    default:
      return ['android', 'ios'];
  }
}

function projectIdentity(root: string, fw: Framework, packageName: string | null): ProjectIdentity {
  return {
    root,
    gitRemote: gitRemote(root),
    packageName,
    workspaceTarget: null,
    framework: fw,
    platforms: platformsFor(fw),
  };
}

function recomputeCoverage(map: AppKnowledgeMap): void {
  // Recompute unvisited static screens here so it is correct after EVERY build path — including a
  // static-only scan where mergeRuntimeGraph never runs.
  map.runtimeTopology.unvisitedStaticScreens = computeUnvisitedStaticScreens(map);
  const staticScreens = map.staticTopology.screens.length;
  const runtimeScreens = map.runtimeTopology.screens.length;
  const linkedScreens = map.runtimeTopology.screens.filter((r) => r.linkedStaticScreenId).length;
  const unmapped = map.runtimeTopology.screens.filter((r) => r.unmapped).length;
  const featureCoverage: Record<string, AppKnowledgeMap['features'][number]['testCoverage']> = {};
  for (const f of map.features) featureCoverage[f.id] = f.testCoverage;
  const staleTests = map.testSuite.cases.filter((c) => c.stale).length;
  const overallPercent = staticScreens ? Math.round((linkedScreens / staticScreens) * 100) : runtimeScreens ? 100 : 0;
  map.coverage = {
    staticScreens,
    runtimeScreens,
    linkedScreens,
    unvisitedStaticScreens: map.runtimeTopology.unvisitedStaticScreens.length,
    unmappedRuntimeScreens: unmapped,
    featureCoverage,
    staleTests,
    overallPercent,
  };
}

/** Everything the (slow) static scan produces — computed OUTSIDE the app-map lock (H8) so the
 *  locked critical section is only load → merge → save and can never outlive the stale threshold. */
interface StaticScanBundle {
  scan: ReturnType<typeof staticScan>;
  features: ReturnType<typeof inferFeatures>;
  codeIndex: CodeIndex | null;
}

/** Run the filesystem-heavy static scan + feature inference + code index. Lock-free: reads only
 *  the project sources, never the app map. */
function computeStaticScan(root: string, at: string): StaticScanBundle {
  const scan = staticScan(root, at);
  const features = inferFeatures({
    topo: scan.staticTopology,
    auth: scan.auth,
    onboarding: scan.onboarding,
    paywalls: scan.paywalls,
    hasForms: hasFormLibrary(root),
  });
  // Code index over the collected files.
  const codeIndex = buildCodeIndex(root, scan.collectedFiles, at);
  return { scan, features, codeIndex };
}

/** Replace the static topology + static-derived facts; preserve runtime feature enrichment.
 *  Pure over (map, bundle) — cheap enough to run inside the lock. */
function applyStaticScan(map: AppKnowledgeMap, bundle: StaticScanBundle, at: string): CodeIndex | null {
  const { scan } = bundle;
  map.staticTopology = scan.staticTopology;
  map.appIdentity = {
    androidPackage: scan.appIdentity.androidPackage ?? map.appIdentity.androidPackage,
    iosBundleId: scan.appIdentity.iosBundleId ?? map.appIdentity.iosBundleId,
    appName: scan.appIdentity.appName ?? map.appIdentity.appName,
    version: scan.appIdentity.version ?? map.appIdentity.version,
    artifactHash: map.appIdentity.artifactHash,
    environment: map.appIdentity.environment,
  };
  map.auth = scan.auth;
  map.onboarding = scan.onboarding;
  map.paywalls = scan.paywalls;
  map.inputModels = scan.inputModels;
  map.sourceFingerprint = scan.sourceFingerprint;
  if (scan.packageName) map.project.packageName = scan.packageName;

  // Re-inferred features, but carry over runtime enrichment (runtimeScreens/testCoverage) by id.
  const prevById = new Map(map.features.map((f) => [f.id, f]));
  map.features = bundle.features.map((f) => {
    const prev = prevById.get(f.id);
    if (!prev) return f;
    return {
      ...f,
      runtimeScreens: prev.runtimeScreens,
      testCoverage: prev.testCoverage,
      actions: prev.actions.length ? prev.actions : f.actions,
    };
  });

  addProvenance(
    map,
    makeProvenance(
      'code_scan',
      at,
      `Static scan: ${scan.staticTopology.screens.length} screen(s), router=${scan.staticTopology.router ?? 'none'}`,
      { targetType: 'map', refs: scan.staticTopology.parserNotes.slice(0, 3) },
    ),
  );
  if (scan.appIdentity.androidPackage || scan.appIdentity.iosBundleId) {
    addProvenance(
      map,
      makeProvenance('app_config', at, `App identity from config: ${scan.appIdentity.androidPackage ?? scan.appIdentity.iosBundleId}`, {
        targetType: 'identity',
      }),
    );
  }
  return bundle.codeIndex;
}

/** Test seam: observe where the static scan runs relative to the lock. */
export const buildHooks: { onStaticScan?: (root: string) => void } = {};

/** Build (or incrementally update) the app map. Filesystem-bound but never throws on scan errors. */
export function buildAppMap(root: string, opts: BuildOptions): BuildResult {
  // H8: the static scan can take many seconds on a large repo, and the lock is synchronous (no
  // heartbeat can fire while a sync fn runs) — holding it across the scan let a concurrent builder
  // judge it stale and steal it. So the scan runs FIRST, lock-free (it reads sources, not the map),
  // and the lock covers only load → merge → save. The whole cycle still holds the lock end-to-end,
  // so two builders can never load the same base map and clobber each other's merge.
  const willRescan = opts.mode === 'static_only' || opts.mode === 'full' || opts.forceRescan === true || !existsSync(appMapPath(root));
  const bundle = willRescan ? runStaticScan(root, opts.at) : null;
  return withAppMapLock(root, () => buildAppMapLocked(root, opts, bundle));
}

function runStaticScan(root: string, at: string): StaticScanBundle {
  buildHooks.onStaticScan?.(root);
  return computeStaticScan(root, at);
}

function buildAppMapLocked(root: string, opts: BuildOptions, prescanned: StaticScanBundle | null): BuildResult {
  const fw = detectFramework(root);
  const fallbackProject = projectIdentity(root, fw, null);
  const loaded = loadAppMap(root, fallbackProject, opts.at);
  const map: AppKnowledgeMap = loaded.map ?? emptyAppMap(fallbackProject, opts.at);
  // refresh project identity (framework can change as the repo evolves)
  map.project = { ...map.project, ...projectIdentity(root, fw, map.project.packageName) };

  let codeIndex: CodeIndex | null = null;
  const doRescan = opts.mode === 'static_only' || opts.mode === 'full' || !loaded.existed || opts.forceRescan === true;
  let rescanned = false;
  if (doRescan) {
    // Normally pre-scanned outside the lock; only if the map vanished between the pre-check and
    // acquisition (rare) do we scan here, inside the lock.
    codeIndex = applyStaticScan(map, prescanned ?? runStaticScan(root, opts.at), opts.at);
    rescanned = true;
  }

  let mergeResult: MergeResult | undefined;
  if ((opts.mode === 'runtime_merge' || opts.mode === 'full') && opts.exploreGraph) {
    mergeResult = mergeRuntimeGraph(map, opts.exploreGraph, { sessionId: opts.sessionId, at: opts.at });
    addProvenance(
      map,
      makeProvenance(
        'runtime',
        opts.at,
        `Runtime merge: +${mergeResult.newRuntimeScreens} new, ~${mergeResult.updatedRuntimeScreens} updated, ${mergeResult.linkedScreens} linked`,
        { targetType: 'map', refs: opts.sessionId ? [opts.sessionId] : [] },
      ),
    );
  }

  let firstRunApply: FirstRunApplyResult | undefined;
  if (opts.firstRunPatches?.length) {
    firstRunApply = applyFirstRunPatches(map, opts.firstRunPatches, opts.at);
    addProvenance(
      map,
      makeProvenance(
        'runtime',
        opts.at,
        `First-run merge: ${firstRunApply.newScreens} new, ${firstRunApply.updatedScreens} updated runtime screen(s)`,
        { targetType: 'map', refs: opts.sessionId ? [opts.sessionId] : [] },
      ),
    );
  }

  if (opts.appIdentityHints) {
    map.appIdentity.androidPackage = opts.appIdentityHints.androidPackage ?? map.appIdentity.androidPackage;
    map.appIdentity.iosBundleId = opts.appIdentityHints.iosBundleId ?? map.appIdentity.iosBundleId;
    map.appIdentity.artifactHash = opts.appIdentityHints.artifactHash ?? map.appIdentity.artifactHash;
    map.appIdentity.environment = opts.appIdentityHints.environment ?? map.appIdentity.environment;
  }

  recomputeCoverage(map);
  recomputeConfidence(map);
  // Derived issue summaries from the durable issue ledger. Best-effort — the issue
  // ledger is an additive context layer and must never break an app-map build.
  try {
    applyIssueSummariesToAppMap(map, root, opts.at);
  } catch {
    /* best-effort */
  }
  map.updatedAt = opts.at;
  if (!map.generatedAt) map.generatedAt = opts.at;

  let save: SaveResult | undefined;
  if (opts.persist !== false) {
    save = saveAppMap(root, map);
    if (opts.includeCodeIndex !== false) saveIndexes(root, codeIndex, map.features);
    // Fix 8: durably remember this project so its app-map resource URI resolves across restarts.
    rememberProject(root, { packageName: map.project.packageName, framework: map.project.framework, at: opts.at });
  }

  return { map, codeIndex, mergeResult, firstRunApply, migration: loaded.migration, save, rescanned };
}

/** Read just the coverage counts from an existing map (zeros if none) — for computing a delta. */
export function quickCoverage(root: string, at: string): { overallPercent: number; runtimeScreens: number; staticScreens: number } {
  const fw = detectFramework(root);
  const loaded = loadAppMap(root, projectIdentity(root, fw, null), at);
  const c = loaded.map?.coverage;
  return { overallPercent: c?.overallPercent ?? 0, runtimeScreens: c?.runtimeScreens ?? 0, staticScreens: c?.staticScreens ?? 0 };
}

/** Compact, context-friendly summary of a map for tool text + structured results. */
export function summarizeMap(map: AppKnowledgeMap): Record<string, unknown> {
  const gaps: string[] = [];
  if (map.runtimeTopology.unvisitedStaticScreens.length)
    gaps.push(`${map.runtimeTopology.unvisitedStaticScreens.length} static screen(s) never visited at runtime`);
  const uncovered = map.features.filter((f) => f.testCoverage === 'none');
  if (uncovered.length)
    gaps.push(
      `${uncovered.length} feature(s) with no coverage: ${uncovered
        .slice(0, 4)
        .map((f) => f.title)
        .join(', ')}`,
    );
  const hypotheses = map.features.filter((f) => f.status === 'hypothesis');
  if (hypotheses.length) gaps.push(`${hypotheses.length} low-confidence feature hypothesis(es)`);
  return {
    framework: map.project.framework,
    router: map.staticTopology.router,
    appIdentity: map.appIdentity,
    staticScreens: map.staticTopology.screens.length,
    runtimeScreens: map.runtimeTopology.screens.length,
    features: map.features.map((f) => ({
      id: f.id,
      title: f.title,
      status: f.status,
      testCoverage: f.testCoverage,
      confidence: f.confidence,
    })),
    coverage: map.coverage,
    confidence: map.confidence.overall,
    topGaps: gaps.slice(0, 6),
    parserNotes: map.staticTopology.parserNotes.slice(0, 4),
  };
}
