// Vision Gap Fix 9 — the single "suite knowledge merge" service. The vision requires the persistent
// suite (.swipium/test-suite.json) to stay current after EVERY flow that observes or creates QA
// knowledge — exploration, automation generation, and report — without depending on
// a later qa_report or a manual suite generation. Each flow funnels its cases through here so stable
// ids, dedup, provenance, and the run ledger are enforced in ONE place (store.applyMerge), and a merge
// failure is returned as a WARNING (best-effort) rather than failing an otherwise-valid QA run.

import { applyMerge, suiteDelta, suiteResourceUri, suiteJsonPath, loadSuite, type SuiteDelta } from '../testSuite/store.js';
import { loadAppMap, saveAppMap } from '../appMap/store.js';
import { detectFramework } from '../context/detect.js';
import type { ProjectIdentity, TestCaseRef } from '../appMap/schema.js';
import type { CanonicalTestCase, ProvenanceSource } from '../testSuite/schema.js';
import type { MergeMode } from '../testSuite/merge.js';
import { casesFromExploration, caseFromPom } from '../testSuite/generator.js';
import { pomForSession } from './suiteGenerate.js';
import type { AssembledSuite } from './automationGenerate.js';
import type { Session, ExplorationRecord } from '../session/store.js';
import type { AutomationFramework, LocatorReadiness, AutomationStatus } from '../testSuite/schema.js';
import { join } from 'node:path';
import { log } from '../lib/logger.js';

export interface SuiteMergeResult {
  ok: boolean;
  /** Non-fatal reason the merge was skipped or failed — surfaced as a warning, never a hard error. */
  warning?: string;
  created: string[];
  updated: string[];
  deprecated: string[];
  delta?: SuiteDelta;
  suiteUri?: string;
  written: string[];
  /** Canonical ids touched (created + updated) — used to backfill automation traces. */
  caseIds: string[];
}

const EMPTY: SuiteMergeResult = { ok: true, created: [], updated: [], deprecated: [], written: [], caseIds: [] };

function fallbackProject(root: string): ProjectIdentity {
  const fw = detectFramework(root);
  return { root, gitRemote: null, packageName: null, workspaceTarget: null, framework: fw, platforms: fw === 'native-android' ? ['android'] : fw === 'native-ios' ? ['ios'] : ['android', 'ios'] };
}

/**
 * Mirror a COMPACT index of the persistent suite into the app map's testSuite section so the durable
 * map (and qa_app_map_query / feature scoping) reflect the growing suite — the "map + suite as one
 * growing QA business context" loop the vision requires. Best-effort: no map yet ⇒ no-op.
 */
function mirrorSuiteIndexToMap(root: string, now: string): void {
  try {
    const loaded = loadAppMap(root, fallbackProject(root), now);
    if (!loaded.map) return; // no durable map yet — feature scope still reads the suite directly
    const suite = loadSuite(root);
    const refs: TestCaseRef[] = suite.cases.map((c) => ({
      id: c.id,
      title: c.title,
      featureId: c.featureId,
      status: c.actualResult.status,
      source: 'test-suite',
      lastRun: c.actualResult.lastRunAt,
      stale: c.status === 'deprecated',
    }));
    loaded.map.testSuite = { cases: refs };
    loaded.map.coverage.staleTests = refs.filter((r) => r.stale).length;
    loaded.map.updatedAt = now;
    saveAppMap(root, loaded.map);
  } catch {
    /* best-effort: a mirror failure never fails the suite merge */
  }
}

export interface MergeContext {
  source: ProvenanceSource;
  now: string;
  runId: string;
  mode?: MergeMode;
  sourceUri?: string;
  appId?: string;
  /** Session id for the suite resource URI; when omitted the file:// path is returned instead. */
  sessionId?: string;
  /** Feature ids still live in the current app map; lets the merge auto-deprecate vanished features. */
  liveFeatureIds?: string[];
}

/** Core: merge already-canonical cases into the suite. Best-effort — never throws. */
export function mergeCanonical(root: string, cases: CanonicalTestCase[], ctx: MergeContext): SuiteMergeResult {
  if (!cases.length) return EMPTY;
  try {
    const applied = applyMerge(
      root,
      cases,
      { source: ctx.source, mode: ctx.mode ?? 'update', now: ctx.now, runId: ctx.runId, sourceUri: ctx.sourceUri, liveFeatureIds: ctx.liveFeatureIds },
      ctx.appId,
    );
    const delta = suiteDelta(applied.result.suite, applied.result);
    const caseIds = [...applied.result.created, ...applied.result.updated];
    // Keep the durable app map's suite index in sync with the persistent suite (Fix #3).
    mirrorSuiteIndexToMap(root, ctx.now);
    return {
      ok: true,
      created: applied.result.created,
      updated: applied.result.updated,
      deprecated: applied.result.deprecated,
      delta,
      suiteUri: ctx.sessionId ? suiteResourceUri(ctx.sessionId) : `file://${suiteJsonPath(root)}`,
      written: applied.written,
      caseIds,
    };
  } catch (e) {
    log('warn', 'suite knowledge merge failed', { source: ctx.source, err: String(e) });
    return { ...EMPTY, ok: false, warning: `suite merge failed: ${String(e)}` };
  }
}

