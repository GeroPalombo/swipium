// Standalone qa_smoke after a prepare that found this simulator's WDA hung (a blocked wda_attach
// from qa_prepare_ios_target) gives the same WDA_UNREACHABLE verdict as qa_test_this, never a
// visual-only launch pass. A later working WDA record, a WDA that answers again, or a qa_wda attach
// failure do not trigger it. Hermetic: /status is faked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const SIM = '6C1E1C1A-1B2C-4D3E-8F90-0123456789AB';
const HUNG = 'http://127.0.0.1:8110';
const fake = vi.hoisted(() => ({ answers: new Set<string>() }));
vi.mock('../src/lib/wda.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/wda.js')>()),
  checkWda: async (url: string) =>
    fake.answers.has(url) ? { reachable: true, ready: true } : { reachable: false, ready: false, error: 'This operation was aborted' },
}));

const { hungWdaAtPrepare } = await import('../src/tools/smoke.js');
const { FakeDriver, buttonScreen, harness, structured } = await import('./actFixFake.js');
type Session = import('../src/session/store.js').Session;

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('smoke-hung-wda');
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => fake.answers.clear());

const record = (s: Session, tool: string, action: string, status: 'blocked' | 'executed', url = HUNG) =>
  h.sessions.recordMutation(s, {
    tool,
    action,
    risk: 'low',
    target: { webDriverAgentUrl: url, udid: SIM },
    consent: { required: false, approved: true },
    status,
    detail:
      status === 'blocked' ? `this simulator's own WDA at ${url} is listening but did not answer /status within 1.5 s (hung)` : undefined,
  });

describe('hungWdaAtPrepare', () => {
  it("names prepare's hang, and stops naming it once a WDA works or answers again", async () => {
    const s = h.sessions.get(await h.start(new FakeDriver(buttonScreen('A', 1))))!;
    s.device = SIM;
    expect(await hungWdaAtPrepare(s)).toBeUndefined();
    record(s, 'qa_prepare_ios_target', 'wda_attach', 'blocked');
    expect(await hungWdaAtPrepare(s)).toMatch(/hung/);
    fake.answers.add(HUNG);
    expect(await hungWdaAtPrepare(s)).toBeUndefined();
    fake.answers.clear();
    record(s, 'qa_wda', 'wda_start', 'executed', 'http://127.0.0.1:8111');
    expect(await hungWdaAtPrepare(s)).toBeUndefined();
  });

  it('a qa_wda attach failure is not a prepare hang', async () => {
    const s = h.sessions.get(await h.start(new FakeDriver(buttonScreen('A', 1))))!;
    s.device = SIM;
    record(s, 'qa_wda', 'wda_attach', 'blocked');
    expect(await hungWdaAtPrepare(s)).toBeUndefined();
  });
});

describe('qa_smoke after a hung-WDA prepare', () => {
  it('is WDA_UNREACHABLE, not a visual-only launch pass', async () => {
    const d = new FakeDriver(buttonScreen('Home', 2));
    const sessionId = await h.start(d);
    const s = h.sessions.get(sessionId)!;
    s.device = SIM;
    s.appId = 'com.example.app';
    record(s, 'qa_prepare_ios_target', 'wda_attach', 'blocked');
    const r = structured(await h.call('qa_smoke', { sessionId, runFlows: false }));
    const launch = r.baseline as Record<string, unknown>;
    expect(launch.outcome).toBe('blocked');
    expect(launch.failureCode).toBe('WDA_UNREACHABLE');
    expect(d.got('launchApp')).toHaveLength(0);
  }, 20_000);
});
