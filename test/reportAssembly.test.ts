// generateSessionReport assembly: report.json additions (schema 2, steps, partial, outcome evidence,
// contradicted, relative artifact paths), one high-severity count, latest-attempt verdicts,
// report.html written once per session, the <= 2 KB summary.md, the XML-safe dump, the visual-only
// wording, and the idempotent suite / issue-ledger fold.
// Hermetic: HOME is a temp dir (test/setupFakeHome.ts), no device discovery, fake driver only.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { generateSessionReport, runFoldKey } = await import('../src/services/report.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
const { FakeDriver, buttonScreen } = await import('./actFixFake.js');
const { applyPolicy } = await import('../src/report/policy.js');
const { latestAttempts, reportPolicyVerdicts, toJUnit, workflowKey } = await import('../src/report/export.js');
type ReportData = import('../src/report/export.js').ReportData;
type Session = import('../src/session/store.js').Session;
type Store = InstanceType<typeof SessionStore>;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
afterEach(() => setDriverFactoryForTests(undefined));

// A fixed session root keeps paths (and so summary.md byte counts) independent of $HOME/$TMPDIR.
const FIXED_ROOT = '/tmp/swipium-report-fixture';

function newSession(opts: { fixedDir?: string } = {}): { store: Store; s: Session } {
  const root = mkdtempSync(join(tmpdir(), 'swipium-assembly-'));
  roots.push(root);
  const store = new SessionStore();
  let sessionDir: string | undefined;
  if (opts.fixedDir) {
    sessionDir = join(FIXED_ROOT, opts.fixedDir);
    rmSync(sessionDir, { recursive: true, force: true });
    roots.push(sessionDir);
  }
  const s = store.create(root, undefined, sessionDir ? { sessionDir } : undefined);
  s.appId = 'com.example.app';
  store.milestone(s, 'app_launch_end');
  return { store, s };
}

async function report(store: Store, s: Session, opts: Parameters<typeof generateSessionReport>[2] = {}) {
  const res = await generateSessionReport(store, s, { includeCurrentDump: false, ...opts });
  return { res, r: res.report as unknown as ReportData };
}

const png = Buffer.from('89504e470d0a1a0a', 'hex');

describe('report.json additions', () => {
  it('carries schemaVersion 2, the steps, partial:null and artifacts with relative paths', async () => {
    const { store, s } = newSession();
    store.addStep(s, { durationMs: 12, source: 'act', action: 'tap', target: 'tap "Sign in"', result: 'ok' });
    store.saveArtifact(s, 'screenshot', 'shot.png', png, 'image/png');
    const { r } = await report(store, s);
    expect(r.schemaVersion).toBe(2);
    expect(r.partial).toBeNull();
    expect(r.steps).toHaveLength(1);
    expect(r.steps![0]).toMatchObject({ i: 0, source: 'act', target: 'tap "Sign in"', result: 'ok', durationMs: 12 });
    const shot = r.artifacts.find((a) => a.uri.endsWith('shot.png'))!;
    expect(shot).toMatchObject({ path: 'screenshots/shot.png', redaction: 'not-applied' });
    expect(typeof shot.createdAt).toBe('number');
    for (const a of r.artifacts) if (a.path) expect(isAbsolute(a.path)).toBe(false);
    expect(JSON.stringify(r.artifacts)).not.toContain(s.dir);
    // Existing keys stay.
    expect(r).toHaveProperty('ciMutations');
    expect(r).toHaveProperty('outcomeTally');
  });

  it('a typed secret in a step target never reaches report.json', async () => {
    const { store, s } = newSession();
    s.secrets.add('hunter2-secret');
    store.addStep(s, { durationMs: 1, source: 'act', action: 'type', target: 'type "hunter2-secret" into "Password"', result: 'ok' });
    const { res } = await report(store, s);
    expect(readFileSync(store.findArtifact(res.reportUri)!.rec.path, 'utf8')).not.toContain('hunter2-secret');
  });

  it('links evidence that resolves to session artifacts only (checkpoint, failed step shot and dump, explicit URIs)', async () => {
    const { store, s } = newSession();
    const cp = store.saveArtifact(s, 'checkpoint', 'cp.png', png, 'image/png');
    const failShot = store.saveArtifact(s, 'screenshot', 'fail.png', png, 'image/png');
    const failDump = store.saveArtifact(s, 'dump', 'fail.xml', '<hierarchy/>', 'application/xml');
    const okShot = store.saveArtifact(s, 'screenshot', 'ok.png', png, 'image/png');
    const a = store.addStep(s, { durationMs: 5, source: 'flow', action: 'tap', result: 'ok', screenshotUri: okShot });
    const b = store.addStep(s, {
      durationMs: 5,
      source: 'flow',
      action: 'assertVisible',
      result: 'failed',
      failureCode: 'ASSERTION_FAILED',
      screenshotUri: failShot,
      dumpUri: failDump,
    });
    store.addNote(s, {
      at: Date.now(),
      workflow: 'checkout',
      outcome: 'fail',
      category: 'app_bug',
      origin: 'flow',
      stepRange: [a.i, b.i],
      checkpointUri: cp,
      artifactUris: ['swipium://session/nope/screenshot/unknown.png', okShot],
    });
    const { r, res } = await report(store, s);
    const o = r.testOutcomes.find((n) => n.workflow === 'checkout')!;
    expect(o.stepRange).toEqual([a.i, b.i]);
    expect(o.evidence).toEqual([cp, failShot, failDump, okShot]);
    const manifestUris = new Set((res.manifest as { files: Array<{ uri: string }> }).files.map((f) => f.uri));
    for (const n of r.testOutcomes) for (const u of n.evidence ?? []) expect(manifestUris.has(u)).toBe(true);
  });

  it('a note with no stored range covers the steps since the previous note', async () => {
    const { store, s } = newSession();
    store.addNote(s, { at: Date.now() - 1000, workflow: 'first', outcome: 'pass', origin: 'agent', source: 'qa_note' });
    const st = store.addStep(s, { durationMs: 1, source: 'act', action: 'tap', result: 'ok' });
    store.addNote(s, { at: Date.now() + 5, workflow: 'second', outcome: 'pass', origin: 'agent', source: 'qa_note' });
    const { r } = await report(store, s);
    expect(r.testOutcomes.find((n) => n.workflow === 'second')!.stepRange).toEqual([st.i, st.i]);
  });
});

