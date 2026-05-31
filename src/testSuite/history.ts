// Per-case run-history ledger helpers (SWIPIUM-REQ-06 "Keep a run history ledger for each case").
// PURE. A TestRunRef is appended on every merge that carries a real run result (merge.ts); these
// helpers summarize the ledger for reporting and for the persisted per-run files (store.recordRun).

import type { CanonicalTestCase, TestRunRef, ActualStatus } from './schema.js';

export interface CaseHistorySummary {
  id: string;
  runs: number;
  lastStatus: ActualStatus | 'not_run';
  lastRunAt?: string;
  passRate: number; // 0..1 over runs that actually executed (excludes not_run/skipped)
}

export function summarizeCaseHistory(c: CanonicalTestCase): CaseHistorySummary {
  const runs = c.history;
  const executed = runs.filter((r) => r.status === 'pass' || r.status === 'fail');
  const passes = executed.filter((r) => r.status === 'pass').length;
  const last = runs[runs.length - 1];
  return {
    id: c.id,
    runs: runs.length,
    lastStatus: last?.status ?? c.actualResult.status,
    lastRunAt: last?.at ?? c.actualResult.lastRunAt,
    passRate: executed.length ? passes / executed.length : 0,
  };
}

/** A persisted per-run ledger file (`.swipium/test-runs/<ts>.json`) capturing what one merge observed. */
export interface RunLedger {
  runId: string;
  at: string;
  source: string;
  sourceUri?: string;
  created: string[];
  updated: string[];
  deprecated: string[];
  results: Array<Pick<TestRunRef, 'runId' | 'at' | 'status' | 'summary' | 'evidence'> & { caseId: string }>;
}

/** Build a run-ledger record from a merged suite + the ids touched this run. */
export function buildRunLedger(
  cases: CanonicalTestCase[],
  opts: { runId: string; at: string; source: string; sourceUri?: string; created: string[]; updated: string[]; deprecated: string[] },
): RunLedger {
  const touched = new Set([...opts.created, ...opts.updated]);
  const results = cases
    .filter((c) => touched.has(c.id))
    .map((c) => {
      const last = c.history[c.history.length - 1];
      return {
        caseId: c.id,
        runId: opts.runId,
        at: last?.at ?? opts.at,
        status: c.actualResult.status,
        summary: c.actualResult.summary,
        evidence: c.actualResult.evidence,
      };
    });
  return {
    runId: opts.runId,
    at: opts.at,
    source: opts.source,
    sourceUri: opts.sourceUri,
    created: opts.created,
    updated: opts.updated,
    deprecated: opts.deprecated,
    results,
  };
}
