// Export formats over the outcome model: latest attempt per workflow, step timeline, evidence and the
// display flags (flaky, contradicted, no evidence). Covers JUnit semantics, narrowed SARIF, the
// failure-first GitHub summary, the Markdown table, the Playwright deprecation note, the PR summary
// category / evidence line, and old (2.3.5) reports rendering in every format.

import { describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GITHUB_SUMMARY_FULL_REPORT,
  PLAYWRIGHT_DEPRECATION,
  inlinePrSummary,
  likelyReportCategory,
  reportPolicyVerdicts,
  toGithubSummary,
  toJUnit,
  toMarkdown,
  toPlaywrightJson,
  toSarif,
  type ReportData,
  type ReportNote,
  type ReportStep,
} from '../src/report/export.js';
import { applyPolicy } from '../src/report/policy.js';
import { buildPrSummary } from '../src/report/history.js';

function base(over: Partial<ReportData> = {}): ReportData {
  return {
    sessionId: 'sess-9',
    appId: 'com.example.demo',
    device: 'emulator-5554',
    coverage: 'smoke',
    executiveSummary: { risk: 'ship', reasons: ['all workflows passed'], nextAction: 'Ship it.' },
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
    phaseTimings: { totalMs: 10_000, setupMs: 1000, activeMs: 9000, timeToLoginMs: null },
    artifacts: [],
    ...over,
  };
}

const step = (i: number, over: Partial<ReportStep> = {}): ReportStep => ({
  i,
  at: 1000 + i,
  durationMs: 100 * i,
  source: 'flow',
  action: 'tap',
  target: `tap "Button ${i}"`,
  result: 'ok',
  ...over,
});

const flow = (workflow: string, outcome: ReportNote['outcome'], over: Partial<ReportNote> = {}): ReportNote => ({
  workflow,
  outcome,
  origin: 'flow',
  ...over,
});
const agent = (workflow: string, outcome: ReportNote['outcome'], over: Partial<ReportNote> = {}): ReportNote => ({
  workflow,
  outcome,
  origin: 'agent',
  source: 'qa_note',
  ...over,
});

interface Tc {
  '@_name': string;
  '@_time': string;
  failure?: { '#text': string; '@_message': string; '@_type': string };
  error?: { '#text': string; '@_message': string; '@_type': string };
  skipped?: { '@_message': string };
  'system-out'?: string;
}
interface Suite {
  '@_tests': string;
  '@_failures': string;
  '@_errors': string;
  '@_skipped': string;
  testcase?: Tc | Tc[];
}
const parse = (xml: string) =>
  new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', htmlEntities: true }).parse(xml) as {
    testsuites: { '@_tests': string; '@_errors': string; testsuite: Suite[] };
  };
const casesOf = (xml: string, suite = 0): Tc[] => {
  const tc = parse(xml).testsuites.testsuite[suite].testcase;
  return tc ? (Array.isArray(tc) ? tc : [tc]) : [];
};
const gate = (r: ReportData) => applyPolicy(reportPolicyVerdicts(r), null);

