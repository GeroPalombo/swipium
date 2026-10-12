// The not-tested marker and an agent's pass claim need device evidence
// with the app under test in front.
//  - qa_act records appForeground only when the post-action foreground is the app under test;
//  - after a blocked run, an action on another app (SpringBoard / launcher) plus a qa_note pass keeps
//    the marker: BLOCK, gate fails with the original code;
//  - an app-in-front action alone keeps it too, and so does an agent outcome note after it.
// Hermetic: in-memory server with a fake driver (test/actFixFake.ts), temp HOME, no device.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeDriver, buttonScreen, harness, structured } from './actFixFake.js';

const { generateSessionReport } = await import('../src/services/report.js');
const { reportPolicyVerdicts } = await import('../src/report/export.js');
const { applyPolicy } = await import('../src/report/policy.js');
type ReportData = import('../src/report/export.js').ReportData;

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('round4-gate');
});
afterAll(async () => {
  await h.close();
});

async function report(sessionId: string, notTested?: { reason: string; failureCode: string; reachedApp: false }) {
  const s = h.sessions.get(sessionId)!;
  const r = (await generateSessionReport(h.sessions, s, { includeCurrentDump: false, ...(notTested ? { notTested } : {}) }))
    .report as unknown as ReportData;
  const verdicts = reportPolicyVerdicts(r);
  return { r, s, verdicts, notTestedVerdict: verdicts.find((v) => v.flow === 'swipium: not tested') };
}

const tap = (sessionId: string) => h.call('qa_act', { sessionId, action: 'tap', target: { text: 'A item 0' } });
const passNote = (sessionId: string) => h.call('qa_note', { sessionId, workflow: 'login', outcome: 'pass', reason: 'looks fine' });
const onOtherApp = (fake: FakeDriver, pkg: string) => {
  fake.xml = buttonScreen('A', 2, pkg);
  fake.foreground = `${pkg}/.Main`;
};
const metroBlocked = { reason: 'Metro is not serving this debug build', failureCode: 'METRO_REQUIRED', reachedApp: false as const };

describe('qa_act appForeground', () => {
  it('is set when the app under test is in front after the action, not when another app is', async () => {
    const fake = new FakeDriver(buttonScreen('A', 2));
    const sessionId = await h.start(fake);
    const s = h.sessions.get(sessionId)!;
    expect(structured(await tap(sessionId)).ok).toBe(true);
    expect(s.recordedActions.at(-1)?.appForeground).toBe(true);

    // The dump's root package is trusted on the post-action path, so the screen changes owner too.
    onOtherApp(fake, 'com.google.android.apps.nexuslauncher');
    await tap(sessionId);
    expect(s.recordedActions.at(-1)?.appForeground).toBeUndefined();
  });
});

describe('the not-tested marker needs app evidence', () => {
  it('a tap on another app plus a qa_note pass after a blocked run keeps BLOCK and the blocker code; the gate blocks', async () => {
    const fake = new FakeDriver(buttonScreen('A', 2));
    const sessionId = await h.start(fake);
    await report(sessionId, metroBlocked);
    onOtherApp(fake, 'com.apple.springboard');
    await tap(sessionId);
    await passNote(sessionId);
    const { r, s, verdicts, notTestedVerdict } = await report(sessionId);
    expect(s.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED', reachedApp: false });
    expect(r.executiveSummary.risk).toBe('block');
    expect(notTestedVerdict).toMatchObject({ passed: false, failureCode: 'METRO_REQUIRED' });
    expect(applyPolicy(verdicts, null).block).toBe(true);
  });

  it('an app-in-front action alone keeps the marker', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 2)));
    await report(sessionId, metroBlocked);
    await tap(sessionId);
    const { s, notTestedVerdict } = await report(sessionId);
    expect(s.recordedActions.at(-1)?.appForeground).toBe(true);
    expect(s.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED' });
    expect(notTestedVerdict).toMatchObject({ passed: false, failureCode: 'METRO_REQUIRED' });
  });

  it('an app-in-front action plus an agent outcome note after the marker keeps it', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 2)));
    await report(sessionId, metroBlocked);
    await new Promise((r) => setTimeout(r, 5));
    await tap(sessionId);
    await passNote(sessionId);
    const { s, verdicts, notTestedVerdict } = await report(sessionId);
    expect(s.notTested).toMatchObject({ failureCode: 'METRO_REQUIRED' });
    expect(notTestedVerdict).toMatchObject({ passed: false, failureCode: 'METRO_REQUIRED' });
    expect(applyPolicy(verdicts, null).block).toBe(true);
  });
});
