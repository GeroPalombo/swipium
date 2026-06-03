// Feature scope resolution (SWIPIUM-REQ-03 "Feature Scope Model" + "Query and Ranking"). PURE.
// Given a natural-language feature request and the available ground truth — the static code index,
// the runtime screen graph, and existing tests — rank every plausible code/runtime artifact, group
// them into feature candidates, and return the best-supported FeatureScope plus disambiguation when
// genuinely-different features tie. No device, no filesystem, no LLM: deterministic and unit-testable.

import type { FeatureIndex, SourceSymbol, RouteRef, SourceFileEntry, SymbolKind } from '../appMap/featureIndex.js';
import { normalizeQuery, termsAreUnrelated, type NormalizedQuery } from './synonyms.js';

export type ScopeSource = 'symbol' | 'route' | 'file' | 'runtime' | 'test';
export type RecommendedStrategy = 'smoke' | 'targeted_explore' | 'stateful_e2e' | 'manual_blocked';

export interface SourceMatch {
  source: ScopeSource;
  name: string;
  file?: string;
  line?: number;
  kind?: string;
  matchedTerms: string[];
  score: number;
}

export interface ScreenRef {
  name: string;
  origin: 'static' | 'runtime';
  id?: string; // runtime node id
  file?: string; // static source file
  route?: string;
  confidence: number;
}

export interface EntryPoint {
  kind: 'route' | 'deep_link' | 'runtime_node' | 'screen_component';
  value: string;
  file?: string;
  confidence: number;
}

export interface CodeSymbolRef {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
}

export interface DataDependency {
  name: string;
  kind: 'api' | 'validation' | 'fixture' | 'permission' | 'storage' | 'external';
  evidence: string;
}

export interface FeatureRisk {
  risk: string;
  level: 'low' | 'medium' | 'high';
  rationale: string;
}

export interface TestCaseRef {
  id: string;
  title: string;
  source: string; // e.g. "testcase", "flow", "catalog"
  path?: string;
}

export interface CoverageGap {
  area: string;
  reason: string;
}

export interface FeatureScope {
  featureId: string;
  query: string;
  title: string;
  objective: string;
  confidence: number; // 0..1
  sourceMatches: SourceMatch[];
  staticScreens: ScreenRef[];
  runtimeScreens: ScreenRef[];
  entryPoints: EntryPoint[];
  functions: CodeSymbolRef[];
  dataDependencies: DataDependency[];
  risks: FeatureRisk[];
  existingTests: TestCaseRef[];
  coverageGaps: CoverageGap[];
  recommendedStrategy: RecommendedStrategy;
  /** The core/expanded query terms this candidate matched on (for transparency + disambiguation). */
  matchedTerms: string[];
}

/** Lightweight ranked summary of an alternate candidate (the primary is returned in full). */
export interface FeatureCandidate {
  featureId: string;
  title: string;
  confidence: number;
  matchedTerms: string[];
  topMatches: string[];
}

export interface RuntimeScreenInput {
  id: string;
  title?: string;
  route?: string;
  text?: string; // visible text (element labels concatenated)
}

export interface FeatureScopeInput {
  query: string;
  index: FeatureIndex;
  runtimeScreens?: RuntimeScreenInput[];
  existingTests?: TestCaseRef[];
  platform?: string;
  limit?: number;
}

export interface FeatureScopeResult {
  primary: FeatureScope;
  candidates: FeatureCandidate[];
  needsInput?: { question: string; options: string[] };
  searched: { terms: string[]; files: number; symbols: number; routes: number; runtimeScreens: number };
  found: boolean;
}

// ---- scoring weights ----------------------------------------------------------------------------
const CORE_W = 1.0;
const SYN_W = 0.4;
const KIND_WEIGHT: Record<ScopeSource, number> = { symbol: 1.0, route: 1.0, runtime: 0.9, test: 0.6, file: 0.45 };
const SYMBOL_KIND_WEIGHT: Record<SymbolKind, number> = {
  screen: 1.0, service: 0.85, hook: 0.7, component: 0.7, function: 0.55, class: 0.6, constant: 0.5,
};
const EXACT_BONUS = 0.8; // an item whose tokens contain every core term