describe('latest attempt per workflow in every export', () => {
  it('flow fail then flow pass: gate passes, one JUnit case, flaky with its attempts', () => {
    const r = base({ testOutcomes: [flow('Login', 'fail', { category: 'app_bug', at: 1 }), flow('Login', 'pass', { at: 2 })] });
    expect(gate(r).block).toBe(false);
    const cases = casesOf(toJUnit(r, gate(r)));
    expect(cases).toHaveLength(1);
    expect(cases[0].failure).toBeUndefined();
    expect(cases[0]['system-out']).toContain('flaky: attempts fail, pass');
    expect(toMarkdown(r)).toContain('✅ pass flaky (attempts: fail, pass)');
    expect(toGithubSummary(r)).toContain('pass flaky (attempts: fail, pass)');
    expect(toGithubSummary(r)).not.toContain('### Failures');
    const pw = JSON.parse(toPlaywrightJson(r));
    expect(pw.suites[0].specs).toHaveLength(1);
    expect(pw.stats.flaky).toBe(1);
    expect(JSON.parse(toSarif(r)).runs[0].results).toHaveLength(0);
  });

  it('flow fail then agent note pass: still blocks and the failure stays in JUnit', () => {
    const r = base({ testOutcomes: [flow('Login', 'fail', { category: 'app_bug' }), agent('Login', 'pass')] });
    expect(gate(r).block).toBe(true);
    const cases = casesOf(toJUnit(r));
    expect(cases.filter((c) => c.failure)).toHaveLength(1);
    // Two cases for one name stay distinct (CI sinks merge equal names).
    expect(new Set(cases.map((c) => c['@_name'])).size).toBe(cases.length);
  });

  it('note fail then note pass: passes and is flaky', () => {
    const r = base({ testOutcomes: [agent('checkout', 'fail', { category: 'app_bug' }), agent('checkout', 'pass')] });
    expect(gate(r).block).toBe(false);
    expect(casesOf(toJUnit(r))).toHaveLength(1);
    expect(toMarkdown(r)).toContain('flaky');
  });

  it('"Login" then "login " is one workflow', () => {
    const r = base({ testOutcomes: [flow('Login', 'fail', { category: 'app_bug' }), flow('login ', 'pass')] });
    expect(casesOf(toJUnit(r))).toHaveLength(1);
    expect(toMarkdown(r).match(/\| ✅ pass flaky/g)).toHaveLength(1);
  });

  it('flow fail with a crash finding, then flow pass: still blocks on the finding', () => {
    const r = base({
      testOutcomes: [flow('Login', 'fail', { category: 'app_bug' }), flow('Login', 'pass')],
      findings: [{ severity: 'high', layer: 'native', kind: 'crash', failureCode: 'NATIVE_CRASH', detail: 'FATAL EXCEPTION' }],
      highSeverityCount: 1,
    });
    expect(gate(r).block).toBe(true);
    expect(gate(r).blocked).toEqual(['finding:crash: NATIVE_CRASH']);
    expect(casesOf(toJUnit(r), 1)[0].failure?.['@_type']).toBe('NATIVE_CRASH');
  });
});

