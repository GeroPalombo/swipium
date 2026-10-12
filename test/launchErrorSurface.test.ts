// Launch error screens and related fixes (hermetic, fake driver):
//  - a launch onto an RN RedBox / Expo dev launcher is caught from one tree
//    (launchErrorSurface / checkLaunchErrorSurface): the bundle-load variant marks the session not
//    tested (METRO_REQUIRED), a JS-exception RedBox is an app finding, an iOS alert on top is named;
//    qa_prepare_ios_target's job fails METRO_REQUIRED instead of "ready"; qa_screenshot of a RedBox
//    says so and is not "reached the app" evidence.
//  - qa_wda stop names where a registry-found WDA came from (wdaStopOrigin).
//  - A flow whose app is not installed is BUNDLE_ID_NOT_FOUND, filed blocked (setup), not mcp_limitation.
//  - The process registry drops dead children's entries on the next registration.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buttonScreen, dump, FakeDriver, harness, structured, textOf } from './actFixFake.js';

// The registry module fixes its path at import time; the qa_screenshot harness later moves HOME.
const registryHome = process.env.HOME!;
const prepareIosResult = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../src/services/prepareIos.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/prepareIos.js')>()),
  prepareIos: vi.fn(async () => prepareIosResult.value),
}));

const { launchErrorSurface, isMetroRequiredFinding } = await import('../src/oracle/health.js');
const { checkLaunchErrorSurface } = await import('../src/oracle/record.js');
const { SessionStore } = await import('../src/session/store.js');
const { parseSnapshot } = await import('../src/snapshot/parse.js');
const { wdaStopOrigin } = await import('../src/tools/wda.js');
const { classifyFlowFailure } = await import('../src/services/smoke.js');
const { runFlow } = await import('../src/flows/run.js');
const { runPrepareIosJob } = await import('../src/tools/prepareIosTarget.js');
type Flow = import('../src/flows/schema.js').Flow;
type FlowRunResult = import('../src/flows/run.js').FlowRunResult;

const T = (text: string, y = 200) => ({
  cls: 'android.widget.TextView',
  text,
  bounds: [40, y, 1040, y + 80] as [number, number, number, number],
});
const NO_BUNDLE = dump([
  T('No script URL provided. Make sure the packager is running or you have embedded a JS bundle in your application bundle.'),
]);
const JS_ERROR = dump([T('TypeError: undefined is not an object (evaluating x.y)'), T('Reload', 400), T('Dismiss', 500)]);

function newSession(fake?: FakeDriver) {
  const sessions = new SessionStore();
  const session = sessions.create(mkdtempSync(join(tmpdir(), 'swipium-r4f-proj-')));
  session.appId = 'com.example.app';
  if (fake) session.driver = fake;
  return { sessions, session };
}

