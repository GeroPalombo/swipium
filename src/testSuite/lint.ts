// Linter for the persistent suite. PURE. Catches the failure
// modes that make a maintained suite untrustworthy: missing expected/actual results, unlinked or
// stale map links, duplicate ids, brittle automation above threshold, and (most importantly)
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
  /** Feature IDs still present in the current app map. Enables the stale-map-link rule. */
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
  const stepKeys = new Map<string, string>();
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
      if (stale.length)
        add('warn', 'stale_map_link', `Case links to feature(s) no longer in the app map: ${stale.map((l) => l.id).join(', ')}`, c.id);
    }

    if (c.automation.status === 'automated' && brittleGrades.includes(c.automation.locatorReadiness)) {
      add('warn', 'brittle_automation', `Automated case has brittle locators (grade ${c.automation.locatorReadiness})`, c.id);
    }
    if (c.automation.status === 'automated' && (c.automation.replayStatus === 'failed' || c.automation.replayStatus === 'blocked')) {
      add('warn', 'unreplayable_automation', `Automated case has replayStatus ${c.automation.replayStatus}, not release-gate proof`, c.id);
    }

    // No steps, or only a generic "explore" placeholder step, is not a real test; and a
    // "pass" on an exploration placeholder whose coverage was not found is not evidence.
    if (!c.steps.length) add('warn', 'no_steps', 'Case has no steps', c.id);
    else if (c.steps.every((s) => s.action === 'explore')) {
      add('warn', 'placeholder_steps', 'Case has only a generic "explore" placeholder step; record the real steps', c.id);
      // A pass needs evidence; a placeholder-only case with none proves nothing.
      if (c.actualResult.status === 'pass' && /not_found|none/i.test(c.actualResult.summary ?? ''))
        add('error', 'unproven_pass', `Case is marked pass but its evidence says "${c.actualResult.summary}"`, c.id);
      else if (c.actualResult.status === 'pass' && !(c.actualResult.evidence?.length || c.evidence?.length))
        add(
          'error',
          'unproven_pass',
          'Case is marked pass with only a placeholder step and no evidence; mark it not_run or attach evidence',
          c.id,
        );
    }

    // The same normalized steps under a different id/feature label is a duplicate case.
    if (c.steps.length && !c.steps.every((s) => s.action === 'explore')) {
      const key = c.steps.map((s) => `${s.action}|${(s.target ?? '').toLowerCase()}|${(s.data ?? '').toLowerCase()}`).join('>');
      const prior = stepKeys.get(key);
      if (prior && prior !== c.id) add('warn', 'duplicate_steps', `Case has the same steps as ${prior}`, c.id);
      else stepKeys.set(key, c.id);
    }

    if (c.creativityLevel === 'adversarial' && !hasAdversarialSafety(c)) {
      add(
        'error',
        'unsafe_adversarial',
        'Adversarial case lacks disposable-state/consent safety metadata. Swipium will refuse to run it',
        c.id,
      );
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.length - errorCount;
  return { findings, errorCount, warnCount, ok: errorCount === 0 };
}
