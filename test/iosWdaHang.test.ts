// R5 follow-ups (iOS/WDA): hung WDA handling and small result fixes.
//  - prepareIos: this simulator's own WDA already hung before prepare (listens, /status silent) is
//    WDA_UNREACHABLE / wdaHung, never a visual-only pass; POST /session is capped at 15 s and a
//    timeout with a silent /status is the hung path
//  - lostWdaResult: a blocked/executed WDA in the ledger that no longer answers is WDA_UNREACHABLE
//  - runSmoke: the WDA-hang path (prepare said hung, or the launch's session create timed out)
//  - qa_clear_overlay auto on a permission dialog: needs_decision, nothing tapped
//  - a WDA "unable to find an element" 404 is ELEMENT_NOT_FOUND, a re-created element STALE_REF
//  - "Don't Allow" closes say the permission was denied; logs.since relative to a given clock
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-wdahang-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const SIM = '6C1E1C1A-1B2C-4D3E-8F90-0123456789AB';
const CONFIGURED = 'http://127.0.0.1:8100';
const OWN = 'http://127.0.0.1:8110';

const fake = vi.hoisted(() => ({
  status: {} as Record<string, { reachable: boolean; ready: boolean; error?: string }>,
  ownHung: false,
  sessionHangs: false,
  sessionTimeouts: [] as number[],
}));

vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return {
    ...actual,
    checkWda: async (url: string) => fake.status[url.replace(/\/+$/, '')] ?? { reachable: false, ready: false, error: 'ECONNREFUSED' },
    // The real request path (wdaFetch), with a WDA that never answers POST /session: the timeout
    // signal fires at once, and the per-call timeout it was created with is recorded.
    createWdaSession: async (url: string, opts: unknown) => {
      if (!fake.sessionHangs) return { sessionId: 'S1', capabilities: {} };
      const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        fake.sessionTimeouts.push(ms);
        const c = new AbortController();
        c.abort();
        return c.signal;
      });
      vi.stubGlobal('fetch', async () => {
        fake.status[url] = { reachable: false, ready: false, error: 'This operation was aborted' }; // /status goes silent too
        throw new Error('This operation was aborted');
      });
      try {
        return await actual.createWdaSession(url, opts as never);
      } finally {
        spy.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  };
});
vi.mock('../src/lib/wdaDevice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wdaDevice.js')>();
  return {
    ...actual,
    wdaDeviceOwnership: async () => ({ owner: 'match', reason: 'test' }),
    ownButUnresponsive: async () => false,
    findOwnSimulatorWda: async (_u: string, _d: string, _r: unknown, unresponsive?: string[]) => {
      if (fake.ownHung) unresponsive?.push(OWN);
      return undefined;
    },
  };
});
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return {
    ...actual,
    simctlAvailable: async () => true,
    listSimulators: async () => [{ udid: SIM, name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' }],
  };
});

const { SessionStore } = await import('../src/session/store.js');
const { prepareIos } = await import('../src/services/prepareIos.js');
const { lostWdaResult } = await import('../src/session/attach.js');
const { runSmoke } = await import('../src/services/smoke.js');
const { classifyFlowDriverError } = await import('../src/flows/run.js');
const { permissionDeniedNote } = await import('../src/snapshot/overlays.js');
const { logcatSince } = await import('../src/tools/device.js');
const { FakeDriver, buttonScreen, harness, structured } = await import('./actFixFake.js');

const roots: string[] = [];
function newSession() {
  const sessions = new SessionStore();
  const root = mkdtempSync(join(tmpdir(), 'swipium-wdahang-proj-'));
  roots.push(root);
  const session = sessions.create(root);
  return { sessions, session };
}

afterAll(() => {
  for (const d of [fakeHome, ...roots]) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  fake.status = {};
  fake.ownHung = false;
  fake.sessionHangs = false;
  fake.sessionTimeouts = [];
});

describe('prepareIos: hung WDA', () => {
  it("this simulator's own WDA already hung before prepare: wdaHung + blocked ledger entry, not a visual-only pass", async () => {
    fake.ownHung = true;
    fake.status[CONFIGURED] = { reachable: false, ready: false, error: 'This operation was aborted' };
    const { sessions, session } = newSession();
    const res = await prepareIos(sessions, session, { launch: false, attachWda: 'auto' });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('visual-fallback');
    expect(res.wdaHung).toMatch(/own WDA at http:\/\/127\.0\.0\.1:8110 is listening but did not answer \/status/);
    expect(res.wda).toEqual({ reachable: false, url: OWN });
    expect(res.resultText).toMatch(/qa_wda \{ action:"stop" \}/);
    const entry = session.mutations?.find((m) => m.action === 'wda_attach');
    expect(entry?.status).toBe('blocked');
    expect(entry?.target?.webDriverAgentUrl).toBe(OWN);

    const required = await prepareIos(sessions, newSession().session, { launch: false, attachWda: 'required' });
    expect(required.ok).toBe(false);
    expect(required.failureCode).toBe('WDA_UNREACHABLE');
  });

  it('a hung WDA that answers the short re-probe is attached normally', async () => {
    fake.ownHung = true;
    fake.status[OWN] = { reachable: true, ready: true };
    const { sessions, session } = newSession();
    const res = await prepareIos(sessions, session, { launch: false, attachWda: 'auto' });
    expect(res.wdaHung).toBeUndefined();
    expect(res.mode).toBe('structured');
    expect(res.wda).toEqual({ reachable: true, url: OWN });
  });

  it('POST /session is capped at 15 s; a timeout with /status gone silent is the hung path', async () => {
    fake.status[CONFIGURED] = { reachable: true, ready: true };
    fake.sessionHangs = true;
    const { sessions, session } = newSession();
    const res = await prepareIos(sessions, session, { launch: false, attachWda: 'auto' });
    expect(fake.sessionTimeouts).toEqual([15_000]); // not WDA's 60 s default for POST /session
    expect(res.ok).toBe(true);
    expect(res.wdaHung).toMatch(/did not create a session within 15 s and stopped answering \/status/);
    expect(session.mutations?.find((m) => m.action === 'wda_attach')?.status).toBe('blocked');
  });
});

