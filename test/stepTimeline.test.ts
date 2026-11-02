// Step timeline writers and note evidence, at the handler level with the shared fake driver:
//  - qa_act writes exactly one step per call (errors too), flows one per flow step, qa_note one,
//    smoke one for launch + health, explore one summary step;
//  - failure evidence: failed act / flow steps get a screenshot (and a dump when one is in hand),
//    no_change / validation / transport failures capture nothing, nothing counts toward the
//    screenshot budget, sensitive sessions capture nothing;
//  - qa_note: checkpoint screenshot for pass/fail, step range, unknown artifactUris dropped with a
//    warning before the verifiedVisually check, and a checkpoint is never "reached the app" evidence.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump, FakeDriver, harness, structured, textOf, type NodeSpec } from './actFixFake.js';
import type { Session, StepRecord } from '../src/session/store.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('step-timeline');
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
const HOME = dump([{ cls: 'android.widget.TextView', text: 'Home', bounds: [40, 100, 1040, 180], clickable: false }]);

/** A fake whose screenshot returns a non-empty buffer and counts calls. */
class ShotFake extends FakeDriver {
  shots = 0;
  override async screenshot() {
    this.shots++;
    return Buffer.from('png-bytes');
  }
}

async function start(xml = dump(LOGIN), extra: Record<string, unknown> = {}) {
  const fake = new ShotFake(xml);
  fake.reflectTyping = true;
  const id = await h.start(fake, extra);
  const session = h.sessions.get(id)!;
  // Bound like after any device tool (qa_start_session binds lazily; qa_note never binds).
  session.driver = fake;
  return { fake, id, session };
}

const steps = (s: Session): StepRecord[] => s.steps ?? [];
const last = (s: Session): StepRecord => steps(s).at(-1)!;
const artifactKinds = (s: Session) => s.artifacts.map((a) => a.kind);

