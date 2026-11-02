// The agent summary (summary.md and the report head): failure first, <= 2 KB, in a fixed order.
// Pure fixtures with a fixed session root, so byte counts don't depend on $HOME.

import { describe, expect, it } from 'vitest';
import { AGENT_SUMMARY_MAX_BYTES, buildAgentSummary, type AgentSummaryReport } from '../src/report/summary.js';
import { buildReportHead, REPORT_HEAD_MAX_CHARS } from '../src/report/head.js';

const ROOT = '/fixed/swipium/runs/proj-0000/abcd1234';
const OPTS = { reportHtmlPath: `${ROOT}/report/report.html`, reportJsonPath: `${ROOT}/report/report-1700000000000.json` };
const URI = (p: string) => `swipium://session/abcd1234/${p}`;
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

function failSteps(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    i,
    at: 1000 + i,
    durationMs: 50,
    source: 'flow',
    action: 'tap',
    target: `tap "Button ${i}"`,
    result: 'failed',
    failureCode: 'ELEMENT_NOT_FOUND',
    ...(i % 2 === 0 ? { screenshotUri: URI(`screenshot/fail-${i}.png`) } : { screenshotSkipped: 'screenshot withheld (secure field)' }),
  }));
}

const PASS: AgentSummaryReport = {
  executiveSummary: { risk: 'ship', reasons: ['no blocking findings; native + app healthy'], nextAction: 'No blocking issues found.' },
  nativeHealth: 'OK',
  appHealth: 'OK',
  testOutcomes: [
    { workflow: 'launch_smoke', outcome: 'pass', origin: 'smoke' },
    { workflow: 'login', outcome: 'pass', origin: 'flow' },
  ],
  findings: [],
  steps: [],
};

const FAIL: AgentSummaryReport = {
  executiveSummary: { risk: 'block', reasons: ['1 workflow(s) failed'], nextAction: 'Fix "checkout" before shipping.' },
  nativeHealth: 'OK',
  appHealth: 'OK',
  testOutcomes: [
    { workflow: 'login', outcome: 'pass', origin: 'flow' },
    { workflow: 'checkout', outcome: 'fail', origin: 'flow', category: 'app_bug', reason: 'Pay does nothing', stepRange: [0, 2] },
  ],
  steps: [
    { i: 0, at: 1, durationMs: 10, source: 'flow', action: 'tap', result: 'ok' },
    { i: 1, at: 2, durationMs: 10, source: 'flow', action: 'tap', result: 'ok' },
    {
      i: 2,
      at: 3,
      durationMs: 10,
      source: 'flow',
      action: 'assertVisible',
      result: 'failed',
      failureCode: 'ASSERTION_FAILED',
      screenshotUri: URI('screenshot/fail-2.png'),
    },
  ],
  findings: [{ severity: 'medium', layer: 'app', kind: 'logbox', detail: 'Warning: each child needs a key' }],
};

const BLOCKED: AgentSummaryReport = {
  executiveSummary: {
    risk: 'block',
    reasons: ['not tested: the run stopped (BUILD_FAILED) before the app was tested'],
    nextAction: 'Not tested: the run stopped (BUILD_FAILED) before the app was tested. This run is not a pass; fix the blocker and re-run.',
  },
  notTested: { reason: 'the run stopped (BUILD_FAILED) before the app was tested', failureCode: 'BUILD_FAILED', reachedApp: false },
  nativeHealth: 'not checked',
  appHealth: 'not checked',
  testOutcomes: [],
  findings: [],
  steps: [],
  artifacts: [{ uri: URI('build/gradle-1.log'), kind: 'build', path: 'build/gradle-1.log', createdAt: 5 }],
};

const MANY_FAILURES: AgentSummaryReport = {
  executiveSummary: { risk: 'block', reasons: ['20 workflow(s) failed'], nextAction: 'Fix "flow-0" before shipping.' },
  nativeHealth: 'OK',
  appHealth: 'OK',
  testOutcomes: Array.from({ length: 20 }, (_, i) => ({
    workflow: `flow-${i}-with-a-reasonably-long-descriptive-name`,
    outcome: 'fail' as const,
    origin: 'flow',
    category: 'app_bug',
    reason: `step ${i} failed: ${'x'.repeat(200)}`,
    stepRange: [i, i] as [number, number],
  })),
  steps: failSteps(20),
  findings: [],
};

