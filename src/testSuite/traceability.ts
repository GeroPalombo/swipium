// Traceability helpers (SWIPIUM-REQ-06 "Integration Requirements"). PURE. Build the links that tie a
// canonical case back to the app map, runtime screens, source files, tickets, requirements, and
// evidence so the persistent suite is navigable rather than a flat list of steps.

import type { AppMapLink, EvidenceRef } from './schema.js';

/** Build app-map links from POM page names + the runtime screens touched while recording. */
export function buildMapLinks(input: { pages?: string[]; screens?: string[]; featureId?: string }): AppMapLink[] {
  const links: AppMapLink[] = [];
  const seen = new Set<string>();
  const push = (kind: AppMapLink['kind'], id: string, label?: string) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ kind, id, ...(label ? { label } : {}) });
  };
  if (input.featureId) push('feature', input.featureId);
  for (const p of input.pages ?? []) push('static_screen', p, p);
  for (const s of input.screens ?? []) push('runtime_screen', s);
  return links;
}

/** Normalize a list of evidence URIs/records into EvidenceRef[], de-duped by uri. */
export function buildEvidence(uris: Array<string | EvidenceRef | undefined | null>): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const u of uris) {
    if (!u) continue;
    const ref: EvidenceRef = typeof u === 'string' ? { uri: u } : u;
    if (!ref.uri || seen.has(ref.uri)) continue;
    seen.add(ref.uri);
    out.push(ref);
  }
  return out;
}

/** Pull ticket-like and requirement-like tokens out of a free-text label (e.g. "JIRA-123", "SWIPIUM-REQ-06"). */
export function extractRefs(text: string | undefined): { ticketRefs: string[]; requirementRefs: string[] } {
  const ticketRefs: string[] = [];
  const requirementRefs: string[] = [];
  if (!text) return { ticketRefs, requirementRefs };
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]+-(?:REQ-)?\d+)\b/g)) {
    const token = m[1];
    if (/-REQ-/.test(token)) requirementRefs.push(token);
    else ticketRefs.push(token);
  }
  return { ticketRefs: Array.from(new Set(ticketRefs)), requirementRefs: Array.from(new Set(requirementRefs)) };
}
