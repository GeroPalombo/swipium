// Release-gate integrity and report exports:
//  - only Swipium-judged outcomes make a run "tested"; an agent fail note can block but never pass;
//  - a non-app failure (missing_test_data, destructive_refused) keeps the headline off SHIP;
//  - `visual_diff` in a policy matches visual comparisons only, never assertVisible;
//  - SARIF / Playwright carry the not-tested case, and SARIF levels follow the policy like JUnit;
//  - a screen or workflow named like an Object.prototype member resolves to the manifest anchor;
//  - the Markdown export keeps HTML neutralized after a reason that smuggles in a code fence;
//  - the session manifest lists report.md, and a corrupt test-suite.json is a warning, not a lost report;
//  - trend history reads the real per-session report files, skips corrupt ones, and compares on
//    scrubbed reasons;
//  - the test-suite JUnit export strips XML-illegal control characters.
// Hermetic: HOME is a temp dir (test/setupFakeHome.ts), no device discovery, no driver.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { generateSessionReport } = await import('../src/services/report.js');
const { reportPolicyVerdicts, toMarkdown, toPlaywrightJson, toSarif, isVisualFailure } = await import('../src/report/export.js');
const { applyPolicy } = await import('../src/report/policy.js');
const { releaseAssessment } = await import('../src/report/summary.js');
const { compareReports, findReportJsonFiles, trendForReports, trendForRoot } = await import('../src/report/history.js');
const { exportSuite } = await import('../src/testSuite/exporter.js');
type ReportData = import('../src/report/export.js').ReportData;
type ReportNote = import('../src/report/export.js').ReportNote;
type Policy = import('../src/report/policy.js').Policy;
type Session = import('../src/session/store.js').Session;
type Store = InstanceType<typeof SessionStore>;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

function fresh(root = tempDir('swipium-gate-integrity-')): { store: Store; s: Session } {
  const store = new SessionStore();
  const s = store.create(root);
  s.appId = 'com.example.app';
  return { store, s };
}

async function report(store: Store, s: Session) {
  const res = await generateSessionReport(store, s, { includeCurrentDump: false });
  return { res, r: res.report as unknown as ReportData };
}

const policy = (p: Partial<Policy>): Policy => ({ blockOn: [], warnOn: [], ignoreKnown: [], ciAllowMutations: [], ...p });

function data(over: Partial<ReportData> = {}): ReportData {
  return {
    sessionId: 'sess-1',
    appId: 'com.example.demo',
    device: 'emulator-5554',
    coverage: 'smoke',
    executiveSummary: { risk: 'caution', reasons: [], nextAction: 'Re-run.' },
    nativeHealth: 'OK',
    appHealth: 'OK',
    findings: [],
    highSeverityCount: 0,
    testOutcomes: [],
    outcomeTally: {},
    environmentChanges: [],
    guardrailOverrides: [],
    finalNetwork: 'online',
    networkRestore: 'unchanged',
    authState: 'unknown',
    phaseTimings: { totalMs: 1000, setupMs: 0, activeMs: 1000, timeToLoginMs: null },
    artifacts: [],
    ...over,
  };
}

describe('an agent fail note never makes a run tested', () => {
  it('a lone qa_note fail under a warned category: not tested, gate blocks, risk not SHIP', async () => {
    const { store, s } = fresh();
    store.addNote(s, {
      at: Date.now(),
      workflow: 'checkout',
      outcome: 'fail',
      category: 'missing_test_data',
      reason: 'no test card',
      source: 'qa_note',
    });
    const { r } = await report(store, s);
    expect(r.notTested).toMatchObject({ exercised: false, failureCode: 'NOT_TESTED' });
    expect(r.notTested?.reason).toContain('agent qa_note failure claim');
    expect(r.executiveSummary.risk).not.toBe('ship');
    const decision = applyPolicy(reportPolicyVerdicts(r), policy({ blockOn: ['native_crash'], warnOn: ['missing_test_data'] }));
    expect(decision.block).toBe(true);
    expect(decision.blocked).toContain('swipium: not tested: NOT_TESTED');
    // The note itself still reaches the gate (here only warned).
    expect(decision.warned).toContain('checkout: missing_test_data');
  });

  it('an agent app_bug fail note still blocks', async () => {
    const { store, s } = fresh();
    store.addNote(s, { at: Date.now(), workflow: 'login', outcome: 'fail', category: 'app_bug', reason: 'crash', source: 'qa_note' });
    const { r } = await report(store, s);
    expect(r.executiveSummary.risk).toBe('block');
    expect(applyPolicy(reportPolicyVerdicts(r), null).blocked).toContain('login: app_bug');
  });
});

