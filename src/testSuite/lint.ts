// Linter for the persistent suite (SWIPIUM-REQ-06 "qa_test_suite_lint"). PURE. Catches the failure
// modes that make a maintained suite untrustworthy: missing expected/actual results, unlinked or
// stale map links, duplicate ids, brittle automation above threshold, and — most importantly —
// `adversarial` cases that lack the safety metadata Swipium requires before it will ever run them.

import type { CanonicalTestCase, TestSuiteFile } from './schema.js';

export type LintSeverity = 'error' | 'warn';

export interface LintFinding {
  id?: string;
  rule: string;
  severity: LintSeverity;
  message: string;
}

export interface LintResult {
  findings: LintFinding[];
  errorCount: number;
  warnCount: number;
  ok: boolean;
}

export interface LintOptions {
  /** Feature IDs still present in the current app map — enables the stale-map-link rule. */
  liveFeatureIds?: string[];
  /** Locator-readiness grade (and worse) that counts as brittle. Default 'D'. */
  brittleThreshold?: 'C' | 'D';
}

/** A case may run adversarially only with explicit disposable-state / consent metadata. */
function hasAdversarialSafety(c: CanonicalTestCase): boolean {
  const tagged = c.tags.some((t) => /disposable|consent|sandbox/i.test(t));
  const precondition = c.preconditions.some((p) => /disposable|sandbox|throwaway|test account/i.test(p));
  const fixtureNote = c.fixtures.some((f) => /disposable|sandbox/i.test(f));
  return tagged || precondition || fixtureNote;
}

export function lintSuite(suite: TestSuiteFile, opts: LintOptions = {}): LintResult {
  const findings: LintFinding[] = [];
  const add = (severity: LintSeverity, rule: string, message: string, id?: string) => findings.push({ id, rule, severity, message });
  const brittleGrades = opts.brittleThreshold === 'C' ? ['C', 'D'] : ['D'];

  const seen = new Set<string>();
  const live = opts.liveFeatureIds ? new Set(opts.liveFeatureIds) : null;

  for (const c of suite.cases) {
    if (seen.has(c.id)) add('error', 'duplicate_id', `Duplicate case id ${c.id}`, c.id);
    seen.add(c.id);

    if (c.status === 'deprecated') continue; // deprecated cases are exempt from content rules

    if (!c.expectedResult.length || c.expectedResult.every((e) => !e.trim())) {
      add('error', 'missing_expected', 'Case has no expected result', c.id);
    }

    // An executed case (has run history) that never recorded an actual result.
    if (c.history.length > 0 && c.actualResult.status === 'not_run') {
      add('error', 'missing_actual', 'Case has run history but actualResult is still not_run', c.id);
    }

    if (!c.mapLinks.length && c.status !== 'manual_only' && c.status !== 'draft') {
      add('warn', 'unlinked_feature', 'Case is not linked to any app-map feature/screen', c.id);
    }

    if (live) {
      const stale = c.mapLinks.filter((l) => l.kind === 'feature' && !live.has(l.id));
      if (stale.length) add('warn', 'stale_map_link', `Case links to feature(s) no longer in the app map: ${stale.map((l) => l.id).join(', ')}`, c.id);
    }

    if (c.automation.status === 'automated' && brittleGrades.includes(c.automation.locatorReadiness)) {
      add('warn', 'brittle_automation', `Automated case has brittle locators (grade ${c.automation.locatorReadiness})`, c.id);
    }
    if (c.automation.status === 'automated' && (c.automation.replayStatus === 'failed' || c.automation.replayStatus === 'blocked')) {
      add('warn', 'unreplayable_automation', `Automated case has replayStatus ${c.automation.replayStatus} — not release-gate proof`, c.id);
    }

    if (c.creativityLevel === 'adversarial' && !hasAdversarialSafety(c)) {
      add('error', 'unsafe_adversarial', 'Adversarial case lacks disposable-state/consent safety metadata — Swipium will refuse to run it', c.id);
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.length - errorCount;
  return { findings, errorCount, warnCount, ok: errorCount === 0 };
}
