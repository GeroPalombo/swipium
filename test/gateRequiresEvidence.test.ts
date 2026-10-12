// The CI release gate passed runs that tested nothing. The rule is inverted:
// only a Swipium-run check that looked at the app's UI and found it healthy counts (a smoke / flow
// pass whose oracle ruled out RedBox and blank screens, or an exploration that reached a real app
// screen). Agent verdicts (qa_note, qa_visual assert), launches, raw actions and findings never
// count, and never clear a persisted not-tested marker (METRO_REQUIRED).
// One gate test per repro case (a)-(e), plus the qa_act items fixed alongside:
//  - appForeground is an exact package match (com.example.app is not com.example.app2);
//  - qa_act wait with `target` instead of `for` is INVALID_ARGUMENT, not ok:true;
//  - an explorer stop that tested nothing (left the app 3 times) is "blocked", not "completed".
// Hermetic: temp HOME, fake driver (test/actFixFake.ts), no device.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDriver, buttonScreen, harness, structured } from './actFixFake.js';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { generateSessionReport } = await import('../src/services/report.js');
const { reportPolicyVerdicts } = await import('../src/report/export.js');
const { applyPolicy } = await import('../src/report/policy.js');
const { runExplore } = await import('../src/explore/runner.js');
type ReportData = import('../src/report/export.js').ReportData;
type Session = import('../src/session/store.js').Session;
type Store = InstanceType<typeof SessionStore>;