describe('JUnit semantics', () => {
  it('per-case time is the sum of the steps in the outcome range, 0 when unknown', () => {
    const r = base({
      steps: [step(1), step(2), step(3), step(4), step(5)],
      testOutcomes: [flow('ranged', 'pass', { stepRange: [2, 4] }), flow('unranged', 'pass')],
    });
    const [ranged, unranged] = casesOf(toJUnit(r));
    expect(Number(ranged['@_time'])).toBeCloseTo(0.9); // 200 + 300 + 400 ms
    expect(Number(unranged['@_time'])).toBe(0);
  });

  it('type is the failure code, message the human text, and system-out names the failing step', () => {
    const r = base({
      steps: [step(1), step(2, { result: 'failed', failureCode: 'ELEMENT_NOT_FOUND', target: 'tap "Sign in"' })],
      testOutcomes: [flow('login', 'fail', { category: 'app_bug', reason: 'Sign in never appeared', stepRange: [1, 2] })],
    });
    const [c] = casesOf(toJUnit(r));
    expect(c.failure).toMatchObject({ '@_type': 'app_bug', '@_message': 'Sign in never appeared' });
    expect(c['system-out']).toContain('failing step #2: tap "Sign in" (ELEMENT_NOT_FOUND)');
    expect(c['system-out']).toContain('(no evidence)');
  });

  it('tool / environment failures and the not-tested case are <error>, not <failure>', () => {
    const r = base({
      testOutcomes: [
        flow('boot', 'fail', { category: 'other', steps: [{ index: 0, kind: 'launch', ok: false, failureCode: 'DEVICE_UNRESPONSIVE' }] }),
        flow('tool', 'fail', { category: 'mcp_limitation', reason: 'canvas' }),
      ],
      findings: [{ severity: 'high', kind: 'wda_unreachable', failureCode: 'WDA_UNREACHABLE', detail: 'no source' }],
      notTested: { reachedApp: false, exercised: false, reason: 'Metro is down', failureCode: 'METRO_REQUIRED' },
    });
    const xml = toJUnit(r);
    const cases = casesOf(xml);
    expect(cases.map((c) => c.error?.['@_type'])).toEqual(['DEVICE_UNRESPONSIVE', 'mcp_limitation', 'METRO_REQUIRED']);
    expect(cases.find((c) => c['@_name'] === 'swipium: not tested')?.error?.['@_message']).toBe('Metro is down');
    expect(casesOf(xml, 1)[0].error?.['@_type']).toBe('WDA_UNREACHABLE');
    expect(xml).not.toContain('<failure');
    expect(parse(xml).testsuites['@_errors']).toBe('4');
  });

  it('blocked, skipped and not_applicable are <skipped> with the outcome in the message', () => {
    const r = base({
      testOutcomes: [
        flow('pay', 'blocked', { reason: 'no test card' }),
        flow('share', 'skipped', { reason: 'out of scope' }),
        flow('tablet', 'not_applicable', { reason: 'phone only' }),
      ],
    });
    expect(casesOf(toJUnit(r)).map((c) => c.skipped?.['@_message'])).toEqual([
      'blocked: no test card',
      'skipped: out of scope',
      'not applicable: phone only',
    ]);
  });

  it('only high findings are cases, and repeated names get the screen, then an index', () => {
    const crash = { severity: 'high', layer: 'app', kind: 'redbox', failureCode: 'REDBOX', detail: 'boom' };
    const r = base({
      findings: [
        { ...crash, screen: 'Home' },
        { ...crash, screen: 'Settings', detail: 'bang' },
        { ...crash, detail: 'pow' },
        { ...crash, detail: 'zap' },
        { severity: 'medium', layer: 'app', kind: 'slow', detail: 'slow list' },
        { severity: 'low', layer: 'app', kind: 'log_noise', detail: 'noise' },
      ],
      testOutcomes: [
        { workflow: 'map', outcome: 'pass', origin: 'explore' },
        { workflow: 'map', outcome: 'pass', origin: 'explore' },
      ],
    });
    const xml = toJUnit(r);
    expect(casesOf(xml, 1).map((c) => c['@_name'])).toEqual([
      '[high] app/redbox',
      '[high] app/redbox [Settings]',
      '[high] app/redbox #2',
      '[high] app/redbox #3',
    ]);
    expect(xml).not.toContain('slow list');
    expect(casesOf(xml).map((c) => c['@_name'])).toEqual(['map', 'map #2']);
  });

  it('a pass that its own range contradicts is still a pass, noted in system-out', () => {
    const r = base({ testOutcomes: [flow('feed', 'pass', { contradicted: true, evidence: ['swipium://session/s/screenshot/a.png'] })] });
    const [c] = casesOf(toJUnit(r));
    expect(c.failure).toBeUndefined();
    expect(c['system-out']).toContain('contradicted');
    expect(c['system-out']).toContain('swipium://session/s/screenshot/a.png');
  });
});

describe('SARIF holds high app findings only, fingerprinted by content', () => {
  const findings = [
    { severity: 'high', layer: 'app', kind: 'redbox', failureCode: 'REDBOX', detail: 'boom at 2026-10-01T10:00:00Z', screen: 'Home' },
    { severity: 'high', layer: 'native', kind: 'crash', failureCode: 'NATIVE_CRASH', detail: 'FATAL' },
    { severity: 'high', layer: 'app', kind: 'redbox', failureCode: 'REDBOX', detail: 'other boom', screen: 'Feed' },
    { severity: 'high', kind: 'wda_unreachable', failureCode: 'WDA_UNREACHABLE', detail: 'no source' },
    { severity: 'medium', layer: 'app', kind: 'anr', detail: 'stall' },
  ];

  it('drops workflow failures, tool findings and medium / low findings', () => {
    const r = base({ findings, testOutcomes: [flow('login', 'fail', { category: 'app_bug' })] });
    const results = JSON.parse(toSarif(r)).runs[0].results as Array<{ ruleId: string }>;
    expect(results.map((x) => x.ruleId)).toEqual(['REDBOX', 'NATIVE_CRASH', 'REDBOX']);
  });

  it('the same findings in a different order give the same fingerprints', () => {
    const fp = (list: typeof findings) => {
      const results = JSON.parse(toSarif(base({ findings: list }))).runs[0].results as Array<{
        message: { text: string };
        partialFingerprints: Record<string, string>;
      }>;
      return Object.fromEntries(results.map((x) => [x.message.text, x.partialFingerprints['swipium/v1']]));
    };
    const forward = fp(findings);
    expect(fp([...findings].reverse())).toEqual(forward);
    expect(new Set(Object.values(forward)).size).toBe(3);
  });
});