describe('contradicted passes', () => {
  it('a high crash inside the range of a pass marks it contradicted', async () => {
    const { store, s } = newSession();
    const t0 = Date.now();
    const st = store.addStep(s, { at: t0, durationMs: 1, source: 'flow', action: 'tap', result: 'ok' });
    s.findings.push({ at: t0 + 1, severity: 'high', kind: 'crash', layer: 'native', detail: 'FATAL EXCEPTION: main' });
    store.addNote(s, { at: t0 + 2, workflow: 'login', outcome: 'pass', origin: 'flow', stepRange: [st.i, st.i] });
    const { r } = await report(store, s);
    expect(r.testOutcomes.find((n) => n.workflow === 'login')!.contradicted).toBe(true);
  });

  it('a failed flow or smoke step in the range contradicts a pass', async () => {
    const { store, s } = newSession();
    const a = store.addStep(s, { durationMs: 1, source: 'smoke', action: 'launch', result: 'failed', failureCode: 'BLANK_SCREEN' });
    store.addNote(s, { at: Date.now() + 1, workflow: 'launch_smoke', outcome: 'pass', origin: 'smoke', stepRange: [a.i, a.i] });
    const { r } = await report(store, s);
    expect(r.testOutcomes[0].contradicted).toBe(true);
  });

  it('a failed act step followed by a passing note is not flagged', async () => {
    const { store, s } = newSession();
    const a = store.addStep(s, { durationMs: 1, source: 'act', action: 'tap', result: 'failed', failureCode: 'ELEMENT_NOT_FOUND' });
    const b = store.addStep(s, { durationMs: 1, source: 'act', action: 'tap', result: 'ok' });
    store.addNote(s, { at: Date.now() + 1, workflow: 'login', outcome: 'pass', origin: 'agent', source: 'qa_note', stepRange: [a.i, b.i] });
    const { r } = await report(store, s);
    expect(r.testOutcomes[0].contradicted).toBeUndefined();
  });
});

