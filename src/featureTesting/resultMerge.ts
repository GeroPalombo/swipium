// Merge a focused feature run back into cases + the durable feature map (SWIPIUM-REQ-03
// "App Map Update Requirements" + "Runtime Execution Requirements"). PURE. Given the scope, the
// generated cases, and the signals a run produced (qa_note outcomes, runtime screens visited,
// evidence, exploration terminal state), it fills each case's actual result/status/evidence and
// computes the feature's coverage delta for persistence. Honest: a feature blocked by a gate
// becomes `blocked` with guidance, never a false `fail`.

import type { FeatureScope } from './featureScope.js';
import type { FeatureTestCase, CaseStatus } from './testCaseFactory.js';
import type { FeatureCoverage, FeatureCoverageStatus } from './featureMap.js';

export interface MergeNote {
  workflow: string;
  outcome: 'pass' | 'fail' | 'blocked' | 'skipped' | 'not_applicable' | string;
  reason?: string;
  recommendedSetup?: string;
  artifactUris?: string[];
}

export interface FeatureRunSignals {
  notes: MergeNote[];
  visitedRuntimeScreens: string[]; // runtime node ids touched during the run
  evidence: string[]; // artifact URIs (screen graph, screenshots, report)
  exploration?: { state: 'completed' | 'blocked' | 'needs_input'; stoppedReason?: string; screensVisited?: number };
  blocked?: boolean;
  blockReason?: string;
  blockGuidance?: string;
}

export interface FeatureMergeResult {
  cases: FeatureTestCase[];
  coverage: FeatureCoverage;
  delta: {
    statusBefore?: FeatureCoverageStatus;
    statusAfter: FeatureCoverageStatus;
    casesPassed: number;
    casesFailed: number;
    casesBlocked: number;
    newRuntimeScreens: string[];
    summary: string;
  };
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

/** Best-effort match a run note to a generated case by title/workflow token overlap. */
function matchNote(testCase: FeatureTestCase, notes: MergeNote[]): MergeNote | undefined {
  const ct = tokens(testCase.title);
  let best: { note: MergeNote; overlap: number } | undefined;
  for (const n of notes) {
    const nt = tokens(n.workflow);
    let overlap = 0;
    for (const t of nt) if (ct.has(t)) overlap++;
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { note: n, overlap };
  }
  return best?.note;
}

function noteToStatus(outcome: string): CaseStatus {
  switch (outcome) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'fail';
    case 'blocked':
      return 'blocked';
    case 'skipped':
    case 'not_applicable':
      return 'skipped';
    default:
      return 'not_run';
  }
}

export function mergeFeatureRun(
  scope: FeatureScope,
  cases: FeatureTestCase[],
  signals: FeatureRunSignals,
  prior?: FeatureCoverage,
): FeatureMergeResult {
  const globallyBlocked = !!signals.blocked || signals.exploration?.state === 'blocked';
  const mergedCases: FeatureTestCase[] = cases.map((c) => {
    const note = matchNote(c, signals.notes);
    let status: CaseStatus = c.status;
    const actualResult: string[] = [...c.actualResult];
    const evidence = [...c.evidence];
    if (note) {
      status = noteToStatus(note.outcome);
      actualResult.push(`${note.outcome}${note.reason ? ` — ${note.reason}` : ''}`);
      if (note.artifactUris) evidence.push(...note.artifactUris);
    } else if (globallyBlocked && status === 'not_run') {
      // Honest: the run was blocked before reaching this case — blocked, not failed.
      status = 'blocked';
      actualResult.push(
        `blocked — ${signals.blockReason ?? signals.exploration?.stoppedReason ?? 'feature run was blocked before this case'}`,
      );
    } else if (status === 'not_run') {
      actualResult.push('not executed in this run');
    }
    return { ...c, status, actualResult, evidence: [...new Set(evidence)] };
  });

  const casesPassed = mergedCases.filter((c) => c.status === 'pass').length;
  const casesFailed = mergedCases.filter((c) => c.status === 'fail').length;
  const casesBlocked = mergedCases.filter((c) => c.status === 'blocked').length;
  const casesRun = mergedCases.filter((c) => c.status === 'pass' || c.status === 'fail').length;

  let statusAfter: FeatureCoverageStatus;
  if (globallyBlocked && casesRun === 0) statusAfter = 'blocked';
  else if (casesRun === 0) statusAfter = prior?.status === 'covered' ? 'covered' : 'not_tested';
  else if (casesRun === mergedCases.length && casesFailed === 0 && casesBlocked === 0) statusAfter = 'covered';
  else statusAfter = 'partial';

  const newRuntimeScreens = signals.visitedRuntimeScreens.filter((id) => !(prior?.runtimeScreens ?? []).includes(id));
  const runtimeScreens = [
    ...new Set([
      ...(prior?.runtimeScreens ?? []),
      ...(scope.runtimeScreens.map((s) => s.id ?? s.name).filter(Boolean) as string[]),
      ...signals.visitedRuntimeScreens,
    ]),
  ];
  const staticScreens = [
    ...new Set([...(prior?.staticScreens ?? []), ...(scope.staticScreens.map((s) => s.file ?? s.name).filter(Boolean) as string[])]),
  ];

  const blockers: string[] = [];
  if (globallyBlocked)
    blockers.push(signals.blockGuidance ?? signals.blockReason ?? signals.exploration?.stoppedReason ?? 'feature run blocked');
  for (const n of signals.notes)
    if (n.outcome === 'blocked')
      blockers.push(`${n.workflow}: ${n.reason ?? 'blocked'}${n.recommendedSetup ? ` — ${n.recommendedSetup}` : ''}`);

  const coverage: FeatureCoverage = {
    featureId: scope.featureId,
    title: scope.title,
    query: scope.query,
    status: statusAfter,
    runtimeScreens,
    staticScreens,
    linkConfidence: Math.max(scope.confidence, prior?.linkConfidence ?? 0),
    cases: mergedCases.map((c) => ({ id: c.id, title: c.title, status: c.status, creativity: c.creativity })),
    blockers: [...new Set([...(prior?.blockers ?? []), ...blockers])].slice(0, 20),
    coverageGaps: scope.coverageGaps.map((g) => `${g.area}: ${g.reason}`),
    automationReadiness: prior?.automationReadiness ?? 'partial',
    evidence: [...new Set([...(prior?.evidence ?? []), ...signals.evidence])].slice(0, 40),
  };

  const summary = globallyBlocked
    ? `🚧 ${scope.title} blocked: ${signals.blockReason ?? signals.exploration?.stoppedReason ?? 'gate encountered'} (${casesBlocked} case(s) blocked).`
    : `${statusAfter === 'covered' ? '✅' : '◐'} ${scope.title}: ${casesPassed} passed, ${casesFailed} failed, ${casesBlocked} blocked; ${newRuntimeScreens.length} new runtime screen(s).`;

  return {
    cases: mergedCases,
    coverage,
    delta: { statusBefore: prior?.status, statusAfter, casesPassed, casesFailed, casesBlocked, newRuntimeScreens, summary },
  };
}
