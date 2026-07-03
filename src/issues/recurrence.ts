// SWIPIUM Issue Log — lifecycle folding + recurrence messages (SWIPIUM-REQ-07 "Recurrence Behavior").
//
// PURE. `foldEvent` is the single reducer that turns the append-only event stream into the derived
// index record — so the index can always be rebuilt from `issues-log.jsonl`. `buildRecurrenceMessage`
// produces the product-facing text shown in reports when a fixed issue reappears.

import type { IssueEvent, IssueRecord, IssueState, IssueLinks, AppMapRef, TestRef, ReportRef, EvidenceRef } from './schema.js';
import { ISSUE_SCHEMA_VERSION } from './schema.js';

/** Format an ISO timestamp as a YYYY-MM-DD date for human-facing recurrence text. */
export function isoDate(iso?: string): string {
  if (!iso) return 'an unknown date';
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : iso;
}

/**
 * Build the report-ready recurrence message for an issue that was observed again.
 * Three variants per the spec: fixed-with-commit, fixed-without-commit, never-fixed.
 */
export function buildRecurrenceMessage(record: IssueRecord): string {
  const summary = record.summary || record.title;
  if (record.fixedAt && record.fixedInCommit) {
    const note = record.howFixed ? ` Previous fix note: ${record.howFixed}.` : '';
    return `This error ${summary} appeared again. It was first reported on ${isoDate(record.firstSeenAt)} and fixed on ${isoDate(record.fixedAt)} in ${record.fixedInCommit}.${note}`;
  }
  if (record.fixedAt) {
    return `This error ${summary} appeared again. It was first reported on ${isoDate(record.firstSeenAt)} and fixed on ${isoDate(record.fixedAt)}. No fixed commit was recorded.`;
  }
  return `This error ${summary} was observed again. It was first reported on ${isoDate(record.firstSeenAt)} and has appeared ${record.observationCount} times.`;
}

function mergeRefs<T>(existing: T[] | undefined, incoming: T[] | undefined, key: (t: T) => string): T[] | undefined {
  if (!existing && !incoming) return undefined;
  const seen = new Map<string, T>();
  for (const r of existing ?? []) seen.set(key(r), r);
  for (const r of incoming ?? []) seen.set(key(r), r);
  return [...seen.values()];
}

function mergeLinks(record: IssueRecord, links?: IssueLinks): void {
  if (!links) return;
  record.appMapRefs = mergeRefs<AppMapRef>(record.appMapRefs, links.appMapRefs, (r) => `${r.screenId ?? ''}|${r.featureId ?? ''}`);
  record.testRefs = mergeRefs<TestRef>(record.testRefs, links.testRefs, (r) => r.testCaseId);
  record.reportRefs = mergeRefs<ReportRef>(record.reportRefs, links.reportRefs, (r) => `${r.reportPath ?? ''}|${r.reportUri ?? ''}`);
  record.evidenceRefs = mergeRefs<EvidenceRef>(record.evidenceRefs, links.evidenceRefs, (r) => `${r.kind}|${r.uri ?? r.path ?? ''}`);
}

/**
 * Fold a single event onto the running index record. Returns the updated record (a new object).
 * `prev` is null when this is the first event for the issue. This reducer is the canonical
 * definition of "what state is this issue in", and is replayed in order to rebuild the index.
 */
