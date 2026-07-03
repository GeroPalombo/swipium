// SWIPIUM-REQ-08 — derive compact app-map issue summaries from the durable issue ledger.
//
// The issue ledger (`.swipium/issues-log.jsonl`) stays the source of truth. This module reads the
// issue index + events and attaches a small `AppMapIssueSummary` to the screens/features an issue is
// confidently associated with — counts + pointers only, never full events. Rebuilt on every app-map
// refresh, so deleting the issue index and rebuilding loses nothing once the map is refreshed.
//
// PURE w.r.t. the clock (now is injected). Reads the ledger via src/issues/store.

import { combineReleaseImpact, defaultReleaseImpact, type IssueRecord } from '../issues/schema.js';
import { getIndex, readEvents } from '../issues/store.js';
import { loadSuite } from '../testSuite/store.js';
import type { AppKnowledgeMap, AppMapIssueSummary, FeatureNode, RuntimeScreen, StaticScreen } from './schema.js';

/** Categorize a record into the summary buckets. A record can land in several derived buckets. */
function isOpen(r: IssueRecord): boolean {
  return (r.state === 'open' || r.state === 'observed_again' || r.state === 'needs_triage') && r.category !== 'environment_noise';
}
function isRecurring(r: IssueRecord): boolean {
  return r.state === 'reopened' || Boolean(r.lastRecurrenceMessage);
}
function isKnownNoise(r: IssueRecord): boolean {
  return r.state === 'expected_environment_noise' || r.state === 'suppressed' || r.category === 'environment_noise';
}

const SEVERITY_RANK: Record<string, number> = { blocker: 5, high: 4, medium: 3, low: 2, info: 1 };

/** Build a compact issue summary from the subset of issue records mapped to a screen/feature. */
export function buildAppMapIssueSummary(records: IssueRecord[], now: string): AppMapIssueSummary {
  const open = records.filter(isOpen);
  const recurring = records.filter(isRecurring);
  const hardGate = records.filter((r) => r.category === 'hard_gate');
  const storeCompliance = records.filter((r) => r.category === 'store_compliance' || r.category === 'security_privacy');
  const knownNoise = records.filter(isKnownNoise);
  const improvement = records.filter((r) => r.category === 'improvement' || r.category === 'accessibility_readiness');
  const fixed = records.filter((r) => r.state === 'fixed');

  // Release impact rolls up non-suppressed, non-fixed, real-defect/gate/compliance records.
  const impacts = records
    .filter(
      (r) =>
        r.state !== 'suppressed' && r.state !== 'expected_environment_noise' && r.state !== 'fixed' && r.category !== 'environment_noise',
    )
    .map((r) => defaultReleaseImpact(r.category, r.severity));

  const ids = (rs: IssueRecord[]) => rs.map((r) => r.issueId);
  const lastIssueSeenAt = records.reduce<string | undefined>((max, r) => (!max || r.lastSeenAt > max ? r.lastSeenAt : max), undefined);
  const topIssueIds = records
    .slice()
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || (b.lastSeenAt > a.lastSeenAt ? 1 : -1))
    .slice(0, 5)
    .map((r) => r.issueId);

  return {
    openIssueIds: ids(open),
    recurringIssueIds: ids(recurring),
    hardGateIssueIds: ids(hardGate),
    storeComplianceIssueIds: ids(storeCompliance),
    knownNoiseIssueIds: ids(knownNoise),
    improvementIssueIds: ids(improvement),
    fixedIssueIds: ids(fixed),
    counts: {
      open: open.length,
      recurring: recurring.length,
      hardGate: hardGate.length,
      storeCompliance: storeCompliance.length,
      knownNoise: knownNoise.length,
      improvement: improvement.length,
      fixed: fixed.length,
    },
    releaseImpact: combineReleaseImpact(impacts),
    lastIssueSeenAt,
    topIssueIds,
    updatedAt: now,
  };
}

/**
 * Build per-issue screen/feature associations from the event log (mapping rules in REQ-08 order):
 *   1. explicit links.appMapRefs (screenId/featureId)
 *   2. observation.screenId matching a runtime/static screen id
 *   3. observation.screenPurpose matching a runtime screen purpose
 * Issues with no confident mapping stay project-level only (never attached to a random screen).
 */