describe('the headline agrees with the gate on non-app failures', () => {
  it('a healthy smoke plus a missing_test_data fail is CAUTION, never SHIP', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    store.addNote(s, { at: Date.now(), workflow: 'launch_smoke', outcome: 'pass', reason: 'launched, app=ok' });
    store.addNote(s, { at: Date.now(), workflow: 'checkout', outcome: 'fail', category: 'missing_test_data', reason: 'no test card' });
    const { r } = await report(store, s);
    expect(r.notTested).toBeUndefined();
    expect(r.executiveSummary.risk).toBe('caution');
    expect(r.executiveSummary.nextAction).toContain('checkout');
    expect(r.coverageVerdict?.status).toBe('BLOCKED');
    expect(applyPolicy(reportPolicyVerdicts(r), null).block).toBe(true);
  });

  it('releaseAssessment: otherFailCount is a caution', () => {
    const a = releaseAssessment({
      nativeHealth: 'OK',
      appHealth: 'OK',
      highSeverityCount: 0,
      failCount: 0,
      blockedCount: 0,
      otherFailCount: 1,
      overrideCount: 0,
      topOtherFail: { workflow: 'delete account', category: 'destructive_refused' },
    });
    expect(a.risk).toBe('caution');
    expect(a.nextAction).toContain('delete account');
  });
});

describe('visual_diff matches visual comparisons only', () => {
  const visualPolicy = policy({ blockOn: ['native_crash'], warnOn: ['visual_diff'] });
  const step = (kind: string) => [{ index: 1, kind, ok: false, failureCode: 'ASSERTION_FAILED' }];

  it('a failing assertVisible / waitForVisible still blocks', () => {
    for (const kind of ['assertVisible', 'waitForVisible']) {
      const r = data({ testOutcomes: [{ workflow: 'home', outcome: 'fail', category: 'app_bug', steps: step(kind) }] });
      expect(applyPolicy(reportPolicyVerdicts(r), visualPolicy).block).toBe(true);
    }
  });

  it('a failing assertImage / assertOcrText / assertDiff only warns', () => {
    for (const kind of ['assertImage', 'assertOcrText', 'assertDiff']) {
      const r = data({ testOutcomes: [{ workflow: 'home', outcome: 'fail', category: 'app_bug', steps: step(kind) }] });
      const decision = applyPolicy(reportPolicyVerdicts(r), visualPolicy);
      expect(decision.block).toBe(false);
      expect(decision.warned).toEqual(['home: ASSERTION_FAILED']);
    }
  });

  it('evidence kinds: Swipium visual_match counts, an agent manual_review or qa_note does not', () => {
    const n = (over: Partial<ReportNote>): ReportNote => ({ workflow: 'w', outcome: 'fail', ...over });
    expect(isVisualFailure(n({ evidenceKind: 'visual_match' }))).toBe(true);
    expect(isVisualFailure(n({ evidenceKind: 'ocr_text' }))).toBe(true);
    expect(isVisualFailure(n({ evidenceKind: 'manual_review', method: 'visual' }))).toBe(false);
    expect(isVisualFailure(n({ evidenceKind: 'visual_match', source: 'qa_note' }))).toBe(false);
    expect(isVisualFailure(n({ evidenceKind: 'visual_match', outcome: 'pass' }))).toBe(false);
  });
});

