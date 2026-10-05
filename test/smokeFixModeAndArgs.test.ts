// Real-device smoke fixes #2–#4:
//  #2 one slow screen switched the session to visual-fallback FOREVER (every later qa_snapshot
//     answered VISUAL_ONLY_SCREEN though dumps worked again). visual-fallback is now per-screen:
//     qa_snapshot / qa_act keep attempting a bounded structured dump and switch back on success.
//  #3 undeclared top-level arguments were silently stripped (qa_app_control { appId } force-stopped
//     the SESSION's app) — they are now rejected centrally with INVALID_ARGUMENT, nothing executed.
//  #4 minor: typed "No appId" error; qa_continue_from_blocker (not qa_resume); flow missing-variable
//     message; `redacted` only for values treated as secret.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { FakeDriver, buttonScreen, harness, structured, textOf } from './actFixFake.js';
import { missingVarMessage } from '../src/flows/schema.js';
import { failedFlowNextSteps } from '../src/tools/flow.js';
import { VISUAL_FALLBACK_PROBE } from '../src/tools/snapshot.js';
import { unknownArgumentKeys } from '../src/server.js';

/** Dumps fail ("could not get idle") while `busy` is set. */
class BusyDriver extends FakeDriver {
  busy = false;
  async dumpXml(opts?: Parameters<FakeDriver['dumpXml']>[0]) {
    if (this.busy) {
      this.rec('dumpXml', opts);
      throw new Error('uiautomator dump failed after 5 attempt(s): ERROR: could not get idle state.');
    }
    return super.dumpXml(opts);
  }
  async terminateApp() {
    this.rec('terminateApp');
  }
}

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('smokefix-mode');
});
afterAll(async () => {
  await h.close();
});

describe('#2 visual-fallback is not permanent', () => {
  it('qa_snapshot recovers to structured once a dump succeeds again', async () => {
    const fake = new BusyDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const session = h.sessions.get(id)!;
    fake.busy = true;
    let last: CallToolResult | undefined;
    for (let i = 0; i < session.budget.maxSnapshotFailures; i++) last = await h.call('qa_snapshot', { sessionId: id });
    expect(structured(last!).failureCode).toBe('VISUAL_ONLY_SCREEN');
    expect(session.mode).toBe('visual-fallback');

    // Still busy: a bounded probe is attempted (not the full retry ladder) and fails honestly.
    fake.calls = [];
    const still = await h.call('qa_snapshot', { sessionId: id });
    expect(structured(still).failureCode).toBe('VISUAL_ONLY_SCREEN');
    expect(fake.got('dumpXml')[0]?.a[0]).toEqual(VISUAL_FALLBACK_PROBE);
    expect(session.mode).toBe('visual-fallback');

    // The screen settles: the next snapshot is structured again and the mode is reset.
    fake.busy = false;
    const ok = await h.call('qa_snapshot', { sessionId: id });
    expect(ok.isError).toBeFalsy();
    expect(structured(ok).modeRecovered).toBe(true);
    expect(textOf(ok)).toContain('mode: structured again');
    expect(session.mode).toBe('structured');
    expect(session.counters.snapshotFailures).toBe(0);
    const again = await h.call('qa_snapshot', { sessionId: id });
    expect(again.isError).toBeFalsy();
    expect(structured(again).modeRecovered).toBeUndefined();
  });

  it('a successful qa_act observation also clears visual-fallback', async () => {
    const fake = new BusyDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const session = h.sessions.get(id)!;
    h.sessions.setMode(session, 'visual-fallback');
    const res = await h.call('qa_act', { sessionId: id, action: 'tap', target: { x: 100, y: 100 }, observe: 'none' });
    expect(res.isError).toBeFalsy();
    expect(structured(res).modeRecovered).toBe(true);
    expect(session.mode).toBe('structured');
  });

  it('snapshot failures count consecutively (a success resets the count)', async () => {
    const fake = new BusyDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const session = h.sessions.get(id)!;
    for (let round = 0; round < 3; round++) {
      fake.busy = true;
      for (let i = 0; i < session.budget.maxSnapshotFailures - 1; i++) {
        expect(structured(await h.call('qa_snapshot', { sessionId: id })).failureCode).toBe('SNAPSHOT_FAILED');
      }
      fake.busy = false;
      expect((await h.call('qa_snapshot', { sessionId: id })).isError).toBeFalsy();
    }
    expect(session.mode).toBe('structured');
  });
});