export function issueAssociations(root: string, map: AppKnowledgeMap): Map<string, { screenIds: Set<string>; featureIds: Set<string> }> {
  const assoc = new Map<string, { screenIds: Set<string>; featureIds: Set<string> }>();
  const ensure = (id: string) => {
    let a = assoc.get(id);
    if (!a) assoc.set(id, (a = { screenIds: new Set(), featureIds: new Set() }));
    return a;
  };
  const runtimeIds = new Set(map.runtimeTopology.screens.map((s) => s.id));
  const staticIds = new Set(map.staticTopology.screens.map((s) => s.id));
  const purposeIndex = new Map<string, string[]>(); // purpose(lower) → runtime screen ids
  for (const s of map.runtimeTopology.screens) {
    if (s.purpose) {
      const key = s.purpose.toLowerCase();
      purposeIndex.set(key, [...(purposeIndex.get(key) ?? []), s.id]);
    }
  }

  for (const ev of readEvents(root)) {
    const a = ensure(ev.issueId);
    // 1. explicit app-map refs.
    for (const ref of ev.links?.appMapRefs ?? []) {
      if (ref.screenId) a.screenIds.add(ref.screenId);
      if (ref.featureId) a.featureIds.add(ref.featureId);
    }
    const obs = ev.observation;
    if (obs?.screenId) {
      // 2. screen id that matches a known screen.
      if (runtimeIds.has(obs.screenId) || staticIds.has(obs.screenId)) a.screenIds.add(obs.screenId);
    }
    // 3. screen purpose → runtime screens with that purpose.
    if (obs?.screenPurpose) {
      for (const sid of purposeIndex.get(obs.screenPurpose.toLowerCase()) ?? []) a.screenIds.add(sid);
    }
  }

  // Roll screen associations up to the features that contain those screens.
  for (const f of map.features) {
    const owned = new Set([...f.staticScreens, ...f.runtimeScreens]);
    for (const [issueId, a] of assoc) {
      if ([...a.screenIds].some((sid) => owned.has(sid))) a.featureIds.add(f.id);
      void issueId;
    }
  }

  // 4. observation.workflow → test-suite case → feature. Read the persistent suite's COMPACT issue
  // links (issue id + featureId only — never case history) so an issue attached only to a test case
  // still shows up on the owning feature's summary (REQ-08 follow-up).
  try {
    const suite = loadSuite(root, map.appIdentity?.androidPackage ?? undefined);
    for (const c of suite.cases) {
      if (!c.featureId) continue;
      for (const ref of c.issueRefs ?? []) ensure(ref.issueId).featureIds.add(c.featureId);
      for (const run of c.history ?? []) for (const link of run.issueLinks ?? []) ensure(link.issueId).featureIds.add(c.featureId);
    }
  } catch {
    /* best-effort — suite is optional */
  }
  return assoc;
}

/**
 * Attach derived issue summaries to the map's screens + features from the issue ledger. Clears stale
 * summaries when an issue no longer maps to a node. The map keeps only counts + ids.
 */
export function applyIssueSummariesToAppMap(
  map: AppKnowledgeMap,
  root: string,
  now: string,
): { screensWithIssues: number; featuresWithIssues: number } {
  const index = getIndex(root, now, map.appIdentity?.androidPackage ?? undefined);
  const byId = new Map(index.records.map((r) => [r.issueId, r]));
  if (index.records.length === 0) {
    // No ledger yet — clear any stale summaries and return.
    for (const s of map.runtimeTopology.screens) delete s.issueSummary;
    for (const s of map.staticTopology.screens) delete s.issueSummary;
    for (const f of map.features) delete f.issueSummary;
    return { screensWithIssues: 0, featuresWithIssues: 0 };
  }
  const assoc = issueAssociations(root, map);

  const recordsForScreen = (screenId: string): IssueRecord[] => {
    const out: IssueRecord[] = [];
    for (const [issueId, a] of assoc) {
      if (a.screenIds.has(screenId)) {
        const r = byId.get(issueId);
        if (r) out.push(r);
      }
    }
    return out;
  };
  const recordsForFeature = (featureId: string): IssueRecord[] => {
    const out: IssueRecord[] = [];
    for (const [issueId, a] of assoc) {
      if (a.featureIds.has(featureId)) {
        const r = byId.get(issueId);
        if (r) out.push(r);
      }
    }
    return out;
  };

  let screensWithIssues = 0;
  let featuresWithIssues = 0;
  const applyTo = (node: RuntimeScreen | StaticScreen, recs: IssueRecord[]): boolean => {
    if (recs.length === 0) {
      delete node.issueSummary;
      return false;
    }
    node.issueSummary = buildAppMapIssueSummary(recs, now);
    return true;
  };

  for (const s of map.runtimeTopology.screens) if (applyTo(s, recordsForScreen(s.id))) screensWithIssues++;
  for (const s of map.staticTopology.screens) if (applyTo(s, recordsForScreen(s.id))) screensWithIssues++;
  for (const f of map.features) {
    const recs = recordsForFeature(f.id);
    if (recs.length === 0) {
      delete f.issueSummary;
      continue;
    }
    (f as FeatureNode).issueSummary = buildAppMapIssueSummary(recs, now);
    featuresWithIssues++;
  }
  return { screensWithIssues, featuresWithIssues };
}