describe('launch error screen detection', () => {
  it('launchErrorSurface: bundle-load RedBox is METRO_REQUIRED, a JS-exception RedBox is not, a normal screen is nothing', () => {
    const metro = launchErrorSurface(parseSnapshot(NO_BUNDLE).allNodes);
    expect(metro?.kind).toBe('rn_redbox');
    expect(isMetroRequiredFinding(metro!)).toBe(true);
    const js = launchErrorSurface(parseSnapshot(JS_ERROR).allNodes);
    expect(js?.kind).toBe('rn_redbox');
    expect(isMetroRequiredFinding(js!)).toBe(false);
    expect(launchErrorSurface(parseSnapshot(buttonScreen('Home', 3)).allNodes)).toBeUndefined();
  });

  it('checkLaunchErrorSurface: METRO_REQUIRED marks the session not tested (no finding); a JS RedBox is an app finding', async () => {
    const a = newSession(new FakeDriver(NO_BUNDLE));
    const r1 = await checkLaunchErrorSurface(a.sessions, a.session, a.session.driver!);
    expect(r1.appError && isMetroRequiredFinding(r1.appError)).toBe(true);
    expect(a.session.notTested?.failureCode).toBe('METRO_REQUIRED');
    expect(a.session.findings).toHaveLength(0);

    const b = newSession(new FakeDriver(JS_ERROR));
    const r2 = await checkLaunchErrorSurface(b.sessions, b.session, b.session.driver!);
    expect(r2.appError?.kind).toBe('rn_redbox');
    expect(b.session.notTested).toBeUndefined();
    expect(b.session.findings.map((f) => f.kind)).toEqual(['rn_redbox']);

    const c = newSession(new FakeDriver(buttonScreen('Home', 2)));
    expect(await checkLaunchErrorSurface(c.sessions, c.session, c.session.driver!)).toEqual({});
  });

  it('checkLaunchErrorSurface names an iOS alert left on top of the app', async () => {
    const xml = dump([
      { cls: 'XCUIElementTypeAlert', desc: 'Sign in to your Apple Account', bounds: [100, 600, 980, 1200] },
      { cls: 'XCUIElementTypeButton', text: 'Close', bounds: [120, 1000, 540, 1100] },
    ]);
    const s = newSession(new FakeDriver(xml));
    const r = await checkLaunchErrorSurface(s.sessions, s.session, s.session.driver!);
    expect(r.appError).toBeUndefined();
    expect(r.alert).toBe('Sign in to your Apple Account');
  });

  it('a failed dump is no verdict', async () => {
    const fake = new FakeDriver('');
    fake.dumpXml = async () => {
      throw new Error('dump failed');
    };
    const s = newSession(fake);
    expect(await checkLaunchErrorSurface(s.sessions, s.session, fake)).toEqual({});
    expect(s.session.notTested).toBeUndefined();
  });

  it('qa_prepare_ios_target job: a structured launch onto the bundle-load RedBox fails METRO_REQUIRED, not "ready"', async () => {
    const { sessions, session } = newSession(new FakeDriver(NO_BUNDLE));
    prepareIosResult.value = {
      ok: true,
      udid: 'SIM-1',
      name: 'iPhone 16',
      bundleId: 'com.example.app',
      installed: false,
      launched: true,
      mode: 'structured',
      resultText: 'ready iOS iPhone 16 / com.example.app: WDA structured.',
    };
    const job = sessions.createJob(session, 'prepare_ios');
    await runPrepareIosJob(sessions, session, job, { bundleId: 'com.example.app' });
    expect(job.status).toBe('failed');
    expect(String(job.error)).toMatch(/^METRO_REQUIRED: .*launched, but the app shows RN RedBox/);
    expect(session.notTested?.failureCode).toBe('METRO_REQUIRED');
  });

  it('qa_prepare_ios_target job: a visual-only launch reads no tree (no check)', async () => {
    const fake = new FakeDriver(NO_BUNDLE);
    const { sessions, session } = newSession(fake);
    prepareIosResult.value = { ok: true, udid: 'SIM-1', name: 'iPhone 16', launched: true, mode: 'visual-fallback', resultText: 'ready' };
    const job = sessions.createJob(session, 'prepare_ios');
    await runPrepareIosJob(sessions, session, job, { bundleId: 'com.example.app' });
    expect(job.status).toBe('done');
    expect(fake.got('dumpXml')).toHaveLength(0);
  });

  describe('qa_screenshot', () => {
    let h: Awaited<ReturnType<typeof harness>>;
    beforeAll(async () => {
      h = await harness('r4f-shot');
    });
    afterAll(async () => {
      await h.close();
    });

    it('a RedBox on screen is reported and the screenshot is not "reached the app" evidence', async () => {
      const fake = new FakeDriver(NO_BUNDLE);
      fake.foreground = 'com.example.app/.MainActivity';
      const id = await h.start(fake);
      const res = await h.call('qa_screenshot', { sessionId: id });
      const s = structured(res);
      expect((s.appError as { failureCode?: string }).failureCode).toBe('METRO_REQUIRED');
      expect(textOf(res)).toMatch(/METRO_REQUIRED: the app shows RN RedBox/);
      const art = h.sessions.get(id)!.artifacts.find((a) => a.uri === s.uri);
      expect(art?.appForeground).toBeUndefined();
    }, 20_000);

    it('a normal screen still counts as an app-in-front screenshot', async () => {
      const fake = new FakeDriver(buttonScreen('Home', 2));
      const id = await h.start(fake);
      const s = structured(await h.call('qa_screenshot', { sessionId: id }));
      expect(s.appError).toBeUndefined();
      expect(h.sessions.get(id)!.artifacts.find((a) => a.uri === s.uri)?.appForeground).toBe(true);
    }, 20_000);
  });
});

