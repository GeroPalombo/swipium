// Feature scope resolution: a natural-language feature request is ranked against the static code
// index, runtime screens, and existing tests, grouped into candidates, and turned into a scope with
// entry points, risks, gaps, and a strategy. Pure: hand-built indexes, no filesystem or device.

import { describe, expect, it } from 'vitest';
import { buildFeatureScope } from '../src/featureTesting/featureScope.js';
import { tokenize, type FeatureIndex, type RouteRef, type SourceSymbol, type SymbolKind } from '../src/appMap/featureIndex.js';

const sym = (name: string, kind: SymbolKind, file: string, line = 1): SourceSymbol => ({ name, kind, file, line, tokens: tokenize(name) });
const index = (symbols: SourceSymbol[], routes: RouteRef[] = []): FeatureIndex => ({
  root: '/repo',
  symbols,
  routes,
  files: [],
  scannedFiles: symbols.length,
  truncated: false,
});

describe('buildFeatureScope', () => {
  const weatherIndex = index(
    [
      sym('WeatherAnalysisScreen', 'screen', 'src/screens/WeatherAnalysisScreen.tsx', 3),
      sym('LoginScreen', 'screen', 'src/screens/LoginScreen.tsx'),
    ],
    [{ route: '/weather', file: 'src/nav.ts', line: 12, tokens: ['weather'] }],
  );

  it('builds a full scope from code, runtime, and test evidence for the request', () => {
    const r = buildFeatureScope({
      query: 'weather analysis feature',
      index: weatherIndex,
      runtimeScreens: [{ id: 'n3', title: 'Weather', text: 'Today forecast' }],
      existingTests: [{ id: 'TC-WEATHER-001', title: 'Weather analysis loads', source: 'testcase' }],
      platform: 'android',
    });
    expect(r.found).toBe(true);
    expect(r.needsInput).toBeUndefined();
    const p = r.primary;
    // Stopwords ("feature") are dropped from the id and title.
    expect(p.featureId).toBe('feat-weather-analysis');
    expect(p.title).toBe('Weather Analysis');
    expect(p.objective).toContain('"Weather Analysis" feature on android');
    expect(p.confidence).toBe(1);
    expect(p.staticScreens.map((s) => s.name)).toEqual(['WeatherAnalysisScreen', '/weather']);
    expect(p.runtimeScreens).toMatchObject([{ name: 'Weather', origin: 'runtime', id: 'n3' }]);
    expect(p.entryPoints.map((e) => `${e.kind}:${e.value}`)).toEqual([
      'screen_component:WeatherAnalysisScreen',
      'runtime_node:n3',
      'route:/weather',
    ]);
    expect(p.existingTests.map((t) => t.id)).toEqual(['TC-WEATHER-001']);
    // Every area has evidence, so no gap; plain navigation vocabulary is low risk.
    expect(p.coverageGaps).toEqual([]);
    expect(p.risks.map((x) => x.level)).toEqual(['low']);
    expect(p.recommendedStrategy).toBe('targeted_explore');
    // The unrelated login screen is not part of the scope.
    expect(p.sourceMatches.some((m) => m.name === 'LoginScreen')).toBe(false);
    // Synonyms widen the search vocabulary.
    expect(r.searched).toMatchObject({ symbols: 2, routes: 1, runtimeScreens: 1 });
    expect(r.searched.terms).toEqual(expect.arrayContaining(['weather', 'analysis', 'forecast', 'analytics']));
  });

  it('reports the missing runtime and test coverage as gaps', () => {
    const p = buildFeatureScope({ query: 'weather analysis', index: weatherIndex }).primary;
    expect(p.coverageGaps.map((g) => g.area)).toEqual(['runtime', 'tests']);
  });

  it('nothing matching is an honest empty scope with the searched terms', () => {
    const r = buildFeatureScope({ query: 'weather', index: index([sym('LoginScreen', 'screen', 'l.tsx')]) });
    expect(r.found).toBe(false);
    expect(r.candidates).toEqual([]);
    expect(r.primary).toMatchObject({ featureId: 'feat-weather', confidence: 0, recommendedStrategy: 'manual_blocked', matchedTerms: [] });
    expect(r.primary.coverageGaps.map((g) => g.area)).toEqual(['map']);
    expect(r.searched.terms).toContain('forecast');
  });

  it('asks one question when two unrelated features tie', () => {
    const r = buildFeatureScope({
      query: 'alerts payment',
      index: index([sym('AlertsScreen', 'screen', 'a.tsx'), sym('PaymentScreen', 'screen', 'p.tsx')]),
    });
    expect(r.candidates.map((c) => c.featureId)).toEqual(['feat-alerts', 'feat-payment']);
    expect(r.needsInput?.options).toEqual(['Alerts (100%)', 'Payment (100%)']);
  });

  it('does not ask when the matches share a core term: they merge into one feature', () => {
    const r = buildFeatureScope({
      query: 'weather alerts',
      index: index([
        sym('WeatherScreen', 'screen', 'w.tsx'),
        sym('AlertsScreen', 'screen', 'a.tsx'),
        sym('WeatherAlertsScreen', 'screen', 'wa.tsx'),
      ]),
    });
    expect(r.needsInput).toBeUndefined();
    expect(r.candidates).toHaveLength(1);
    expect(r.primary.featureId).toBe('feat-weather-alerts');
    // The exact-name match ranks first.
    expect(r.primary.sourceMatches[0].name).toBe('WeatherAlertsScreen');
  });

  it('destructive and auth vocabulary blocks automation and asks for credentials', () => {
    const p = buildFeatureScope({ query: 'delete account', index: index([sym('DeleteAccountScreen', 'screen', 'd.tsx')]) }).primary;
    expect(p.recommendedStrategy).toBe('manual_blocked');
    expect(p.risks.map((x) => `${x.level}:${x.risk}`)).toEqual(['high:destructive actions present', 'medium:authentication gate']);
    expect(p.dataDependencies).toContainEqual({ name: 'test credentials', kind: 'fixture', evidence: 'auth vocabulary in scope' });
  });

  it('state-changing vocabulary recommends a stateful end-to-end test', () => {
    const p = buildFeatureScope({ query: 'create post', index: index([sym('CreatePostScreen', 'screen', 'c.tsx')]) }).primary;
    expect(p.featureId).toBe('feat-create-post');
    expect(p.recommendedStrategy).toBe('stateful_e2e');
  });

  it('services become data dependencies and every matched symbol is listed as a function', () => {
    const p = buildFeatureScope({
      query: 'checkout',
      index: index([sym('CheckoutScreen', 'screen', 'src/Checkout.tsx', 4), sym('CheckoutService', 'service', 'src/api/checkout.ts', 9)]),
    }).primary;
    expect(p.dataDependencies).toEqual([
      { name: 'CheckoutService', kind: 'external', evidence: 'service src/api/checkout.ts:9' },
      { name: 'sandbox payment method', kind: 'fixture', evidence: 'payment vocabulary in scope' },
    ]);
    expect(p.functions.map((f) => f.name)).toEqual(['CheckoutScreen', 'CheckoutService']);
    expect(p.risks[0]).toMatchObject({ risk: 'real-money / purchase path', level: 'high' });
    expect(p.recommendedStrategy).toBe('manual_blocked');
  });
});