describe('verdicts agree with the gate', () => {
  it('flow fail then flow pass: the risk banner is not BLOCK', async () => {
    const { store, s } = newSession();
    store.addNote(s, {
      at: Date.now() - 10,
      workflow: 'login',
      outcome: 'fail',
      category: 'app_bug',
      origin: 'flow',
      reason: 'qa_flow_run failed',
    });
    store.addNote(s, { at: Date.now(), workflow: 'login', outcome: 'pass', origin: 'flow', reason: 'qa_flow_run: 3 steps' });
    const { r, res } = await report(store, s);
    expect(r.executiveSummary.risk).not.toBe('block');
    expect(r.appVerdict?.status).not.toBe('BLOCKED');
    expect(res.summaryText).not.toContain('- FAIL');
  });

  it('flow fail then agent note pass still blocks', async () => {
    const { store, s } = newSession();
    store.addNote(s, { at: Date.now() - 10, workflow: 'login', outcome: 'fail', category: 'app_bug', origin: 'flow' });
    store.addNote(s, { at: Date.now(), workflow: 'login', outcome: 'pass', origin: 'agent', source: 'qa_note' });
    const { r } = await report(store, s);
    expect(r.executiveSummary.risk).toBe('block');
  });

  it('highSeverityCount counts unique, non-tool high findings, and the banner uses it', async () => {
    const { store, s } = newSession();
    const crash = { severity: 'high', kind: 'crash', layer: 'native' as const, detail: 'FATAL EXCEPTION: main' };
    s.findings.push({ at: 1, ...crash }, { at: 2, ...crash });
    s.findings.push({ at: 3, severity: 'high', kind: 'wda_unreachable', layer: 'native', detail: 'WDA returned no source' });
    const { r } = await report(store, s);
    expect(r.highSeverityCount).toBe(1);
    expect(r.executiveSummary.reasons).toContain('1 high-severity finding(s)');
  });
});

describe('a later skip, block or n/a never hides a failure', () => {
  type NoteIn = Parameters<Store['addNote']>[1];
  const t0 = Date.now() - 1000;
  const scenarios: Array<{ name: string; workflow: string; notes: NoteIn[] }> = [
    {
      name: 'flow fail then smoke budget skip of the same flow',
      workflow: 'checkout',
      notes: [
        { at: t0, workflow: 'checkout', outcome: 'fail', category: 'app_bug', origin: 'flow', reason: 'qa_flow_run failed' },
        {
          at: t0 + 1,
          workflow: 'checkout',
          outcome: 'skipped',
          category: 'intentionally_skipped',
          origin: 'smoke',
          reason: 'budget: time',
        },
      ],
    },
    {
      name: 'flow fail then smoke blocked',
      workflow: 'checkout',
      notes: [
        { at: t0, workflow: 'checkout', outcome: 'fail', category: 'app_bug', origin: 'flow', reason: 'qa_flow_run failed' },
        { at: t0 + 1, workflow: 'checkout', outcome: 'blocked', category: 'other', origin: 'smoke', reason: 'METRO_REQUIRED: down' },
      ],
    },
    {
      name: 'launch_smoke fail then a cancelled smoke',
      workflow: 'launch_smoke',
      notes: [
        { at: t0, workflow: 'launch_smoke', outcome: 'fail', category: 'app_bug', origin: 'smoke', reason: 'app=error redbox' },
        {
          at: t0 + 1,
          workflow: 'launch_smoke',
          outcome: 'skipped',
          category: 'intentionally_skipped',
          origin: 'smoke',
          reason: 'cancelled',
        },
      ],
    },
    {
      name: 'agent fail then agent n/a',
      workflow: 'login',
      notes: [
        { at: t0, workflow: 'login', outcome: 'fail', category: 'app_bug', origin: 'agent', source: 'qa_note', reason: 'wrong error text' },
        { at: t0 + 1, workflow: 'Login ', outcome: 'not_applicable', origin: 'agent', source: 'qa_note' },
      ],
    },
  ];
  for (const sc of scenarios) {
    it(`${sc.name}: gate, JUnit, risk banner and summary all block`, async () => {
      const { store, s } = newSession();
      for (const n of sc.notes) store.addNote(s, n);
      const { r, res } = await report(store, s);
      const gate = applyPolicy(reportPolicyVerdicts(r), null);
      expect(gate.block).toBe(true);
      expect(gate.blocked).toContain(`${sc.workflow}: app_bug`);
      expect(toJUnit(r, gate)).toMatch(new RegExp(`<testcase name="${sc.workflow}"[^>]*>\\s*<failure`));
      expect(r.executiveSummary.risk).toBe('block');
      expect(res.summaryText).toContain('- FAIL');
      // The later note is kept as an attempt of the failure that counts.
      const counting = latestAttempts(r.testOutcomes).find((n) => workflowKey(n.workflow) === workflowKey(sc.workflow))!;
      expect(counting.outcome).toBe('fail');
      expect(counting.attempts?.map((a) => a.outcome)).toEqual([sc.notes[1].outcome]);
    });
  }

  it('a superseded healthy smoke pass does not make the run tested', async () => {
    const { store, s } = newSession();
    store.addNote(s, { at: t0, workflow: 'launch_smoke', outcome: 'pass', origin: 'smoke', reason: 'app=ok' });
    store.addNote(s, {
      at: t0 + 1,
      workflow: 'launch_smoke',
      outcome: 'fail',
      category: 'mcp_limitation',
      origin: 'smoke',
      reason: 'baseline failed',
    });
    const { r } = await report(store, s);
    expect(r.notTested?.exercised).toBe(false);
  });
});