interface TermHit {
  matched: string[]; // distinct core terms present
  synMatched: string[]; // distinct synonym-only terms present
}

function hits(tokens: string[], q: NormalizedQuery): TermHit {
  const present = new Set(tokens);
  const matched = q.coreTerms.filter((t) => present.has(t));
  const synMatched = q.expandedTerms.filter((t) => present.has(t) && !q.coreTerms.includes(t));
  return { matched, synMatched };
}

function baseScore(h: TermHit, q: NormalizedQuery, tokens: string[]): number {
  if (!h.matched.length && !h.synMatched.length) return 0;
  let s = h.matched.length * CORE_W + h.synMatched.length * SYN_W;
  // Exact feature-name match: the item carries every core term (highest-ranked per requirement).
  if (q.coreTerms.length && q.coreTerms.every((t) => tokens.includes(t))) s += EXACT_BONUS;
  return s;
}

// ---- Union-Find over core terms (clustering) ----------------------------------------------------
class UF {
  private parent = new Map<string, string>();
  private find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  root(x: string): string {
    return this.find(x);
  }
}

interface ScoredMatch extends SourceMatch {
  tokens: string[];
}

function slug(terms: string[]): string {
  const base = terms.join('-').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `feat-${base || 'unknown'}`.slice(0, 64);
}

function titleCase(terms: string[]): string {
  return terms.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
}

// state-changing / risky vocab used for strategy + risk derivation
const STATEFUL_TERMS = new Set(['create', 'add', 'new', 'edit', 'update', 'save', 'checkout', 'pay', 'purchase', 'order', 'subscribe', 'submit', 'send', 'post', 'upload', 'book']);
const DESTRUCTIVE_TERMS = new Set(['delete', 'remove', 'destroy', 'clear', 'wipe', 'cancel', 'logout', 'deactivate']);
const PAYMENT_TERMS = new Set(['checkout', 'payment', 'pay', 'purchase', 'order', 'subscribe', 'billing']);
const AUTH_TERMS = new Set(['auth', 'login', 'signin', 'logon', 'authentication', 'credentials', 'password', 'account', 'register', 'signup']);

function collectMatches(input: FeatureScopeInput, q: NormalizedQuery): ScoredMatch[] {
  const out: ScoredMatch[] = [];
  const push = (m: ScoredMatch) => {
    if (m.score > 0) out.push(m);
  };
  for (const s of input.index.symbols) {
    const h = hits(s.tokens, q);
    const score = baseScore(h, q, s.tokens) * KIND_WEIGHT.symbol * SYMBOL_KIND_WEIGHT[s.kind];
    push({ source: 'symbol', name: s.name, file: s.file, line: s.line, kind: s.kind, matchedTerms: [...h.matched, ...h.synMatched], score, tokens: s.tokens });
  }
  for (const r of input.index.routes) {
    const h = hits(r.tokens, q);
    const score = baseScore(h, q, r.tokens) * KIND_WEIGHT.route;
    push({ source: 'route', name: r.route, file: r.file, line: r.line, matchedTerms: [...h.matched, ...h.synMatched], score, tokens: r.tokens });
  }
  for (const f of input.index.files) {
    const h = hits(f.tokens, q);
    const score = baseScore(h, q, f.tokens) * KIND_WEIGHT.file;
    push({ source: 'file', name: f.base, file: f.file, matchedTerms: [...h.matched, ...h.synMatched], score, tokens: f.tokens });
  }
  for (const n of input.runtimeScreens ?? []) {
    const tokens = [...tokenizeLoose(n.title), ...tokenizeLoose(n.route), ...tokenizeLoose(n.text)];
    const h = hits(tokens, q);
    const score = baseScore(h, q, tokens) * KIND_WEIGHT.runtime;
    push({ source: 'runtime', name: n.title || n.route || n.id, file: undefined, kind: 'runtime_node', matchedTerms: [...h.matched, ...h.synMatched], score, tokens });
    // carry the node id on `line`-less match via name; id kept for screen extraction below
    if (score > 0) (out[out.length - 1] as ScoredMatch & { runtimeId?: string }).runtimeId = n.id;
  }
  for (const t of input.existingTests ?? []) {
    const tokens = tokenizeLoose(`${t.title} ${t.id}`);
    const h = hits(tokens, q);
    const score = baseScore(h, q, tokens) * KIND_WEIGHT.test;
    push({ source: 'test', name: t.title || t.id, matchedTerms: [...h.matched, ...h.synMatched], score, tokens });
    if (score > 0) (out[out.length - 1] as ScoredMatch & { testRef?: TestCaseRef }).testRef = t;
  }
  return out;
}