describe('qa_act timeline step', () => {
  it('a tap writes one ok step with target, screen and duration', async () => {
    const { fake, id, session } = await start();
    await h.call('qa_snapshot', { sessionId: id });
    fake.onTap = () => (fake.xml = HOME);
    await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'Sign in' } });
    expect(steps(session)).toHaveLength(1);
    const st = last(session);
    expect(st).toMatchObject({ source: 'act', action: 'tap', target: 'tap "Sign in"', result: 'ok' });
    expect(typeof st.durationMs).toBe('number');
    expect(st.screen).toBe('Home');
    expect(st.screenshotUri).toBeUndefined();
    // No extra device call on success: no screenshot was taken.
    expect(fake.shots).toBe(0);
  }, 20_000);

  it('type names the field, never the typed text (secret or not)', async () => {
    const { id, session } = await start(dump([...LOGIN, PASSWORD]));
    const snap = structured(await h.call('qa_snapshot', { sessionId: id }));
    expect(snap.ok).toBe(true);
    await h.call('qa_act', { sessionId: id, action: 'type', target: { id: 'com.example.app:id/email' }, text: 'plain-typed-value-77' });
    await h.call('qa_act', { sessionId: id, action: 'type', target: { id: 'com.example.app:id/password' }, text: 'Sup3r-Secret-Pw!' });
    const [email, pw] = steps(session).slice(-2);
    expect(email.target).toBe('type into "com.example.app:id/email"');
    expect(pw.target).toBe('type into "com.example.app:id/password"');
    const all = JSON.stringify(steps(session));
    expect(all).not.toContain('plain-typed-value-77');
    expect(all).not.toContain('Sup3r-Secret-Pw!');
  }, 20_000);

  it('a ref target is labelled by the field name, not its current value', async () => {
    const { id, session } = await start(
      dump([{ cls: 'android.widget.EditText', text: 'me@example.com', desc: 'Email', bounds: [40, 300, 1040, 400] }]),
    );
    const snap = structured(await h.call('qa_snapshot', { sessionId: id }));
    const ref = String((snap.elements as string[])[0]).split(' ')[0];
    await h.call('qa_act', { sessionId: id, action: 'tap', target: { ref } });
    expect(last(session).target).toBe('tap "Email"');
  }, 20_000);

  it('a tap that changes nothing is no_change and captures nothing', async () => {
    const { fake, id, session } = await start();
    await h.call('qa_snapshot', { sessionId: id });
    await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'Sign in' } });
    const st = last(session);
    expect(st.result).toBe('no_change');
    expect(st.screenshotUri).toBeUndefined();
    expect(st.dumpUri).toBeUndefined();
    expect(fake.shots).toBe(0);
  }, 20_000);

  it('a resolve error records a failed step with its failureCode and a screenshot, outside the budget', async () => {
    const { fake, id, session } = await start();
    await h.call('qa_snapshot', { sessionId: id });
    const before = session.counters.screenshots;
    const res = structured(await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'No such button' } }));
    expect(res.ok).toBe(false);
    expect(steps(session)).toHaveLength(1);
    const st = last(session);
    expect(st.result).toBe('failed');
    expect(st.failureCode).toBe(res.failureCode);
    expect(st.failureCode).toBeTruthy();
    expect(st.screenshotUri).toMatch(/^swipium:\/\/session\/.+\/screenshot\/step-\d+-fail-/);
    expect(fake.shots).toBe(1);
    expect(session.counters.screenshots).toBe(before);
  }, 20_000);

  it('a failure after the settle keeps the settled XML as the step dump', async () => {
    const { fake, id, session } = await start();
    fake.reflectTyping = false; // the field never holds the text: read-back mismatch after the settle
    await h.call('qa_snapshot', { sessionId: id });
    const res = structured(
      await h.call('qa_act', { sessionId: id, action: 'type', target: { id: 'com.example.app:id/email' }, text: 'abc-not-landing' }),
    );
    expect(res.failureCode).toBe('TEXT_INPUT_MISMATCH');
    const st = last(session);
    expect(st.result).toBe('failed');
    expect(st.screenshotUri).toBeTruthy();
    expect(st.dumpUri).toMatch(/\/dump\/step-\d+-dump-/);
    const dumpArt = session.artifacts.find((a) => a.uri === st.dumpUri)!;
    expect(readFileSync(dumpArt.path, 'utf8')).toContain('<hierarchy');
    expect(fake.shots).toBe(1);
  }, 30_000);

  it('validation errors record a failed step but capture nothing', async () => {
    const { fake, id, session } = await start();
    const res = structured(await h.call('qa_act', { sessionId: id, action: 'wait', target: { text: 'x' } }));
    expect(res.failureCode).toBe('INVALID_ARGUMENT');
    const missing = structured(await h.call('qa_act', { sessionId: id, action: 'type', target: { text: 'Email' } }));
    expect(missing.ok).toBe(false);
    expect(steps(session).map((st) => st.result)).toEqual(['failed', 'failed']);
    expect(steps(session).every((st) => !st.screenshotUri && !st.dumpUri)).toBe(true);
    expect(fake.shots).toBe(0);
  }, 20_000);

  it('a transport failure (device gone) captures nothing', async () => {
    const { fake, id, session } = await start();
    await h.call('qa_snapshot', { sessionId: id });
    fake.onTap = () => {
      throw new Error("adb: device 'emulator-5554' not found");
    };
    const res = structured(await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'Sign in' } }));
    expect(res.failureCode).toBe('NO_DEVICE');
    const st = last(session);
    expect(st).toMatchObject({ result: 'failed', failureCode: 'NO_DEVICE' });
    expect(st.screenshotUri).toBeUndefined();
    expect(fake.shots).toBe(0);
  }, 20_000);

  it('a sensitive session records the failure without an image', async () => {
    const { fake, id, session } = await start(dump(LOGIN), { sensitive: true });
    session.sensitive = true;
    await h.call('qa_snapshot', { sessionId: id });
    await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'No such button' } });
    const st = last(session);
    expect(st.result).toBe('failed');
    expect(st.screenshotUri).toBeUndefined();
    expect(st.screenshotSkipped).toMatch(/sensitive/);
    expect(fake.shots).toBe(0);
    expect(artifactKinds(session)).not.toContain('screenshot');
  }, 20_000);

  it('a failure on a screen with a secure field is withheld, not captured', async () => {
    const { fake, id, session } = await start(dump([...LOGIN, PASSWORD]));
    await h.call('qa_snapshot', { sessionId: id });
    await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'No such button' } });
    expect(last(session).screenshotSkipped).toBe('screenshot withheld (secure field)');
    expect(fake.shots).toBe(0);
  }, 20_000);
});

