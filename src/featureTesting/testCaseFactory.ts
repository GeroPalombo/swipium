// Feature-focused test case generation (SWIPIUM-REQ-03 "Test Case Generation Requirements"). PURE.
// Turns a FeatureScope + FeatureObjective into industry-style test cases (TestRail-aligned: each case
// connects preconditions, inputs, steps, and expected results to the documented objective). Cases are
// linked to featureId + map screens + evidence, carry a creativity level, and start with empty actual
// results (filled after a run by resultMerge).

import type { FeatureScope } from './featureScope.js';
import type { FeatureObjective } from './objectiveModel.js';

export type CreativityLevel = 'conservative' | 'standard' | 'creative' | 'adversarial';
export type CaseStatus = 'not_run' | 'pass' | 'fail' | 'blocked' | 'skipped';

export interface FeatureTestCase {
  id: string;
  featureId: string;
  title: string;
  purpose: string;
  creativity: CreativityLevel;
  riskLevel: 'low' | 'medium' | 'high';
  preconditions: string[];
  fixtures: string[];
  steps: string[];
  expected: string[];
  /** Filled after execution by resultMerge — never conflated with `expected`. */
  actualResult: string[];
  status: CaseStatus;
  evidence: string[];
  automation: { status: 'automated' | 'partial' | 'manual' | 'none'; flow?: string; pageObjects: string[] };
  /** Map links: static screen file refs + runtime node ids the case touches. */
  mapLinks: { staticScreens: string[]; runtimeScreens: string[] };
  requiresConsent: boolean;
}

const CREATIVITY_RANK: Record<CreativityLevel, number> = { conservative: 0, standard: 1, creative: 2, adversarial: 3 };

export interface GenerateCasesOptions {
  creativity?: CreativityLevel;
  platform?: string;
  /** Allow adversarial/destructive cases (requires explicit consent + disposable state). Default false. */
  allowAdversarial?: boolean;
}

export function generateFeatureTestCases(scope: FeatureScope, objective: FeatureObjective, opts: GenerateCasesOptions = {}): FeatureTestCase[] {
  const level = opts.creativity ?? 'standard';
  const maxRank = CREATIVITY_RANK[level];
  const platform = opts.platform ?? 'android+ios';
  const cases: FeatureTestCase[] = [];

  const fixtures = scope.dataDependencies.filter((d) => d.kind === 'fixture').map((d) => d.name);
  const staticScreenLinks = scope.staticScreens.map((s) => s.file ?? s.name).filter(Boolean) as string[];
  const runtimeScreenLinks = scope.runtimeScreens.map((s) => s.id ?? s.name).filter(Boolean) as string[];
  const baseRisk = scope.risks.reduce<'low' | 'medium' | 'high'>((acc, r) => (rank(r.level) > rank(acc) ? r.level : acc), 'low');
  const mapLinks = { staticScreens: staticScreenLinks, runtimeScreens: runtimeScreenLinks };
  const idFor = (n: number) => `TC-${scope.featureId.replace(/^feat-/, '').toUpperCase().slice(0, 12)}-${String(n).padStart(3, '0')}`;

  const mk = (over: Partial<FeatureTestCase> & { title: string; creativity: CreativityLevel; steps: string[]; expected: string[] }): FeatureTestCase => ({
    id: idFor(cases.length + 1),
    featureId: scope.featureId,
    purpose: over.purpose ?? `Verify the ${scope.title} feature behaves as expected.`,
    riskLevel: over.riskLevel ?? baseRisk,
    preconditions: over.preconditions ?? ['app installed and launched'],
    fixtures: over.fixtures ?? fixtures,
    actualResult: [],
    status: 'not_run',
    evidence: [],
    automation: over.automation ?? { status: 'none', pageObjects: [] },
    mapLinks,
    requiresConsent: over.requiresConsent ?? false,
    ...over,
  });

  // ---- conservative: the core happy path only ----
  cases.push(
    mk({
      title: `${scope.title} — happy path`,
      creativity: 'conservative',
      purpose: objective.userGoal,
      preconditions: ['app installed and launched', ...(objective.externalDependencies.length ? [`available: ${objective.externalDependencies.join(', ')}`] : [])],
      steps: objective.primaryHappyPath,
      expected: objective.expectedOutputs,
    }),
  );

  // ---- standard: common validation / empty / error cases ----
  if (maxRank >= CREATIVITY_RANK.standard) {
    for (const neg of objective.negativeCases) {
      cases.push(
        mk({
          title: `${scope.title} — ${shorten(neg)}`,
          creativity: 'standard',
          purpose: `Validate a common negative/validation case for ${scope.title}.`,
          steps: [`Reach the ${scope.title} surface`, neg.split('→')[0].trim()],
          expected: [neg.includes('→') ? neg.split('→')[1].trim() : 'A clear validation/error state is shown without a crash'],
        }),
      );
    }
    if (objective.inputFields.length) {
      cases.push(
        mk({
          title: `${scope.title} — required input validation`,
          creativity: 'standard',
          purpose: 'Submitting with required inputs missing is rejected.',
          steps: [`Reach the ${scope.title} surface`, `Leave required field(s) blank: ${objective.inputFields.filter((f) => f.required).map((f) => f.name).join(', ')}`, 'Attempt to submit/continue'],
          expected: ['A validation message is shown; the action is not performed'],
        }),
      );
    }
  }

  // ---- creative: boundary, interruption, permission, offline, visual/state ----
  if (maxRank >= CREATIVITY_RANK.creative) {
    for (const edge of objective.edgeCases) {
      cases.push(
        mk({
          title: `${scope.title} — edge: ${shorten(edge)}`,
          creativity: 'creative',
          purpose: `Exercise an edge/boundary condition for ${scope.title}.`,
          steps: [`Reach the ${scope.title} surface`, edge],
          expected: ['The app handles the condition gracefully (no crash, coherent UI state)'],
        }),
      );
    }
    cases.push(
      mk({
        title: `${scope.title} — offline / interruption resilience`,
        creativity: 'creative',
        purpose: 'The feature degrades gracefully when connectivity drops or it is interrupted.',
        steps: [`Reach the ${scope.title} surface`, 'Toggle airplane mode / background and foreground the app mid-flow'],
        expected: ['No crash; the app shows an offline/retry state or resumes coherently'],
        riskLevel: 'low',
      }),
    );
  }

  // ---- adversarial: destructive/security/high-impact — consent-gated, disposable state only ----
  if (maxRank >= CREATIVITY_RANK.adversarial && opts.allowAdversarial && objective.destructiveBoundaries.length) {
    for (const boundary of objective.destructiveBoundaries) {
      cases.push(
        mk({
          title: `${scope.title} — destructive boundary`,
          creativity: 'adversarial',
          purpose: 'Probe a destructive/high-impact boundary safely.',
          riskLevel: 'high',
          requiresConsent: true,
          preconditions: ['disposable test state', 'explicit candidate-bound consent'],
          steps: [`Reach the ${scope.title} surface`, boundary],
          expected: ['Either the action is safely contained on disposable state, or it is correctly gated behind confirmation'],
        }),
      );
    }
  }

  return cases;
}

function rank(level: 'low' | 'medium' | 'high'): number {
  return level === 'high' ? 2 : level === 'medium' ? 1 : 0;
}
function shorten(s: string): string {
  const head = s.split('→')[0].trim();
  return head.length > 48 ? head.slice(0, 45) + '…' : head;
}
