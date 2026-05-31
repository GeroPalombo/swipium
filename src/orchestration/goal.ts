// qa_test_this goal routing (Developer 1, roadmap §3.1 Milestone C). A `goal` adjusts ORCHESTRATION
// FLAGS and REQUIRED OUTPUTS only — it never duplicates suite/report/platform logic (those stay in
// the services Developer 2/3 own). Keeping the mapping a pure, exported helper makes goal behavior
// unit-testable without a device, and keeps `qa_test_this` an orchestrator rather than a switchboard.

export type TestGoal =
  | 'smoke'
  | 'explore'
  | 'create_automation_suite'
  | 'release_gate'
  | 'test_login'
  | 'reproduce_bug';

export const TEST_GOALS: TestGoal[] = [
  'smoke',
  'explore',
  'create_automation_suite',
  'release_gate',
  'test_login',
  'reproduce_bug',
];

/** Orchestration flags a goal resolves to. These map onto existing `qa_test_this` behavior. */
export interface GoalFlags {
  goal: TestGoal;
  /** Run guided exploration (qa_explore) after the smoke pass. */
  explore: boolean;
  /** Generate + compile a durable POM suite from the run. */
  generateSuite: boolean;
  /** Stop and ask (credentials/etc.) instead of testing pre-login. */
  stopOnNeedsInput: boolean;
  /** Require the stricter report + readiness summary (Developer 3 service). */
  releaseGate: boolean;
  /** Outputs the goal contractually requires in the terminal envelope. */
  requiredOutputs: string[];
  /** One-line human description of what this goal does. */
  description: string;
}

/** Explicit boolean overrides a caller may pass; when set, they win over the goal default. */
export interface GoalOverrides {
  explore?: boolean;
  generateSuite?: boolean;
  stopOnNeedsInput?: boolean;
}

/** Policy knobs that shape the DEFAULT (no explicit goal) behavior. */
export interface GoalPolicy {
  /** Opt out of the default "leave behind automation" behavior — just launch + smoke, fast. */
  fastSmoke?: boolean;
}

const BASE: Record<TestGoal, Omit<GoalFlags, 'goal'>> = {
  smoke: {
    explore: false,
    generateSuite: false,
    stopOnNeedsInput: false,
    releaseGate: false,
    requiredOutputs: ['reportUri', 'smoke'],
    description: 'Fastest launch + guardrail/smoke path.',
  },
  explore: {
    explore: true,
    generateSuite: false,
    stopOnNeedsInput: false,
    releaseGate: false,
    requiredOutputs: ['reportUri', 'smoke', 'exploration'],
    description: 'Smoke, then guided exploration to map reachable workflows.',
  },
  create_automation_suite: {
    explore: true,
    generateSuite: true,
    stopOnNeedsInput: false,
    releaseGate: false,
    requiredOutputs: ['reportUri', 'smoke', 'exploration', 'suite'],
    description: 'Smoke + explore, then request a POM suite from the suite service.',
  },
  release_gate: {
    explore: true,
    generateSuite: false,
    stopOnNeedsInput: false,
    releaseGate: true,
    requiredOutputs: ['reportUri', 'smoke', 'readiness'],
    description: 'Stricter report + readiness/release-gate summary required.',
  },
  test_login: {
    explore: false,
    generateSuite: false,
    stopOnNeedsInput: true,
    releaseGate: false,
    requiredOutputs: ['reportUri', 'smoke'],
    description: 'Drive the login flow; stop for credentials if no secure inputs exist.',
  },
  reproduce_bug: {
    explore: true,
    generateSuite: false,
    stopOnNeedsInput: false,
    releaseGate: false,
    requiredOutputs: ['reportUri', 'exploration'],
    description: 'Focused exploration/test plan driven by a text goal.',
  },
};

/**
 * Resolve a goal into orchestration flags. Explicit per-flag overrides win, so existing callers
 * passing `explore`/`generateSuite`/`stopOnNeedsInput` keep working unchanged.
 *
 * DEFAULT POLICY (no explicit goal): "leave behind automation when possible" — the run still does
 * a fast launch + smoke, but ALSO attempts POM suite generation afterward (the suite service skips
 * honestly when no actions were recorded). Opt out with `goal:"smoke"` (fast, explicit) or
 * `policy.fastSmoke:true`.
 */
export function resolveGoalFlags(goal: TestGoal | undefined, overrides: GoalOverrides = {}, policy: GoalPolicy = {}): GoalFlags {
  const explicit = goal !== undefined;
  const g: TestGoal = goal ?? 'smoke';
  const base = { ...BASE[g] };

  if (!explicit) {
    // Default autopilot: attempt automation. Stays fast (no forced exploration); suite generation
    // is best-effort and skips when there are no recorded actions to turn into page objects.
    base.generateSuite = true;
    base.requiredOutputs = ['reportUri', 'smoke', 'suite'];
    base.description = 'Default autopilot: fast launch + smoke, then generate a POM suite when actions exist (goal:"smoke" or fastSmoke:true to skip).';
  }
  if (policy.fastSmoke) {
    // Strongest "just smoke, fast" signal — overrides the default automation attempt.
    base.generateSuite = false;
    base.explore = false;
  }

  return {
    goal: g,
    explore: overrides.explore ?? base.explore,
    generateSuite: overrides.generateSuite ?? base.generateSuite,
    stopOnNeedsInput: overrides.stopOnNeedsInput ?? base.stopOnNeedsInput,
    releaseGate: base.releaseGate,
    requiredOutputs: base.requiredOutputs,
    description: base.description,
  };
}
