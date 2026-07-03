// SWIPIUM-REQ-08 — executable mobile-audit result model + release-impact rollup.

import {
  combineReleaseImpact,
  defaultReleaseImpact,
  type IssueCategory,
  type IssueSeverity,
  type ReleaseImpact,
} from '../issues/schema.js';
import type { AuditProfile } from './profiles.js';

export type CheckStatus = 'pass' | 'fail' | 'blocked' | 'skipped' | 'not_applicable';

export interface MobileAuditCheckResult {
  id: string;
  title: string;
  profile: AuditProfile;
  status: CheckStatus;
  category?: IssueCategory;
  severity?: IssueSeverity;
  issueId?: string;
  reason?: string;
  evidenceUris: string[];
  workflow?: string;
  screenId?: string;
  nextStep?: string;
}

export type AuditRunState = 'completed' | 'blocked' | 'needs_input' | 'unsafe';

export interface MobileAuditRunResult {
  profile: AuditProfile;
  state: AuditRunState;
  releaseImpact: ReleaseImpact;
  checks: MobileAuditCheckResult[];
  issueIds: string[];
  recurrenceWarnings: string[];
  reportUri?: string;
  appMapUri?: string;
  testSuiteRunUri?: string;
}

/**
 * Release impact of a finished audit run. A failed check with a real-defect / store-compliance /
 * hard-gate category contributes its category's default impact; recurrence of a previously-fixed
 * blocker/high issue blocks. Passing / not-applicable / skipped checks do not raise impact.
 */
export function auditReleaseImpact(checks: MobileAuditCheckResult[], hasBlockingRecurrence: boolean): ReleaseImpact {
  const impacts: ReleaseImpact[] = [];
  for (const c of checks) {
    if (c.status !== 'fail' && c.status !== 'blocked') continue;
    if (!c.category) {
      // a blocked check with no category is at most a warning (environment / setup gap).
      impacts.push('warn');
      continue;
    }
    impacts.push(defaultReleaseImpact(c.category, c.severity ?? 'medium'));
  }
  if (hasBlockingRecurrence) impacts.push('block');
  return combineReleaseImpact(impacts);
}

/** Map a finished check to a one-line markdown row. */
export function checkLine(c: MobileAuditCheckResult): string {
  const tag = c.issueId ? ` [${c.issueId}]` : '';
  return `- ${c.status.toUpperCase()} — ${c.title}${c.reason ? `: ${c.reason}` : ''}${tag}`;
}

/** Render the audit run as a compact markdown block for the report / tool output. */
export function auditRunToMarkdown(run: MobileAuditRunResult): string {
  const lines = [
    `## Mobile Audit — ${run.profile}`,
    '',
    `State: **${run.state}** · Release impact: **${run.releaseImpact.toUpperCase()}**`,
    '',
  ];
  for (const c of run.checks) lines.push(checkLine(c));
  if (run.recurrenceWarnings.length) {
    lines.push('', '### Recurrence');
    for (const w of run.recurrenceWarnings) lines.push(`- ${w}`);
  }
  return lines.join('\n');
}