describe('report.json keeps every attempt and marks the one that counts', () => {
  it('flow fail then pass: both entries kept, the last flaky with the fail as its attempt', async () => {
    const { store, s } = newSession();
    store.addNote(s, {
      at: Date.now() - 10,
      workflow: 'login',
      outcome: 'fail',
      category: 'app_bug',
      origin: 'flow',
      reason: 'qa_flow_run failed',
    });
    store.addNote(s, { at: Date.now(), workflow: 'login', outcome: 'pass', origin: 'flow', reason: 'qa_flow_run: 3 steps' });
    const { r, res } = await report(store, s);
    expect(r.testOutcomes).toHaveLength(2);
    const lastEntry = r.testOutcomes[1];
    expect(lastEntry.flaky).toBe(true);
    expect(lastEntry.attempts?.[0].outcome).toBe('fail');
    expect(r.testOutcomes[0].attempts).toBeUndefined();

    // The CLI re-gates the saved file: same verdicts, attempts not doubled.
    const saved = JSON.parse(readFileSync(store.findArtifact(res.reportUri)!.rec.path, 'utf8')) as ReportData;
    const once = latestAttempts(saved.testOutcomes);
    expect(once).toHaveLength(1);
    expect(once[0].attempts).toHaveLength(1);
    expect(latestAttempts(once)).toEqual(once);
    expect(latestAttempts([...saved.testOutcomes])).toEqual(latestAttempts(r.testOutcomes));
    expect(reportPolicyVerdicts(saved)).toEqual(reportPolicyVerdicts(r));
    expect(applyPolicy(reportPolicyVerdicts(saved), null).block).toBe(false);
  });
});

describe('visual-only wording', () => {
  it('says visual-only when no UI tree was read', async () => {
    const { store, s } = newSession();
    store.addNote(s, {
      at: Date.now(),
      workflow: 'launch_smoke',
      outcome: 'pass',
      origin: 'smoke',
      method: 'visual',
      reason: 'native=ok app=unverified',
    });
    const { r } = await report(store, s);
    expect(r.appVerdict?.summary).toMatch(/visual-only: no UI tree was read/);
  });

  it('does not say visual-only when a tree was read (a tool failure made health unverified)', async () => {
    const { store, s } = newSession();
    store.addNote(s, { at: Date.now(), workflow: 'login', outcome: 'pass', origin: 'flow', method: 'structured' });
    s.findings.push({ at: Date.now(), severity: 'high', kind: 'wda_unreachable', layer: 'native', detail: 'WDA returned no source' });
    const { r } = await report(store, s);
    expect(r.appHealth).toBe('unverified');
    expect(JSON.stringify([r.appVerdict, r.executiveSummary])).not.toMatch(/visual-only/);
    expect(r.appVerdict?.summary).toMatch(/tool failure/);
  });
});

describe('report-time dump', () => {
  it('goes through the XML-safe structural redaction (markup intact, secret values scrubbed)', async () => {
    const { store, s } = newSession();
    // "class" as a secret: a plain-text pass would rewrite every class="..." attribute name.
    s.secrets.add('class');
    s.secrets.add('Secret-Value-42');
    const xml = buttonScreen('Secret-Value-42', 2);
    const fake = new FakeDriver(xml);
    s.driver = fake;
    const res = await generateSessionReport(store, s, { includeCurrentDump: true });
    expect(res.dumpUri).toBeTruthy();
    const saved = readFileSync(store.findArtifact(res.dumpUri!)!.rec.path, 'utf8');
    expect(saved).toContain('class="');
    expect(saved).not.toContain('Secret-Value-42');
  });
});