describe('flow timeline steps', () => {
  const flowYaml = [
    'name: login',
    'steps:',
    '  - inputText: { into: "id=com.example.app:id/email", text: "literal-typed-33" }',
    '  - inputText: { into: "id=com.example.app:id/password", text: "${SWIPIUM_TEST_PASSWORD}", secret: true }',
    '  - tap: "Sign in"',
    '',
  ].join('\n');

  it('N acts + one flow of M steps + one note give N+M+1 steps; the flow secret never reaches state.json', async () => {
    const { fake, id, session } = await start(dump([...LOGIN, PASSWORD]));
    await h.call('qa_snapshot', { sessionId: id });
    // N = 2 acts
    await h.call('qa_act', { sessionId: id, action: 'swipe', direction: 'up' });
    await h.call('qa_act', { sessionId: id, action: 'press', key: 'back' });
    fake.onTap = (_x, y) => {
      if (y > 500) fake.xml = HOME;
    };
    const run = structured(
      await h.call('qa_flow_run', { sessionId: id, flowYaml, variables: { SWIPIUM_TEST_PASSWORD: 'Hunter2-Very-Secret' } }),
    );
    expect(run.passed, JSON.stringify(run).slice(0, 600)).toBe(true);
    await h.call('qa_note', { sessionId: id, workflow: 'login', outcome: 'pass' });
    const all = steps(session);
    expect(all).toHaveLength(2 + 3 + 1);
    expect(all.every((st) => st.result && typeof st.durationMs === 'number')).toBe(true);
    expect(all.map((st) => st.source)).toEqual(['act', 'act', 'flow', 'flow', 'flow', 'note']);
    const flowSteps = all.filter((st) => st.source === 'flow');
    expect(flowSteps.every((st) => st.group === 'login')).toBe(true);
    expect(flowSteps.map((st) => st.target)).toEqual([
      'type into "id=com.example.app:id/email"',
      'type into "id=com.example.app:id/password"',
      'tap Sign in',
    ]);
    // The flow note links its run's steps.
    const flowNote = session.notes.find((n) => n.workflow === 'login' && n.origin === 'flow')!;
    expect(flowNote.stepRange).toEqual([flowSteps[0].i, flowSteps[2].i]);
    h.sessions.persistNow(session);
    const state = readFileSync(join(session.dir, 'state.json'), 'utf8');
    expect(state).not.toContain('Hunter2-Very-Secret');
    expect(state).not.toContain('literal-typed-33');
    expect(state).toContain('"source":"flow"');
  }, 30_000);

  it('a failed flow step reuses the failure screenshot and adds a dump, outside the budget', async () => {
    const { fake, id, session } = await start();
    const before = session.counters.screenshots;
    const run = structured(
      await h.call('qa_flow_run', { sessionId: id, flowYaml: 'name: broken\nsteps:\n  - assertVisible: "Not on this screen"\n' }),
    );
    expect(run.passed).toBe(false);
    const st = last(session);
    expect(st).toMatchObject({ source: 'flow', group: 'broken', result: 'failed', failureCode: 'ASSERTION_FAILED' });
    const flowShot = (run.steps as Array<{ screenshotUri?: string }>)[0].screenshotUri;
    expect(flowShot).toBeTruthy();
    expect(st.screenshotUri).toBe(flowShot);
    expect(st.dumpUri).toBeTruthy();
    expect(fake.shots).toBe(1); // reused, not captured twice
    expect(session.counters.screenshots).toBe(before);
  }, 30_000);

  it('a flow whose verdict came from a visual step marks its note visualStep; a note: step is flow_note', async () => {
    const { id, session } = await start();
    await h.call('qa_flow_run', {
      sessionId: id,
      flowYaml: 'name: vis\nsteps:\n  - note: { outcome: pass, reason: "checkpoint" }\n  - assertDiff: missing-baseline\n',
    });
    const flowNote = session.notes.find((n) => n.workflow === 'vis')!;
    expect(flowNote.origin).toBe('flow');
    expect(flowNote.visualStep).toBe(true);
    expect(session.notes.find((n) => n.workflow === 'vis:note')?.origin).toBe('flow_note');
  }, 30_000);
});

describe('step cap', () => {
  it('600 steps keep the first failure', async () => {
    const { id, session } = await start();
    await h.call('qa_snapshot', { sessionId: id });
    await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'No such button' } });
    const firstFailure = last(session);
    expect(firstFailure.result).toBe('failed');
    for (let i = 0; i < 599; i++) h.sessions.addStep(session, { source: 'act', action: 'tap', result: 'ok', durationMs: 1 });
    expect(steps(session)).toHaveLength(500);
    expect(steps(session)[0]).toEqual(firstFailure);
  }, 30_000);
});

