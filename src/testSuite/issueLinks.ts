// SWIPIUM-REQ-08 — link persistent test cases to issue-ledger records.
//
// The issue ledger (src/issues) stays the source of truth for issue lifecycle. This layer records,
// on a canonical test case, WHICH issues caused/blocked it and — crucially — lets a passing run that
// is linked to a previously-fixed issue prove the fix held ("verified_fixed"). PURE: mutates the
// passed case/run objects, takes `now` as input, never touches the clock or fs.

import type { IssueCategory, IssueRecord } from '../issues/schema.js';
import type { CanonicalTestCase, TestCaseIssueRelationship, TestCaseRunIssueLink, TestCaseRunIssueRelationship } from './schema.js';

/** Map an issue category + case outcome to the durable case→issue relationship. */
export function relationshipForCase(category: IssueCategory): TestCaseIssueRelationship {
  switch (category) {
    case 'app_bug':
    case 'blocker_app_bug':
    case 'store_compliance':
    case 'security_privacy':
      return 'caused_failure';
    case 'hard_gate':
    case 'expected_gate':
    case 'missing_test_data':
    case 'mcp_limitation':
      return 'blocks_case';
    case 'environment_noise':
      return 'known_noise';
    case 'improvement':
    case 'accessibility_readiness':
      return 'improvement';
    default:
      return 'blocks_case';
  }
}

/** The per-run link relationship from the issue + whether it reopened this run. */
export function runRelationshipFor(record: IssueRecord, reopened: boolean): TestCaseRunIssueRelationship {
  if (reopened || record.state === 'reopened') return 'regressed';
  if (record.state === 'suppressed' || record.state === 'expected_environment_noise') return 'suppressed';
  return 'observed';
}

/** Upsert a durable issue ref on a case (idempotent by issueId). Mutates and returns the case. */
export function linkIssueToCase(
  testCase: CanonicalTestCase,
  record: IssueRecord,
  relationship: TestCaseIssueRelationship,
  now: string,
  reportUri?: string,
): CanonicalTestCase {
  const refs = (testCase.issueRefs ??= []);
  const existing = refs.find((r) => r.issueId === record.issueId);
  if (existing) {
    existing.relationship = relationship;
    existing.lastLinkedAt = now;
    existing.lastIssueState = record.state;
    if (reportUri) existing.lastReportUri = reportUri;
  } else {
    refs.push({
      issueId: record.issueId,
      fingerprint: record.fingerprint,
      relationship,
      firstLinkedAt: now,
      lastLinkedAt: now,
      lastIssueState: record.state,
      lastReportUri: reportUri,
    });
  }
  return testCase;
}

/** Append a per-run issue link to a run-history entry (mutates and returns the run ref). */
export function linkRunIssue(
  run: { issueLinks?: TestCaseRunIssueLink[] },
  record: IssueRecord,
  relationship: TestCaseRunIssueRelationship,
  reportUri?: string,
  evidenceUris?: string[],
): TestCaseRunIssueLink {
  const link: TestCaseRunIssueLink = {
    issueId: record.issueId,
    fingerprint: record.fingerprint,
    relationship,
    reportUri,
    evidenceUris,
  };
  (run.issueLinks ??= []).push(link);
  return link;
}

/**
 * Issue ids whose fix was VERIFIED this run: a case that PASSED this run and carries a durable ref
 * to an issue that the ledger now reports as `fixed`. Returns the issue ids eligible for a
 * `verified_fixed` linked_run event + report `fixedIssuesVerified`.
 */
export function verifiedFixedIssuesForRun(
  cases: CanonicalTestCase[],
  passingCaseIds: Set<string>,
  issueStateById: Map<string, string>,
): string[] {
  const out = new Set<string>();
  for (const c of cases) {
    if (!passingCaseIds.has(c.id)) continue;
    for (const ref of c.issueRefs ?? []) {
      if (issueStateById.get(ref.issueId) === 'fixed') out.add(ref.issueId);
    }
  }
  return [...out];
}

/** Render a compact "Linked issues" line for a case (suite markdown export). */
export function issueRefsToMarkdown(testCase: CanonicalTestCase): string | undefined {
  if (!testCase.issueRefs?.length) return undefined;
  return testCase.issueRefs.map((r) => `${r.issueId} (${r.relationship}, ${r.lastIssueState})`).join(', ');
}
