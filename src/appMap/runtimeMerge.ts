// Runtime merge (SWIPIUM-REQ-01 "Runtime Merge Requirements"). Folds a SerializedGraph from
// src/explore/graph.ts into AppKnowledgeMap.runtimeTopology. Node matching uses MULTIPLE signals
// (route/screen name, foreground owner, structured signature, visual signature, visible text
// tokens, locator/accessibility ids, screenshot, action label) so revisits dedupe instead of
// duplicating. Contradictory observations are preserved as versioned facts, never overwritten.

import type { SerializedGraph, ScreenNode } from '../explore/graph.js';
import type { AppKnowledgeMap, RuntimeScreen, StaticScreen } from './schema.js';

export interface MergeOptions {
  sessionId?: string;
  /** ISO timestamp for firstSeen/lastSeen. */
  at: string;
}

export interface MergeResult {
  newRuntimeScreens: number;
  updatedRuntimeScreens: number;
  linkedScreens: number;
  unmappedRuntimeScreens: number;
  unvisitedStaticScreens: number;
}

/** Static screens declared in code but not yet linked by any runtime screen. Shared so it can be
 *  recomputed after EVERY static scan (not only after a runtime merge) — otherwise a static-only
 *  map knows about static screens but reports zero unvisited (SWIPIUM-REQ-01). */
export function computeUnvisitedStaticScreens(map: AppKnowledgeMap): string[] {
  const linkedStaticIds = new Set(map.runtimeTopology.screens.map((r) => r.linkedStaticScreenId).filter(Boolean) as string[]);
  return map.staticTopology.screens.filter((s) => !linkedStaticIds.has(s.id)).map((s) => s.id);
}

function tokensFromNode(node: ScreenNode): string[] {
  const out = new Set<string>();
  if (node.title) for (const t of node.title.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3) out.add(t);
  for (const el of node.elements) {
    if (el.label) for (const t of el.label.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3) out.add(t);
  }
  return [...out].slice(0, 40);
}

function locatorIdsFromNode(node: ScreenNode): string[] {
  const out = new Set<string>();
  for (const el of node.elements) {
    if (el.locator && (el.locator.strategy === 'id' || el.locator.strategy === 'accessibility')) out.add(el.locator.value);
  }
  return [...out].slice(0, 40);
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter((x) => setB.has(x)).length;
  return inter / (a.length + b.length - inter);
}

/** Similarity 0..1 between an incoming runtime screen and an existing one, across signals. */
function screenSimilarity(a: RuntimeScreen, b: RuntimeScreen): number {
  if (a.signature && a.signature === b.signature) return 1;
  let score = 0;
  if (a.route && b.route && a.route === b.route) score += 0.4;
  if (a.title && b.title && a.title === b.title) score += 0.2;
  if (a.foregroundOwner && a.foregroundOwner === b.foregroundOwner) score += 0.2;
  if (a.screenshotHash && a.screenshotHash === b.screenshotHash) score += 0.3;
  const sharedLoc = a.locatorIds && b.locatorIds ? a.locatorIds.filter((x) => b.locatorIds!.includes(x)).length : 0;
  if (sharedLoc) score += Math.min(0.3, 0.1 * sharedLoc);
  score += 0.3 * jaccard(a.textTokens ?? [], b.textTokens ?? []);
  return Math.min(1, score);
}