describe('qa_note step and checkpoint', () => {
  it('a pass note writes one note step, a checkpoint and its step range', async () => {
    const { fake, id, session } = await start();
    await h.call('qa_snapshot', { sessionId: id });
    fake.onTap = () => (fake.xml = HOME);
    await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'Sign in' } });
    const res = structured(await h.call('qa_note', { sessionId: id, workflow: 'Login', outcome: 'pass' }));
    expect(res.ok).toBe(true);
    const st = last(session);
    expect(st).toMatchObject({ source: 'note', action: 'note', group: 'Login', result: 'ok' });
    const note = session.notes.at(-1)!;
    expect(note.origin).toBe('agent');
    expect(note.stepRange).toEqual([steps(session)[0].i, st.i]);
    expect(note.checkpointUri).toMatch(/\/checkpoint\/checkpoint-/);
    expect(note.artifactUris).toBeUndefined(); // the checkpoint is linked, not claimed as agent evidence
    expect(st.screenshotUri).toBe(note.checkpointUri);
    const art = session.artifacts.find((a) => a.uri === note.checkpointUri)!;
    expect(art.kind).toBe('checkpoint');
    expect(art.appForeground).toBeUndefined();
    expect(session.counters.screenshots).toBe(0);
    expect(res.checkpointUri).toBe(note.checkpointUri);

    // The next note covers only the steps since this one.
    await h.call('qa_act', { sessionId: id, action: 'press', key: 'back' });
    await h.call('qa_note', { sessionId: id, workflow: 'Back', outcome: 'skipped' });
    const next = session.notes.at(-1)!;
    expect(next.stepRange).toEqual([st.i + 1, st.i + 2]);
    expect(next.checkpointUri).toBeUndefined(); // only pass/fail notes capture
    expect(fake.shots).toBe(1);
  }, 30_000);

  it('with no device attached the note succeeds without an image', async () => {
    const { fake, id, session } = await start();
    session.driver = undefined;
    const res = structured(await h.call('qa_note', { sessionId: id, workflow: 'Login', outcome: 'fail' }));
    expect(res.ok).toBe(true);
    expect(session.notes.at(-1)!.checkpointSkipped).toBe('no device attached');
    expect(last(session).result).toBe('failed');
    expect(fake.shots).toBe(0);
  }, 20_000);

  it('after a transport failure the note captures nothing', async () => {
    const { fake, id, session } = await start();
    await h.call('qa_snapshot', { sessionId: id });
    fake.onTap = () => {
      throw new Error('error: device offline');
    };
    await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'Sign in' } });
    await h.call('qa_note', { sessionId: id, workflow: 'Login', outcome: 'pass' });
    expect(session.notes.at(-1)!.checkpointSkipped).toMatch(/device unreachable/);
    expect(fake.shots).toBe(0);
  }, 20_000);

  it('a sensitive session never captures a checkpoint', async () => {
    const { fake, id, session } = await start();
    session.sensitive = true;
    await h.call('qa_note', { sessionId: id, workflow: 'Login', outcome: 'pass' });
    expect(session.notes.at(-1)!.checkpointSkipped).toMatch(/sensitive/);
    expect(fake.shots).toBe(0);
    expect(artifactKinds(session)).not.toContain('checkpoint');
  }, 20_000);

  it('a hung screenshot times out and the note still records', async () => {
    const { fake, id, session } = await start();
    fake.screenshot = () => new Promise<Buffer>(() => undefined);
    const t0 = Date.now();
    const res = structured(await h.call('qa_note', { sessionId: id, workflow: 'Login', outcome: 'pass' }));
    expect(res.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(session.notes.at(-1)!.checkpointSkipped).toBe('checkpoint timed out');
  }, 20_000);

  it('an agent pass plus its checkpoint is still not "reached the app"', async () => {
    const { generateSessionReport } = await import('../src/services/report.js');
    const withShot = await start();
    await h.call('qa_note', { sessionId: withShot.id, workflow: 'Login', outcome: 'pass' });
    expect(withShot.session.notes.at(-1)!.checkpointUri).toBeTruthy();
    const without = await start();
    without.session.driver = undefined;
    await h.call('qa_note', { sessionId: without.id, workflow: 'Login', outcome: 'pass' });
    expect(without.session.notes.at(-1)!.checkpointUri).toBeUndefined();
    without.session.driver = without.fake;
    const a = (await generateSessionReport(h.sessions, withShot.session)).report as Record<string, unknown>;
    const b = (await generateSessionReport(h.sessions, without.session)).report as Record<string, unknown>;
    const nt = (r: Record<string, unknown>) => r.notTested as { reachedApp?: boolean; reason?: string; failureCode?: string };
    expect(nt(a)?.reachedApp).toBe(false);
    expect(nt(a)).toEqual(nt(b));
  }, 30_000);
});

