// Map diff (SWIPIUM-REQ-01 qa_app_map_diff). Reports added/removed/changed screens, feature
// coverage changes, stale test cases, locator-readiness changes, and new untested code areas
// between two AppKnowledgeMap snapshots. Pure — the tool layer resolves which two maps to compare.

import type { AppKnowledgeMap, TestCoverage } from './schema.js';

export interface ScreenChange {
  id: string;
  field: string;
  was: unknown;
  now: unknown;
}

export interface CoverageChange {
  featureId: string;
  was: TestCoverage;
  now: TestCoverage;
}

export interface AppMapDiff {
  staticScreens: { added: string[]; removed: string[] };
  runtimeScreens: { added: string[]; removed: string[] };
  changedScreens: ScreenChange[];
  featureCoverageChanges: CoverageChange[];
  locatorReadinessChanges: Array<{ id: string; was: string; now: string }>;
  staleTests: string[]; // test case ids referencing screens/features no longer present
  newUntestedCodeAreas: string[]; // newly-added static screens not yet reached at runtime
  summary: string;
}

function ids<T extends { id: string }>(arr: T[]): Set<string> {
  return new Set(arr.map((a) => a.id));
}

export function diffAppMaps(baseline: AppKnowledgeMap, current: AppKnowledgeMap): AppMapDiff {
  const baseStatic = ids(baseline.staticTopology.screens);
  const curStatic = ids(current.staticTopology.screens);
  const baseRuntime = ids(baseline.runtimeTopology.screens);
  const curRuntime = ids(current.runtimeTopology.screens);

  const staticAdded = [...curStatic].filter((id) => !baseStatic.has(id));
  const staticRemoved = [...baseStatic].filter((id) => !curStatic.has(id));
  const runtimeAdded = [...curRuntime].filter((id) => !baseRuntime.has(id));
  const runtimeRemoved = [...baseRuntime].filter((id) => !curRuntime.has(id));

  // changed runtime screens: visits / link / readiness drift
  const changedScreens: ScreenChange[] = [];
  const locatorReadinessChanges: AppMapDiff['locatorReadinessChanges'] = [];
  for (const cur of current.runtimeTopology.screens) {
    const prev = baseline.runtimeTopology.screens.find((s) => s.id === cur.id || s.signature === cur.signature);
    if (!prev) continue;
    if (prev.linkedStaticScreenId !== cur.linkedStaticScreenId) {
      changedScreens.push({ id: cur.id, field: 'linkedStaticScreenId', was: prev.linkedStaticScreenId ?? null, now: cur.linkedStaticScreenId ?? null });
    }
    if (prev.locatorReadiness !== cur.locatorReadiness) {
      locatorReadinessChanges.push({ id: cur.id, was: prev.locatorReadiness, now: cur.locatorReadiness });
    }
  }

  // feature coverage changes
  const featureCoverageChanges: CoverageChange[] = [];
  for (const cur of current.features) {
    const prev = baseline.features.find((f) => f.id === cur.id);
    if (prev && prev.testCoverage !== cur.testCoverage) {
      featureCoverageChanges.push({ featureId: cur.id, was: prev.testCoverage, now: cur.testCoverage });
    }
  }

  // stale tests: cases whose feature/screen no longer exists in current
  const curFeatureIds = ids(current.features);
  const staleTests = current.testSuite.cases
    .filter((c) => (c.featureId && !curFeatureIds.has(c.featureId)) || (c.screenId && !curStatic.has(c.screenId) && !curRuntime.has(c.screenId)) || c.stale)
    .map((c) => c.id);

  // new untested code areas: newly added static screens with no linked runtime screen
  const linkedStatic = new Set(current.runtimeTopology.screens.map((r) => r.linkedStaticScreenId).filter(Boolean) as string[]);
  const newUntestedCodeAreas = staticAdded.filter((id) => !linkedStatic.has(id));

  const summary =
    `+${staticAdded.length}/-${staticRemoved.length} static screens, +${runtimeAdded.length}/-${runtimeRemoved.length} runtime screens; ` +
    `${featureCoverageChanges.length} coverage change(s), ${locatorReadinessChanges.length} locator-readiness change(s), ` +
    `${staleTests.length} stale test(s), ${newUntestedCodeAreas.length} new untested area(s)`;

  return {
    staticScreens: { added: staticAdded, removed: staticRemoved },
    runtimeScreens: { added: runtimeAdded, removed: runtimeRemoved },
    changedScreens,
    featureCoverageChanges,
    locatorReadinessChanges,
    staleTests,
    newUntestedCodeAreas,
    summary,
  };
}
