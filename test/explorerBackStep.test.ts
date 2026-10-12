// The explorer's back step.
//  - a back that leaves the screen unchanged is a no-change step: recorded as same_screen, never
//    repeated on that screen; the run relaunches the app and ends, instead of looping until the clock;
//  - a back that works records changed_screen with its target;
//  - back / relaunch steps count against maxActions;
//  - a time-budget stop is state "blocked", and qa_report is then not SHIP.
// Hermetic: temp HOME, a fake Android driver (test/actFixFake.ts), no device.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDriver, dump } from './actFixFake.js';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { runExplore } = await import('../src/explore/runner.js');
const { generateSessionReport } = await import('../src/services/report.js');
type ReportData = import('../src/report/export.js').ReportData;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const HOME = dump([
  { cls: 'android.widget.TextView', text: 'Home', bounds: [40, 100, 1040, 180], clickable: false },
  { text: 'Details', id: 'com.example.app:id/details', bounds: [40, 300, 1040, 400] },
]);
const DETAIL = dump([
  { cls: 'android.widget.TextView', text: 'Detail page', bounds: [40, 100, 1040, 180], clickable: false },
  { cls: 'android.widget.TextView', text: 'Nothing to tap here', bounds: [40, 300, 1040, 380], clickable: false },
]);

/** Home > tap "Details" > a screen with no controls. `backWorks` decides whether back returns home. */
function appDriver(backWorks: boolean) {
  const d = new FakeDriver(HOME);
  d.onTap = (_x, y) => {
    if (d.xml === HOME && y >= 300 && y <= 400) d.xml = DETAIL;
  };
  d.pressKey = async (key: string) => {
    d.rec('pressKey', key);
    if (backWorks && key === 'back') d.xml = HOME;
  };
  d.terminateApp = async () => {
    d.rec('terminateApp');
  };
  d.launchApp = async () => {
    d.rec('launchApp');
    d.xml = HOME;
  };
  return d;
}

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'swipium-r4-explore-'));
  roots.push(root);
  const sessions = new SessionStore();
  const session = sessions.create(root);
  session.appId = 'com.example.app';
  return { sessions, session };
}

describe('explorer back step', () => {
  it('a back that does nothing is a no-change step: no loop, one relaunch, the run ends', async () => {
    const { sessions, session } = fresh();
    const d = appDriver(false);
    const t0 = Date.now();
    const res = await runExplore(sessions, session, d, { maxActions: 20, maxDurationMs: 60_000 });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(res.stoppedReason).not.toMatch(/time budget/);
    expect(d.got('pressKey')).toHaveLength(1); // never backed out of the same screen twice
    expect(d.got('launchApp').length).toBeGreaterThanOrEqual(1);
    expect(d.got('launchApp').length).toBeLessThanOrEqual(2);
    const back = res.graph.allEdges().filter((e) => e.action.type === 'back');
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ outcome: 'same_screen', oracle: 'screen_signature_same' });
    expect(session.notes.some((n) => /back did not leave "/.test(String(n.reason)))).toBe(true);
  });

  it('a back that works records changed_screen to the screen it reached', async () => {
    const { sessions, session } = fresh();
    const d = appDriver(true);
    const res = await runExplore(sessions, session, d, { maxActions: 20, maxDurationMs: 60_000 });
    const back = res.graph.allEdges().filter((e) => e.action.type === 'back');
    expect(back).toHaveLength(1);
    expect(back[0].outcome).toBe('changed_screen');
    expect(back[0].to).toBe(res.graph.rootId);
    expect(d.got('launchApp')).toHaveLength(0);
    expect(res.state).toBe('completed');
  });

  it('back and relaunch steps count against maxActions', async () => {
    const { sessions, session } = fresh();
    const d = appDriver(false);
    const res = await runExplore(sessions, session, d, { maxActions: 2, maxDurationMs: 60_000 });
    // 1 tap + 1 back = 2: the budget is spent before the relaunch.
    expect(res.stoppedReason).toMatch(/^action budget reached \(2, 1 of them back/);
    expect(d.got('launchApp')).toHaveLength(0);
  });

  it('a time-budget stop is blocked, and the report is not SHIP', async () => {
    const { sessions, session } = fresh();
    const res = await runExplore(sessions, session, appDriver(false), { maxActions: 20, maxDurationMs: 1 });
    expect(res.stoppedReason).toMatch(/^time budget reached \(/);
    expect(res.state).toBe('blocked');
    sessions.setExploration(session, {
      at: Date.now(),
      graphUri: '',
      state: res.state,
      stoppedReason: res.stoppedReason,
      summary: res.summary,
    });
    const r = (await generateSessionReport(sessions, session, { includeCurrentDump: false })).report as unknown as ReportData;
    expect(r.executiveSummary.risk).not.toBe('ship');
  });
});
