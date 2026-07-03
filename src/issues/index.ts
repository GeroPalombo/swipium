// SWIPIUM Issue Log — high-level service + query layer (SWIPIUM-REQ-07).
//
// This is the single entry point callers (health oracle, reports, explore, mobile audit, tools)
// use to record observations and mutate lifecycle. It ties together fingerprinting, classification,
// the append-only store, and the lifecycle reducer, then keeps the derived index in sync.
//
// The id helpers are deterministic given (issueId, createdAt, eventType, seq) so events are stable
// and tests are reproducible without a clock.

import { createHash } from 'node:crypto';
import { classifyObservation, type ClassifyContext } from './classify.js';
import { fingerprint, issueIdFromFingerprint } from './fingerprint.js';
import { buildRecurrenceMessage, foldEvent } from './recurrence.js';
import { appendEvents, eventCountForIssue, findRecord, getIndex, loadPolicy, saveIndex, type IssuePolicyFile } from './store.js';
import type {
  IssueEnvironment,
  IssueEvent,
  IssueIndex,
  IssueLifecyclePatch,
  IssueLinks,
  IssueObservation,
  IssuePlatform,
  IssueRecord,
  IssueRunRef,
  IssueRunRelationship,
  IssueState,
  IssueCategory,
  IssueSeverity,
  SourceRevision,
} from './schema.js';
import { ISSUE_SCHEMA_VERSION } from './schema.js';

/** Deterministic, collision-resistant event id from its content. */
export function makeEventId(issueId: string, createdAt: string, eventType: string, seq = 0): string {
  const h = createHash('sha256').update(`${issueId}|${createdAt}|${eventType}|${seq}`).digest('hex').slice(0, 12);
  return `evt_${h}`;
}

export interface ObserveMeta {
  appId?: string;
  appName?: string;
  platform?: IssuePlatform;
  environment?: IssueEnvironment;
  sourceRevision?: SourceRevision;
  run?: IssueRunRef;
  links?: IssueLinks;
}

export interface ObserveResult {
  record: IssueRecord;
  events: IssueEvent[];
  isNew: boolean;
  reopened: boolean;
  recurrenceMessage?: string;
  fingerprint: string;
  issueId: string;
}

/**
 * Record one observation: fingerprint → classify → decide lifecycle → append event(s) → update
 * index. Reopens a fixed issue (with recurrence message) when its fingerprint is seen again.
 */
export function recordObservation(
  root: string,
  observation: IssueObservation,
  now: string,
  ctx: ClassifyContext = {},
  meta: ObserveMeta = {},
): ObserveResult {
  const policy = loadPolicy(root);
  const fp = fingerprint({
    failureCode: observation.failureCode,
    platform: meta.platform,
    appId: meta.appId,
    observation,
  });
  const issueId = issueIdFromFingerprint(fp);
  const classification = classifyObservation(observation, { ...ctx, policy: mergePolicy(policy, ctx) });

  const index = getIndex(root, now, meta.appId);
  const prev = findRecord(index, { issueId, fingerprint: fp }) ?? null;
  const wasFixed = prev?.state === 'fixed';
  // The observation count is a monotonic per-issue sequence (each observation increments it), so it
  // gives distinct event ids for two same-timestamp observations WITHOUT re-reading the whole log.
  let seq = prev?.observationCount ?? 0;

  const observed: IssueEvent = {
    schemaVersion: ISSUE_SCHEMA_VERSION,
    eventId: makeEventId(issueId, now, 'observed', seq++),
    issueId,
    fingerprint: fp,
    eventType: 'observed',
    createdAt: now,
    appId: meta.appId,
    appName: meta.appName,
    platform: meta.platform,
    environment: meta.environment,
    sourceRevision: meta.sourceRevision,
    run: meta.run,
    observation,
    classification,
    links: meta.links,
  };

  const events: IssueEvent[] = [observed];
  let record = foldEvent(prev, observed);

  // Recurrence: append an explicit `reopened` event so the audit trail is honest (spec §Recurrence).
  let reopened = false;
  let recurrenceMessage: string | undefined;
  if (wasFixed && record.state === 'reopened') {
    reopened = true;
    recurrenceMessage = record.lastRecurrenceMessage ?? buildRecurrenceMessage(record);
    const reopenEvent: IssueEvent = {
      schemaVersion: ISSUE_SCHEMA_VERSION,
      eventId: makeEventId(issueId, now, 'reopened', seq++),
      issueId,
      fingerprint: fp,
      eventType: 'reopened',
      createdAt: now,
      platform: meta.platform,
      environment: meta.environment,
      lifecycle: { state: 'reopened', reopenedAt: now, recurrenceMessage },
    };
    events.push(reopenEvent);
    record = foldEvent(record, reopenEvent);
  }

  appendEvents(root, events);
  upsertRecord(index, record);
  index.updatedAt = now;
  saveIndex(root, index);

  return { record, events, isNew: prev == null, reopened, recurrenceMessage, fingerprint: fp, issueId };
}

