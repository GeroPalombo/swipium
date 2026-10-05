// Protocol 2026-07-28 consent (multi round-trip requests): a consent-gated tool answers with an
// InputRequiredResult carrying the flat approve form, the client retries the call with
// inputResponses + the echoed requestState, and the retry settles into the same outcomes as the
// 2025 elicitation path (approved / CONSENT_DECLINED / CONSENT_CANCELLED / CONSENT_REFUSED /
// portable envelope / operator pre-approval). The requestState is a single-use server-side
// handle: forged, replayed or re-targeted handles are rejected with -32602 and never run the tool.
// Driven in-process through the SDK's real dual-era stdio entry (serveStdio over an in-memory
// transport) with raw JSON-RPC, so the wire shapes are the ones a 2026 client sees.

import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-p2026-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer, buildConsentPromptMessage, ELICITATION_TIMEOUT_MS, CONSENT_INPUT_KEY } = await import('../src/server.js');
const { SessionStore } = await import('../src/session/store.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
const { resolveProjectRoot } = await import('../src/context/projectRoot.js');
const { markModernServer } = await import('../src/context/protocolEra.js');
type Driver = import('../src/drivers/Driver.js').Driver;

const ELICIT = { elicitation: { form: {} } };
type Msg = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> } };

function makeFakeDriver(): Driver & { setAirplaneCalls: boolean[] } {
  const setAirplaneCalls: boolean[] = [];
  const fake = {
    kind: 'direct' as const,
    setAirplaneCalls,
    async listDevices() {
      return ['fake-device'];
    },
    useDevice() {},
    currentDevice() {
      return undefined;
    },
    async airplaneOn() {
      return false;
    },
    async setAirplane(on: boolean) {
      setAirplaneCalls.push(on);
    },
    async adbReverseMetro() {},
    async disableAnimations() {},
  };
  return fake as unknown as Driver & { setAirplaneCalls: boolean[] };
}

