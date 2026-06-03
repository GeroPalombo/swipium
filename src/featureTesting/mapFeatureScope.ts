// Vision Gap Fix 3 — app-map-FIRST feature scoping. The product principle is "read the durable app
// map before deciding what to do". qa_feature_scope / qa_feature_test_plan / qa_test_feature must scope
// from `.swipium/app-map.json` (features, static + runtime topology, tickets, persistent suite) BEFORE
// falling back to a fresh code scan. This shared service builds an app-map-enriched FeatureScopeInput
// and reuses the deterministic ranker in featureScope.ts, then reconciles the result back to a known
// map feature id so scope ids stay compatible with qa_app_map_feature_scope.

import { buildFeatureIndex, tokenize, classifySymbol, type FeatureIndex, type SourceSymbol, type RouteRef, type SourceFileEntry } from '../appMap/featureIndex.js';
import { buildFeatureScope, type FeatureScopeInput, type FeatureScopeResult, type RuntimeScreenInput, type TestCaseRef } from './featureScope.js';
import { loadAppMap } from '../appMap/store.js';
import { appMapResourceUri } from '../appMap/store.js';
import { loadSuite } from '../testSuite/store.js';
import { detectFramework } from '../context/detect.js';
import type { AppKnowledgeMap, ProjectIdentity } from '../appMap/schema.js';

export interface MapFeatureScopeInput {
  root: string;
  query: string;
  /** App map (already loaded) — when omitted it is loaded from `.swipium/app-map.json`. */
  map?: AppKnowledgeMap | null;
  /** A fresh/saved code index FeatureIndex; when omitted a fresh scan is run. */
  index?: FeatureIndex;
  /** Runtime screens from an active session graph; when omitted historical map screens are used. */
  runtimeScreens?: RuntimeScreenInput[];
  /** Existing tests already gathered from disk (flows/testcases). Suite + map cases are added on top. */
  existingTests?: TestCaseRef[];
  platform?: string;
  limit?: number;
}

export interface MapFeatureScopeResult extends FeatureScopeResult {
  appMapUri: string;
  /** The matched durable app-map feature id, when the scope reconciles to one. */
  mapFeatureId?: string;
  /** Ticket ids whose trace references this scope. */
  ticketRefs: string[];
  /** Where the runtime evidence came from. */
  runtimeSource: 'session' | 'app_map' | 'none';
}

function fallbackProject(root: string): ProjectIdentity {
  const fw = detectFramework(root);
  return { root, gitRemote: null, packageName: null, workspaceTarget: null, framework: fw, platforms: fw === 'native-android' ? ['android'] : fw === 'native-ios' ? ['ios'] : ['android', 'ios'] };
}

/** Synthesize index entries from the durable map so a feature that exists ONLY in the app map is found. */
function indexFromMap(map: AppKnowledgeMap, base: FeatureIndex): FeatureIndex {
  const symbols: SourceSymbol[] = [...base.symbols];
  const routes: RouteRef[] = [...base.routes];
  const files: SourceFileEntry[] = [...base.files];
  const seenSym = new Set(symbols.map((s) => `${s.name}:${s.file}`));

  // Map features → synthetic "screen" symbols carrying the feature's title/objective tokens, so the
  // ranker locates a feature even when no source symbol survives a code rename/deletion.
  for (const f of map.features) {
    const name = f.title.replace(/[^A-Za-z0-9]+/g, '') || f.id;
    const file = f.sourceFiles[0] ?? `app-map:${f.id}`;
    const key = `${name}:${file}`;
    const tokens = [...new Set([...tokenize(f.title), ...tokenize(f.objective ?? ''), ...tokenize(f.id)])];
    if (!seenSym.has(key)) {
      symbols.push({ name, kind: 'screen', file, line: 0, tokens });
      seenSym.add(key);
    }
  }
  // Static screens → synthetic routes/files so their names/routes participate in ranking.
  for (const s of map.staticTopology.screens) {
    const tokens = [...new Set([...tokenize(s.name), ...tokenize(s.route ?? '')])];
    if (s.route) routes.push({ route: s.route, file: s.sourceFiles[0] ?? `app-map:${s.id}`, line: 0, tokens });
    files.push({ file: s.sourceFiles[0] ?? `app-map:${s.id}`, base: s.name, tokens });
  }
  return { ...base, symbols, routes, files };
}

/** Historical runtime screens recorded in the durable map (used when no live session graph exists). */
function runtimeScreensFromMap(map: AppKnowledgeMap): RuntimeScreenInput[] {
  return map.runtimeTopology.screens.map((r) => ({
    id: r.id,
    title: r.title,
    route: r.route,
    text: [...(r.textTokens ?? []), ...(r.locatorIds ?? [])].join(' ').trim() || undefined,
  }));
}

/** Existing tests recorded in the durable map's suite index. */
function testsFromMap(map: AppKnowledgeMap): TestCaseRef[] {
  return map.testSuite.cases.map((c) => ({ id: c.id, title: c.title, source: c.source ?? 'app-map' }));
}