describe('qa_wda stop wording', () => {
  it('names this server or another one, never "another server run" for its own WDA', () => {
    expect(wdaStopOrigin([{ serverPid: 10 }], 10)).toBe('registered by this server for another session');
    expect(wdaStopOrigin([{ serverPid: 11 }], 10)).toBe('registered by another Swipium server');
    expect(wdaStopOrigin([{ serverPid: 10 }, { serverPid: 11 }], 10)).toMatch(/this server .* and by another Swipium server/);
  });
});

describe('a flow for an app that is not installed (Android)', () => {
  const flow = { name: 'other-app', appId: 'com.other.app', mode: 'structured', fixtures: [], setup: [], teardown: [] } as unknown as Flow;

  it('prepareTarget on a missing app fails BUNDLE_ID_NOT_FOUND, filed blocked (setup), not mcp_limitation', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 2));
    fake.launchApp = async () => {
      throw new Error('`adb shell monkey -p com.other.app` exited 252');
    };
    fake.isInstalled = async () => false;
    const { sessions, session } = newSession(fake);
    const r = await runFlow(sessions, session, fake, { ...flow, steps: [{ kind: 'prepareTarget' }] } as Flow);
    expect(r.passed).toBe(false);
    expect(r.failureCode).toBe('BUNDLE_ID_NOT_FOUND');
    expect(r.reason).toMatch(/com\.other\.app is not installed/);
    const c = classifyFlowFailure(r, 'appId: com.other.app\n');
    expect(c).toMatchObject({ outcome: 'blocked', category: 'other' });
    expect(c.recommendedSetup).toMatch(/Install the app/);
  }, 20_000);

  it('a launch failure of an installed app is unchanged (not BUNDLE_ID_NOT_FOUND)', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 2));
    fake.launchApp = async () => {
      throw new Error('boom');
    };
    const { sessions, session } = newSession(fake);
    const r = await runFlow(sessions, session, fake, { ...flow, steps: [{ kind: 'prepareTarget' }] } as Flow);
    expect(r.failureCode).not.toBe('BUNDLE_ID_NOT_FOUND');
  }, 20_000);

  it('classifyFlowFailure keeps other environment codes as before', () => {
    const r = { passed: false, failureCode: 'NO_DEVICE', steps: [] } as unknown as FlowRunResult;
    expect(classifyFlowFailure(r, '')).toEqual({ outcome: 'fail', category: 'mcp_limitation' });
  });
});

describe('process registry: dead entries are pruned on registration', () => {
  it('a dead child entry owned by a live server is dropped when another child registers', async () => {
    const { registerManagedProcess } = await import('../src/session/processRegistry.js');
    const file = join(registryHome, '.swipium', 'processes.json');
    mkdirSync(join(registryHome, '.swipium'), { recursive: true });
    const dead = 2 ** 22 + 12345; // above every default pid_max: never a live process
    writeFileSync(file, JSON.stringify([{ pid: dead, kind: 'wda', serverPid: process.pid, startedAt: Date.now() }]));
    registerManagedProcess(process.pid, 'recording', 'sess-1');
    const pids = (JSON.parse(readFileSync(file, 'utf8')) as Array<{ pid: number }>).map((e) => e.pid);
    expect(pids).toEqual([process.pid]);
  });
});
