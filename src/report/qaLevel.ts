// QA level (Developer-3 plan Deliverable 6 / roadmap §3.11) — the single, deterministic, product-facing
// QA verdict label every Swipium run earns. This is DISTINCT from the automation `ReadinessLabel`
// (which scores the *generated suite*): the QA level answers "how far did QA actually get on this app?"
// — the rung a developer, QA engineer, reviewer, and CI all read straight off the report.
//
// Pure + deterministic so it is unit-testable and stable across runs. It NEVER claims a level whose
// evidence was not observed (Hard Product Rule: "always report what was attempted; never over-claim").
// Public v1 levels:
//   observed -> smoke_tested -> automation_candidate -> automation_runnable -> ci_ready

export type QaLevel =
  | 'observed'
  | 'smoke_tested'
  | 'automation_candidate'
  | 'automation_runnable'
  | 'ci_ready';

export const QA_LEVELS: readonly QaLevel[] = [
  'observed',
  'smoke_tested',
  'automation_candidate',
  'automation_runnable',
  'ci_ready',
];

export const QA_LEVEL_MEANING: Record<QaLevel, string> = {
  observed: 'Swipium launched the app and captured evidence.',
  smoke_tested: 'Launch + health guardrails passed (no native crash or fatal app-error surface).',
  automation_candidate: 'A POM automation suite was generated from recorded actions.',
  automation_runnable: 'The generated suite compiled and dry-run validated.',
  ci_ready: 'The suite replayed from a declared state profile — safe to gate CI on.',
};

export interface QaLevelSignals {
  /** Any evidence captured (artifacts, notes, findings, recorded actions, exploration). */
  observed: boolean;
  /** Launch reached and no blocking health error / high-severity finding, with real activity recorded. */
  smokePassed: boolean;
  /** POM suite generated (automation readiness label `generated`). */
  suiteGenerated: boolean;
  /** Suite compiled / dry-run valid (automation readiness label `compiled`). */
  suiteRunnable: boolean;
  /** Suite replayed from a declared state profile (automation readiness label `ci_ready`). */
  ciReplayed: boolean;
}

export interface QaLevelAssessment {
  /**
   * Highest level (in ladder order) whose evidence — and prerequisites — were met. `not_observed`
   * when no evidence was captured at all (the app may not have launched), so the model never
   * over-claims `observed`.
   */
  level: QaLevel | 'not_observed';
  /** Every level whose evidence + prerequisites held, in ladder order. */
  achieved: QaLevel[];
  /** The next rung ABOVE the reported level, or null when at the top. */
  next: QaLevel | null;
  /** What it would take to reach `next`. */
  nextRequirement: string | null;
  /** Lower rungs skipped beneath the reported level. */
  skipped: QaLevel[];
  /** Human-readable explanation of the reported level. */
  rationale: string;
  /** Honest caveats — e.g. a higher marker reached without a CI suite below it. */
  notes: string[];
}

// Prerequisites encode the honest public-v1 progression.
const PREREQ: Record<QaLevel, QaLevel[]> = {
  observed: [],
  smoke_tested: ['observed'],
  automation_candidate: ['smoke_tested'],
  automation_runnable: ['automation_candidate'],
  ci_ready: ['automation_runnable'],
};

function signalFor(level: QaLevel, s: QaLevelSignals): boolean {
  switch (level) {
    case 'observed':
      return s.observed;
    case 'smoke_tested':
      return s.smokePassed;
    case 'automation_candidate':
      return s.suiteGenerated;
    case 'automation_runnable':
      return s.suiteRunnable;
    case 'ci_ready':
      return s.ciReplayed;
  }
}

export function qaLevelRequirement(level: QaLevel): string {
  switch (level) {
    case 'observed':
      return 'Launch the app and capture evidence.';
    case 'smoke_tested':
      return 'Pass launch + health guardrails (no crash, no fatal error surface, no high-severity finding).';
    case 'automation_candidate':
      return 'Record actions (qa_act / qa_smoke / qa_explore) so a POM suite can be generated.';
    case 'automation_runnable':
      return 'Compile and dry-run the generated suite (qa_suite_compile).';
    case 'ci_ready':
      return 'Replay the suite from a declared state profile.';
  }
}

/**
 * Derive the single QA level for a run from its observable signals. Deterministic and honest:
 * a level is only `achieved` when its own evidence AND all its prerequisites are present.
 */
export function deriveQaLevel(signals: QaLevelSignals): QaLevelAssessment {
  const met = new Set<QaLevel>();
  for (const level of QA_LEVELS) {
    if (PREREQ[level].every((p) => met.has(p)) && signalFor(level, signals)) met.add(level);
  }
  const achieved = QA_LEVELS.filter((l) => met.has(l));
  // Honest floor: with zero evidence we report `not_observed`, never a fabricated `observed`.
  const level: QaLevel | 'not_observed' = achieved.length ? achieved[achieved.length - 1] : 'not_observed';
  const reportedIndex = achieved.length ? QA_LEVELS.indexOf(achieved[achieved.length - 1]) : -1;

  // `next` is the next rung above the reported level, not an earlier gap.
  const next = QA_LEVELS.find((l, i) => i > reportedIndex && !met.has(l)) ?? null;
  const nextRequirement = next ? qaLevelRequirement(next) : null;
  // Lower rungs that were skipped beneath the reported level (surfaced separately, never hidden).
  const skipped = QA_LEVELS.filter((l, i) => i < reportedIndex && !met.has(l));

  const notes: string[] = [];
  if (!signals.observed) notes.push('No evidence captured yet — the app may not have launched.');
  if (signals.suiteGenerated && !signals.suiteRunnable) {
    notes.push('A suite was generated but has not compiled/dry-run — it is a candidate, not runnable.');
  }
  if (signals.suiteRunnable && !signals.ciReplayed) {
    notes.push('Suite is runnable but has not replayed from a declared state — not yet CI-ready.');
  }
  if (signals.observed && !signals.smokePassed) {
    notes.push('Launch/health was not confirmed passing — smoke level not reached.');
  }

  const rationale =
    level === 'not_observed'
      ? 'No QA level reached yet — no evidence was captured (the app may not have launched).'
      : `Reached ${level}: ${QA_LEVEL_MEANING[level]}`;
  return { level, achieved, next, nextRequirement, skipped, rationale, notes };
}