describe('GitHub summary is failure first', () => {
  const lines = (md: string) => md.split('\n');

  it('blocked run: the not-tested reason and the log to read are within the first 5 lines', () => {
    const r = base({
      executiveSummary: { risk: 'block', reasons: ['not tested'], nextAction: 'Start Metro.' },
      notTested: { reachedApp: false, exercised: false, reason: 'Metro bundler is not running', failureCode: 'METRO_REQUIRED' },
      artifacts: [{ uri: 'swipium://session/sess-9/metro/metro.log', kind: 'metro', path: 'metro/metro.log', createdAt: 5 }],
    });
    const md = toGithubSummary(r, gate(r));
    const head = lines(md).slice(0, 5).join('\n');
    expect(head).toContain('**Not tested:** Metro bundler is not running');
    expect(head).toContain('`metro/metro.log`');
    expect(lines(md).at(-1)).toBe(GITHUB_SUMMARY_FULL_REPORT);
  });

  it('blocked run with no log says so', () => {
    const r = base({ notTested: { reachedApp: false, exercised: false, reason: 'no device', failureCode: 'NO_DEVICE' } });
    expect(toGithubSummary(r)).toContain('No log captured.');
  });

  it('failed run: the first failure, with its step and code, is within the first 8 lines', () => {
    const r = base({
      executiveSummary: { risk: 'block', reasons: ['1 workflow(s) failed'], nextAction: 'Fix login.' },
      steps: [step(1), step(2), step(3, { result: 'failed', failureCode: 'ELEMENT_NOT_FOUND', target: 'tap "Sign in"' })],
      testOutcomes: [flow('signup', 'pass'), flow('login', 'fail', { category: 'app_bug', reason: 'no button', stepRange: [1, 3] })],
    });
    const md = toGithubSummary(r, gate(r));
    const idx = lines(md).findIndex((l) => l.includes('**login**'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(8);
    expect(lines(md)[idx]).toContain('step #3');
    expect(lines(md)[idx]).toContain('`ELEMENT_NOT_FOUND`');
    // The outcomes table and the closing pointer follow.
    expect(md.indexOf('### Outcomes')).toBeGreaterThan(md.indexOf('### Failures'));
    expect(lines(md).at(-1)).toBe(GITHUB_SUMMARY_FULL_REPORT);
  });

  it('passing run: verdict, outcomes table with evidence, the single high count', () => {
    const r = base({
      testOutcomes: [flow('signup', 'pass', { evidence: ['swipium://session/sess-9/screenshot/ok.png'] }), agent('profile', 'pass')],
      findings: [{ severity: 'high', kind: 'wda_unreachable', failureCode: 'WDA_UNREACHABLE', detail: 'x' }],
      highSeverityCount: 0,
    });
    const md = toGithubSummary(r);
    expect(lines(md)[2]).toContain('**Verdict:** all workflows passed');
    expect(md).toContain('`swipium://session/sess-9/screenshot/ok.png`');
    expect(md).toContain('(no evidence)');
    expect(md).toContain('Findings: **0 high**');
    expect(md).toContain('1 tool/environment');
  });
});

describe('Markdown export', () => {
  it('spaces the finding line, adds an evidence column and renders environment changes once', () => {
    const r = base({
      findings: [{ severity: 'high', layer: 'app', kind: 'redbox', detail: 'boom' }],
      testOutcomes: [
        flow('signup', 'pass', { evidence: ['swipium://session/sess-9/checkpoint/a.png'] }),
        flow('login', 'fail', { category: 'app_bug', artifactUris: ['swipium://session/sess-9/screenshot/f.png'] }),
        flow('feed', 'pass', { contradicted: true }),
      ],
      environmentChanges: ['network set offline'],
      ciMutations: ['network set offline'],
    });
    const md = toMarkdown(r);
    expect(md).toContain('app/redbox: boom');
    expect(md).toContain('| Workflow | Outcome | Notes | Evidence |');
    expect(md).toContain('`swipium://session/sess-9/checkpoint/a.png`');
    expect(md).toContain('`swipium://session/sess-9/screenshot/f.png`');
    expect(md).toMatch(/\| feed \| ⚠️ pass \(contradicted\) \| - \| \(no evidence\) \|/);
    expect(md).not.toContain('## CI mutations');
    expect(md.match(/network set offline/g)).toHaveLength(1);
  });
});

describe('Playwright export', () => {
  it('still renders and carries the deprecation note', () => {
    const pw = JSON.parse(toPlaywrightJson(base({ testOutcomes: [flow('signup', 'pass')] })));
    expect(pw.deprecated).toBe(PLAYWRIGHT_DEPRECATION);
    expect(pw.deprecated).toContain('deprecated');
    expect(pw.suites[0].specs[0]).toMatchObject({ title: 'signup', ok: true });
  });
});

describe('PR summary', () => {
  it('a splash or Metro blocker is not an app regression', () => {
    const health = { appHealth: 'error' };
    expect(likelyReportCategory({ reason: 'splash screen still visible after 30s', category: 'other' }, health)).toBe('environment/setup');
    expect(likelyReportCategory({ reason: 'Metro bundler loading screen still visible' }, health)).toBe('environment/setup');
    expect(likelyReportCategory({ reason: 'expected text "Welcome" to be visible', category: 'app_bug' }, { appHealth: 'OK' })).toBe(
      'app regression',
    );
  });

  it('the history PR summary agrees on a splash blocker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swipium-pr-splash-'));
    try {
      const file = join(dir, 'report.json');
      const r = base({
        appHealth: 'degraded',
        testOutcomes: [flow('launch', 'blocked', { reason: 'splash screen still visible after 30s' })],
      });
      writeFileSync(file, JSON.stringify(r));
      expect(buildPrSummary(file).likelyCategory).toBe('environment/setup');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the evidence line lists each URI once', () => {
    const shot = 'swipium://session/sess-9/screenshot/f.png';
    const r = base({
      testOutcomes: [flow('login', 'fail', { category: 'app_bug', artifactUris: [shot] })],
      artifacts: [{ uri: shot, kind: 'screenshot' }],
    });
    const line = inlinePrSummary(r)
      .split('\n')
      .find((l) => l.startsWith('Evidence:'))!;
    expect(line.split(shot)).toHaveLength(2);
  });
});

