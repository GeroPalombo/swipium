import type { ExploreEdge, ExploreGraph, ScreenNode } from './graph.js';

export interface SuitePromotionCandidate {
  path: string[];
  score: number;
  status: 'promote' | 'reject';
  reasons: string[];
}

function nodeById(nodes: ScreenNode[]): Map<string, ScreenNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function scoreEdge(edge: ExploreEdge, nodes: Map<string, ScreenNode>): { score: number; reasons: string[] } {
  const to = edge.to ? nodes.get(edge.to) : undefined;
  const reasons: string[] = [];
  let score = 0;
  if (edge.outcome === 'changed_screen') {
    score += 30;
    reasons.push('changes screen');
  }
  if (edge.action.locator) {
    const durability = String(edge.action.locator.durability ?? '');
    if (durability === 'high') score += 30;
    else if (durability === 'medium') score += 15;
    else score -= 20;
  } else {
    score -= 25;
    reasons.push('no structured locator provenance');
  }
  if (to?.locatorQuality?.grade === 'A' || to?.locatorQuality?.grade === 'B') score += 15;
  if (to?.mode === 'visual') {
    score -= 15;
    reasons.push('depends on visual-only screen');
  }
  if (edge.outcome === 'unsafe_refused' || /destructive|payment|delete|send/i.test(edge.riskDecision ?? '')) {
    score -= 50;
    reasons.push('unsafe or destructive path');
  }
  return { score, reasons };
}

export function scorePromotionCandidates(graph: ExploreGraph): SuitePromotionCandidate[] {
  const nodes = nodeById(graph.allNodes());
  const candidates = graph
    .allEdges()
    .filter((edge) => edge.outcome === 'changed_screen' && edge.to)
    .map((edge) => {
      const scored = scoreEdge(edge, nodes);
      const path = [edge.from, edge.to!];
      const status = scored.score >= 45 ? 'promote' : 'reject';
      return {
        path,
        score: scored.score,
        status,
        reasons:
          status === 'promote'
            ? ['semantic path has enough replay confidence', ...scored.reasons]
            : ['replay confidence below threshold', ...scored.reasons],
      } satisfies SuitePromotionCandidate;
    });
  return candidates.sort((a, b) => b.score - a.score);
}