describe('#3 unknown top-level arguments are rejected centrally', () => {
  it('qa_app_control { action:"force_stop", appId } → INVALID_ARGUMENT, nothing executed', async () => {
    const fake = new BusyDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const res = await h.call('qa_app_control', { sessionId: id, action: 'force_stop', appId: 'com.a;id' });
    const s = structured(res);
    expect(s.failureCode).toBe('INVALID_ARGUMENT');
    expect(s.unknownArguments).toEqual(['appId']);
    expect(s.acceptedParameters).toEqual(expect.arrayContaining(['sessionId', 'action']));
    expect(String(s.what)).toContain('"appId"');
    expect(fake.got('terminateApp')).toHaveLength(0);
    // control: the same call without the stray key runs.
    const ok = await h.call('qa_app_control', { sessionId: id, action: 'force_stop' });
    expect(ok.isError, textOf(ok)).toBeFalsy();
    expect(fake.got('terminateApp')).toHaveLength(1);
  });

  it('unknownArgumentKeys accepts every declared key (incl. deprecated aliases still in the schema)', () => {
    expect(unknownArgumentKeys({ a: 1, legacy: 2 }, ['a', 'legacy'])).toEqual([]);
    expect(unknownArgumentKeys({ a: 1, x: 2, y: 3 }, ['a'])).toEqual(['x', 'y']);
    expect(unknownArgumentKeys(undefined, ['a'])).toEqual([]);
  });

  it('tools/list and tools/call agree: every advertised property is accepted', async () => {
    const { tools } = await h.client.listTools();
    const snapTool = tools.find((t) => t.name === 'qa_snapshot')!;
    const props = Object.keys((snapTool.inputSchema as { properties?: object }).properties ?? {});
    expect(unknownArgumentKeys({ sessionId: 'x', diff: true, filter: 'a' }, props)).toEqual([]);
  });
});

describe('#4 minor fixes', () => {
  it('qa_app_control without an appId is a typed INVALID_ARGUMENT', async () => {
    const id = await h.start(new BusyDriver(buttonScreen('Home', 3)));
    h.sessions.get(id)!.appId = undefined;
    const s = structured(await h.call('qa_app_control', { sessionId: id, action: 'force_stop' }));
    expect(s.failureCode).toBe('INVALID_ARGUMENT');
    expect(String(s.what)).toContain('No appId');
  });

  it('a missing ${SWIPIUM_*} value points at qa_continue_from_blocker (qa_resume does not exist)', async () => {
    const id = await h.start(new BusyDriver(buttonScreen('Home', 3)));
    const s = structured(
      await h.call('qa_act', { sessionId: id, action: 'type', text: '${SWIPIUM_SMOKEFIX_NOPE}', target: { x: 5, y: 5 } }),
    );
    expect(s.failureCode).toBe('MISSING_TEST_DATA');
    expect(JSON.stringify(s.nextSteps)).toContain('qa_continue_from_blocker');
    expect(JSON.stringify(s)).not.toContain('qa_resume');
  });

  it('qa_act type: `redacted` only when the value was treated as secret', async () => {
    const fake = new BusyDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const plain = structured(await h.call('qa_act', { sessionId: id, action: 'type', text: 'hello world', target: { x: 100, y: 100 } }));
    expect(plain.ok).toBe(true);
    expect(plain.redacted).toBeUndefined();
    expect(plain.secret).toBeUndefined();
    h.sessions.get(id)!.secrets.add('hunter22-smokefix');
    const secret = structured(
      await h.call('qa_act', { sessionId: id, action: 'type', text: 'hunter22-smokefix', target: { x: 100, y: 100 } }),
    );
    expect(secret.redacted).toBe(true);
    expect(secret.secret).toBe(true);
  });

  it('flow missing-variable message is grammatical and does not suggest qa_flow_repair', () => {
    expect(missingVarMessage(['HOME'])).toBe(
      'Variables not available: HOME (flows only read SWIPIUM_* environment variables; pass it via qa_flow_run { variables } or rename it SWIPIUM_HOME)',
    );
    expect(missingVarMessage(['A', 'SWIPIUM_B'])).toContain('pass them via qa_flow_run { variables } or rename it SWIPIUM_A');
    const steps = failedFlowNextSteps('login', 'login.yaml', 2, 'MISSING_FIXTURE');
    expect(steps.join(' ')).not.toContain('qa_flow_repair');
    expect(steps.join(' ')).toContain('variables');
    // control: locator failures still point at repair.
    expect(failedFlowNextSteps('login', 'login.yaml', 2, 'ELEMENT_NOT_FOUND').join(' ')).toContain('qa_flow_repair');
  });
});

describe('qa_app_control changedState reflects what actually ran', () => {
  class FailingDriver extends BusyDriver {
    failHome = false;
    failLaunch = false;
    async pressKey(key: string) {
      this.rec('pressKey', key);
      if (this.failHome) throw new Error('WDA POST /wda/homescreen → HTTP 404');
    }
    async launchApp() {
      this.rec('launchApp');
      if (this.failLaunch) throw new Error('launch failed');
    }
  }

  it('a driver call that fails before any mutation reports changedState:false', async () => {
    const fake = new FailingDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    fake.failHome = true;
    const s = structured(await h.call('qa_app_control', { sessionId: id, action: 'background' }));
    expect(s.ok).toBe(false);
    expect(s.changedState).toBe(false);
  });

  it('a failure after the app was already stopped reports changedState:true', async () => {
    const fake = new FailingDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    fake.failLaunch = true;
    const s = structured(await h.call('qa_app_control', { sessionId: id, action: 'restart' }));
    expect(s.ok).toBe(false);
    expect(fake.got('terminateApp')).toHaveLength(1);
    expect(s.changedState).toBe(true);
  });
});
