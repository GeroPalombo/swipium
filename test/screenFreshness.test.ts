// Cross-tool screen freshness fixes.
// - qa_act compares the post-action screen against the dump taken while resolving the target
//   (ref re-check), not the older snapshot the agent read.
// - qa_visual's secure-screen gate uses the shared freshness rule: any screen change makes it re-check.
// - A failed action, the flow clearOverlay step and qa_smoke's launch mark the stored snapshot stale.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buttonScreen, dump, FakeDriver, harness, structured } from './actFixFake.js';
import { parseSnapshot } from '../src/snapshot/parse.js';
import { actionSeq, adoptSnapshot, freshSnapshot, noteScreenMutation, SNAPSHOT_REUSE_MS } from '../src/snapshot/fresh.js';
import { SessionStore } from '../src/session/store.js';
import { secureScreenState } from '../src/tools/visual.js';
import { runFlow } from '../src/flows/run.js';
import { settleFastAccepts } from '../src/snapshot/settle.js';
import { runSmoke } from '../src/services/smoke.js';
import type { Flow, FlowStep } from '../src/flows/schema.js';
import { IME_HOP_FLOOR_MS } from '../src/core/ime.js';

function newSession(fake: FakeDriver) {
  const sessions = new SessionStore();
  const session = sessions.create(mkdtempSync(join(tmpdir(), 'swipium-r2-proj-')));
  session.appId = 'com.example.app';
  session.driver = fake;
  return { sessions, session };
}

describe('qa_act baseline after a ref re-check re-dump', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness('review-r2');
  });
  afterAll(async () => {
    await h.close();
  });

  it('a screen that changed on its own before the tap is not reported as the tap changing it', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    // The app adds a banner by itself while the agent thinks; the snapshot is now aged.
    fake.xml = dump([
      { cls: 'android.widget.TextView', text: 'Home', bounds: [40, 100, 1040, 180], clickable: false },
      { text: 'Home item 0', id: 'com.example.app:id/home_0', bounds: [40, 200, 1040, 245] },
      { text: 'Home item 1', id: 'com.example.app:id/home_1', bounds: [40, 250, 1040, 295] },
      { text: 'Home item 2', id: 'com.example.app:id/home_2', bounds: [40, 300, 1040, 345] },
      { cls: 'android.widget.TextView', text: 'New banner', bounds: [40, 1500, 1040, 1600], clickable: false },
    ]);
    h.sessions.get(id)!.lastSnapshot!.at = Date.now() - 10_000;
    // The tap itself does nothing (the screen stays as it is now).
    const s = structured(await h.call('qa_act', { sessionId: id, action: 'tap', target: { ref: '@e2' } }));
    expect(s.ok).toBe(true);
    expect(s.changed).toBe(false);
    expect(s.retriedAsPress).toBe(true); // the no-change retry runs, as for any no-op tap
  }, 20_000);

  it('qa_screenshot re-checks for a password field when the snapshot is stale', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 2));
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id }); // no secure field
    // The app restarts onto a login screen: the stored snapshot no longer describes it.
    await h.call('qa_app_control', { sessionId: id, action: 'restart' });
    fake.xml = dump([{ cls: 'android.widget.EditText', text: '', id: 'com.example.app:id/password', bounds: [40, 200, 1040, 300] }]);
    const res = await h.call('qa_screenshot', { sessionId: id });
    expect(res.isError).toBe(true);
    expect(structured(res).failureCode).toBe('CAPTURE_WITHHELD_SECURE');
    // A fresh snapshot still answers without a dump.
    await h.call('qa_snapshot', { sessionId: id });
    fake.xml = buttonScreen('Home', 2);
    const dumpsBefore = fake.got('dumpXml').length;
    expect((await h.call('qa_screenshot', { sessionId: id })).isError).toBe(true);
    expect(fake.got('dumpXml').length).toBe(dumpsBefore);
  }, 30_000);

  it('a driver failure mid-action marks the stored snapshot stale', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 2));
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    const session = h.sessions.get(id)!;
    const before = actionSeq(session);
    fake.pressKey = async () => {
      throw new Error('adb: device offline');
    };
    const res = await h.call('qa_act', { sessionId: id, action: 'press', key: 'back' });
    expect(res.isError).toBe(true);
    expect(actionSeq(session)).toBeGreaterThan(before);
    expect(freshSnapshot(session, SNAPSHOT_REUSE_MS)).toBeUndefined();
  }, 20_000);
});

