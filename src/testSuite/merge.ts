// Merge engine for the persistent suite (SWIPIUM-REQ-06 "Merge and Maintenance Requirements"). PURE
// + deterministic: given the existing suite and a batch of incoming cases, decide what is created,
// updated, deprecated, and which fields conflict with human edits. Every run that observes or
// generates QA knowledge funnels through here so stable IDs, dedup, provenance, and the per-case run
// ledger are enforced in one place. Time is passed in (never read from the clock) so it is testable.

import {
  type CanonicalTestCase,
  type TestSuiteFile,
  type ProvenanceSource,
  type TestRunRef,
  type AutomationStatus,
  GENERATED_FIELDS,
  caseIdentity,
  idPrefix,
} from './schema.js';

export type MergeMode = 'append' | 'update' | 'replace_generated';

export interface MergeConflict {
  id: string;
  field: string;
  reason: string;
}

export interface MergeOptions {
  source: ProvenanceSource;
  mode: MergeMode;
  now: string;
  runId: string;
  sourceUri?: string;
  /** Feature IDs that still exist in the current app map; an active case whose feature disappears is deprecated. */
  liveFeatureIds?: string[];
}

export interface MergeResult {
  suite: TestSuiteFile;
  created: string[];
  updated: string[];
  deprecated: string[];
  unchanged: string[];
  conflicts: MergeConflict[];
}

const AUTOMATION_RANK: Record<AutomationStatus, number> = {
  not_automatable_yet: 0,
  manual: 1,
  candidate: 2,
  partial: 3,
  automated: 4,
};

/** Allocate the next free `TC-<PREFIX>-NNN` id, skipping live + retired ids so nothing is ever reused. */
function allocateId(functionality: string, used: Set<string>): string {
  const prefix = idPrefix(functionality);
  let n = 1;
  let id = `TC-${prefix}-${String(n).padStart(3, '0')}`;
  while (used.has(id)) {
    n += 1;
    id = `TC-${prefix}-${String(n).padStart(3, '0')}`;
  }
  used.add(id);
  return id;
}

function uniq<T>(...lists: T[][]): T[] {
  return Array.from(new Set(lists.flat()));
}

/** Decide the surviving automation link: never regress readiness/status; union assets. */
function mergeAutomation(
  existing: CanonicalTestCase['automation'],
  incoming: CanonicalTestCase['automation'],
): CanonicalTestCase['automation'] {
  const better = AUTOMATION_RANK[incoming.status] >= AUTOMATION_RANK[existing.status] ? incoming : existing;
  return {
    status: better.status,
    framework: incoming.framework ?? existing.framework,
    pageObjects: uniq(existing.pageObjects, incoming.pageObjects),
    testFiles: uniq(existing.testFiles, incoming.testFiles),
    // Locator readiness: keep the stronger grade (A < B < C < D where A is best).
    locatorReadiness: existing.locatorReadiness <= incoming.locatorReadiness ? existing.locatorReadiness : incoming.locatorReadiness,
    replayStatus: incoming.replayStatus !== 'not_replayed' ? incoming.replayStatus : existing.replayStatus,
  };
}

function runRefFrom(c: CanonicalTestCase, opts: MergeOptions): TestRunRef | null {
  if (c.actualResult.status === 'not_run') return null;
  return {
    runId: opts.runId,
    at: opts.now,
    status: c.actualResult.status,
    summary: c.actualResult.summary,
    source: opts.source,
    evidence: c.actualResult.evidence,
  };
}

/** Update an existing case in place (returns a new object), recording conflicts for protected fields. */
function applyUpdate(
  existing: CanonicalTestCase,
  incoming: CanonicalTestCase,
  opts: MergeOptions,
  conflicts: MergeConflict[],
): CanonicalTestCase {
  const protect = !!existing.manuallyEdited && opts.mode !== 'replace_generated';
  const next: CanonicalTestCase = { ...existing };

  // Generated content fields — protected when a human has curated them (unless replace_generated).
  const existingRec = existing as unknown as Record<string, unknown>;
  const incomingRec = incoming as unknown as Record<string, unknown>;
  const nextRec = next as unknown as Record<string, unknown>;
  for (const field of GENERATED_FIELDS) {
    const inVal = incomingRec[field];
    if (inVal === undefined) continue;
    if (field === 'automation') {
      next.automation = mergeAutomation(existing.automation, incoming.automation);
      continue;
    }
    if (protect && JSON.stringify(existingRec[field]) !== JSON.stringify(inVal)) {
      conflicts.push({ id: existing.id, field, reason: 'manually curated — not overwritten (use mergeMode replace_generated to force)' });
      continue;
    }
    nextRec[field] = inVal;
  }

  // Run facts always update — they describe reality, not curated intent.
  if (incoming.actualResult.status !== 'not_run' || existing.actualResult.status === 'not_run') {
    next.actualResult = {
      ...incoming.actualResult,
      lastRunAt: incoming.actualResult.status !== 'not_run' ? opts.now : existing.actualResult.lastRunAt,
      evidence: uniq(existing.actualResult.evidence, incoming.actualResult.evidence),
    };
  }
  next.evidence = dedupeEvidence([...existing.evidence, ...incoming.evidence]);
  next.ticketRefs = uniq(existing.ticketRefs, incoming.ticketRefs);
  next.requirementRefs = uniq(existing.requirementRefs, incoming.requirementRefs);
  next.tags = uniq(existing.tags, incoming.tags);

  // Status: a blocked run blocks the case; a deprecated case stays deprecated until features return.
  if (incoming.status === 'blocked') next.status = 'blocked';
  else if (existing.status === 'blocked' && incoming.actualResult.status === 'pass') next.status = 'active';

  const run = runRefFrom(incoming, opts);
  if (run) next.history = [...existing.history, run];

  next.provenance = [
    ...existing.provenance,
    { source: opts.source, at: opts.now, sourceUri: opts.sourceUri, fields: GENERATED_FIELDS.slice() },
  ];
  next.updatedAt = opts.now;
  return next;
}