/** Append a `fixed` lifecycle event and update the index. */
export function markFixed(
  root: string,
  key: { issueId?: string; fingerprint?: string },
  patch: { fixedInCommit?: string; fixedInVersion?: string; howFixed?: string; fixedBy?: string; sourceRevision?: SourceRevision },
  now: string,
): { ok: boolean; record?: IssueRecord; reason?: string } {
  return applyLifecycle(
    root,
    key,
    now,
    'fixed',
    {
      state: 'fixed',
      fixedAt: now,
      fixedInCommit: patch.fixedInCommit ?? patch.sourceRevision?.commit,
      fixedInVersion: patch.fixedInVersion ?? patch.sourceRevision?.buildVersion,
      howFixed: patch.howFixed,
      fixedBy: patch.fixedBy,
    },
    patch.sourceRevision,
  );
}

export interface LinkRunOptions {
  relationship: IssueRunRelationship;
  reportUri?: string;
  reportPath?: string;
  testCaseId?: string;
  evidenceUris?: string[];
  appMapRefs?: { screenId?: string; featureId?: string }[];
  sourceRevision?: SourceRevision;
}

/**
 * Append a `linked_run` event tying a run (test case / audit check) to an issue with a relationship
 * (observed / verified_fixed / regressed / suppressed) and optional evidence. The issue ledger stays
 * the source of truth; this records HOW a run related to the issue (REQ-08).
 */
export function linkRun(
  root: string,
  key: { issueId?: string; fingerprint?: string },
  opts: LinkRunOptions,
  now: string,
): { ok: boolean; record?: IssueRecord; reason?: string } {
  const index = getIndex(root, now);
  const existing = findRecord(index, key);
  if (!existing) return { ok: false, reason: `No issue found for ${key.issueId ?? key.fingerprint ?? '(no key)'}` };
  const event: IssueEvent = {
    schemaVersion: ISSUE_SCHEMA_VERSION,
    eventId: makeEventId(existing.issueId, now, 'linked_run', eventCountForIssue(root, existing.issueId)),
    issueId: existing.issueId,
    fingerprint: existing.fingerprint,
    eventType: 'linked_run',
    createdAt: now,
    sourceRevision: opts.sourceRevision,
    relationship: opts.relationship,
    run:
      opts.reportUri || opts.reportPath || opts.testCaseId
        ? { reportUri: opts.reportUri, reportPath: opts.reportPath, testCaseId: opts.testCaseId }
        : undefined,
    links: {
      evidenceRefs: opts.evidenceUris?.map((uri) => ({ kind: 'evidence', uri })),
      testRefs: opts.testCaseId ? [{ testCaseId: opts.testCaseId }] : undefined,
      appMapRefs: opts.appMapRefs,
    },
  };
  appendEvents(root, [event]);
  const updated = foldEvent(existing, event);
  upsertRecord(index, updated);
  index.updatedAt = now;
  saveIndex(root, index);
  return { ok: true, record: updated };
}

/**
 * Verify a FIXED issue with current-run evidence (REQ-08 `qa_issue_verify_fixed`). Requires the issue
 * to be in state `fixed` and at least one evidence reference (report/test/audit). Appends a
 * `verified_fixed` linked_run event so reports can honestly claim "verified this run".
 */