/** Merge exploration-derived feature coverage cases into the persistent suite. */
export function mergeFromExploration(root: string, exploration: ExplorationRecord | undefined, ctx: MergeContext): SuiteMergeResult {
  if (!exploration?.summary?.featureCoverage) return EMPTY;
  let cases: CanonicalTestCase[];
  try {
    cases = casesFromExploration({ exploration, source: 'exploration', now: ctx.now, appId: ctx.appId });
  } catch (e) {
    return { ...EMPTY, ok: false, warning: `exploration→canonical conversion failed: ${String(e)}` };
  }
  return mergeCanonical(root, cases, { ...ctx, source: 'exploration' });
}

function readinessGrade(brittlePct: number): LocatorReadiness {
  if (brittlePct <= 0) return 'A';
  if (brittlePct < 25) return 'B';
  if (brittlePct < 50) return 'C';
  return 'D';
}

export interface AutomationMergeInput {
  assembled: AssembledSuite;
  /** Whether the generated suite passed validation (clean secrets + durability). */
  validationOk: boolean;
  /** App-map feature/screen ids the suite covers (from deriveAutomationLinks) — used to ENRICH the
   *  automation metadata of existing feature cases, not only to create a new POM case (Fix #4). */
  links?: { featureIds: string[]; screenIds: string[] };
}

/**
 * Fix 7 — merge automation metadata into the persistent suite. Converts the generated POM smoke flow
 * into a canonical case carrying the real page-object/test-file paths, framework, locator readiness and
 * automation status, AND (Fix #4) upgrades the automation link of EXISTING suite cases whose app-map
 * feature/screen links overlap the generated suite — so a prior feature case is marked automated
 * instead of a parallel POM-only case silently superseding it.
 */
export function mergeFromAutomation(root: string, session: Session, input: AutomationMergeInput, ctx: MergeContext): SuiteMergeResult {
  const { assembled, links } = input;
  let cases: CanonicalTestCase[];
  try {
    const framework: AutomationFramework = assembled.profile.automationLanguage === 'python' ? 'appium_python' : 'appium_js';
    const pageObjects = assembled.files.filter((f) => /page|screen|pages\//i.test(f.path)).map((f) => join(assembled.outputDir, f.path));
    const testFiles = assembled.files.filter((f) => /test|spec|smoke|\.e2e\./i.test(f.path)).map((f) => join(assembled.outputDir, f.path));
    const status: AutomationStatus = !input.validationOk ? 'partial' : assembled.model.audit.brittle > 0 ? 'partial' : 'automated';
    const automation = { status, framework, pageObjects, testFiles, locatorReadiness: readinessGrade(assembled.model.audit.brittlePct), replayStatus: 'not_replayed' as const };

    const { pom } = pomForSession(session);
    const platforms = ([assembled.profile.platforms.android.level !== 'none' ? 'android' : null, assembled.profile.platforms.ios.level !== 'none' ? 'ios' : null].filter(Boolean) as Array<'android' | 'ios'>);
    const base = caseFromPom({ pom, appId: session.appId, source: 'generate', now: ctx.now, platforms: platforms.length ? platforms : ['android'] });
    if (!base) return EMPTY;
    // Group the POM case under the linked map feature so it doesn't fork from existing feature cases.
    if (links?.featureIds.length) {
      base.featureId = links.featureIds[0];
      base.mapLinks = [
        ...links.featureIds.map((id) => ({ kind: 'feature' as const, id })),
        ...links.screenIds.map((id) => ({ kind: 'screen' as const, id })),
        ...base.mapLinks.filter((l) => l.kind !== 'feature'),
      ];
    }
    base.automation = automation;
    cases = [base];

    // Enrich EXISTING cases linked to the same feature/screen ids (Fix #4): re-emit them with their
    // own id + upgraded automation so applyMerge updates (never duplicates) them. mergeAutomation only
    // ever raises status/readiness, so this can't regress a stronger existing link.
    if (links && (links.featureIds.length || links.screenIds.length)) {
      const feat = new Set(links.featureIds);
      const scr = new Set(links.screenIds);
      const suite = loadSuite(root, ctx.appId);
      for (const c of suite.cases) {
        if (c.status === 'deprecated' || c.id === base.id) continue;
        const overlaps = feat.has(c.featureId) || c.mapLinks.some((l) => (l.kind === 'feature' && feat.has(l.id)) || ((l.kind === 'screen' || l.kind === 'static_screen' || l.kind === 'runtime_screen') && scr.has(l.id)));
        if (!overlaps) continue;
        cases.push({ ...c, automation, provenance: [] });
      }
    }
  } catch (e) {
    return { ...EMPTY, ok: false, warning: `automation→canonical conversion failed: ${String(e)}` };
  }
  return mergeCanonical(root, cases, { ...ctx, source: 'generate' });
}
