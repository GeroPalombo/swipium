// Map query (SWIPIUM-REQ-01 qa_app_map_query). Searches the feature index, static topology, runtime
// graph, and tests, returning RANKED results with provenance, confidence, source files,
// screens, and a recommended next Swipium tool call. Pure + deterministic so it is unit-testable.

import { fileMatchDimensions, scoreFile, type CodeIndex } from './codeIndex.js';
import type { AppKnowledgeMap } from './schema.js';

export type QueryIntent = 'feature' | 'screen' | 'code' | 'test' | 'freeform';

export interface RecommendedTool {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface QueryResult {
  type: 'feature' | 'screen' | 'code' | 'test';
  id: string;
  title: string;
  score: number;
  confidence?: number;
  provenance: string[];
  sourceFiles: string[];
  screens: string[];
  recommendedNextTool: RecommendedTool;
}

export interface QueryOutput {
  query: string;
  intent: QueryIntent;
  results: QueryResult[];
  total: number;
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
}

const STOP = new Set(['the', 'and', 'for', 'with', 'test', 'app', 'feature', 'screen', 'flow', 'page']);

function termHits(haystack: string, ts: string[]): number {
  const lower = haystack.toLowerCase();
  return ts.filter((t) => lower.includes(t)).length;
}

export function queryAppMap(
  map: AppKnowledgeMap,
  codeIndex: CodeIndex | null,
  opts: { query: string; intent?: QueryIntent; limit?: number },
): QueryOutput {
  const intent = opts.intent ?? 'freeform';
  const limit = opts.limit ?? 10;
  const ts = terms(opts.query).filter((t) => !STOP.has(t));
  const results: QueryResult[] = [];

  const wantsFeature = intent === 'feature' || intent === 'freeform';
  const wantsScreen = intent === 'screen' || intent === 'freeform';
  const wantsCode = intent === 'code' || intent === 'freeform';
  const wantsTest = intent === 'test' || intent === 'freeform';
  const textTokensByFile = new Map<string, Set<string>>();
  for (const f of codeIndex?.files ?? []) {
    if (f.textTokens?.length) textTokensByFile.set(f.file, new Set(f.textTokens));
  }
  const fileTextHits = (file: string): number => {
    const tokens = textTokensByFile.get(file);
    if (!tokens) return 0;
    return ts.filter((t) => tokens.has(t)).length;
  };

  if (wantsFeature) {
    for (const f of map.features) {
      const hay = `${f.title} ${f.objective ?? ''} ${f.reasons.join(' ')} ${f.id}`;
      const score = termHits(hay, ts) * 3 + termHits(f.sourceFiles.join(' '), ts);
      if (score <= 0) continue;
      results.push({
        type: 'feature',
        id: f.id,
        title: f.title,
        score,
        confidence: f.confidence,
        provenance: [f.status === 'fact' ? 'code_scan' : 'code_scan(hypothesis)'],
        sourceFiles: f.sourceFiles.slice(0, 8),
        screens: [...f.staticScreens, ...f.runtimeScreens].slice(0, 12),
        recommendedNextTool: {
          tool: 'qa_test_this',
          args: { mode: 'execute', goal: 'reproduce_bug', goalText: f.title, explore: true },
          why: `Focus a run on the "${f.title}" feature (${f.testCoverage} coverage)`,
        },
      });
    }
  }

  if (wantsScreen) {
    for (const s of map.staticTopology.screens) {
      const hay = `${s.name} ${s.route ?? ''} ${s.sourceFiles.join(' ')} ${s.reasons.join(' ')}`;
      const nameRouteHits = termHits(hay, ts);
      const visibleHits = s.sourceFiles.reduce((sum, f) => sum + fileTextHits(f), 0);
      const score = nameRouteHits * 2 + visibleHits * 2;
      if (score <= 0) continue;
      const provenance = ['code_scan'];
      if (nameRouteHits > 0) provenance.push('route/name');
      if (visibleHits > 0) provenance.push('visible_text');
      results.push({
        type: 'screen',
        id: s.id,
        title: s.name,
        score,
        confidence: s.confidence,
        provenance,
        sourceFiles: s.sourceFiles.slice(0, 8),
        screens: [s.id],
        recommendedNextTool: {
          tool: 'qa_explore',
          args: { goal: `reach the ${s.name} screen` },
          why: 'Exercise this screen at runtime to confirm + capture locators',
        },
      });
    }
    for (const r of map.runtimeTopology.screens) {
      const hay = `${r.title ?? ''} ${(r.textTokens ?? []).join(' ')} ${r.route ?? ''}`;
      const score = termHits(hay, ts) * 2;
      if (score <= 0) continue;
      results.push({
        type: 'screen',
        id: r.id,
        title: r.title ?? r.id,
        score,
        provenance: ['runtime'],
        sourceFiles: [],
        screens: [r.id, ...(r.linkedStaticScreenId ? [r.linkedStaticScreenId] : [])],
        recommendedNextTool: {
          tool: 'qa_app_map_read',
          args: { section: 'screens', screenId: r.id },
          why: 'Read the observed runtime screen detail',
        },
      });
    }
  }

  if (wantsCode && codeIndex) {
    for (const file of codeIndex.files) {
      const score = scoreFile(file, ts);
      if (score <= 0) continue;
      results.push({
        type: 'code',
        id: file.file,
        title: file.file,
        score,
        provenance: ['code_scan', ...fileMatchDimensions(file, ts)],
        sourceFiles: [file.file],
        screens: [],
        recommendedNextTool: {
          tool: 'qa_app_map_query',
          args: { query: opts.query, intent: 'feature' },
          why: 'Pivot from this file to the feature(s) it backs',
        },
      });
    }
  }

  if (wantsTest) {
    for (const c of map.testSuite.cases) {
      const hay = `${c.title} ${c.id} ${c.source ?? ''}`;
      const score = termHits(hay, ts) * 2;
      if (score <= 0) continue;
      results.push({
        type: 'test',
        id: c.id,
        title: c.title,
        score,
        provenance: ['test_case'],
        sourceFiles: c.source ? [c.source] : [],
        screens: [c.featureId, c.screenId].filter((x): x is string => !!x),
        recommendedNextTool: {
          tool: 'qa_flow_run',
          args: {},
          why: c.stale ? 'This test looks stale — re-run / repair it' : 'Run this existing test case',
        },
      });
    }
  }

  results.sort((a, b) => b.score - a.score || (b.confidence ?? 0) - (a.confidence ?? 0));
  return { query: opts.query, intent, results: results.slice(0, limit), total: results.length };
}