describe('a 2.3.5 report (no schemaVersion, steps or origin) renders in every format', () => {
  const old = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'reports', 'report-2.3.5-fail.json'), 'utf8')) as ReportData;

  it('has the old shape', () => {
    expect(old.schemaVersion).toBeUndefined();
    expect(old.steps).toBeUndefined();
    expect(old.testOutcomes.some((n) => n.origin)).toBe(false);
  });

  it('junit, sarif, github-summary, markdown, playwright and the PR summary all render', () => {
    const policy = gate(old);
    expect(policy.block).toBe(true);
    const cases = casesOf(toJUnit(old, policy));
    expect(cases.find((c) => c['@_name'] === 'launch_smoke')?.failure?.['@_type']).toBe('app_bug');
    expect(cases.filter((c) => c.skipped?.['@_message'].startsWith('blocked: '))).toHaveLength(2);
    const sarif = JSON.parse(toSarif(old, policy));
    expect(sarif.runs[0].results.map((x: { ruleId: string }) => x.ruleId)).toEqual(['REDBOX']);
    const md = toGithubSummary(old, policy);
    const first = md.split('\n').findIndex((l) => l.includes('**launch\\_smoke**'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(8);
    const markdown = toMarkdown(old);
    expect(markdown).toContain('`swipium://session/d8e10222/screenshot/smoke-baseline-1791771296453.png`');
    expect(markdown).not.toContain('## CI mutations');
    const pw = JSON.parse(toPlaywrightJson(old));
    expect(pw.suites[0].specs.length).toBeGreaterThan(0);
    expect(inlinePrSummary(old)).toContain('Swipium: BLOCK');
  });
});