function tokenizeLoose(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

interface Cluster {
  terms: Set<string>;
  matches: ScoredMatch[];
  score: number;
}

/** Group matches into feature candidates by the core terms they share (union-find). */
function cluster(matches: ScoredMatch[], q: NormalizedQuery): Cluster[] {
  const uf = new UF();
  // Union all core terms that co-occur within any single match.
  for (const m of matches) {
    const core = m.matchedTerms.filter((t) => q.coreTerms.includes(t));
    for (let i = 1; i < core.length; i++) uf.union(core[0], core[i]);
  }
  const byRoot = new Map<string, Cluster>();
  const rootFor = (m: ScoredMatch): string => {
    const core = m.matchedTerms.filter((t) => q.coreTerms.includes(t));
    if (core.length) return uf.root(core[0]);
    // synonym-only match → attach to the synonym's owning core term if derivable, else its own bucket
    return m.matchedTerms[0] ?? '∅';
  };
  for (const m of matches) {
    const root = rootFor(m);
    let c = byRoot.get(root);
    if (!c) {
      c = { terms: new Set(), matches: [], score: 0 };
      byRoot.set(root, c);
    }
    for (const t of m.matchedTerms) c.terms.add(t);
    c.matches.push(m);
    c.score += m.score;
  }
  return [...byRoot.values()].sort((a, b) => b.score - a.score);
}

function deriveRisks(terms: Set<string>): FeatureRisk[] {
  const risks: FeatureRisk[] = [];
  const has = (set: Set<string>) => [...terms].some((t) => set.has(t));
  if (has(DESTRUCTIVE_TERMS)) risks.push({ risk: 'destructive actions present', level: 'high', rationale: 'Feature vocabulary includes delete/remove/cancel — requires disposable state and explicit consent.' });
  if (has(PAYMENT_TERMS)) risks.push({ risk: 'real-money / purchase path', level: 'high', rationale: 'Payment/checkout flows can charge real accounts — use a sandbox/test fixture.' });
  if (has(AUTH_TERMS)) risks.push({ risk: 'authentication gate', level: 'medium', rationale: 'Likely blocked behind login — needs test credentials to exercise fully.' });
  if (!risks.length) risks.push({ risk: 'low-risk read/navigation', level: 'low', rationale: 'No destructive/payment/auth vocabulary detected in scope.' });
  return risks;
}

function deriveStrategy(terms: Set<string>, hasRuntime: boolean, hasStatic: boolean, confidence: number): RecommendedStrategy {
  const has = (set: Set<string>) => [...terms].some((t) => set.has(t));
  if (confidence < 0.15 || (!hasRuntime && !hasStatic)) return 'manual_blocked';
  if (has(DESTRUCTIVE_TERMS) || has(PAYMENT_TERMS)) return 'manual_blocked';
  if (has(STATEFUL_TERMS)) return 'stateful_e2e';
  if (hasRuntime || hasStatic) return 'targeted_explore';
  return 'smoke';
}

function buildScope(c: Cluster, q: NormalizedQuery, input: FeatureScopeInput, maxScore: number): FeatureScope {
  const limit = input.limit ?? 8;
  const matches = [...c.matches].sort((a, b) => b.score - a.score);
  const coreTerms = q.coreTerms.filter((t) => c.terms.has(t));
  const displayTerms = coreTerms.length ? coreTerms : [...c.terms].slice(0, 3);
  const featureId = slug(displayTerms.length ? displayTerms : q.coreTerms);
  const title = titleCase(displayTerms.length ? displayTerms : q.coreTerms);

  const staticScreens: ScreenRef[] = [];
  const runtimeScreens: ScreenRef[] = [];
  const entryPoints: EntryPoint[] = [];
  const functions: CodeSymbolRef[] = [];
  const dataDependencies: DataDependency[] = [];
  const existingTests: TestCaseRef[] = [];
  const seenDep = new Set<string>();

  for (const m of matches) {
    const conf = maxScore > 0 ? Math.min(1, m.score / maxScore) : 0;
    if (m.source === 'symbol') {
      if (m.kind === 'screen') {
        staticScreens.push({ name: m.name, origin: 'static', file: m.file, confidence: conf });
        entryPoints.push({ kind: 'screen_component', value: m.name, file: m.file, confidence: conf });
      } else if (m.kind === 'service' || m.kind === 'class') {
        if (!seenDep.has(m.name)) {
          seenDep.add(m.name);
          dataDependencies.push({ name: m.name, kind: 'external', evidence: `${m.kind} ${m.file}:${m.line}` });
        }
      }
      functions.push({ name: m.name, kind: (m.kind as SymbolKind) ?? 'function', file: m.file!, line: m.line ?? 0 });
    } else if (m.source === 'route') {
      const isDeepLink = /:\/\//.test(m.name);
      entryPoints.push({ kind: isDeepLink ? 'deep_link' : 'route', value: m.name, file: m.file, confidence: conf });
      staticScreens.push({ name: m.name, origin: 'static', file: m.file, route: m.name, confidence: conf });
    } else if (m.source === 'runtime') {
      const id = (m as ScoredMatch & { runtimeId?: string }).runtimeId;
      runtimeScreens.push({ name: m.name, origin: 'runtime', id, route: undefined, confidence: conf });
      if (id) entryPoints.push({ kind: 'runtime_node', value: id, confidence: conf });
    } else if (m.source === 'test') {
      const ref = (m as ScoredMatch & { testRef?: TestCaseRef }).testRef;
      if (ref) existingTests.push(ref);
    }
  }

  // fixture/credential data dependencies inferred from feature vocabulary
  if ([...c.terms].some((t) => AUTH_TERMS.has(t))) dataDependencies.push({ name: 'test credentials', kind: 'fixture', evidence: 'auth vocabulary in scope' });
  if ([...c.terms].some((t) => PAYMENT_TERMS.has(t))) dataDependencies.push({ name: 'sandbox payment method', kind: 'fixture', evidence: 'payment vocabulary in scope' });

  const confidence = maxScore > 0 ? Math.min(1, c.score / maxScore) : 0;
  const risks = deriveRisks(c.terms);
  const strategy = deriveStrategy(c.terms, runtimeScreens.length > 0, staticScreens.length > 0, confidence);

  const coverageGaps: CoverageGap[] = [];
  if (!runtimeScreens.length) coverageGaps.push({ area: 'runtime', reason: 'No runtime screen has been observed for this feature yet — run a focused exploration.' });
  if (!staticScreens.length) coverageGaps.push({ area: 'static', reason: 'No screen/route component matched in source — the static index may be incomplete or the feature is named differently.' });
  if (!existingTests.length) coverageGaps.push({ area: 'tests', reason: 'No existing test/flow covers this feature — generate cases.' });

  const objective = `Validate the "${title}" feature${input.platform ? ` on ${input.platform}` : ''}: reach its entry point, exercise the primary path, and verify the expected outcome.`;

  return {
    featureId,
    query: input.query,
    title,
    objective,
    confidence: round(confidence),
    sourceMatches: dedupeMatches(matches).slice(0, limit),
    staticScreens: dedupeScreens(staticScreens).slice(0, limit),
    runtimeScreens: dedupeScreens(runtimeScreens).slice(0, limit),
    entryPoints: dedupeEntry(entryPoints).slice(0, limit),
    functions: functions.slice(0, limit),
    dataDependencies,
    risks,
    existingTests: dedupeTests(existingTests),
    coverageGaps,
    recommendedStrategy: strategy,
    matchedTerms: [...c.terms],
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function dedupeMatches(m: SourceMatch[]): SourceMatch[] {
  const seen = new Set<string>();
  return m.filter((x) => {
    const k = `${x.source}:${x.name}:${x.file ?? ''}:${x.line ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function dedupeScreens(s: ScreenRef[]): ScreenRef[] {
  const seen = new Set<string>();
  return s.filter((x) => {
    const k = `${x.origin}:${x.id ?? ''}:${x.name}:${x.file ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function dedupeEntry(e: EntryPoint[]): EntryPoint[] {
  const seen = new Set<string>();
  return e.filter((x) => {
    const k = `${x.kind}:${x.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function dedupeTests(t: TestCaseRef[]): TestCaseRef[] {
  const seen = new Set<string>();
  return t.filter((x) => {
    if (seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}

/** Build the feature scope: rank, cluster, and pick the best candidate (asking only on a real tie). */
export function buildFeatureScope(input: FeatureScopeInput): FeatureScopeResult {
  const q = normalizeQuery(input.query);
  const matches = collectMatches(input, q);
  const searched = {
    terms: q.expandedTerms,
    files: input.index.files.length,
    symbols: input.index.symbols.length,
    routes: input.index.routes.length,
    runtimeScreens: (input.runtimeScreens ?? []).length,
  };

  if (!matches.length) {
    // No feature found — honest empty scope with searched terms (acceptance criterion).
    const empty: FeatureScope = {
      featureId: slug(q.coreTerms),
      query: input.query,
      title: titleCase(q.coreTerms),
      objective: `No code or runtime evidence found for "${input.query}".`,
      confidence: 0,
      sourceMatches: [],
      staticScreens: [],
      runtimeScreens: [],
      entryPoints: [],
      functions: [],
      dataDependencies: [],
      risks: [{ risk: 'feature not located', level: 'medium', rationale: 'No matching code symbols, routes, runtime screens, or tests.' }],
      existingTests: [],
      coverageGaps: [
        { area: 'map', reason: 'Feature not present in the current map — run an initial qa_test_this/qa_explore to grow coverage, or refine the feature name.' },
      ],
      recommendedStrategy: 'manual_blocked',
      matchedTerms: [],
    };
    return { primary: empty, candidates: [], searched, found: false };
  }

  const clusters = cluster(matches, q);
  const maxScore = clusters[0].score;
  const scopes = clusters.map((c) => buildScope(c, q, input, maxScore));
  const primary = scopes[0];

  const candidates: FeatureCandidate[] = scopes.map((s) => ({
    featureId: s.featureId,
    title: s.title,
    confidence: s.confidence,
    matchedTerms: s.matchedTerms,
    topMatches: s.sourceMatches.slice(0, 3).map((m) => `${m.source}:${m.name}`),
  }));

  // Disambiguation: ask ONE question only when the top two candidates are close AND about
  // genuinely-different features (no shared core term).
  let needsInput: FeatureScopeResult['needsInput'];
  if (scopes.length >= 2) {
    const a = scopes[0];
    const b = scopes[1];
    const close = b.confidence >= a.confidence * 0.75 && a.confidence > 0;
    if (close && termsAreUnrelated(a.matchedTerms.filter((t) => q.coreTerms.includes(t)), b.matchedTerms.filter((t) => q.coreTerms.includes(t)))) {
      needsInput = {
        question: `"${input.query}" matched more than one distinct feature. Which one should Swipium test?`,
        options: scopes.slice(0, 4).map((s) => `${s.title} (${Math.round(s.confidence * 100)}%)`),
      };
    }
  }

  return { primary, candidates, needsInput, searched, found: true };
}
