// Every report surface agrees, end to end through generateSessionReport and the saved report.json:
//  - log tails embedded in report.html are scrubbed (credential patterns and session secrets);
//  - a notTested block on a reached and exercised app is informational: normal layout, gate PASS;
//  - two workflows whose names redact to the same text keep separate attempt groups.
// Hermetic: HOME is a temp dir (test/setupFakeHome.ts), no device discovery, no driver.

import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { generateSessionReport } = await import('../src/services/report.js');
const { latestAttempts, reportPolicyVerdicts, toGithubSummary } = await import('../src/report/export.js');
const { applyPolicy } = await import('../src/report/policy.js');
const { renderReportHtml } = await import('../src/report/html.js');
type ReportData = import('../src/report/export.js').ReportData;
type Session = import('../src/session/store.js').Session;
type Store = InstanceType<typeof SessionStore>;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fresh(): { store: Store; s: Session } {
  const root = mkdtempSync(join(tmpdir(), 'swipium-consistency-'));
  roots.push(root);
  const store = new SessionStore();
  const s = store.create(root);
  s.appId = 'com.example.app';
  return { store, s };
}

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl';
const SECRET = 'Zq9-session-secret-77';

function writeMetroLog(store: Store, s: Session): string {
  const uri = store.saveArtifact(s, 'metro', 'metro.log', '', 'text/plain');
  const path = s.artifacts.find((a) => a.uri === uri)!.path;
  // Appended raw, the way the Metro child process writes it (never through saveArtifact).
  appendFileSync(
    path,
    [
      'metro: starting',
      `GET /api/me Authorization: Bearer ${JWT}`,
      'login form posted password=hunter2secret ok',
      `echo ${SECRET} from the dev menu`,
      'metro: bundling failed',
    ].join('\n'),
  );
  return path;
}

const savedReport = (store: Store, uri: string) => JSON.parse(readFileSync(store.findArtifact(uri)!.rec.path, 'utf8')) as ReportData;

describe('report.html log tails are scrubbed', () => {
  it('a Bearer JWT, a password= pair and a session secret in metro.log never reach the HTML', async () => {
    const { store, s } = fresh();
    s.secrets.add(SECRET);
    writeMetroLog(store, s);
    const res = await generateSessionReport(store, s, {
      includeCurrentDump: false,
      notTested: { reason: 'Metro bundler is not running', failureCode: 'METRO_REQUIRED', reachedApp: false },
    });
    const html = readFileSync(res.reportHtmlPath, 'utf8');
    expect(html).toContain('metro: bundling failed'); // the tail rendered
    expect(html).toContain('NOT TESTED');
    for (const leaked of [JWT, 'eyJhbGciOiJIUzI1NiJ9', 'hunter2secret', SECRET]) expect(html).not.toContain(leaked);
  });

  it('without a redactor (the CLI has no secrets) credential patterns are still scrubbed', async () => {
    const { store, s } = fresh();
    writeMetroLog(store, s);
    const r = baseNotTested(s);
    const html = await renderReportHtml(r, { sessionDir: s.dir });
    expect(html).toContain('metro: bundling failed');
    for (const leaked of [JWT, 'hunter2secret']) expect(html).not.toContain(leaked);
  });
});

function baseNotTested(s: Session): ReportData {
  return {
    sessionId: s.id,
    appId: 'com.example.app',
    device: null,
    coverage: 'smoke',
    executiveSummary: { risk: 'block', reasons: ['not tested'], nextAction: 'Start Metro.' },
    notTested: { reachedApp: false, reason: 'Metro bundler is not running', failureCode: 'METRO_REQUIRED' },
    nativeHealth: 'unknown',
    appHealth: 'unknown',
    findings: [],
    highSeverityCount: 0,
    testOutcomes: [],
    outcomeTally: {},
    environmentChanges: [],
    guardrailOverrides: [],
    finalNetwork: 'online',
    networkRestore: 'unchanged',
    authState: 'unknown',
    phaseTimings: { totalMs: 0, setupMs: 0, activeMs: 0, timeToLoginMs: null },
    artifacts: s.artifacts.map((a) => ({ uri: a.uri, kind: a.kind, path: 'logs/metro.log', createdAt: a.createdAt })),
    schemaVersion: 2,
    steps: [],
  } as ReportData;
}

describe('notTested on a reached and exercised app', () => {
  it('normal layout, no "Not tested" in HTML, summary or GitHub summary, and the gate passes everywhere', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    store.addNote(s, {
      at: Date.now(),
      workflow: 'launch_smoke',
      outcome: 'pass',
      origin: 'smoke',
      reason: 'native=ok app=ok quality=good',
    });
    const res = await generateSessionReport(store, s, {
      includeCurrentDump: false,
      notTested: { reason: 'an optional step was not reached', failureCode: 'NOT_TESTED' },
    });
    const r = res.report as unknown as ReportData;
    expect(r.notTested).toMatchObject({ reachedApp: true, exercised: true });

    const html = readFileSync(res.reportHtmlPath, 'utf8');
    expect(html).toContain('Release gate: PASS');
    expect(html).toContain('id="outcomes"');
    expect(html).not.toMatch(/not tested/i);
    expect(res.summaryText).not.toMatch(/not tested/i);

    const saved = savedReport(store, res.reportUri);
    expect(toGithubSummary(saved)).not.toMatch(/not tested/i);
    expect(applyPolicy(reportPolicyVerdicts(saved), null).block).toBe(false);
    expect(applyPolicy(reportPolicyVerdicts(r), null).block).toBe(false);
    expect(r.executiveSummary.risk).toBe('ship');
  });
});

describe('attempt groups survive redaction', () => {
  it('two workflows whose names redact to the same text: the fail still blocks, in the banner and on re-gate', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    s.secrets.add('user1@example.com');
    s.secrets.add('user2@example.com');
    store.addNote(s, {
      at: Date.now() - 10,
      workflow: 'login user1@example.com',
      outcome: 'fail',
      category: 'app_bug',
      origin: 'flow',
      reason: 'qa_flow_run failed at step 2',
    });
    store.addNote(s, {
      at: Date.now(),
      workflow: 'login user2@example.com',
      outcome: 'pass',
      origin: 'flow',
      reason: 'qa_flow_run: 4 steps',
    });
    const res = await generateSessionReport(store, s, { includeCurrentDump: false });
    const r = res.report as unknown as ReportData;

    // Both names redact to the same text, but they are two attempt groups.
    expect(new Set(r.testOutcomes.map((n) => n.workflow)).size).toBe(1);
    expect(new Set(r.testOutcomes.map((n) => n.attemptKey)).size).toBe(2);
    expect(r.testOutcomes.some((n) => n.superseded)).toBe(false);
    expect(r.executiveSummary.risk).toBe('block');
    expect(applyPolicy(reportPolicyVerdicts(r), null).block).toBe(true);

    // The CLI re-gates the saved report.json on its own.
    const saved = savedReport(store, res.reportUri);
    expect(latestAttempts(saved.testOutcomes)).toHaveLength(2);
    expect(applyPolicy(reportPolicyVerdicts(saved), null).block).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('user1@example.com');
  });

  it('reports without attemptKey (older) still group by kind and workflow name', () => {
    const notes = [
      { workflow: 'Login', outcome: 'fail' as const, origin: 'flow' },
      { workflow: 'login ', outcome: 'pass' as const, origin: 'flow' },
    ];
    const once = latestAttempts(notes);
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ outcome: 'pass', flaky: true });
  });
});