const MANY_FINDINGS: AgentSummaryReport = {
  executiveSummary: { risk: 'block', reasons: ['30 high-severity finding(s)'], nextAction: 'Investigate: crash' },
  nativeHealth: 'error',
  appHealth: 'error',
  testOutcomes: [],
  steps: [],
  findings: Array.from({ length: 30 }, (_, i) => ({
    severity: i % 3 === 0 ? 'high' : 'medium',
    layer: 'native',
    kind: 'crash',
    detail: `FATAL EXCEPTION ${i}: ${'java.lang.IllegalStateException '.repeat(8)}`,
    screenshotUri: URI(`screenshot/crash-${i}.png`),
    count: 2,
  })),
};

describe('agent summary', () => {
  it.each([
    ['pass', PASS],
    ['fail', FAIL],
    ['blocked', BLOCKED],
    ['20-failure', MANY_FAILURES],
    ['30-finding', MANY_FINDINGS],
  ])('%s fixture stays within 2048 bytes and ends with the report paths', (_name, report) => {
    const text = buildAgentSummary(report, OPTS);
    // summary.md is the text plus a trailing newline.
    expect(bytes(`${text}\n`)).toBeLessThanOrEqual(AGENT_SUMMARY_MAX_BYTES);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^RELEASE RISK: (SHIP|BLOCK|CAUTION)/);
    expect(lines.at(-2)).toBe(`Open the report: ${OPTS.reportHtmlPath}`);
    expect(lines.at(-1)).toBe(`report.json: ${OPTS.reportJsonPath}`);
  });

  it('says "not tested" exactly once on a blocked run, with the fix and the build log', () => {
    const text = buildAgentSummary(BLOCKED, OPTS);
    expect(text.match(/not tested/gi)).toHaveLength(1);
    expect(text).toContain('Not tested (BUILD_FAILED)');
    expect(text).toContain('Next: Open the build log artifact');
    expect(text).toContain('Log: build/gradle-1.log');
    expect(text.split('\n')[0]).toBe('RELEASE RISK: BLOCK: blocked by BUILD_FAILED');
  });

  it('says "no log captured" when the blocked run saved no log', () => {
    expect(buildAgentSummary({ ...BLOCKED, artifacts: [] }, OPTS)).toContain('Log: no log captured');
  });

  it('keeps the order: verdict, health, failures, findings, passes, paths', () => {
    const text = buildAgentSummary(FAIL, OPTS);
    const at = (s: string) => text.indexOf(s);
    expect(at('RELEASE RISK')).toBe(0);
    expect(at('Health:')).toBeGreaterThan(at('RELEASE RISK'));
    expect(at('Failures (1)')).toBeGreaterThan(at('Health:'));
    expect(at('Findings (1')).toBeGreaterThan(at('Failures (1)'));
    expect(at('Passed: 1 of 2')).toBeGreaterThan(at('Findings (1'));
    expect(at('Open the report')).toBeGreaterThan(at('Passed:'));
    expect(text).toMatch(/- FAIL checkout step #2 ASSERTION_FAILED( "[^"]+")?: /);
    expect(text).toContain(`${URI('screenshot/fail-2.png')}; do:`);
  });

  it('every failure line has a step number and a screenshot or the reason there is none', () => {
    const text = buildAgentSummary(MANY_FAILURES, OPTS);
    const failLines = text.split('\n').filter((l) => l.startsWith('- FAIL'));
    expect(failLines.length).toBeGreaterThan(0);
    expect(failLines.length).toBeLessThanOrEqual(8);
    for (const l of failLines) {
      expect(l).toMatch(/step #\d+/);
      expect(l).toMatch(/swipium:\/\/\S+\.png|\(no screenshot: [^)]+\)/);
    }
    expect(text).toMatch(/\+\d+ more in report\.html/);
    expect(text).toContain('(no screenshot: screenshot withheld (secure field))');
  });

  it('lists at most 5 findings, high first, then +N more', () => {
    const text = buildAgentSummary(MANY_FINDINGS, OPTS);
    const findingLines = text.split('\n').filter((l) => /^- \[/.test(l));
    expect(findingLines.length).toBeLessThanOrEqual(5);
    expect(findingLines[0]).toMatch(/^- \[high\]/);
    expect(text).toMatch(/\+\d+ more$/m);
  });

  it('counts the latest attempt per workflow: a flow fail then pass is one flaky pass, no failure line', () => {
    const text = buildAgentSummary(
      {
        ...PASS,
        testOutcomes: [
          { workflow: 'login', outcome: 'fail', origin: 'flow', category: 'app_bug' },
          { workflow: 'Login ', outcome: 'pass', origin: 'flow' },
        ],
      },
      OPTS,
    );
    expect(text).not.toContain('- FAIL');
    expect(text).toContain('Passed: 1 of 1 outcome(s) (1 flaky)');
  });

  it('the findings high count is the report count, so a tool failure is not a high app finding', () => {
    const text = buildAgentSummary(
      {
        ...PASS,
        findings: [{ severity: 'high', layer: 'native', kind: 'wda_unreachable', failureCode: 'WDA_UNREACHABLE', detail: 'no source' }],
        highSeverityCount: 0,
      },
      OPTS,
    );
    expect(text).toContain('high: 0');
  });

  it('a later skip or n/a never hides a failure in the summary', () => {
    const text = buildAgentSummary(
      {
        ...PASS,
        testOutcomes: [
          { workflow: 'checkout', outcome: 'fail', origin: 'flow', category: 'app_bug', reason: 'total wrong' },
          { workflow: 'checkout', outcome: 'skipped', origin: 'smoke', reason: 'budget: session budget exhausted' },
          { workflow: 'login', outcome: 'fail', origin: 'agent', source: 'qa_note', category: 'app_bug' },
          { workflow: 'Login ', outcome: 'not_applicable', origin: 'agent', source: 'qa_note' },
        ],
      },
      OPTS,
    );
    expect(text).toContain('Failures (2):');
  });

  it('a partial report says which job is still running; an html failure is said instead of the open line', () => {
    const text = buildAgentSummary(
      { ...PASS, partial: { jobId: 'j1', kind: 'explore' } },
      { ...OPTS, reportHtmlError: 'boom', reportHtmlPath: undefined },
    );
    expect(text).toContain('Partial: job j1 (explore) was still running');
    expect(text).toContain('report.html was not written (boom)');
    expect(text).not.toContain('Open the report');
  });

  it('readiness, QA level, taxonomy, ledger, WDA, timing and the artifact list stay out', () => {
    const text = buildAgentSummary(FAIL, OPTS);
    expect(text).not.toMatch(/QA level|readiness|taxonomy|mutation ledger|wda:|timing:|artifacts:/i);
  });
});

describe('report head', () => {
  it('follows the summary order and ends with the report.md pointer', () => {
    const head = buildReportHead(FAIL as Record<string, unknown>, {
      reportMdUri: URI('report/r-summary.md'),
      reportUri: URI('report/r.json'),
      reportHtmlPath: OPTS.reportHtmlPath,
    });
    const lines = head.split('\n');
    expect(lines[0]).toBe('RELEASE RISK: BLOCK: 1 workflow(s) failed');
    expect(lines[1]).toBe('Health: native OK, app OK');
    expect(head).toContain(`Open the report: ${OPTS.reportHtmlPath}`);
    expect(head).toContain(`report.json: ${URI('report/r.json')}`);
    expect(lines.at(-1)).toBe(`report.md: ${URI('report/r-summary.md')}`);
  });

  it('stays within budget on the large fixtures and keeps the pointer', () => {
    for (const r of [MANY_FAILURES, MANY_FINDINGS]) {
      const head = buildReportHead(r as Record<string, unknown>, { reportMdUri: URI('report/x.md'), reportHtmlPath: OPTS.reportHtmlPath });
      expect(bytes(head)).toBeLessThanOrEqual(Math.min(AGENT_SUMMARY_MAX_BYTES, REPORT_HEAD_MAX_CHARS));
      expect(head.endsWith(`report.md: ${URI('report/x.md')}`)).toBe(true);
    }
  });
});

describe('release policy notice', () => {
  it('says once when .swipium/policy.json was ignored', () => {
    const text = buildAgentSummary(
      { ...FAIL, releasePolicyNotice: '.swipium/policy.json is not valid JSON: it was ignored, so every failure blocks' },
      OPTS,
    );
    expect(text.match(/^Policy: /gm)?.length).toBe(1);
    expect(text).toContain('it was ignored, so every failure blocks');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
  });
});