describe('report.html', () => {
  it('is written once per session at report/report.html, private, with ONE artifact record across calls', async () => {
    const { store, s } = newSession();
    const first = await generateSessionReport(store, s, { includeCurrentDump: false });
    const second = await generateSessionReport(store, s, { includeCurrentDump: false });
    expect(first.reportHtmlPath).toBe(join(s.dir, 'report', 'report.html'));
    expect(second.reportHtmlPath).toBe(first.reportHtmlPath);
    expect(first.reportHtmlUrl).toMatch(/^file:\/\//);
    expect(existsSync(first.reportHtmlPath)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(first.reportHtmlPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(first.reportHtmlPath, 'utf8')).toMatch(/<html/i);
    const recs = s.artifacts.filter((a) => a.uri.endsWith('/report/report.html'));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: 'report', mime: 'text/html' });
    expect(second.summaryText).toContain(`Open the report: ${first.reportHtmlPath}`);
  });
});

describe('partial reports', () => {
  it('a report made while an explore job runs is partial, in JSON and summary.md', async () => {
    const { store, s } = newSession();
    const job = store.createJob(s, 'explore');
    const { r, res } = await report(store, s);
    expect(r.partial).toEqual({ jobId: job.jobId, kind: 'explore' });
    expect(readFileSync(store.findArtifact(res.reportMdUri)!.rec.path, 'utf8')).toContain(`Partial: job ${job.jobId} (explore)`);
  });

  it('the reporting job itself (excludeJobId) does not make the report partial', async () => {
    const { store, s } = newSession();
    const job = store.createJob(s, 'test_this:execute');
    const { r } = await report(store, s, { excludeJobId: job.jobId });
    expect(r.partial).toBeNull();
  });
});

describe('summary.md', () => {
  it('stays within 2048 bytes on a 20-failure run at a fixed session root', async () => {
    const { store, s } = newSession({ fixedDir: 'twenty-fail' });
    for (let i = 0; i < 20; i++) {
      const st = store.addStep(s, { durationMs: 1, source: 'flow', action: 'tap', result: 'failed', failureCode: 'ELEMENT_NOT_FOUND' });
      store.addNote(s, {
        at: Date.now() + i,
        workflow: `flow-${i}-checkout-path`,
        outcome: 'fail',
        category: 'app_bug',
        origin: 'flow',
        reason: 'x'.repeat(300),
        stepRange: [st.i, st.i],
      });
    }
    for (let i = 0; i < 30; i++) s.findings.push({ at: i, severity: 'medium', kind: `k${i}`, layer: 'app', detail: 'y'.repeat(200) });
    const { res } = await report(store, s);
    const md = readFileSync(store.findArtifact(res.reportMdUri)!.rec.path, 'utf8');
    expect(Buffer.byteLength(md)).toBeLessThanOrEqual(2048);
    expect(md).toContain('more in report.html');
    expect(md).toContain(`Open the report: ${res.reportHtmlPath}`);
  });
});

describe('idempotent fold', () => {
  const lines = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0);
  const suiteState = (root: string) => {
    const p = join(root, '.swipium', 'test-suite.json');
    if (!existsSync(p)) return { cases: 0, history: 0 };
    const suite = JSON.parse(readFileSync(p, 'utf8')) as { cases: Array<{ history?: unknown[] }> };
    return { cases: suite.cases.length, history: suite.cases.reduce((n, c) => n + (c.history?.length ?? 0), 0) };
  };

  it('twice with no new activity folds once; a new note folds again', async () => {
    const { store, s } = newSession();
    store.addNote(s, {
      at: Date.now(),
      workflow: 'checkout',
      outcome: 'fail',
      category: 'app_bug',
      origin: 'agent',
      source: 'qa_note',
      reason: 'Pay does nothing',
    });
    const issuesLog = join(s.root, '.swipium', 'issues-log.jsonl');

    const first = await report(store, s);
    const key = s.lastFoldKey;
    expect(key).toBe(runFoldKey(s));
    const after1 = { issues: lines(issuesLog), suite: suiteState(s.root) };
    expect(after1.issues).toBeGreaterThan(0);

    const second = await report(store, s);
    expect(s.lastFoldKey).toBe(key);
    expect({ issues: lines(issuesLog), suite: suiteState(s.root) }).toEqual(after1);
    expect(second.r.persistentSuite).toEqual(first.r.persistentSuite);
    expect((second.r as unknown as { issues?: unknown }).issues).toEqual((first.r as unknown as { issues?: unknown }).issues);

    store.addNote(s, {
      at: Date.now() + 5,
      workflow: 'profile',
      outcome: 'fail',
      category: 'app_bug',
      origin: 'agent',
      source: 'qa_note',
      reason: 'Avatar missing',
    });
    await report(store, s);
    expect(s.lastFoldKey).not.toBe(key);
    expect(lines(issuesLog)).toBeGreaterThan(after1.issues);
  });
});
