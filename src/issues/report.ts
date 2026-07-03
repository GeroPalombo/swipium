// SWIPIUM Issue Log — fold issue memory into reports (SWIPIUM-REQ-07 "Report Changes").
//
// Builds the `issues` section of a QA report from the derived index, and renders the Markdown
// "Issue Memory" block. PURE — takes records + now, returns data/strings.

import { APP_BUG_CATEGORIES, combineReleaseImpact, defaultReleaseImpact, type IssueRecord, type ReleaseImpact } from './schema.js';

export interface ReportIssuesSection {
  summary: {
    newOpen: number;
    recurring: number;
    fixedStillPassing: number;
    suppressed: number;
    environmentNoise: number;
    hardGates: number;
  };
  releaseImpact: ReleaseImpact;
  newIssues: IssueRecord[];
  recurringIssues: IssueRecord[];
  fixedIssuesVerified: IssueRecord[];
  knownNoise: IssueRecord[];
  hardGates: IssueRecord[];
  improvements: IssueRecord[];
}

/**
 * Build the report issues section.
 * @param records all index records for the app/project
 * @param runIssueIds ids touched in THIS run (so "new/recurring" reflect this run, not all history)
 * @param verifiedFixedIssueIds ids whose fix was VERIFIED this run by passing evidence (REQ-08). Only
 *   these are reported as "fixed issues verified this run". When omitted AND no runIssueIds is given
 *   (whole-history view, e.g. qa_issue_log) all fixed issues are listed historically.
 */
export function buildReportIssuesSection(
  records: IssueRecord[],
  runIssueIds?: Set<string>,
  verifiedFixedIssueIds?: Set<string>,
): ReportIssuesSection {
  const inRun = (r: IssueRecord) => !runIssueIds || runIssueIds.has(r.issueId);

  const newIssues = records.filter(
    (r) => inRun(r) && (r.state === 'open' || r.state === 'observed_again') && r.observationCount <= 1 && !r.lastRecurrenceMessage,
  );
  const openIssues = records.filter((r) => inRun(r) && (r.state === 'open' || r.state === 'observed_again'));
  const recurringIssues = records.filter((r) => inRun(r) && (r.state === 'reopened' || Boolean(r.lastRecurrenceMessage)));
  // "Verified this run" requires CURRENT-RUN pass evidence (a verified_fixed linked_run). REQ-08:
  // honest fix verification. When a verification set is supplied, only those fixed issues count; when
  // a run scope is supplied but no verification set, nothing is claimed verified; with neither (a
  // whole-history view) all fixed issues are listed.
  const fixedIssuesVerified = records.filter(
    (r) => r.state === 'fixed' && (verifiedFixedIssueIds ? verifiedFixedIssueIds.has(r.issueId) : runIssueIds ? false : true),
  );
  const knownNoise = records.filter(
    (r) => r.state === 'expected_environment_noise' || r.state === 'suppressed' || r.category === 'environment_noise',
  );
  const hardGates = records.filter((r) => inRun(r) && r.category === 'hard_gate');
  const improvements = records.filter((r) => inRun(r) && (r.category === 'improvement' || r.category === 'accessibility_readiness'));

  // Release impact: real, non-suppressed app defects + store/security issues drive the gate.
  const impacts: ReleaseImpact[] = [];
  for (const r of records) {
    if (!inRun(r)) continue;
    if (r.state === 'suppressed' || r.state === 'expected_environment_noise' || r.state === 'fixed') continue;
    if (
      APP_BUG_CATEGORIES.includes(r.category) ||
      r.category === 'security_privacy' ||
      r.category === 'store_compliance' ||
      r.category === 'improvement' ||
      r.category === 'accessibility_readiness' ||
      r.category === 'hard_gate'
    ) {
      impacts.push(defaultReleaseImpact(r.category, r.severity));
    }
  }
  const releaseImpact = combineReleaseImpact(impacts);

  return {
    summary: {
      newOpen: openIssues.length,
      recurring: recurringIssues.length,
      fixedStillPassing: fixedIssuesVerified.length,
      suppressed: records.filter((r) => r.state === 'suppressed').length,
      environmentNoise: records.filter((r) => r.state === 'expected_environment_noise' || r.category === 'environment_noise').length,
      hardGates: hardGates.length,
    },
    releaseImpact,
    newIssues,
    recurringIssues,
    fixedIssuesVerified,
    knownNoise,
    hardGates,
    improvements,
  };
}

/** Render the Markdown "Issue Memory" block (spec §Report Changes example). */
export function issuesSectionToMarkdown(section: ReportIssuesSection): string {
  const s = section.summary;
  const lines: string[] = [];
  lines.push('## Issue Memory');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| New / open issues | ${s.newOpen} |`);
  lines.push(`| Recurring (regressed) issues | ${s.recurring} |`);
  lines.push(`| Known environment noise | ${s.environmentNoise} |`);
  lines.push(`| Suppressed | ${s.suppressed} |`);
  lines.push(`| Hard gates | ${s.hardGates} |`);
  lines.push(`| Fixed issues still passing | ${s.fixedStillPassing} |`);
  lines.push('');
  lines.push(`Release impact: **${section.releaseImpact.toUpperCase()}**`);

  const blockingBugs = section.newIssues.filter(
    (r) => r.category === 'blocker_app_bug' || (r.category === 'app_bug' && (r.severity === 'blocker' || r.severity === 'high')),
  );
  if (blockingBugs.length) {
    lines.push('', '### Blocking App Bugs');
    for (const r of blockingBugs) lines.push(`- \`${r.issueId}\` (${r.severity}): ${r.summary}`);
  }
  if (section.recurringIssues.length) {
    lines.push('', '### Recurring Issues');
    for (const r of section.recurringIssues) {
      lines.push(`- \`${r.issueId}\`: ${r.summary}.`);
      if (r.lastRecurrenceMessage) lines.push(`  ${r.lastRecurrenceMessage}`);
    }
  }
  if (section.hardGates.length) {
    lines.push('', '### Hard Gates');
    for (const r of section.hardGates) lines.push(`- \`${r.issueId}\`: ${r.summary} (workflow gated, not an app bug).`);
  }
  if (section.knownNoise.length) {
    lines.push('', '### Environment Noise');
    for (const r of section.knownNoise)
      lines.push(`- \`${r.issueId}\`: ${r.summary}${r.suppressionReason ? ` (suppressed: ${r.suppressionReason})` : ''}.`);
  }
  if (section.improvements.length) {
    lines.push('', '### Improvements & Precautions');
    for (const r of section.improvements) lines.push(`- \`${r.issueId}\`: ${r.summary}.`);
  }
  if (section.fixedIssuesVerified.length) {
    lines.push('', '### Fixed Issues Verified This Run');
    for (const r of section.fixedIssuesVerified)
      lines.push(`- \`${r.issueId}\`: ${r.summary}${r.fixedInCommit ? ` (fixed in \`${r.fixedInCommit}\`)` : ''}.`);
  }
  return lines.join('\n');
}
