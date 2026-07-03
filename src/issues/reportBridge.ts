// SWIPIUM Issue Log — report integration bridge (SWIPIUM-REQ-07 "Integration Points → Reports").
//
// Converts a finished run's health findings + structured test outcomes into normalized issue
// observations, records them in the durable ledger (so recurrence works across runs), and returns
// the report `issues` section + recurrence messages. The health oracle stays observation-only; this
// bridge + src/issues/classify.ts own category/severity/state.
//
// Best-effort: the caller wraps this in try/catch so report generation never fails because of the
// ledger. Inputs are plain shapes (not Session) so this stays unit-testable.

import { recordObservation } from './index.js';
import { getIndex } from './store.js';
import { buildReportIssuesSection, type ReportIssuesSection } from './report.js';
import {
  isIssueCategory,
  type IssueCategory,
  type IssueEnvironment,
  type IssueObservation,
  type IssuePlatform,
  type SourceRevision,
} from './schema.js';

export interface BridgeFinding {
  severity: string;
  kind: string;
  detail: string;
  layer?: 'native' | 'app';
  evidence?: string;
  screen?: string;
  screenshotUri?: string;
  failureCode?: string;
}

export interface BridgeNote {
  workflow: string;
  outcome: string;
  category?: string;
  reason?: string;
  failureCode?: string;
  artifactUris?: string[];
}

export interface BridgeMeta {
  appId?: string;
  appName?: string;
  platform?: IssuePlatform;
  environment?: IssueEnvironment;
  sessionId?: string;
  reportPath?: string;
  reportUri?: string;
  sourceRevision?: SourceRevision;
}

/** One issue recorded from this run, with the linking context callers need (REQ-08). */
export interface BridgeRecorded {
  issueId: string;
  fingerprint: string;
  source: 'finding' | 'note';
  workflow?: string;
  category: IssueCategory;
  severity: string;
  state: string;
  reopened: boolean;
}

export interface BridgeResult {
  section: ReportIssuesSection;
  recordedIssueIds: string[];
  recurrences: string[];
  /** Per-issue linking context so the caller can attach issues to test cases (REQ-08). */
  recorded: BridgeRecorded[];
}

const BILLING_HINTS: Array<[string, RegExp]> = [
  ['revenuecat', /revenuecat/i],
  ['storekit', /storekit/i],
  ['google_play_billing', /billing_unavailable|google play billing|play billing/i],
];

function detectSubsystem(text: string): string | undefined {
  for (const [name, re] of BILLING_HINTS) if (re.test(text)) return name;
  return undefined;
}

function findingToObservation(f: BridgeFinding): IssueObservation {
  const subsystem = detectSubsystem(`${f.detail} ${f.evidence ?? ''}`);
  return {
    title: `${f.kind}${f.screen ? ` on ${f.screen}` : ''}`,
    summary: f.detail.slice(0, 200),
    failureCode: f.failureCode,
    screenPurpose: f.screen,
    visibleText: f.evidence,
    subsystem,
  };
}

/** Infer a screen purpose from a workflow/reason so the classifier can resolve gate-style notes. */
function inferScreenPurpose(n: BridgeNote): string | undefined {
  const hay = `${n.workflow} ${n.reason ?? ''}`.toLowerCase();
  if (/paywall|subscribe|purchase|trial/.test(hay)) return 'paywall';
  if (/login|sign\s?in/.test(hay)) return 'login';
  if (/forgot.?password/.test(hay)) return 'login';
  return undefined;
}

function noteToObservation(n: BridgeNote): IssueObservation {
  const subsystem = detectSubsystem(`${n.workflow} ${n.reason ?? ''}`);
  return {
    title: `${n.workflow} → ${n.outcome}`,
    summary: n.reason ? n.reason.slice(0, 200) : `${n.workflow} ${n.outcome}`,
    failureCode: n.failureCode,
    workflow: n.workflow,
    screenPurpose: inferScreenPurpose(n),
    visibleText: n.reason,
    subsystem,
  };
}