/** Cases from the canonical persistent suite (.swipium/test-suite.json) — the growing QA context the
 *  vision requires feature scoping to read, not just the app-map's mirrored index. Each case also
 *  contributes a synthetic feature symbol so a suite-only functionality is locatable. */
function testsFromSuite(root: string): { tests: TestCaseRef[]; symbols: SourceSymbol[] } {
  const tests: TestCaseRef[] = [];
  const symbols: SourceSymbol[] = [];
  try {
    const suite = loadSuite(root);
    for (const c of suite.cases) {
      if (c.status === 'deprecated') continue;
      tests.push({ id: c.id, title: c.title, source: 'suite' });
      const tokens = [...new Set([...tokenize(c.functionality), ...tokenize(c.title), ...tokenize(c.featureId), ...tokenize(c.objective ?? '')])];
      symbols.push({ name: (c.functionality || c.title).replace(/[^A-Za-z0-9]+/g, '') || c.id, kind: 'screen', file: `suite:${c.id}`, line: 0, tokens });
    }
  } catch {
    /* best-effort */
  }
  return { tests, symbols };
}

/** Pick the map feature that best overlaps the scoped result's terms — to reconcile the scope id. */
function reconcileMapFeature(map: AppKnowledgeMap, result: FeatureScopeResult): { id?: string; title?: string } {
  if (!result.found) return {};
  const scopeTerms = new Set(result.primary.matchedTerms.map((t) => t.toLowerCase()));
  let best: { id: string; title: string; score: number } | undefined;
  for (const f of map.features) {
    const ft = new Set([...tokenize(f.title), ...tokenize(f.id), ...tokenize(f.objective ?? '')]);
    let score = 0;
    for (const t of ft) if (scopeTerms.has(t)) score++;
    if (score > 0 && (!best || score > best.score)) best = { id: f.id, title: f.title, score };
  }
  return best ? { id: best.id, title: best.title } : {};
}

/** Ticket ids whose trace scopes/touches this feature (so scope carries ticketRefs). */
function ticketRefsForFeature(map: AppKnowledgeMap, featureId?: string): string[] {
  if (!featureId) return [];
  return map.tickets.tickets.filter((t) => t.scopedFeatures.includes(featureId)).map((t) => t.id);
}

/**
 * Resolve a feature scope using the durable app map as primary context, falling back to a fresh code
 * scan only to fill gaps. Returns the same FeatureScopeResult shape (so callers are unchanged) plus the
 * reconciled map feature id, ticket refs, runtime evidence source, and the app map resource uri.
 */
export function buildMapFeatureScope(input: MapFeatureScopeInput): MapFeatureScopeResult {
  const at = new Date().toISOString();
  const map = input.map ?? loadAppMap(input.root, fallbackProject(input.root), at).map;
  const appMapUri = appMapResourceUri(input.root);

  // Code index: provided, else fresh scan (still useful — but the map is layered on top as primary).
  const baseIndex: FeatureIndex = input.index ?? buildFeatureIndex(input.root);

  // The growing QA context (Fix #3): the persistent suite is durable feature knowledge too, so feed its
  // cases into scoping as existing tests + synthetic feature symbols (a suite-only feature is findable).
  const suite = testsFromSuite(input.root);

  if (!map) {
    // No durable map yet — still layer the persistent suite on top of the pure code-scan scope.
    const idx: FeatureIndex = { ...baseIndex, symbols: [...baseIndex.symbols, ...suite.symbols] };
    const res = buildFeatureScope({ query: input.query, index: idx, runtimeScreens: input.runtimeScreens, existingTests: [...(input.existingTests ?? []), ...suite.tests], platform: input.platform, limit: input.limit });
    return { ...res, appMapUri, ticketRefs: [], runtimeSource: input.runtimeScreens?.length ? 'session' : 'none' };
  }

  const baseEnriched = indexFromMap(map, baseIndex);
  const enrichedIndex: FeatureIndex = { ...baseEnriched, symbols: [...baseEnriched.symbols, ...suite.symbols] };
  // Runtime evidence: prefer the live session graph; else fall back to historical map screens.
  let runtimeScreens = input.runtimeScreens;
  let runtimeSource: MapFeatureScopeResult['runtimeSource'] = 'session';
  if (!runtimeScreens || !runtimeScreens.length) {
    runtimeScreens = runtimeScreensFromMap(map);
    runtimeSource = runtimeScreens.length ? 'app_map' : 'none';
  }
  const existingTests = [...(input.existingTests ?? []), ...testsFromMap(map), ...suite.tests];

  const scopeInput: FeatureScopeInput = { query: input.query, index: enrichedIndex, runtimeScreens, existingTests, platform: input.platform, limit: input.limit };
  const result = buildFeatureScope(scopeInput);

  // Reconcile to a known map feature so the scope id matches qa_app_map_feature_scope's id.
  const reconciled = reconcileMapFeature(map, result);
  if (reconciled.id && result.found) {
    result.primary.featureId = reconciled.id;
    if (reconciled.title) result.primary.title = reconciled.title;
  }
  const ticketRefs = ticketRefsForFeature(map, reconciled.id);

  return { ...result, appMapUri, mapFeatureId: reconciled.id, ticketRefs, runtimeSource };
}