const roots: string[] = [];
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('gate-r5');
});
afterAll(async () => {
  await h.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fresh(): { store: Store; s: Session } {
  const root = mkdtempSync(join(tmpdir(), 'swipium-gate-r5-'));
  roots.push(root);
  const store = new SessionStore();
  const s = store.create(root);
  s.appId = 'com.example.app';
  return { store, s };
}

const metroBlocked = { reason: 'Metro is not serving this debug build', failureCode: 'METRO_REQUIRED', reachedApp: false as const };

async function report(store: Store, s: Session, notTested?: typeof metroBlocked) {
  const r = (await generateSessionReport(store, s, { includeCurrentDump: false, ...(notTested ? { notTested } : {}) }))
    .report as unknown as ReportData;
  const verdicts = reportPolicyVerdicts(r);
  return { r, verdicts, gateBlocks: applyPolicy(verdicts, null).block };
}

/** Start from a run the gate must block: METRO_REQUIRED persisted on the session. */
async function blockedRun() {
  const { store, s } = fresh();
  store.milestone(s, 'app_launch_end');
  await report(store, s, metroBlocked);
  expect(s.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED' });
  return { store, s, later: Date.now() + 10 };
}

describe('the gate never passes a run that tested nothing', () => {
  it('(a) qa_visual assert pass:true is the agent verdict: not SHIP, marker kept, gate blocks', async () => {
    const { store, s, later } = await blockedRun();
    store.saveArtifact(s, 'screenshot', 'visual.png', Buffer.alloc(8), 'image/png');
    s.artifacts[s.artifacts.length - 1].appForeground = true;
    store.addNote(s, {
      at: later,
      workflow: 'home screen rendered',
      outcome: 'pass',
      method: 'visual',
      evidenceKind: 'manual_review',
      verifiedVisually: true,
    });
    const { r, gateBlocks } = await report(store, s);
    expect(s.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED' });
    expect(r.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED', exercised: false });
    expect(r.executiveSummary.risk).not.toBe('ship');
    expect(gateBlocks).toBe(true);
  });

  it('(a) without a marker, a qa_visual assert pass alone is not tested either', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    store.addNote(s, { at: Date.now(), workflow: 'x', outcome: 'pass', method: 'visual', evidenceKind: 'manual_review' });
    const { r, gateBlocks } = await report(store, s);
    expect(r.notTested).toMatchObject({ exercised: false, failureCode: 'NOT_TESTED' });
    expect(gateBlocks).toBe(true);
  });

  it('(b) a tap with the app in front (RedBox "Dismiss") plus a qa_note pass keeps the marker', async () => {
    const { store, s, later } = await blockedRun();
    store.addRecordedAction(s, { at: later, action: 'tap', selector: 'Dismiss', exportability: 'semantic', appForeground: true });
    store.addNote(s, { at: later + 1, workflow: 'login', outcome: 'pass', source: 'qa_note' });
    const { r, gateBlocks } = await report(store, s);
    expect(s.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED' });
    expect(r.executiveSummary.risk).not.toBe('ship');
    expect(gateBlocks).toBe(true);
  });

  it('(c) a visual-only launch smoke pass (app=unverified) plus a qa_note pass keeps the marker', async () => {
    const { store, s, later } = await blockedRun();
    store.addNote(s, { at: later, workflow: 'launch_smoke', outcome: 'pass', reason: 'native=ok app=unverified' });
    store.addNote(s, { at: later + 1, workflow: 'login', outcome: 'pass', source: 'qa_note' });
    const { r, gateBlocks } = await report(store, s);
    expect(s.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED' });
    expect(r.executiveSummary.risk).not.toBe('ship');
    expect(gateBlocks).toBe(true);
  });

  it('(d) an exploration of a blank screen (visual-only, or 0 screens) keeps the marker', async () => {
    for (const summary of [
      { screensVisited: 1, visualOnlyScreens: 1 },
      { screensVisited: 0, visualOnlyScreens: 0 },
    ]) {
      const { store, s, later } = await blockedRun();
      store.addNote(s, { at: later, workflow: 'guided_exploration', outcome: 'pass', method: 'visual', verifiedVisually: true });
      store.setExploration(s, {
        at: later,
        state: summary.screensVisited ? 'completed' : 'blocked',
        stoppedReason: 'no further safe, unexplored actions',
        summary: { ...summary, actionsTried: 0, workflowsFound: 0, blockers: 0, appErrors: 0, unsafeActionsSkipped: 0 },
      });
      const { r, gateBlocks } = await report(store, s);
      expect(s.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED' });
      expect(r.executiveSummary.risk).not.toBe('ship');
      expect(gateBlocks).toBe(true);
    }
  });

  it('(e) a launch, a stored finding (permission dialog) and a qa_note pass: not tested, gate blocks', async () => {
    const { store, s } = fresh();
    store.milestone(s, 'app_launch_end');
    store.addFinding(s, { at: Date.now(), severity: 'low', layer: 'native', kind: 'permission_dialog', detail: 'Allow notifications?' });
    store.addNote(s, { at: Date.now() + 1, workflow: 'login', outcome: 'pass', source: 'qa_note' });
    const { r, gateBlocks } = await report(store, s);
    expect(r.notTested).toMatchObject({ exercised: false, failureCode: 'NOT_TESTED' });
    expect(r.executiveSummary.risk).not.toBe('ship');
    expect(gateBlocks).toBe(true);
  });

  it('a healthy Swipium check does clear it: a launch smoke with app=ok, or a real-screen exploration', async () => {
    const smoke = await blockedRun();
    smoke.store.addNote(smoke.s, { at: smoke.later, workflow: 'launch_smoke', outcome: 'pass', reason: 'native=ok app=ok quality=good' });
    expect((await report(smoke.store, smoke.s)).gateBlocks).toBe(false);
    expect(smoke.s.notTested).toBeUndefined();

    const ex = await blockedRun();
    ex.store.setExploration(ex.s, {
      at: ex.later,
      state: 'completed',
      stoppedReason: 'no further safe, unexplored actions',
      summary: {
        screensVisited: 2,
        visualOnlyScreens: 0,
        actionsTried: 1,
        workflowsFound: 1,
        blockers: 0,
        appErrors: 0,
        unsafeActionsSkipped: 0,
      },
    });
    expect((await report(ex.store, ex.s)).gateBlocks).toBe(false);
    expect(ex.s.notTested).toBeUndefined();
  });
});

describe('qa_act fixes alongside the gate', () => {
  it('appForeground is an exact package match: com.example.app2 in front is not the app under test', async () => {
    const fake = new FakeDriver(buttonScreen('A', 2));
    const sessionId = await h.start(fake);
    const s = h.sessions.get(sessionId)!;
    fake.xml = buttonScreen('A', 2, 'com.example.app2');
    fake.foreground = 'com.example.app2/.Main';
    await h.call('qa_act', { sessionId, action: 'tap', target: { text: 'A item 0' } });
    expect(s.recordedActions.at(-1)?.appForeground).toBeUndefined();
  });

  it('wait with `target` instead of `for` is INVALID_ARGUMENT', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 2)));
    const res = structured(await h.call('qa_act', { sessionId, action: 'wait', target: { text: 'Not on screen' }, timeoutMs: 500 }));
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('INVALID_ARGUMENT');
  });
});

describe('explorer stops that tested nothing', () => {
  it('leaving the app over and over with nothing explored is blocked, not completed', async () => {
    const { store, s } = fresh();
    const d = new FakeDriver(buttonScreen('A', 2, 'com.other.app'));
    d.foreground = 'com.other.app/.Main';
    d.launchApp = async () => {
      d.rec('launchApp');
    };
    d.terminateApp = async () => {
      d.rec('terminateApp');
    };
    const res = await runExplore(store, s, d, { maxActions: 20, maxDurationMs: 60_000 });
    expect(res.stoppedReason).toMatch(/left the app|no way back/);
    expect(res.state).toBe('blocked');
  });
});
