// SWIPIUM Issue Log / Error Tracking (SWIPIUM-REQ-07). Type definitions, enums, and validation
// helpers for the durable, project-level issue ledger.
//
// The ledger is Swipium's mobile-QA memory: an append-only event log (`.swipium/issues-log.jsonl`)
// plus a derived index (`.swipium/issues/index.json`). Events are compact and never hold full
// screenshots / logs / stack traces / report JSON — only references to artifacts (Developer Notes).
// Every lifecycle mutation is append-only so a developer can audit WHY an issue is currently
// considered fixed / reopened / suppressed.
//
// PURE: nothing here touches the clock or the filesystem. Callers pass `now` (an ISO string) in.

export const ISSUE_SCHEMA_VERSION = 1 as const;

/** Lifecycle state of an issue (Sentry-style triage states). */
export type IssueState = 'open' | 'observed_again' | 'fixed' | 'reopened' | 'suppressed' | 'expected_environment_noise' | 'needs_triage';

/** How a developer triages an issue. */
export type IssueCategory =
  | 'app_bug'
  | 'blocker_app_bug'
  | 'environment_noise'
  | 'expected_gate'
  | 'hard_gate'
  | 'improvement'
  | 'missing_test_data'
  | 'mcp_limitation'
  | 'security_privacy'
  | 'store_compliance'
  | 'accessibility_readiness';

export type IssueSeverity = 'blocker' | 'high' | 'medium' | 'low' | 'info';

export type IssueOwner = 'app' | 'backend' | 'test_env' | 'mcp' | 'unknown';

export type IssuePlatform = 'ios' | 'android' | 'web' | 'unknown';

export type IssueEnvironment = 'simulator' | 'emulator' | 'device' | 'ci' | 'unknown';

/** Release impact of an issue or of a whole run's issue memory. */
export type ReleaseImpact = 'block' | 'warn' | 'pass';

export type IssueEventType = 'observed' | 'classified' | 'triaged' | 'fixed' | 'reopened' | 'suppressed' | 'linked_run' | 'note_added';

/** Source revision metadata. Git is NEVER required; `unknown` is a valid provider. */
export interface SourceRevision {
  provider: 'explicit' | 'github_actions' | 'gitlab_ci' | 'bitbucket_ci' | 'app_build' | 'git_readonly' | 'unknown';
  commit?: string;
  branch?: string;
  tag?: string;
  runUrl?: string;
  buildVersion?: string;
  buildNumber?: string;
  artifactHash?: string;
}

/** A reference back to the run that produced an event (compact — no inline report JSON). */
export interface IssueRunRef {
  sessionId?: string;
  reportPath?: string;
  reportUri?: string;
  testCaseId?: string;
}

/** What was actually seen. Hashes/references only; no full stack traces or screenshots. */
export interface IssueObservation {
  title: string;
  summary: string;
  failureCode?: string;
  screenPurpose?: string;
  screenId?: string;
  route?: string;
  workflow?: string;
  visibleText?: string; // short, normalized — redact before storing long text
  visibleTextHash?: string;
  exception?: { type?: string; message?: string; topFrame?: string };
  http?: { method?: string; routeTemplate?: string; status?: number };
  packageName?: string;
  subsystem?: string; // billing/store subsystem: revenuecat | storekit | google_play_billing | ...
  steps?: string[];
}

/** Classifier output for an observation. */
export interface IssueClassification {
  category: IssueCategory;
  severity: IssueSeverity;
  owner: IssueOwner;
  confidence: number; // 0..1
  reason: string;
  releaseImpact: ReleaseImpact;
}

/** A lifecycle patch carried on a fixed/reopened/suppressed/triaged event. */
export interface IssueLifecyclePatch {
  state?: IssueState;
  fixedAt?: string;
  fixedInCommit?: string;
  fixedInVersion?: string;
  fixedBy?: string;
  howFixed?: string;
  reopenedAt?: string;
  recurrenceMessage?: string;
  suppressedUntil?: string;
  suppressionReason?: string;
  suppressionScope?: SuppressionScope;
  category?: IssueCategory;
  severity?: IssueSeverity;
  owner?: IssueOwner;
  note?: string;
}

export type SuppressionScope = 'fingerprint' | 'platform' | 'environment' | 'appVersion';

export interface AppMapRef {
  screenId?: string;
  featureId?: string;
}
export interface TestRef {
  testCaseId: string;
}
export interface ReportRef {
  reportPath?: string;
  reportUri?: string;
}
export interface EvidenceRef {
  kind: string; // screenshot | log | dump | recording
  uri?: string;
  path?: string;
}

export interface IssueLinks {
  appMapRefs?: AppMapRef[];
  testRefs?: TestRef[];
  reportRefs?: ReportRef[];
  evidenceRefs?: EvidenceRef[];
}

/** One append-only event in `.swipium/issues-log.jsonl`. */
export interface IssueEvent {
  schemaVersion: typeof ISSUE_SCHEMA_VERSION;
  eventId: string;
  issueId: string;
  fingerprint: string;
  eventType: IssueEventType;
  createdAt: string;
  appId?: string;
  appName?: string;
  platform?: IssuePlatform;
  environment?: IssueEnvironment;
  sourceRevision?: SourceRevision;
  run?: IssueRunRef;
  observation?: IssueObservation;
  classification?: IssueClassification;
  lifecycle?: IssueLifecyclePatch;
  links?: IssueLinks;
  /** Relationship carried on a `linked_run` event (REQ-08): how this run relates to the issue. */
  relationship?: IssueRunRelationship;
}