/** Match an incoming runtime screen against existing static screens (multi-signal). */
function matchStaticScreen(rt: RuntimeScreen, statics: StaticScreen[]): { id: string; confidence: number } | null {
  let best: { id: string; confidence: number } | null = null;
  for (const s of statics) {
    let conf = 0;
    const sName = s.name.toLowerCase();
    const sRoute = (s.route ?? '').toLowerCase().replace(/^\//, '');
    if (rt.route && sRoute && rt.route.toLowerCase().replace(/^\//, '') === sRoute) conf = Math.max(conf, 0.9);
    if (rt.title && (rt.title.toLowerCase() === sName || rt.title.toLowerCase().includes(sName))) conf = Math.max(conf, 0.7);
    if (rt.foregroundOwner && rt.foregroundOwner.toLowerCase().includes(sName)) conf = Math.max(conf, 0.75);
    // token overlap between visible text and the static screen name
    if (rt.textTokens && rt.textTokens.some((t) => sName.includes(t) && t.length >= 4)) conf = Math.max(conf, 0.5);
    if (conf > 0 && (!best || conf > best.confidence)) best = { id: s.id, confidence: Math.round(conf * 100) / 100 };
  }
  return best && best.confidence >= 0.5 ? best : null;
}

function nextRuntimeId(map: AppKnowledgeMap): string {
  const n = map.runtimeTopology.screens.length + 1;
  return `r${n}`;
}

/** Convert an explore graph node into a normalized RuntimeScreen candidate. */
function toRuntimeScreen(node: ScreenNode, at: string): RuntimeScreen {
  return {
    id: '', // assigned on insert
    signature: node.signature,
    title: node.title,
    route: node.urlOrRoute,
    platform: node.platform,
    foregroundOwner: undefined,
    uiSignature: node.mode === 'structured' ? node.signature : undefined,
    visualSignature: node.mode === 'visual' ? node.signature : undefined,
    textTokens: tokensFromNode(node),
    locatorIds: locatorIdsFromNode(node),
    screenshotHash: node.screenshotUri,
    lastArtifactUris: [node.screenshotUri, node.dumpUri].filter((x): x is string => !!x),
    authState: node.authState,
    locatorReadiness: node.locatorQuality?.grade ?? 'unknown',
    firstSeen: at,
    lastSeen: at,
    visits: node.visits,
  };
}

/**
 * Merge a serialized explore graph into the map's runtime topology. Returns merge stats.
 * Re-running exploration UPDATES matched nodes (visits/lastSeen/artifacts) rather than duplicating.
 */
export function mergeRuntimeGraph(map: AppKnowledgeMap, graph: SerializedGraph, opts: MergeOptions): MergeResult {
  const stats: MergeResult = {
    newRuntimeScreens: 0,
    updatedRuntimeScreens: 0,
    linkedScreens: 0,
    unmappedRuntimeScreens: 0,
    unvisitedStaticScreens: 0,
  };
  if (opts.sessionId && !map.runtimeTopology.mergedFromSessions.includes(opts.sessionId)) {
    map.runtimeTopology.mergedFromSessions.push(opts.sessionId);
  }

  const graphIdToRuntimeId = new Map<string, string>();

  for (const node of graph.nodes) {
    const candidate = toRuntimeScreen(node, opts.at);
    // 1) match against existing runtime screens (dedupe revisits across sessions)
    let matched: RuntimeScreen | undefined;
    for (const existing of map.runtimeTopology.screens) {
      if (existing.platform !== candidate.platform) continue;
      if (screenSimilarity(candidate, existing) >= 0.7) {
        matched = existing;
        break;
      }
    }
    if (matched) {
      // preserve contradictory facts as versioned observations instead of blind overwrite
      const contra = matched.contradictions ?? [];
      if (candidate.title && matched.title && candidate.title !== matched.title) {
        contra.push({ at: opts.at, field: 'title', was: matched.title, now: candidate.title });
      }
      if (candidate.route && matched.route && candidate.route !== matched.route) {
        contra.push({ at: opts.at, field: 'route', was: matched.route, now: candidate.route });
      }
      matched.contradictions = contra.length ? contra.slice(-20) : matched.contradictions;
      matched.visits += candidate.visits;
      matched.lastSeen = opts.at;
      matched.locatorReadiness = candidate.locatorReadiness !== 'unknown' ? candidate.locatorReadiness : matched.locatorReadiness;
      matched.lastArtifactUris = [...new Set([...candidate.lastArtifactUris, ...matched.lastArtifactUris])].slice(0, 10);
      matched.textTokens = [...new Set([...(matched.textTokens ?? []), ...(candidate.textTokens ?? [])])].slice(0, 60);
      matched.locatorIds = [...new Set([...(matched.locatorIds ?? []), ...(candidate.locatorIds ?? [])])].slice(0, 60);
      if (candidate.authState) matched.authState = candidate.authState;
      stats.updatedRuntimeScreens++;
      graphIdToRuntimeId.set(node.id, matched.id);
    } else {
      candidate.id = nextRuntimeId(map);
      const link = matchStaticScreen(candidate, map.staticTopology.screens);
      if (link) {
        candidate.linkedStaticScreenId = link.id;
        candidate.linkConfidence = link.confidence;
        stats.linkedScreens++;
      } else {
        candidate.unmapped = true;
        stats.unmappedRuntimeScreens++;
      }
      map.runtimeTopology.screens.push(candidate);
      stats.newRuntimeScreens++;
      graphIdToRuntimeId.set(node.id, candidate.id);
    }
  }

  // edges (best-effort id mapping; skip edges whose endpoints didn't map)
  for (const e of graph.edges) {
    const from = graphIdToRuntimeId.get(e.from);
    const to = e.to ? graphIdToRuntimeId.get(e.to) : undefined;
    if (!from) continue;
    const existing = map.runtimeTopology.edges.find(
      (x) => x.from === from && x.to === to && x.action.type === e.action.type && x.action.targetDescription === e.action.targetDescription,
    );
    if (existing) {
      existing.observedCount++;
      existing.evidenceUris = [...new Set([...existing.evidenceUris, ...e.evidenceUris])].slice(0, 10);
    } else {
      map.runtimeTopology.edges.push({
        from,
        to,
        action: { type: e.action.type, targetDescription: e.action.targetDescription },
        outcome: e.outcome,
        evidenceUris: e.evidenceUris.slice(0, 10),
        observedCount: 1,
      });
    }
  }

  // unvisited static screens: declared in code but never linked by any runtime screen.
  map.runtimeTopology.unvisitedStaticScreens = computeUnvisitedStaticScreens(map);
  stats.unvisitedStaticScreens = map.runtimeTopology.unvisitedStaticScreens.length;

  // refresh feature coverage + runtime screen links
  for (const feature of map.features) {
    const featureRuntime = map.runtimeTopology.screens.filter(
      (r) => r.linkedStaticScreenId && feature.staticScreens.includes(r.linkedStaticScreenId),
    );
    feature.runtimeScreens = [...new Set(featureRuntime.map((r) => r.id))];
    if (!feature.runtimeScreens.length) {
      feature.testCoverage = feature.testCoverage === 'covered' ? 'covered' : 'none';
    } else {
      const coveredStatic = new Set(featureRuntime.map((r) => r.linkedStaticScreenId));
      feature.testCoverage =
        feature.staticScreens.length && feature.staticScreens.every((s) => coveredStatic.has(s)) ? 'covered' : 'partial';
    }
  }

  return stats;
}
