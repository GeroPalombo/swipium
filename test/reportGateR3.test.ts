// Round-3 report / release-gate behaviour (E2E NEW-10..13, CR "reached but blocked", NEW-15):
//  - a screenshot taken without the app in front does not count as "reached the app";
//  - a persisted notTested marker keeps its blocker code across later qa_report calls;
//  - an agent qa_note pass with no device evidence is never SHIP;
//  - a run that reached the app but exercised nothing fails the gate with the blocker's code;
//  - a hung WDA (wda_unreachable finding) is a tool/environment failure, not an app bug.
// Hermetic: HOME is a temp dir (test/setupFakeHome.ts), no device discovery, no driver.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { generateSessionReport } = await import('../src/services/report.js');
const { reportPolicyVerdicts } = await import('../src/report/export.js');
type ReportData = import('../src/report/export.js').ReportData;
type Session = import('../src/session/store.js').Session;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fresh(): { store: InstanceType<typeof SessionStore>; s: Session } {
  const root = mkdtempSync(join(tmpdir(), 'swipium-gate-r3-'));
  roots.push(root);
  const store = new SessionStore();
  const s = store.create(root);
  s.appId = 'com.example.app';
  return { store, s };
}

async function report(store: InstanceType<typeof SessionStore>, s: Session, notTested?: Parameters<typeof generateSessionReport>[2]) {
  const r = (await generateSessionReport(store, s, { includeCurrentDump: false, ...notTested })).report as unknown as ReportData & {
    failureBuckets: { counts: Record<string, number> };
  };
  const notTestedVerdict = reportPolicyVerdicts(r).find((v) => v.flow === 'swipium: not tested');
  return { r, notTestedVerdict };
}

describe('reached the app needs real evidence (E2E NEW-10)', () => {
  it('a screenshot without the app in front is not evidence: BLOCK / NOT_RUN', async () => {
    const { store, s } = fresh();
    store.saveArtifact(s, 'screenshot', 'home.png', Buffer.alloc(8), 'image/png');
    const { r, notTestedVerdict } = await report(store, s);
    expect(r.executiveSummary.risk).toBe('block');
    expect(r.appVerdict?.status).toBe('NOT_RUN');
    expect(r.notTested).toMatchObject({ reachedApp: false });
    expect(notTestedVerdict).toMatchObject({ passed: false });
  });

  it('a screenshot with appForeground:true counts as reaching the app (not BLOCK)', async () => {
    const { store, s } = fresh();
    store.saveArtifact(s, 'screenshot', 'app.png', Buffer.alloc(8), 'image/png');
    s.artifacts[s.artifacts.length - 1].appForeground = true;
    const { r } = await report(store, s);
    expect(r.executiveSummary.risk).not.toBe('block');
    expect(r.notTested).toMatchObject({ reachedApp: true, exercised: false });
  });
});

describe('persisted notTested marker (E2E NEW-10 / NEW-13)', () => {
  it('keeps BLOCK and the METRO_REQUIRED code on a later plain qa_report, even after a home-screen screenshot', async () => {
    const { store, s } = fresh();
    await report(store, s, {
      notTested: { reason: 'Metro is not serving this debug build', failureCode: 'METRO_REQUIRED', reachedApp: false },
    });
    expect(s.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED', reachedApp: false });
    store.saveArtifact(s, 'screenshot', 'home.png', Buffer.alloc(8), 'image/png');
    const { r, notTestedVerdict } = await report(store, s);
    expect(r.executiveSummary.risk).toBe('block');
    expect(r.appVerdict?.status).toBe('NOT_RUN');
    expect(r.notTested).toMatchObject({ reachedApp: false, failureCode: 'METRO_REQUIRED' });
    expect(notTestedVerdict).toMatchObject({ passed: false, failureCode: 'METRO_REQUIRED' });
  });

  it('a Swipium pass outcome recorded after the marker clears it', async () => {
    const { store, s } = fresh();
    await report(store, s, { notTested: { reason: 'Metro down', failureCode: 'METRO_REQUIRED', reachedApp: false } });
    store.milestone(s, 'app_launch_end');
    store.addNote(s, { at: Date.now() + 5, workflow: 'launch_smoke', outcome: 'pass', reason: 'native=ok app=ok quality=good' });
    const { r, notTestedVerdict } = await report(store, s);
    expect(s.notTested).toBeUndefined();
    expect(r.notTested).toBeUndefined();
    expect(['ship', 'caution']).toContain(r.executiveSummary.risk);
    expect(notTestedVerdict).toBeUndefined();
  });
});

describe('agent pass claims (E2E NEW-11)', () => {
  it('a qa_note pass with no device evidence is not SHIP and fails the gate', async () => {
    const { store, s } = fresh();
    store.addNote(s, { at: Date.now(), workflow: 'login', outcome: 'pass', source: 'qa_note' });
    const { r, notTestedVerdict } = await report(store, s);
    expect(r.executiveSummary.risk).toBe('block');
    expect(r.notTested).toMatchObject({ reachedApp: false, failureCode: 'NOT_TESTED' });
    expect(r.notTested?.reason).toMatch(/unverified qa_note pass/);
    expect(notTestedVerdict).toMatchObject({ passed: false });
  });

  it('the same pass after a launch only is not SHIP: CAUTION, App UNVERIFIED, gate fails NOT_TESTED (round 4 must-fix 1)', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    store.addNote(s, { at: Date.now(), workflow: 'login', outcome: 'pass', source: 'qa_note' });
    const { r, notTestedVerdict } = await report(store, s);
    expect(r.notTested).toMatchObject({ reachedApp: true, exercised: false, failureCode: 'NOT_TESTED' });
    expect(r.notTested?.reason).toMatch(/unverified qa_note pass claim on a launched app/);
    expect(r.executiveSummary.risk).toBe('caution');
    expect(r.appVerdict?.status).toBe('UNVERIFIED');
    expect(notTestedVerdict).toMatchObject({ passed: false, failureCode: 'NOT_TESTED' });
  });

  it('the same pass after a launch plus an action with the app in front is still not tested (R5 must-fix 1)', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    store.addRecordedAction(s, { at: Date.now() + 1, action: 'tap', selector: 'Login', exportability: 'semantic', appForeground: true });
    store.addNote(s, { at: Date.now() + 5, workflow: 'login', outcome: 'pass', source: 'qa_note' });
    const { r, notTestedVerdict } = await report(store, s);
    expect(r.notTested).toMatchObject({ reachedApp: true, exercised: false, failureCode: 'NOT_TESTED' });
    expect(r.executiveSummary.risk).not.toBe('ship');
    expect(notTestedVerdict).toMatchObject({ passed: false });
  });

  it('the same pass after a launch plus a Swipium launch_smoke pass is SHIP', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    store.addNote(s, { at: Date.now(), workflow: 'launch_smoke', outcome: 'pass', reason: 'native=ok app=ok quality=good' });
    store.addNote(s, { at: Date.now() + 5, workflow: 'login', outcome: 'pass', source: 'qa_note' });
    const { r, notTestedVerdict } = await report(store, s);
    expect(r.notTested).toBeUndefined();
    expect(r.executiveSummary.risk).toBe('ship');
    expect(notTestedVerdict).toBeUndefined();
  });
});