// A blocked/failed note in any of these categories is a real REQ-07 issue-ledger entry (not just
// app bugs): hard gates, store-compliance/privacy gaps, readiness improvements, missing data, etc.
// Intentional skips and not-applicable / passing outcomes are NOT recorded.
const RECORDED_NOTE_CATEGORIES = new Set([
  'app_bug',
  'blocker_app_bug',
  'hard_gate',
  'expected_gate',
  'store_compliance',
  'security_privacy',
  'accessibility_readiness',
  'improvement',
  'missing_test_data',
  'mcp_limitation',
]);

function shouldRecordNote(n: BridgeNote): boolean {
  if (n.outcome !== 'fail' && n.outcome !== 'blocked') return false;
  if (n.category === 'intentionally_skipped') return false;
  // Record when it carries a recognized category, a failure code, or is an uncategorized failure
  // (an uncategorized fail/blocked is still worth remembering — the classifier triages it).
  return !n.category || RECORDED_NOTE_CATEGORIES.has(n.category) || Boolean(n.failureCode);
}

/**
 * Fold a run's findings + notes into the issue ledger and build the report section.
 * Only non-info findings and failing/blocked app-bug notes become observations.
 */
export function foldRunIntoLedger(
  root: string,
  findings: BridgeFinding[],
  notes: BridgeNote[],
  now: string,
  meta: BridgeMeta = {},
  /** Issue ids whose fix was VERIFIED this run by passing evidence (from test-suite/audit links). */
  verifiedFixedIssueIds?: Set<string>,
): BridgeResult {
  const recordedIssueIds: string[] = [];
  const recurrences: string[] = [];
  const recorded: BridgeRecorded[] = [];
  const run = { sessionId: meta.sessionId, reportPath: meta.reportPath, reportUri: meta.reportUri };

  for (const f of findings) {
    if (f.severity === 'info') continue; // info findings are not issues
    const res = recordObservation(
      root,
      findingToObservation(f),
      now,
      { environment: meta.environment },
      {
        appId: meta.appId,
        appName: meta.appName,
        platform: meta.platform,
        environment: meta.environment,
        sourceRevision: meta.sourceRevision,
        run,
      },
    );
    recordedIssueIds.push(res.issueId);
    recorded.push({
      issueId: res.issueId,
      fingerprint: res.fingerprint,
      source: 'finding',
      category: res.record.category,
      severity: res.record.severity,
      state: res.record.state,
      reopened: res.reopened,
    });
    if (res.recurrenceMessage) recurrences.push(res.recurrenceMessage);
  }

  for (const n of notes) {
    if (!shouldRecordNote(n)) continue;
    // Trust an explicit, valid issue-category note as a classifier fallback (the text rules still
    // win when they detect a stronger signal, e.g. an actual RedBox mentioned in the reason).
    const categoryHint: IssueCategory | undefined = n.category && isIssueCategory(n.category) ? n.category : undefined;
    const res = recordObservation(
      root,
      noteToObservation(n),
      now,
      { environment: meta.environment, categoryHint },
      {
        appId: meta.appId,
        appName: meta.appName,
        platform: meta.platform,
        environment: meta.environment,
        sourceRevision: meta.sourceRevision,
        run: { ...run, testCaseId: n.workflow },
      },
    );
    recordedIssueIds.push(res.issueId);
    recorded.push({
      issueId: res.issueId,
      fingerprint: res.fingerprint,
      source: 'note',
      workflow: n.workflow,
      category: res.record.category,
      severity: res.record.severity,
      state: res.record.state,
      reopened: res.reopened,
    });
    if (res.recurrenceMessage) recurrences.push(res.recurrenceMessage);
  }

  const index = getIndex(root, now, meta.appId);
  const section = buildReportIssuesSection(index.records, new Set(recordedIssueIds), verifiedFixedIssueIds);
  return { section, recordedIssueIds, recurrences, recorded };
}