export function verifyFixed(
  root: string,
  key: { issueId?: string; fingerprint?: string },
  opts: {
    reportUri?: string;
    testCaseId?: string;
    auditCheckId?: string;
    evidenceUris?: string[];
    sourceRevision?: SourceRevision;
    note?: string;
  },
  now: string,
): { ok: boolean; record?: IssueRecord; reason?: string } {
  const index = getIndex(root, now);
  const existing = findRecord(index, key);
  if (!existing) return { ok: false, reason: `No issue found for ${key.issueId ?? key.fingerprint ?? '(no key)'}` };
  if (existing.state !== 'fixed')
    return { ok: false, reason: `Issue ${existing.issueId} is "${existing.state}", not "fixed" — only a fixed issue can be verified` };
  const hasEvidence = Boolean(opts.reportUri || opts.testCaseId || opts.auditCheckId || (opts.evidenceUris && opts.evidenceUris.length));
  if (!hasEvidence)
    return { ok: false, reason: 'verify_fixed needs current-run evidence: a reportUri, testCaseId, auditCheckId, or evidenceUris' };
  return linkRun(
    root,
    { issueId: existing.issueId },
    {
      relationship: 'verified_fixed',
      reportUri: opts.reportUri,
      testCaseId: opts.testCaseId ?? opts.auditCheckId,
      evidenceUris: opts.evidenceUris,
      sourceRevision: opts.sourceRevision,
    },
    now,
  );
}

function applyLifecycle(
  root: string,
  key: { issueId?: string; fingerprint?: string },
  now: string,
  eventType: IssueEvent['eventType'],
  lifecycle: IssueLifecyclePatch,
  sourceRevision?: SourceRevision,
): { ok: boolean; record?: IssueRecord; reason?: string } {
  const index = getIndex(root, now);
  const existing = findRecord(index, key);
  if (!existing) {
    return { ok: false, reason: `No issue found for ${key.issueId ?? key.fingerprint ?? '(no key)'}` };
  }
  const event: IssueEvent = {
    schemaVersion: ISSUE_SCHEMA_VERSION,
    eventId: makeEventId(existing.issueId, now, eventType, eventCountForIssue(root, existing.issueId)),
    issueId: existing.issueId,
    fingerprint: existing.fingerprint,
    eventType,
    createdAt: now,
    sourceRevision,
    lifecycle,
  };
  appendEvents(root, [event]);
  const updated = foldEvent(existing, event);
  upsertRecord(index, updated);
  index.updatedAt = now;
  saveIndex(root, index);
  return { ok: true, record: updated };
}

function upsertRecord(index: IssueIndex, record: IssueRecord): void {
  const i = index.records.findIndex((r) => r.issueId === record.issueId);
  if (i >= 0) index.records[i] = record;
  else index.records.push(record);
}

function mergePolicy(policy: IssuePolicyFile, ctx: ClassifyContext): IssuePolicyFile | undefined {
  // ctx.policy (in-memory) takes precedence; otherwise use the on-disk policy's classifiers.
  if (ctx.policy?.classifiers) return ctx.policy;
  if (policy.classifiers) return policy;
  return undefined;
}

// --- Query layer (qa_issue_log) -------------------------------------------------------------

export interface IssueQuery {
  state?: IssueState;
  category?: IssueCategory;
  severity?: IssueSeverity;
  platform?: IssuePlatform;
  since?: string; // ISO; lastSeenAt >= since
  includeSuppressed?: boolean;
}

export interface IssueQueryResult {
  records: IssueRecord[];
  counts: {
    byState: Record<string, number>;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    total: number;
  };
  recurrenceCandidates: IssueRecord[]; // fixed issues that could regress (fixed but seen again recently)
}

export function queryIssues(root: string, now: string, query: IssueQuery = {}): IssueQueryResult {
  const index = getIndex(root, now);
  let records = index.records.slice();
  if (!query.includeSuppressed) records = records.filter((r) => r.state !== 'suppressed');
  if (query.state) records = records.filter((r) => r.state === query.state);
  if (query.category) records = records.filter((r) => r.category === query.category);
  if (query.severity) records = records.filter((r) => r.severity === query.severity);
  if (query.platform) records = records.filter((r) => r.platform === query.platform);
  if (query.since) records = records.filter((r) => r.lastSeenAt >= query.since!);

  const counts = {
    byState: tally(records, (r) => r.state),
    byCategory: tally(records, (r) => r.category),
    bySeverity: tally(records, (r) => r.severity),
    total: records.length,
  };
  const recurrenceCandidates = records.filter((r) => r.state === 'reopened' || r.lastRecurrenceMessage);
  return { records, counts, recurrenceCandidates };
}

function tally<T>(rows: T[], key: (t: T) => string): Record<string, number> {
  return rows.reduce<Record<string, number>>((a, r) => ((a[key(r)] = (a[key(r)] ?? 0) + 1), a), {});
}

export * from './schema.js';
export { fingerprint, issueIdFromFingerprint } from './fingerprint.js';
export { classifyObservation } from './classify.js';
export { resolveSourceRevision } from './sourceRevision.js';
export { buildRecurrenceMessage } from './recurrence.js';
