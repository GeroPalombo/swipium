// SWIPIUM-REQ-08 — issue quality metrics, derived from the append-only EVENT log (not just current
// index state) so trends are honest: opened / fixed / reopened / verified-fixed counts, issue aging,
// reopen rate (fixed issues that later reopened), fix-verification rate (fixed issues with a
// verified_fixed event), and a time/version/category series. PURE — `until` is the reference clock.

import { rebuildRecords } from './recurrence.js';
import type { IssueEvent, IssueRecord } from './schema.js';

export type MetricsGroupBy = 'day' | 'week' | 'version' | 'commit' | 'category' | 'owner' | 'screen' | 'feature';

export interface IssueMetrics {
  opened: number;
  fixed: number;
  reopened: number;
  verifiedFixed: number;
  suppressed: number;
  environmentNoise: number;
  avgAgeDays: number;
  p95AgeDays: number;
  reopenRatePct: number;
  fixVerificationRatePct: number;
  blockerOpenCount: number;
  highOpenCount: number;
  topRecurringIssues: IssueRecord[];
  topAgingIssues: IssueRecord[];
  series: Array<{ bucket: string; opened: number; fixed: number; reopened: number; verifiedFixed: number }>;
}

export interface MetricsOptions {
  since?: string;
  until?: string;
  groupBy?: MetricsGroupBy;
  includeSuppressed?: boolean;
}

function inRange(at: string, since?: string, until?: string): boolean {
  if (since && at < since) return false;
  if (until && at > until) return false;
  return true;
}

function isoWeek(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function bucketKey(ev: IssueEvent, groupBy: MetricsGroupBy): string {
  switch (groupBy) {
    case 'day':
      return ev.createdAt.slice(0, 10);
    case 'week':
      return isoWeek(ev.createdAt);
    case 'version':
      return ev.sourceRevision?.buildVersion ?? 'unknown';
    case 'commit':
      return ev.sourceRevision?.commit ?? 'unknown';
    case 'category':
      return ev.classification?.category ?? 'unknown';
    case 'owner':
      return ev.classification?.owner ?? 'unknown';
    case 'screen':
      return ev.links?.appMapRefs?.[0]?.screenId ?? ev.observation?.screenId ?? 'unknown';
    case 'feature':
      return ev.links?.appMapRefs?.[0]?.featureId ?? 'unknown';
    default:
      return ev.createdAt.slice(0, 10);
  }
}

function ageDays(fromIso: string, untilIso: string): number {
  const a = new Date(fromIso).getTime();
  const b = new Date(untilIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, (b - a) / 86400000);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Compute issue metrics from the full event stream. `until` defaults to the latest event time. */
export function computeIssueMetrics(events: IssueEvent[], opts: MetricsOptions = {}): IssueMetrics {
  const groupBy = opts.groupBy ?? 'week';
  const until = opts.until ?? events.reduce<string>((m, e) => (e.createdAt > m ? e.createdAt : m), '1970-01-01T00:00:00.000Z');
  const records = rebuildRecords(events);

  // First-observation EVENT per issue → "opened". Track the event id (not just the timestamp) so
  // two same-timestamp observations of one fingerprint count as a single open (REQ-08 follow-up).
  const firstObserved = new Map<string, { at: string; eventId: string }>();
  for (const e of events) {
    if (e.eventType !== 'observed') continue;
    const prev = firstObserved.get(e.issueId);
    if (!prev || e.createdAt < prev.at) firstObserved.set(e.issueId, { at: e.createdAt, eventId: e.eventId });
  }

  let opened = 0;
  for (const [, first] of firstObserved) if (inRange(first.at, opts.since, opts.until)) opened++;

  let fixed = 0;
  let reopened = 0;
  let verifiedFixed = 0;
  let suppressed = 0;
  const everFixed = new Set<string>();
  const fixedThenReopened = new Set<string>();
  const verifiedFixedIssues = new Set<string>();
  const fixedAtById = new Map<string, string>();
  const series = new Map<string, { opened: number; fixed: number; reopened: number; verifiedFixed: number }>();
  const bump = (key: string, field: 'opened' | 'fixed' | 'reopened' | 'verifiedFixed') => {
    const b = series.get(key) ?? { opened: 0, fixed: 0, reopened: 0, verifiedFixed: 0 };
    b[field]++;
    series.set(key, b);
  };

  for (const e of events) {
    const within = inRange(e.createdAt, opts.since, opts.until);
    if (e.eventType === 'observed' && firstObserved.get(e.issueId)?.eventId === e.eventId && within) bump(bucketKey(e, groupBy), 'opened');
    if (e.eventType === 'fixed') {
      everFixed.add(e.issueId);
      fixedAtById.set(e.issueId, e.createdAt);
      if (within) {
        fixed++;
        bump(bucketKey(e, groupBy), 'fixed');
      }
    }
    if (e.eventType === 'reopened') {
      // a reopen counts toward reopen-rate only if it followed a fix.
      if (everFixed.has(e.issueId)) fixedThenReopened.add(e.issueId);
      if (within) {
        reopened++;
        bump(bucketKey(e, groupBy), 'reopened');
      }
    }
    if (e.eventType === 'linked_run' && e.relationship === 'verified_fixed') {
      verifiedFixedIssues.add(e.issueId);
      if (within) {
        verifiedFixed++;
        bump(bucketKey(e, groupBy), 'verifiedFixed');
      }
    }
    if (e.eventType === 'suppressed' && within) suppressed++;
  }

  const noiseIssues = records.filter(
    (r) =>
      (opts.includeSuppressed || r.state !== 'suppressed') &&
      (r.category === 'environment_noise' || r.state === 'expected_environment_noise'),
  );
  const openRecords = records.filter(
    (r) => r.state === 'open' || r.state === 'observed_again' || r.state === 'reopened' || r.state === 'needs_triage',
  );
  const ages = openRecords.map((r) => ageDays(r.firstSeenAt, until)).sort((a, b) => a - b);
  const avgAgeDays = ages.length ? Number((ages.reduce((s, v) => s + v, 0) / ages.length).toFixed(2)) : 0;
  const p95AgeDays = Number(percentile(ages, 95).toFixed(2));

  const reopenRatePct = everFixed.size ? Number(((fixedThenReopened.size / everFixed.size) * 100).toFixed(1)) : 0;
  const fixVerificationRatePct = everFixed.size ? Number(((verifiedFixedIssues.size / everFixed.size) * 100).toFixed(1)) : 0;

  const topRecurringIssues = records
    .filter((r) => r.lastRecurrenceMessage || r.state === 'reopened')
    .sort((a, b) => (b.lastSeenAt > a.lastSeenAt ? 1 : -1))
    .slice(0, 5);
  const topAgingIssues = openRecords
    .slice()
    .sort((a, b) => ageDays(b.firstSeenAt, until) - ageDays(a.firstSeenAt, until))
    .slice(0, 5);

  return {
    opened,
    fixed,
    reopened,
    verifiedFixed,
    suppressed,
    environmentNoise: noiseIssues.length,
    avgAgeDays,
    p95AgeDays,
    reopenRatePct,
    fixVerificationRatePct,
    blockerOpenCount: openRecords.filter((r) => r.severity === 'blocker').length,
    highOpenCount: openRecords.filter((r) => r.severity === 'high').length,
    topRecurringIssues,
    topAgingIssues,
    series: [...series.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([bucket, v]) => ({ bucket, ...v })),
  };
}
