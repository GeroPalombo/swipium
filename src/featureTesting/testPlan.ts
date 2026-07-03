// Feature test plan (SWIPIUM-REQ-03, served by qa_test_feature mode:"plan"). PURE. Read-only plan
// generation: it assembles the scope, objective, generated cases, required fixtures, risks,
// automation readiness, and the EXACT ordered execution plan an agent (or qa_test_feature) would
// run. Useful before execution and for PR review.

import type { FeatureScope } from './featureScope.js';
import type { FeatureObjective } from './objectiveModel.js';
import { generateFeatureTestCases, type FeatureTestCase, type CreativityLevel } from './testCaseFactory.js';

export interface ExecutionStep {
  tool: string;
  why: string;
  args?: Record<string, unknown>;
}

export type AutomationReadiness = 'ready' | 'partial' | 'manual' | 'blocked';

export interface FeatureTestPlan {
  featureId: string;
  title: string;
  scope: FeatureScope;
  objective: FeatureObjective;
  cases: FeatureTestCase[];
  requiredFixtures: string[];
  risks: FeatureScope['risks'];
  automationReadiness: AutomationReadiness;
  executionPlan: ExecutionStep[];
  blockers: string[];
}

export interface BuildPlanOptions {
  creativity?: CreativityLevel;
  platform?: string;
  allowAdversarial?: boolean;
  sessionId?: string;
  maxScreens?: number;
  maxActions?: number;
}

export function buildFeatureTestPlan(scope: FeatureScope, objective: FeatureObjective, opts: BuildPlanOptions = {}): FeatureTestPlan {
  const cases = generateFeatureTestCases(scope, objective, {
    creativity: opts.creativity,
    platform: opts.platform,
    allowAdversarial: opts.allowAdversarial,
  });
  const requiredFixtures = [
    ...new Set([...scope.dataDependencies.filter((d) => d.kind === 'fixture').map((d) => d.name), ...cases.flatMap((c) => c.fixtures)]),
  ];

  const blockers: string[] = [];
  if (scope.recommendedStrategy === 'manual_blocked')
    blockers.push(
      'Feature involves destructive/payment/auth-gated or unlocated surfaces — needs setup/consent before automated execution.',
    );
  if (!scope.staticScreens.length && !scope.runtimeScreens.length)
    blockers.push('No static or runtime entry point located — exploration may not converge.');

  const automationReadiness: AutomationReadiness = blockers.length
    ? 'blocked'
    : scope.runtimeScreens.length && scope.existingTests.length
      ? 'ready'
      : scope.runtimeScreens.length || scope.staticScreens.length
        ? 'partial'
        : 'manual';

  const sid = opts.sessionId ?? '${sessionId}';
  const executionPlan: ExecutionStep[] = [];
  executionPlan.push({
    tool: 'qa_app_map_feature_scope',
    why: 'Resolve/refresh the feature scope against the current map',
    args: { sessionId: sid, query: scope.query },
  });
  const deepLink = scope.entryPoints.find((e) => e.kind === 'deep_link');
  const route = scope.entryPoints.find((e) => e.kind === 'route');
  if (deepLink) {
    executionPlan.push({
      tool: 'qa_app_control',
      why: `Navigate directly via the known deep link ${deepLink.value}`,
      args: { sessionId: sid, action: 'open_url', url: deepLink.value },
    });
  } else if (route) {
    executionPlan.push({
      tool: 'qa_explore',
      why: `Navigate toward route "${route.value}" using the runtime graph`,
      args: { sessionId: sid, goal: scope.title, strategy: 'hybrid', maxScreens: opts.maxScreens ?? 8 },
    });
  } else {
    executionPlan.push({
      tool: 'qa_explore',
      why: `Targeted exploration toward the ${scope.title} feature`,
      args: { sessionId: sid, goal: scope.title, strategy: 'hybrid', maxScreens: opts.maxScreens ?? 8, maxActions: opts.maxActions ?? 20 },
    });
  }
  executionPlan.push({ tool: 'qa_note', why: 'Record pass/fail/blocked per generated test case with evidence', args: { sessionId: sid } });
  executionPlan.push({ tool: 'qa_report', why: 'Summarize the focused run and update the map/test suite' });

  return {
    featureId: scope.featureId,
    title: scope.title,
    scope,
    objective,
    cases,
    requiredFixtures,
    risks: scope.risks,
    automationReadiness,
    executionPlan,
    blockers,
  };
}
