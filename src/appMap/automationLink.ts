// Vision Gap Fix 7 — write a generated automation suite back into the durable app map. After
// qa_generate target:"appium" emits an Appium POM suite, the app map should KNOW automation now exists for
// these screens/features, so future feature/ticket decisions can see which flows are automated. Pure-
// ish: loads + saves `.swipium/app-map.json`, upserting an AutomationSuiteRef (by path) with the
// screen/feature ids the suite covers. Best-effort: returns ok:false rather than throwing on no map.

import { loadAppMap, saveAppMap } from './store.js';
import { addProvenance, makeProvenance, recomputeConfidence } from './provenance.js';
import { detectFramework } from './../context/detect.js';
import type { AppKnowledgeMap, AutomationSuiteRef, ProjectIdentity } from './schema.js';

function fallbackProject(root: string): ProjectIdentity {
  const fw = detectFramework(root);
  return {
    root,
    gitRemote: null,
    packageName: null,
    workspaceTarget: null,
    framework: fw,
    platforms: fw === 'native-android' ? ['android'] : fw === 'native-ios' ? ['ios'] : ['android', 'ios'],
  };
}

// Generic page/screen suffixes carry no identity — a POM "LoginPage" and a static "login" route are
// the same screen. Strip these (on both sides) so the page-name → static-screen match actually fires.
const SCREEN_NOISE = new Set(['page', 'screen', 'view', 'component', 'tab', 'modal', 'navigator', 'stack', 'drawer', 'route', 'index']);

/** Split camelCase/PascalCase/snake/kebab into lowercase identity tokens, dropping generic noise. */
function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary: LoginPage → Login Page
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMWord boundary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !SCREEN_NOISE.has(t));
}

/** Best-effort map of generated POM screen names → app-map static screen ids + their feature ids. */
export function deriveAutomationLinks(map: AppKnowledgeMap, screenNames: string[]): { screenIds: string[]; featureIds: string[] } {
  const screenIds = new Set<string>();
  for (const name of screenNames) {
    const want = new Set(tokenize(name));
    if (!want.size) continue;
    let best: { id: string; score: number } | undefined;
    for (const s of map.staticTopology.screens) {
      // Match against the static screen's name, route, AND id slug (e.g. "screen:login" / "route:login").
      const have = new Set([...tokenize(s.name), ...tokenize(s.route ?? ''), ...tokenize(s.id)]);
      let score = 0;
      for (const t of want) if (have.has(t)) score++;
      if (score > 0 && (!best || score > best.score)) best = { id: s.id, score };
    }
    if (best) screenIds.add(best.id);
  }
  const featureIds = new Set<string>();
  for (const f of map.features) {
    if (f.staticScreens.some((sid) => screenIds.has(sid))) featureIds.add(f.id);
  }
  return { screenIds: [...screenIds], featureIds: [...featureIds] };
}

export interface LinkAutomationResult {
  ok: boolean;
  appMapUri?: string;
  suite?: AutomationSuiteRef;
}

/** Upsert (by path) an automation suite record into the durable app map. */
export function linkAutomationSuite(root: string, suite: AutomationSuiteRef, now: string): LinkAutomationResult {
  const loaded = loadAppMap(root, fallbackProject(root), now);
  if (!loaded.map) return { ok: false };
  const map = loaded.map;
  // Enrich screen/feature links from the map when the caller didn't already resolve them.
  if ((!suite.linkedScreenIds || !suite.linkedScreenIds.length) && suite.linkedFeatureIds === undefined) {
    // nothing to enrich
  }
  const existing = map.automation.suites.find((s) => s.path === suite.path);
  if (existing) Object.assign(existing, suite);
  else map.automation.suites.push(suite);
  addProvenance(
    map,
    makeProvenance('test_case', now, `Automation suite ${suite.name} linked (${suite.framework ?? 'appium'})`, {
      targetType: 'test',
      refs: [suite.path],
    }),
  );
  map.updatedAt = now;
  recomputeConfidence(map);
  const save = saveAppMap(root, map);
  return { ok: true, appMapUri: save.resourceUri, suite };
}