export function foldEvent(prev: IssueRecord | null, event: IssueEvent): IssueRecord {
  const obs = event.observation;
  const cls = event.classification;
  const lc = event.lifecycle;

  const record: IssueRecord =
    prev != null
      ? { ...prev }
      : {
          schemaVersion: ISSUE_SCHEMA_VERSION,
          issueId: event.issueId,
          fingerprint: event.fingerprint,
          title: obs?.title ?? 'Untitled issue',
          summary: obs?.summary ?? obs?.title ?? 'issue',
          state: 'needs_triage',
          category: cls?.category ?? 'mcp_limitation',
          severity: cls?.severity ?? 'low',
          confidence: cls?.confidence ?? 0.5,
          owner: cls?.owner,
          platform: event.platform,
          environment: event.environment,
          firstSeenAt: event.createdAt,
          lastSeenAt: event.createdAt,
          observationCount: 0,
        };

  // Keep the most descriptive title/summary if a later observation has one.
  if (obs?.title) record.title = obs.title;
  if (obs?.summary) record.summary = obs.summary;
  if (event.platform && record.platform == null) record.platform = event.platform;
  if (event.environment && record.environment == null) record.environment = event.environment;

  // Classification updates (latest classification wins for category/severity/owner/confidence).
  if (cls) {
    record.category = cls.category;
    record.severity = cls.severity;
    record.owner = cls.owner;
    record.confidence = cls.confidence;
  }

  mergeLinks(record, event.links);
  if (event.run) {
    const reportRef: ReportRef = { reportPath: event.run.reportPath, reportUri: event.run.reportUri };
    if (reportRef.reportPath || reportRef.reportUri) {
      record.reportRefs = mergeRefs<ReportRef>(record.reportRefs, [reportRef], (r) => `${r.reportPath ?? ''}|${r.reportUri ?? ''}`);
    }
    if (event.run.testCaseId) {
      record.testRefs = mergeRefs<TestRef>(record.testRefs, [{ testCaseId: event.run.testCaseId }], (r) => r.testCaseId);
    }
  }

  switch (event.eventType) {
    case 'observed': {
      record.observationCount += 1;
      record.lastSeenAt = event.createdAt;
      // Recurrence: an observation of a FIXED issue reopens it.
      if (record.state === 'fixed') {
        record.state = 'reopened';
        record.reopenedAt = event.createdAt;
        record.lastRecurrenceMessage = buildRecurrenceMessage(record);
      } else if (record.state === 'open' || record.state === 'observed_again') {
        record.state = 'observed_again';
      } else if (record.state === 'needs_triage') {
        // first observation of a noise/gate stays in its classified lane; otherwise open.
        record.state = isNoiseCategory(record) ? 'expected_environment_noise' : 'open';
      } else if (record.state === 'reopened') {
        // stays reopened, just bump counts
      } else if (record.state === 'suppressed' || record.state === 'expected_environment_noise') {
        // suppressed/noise: keep the lane (still visible in known-noise), bump counts only.
      }
      break;
    }
    case 'classified': {
      // pure re-classification of an existing record; lane derived from category.
      if (record.state === 'needs_triage') record.state = isNoiseCategory(record) ? 'expected_environment_noise' : 'open';
      break;
    }
    case 'fixed': {
      record.state = 'fixed';
      record.fixedAt = lc?.fixedAt ?? event.createdAt;
      record.fixedInCommit = lc?.fixedInCommit ?? event.sourceRevision?.commit ?? record.fixedInCommit;
      record.fixedInVersion = lc?.fixedInVersion ?? event.sourceRevision?.buildVersion ?? record.fixedInVersion;
      record.fixedBy = lc?.fixedBy ?? record.fixedBy;
      record.howFixed = lc?.howFixed ?? record.howFixed;
      break;
    }
    case 'reopened': {
      record.state = 'reopened';
      record.reopenedAt = lc?.reopenedAt ?? event.createdAt;
      record.lastRecurrenceMessage = lc?.recurrenceMessage ?? buildRecurrenceMessage(record);
      break;
    }
    case 'suppressed': {
      record.state = 'suppressed';
      record.suppressedUntil = lc?.suppressedUntil;
      record.suppressionReason = lc?.suppressionReason;
      record.suppressionScope = lc?.suppressionScope;
      break;
    }
    case 'triaged': {
      if (lc?.category) record.category = lc.category;
      if (lc?.severity) record.severity = lc.severity;
      if (lc?.owner) record.owner = lc.owner;
      break;
    }
    case 'linked_run': {
      // Evidence from a run (test case / audit check), not a state change — links already merged.
      // A `verified_fixed` link records that a passing run confirmed the fix still holds (REQ-08).
      if (event.relationship === 'verified_fixed' && record.state === 'fixed') {
        record.lastVerifiedFixedAt = event.createdAt;
      }
      break;
    }
    case 'note_added':
      // links already merged above; no state change.
      break;
  }

  // Apply any explicit state override carried on a lifecycle patch last.
  if (lc?.state) record.state = lc.state;
  return record;
}

function isNoiseCategory(record: IssueRecord): boolean {
  return record.category === 'environment_noise';
}

/** Replay an ordered event stream into the full set of index records (rebuild). */
export function rebuildRecords(events: IssueEvent[]): IssueRecord[] {
  const byId = new Map<string, IssueRecord>();
  for (const ev of events) {
    const prev = byId.get(ev.issueId) ?? null;
    byId.set(ev.issueId, foldEvent(prev, ev));
  }
  return [...byId.values()];
}

export const ALL_STATES_FOR_TEST: IssueState[] = ['open', 'fixed', 'reopened'];
