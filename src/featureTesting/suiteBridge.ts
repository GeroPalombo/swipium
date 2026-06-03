// SWIPIUM-REQ-03 / REQ-06 Fix Group 3 — bridge focused-feature cases into the durable, project-level
// test suite (.swipium/test-suite.json). Feature testing used to persist canonical facts ONLY under
// .swipium/feature-map; this converts each FeatureTestCase into a CanonicalTestCase (linked to the
// featureId + map screens + evidence) so applyMerge() can fold them into the single source of truth.

import type { FeatureTestCase } from './testCaseFactory.js';
import type { FeatureScope } from './featureScope.js';
import type { CanonicalTestCase, AppMapLink, ActualStatus, CasePlatform, AutomationStatus } from '../testSuite/schema.js';
import { normalizeCase } from '../testSuite/generator.js';

const ACTUAL_STATUS: Record<string, ActualStatus> = { not_run: 'not_run', pass: 'pass', fail: 'fail', blocked: 'blocked', skipped: 'skipped' };

export function featureCasesToCanonical(cases: FeatureTestCase[], scope: FeatureScope, now: string, platform?: 'android' | 'ios'): CanonicalTestCase[] {
  const platforms: CasePlatform[] = [platform ?? 'android'];
  return cases.map((c) => {
    const mapLinks: AppMapLink[] = [
      { kind: 'feature', id: c.featureId, label: scope.title },
      ...c.mapLinks.staticScreens.map((id) => ({ kind: 'static_screen' as const, id })),
      ...c.mapLinks.runtimeScreens.map((id) => ({ kind: 'runtime_screen' as const, id })),
    ];
    const actualStatus = ACTUAL_STATUS[c.status] ?? 'not_run';
    const automationStatus: AutomationStatus = c.automation.status === 'none' ? 'manual' : c.automation.status;
    return normalizeCase(
      {
        featureId: c.featureId,
        functionality: scope.title,
        title: c.title,
        description: c.purpose,
        objective: c.purpose,
        creativityLevel: c.creativity,
        platforms,
        type: c.creativity === 'adversarial' ? 'negative' : 'functional',
        priority: c.riskLevel === 'high' ? 'P1' : c.riskLevel === 'low' ? 'P3' : 'P2',
        preconditions: c.preconditions,
        fixtures: c.fixtures,
        steps: c.steps.map((action, i) => ({ index: i + 1, action, expected: c.expected[i] })),
        expectedResult: c.expected,
        actualResult: {
          status: actualStatus,
          summary: c.actualResult.join('; ') || 'Generated from a focused feature run.',
          evidence: c.evidence,
          lastRunAt: actualStatus !== 'not_run' ? now : undefined,
        },
        automation: {
          status: automationStatus,
          pageObjects: c.automation.pageObjects,
          testFiles: c.automation.flow ? [c.automation.flow] : [],
          locatorReadiness: 'D',
          replayStatus: 'not_replayed',
        },
        status: actualStatus === 'blocked' ? 'blocked' : 'active',
        mapLinks,
        evidence: c.evidence.map((uri) => ({ uri })),
        tags: ['feature', c.featureId],
      },
      now,
    );
  });
}