describe('qa_note evidence links', () => {
  it('an unknown artifactUri is dropped with a warning; known ones are kept', async () => {
    const { id, session } = await start();
    const shot = structured(await h.call('qa_screenshot', { sessionId: id, reason: 'evidence' }));
    const known = String(shot.uri ?? shot.artifactUri ?? session.artifacts.find((a) => a.kind === 'screenshot')?.uri);
    expect(session.artifacts.some((a) => a.uri === known)).toBe(true);
    const bogus = 'swipium://session/other/screenshot/nope.png';
    const res = await h.call('qa_note', { sessionId: id, workflow: 'Cart', outcome: 'fail', artifactUris: [known, bogus] });
    const s = structured(res);
    expect(s.ok).toBe(true);
    expect(s.warnings as string[]).toEqual([expect.stringContaining(bogus)]);
    expect(textOf(res)).toContain('dropped 1 artifactUri');
    expect(session.notes.at(-1)!.artifactUris).toEqual([known]);
  }, 20_000);

  it('a verifiedVisually pass backed only by unknown URIs is refused as missing evidence', async () => {
    const { id, session } = await start();
    const res = structured(
      await h.call('qa_note', {
        sessionId: id,
        workflow: 'Map',
        outcome: 'pass',
        verifiedVisually: true,
        artifactUris: ['swipium://session/x/screenshot/made-up.png'],
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('INVALID_ARGUMENT');
    expect(session.notes).toHaveLength(0);
  }, 20_000);

  it('verifiedVisually still needs explicit evidence: the auto checkpoint does not count', async () => {
    const { id, session } = await start();
    // An earlier pass leaves a checkpoint in the session.
    await h.call('qa_note', { sessionId: id, workflow: 'Home', outcome: 'pass' });
    expect(session.notes.at(-1)!.checkpointUri).toBeTruthy();
    const res = structured(await h.call('qa_note', { sessionId: id, workflow: 'Map', outcome: 'pass', verifiedVisually: true }));
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('INVALID_ARGUMENT');
  }, 20_000);
});

describe('smoke and explore steps', () => {
  it('smoke writes one launch step and origin-tagged notes', async () => {
    const { runSmoke } = await import('../src/services/smoke.js');
    const { session, fake } = await start(HOME);
    await runSmoke(h.sessions, session, fake, { launch: true, runFlows: false });
    const smokeSteps = steps(session).filter((st) => st.source === 'smoke');
    expect(smokeSteps).toHaveLength(1);
    expect(smokeSteps[0]).toMatchObject({ action: 'launch', result: 'ok' });
    expect(smokeSteps[0].screenshotUri).toBeTruthy();
    const launch = session.notes.find((n) => n.workflow === 'launch_smoke')!;
    expect(launch.origin).toBe('smoke');
    expect(launch.stepRange).toEqual([smokeSteps[0].i, smokeSteps[0].i]);
  }, 60_000);

  it('explore writes one summary step and explore-tagged notes', async () => {
    const { runExplore } = await import('../src/explore/runner.js');
    const { linkExploreStep } = await import('../src/explore/runner.js');
    const { session, fake } = await start(dump(LOGIN));
    session.inputs = [];
    const res = await runExplore(h.sessions, session, fake, { maxActions: 2, maxDurationMs: 20_000, stopOnAuth: true });
    const ex = steps(session).filter((st) => st.source === 'explore');
    expect(ex).toHaveLength(1);
    expect(ex[0].target).toMatch(/^explored \d+ screen\(s\), \d+ action\(s\)/);
    expect(res.stepIndex).toBe(ex[0].i);
    linkExploreStep(h.sessions, session, res.stepIndex, 'swipium://session/x/explore/graph-1.json');
    expect(ex[0].target).toContain('graph: swipium://session/x/explore/graph-1.json');
    expect(session.notes.length).toBeGreaterThan(0); // the login wall is noted
    for (const n of session.notes) expect(n.origin).toBe('explore');
  }, 60_000);
});