describe('lostWdaResult', () => {
  it('names the ledger WDA that no longer answers; undefined when it answers or there is none', async () => {
    const { sessions, session } = newSession();
    session.device = SIM;
    expect(await lostWdaResult(session, 'No structured UI tree')).toBeUndefined(); // never had a WDA
    sessions.recordMutation(session, {
      tool: 'qa_prepare_ios_target',
      action: 'wda_attach',
      risk: 'low',
      target: { webDriverAgentUrl: OWN, udid: SIM },
      consent: { required: false, approved: true },
      status: 'blocked',
      detail: 'hung',
    });
    const lost = await lostWdaResult(session, 'No structured UI tree');
    const s = lost!.structuredContent as Record<string, unknown>;
    expect(s.failureCode).toBe('WDA_UNREACHABLE');
    expect(String(s.what)).toContain(OWN);
    expect((s.nextSteps as string[])[0]).toContain(`qa_wda { action:"stop", device:"${SIM}" }`);
    fake.status[OWN] = { reachable: true, ready: true };
    expect(await lostWdaResult(session, 'No structured UI tree')).toBeUndefined();
  });
});

describe('runSmoke: WDA-hang path', () => {
  it('prepare said WDA hung: no launch, no dump, launch blocked WDA_UNREACHABLE, flows not judged', async () => {
    const d = new FakeDriver(buttonScreen('Home', 2));
    const { sessions, session } = newSession();
    session.appId = 'com.example.app';
    session.driver = d;
    const r = await runSmoke(sessions, session, d, { wdaUnreachable: 'WebDriverAgent at X hung', runFlows: false });
    const launch = r.baseline.launch as Record<string, unknown>;
    expect(launch.outcome).toBe('blocked');
    expect(launch.failureCode).toBe('WDA_UNREACHABLE');
    expect(launch.wdaHung).toBe(true);
    expect(d.got('dumpXml')).toHaveLength(0);
    const note = session.notes?.find((n) => n.workflow === 'launch_smoke');
    expect(note?.reason).toMatch(/^WDA_UNREACHABLE: WebDriverAgent at X hung/);
    expect(note?.category).toBe('mcp_limitation');
  });

  it("the launch's session create timed out on a WDA driver: blocked WDA_UNREACHABLE, nothing judged", async () => {
    const d = new FakeDriver(buttonScreen('Home', 2));
    Object.defineProperty(d, 'kind', { value: 'wda' });
    d.launchApp = async () => {
      throw new Error('WDA POST /session timed out after 15000ms');
    };
    const { sessions, session } = newSession();
    session.appId = 'com.example.app';
    session.driver = d;
    const r = await runSmoke(sessions, session, d, { runFlows: false });
    const launch = r.baseline.launch as Record<string, unknown>;
    expect(launch.failureCode).toBe('WDA_UNREACHABLE');
    expect(launch.wdaHung).toBe(true);
    expect(d.got('dumpXml')).toHaveLength(0);
    expect(session.notes?.find((n) => n.workflow === 'launch_smoke')?.reason).toMatch(/did not create a session within 15 s/);
  });
});

describe('qa_clear_overlay auto on a permission dialog', () => {
  it('returns needs_decision and taps nothing', async () => {
    const h = await harness('wdahang-overlay');
    try {
      const d = new FakeDriver(buttonScreen('Home', 2));
      d.foreground = 'com.google.android.permissioncontroller/.permission.ui.GrantPermissionsActivity';
      const sessionId = await h.start(d);
      const s = structured(await h.call('qa_clear_overlay', { sessionId, strategy: 'auto' }));
      expect(s.outcome).toBe('needs_decision');
      expect(d.got('tapXY')).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});

describe('small result fixes', () => {
  it('a WDA selector miss is ELEMENT_NOT_FOUND, a re-created element STALE_REF (not WDA_SESSION_FAILED)', () => {
    expect(
      classifyFlowDriverError(new Error("WdaHttpError: WDA HTTP 404: unable to find an element using 'accessibility id', value 'x'")),
    ).toBe('ELEMENT_NOT_FOUND');
    expect(
      classifyFlowDriverError(
        new Error('WDA HTTP 404: The previously found element ""Tab" TextField" is not present in the current view anymore'),
      ),
    ).toBe('STALE_REF');
  });

  it('"Don\'t Allow" closes say the permission was denied', () => {
    expect(permissionDeniedNote('Don’t Allow')).toMatch(/DENIED the permission.*privacy_reset/);
    expect(permissionDeniedNote("Don't Allow")).not.toBe('');
    expect(permissionDeniedNote('Close')).toBe('');
  });

  it('logs.since relative ages are measured from the given (device) clock', () => {
    const deviceNow = Date.UTC(2026, 9, 11, 11, 37, 0);
    expect(logcatSince('2m', deviceNow)).toBe(((deviceNow - 120_000) / 1000).toFixed(3));
  });
});