describe('reached but blocked fails the gate (CR, BLANK_SCREEN / GOAL-9)', () => {
  it('launch + blocked blank launch_smoke + blocked qa_note: CAUTION, gate fails with BLANK_SCREEN', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    store.addNote(s, {
      at: Date.now(),
      workflow: 'launch_smoke',
      outcome: 'blocked',
      category: 'other',
      reason: 'the app showed a blank screen for 15 s, launch NOT verified',
      missingPrecondition: 'the app rendering its first screen',
    });
    store.addNote(s, {
      at: Date.now(),
      workflow: 'checkout',
      outcome: 'blocked',
      category: 'other',
      source: 'qa_note',
      reason: 'blank screen',
    });
    const { r, notTestedVerdict } = await report(store, s);
    expect(r.executiveSummary.risk).toBe('caution');
    expect(r.notTested).toMatchObject({ reachedApp: true, exercised: false, failureCode: 'BLANK_SCREEN' });
    expect(notTestedVerdict).toMatchObject({ passed: false, failureCode: 'BLANK_SCREEN' });
    // A blocked "other" note is setup/precondition, not a Swipium limitation (E2E NEW-14).
    expect(r.failureBuckets.counts.environment).toBeGreaterThanOrEqual(1);
    expect(r.failureBuckets.counts.mcp_limitation).toBe(0);
  });
});

describe('a hung WDA is a tool / environment failure, not an app bug (NEW-15 / GOAL NEW-R3-2)', () => {
  it('wda_unreachable finding + blocked launch_smoke: no "App status: BLOCKED", no app_bug issue, gate still fails', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    store.addFinding(s, {
      at: Date.now(),
      severity: 'high',
      layer: 'native',
      kind: 'wda_unreachable',
      detail: 'WebDriverAgent did not return a UI source',
    });
    store.addNote(s, {
      at: Date.now(),
      workflow: 'launch_smoke',
      outcome: 'blocked',
      category: 'mcp_limitation',
      reason: 'WDA_UNREACHABLE: WebDriverAgent returned no UI source after the launch; a tool / environment failure, launch NOT verified',
    });
    const res = await generateSessionReport(store, s, { includeCurrentDump: false });
    const r = res.report as unknown as ReportData & {
      issues?: { recorded?: Array<{ category: string }> };
      failureBuckets: { counts: Record<string, number> };
    };
    expect(r.appVerdict?.status).not.toBe('BLOCKED');
    expect(r.nativeHealth).not.toBe('error');
    expect(res.summaryText).not.toMatch(/App status: BLOCKED/);
    expect(r.executiveSummary.reasons.join(' ')).not.toMatch(/native crash/);
    expect(r.failureBuckets.counts.app_bug).toBe(0);
    expect(r.failureBuckets.counts.environment).toBeGreaterThanOrEqual(1);
    // Not a tested run: the gate fails, on the WDA finding and the not-tested verdict, with WDA_UNREACHABLE.
    const verdicts = reportPolicyVerdicts(r);
    expect(verdicts.find((v) => v.flow === 'finding:wda_unreachable')).toMatchObject({ passed: false });
    expect(verdicts.find((v) => v.flow === 'swipium: not tested')).toMatchObject({ passed: false, failureCode: 'WDA_UNREACHABLE' });
    // The issue ledger files it as a Swipium/tool limitation, never as an app bug.
    expect(JSON.stringify(r.issues)).toMatch(/mcp_limitation/);
    expect(JSON.stringify(r.issues ?? {})).not.toMatch(/"app_bug"|"blocker_app_bug"/);
  });
});
