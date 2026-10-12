// SWIPIUM Issue Log: report integration bridge.
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
  /** Crash/ANR log excerpt captured with the finding (oracle/record.ts). */
  logUri?: string;
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

/** One issue recorded from this run, with the linking context callers need. */
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
  /** Per-issue linking context so the caller can attach issues to test cases. */
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

const FINDING_TITLES: Record<string, string> = {
  native_crash: 'Native crash',
  anr: 'App not responding (ANR)',
  wrong_foreground_app: 'App left the foreground',
  rn_redbox: 'React Native RedBox',
  expo_dev_launcher: 'Expo dev launcher instead of the app',
  app_error_boundary: 'Error boundary fallback screen',
  webview_error: 'WebView error page',
  rn_logbox_error: 'React Native LogBox error',
  unknown_error_surface: 'Error message on screen',
};

/** A readable ledger title: what happened, where (app + activity/screen), not "anr on unknown". */
function findingTitle(f: BridgeFinding, appId?: string): string {
  const what = FINDING_TITLES[f.kind] ?? f.kind;
  const hint = f.kind === 'wrong_foreground_app' && /possible crash/i.test(f.detail) ? ' (possible crash)' : '';
  // For a foreground loss the screen is whatever replaced the app (the launcher): name the app
  // that left, not the launcher (LOG-3).
  if (f.kind === 'wrong_foreground_app' && appId) return `${what}${hint}: ${appId}`;
  const where = f.screen && f.screen !== 'unknown' ? f.screen : appId;
  const ev = f.evidence ? `: "${f.evidence.slice(0, 60)}"` : '';
  return `${what}${hint}${where ? ` in ${where}` : ''}${ev}`;
}

/** Evidence the finding carries (screenshot, crash log), as ledger evidence refs. */
function findingEvidenceRefs(f: BridgeFinding): Array<{ kind: string; uri: string }> {
  const refs: Array<{ kind: string; uri: string }> = [];
  if (f.screenshotUri) refs.push({ kind: 'screenshot', uri: f.screenshotUri });
  if (f.logUri) refs.push({ kind: 'log', uri: f.logUri });
  return refs;
}

function findingToObservation(f: BridgeFinding, appId?: string): IssueObservation {
  const subsystem = detectSubsystem(`${f.detail} ${f.evidence ?? ''}`);
  return {
    title: findingTitle(f, appId),
    summary: f.detail.slice(0, 200),
    // A hung WDA carries no code of its own; name it so the classifier files it as a tool failure.
    failureCode: f.failureCode ?? (f.kind === 'wda_unreachable' ? 'WDA_UNREACHABLE' : undefined),
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
    title: `${n.workflow} > ${n.outcome}`,
    summary: n.reason ? n.reason.slice(0, 200) : `${n.workflow} ${n.outcome}`,
    failureCode: n.failureCode,
    workflow: n.workflow,
    screenPurpose: inferScreenPurpose(n),
    visibleText: n.reason,
    subsystem,
  };
}

// A blocked/failed note in any of these categories is a real issue-ledger entry (not just
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
  // (an uncategorized fail/blocked is still worth remembering; the classifier triages it).
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

  // One observation per issue per run: qa_act re-runs health after every action, so the same
  // crash dialog / RedBox is often recorded several times in one session (LOG-3).
  const seenFindings = new Set<string>();
  for (const f of findings) {
    if (f.severity === 'info') continue; // info findings are not issues
    const key = `${f.kind}|${f.failureCode ?? ''}|${f.screen ?? ''}|${f.detail}|${f.evidence ?? ''}`;
    if (seenFindings.has(key)) continue;
    seenFindings.add(key);
    const evidenceRefs = findingEvidenceRefs(f);
    // A high-severity health finding is an app-owned defect unless a built-in rule says otherwise
    // (e.g. "app left to the launcher (possible crash)" used to land as an unclassified low).
    // A different app in front is the app's behaviour (or the crash's first sign under load), never a
    // Swipium limitation: without this it fell to the mcp_limitation default and shared an issue id
    // with the later app_bug "possible crash" observation (LOG NEW-2).
    const highHint =
      f.severity === 'high'
        ? { categoryHint: 'app_bug' as IssueCategory, severityHint: 'high' as const }
        : f.kind === 'wrong_foreground_app'
          ? { categoryHint: 'app_bug' as IssueCategory, severityHint: 'medium' as const }
          : {};
    const res = recordObservation(
      root,
      findingToObservation(f, meta.appId),
      now,
      { environment: meta.environment, ...highHint },
      {
        appId: meta.appId,
        appName: meta.appName,
        platform: meta.platform,
        environment: meta.environment,
        sourceRevision: meta.sourceRevision,
        run,
        ...(evidenceRefs.length ? { links: { evidenceRefs } } : {}),
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
        ...(n.artifactUris?.length ? { links: { evidenceRefs: n.artifactUris.map((uri) => ({ kind: 'evidence', uri })) } } : {}),
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
