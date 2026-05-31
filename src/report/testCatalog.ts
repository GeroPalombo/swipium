// Universal run test catalog (Developer-3 plan Deliverable 4 / review item #6). The POM test-case
// catalog only exists when a suite is generated; this builds a catalog for EVERY run — executed,
// skipped, blocked, and exploration-promoted workflows — straight from the session's observed state
// (smoke notes, findings, exploration summary, suite status). Pure + deterministic so blocked and
// no-suite runs are documented as thoroughly as a green suite run, and skipped/blocked entries are
// as visible as passing ones.

export type RunCatalogStatus = 'pass' | 'fail' | 'blocked' | 'skipped' | 'not_applicable' | 'observed';

export interface RunTestCatalogEntry {
  id: string;
  objective: string;
  status: RunCatalogStatus;
  preconditions: string[];
  steps: string[];
  expectedResult: string;
  actualResult: string;
  evidence: string[];
  blockers: string[];
  cleanup: string[];
  automationReadiness: 'automated' | 'partial' | 'manual' | 'none';
  replayStatus: string;
  source: 'smoke' | 'note' | 'exploration' | 'baseline';
}

export interface RunCatalogNote {
  workflow: string;
  outcome: RunCatalogStatus | string;
  category?: string;
  reason?: string;
  missingPrecondition?: string;
  recommendedSetup?: string;
  artifactUris?: string[];
  method?: string;
  verifiedVisually?: boolean;
}

export interface RunCatalogExploration {
  screensVisited: number;
  workflowsFound: number;
  visualOnlyScreens: number;
  unsafeActionsSkipped: number;
  appErrors: number;
  blockers: string[];
}

export interface RunTestCatalogInput {
  notes: RunCatalogNote[];
  findings: Array<{ kind: string; severity: string; detail: string }>;
  exploration?: RunCatalogExploration | null;
  fixtures?: string[];
  suiteGenerated: boolean;
  suiteReplayStatus?: string;
  observed: boolean;
}

const KNOWN_STATUSES: RunCatalogStatus[] = ['pass', 'fail', 'blocked', 'skipped', 'not_applicable', 'observed'];
function asStatus(outcome: string): RunCatalogStatus {
  return (KNOWN_STATUSES as string[]).includes(outcome) ? (outcome as RunCatalogStatus) : 'observed';
}

export interface RunTestCatalog {
  entries: RunTestCatalogEntry[];
  counts: Record<RunCatalogStatus, number>;
  total: number;
}

export function buildRunTestCatalog(input: RunTestCatalogInput): RunTestCatalog {
  const entries: RunTestCatalogEntry[] = [];
  const automation: RunTestCatalogEntry['automationReadiness'] = input.suiteGenerated ? 'partial' : 'manual';
  const replayStatus = input.suiteReplayStatus ?? 'not_replayed';
  const preconditions = ['app installed', ...(input.fixtures ?? [])];

  // 1. One entry per recorded workflow outcome — pass/fail/blocked/skipped all equally visible.
  input.notes.forEach((n, i) => {
    const status = asStatus(n.outcome);
    const blockers: string[] = [];
    if (status === 'blocked' || status === 'fail') {
      if (n.missingPrecondition) blockers.push(`missing precondition: ${n.missingPrecondition}`);
      if (n.reason) blockers.push(n.reason);
      if (n.recommendedSetup) blockers.push(`recommended setup: ${n.recommendedSetup}`);
      if (!blockers.length) blockers.push(`${status} with no recorded reason`);
    }
    entries.push({
      id: `RTC-${String(i + 1).padStart(3, '0')}`,
      objective: `Verify the "${n.workflow}" workflow.`,
      status,
      preconditions,
      steps: [`Exercise the ${n.workflow} workflow`],
      expectedResult: 'Workflow completes without an error surface.',
      actualResult: `${n.workflow}: ${n.outcome}${n.reason ? ` — ${n.reason}` : ''}${n.verifiedVisually || n.method === 'visual' ? ' (visual-only evidence — weaker than a structured assertion)' : ''}`,
      evidence: n.artifactUris ?? [],
      blockers,
      cleanup: ['return to home/initial screen'],
      automationReadiness: automation,
      replayStatus,
      source: 'note',
    });
  });

  // 2. Guided exploration coverage as a first-class catalog entry (promoted/visited workflows).
  if (input.exploration) {
    const e = input.exploration;
    entries.push({
      id: `RTC-${String(entries.length + 1).padStart(3, '0')}`,
      objective: 'Guided exploration coverage of reachable screens and workflows.',
      status: e.appErrors > 0 ? 'fail' : e.screensVisited > 0 ? 'pass' : 'observed',
      preconditions,
      steps: [`Explore reachable screens safely (${e.screensVisited} visited, ${e.workflowsFound} transitions)`],
      expectedResult: 'Reachable workflows explored without unsafe actions or error surfaces.',
      actualResult: `${e.screensVisited} screens, ${e.workflowsFound} transitions, ${e.visualOnlyScreens} visual-only, ${e.unsafeActionsSkipped} unsafe skipped, ${e.appErrors} app errors`,
      evidence: [],
      blockers: e.blockers ?? [],
      cleanup: [],
      automationReadiness: input.suiteGenerated ? 'partial' : 'none',
      replayStatus,
      source: 'exploration',
    });
  }

  // 3. Baseline launch entry when nothing else describes the run, so an "empty" run is still honest.
  if (!entries.length) {
    const findingBlockers = input.findings.filter((f) => f.severity === 'high').map((f) => `${f.kind}: ${f.detail}`);
    entries.push({
      id: 'RTC-001',
      objective: 'Launch the app and capture baseline evidence.',
      status: input.observed ? (findingBlockers.length ? 'fail' : 'observed') : 'not_applicable',
      preconditions,
      steps: ['Launch the app'],
      expectedResult: 'App launches and is foregrounded without a crash or fatal error surface.',
      actualResult: input.observed
        ? findingBlockers.length
          ? 'App launched but a high-severity issue was observed.'
          : 'App launched and baseline evidence was captured (no discrete workflow recorded).'
        : 'No launch evidence captured.',
      evidence: [],
      blockers: findingBlockers,
      cleanup: [],
      automationReadiness: 'none',
      replayStatus: 'not_replayed',
      source: 'baseline',
    });
  }

  const counts = Object.fromEntries(KNOWN_STATUSES.map((s) => [s, 0])) as Record<RunCatalogStatus, number>;
  for (const entry of entries) counts[entry.status]++;
  return { entries, counts, total: entries.length };
}