/** How a run relates to an issue on a `linked_run` event (REQ-08 test-suite / audit linking). */
export type IssueRunRelationship = 'observed' | 'verified_fixed' | 'regressed' | 'suppressed';

/** A derived index record (one per issue), rebuildable from the event log. */
export interface IssueRecord {
  schemaVersion: typeof ISSUE_SCHEMA_VERSION;
  issueId: string;
  fingerprint: string;
  title: string;
  summary: string;
  state: IssueState;
  category: IssueCategory;
  severity: IssueSeverity;
  confidence: number;
  owner?: IssueOwner;
  platform?: IssuePlatform;
  environment?: IssueEnvironment;
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
  fixedAt?: string;
  fixedInCommit?: string;
  fixedInVersion?: string;
  fixedBy?: string;
  howFixed?: string;
  reopenedAt?: string;
  suppressedUntil?: string;
  suppressionReason?: string;
  suppressionScope?: SuppressionScope;
  appMapRefs?: AppMapRef[];
  testRefs?: TestRef[];
  reportRefs?: ReportRef[];
  evidenceRefs?: EvidenceRef[];
  lastRecurrenceMessage?: string;
  /** When a `verified_fixed` linked_run last confirmed the fix held (REQ-08). */
  lastVerifiedFixedAt?: string;
}

/** The derived index file (`.swipium/issues/index.json`). */
export interface IssueIndex {
  schemaVersion: typeof ISSUE_SCHEMA_VERSION;
  updatedAt: string;
  appId?: string;
  records: IssueRecord[];
}

export function emptyIndex(now: string, appId?: string): IssueIndex {
  return { schemaVersion: ISSUE_SCHEMA_VERSION, updatedAt: now, appId, records: [] };
}

/** A user-visible issue is one a release reviewer should still see (not silently hidden). */
export const NOISE_STATES: IssueState[] = ['expected_environment_noise', 'suppressed'];
export const OPEN_STATES: IssueState[] = ['open', 'observed_again', 'reopened', 'needs_triage'];

export const ALL_ISSUE_STATES: IssueState[] = [
  'open',
  'observed_again',
  'fixed',
  'reopened',
  'suppressed',
  'expected_environment_noise',
  'needs_triage',
];

export const ALL_ISSUE_CATEGORIES: IssueCategory[] = [
  'app_bug',
  'blocker_app_bug',
  'environment_noise',
  'expected_gate',
  'hard_gate',
  'improvement',
  'missing_test_data',
  'mcp_limitation',
  'security_privacy',
  'store_compliance',
  'accessibility_readiness',
];

export const ALL_ISSUE_SEVERITIES: IssueSeverity[] = ['blocker', 'high', 'medium', 'low', 'info'];

/** Categories that count as "real app defects" rather than noise / gates / readiness. */
export const APP_BUG_CATEGORIES: IssueCategory[] = ['app_bug', 'blocker_app_bug'];

/** Map a category to its default release impact when a policy rule doesn't override it. */
export function defaultReleaseImpact(category: IssueCategory, severity: IssueSeverity): ReleaseImpact {
  if (category === 'blocker_app_bug' || severity === 'blocker') return 'block';
  if (category === 'app_bug') return severity === 'high' ? 'block' : 'warn';
  if (category === 'security_privacy' || category === 'store_compliance') return severity === 'high' ? 'block' : 'warn';
  if (category === 'hard_gate') return 'warn';
  if (category === 'environment_noise') return 'pass';
  if (category === 'improvement' || category === 'accessibility_readiness') return 'warn';
  return 'warn';
}

/** Roll up many per-issue impacts into a single release decision (block > warn > pass). */
export function combineReleaseImpact(impacts: ReleaseImpact[]): ReleaseImpact {
  if (impacts.includes('block')) return 'block';
  if (impacts.includes('warn')) return 'warn';
  return 'pass';
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Lightweight structural validation for an event (best-effort; never throws). */
export function validateEvent(e: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (typeof e !== 'object' || e === null) return [{ path: '', message: 'event is not an object' }];
  const ev = e as Record<string, unknown>;
  if (ev.schemaVersion !== ISSUE_SCHEMA_VERSION) out.push({ path: 'schemaVersion', message: 'unexpected schema version' });
  for (const k of ['eventId', 'issueId', 'fingerprint', 'eventType', 'createdAt'] as const) {
    if (typeof ev[k] !== 'string' || !ev[k]) out.push({ path: k, message: `missing/invalid ${k}` });
  }
  return out;
}

export function isIssueState(v: unknown): v is IssueState {
  return typeof v === 'string' && (ALL_ISSUE_STATES as string[]).includes(v);
}
export function isIssueCategory(v: unknown): v is IssueCategory {
  return typeof v === 'string' && (ALL_ISSUE_CATEGORIES as string[]).includes(v);
}
export function isIssueSeverity(v: unknown): v is IssueSeverity {
  return typeof v === 'string' && (ALL_ISSUE_SEVERITIES as string[]).includes(v);
}