describe('SARIF and Playwright carry the not-tested case and follow the policy', () => {
  const notTested = data({ notTested: { reachedApp: false, exercised: false, reason: 'Metro is down', failureCode: 'METRO_REQUIRED' } });

  it('a METRO_REQUIRED run is a SARIF error result and a failed Playwright spec', () => {
    const decision = applyPolicy(reportPolicyVerdicts(notTested), null);
    const sarif = JSON.parse(toSarif(notTested, decision));
    const results = sarif.runs[0].results as Array<{ ruleId: string; level: string; properties: { workflow?: string } }>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ruleId: 'METRO_REQUIRED', level: 'error', properties: { workflow: 'swipium: not tested' } });
    const pw = JSON.parse(toPlaywrightJson(notTested));
    const spec = pw.suites[0].specs.find((sp: { title: string }) => sp.title === 'swipium: not tested');
    expect(spec.ok).toBe(false);
    expect(pw.stats.unexpected).toBe(1);
  });

  it('a warned failure is a SARIF warning, a suppressed one a note, a blocking one an error', () => {
    const r = data({
      testOutcomes: [
        { workflow: 'checkout', outcome: 'fail', category: 'missing_test_data' },
        { workflow: 'billing', outcome: 'fail', category: 'BILLING_UNAVAILABLE' },
        { workflow: 'login', outcome: 'fail', category: 'app_bug' },
      ],
      findings: [{ severity: 'high', layer: 'native', kind: 'crash', failureCode: 'NATIVE_CRASH', detail: 'FATAL' }],
    });
    const decision = applyPolicy(
      reportPolicyVerdicts(r),
      policy({ blockOn: ['anr'], warnOn: ['missing_test_data', 'native_crash'], ignoreKnown: ['BILLING_UNAVAILABLE'] }),
    );
    const results = JSON.parse(toSarif(r, decision)).runs[0].results as Array<{ ruleId: string; level: string }>;
    const level = Object.fromEntries(results.map((x) => [x.ruleId, x.level]));
    expect(level).toEqual({ NATIVE_CRASH: 'warning', missing_test_data: 'warning', BILLING_UNAVAILABLE: 'note', app_bug: 'error' });
  });

  it('a screen or workflow named "constructor" anchors to the manifest, never a prototype member', () => {
    const r = data({
      testOutcomes: [{ workflow: 'constructor', outcome: 'fail', category: 'app_bug' }],
      findings: [{ severity: 'high', layer: 'app', kind: 'redbox', detail: 'boom', screen: 'toString' }],
    });
    const sarif = JSON.parse(toSarif(r, undefined, { sources: { defaultUri: 'app.json', byScreen: {}, byWorkflow: {} } }));
    for (const res of sarif.runs[0].results) expect(res.locations[0].physicalLocation.artifactLocation.uri).toBe('app.json');
  });
});

