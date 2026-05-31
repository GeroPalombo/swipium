// Provenance + confidence helpers (SWIPIUM-REQ-01). Every fact in the app map must be traceable
// to a source (code scan, app config, runtime, ticket, user note, test case, report) and carry a
// confidence with machine-readable reason codes. These pure helpers keep that bookkeeping uniform.

import type { AppKnowledgeMap, ConfidenceEntry, ProvenanceEntry, ProvenanceSource } from './schema.js';

let provCounter = 0;

/** Deterministic-ish id without Date.now()/random (those are unavailable in some sandboxes). */
function nextProvId(source: ProvenanceSource): string {
  provCounter = (provCounter + 1) % 1_000_000;
  return `prov_${source}_${provCounter.toString(36)}`;
}

export function makeProvenance(
  source: ProvenanceSource,
  at: string,
  detail: string,
  opts: { refs?: string[]; targetType?: ProvenanceEntry['targetType']; targetId?: string } = {},
): ProvenanceEntry {
  return { id: nextProvId(source), source, at, detail, ...opts };
}

/** Append provenance, de-duplicating identical (source, detail, targetId) entries. */
export function addProvenance(map: AppKnowledgeMap, entry: ProvenanceEntry): void {
  const dup = map.provenance.find(
    (p) => p.source === entry.source && p.detail === entry.detail && p.targetId === entry.targetId && p.targetType === entry.targetType,
  );
  if (!dup) map.provenance.push(entry);
}

/** Combine independent confidence signals: more corroboration raises the score, capped < 1 for inference. */
export function combineConfidence(signals: number[]): number {
  if (!signals.length) return 0;
  // Noisy-OR style: 1 - Π(1 - s). Two 0.6 signals → 0.84; saturates toward but never reaches 1.
  const inv = signals.reduce((acc, s) => acc * (1 - Math.max(0, Math.min(1, s))), 1);
  return Math.round((1 - inv) * 100) / 100;
}

export function confidenceEntry(score: number, reasons: string[]): ConfidenceEntry {
  return { score: Math.round(Math.max(0, Math.min(1, score)) * 100) / 100, reasons };
}

/**
 * Recompute the per-feature / per-screen confidence summary and overall from the map's current
 * nodes. Runtime-corroborated screens get a small boost (observation beats inference).
 */
export function recomputeConfidence(map: AppKnowledgeMap): void {
  const features: Record<string, ConfidenceEntry> = {};
  for (const f of map.features) features[f.id] = confidenceEntry(f.confidence, f.reasons);

  const screens: Record<string, ConfidenceEntry> = {};
  for (const s of map.staticTopology.screens) {
    const linked = map.runtimeTopology.screens.some((r) => r.linkedStaticScreenId === s.id);
    const reasons = [...s.reasons, ...(linked ? ['runtime_observed'] : [])];
    screens[s.id] = confidenceEntry(linked ? combineConfidence([s.confidence, 0.7]) : s.confidence, reasons);
  }
  for (const r of map.runtimeTopology.screens) {
    if (r.unmapped) screens[r.id] = confidenceEntry(0.9, ['runtime_observed', 'unmapped_runtime_screen']);
  }

  const all = [...Object.values(features), ...Object.values(screens)].map((e) => e.score);
  const overall = all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 100) / 100 : 0;
  map.confidence = { overall, features, screens };
}