function dedupeEvidence(items: CanonicalTestCase['evidence']): CanonicalTestCase['evidence'] {
  const seen = new Set<string>();
  const out: CanonicalTestCase['evidence'] = [];
  for (const e of items) {
    if (seen.has(e.uri)) continue;
    seen.add(e.uri);
    out.push(e);
  }
  return out;
}

/**
 * Merge `incoming` canonical cases into `suite`. Incoming cases may carry a blank id (`''`) — a new
 * stable id is allocated; a non-blank id or an identity match updates the existing case instead of
 * creating a duplicate.
 */
export function mergeCases(suite: TestSuiteFile, incoming: CanonicalTestCase[], opts: MergeOptions): MergeResult {
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const conflicts: MergeConflict[] = [];

  const cases = suite.cases.map((c) => ({ ...c }));
  const byId = new Map(cases.map((c) => [c.id, c] as const));
  const byIdentity = new Map(cases.map((c) => [caseIdentity(c), c] as const));
  const used = new Set<string>([...cases.map((c) => c.id), ...suite.retiredIds]);
  const touched = new Set<string>();

  for (const inc of incoming) {
    const match = (inc.id && byId.get(inc.id)) || byIdentity.get(caseIdentity(inc));
    if (match) {
      if (opts.mode === 'append') {
        unchanged.push(match.id);
        touched.add(match.id);
        continue;
      }
      const next = applyUpdate(match, inc, opts, conflicts);
      const idx = cases.indexOf(match);
      cases[idx] = next;
      byId.set(next.id, next);
      byIdentity.set(caseIdentity(next), next);
      updated.push(next.id);
      touched.add(next.id);
    } else {
      const id = inc.id && !used.has(inc.id) ? (used.add(inc.id), inc.id) : allocateId(inc.functionality, used);
      const run = runRefFrom({ ...inc, id }, opts);
      const fresh: CanonicalTestCase = {
        ...inc,
        id,
        createdAt: opts.now,
        updatedAt: opts.now,
        history: run ? [run] : [],
        provenance: [{ source: opts.source, at: opts.now, sourceUri: opts.sourceUri, fields: GENERATED_FIELDS.slice() }],
      };
      cases.push(fresh);
      byId.set(id, fresh);
      byIdentity.set(caseIdentity(fresh), fresh);
      created.push(id);
      touched.add(id);
    }
  }

  // Deprecate active cases whose linked feature has disappeared from the current map.
  const deprecated: string[] = [];
  const retiredIds = new Set(suite.retiredIds);
  if (opts.liveFeatureIds && opts.liveFeatureIds.length) {
    const live = new Set(opts.liveFeatureIds);
    for (const c of cases) {
      if (c.status === 'deprecated' || c.status === 'manual_only') continue;
      if (touched.has(c.id)) continue;
      if (c.manuallyEdited) continue; // never auto-deprecate human-curated cases
      if (!live.has(c.featureId)) {
        c.status = 'deprecated';
        c.updatedAt = opts.now;
        c.provenance = [
          ...c.provenance,
          { source: opts.source, at: opts.now, note: 'auto-deprecated: linked feature no longer in app map' },
        ];
        deprecated.push(c.id);
        retiredIds.add(c.id);
      }
    }
  }

  const next: TestSuiteFile = {
    schemaVersion: suite.schemaVersion,
    updatedAt: opts.now,
    appId: suite.appId,
    cases,
    retiredIds: Array.from(retiredIds),
  };
  return { suite: next, created, updated, deprecated, unchanged, conflicts };
}