describe('protocol 2026-07-28 consent via InputRequiredResult', () => {
  const sessions = new SessionStore();
  let fake: ReturnType<typeof makeFakeDriver>;
  let client: InMemoryTransport;
  let handle: { close(): Promise<void> };
  let projectRoot: string;
  let sessionId: string;
  let nextId = 0;
  const waiters = new Map<number, (m: Msg) => void>();

  const request = (method: string, params: Record<string, unknown> = {}, caps: Record<string, unknown> = {}) =>
    new Promise<Msg>((resolve, reject) => {
      const id = ++nextId;
      const t = setTimeout(() => reject(new Error(`no response to ${method}`)), 10_000);
      waiters.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      void client.send({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'p2026', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': caps,
          },
        },
      });
    });
  const call = (args: Record<string, unknown>, caps: Record<string, unknown> = ELICIT, extra: Record<string, unknown> = {}) =>
    request('tools/call', { name: 'qa_network', arguments: args, ...extra }, caps);
  const answer = (args: Record<string, unknown>, requestState: unknown, response: unknown, caps: Record<string, unknown> = ELICIT) =>
    call(args, caps, { requestState, inputResponses: response === undefined ? {} : { [CONSENT_INPUT_KEY]: response } });
  const sc = (m: Msg) => (m.result?.structuredContent ?? {}) as Record<string, unknown>;
  const mutations = () => sessions.get(sessionId)!.mutations.filter((m) => m.action === 'network_change');

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-p2026-project-'));
    fake = makeFakeDriver();
    setDriverFactoryForTests(() => fake);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = clientSide;
    client.onmessage = (m) => {
      const msg = m as Msg;
      if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
    };
    await client.start();
    handle = serveStdio(({ era }) => createServer({ era, sessions }).server, { transport: serverSide });
    const discover = await request('server/discover');
    expect(discover.result?.supportedVersions).toContain('2026-07-28');
    const s = await request('tools/call', { name: 'qa_start_session', arguments: { projectRoot } });
    sessionId = sc(s).sessionId as string;
    expect(sessionId).toBeTruthy();
  });

  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    await handle.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SWIPIUM_REQUIRE_ELICITATION;
    delete process.env.SWIPIUM_CONSENT_PREAPPROVE;
  });

  it('asks out-of-band with the flat approve form, then runs once on accept + approve', async () => {
    const args = { sessionId, action: 'offline' };
    const first = await call(args);
    const r = first.result!;
    expect(r.resultType).toBe('input_required');
    expect(r.ttlMs).toBeUndefined(); // interim results carry no cache hints
    const ask = (r.inputRequests as Record<string, { method: string; params: Record<string, unknown> }>)[CONSENT_INPUT_KEY];
    expect(ask.method).toBe('elicitation/create');
    expect(ask.params.mode).toBe('form');
    expect(ask.params.requestedSchema).toEqual({
      type: 'object',
      properties: { approve: { type: 'boolean', title: 'Approve', description: 'Allow Swipium to perform this action.' } },
      required: ['approve'],
    });
    expect(ask.params.message).toBe(
      buildConsentPromptMessage({
        action: 'network_change',
        risk: 'medium',
        exactCommand: 'adb shell cmd connectivity airplane-mode enable',
        affects: { to: 'offline' },
        explain: 'Set the device offline (airplane mode ON)? Swipium will restore the original state on qa_report / session end.',
      }),
    );
    // The model-facing envelope never left the server: no consentId anywhere on the wire.
    expect(JSON.stringify(r)).not.toMatch(/consentId|requiresConsent/);
    expect(typeof r.requestState).toBe('string');
    expect(fake.setAirplaneCalls).toEqual([]);

    const done = await answer(args, r.requestState, { action: 'accept', content: { approve: true } });
    expect(done.error).toBeUndefined();
    expect(done.result?.resultType).toBe('complete');
    expect(sc(done).ok).toBe(true);
    expect(fake.setAirplaneCalls).toEqual([true]);
    expect(mutations().find((m) => m.status === 'approved')?.consent?.approvalMechanism).toBe('elicitation');
  });

  it('a replayed requestState is rejected (-32602) and never runs the tool again', async () => {
    const args = { sessionId, action: 'online' };
    const first = await call(args);
    const state = first.result!.requestState;
    const ok = await answer(args, state, { action: 'accept', content: { approve: true } });
    expect(sc(ok).ok).toBe(true);
    const calls = fake.setAirplaneCalls.length;
    const replay = await answer(args, state, { action: 'accept', content: { approve: true } });
    expect(replay.error).toMatchObject({
      code: -32602,
      message: 'Invalid or expired requestState',
      data: { reason: 'invalid_request_state' },
    });
    expect(fake.setAirplaneCalls.length).toBe(calls);
  });

  it('a forged or tampered requestState is rejected (-32602)', async () => {
    const args = { sessionId, action: 'offline' };
    const forged = await answer(args, 'swp1.' + 'A'.repeat(43), { action: 'accept', content: { approve: true } });
    expect(forged.error?.code).toBe(-32602);
    const first = await call(args);
    const state = String(first.result!.requestState);
    const tampered = state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A');
    const bad = await answer(args, tampered, { action: 'accept', content: { approve: true } });
    expect(bad.error?.code).toBe(-32602);
    const notString = await answer(args, 42, { action: 'accept', content: { approve: true } });
    expect(notString.error?.code).toBe(-32602);
    expect(fake.setAirplaneCalls.filter((c) => c).length).toBe(1); // only the approved test above ran
  });

  it('an approval cannot be re-targeted to other arguments or another session (and the handle burns)', async () => {
    const other = await request('tools/call', { name: 'qa_start_session', arguments: { projectRoot } });
    const otherSession = sc(other).sessionId as string;
    const args = { sessionId, action: 'offline' };
    const first = await call(args);
    const state = first.result!.requestState;
    const before = fake.setAirplaneCalls.length;
    const moved = await answer({ sessionId: otherSession, action: 'offline' }, state, { action: 'accept', content: { approve: true } });
    expect(moved.error?.code).toBe(-32602);
    // Single-use: the legitimate retry with the burned handle fails too, and nothing ran.
    const legit = await answer(args, state, { action: 'accept', content: { approve: true } });
    expect(legit.error?.code).toBe(-32602);
    const flipped = await call(args);
    const changed = await answer({ sessionId, action: 'online' }, flipped.result!.requestState, {
      action: 'accept',
      content: { approve: true },
    });
    expect(changed.error?.code).toBe(-32602);
    expect(fake.setAirplaneCalls.length).toBe(before);
  });

  it('accept with approve:false and decline are CONSENT_DECLINED; a fast answer is flagged likely automatic', async () => {
    const args = { sessionId, action: 'offline' };
    const before = fake.setAirplaneCalls.length;
    const a = await call(args);
    const no = await answer(args, a.result!.requestState, { action: 'accept', content: { approve: false } });
    expect(sc(no)).toMatchObject({ failureCode: 'CONSENT_DECLINED', retrySafe: false, likelyAutomatic: true });
    const b = await call(args);
    const declined = await answer(args, b.result!.requestState, { action: 'decline' });
    expect(sc(declined).failureCode).toBe('CONSENT_DECLINED');
    expect(String((sc(declined).nextSteps as string[]).join(' '))).toMatch(/SWIPIUM_CONSENT_PREAPPROVE=network_change/);
    expect(mutations().at(-1)).toMatchObject({ status: 'refused', consent: { approved: false, approvalMechanism: 'elicitation' } });
    expect(fake.setAirplaneCalls.length).toBe(before);
  });

  it('a slow human decline is not flagged and carries no pre-approve hint', async () => {
    const args = { sessionId, action: 'offline' };
    const a = await call(args);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5_000);
    const declined = await answer(args, a.result!.requestState, { action: 'decline' });
    expect(sc(declined)).toMatchObject({
      failureCode: 'CONSENT_DECLINED',
      likelyAutomatic: false,
      what: 'User declined via elicitation prompt',
    });
    expect(String((sc(declined).nextSteps as string[]).join(' '))).not.toMatch(/PREAPPROVE/);
  });

  it('cancel is a retry-safe CONSENT_CANCELLED; a re-call asks again', async () => {
    const args = { sessionId, action: 'offline' };
    const before = fake.setAirplaneCalls.length;
    const a = await call(args);
    const cancelled = await answer(args, a.result!.requestState, { action: 'cancel' });
    expect(sc(cancelled)).toMatchObject({ failureCode: 'CONSENT_CANCELLED', retrySafe: true });
    expect(sc(cancelled).requiresConsent).toBeUndefined();
    const again = await call(args);
    expect(again.result?.resultType).toBe('input_required');
    expect(fake.setAirplaneCalls.length).toBe(before);
  });

  it('an answer that arrives after the prompt timeout is CONSENT_CANCELLED (expired)', async () => {
    const args = { sessionId, action: 'offline' };
    const before = fake.setAirplaneCalls.length;
    const a = await call(args);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + ELICITATION_TIMEOUT_MS + 1_000);
    const late = await answer(args, a.result!.requestState, { action: 'accept', content: { approve: true } });
    expect(sc(late)).toMatchObject({ failureCode: 'CONSENT_CANCELLED', likelyAutomatic: false });
    expect(String(sc(late).elicitationFailure)).toMatch(/expired/);
    expect(fake.setAirplaneCalls.length).toBe(before);
  });

  it('a retry without our answer is asked again with a fresh handle (the old one is spent)', async () => {
    const args = { sessionId, action: 'offline' };
    const a = await call(args);
    const missing = await answer(args, a.result!.requestState, undefined);
    expect(missing.result?.resultType).toBe('input_required');
    const fresh = missing.result!.requestState;
    expect(fresh).not.toBe(a.result!.requestState);
    const old = await answer(args, a.result!.requestState, { action: 'accept', content: { approve: true } });
    expect(old.error?.code).toBe(-32602);
    const before = fake.setAirplaneCalls.length;
    const ok = await answer(args, fresh, { action: 'accept', content: { approve: true } });
    expect(sc(ok).ok).toBe(true);
    expect(fake.setAirplaneCalls.length).toBe(before + 1);
  });

  it('a client without form elicitation gets the portable envelope (client-assertion re-call works)', async () => {
    const args = { sessionId, action: 'online' };
    for (const caps of [{}, { elicitation: { url: {} } }]) {
      const res = await call(args, caps);
      expect(res.result?.resultType).toBe('complete');
      expect(sc(res).requiresConsent).toBe(true);
    }
    const env = await call(args, {});
    const before = fake.setAirplaneCalls.length;
    const ok = await call({ ...args, consentId: sc(env).consentId, approve: true }, {});
    expect(sc(ok).ok).toBe(true);
    expect(fake.setAirplaneCalls.length).toBe(before + 1);
    expect(
      mutations()
        .filter((m) => m.status === 'approved')
        .at(-1)?.consent?.approvalMechanism,
    ).toBe('client-assertion');
  });

  it('SWIPIUM_REQUIRE_ELICITATION=1 refuses when the request declares no form elicitation', async () => {
    process.env.SWIPIUM_REQUIRE_ELICITATION = '1';
    const res = await call({ sessionId, action: 'offline' }, {});
    expect(sc(res).failureCode).toBe('CONSENT_REFUSED');
    expect(mutations().at(-1)).toMatchObject({ status: 'refused', consent: { approvalMechanism: 'policy' } });
  });

  it('an operator pre-approved action runs without asking, before any prompt', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'network_change';
    const before = fake.setAirplaneCalls.length;
    const res = await call({ sessionId, action: 'offline' });
    expect(res.result?.resultType).toBe('complete');
    expect(sc(res).ok).toBe(true);
    expect(fake.setAirplaneCalls.length).toBe(before + 1);
    expect(
      mutations()
        .filter((m) => m.status === 'approved')
        .at(-1)?.consent?.approvalMechanism,
    ).toBe('operator-policy');
  });

  it('a requestState on a call that never asked for consent is rejected', async () => {
    const res = await request('tools/call', { name: 'qa_status', arguments: {}, requestState: 'swp1.x', inputResponses: {} });
    expect(res.error?.code).toBe(-32602);
  });
});

describe('protocol 2026-07-28 roots', () => {
  it('resolveProjectRoot never sends roots/list on a 2026 instance and falls back', async () => {
    const listRoots = vi.fn(async () => ({ roots: [{ uri: 'file:///nope' }] }));
    const fakeServer = { server: { getClientCapabilities: () => ({ roots: {} }), listRoots } };
    markModernServer(fakeServer);
    const dir = mkdtempSync(join(tmpdir(), 'swipium-p2026-root-'));
    try {
      const r = await resolveProjectRoot(fakeServer as never, undefined, { env: { SWIPIUM_PROJECT_ROOT: dir }, cwd: '/', home: '/nohome' });
      expect(listRoots).not.toHaveBeenCalled();
      expect(r).toMatchObject({ root: dir, source: 'env:SWIPIUM_PROJECT_ROOT' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
