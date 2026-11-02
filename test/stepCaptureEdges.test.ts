// Failure evidence edge cases for the step timeline, at the handler level with the shared fake driver:
//  - a flow step that fails because the device is gone takes no screenshot and no dump;
//  - a qa_act handler that throws records a failed step without touching the device;
//  - an OVERLAY_OBSTRUCTION refusal captures nothing;
//  - a qa_act failure before any settle (no fresh tree) re-checks the screen for a secure field.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dump, FakeDriver, harness, structured, textOf, type NodeSpec } from './actFixFake.js';
import { TRANSPORT_FAILURE_CODES, type Session, type StepRecord } from '../src/session/store.js';
import type { NativeSelectorStrategy } from '../src/drivers/Driver.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('step-capture-edges');
});
afterAll(async () => {
  await h.close();
});

const LOGIN: NodeSpec[] = [
  { cls: 'android.widget.TextView', text: 'Welcome', bounds: [40, 100, 1040, 180], clickable: false },
  { cls: 'android.widget.EditText', desc: 'Email', id: 'com.example.app:id/email', bounds: [40, 300, 1040, 400] },
  { cls: 'android.widget.Button', text: 'Sign in', id: 'com.example.app:id/signin', bounds: [40, 500, 1040, 600] },
];
const PASSWORD: NodeSpec = {
  cls: 'android.widget.EditText',
  desc: 'Password',
  id: 'com.example.app:id/password',
  bounds: [40, 420, 1040, 480],
  extra: 'password="true"',
};

/** Counts screenshots; can stand in for a backend with native selector waits. */
class ShotFake extends FakeDriver {
  shots = 0;
  existsThrows?: Error;
  override async screenshot() {
    this.shots++;
    return Buffer.from('png-bytes');
  }
  async existsBySelector(_using: NativeSelectorStrategy, _value: string): Promise<boolean> {
    this.rec('existsBySelector');
    if (this.existsThrows) throw this.existsThrows;
    return false;
  }
}

async function start(xml = dump(LOGIN)) {
  const fake = new ShotFake(xml);
  const id = await h.start(fake);
  const session = h.sessions.get(id)!;
  session.driver = fake;
  return { fake, id, session };
}

const last = (s: Session): StepRecord => (s.steps ?? []).at(-1)!;

describe('flow failure on a dead device', () => {
  it('takes no screenshot and no dump, and notes the step as not captured', async () => {
    const { fake, id, session } = await start();
    fake.onTap = () => {
      throw new Error("adb: device 'emulator-5554' not found");
    };
    const run = structured(await h.call('qa_flow_run', { sessionId: id, flowYaml: 'name: dead\nsteps:\n  - tap: "Sign in"\n' }));
    expect(run.passed).toBe(false);
    const st = last(session);
    expect(st.source).toBe('flow');
    expect(st.result).toBe('failed');
    expect(TRANSPORT_FAILURE_CODES.has(st.failureCode ?? '')).toBe(true);
    expect(st.screenshotSkipped).toBe('not captured (device unreachable)');
    expect(st.screenshotUri).toBeUndefined();
    expect(st.dumpUri).toBeUndefined();
    expect((run.steps as Array<{ screenshotUri?: string }>)[0].screenshotUri).toBeUndefined();
    expect(fake.shots).toBe(0);
  }, 30_000);
});

describe('qa_act failure evidence edges', () => {
  it('a handler that throws records a failed step with no device capture and still surfaces the error', async () => {
    const { fake, id, session } = await start();
    fake.existsThrows = new Error('boom: unexpected driver failure 4411');
    const res = await h.call('qa_act', {
      sessionId: id,
      action: 'wait',
      for: { selector: { using: 'accessibility id', value: 'never' } },
      timeoutMs: 2000,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('boom: unexpected driver failure 4411');
    const st = last(session);
    expect(st).toMatchObject({ source: 'act', action: 'wait', result: 'failed', failureCode: 'UNKNOWN' });
    expect(st.screenshotUri).toBeUndefined();
    expect(st.dumpUri).toBeUndefined();
    expect(fake.shots).toBe(0);
    expect(fake.got('dumpXml')).toHaveLength(0);
  }, 20_000);

  it('an overlay obstruction records a failed step and captures nothing', async () => {
    const promo: NodeSpec = {
      cls: 'android.widget.Button',
      text: 'Promo banner',
      id: 'com.example.app:id/promo',
      bounds: [0, 450, 1080, 650],
    };
    const { fake, id, session } = await start(dump([...LOGIN, promo]));
    await h.call('qa_snapshot', { sessionId: id });
    const res = structured(await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'Sign in' } }));
    expect(res.failureCode).toBe('OVERLAY_OBSTRUCTION');
    const st = last(session);
    expect(st).toMatchObject({ source: 'act', result: 'failed', failureCode: 'OVERLAY_OBSTRUCTION' });
    expect(st.screenshotUri).toBeUndefined();
    expect(st.dumpUri).toBeUndefined();
    expect(fake.shots).toBe(0);
    expect(fake.got('tapXY')).toHaveLength(0);
  }, 20_000);

  it('a failure before any settle re-checks the screen and withholds on a secure field', async () => {
    // No qa_snapshot: nothing cached. The native selector tap is refused on this backend before
    // any settle, so the guard has no tree in hand and must dump once to see the password field.
    const { fake, id, session } = await start(dump([...LOGIN, PASSWORD]));
    const res = structured(
      await h.call('qa_act', { sessionId: id, action: 'tap', target: { selector: { using: 'accessibility id', value: 'login' } } }),
    );
    expect(res.failureCode).toBe('BACKEND_UNSUPPORTED');
    const st = last(session);
    expect(st.result).toBe('failed');
    expect(st.screenshotUri).toBeUndefined();
    expect(st.screenshotSkipped).toBe('screenshot withheld (secure field)');
    expect(fake.shots).toBe(0);
    expect(fake.got('dumpXml')).toHaveLength(1);
  }, 20_000);

  it('a failure before any settle on a clear screen still captures after the one check', async () => {
    const { fake, id, session } = await start();
    await h.call('qa_act', { sessionId: id, action: 'tap', target: { selector: { using: 'accessibility id', value: 'login' } } });
    const st = last(session);
    expect(st.result).toBe('failed');
    expect(st.screenshotUri).toBeTruthy();
    expect(fake.shots).toBe(1);
    expect(fake.got('dumpXml')).toHaveLength(1);
  }, 20_000);
});