describe('qa_visual secure-screen gate', () => {
  it('a screen change since the snapshot (not only a visual tap) makes the state unknown', () => {
    const fake = new FakeDriver(
      dump([{ cls: 'android.widget.EditText', text: '', id: 'com.example.app:id/password', bounds: [40, 200, 1040, 300] }]),
    );
    const { session } = newSession(fake);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    expect(secureScreenState(session)).toBe('secure');
    session.lastSnapshot!.at = Date.now() - 60_000; // age alone does not matter here
    expect(secureScreenState(session)).toBe('secure');
    noteScreenMutation(session); // e.g. qa_app_control restart, qa_clear_overlay
    expect(secureScreenState(session)).toBe('unknown');
  });
});

describe('screen mutations outside qa_act', () => {
  it('the flow clearOverlay step marks the snapshot stale when it hides the keyboard', async () => {
    const fake = new FakeDriver(buttonScreen('Form', 2));
    const { sessions, session } = newSession(fake);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    fake.ime = true;
    fake.hideKeyboard = async () => {
      fake.ime = false;
      fake.xml = '<hierarchy/>'; // the settle after it gets nothing usable
      return true;
    };
    const before = actionSeq(session);
    const flow = { name: 'clear', steps: [{ kind: 'clearOverlay' }], setup: [], teardown: [] } as unknown as Flow;
    const r = await runFlow(sessions, session, fake, flow);
    expect(r.passed).toBe(true);
    expect(actionSeq(session)).toBeGreaterThan(before);
  }, 20_000);

  it('qa_smoke marks a pre-launch snapshot stale even when the post-launch dump fails', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 2));
    const { sessions, session } = newSession(fake);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    fake.dumpXml = async () => {
      throw new Error('dump failed');
    };
    await runSmoke(sessions, session, fake, { launch: true });
    expect(freshSnapshot(session, SNAPSHOT_REUSE_MS)).toBeUndefined();
  }, 30_000);
});

describe('flow inputText into: keyboard already up (field hop)', () => {
  it('waits the same floor qa_act uses before typing into the newly tapped field', async () => {
    const fake = new FakeDriver(buttonScreen('Form', 2));
    const { sessions, session } = newSession(fake);
    fake.ime = true; // the keyboard is still up from the previous field
    let tappedAt = 0;
    let typedAt = 0;
    fake.onTap = () => (tappedAt = Date.now());
    const type = fake.inputText.bind(fake);
    fake.inputText = async (t: string) => {
      typedAt = Date.now();
      return type(t);
    };
    const flow = {
      name: 'hop',
      setup: [],
      teardown: [],
      steps: [{ kind: 'inputText', into: 'Form item 1', value: 'x' }] as FlowStep[],
    } as unknown as Flow;
    const r = await runFlow(sessions, session, fake, flow);
    expect(r.passed, JSON.stringify(r.steps)).toBe(true);
    expect(tappedAt).toBeGreaterThan(0);
    expect(typedAt - tappedAt).toBeGreaterThanOrEqual(IME_HOP_FLOOR_MS - 20);
  }, 20_000);
});

describe('server startup imports', () => {
  it('the server does not import the CLI init/verify modules (they load the MCP client SDK)', () => {
    const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '\.\/cli\/(init|verify)\.js'/);
  });
});

describe('flow waitForIdle', () => {
  it('never fast-accepts: a dump that differs from the last snapshot means the screen is still changing', async () => {
    const fake = new FakeDriver(buttonScreen('Before', 2));
    const { sessions, session } = newSession(fake);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    fake.xml = buttonScreen('After', 2);
    const flow = { name: 'idle', setup: [], teardown: [], steps: [{ kind: 'waitForIdle' }] as FlowStep[] } as unknown as Flow;
    const fastBefore = settleFastAccepts();
    const r = await runFlow(sessions, session, fake, flow);
    expect(r.passed).toBe(true);
    expect(settleFastAccepts()).toBe(fastBefore);
  }, 20_000);
});