describe('Markdown export: a smuggled code fence cannot switch off HTML neutralization', () => {
  it('a reason with a newline and ``` keeps later "<" escaped and the PR fence intact', () => {
    const evil = 'oops\n```\n<img src=x onerror=alert(1)>';
    const r = data({
      executiveSummary: { risk: 'block', reasons: [evil], nextAction: evil },
      testOutcomes: [{ workflow: 'login', outcome: 'fail', category: 'app_bug', reason: evil }],
      findings: [{ severity: 'high', layer: 'app', kind: 'redbox', detail: evil }],
      environmentChanges: ['<script>alert(2)</script>'],
    });
    const md = toMarkdown(r);
    const prStart = md.indexOf('## PR summary');
    const fenceLine = md.slice(prStart).split('\n')[2];
    const fence = fenceLine.replace(/text$/, '');
    expect(fence.length).toBeGreaterThan(3); // longer than the ``` run inside the summary
    const prEnd = md.indexOf(`\n${fence}\n`, prStart + fenceLine.length);
    expect(prEnd).toBeGreaterThan(prStart);
    // Outside the PR-summary fence no raw "<" survives.
    const outside = md.slice(0, prStart) + md.slice(prEnd + fence.length + 2);
    expect(outside).not.toContain('<');
    expect(outside).toContain('&lt;img src=x onerror=alert(1)>');
    expect(outside).toContain('&lt;script>');
    // Run text never starts a line of its own outside the fence.
    expect(outside.split('\n').some((l) => /^\s*```/.test(l))).toBe(false);
  });
});

describe('the session manifest lists report.md', () => {
  it('manifest.files includes the report.md artifact and report.md names the manifest', async () => {
    const { store, s } = fresh();
    store.addNote(s, { at: Date.now(), workflow: 'launch_smoke', outcome: 'pass', reason: 'app=ok' });
    const { res } = await report(store, s);
    const files = (res.manifest as { files: Array<{ uri: string }> }).files.map((f) => f.uri);
    expect(files).toContain(res.reportMdUri);
    expect(files).toContain(res.reportUri);
    expect(res.summaryText).toContain(`manifest: ${res.manifestUri}`);
  });
});

describe('a corrupt test-suite.json never breaks the report', () => {
  it('the report warns, keeps the issue section, and leaves the file untouched', async () => {
    const { suiteJsonPath } = await import('../src/testSuite/store.js');
    const { readFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { store, s } = fresh();
    const path = suiteJsonPath(s.root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');
    store.addNote(s, { at: Date.now(), workflow: 'login', outcome: 'fail', category: 'app_bug', reason: 'crash' });
    const { res, r } = await report(store, s);
    const rec = r as unknown as Record<string, unknown>;
    expect(String(rec.persistentSuiteWarning)).toContain('test-suite.json is corrupt');
    expect(rec.issues).toBeDefined();
    expect(res.summaryText).toContain('persistent suite: .swipium/test-suite.json is corrupt');
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});

describe('trend history reads the real report layout', () => {
  it('finds the latest report of every persisted session and skips a corrupt file', async () => {
    const root = tempDir('swipium-trend-root-');
    for (const outcome of ['pass', 'fail'] as const) {
      const { store, s } = fresh(root);
      store.addNote(s, { at: Date.now(), workflow: 'login', outcome, category: outcome === 'fail' ? 'app_bug' : undefined, reason: 'r' });
      await report(store, s);
    }
    const files = findReportJsonFiles(root);
    expect(files).toHaveLength(2);
    for (const f of files) expect(f).toMatch(/[\\/]report[\\/]report-\d+\.json$/);
    const trend = trendForRoot(root);
    expect(trend.reports).toBe(2);
    expect(trend.flakyFlows).toContain('login');

    const corrupt = join(root, '.swipium', 'ci', 'report.json');
    mkdirSync(join(root, '.swipium', 'ci'), { recursive: true });
    writeFileSync(corrupt, '{ not json');
    const withCorrupt = trendForReports(findReportJsonFiles(root));
    expect(withCorrupt.reports).toBe(2);
    expect(withCorrupt.unreadableReports).toEqual([corrupt]);
  });

  it('compareReports keys on scrubbed reasons and says not_checked without history', () => {
    const dir = tempDir('swipium-compare-');
    const write = (name: string, reason: string) => {
      const p = join(dir, name);
      writeFileSync(p, JSON.stringify(data({ testOutcomes: [{ workflow: 'login', outcome: 'fail', category: 'app_bug', reason }] })));
      return p;
    };
    const cur = write('cur.json', 'request 7f3a9c21 failed at 2026-10-19T10:00:00Z');
    const base = write('base.json', 'request 1b2c3d4e failed at 2026-10-18T09:00:00Z');
    const cmp = compareReports(cur, base, { trendRoot: tempDir('swipium-empty-trend-') });
    expect(cmp.newFailures).toEqual([]);
    expect(cmp.fixedFailures).toEqual([]);
    expect(cmp.flakeStatus).toBe('not_checked');
  });
});

describe('test-suite JUnit export', () => {
  it('strips XML-illegal control characters', () => {
    const suite = {
      schemaVersion: 1,
      updatedAt: '2026-10-19T00:00:00Z',
      cases: [
        {
          id: 'TC-001',
          title: 'login \u001b[31mred\u0000',
          functionality: 'auth',
          actualResult: { status: 'fail', summary: 'logcat \u0007 bell', failureCode: 'ASSERTION_FAILED' },
        },
      ],
    } as unknown as Parameters<typeof exportSuite>[0];
    const out = exportSuite(suite, 'junit').content ?? '';
    expect(out).toContain('<testsuites');
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out)).toBe(false);
    expect(out).toContain('�');
  });
});
