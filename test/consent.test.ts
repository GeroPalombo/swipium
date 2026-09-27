// Consent state machine + elicitation-aware approval mechanism (DESIGN §10.2, consent.ts header):
// unit coverage of consumeConsent (single-use, action/affects binding) and requestConsentDecision
// (elicitation approved/declined/unavailable, SWIPIUM_REQUIRE_ELICITATION=1 refusal), plus an
// integration pass driving a real consent-gated tool (qa_network) through the in-memory MCP
// server with a client that answers `elicitation/create` — asserting the mutation ledger records
// approvalMechanism 'elicitation' with zero per-tool changes.

import { describe, expect, it, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Hermetic on-disk state (coreHappyPath pattern): SessionStore persists under ~/.swipium,
// so point HOME at a temp dir BEFORE any src module is loaded (dynamic imports below).
const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-consent-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const {
  requireConsent,
  consumeConsent,
  requestConsentDecision,
  setElicitationProvider,
  approvalMechanismFor,
  pendingConsentCount,
  CONSENT_PENDING_CAP,
  CONSENT_TTL_MS,
} = await import('../src/consent/consent.js');
const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
type Driver = import('../src/drivers/Driver.js').Driver;

/** Mint a pending consent and return its consentId. */
function mint(over: Partial<Parameters<typeof requireConsent>[0]> = {}): string {
  const res = requireConsent({ action: 'network_change', risk: 'medium', affects: { to: 'offline' }, explain: 'test', ...over });
  const sc = res.structuredContent as { requiresConsent: boolean; consentId: string };
  expect(sc.requiresConsent).toBe(true);
  return sc.consentId;
}

// Scoped to the unit suites — the integration suite below relies on the provider that
// createServer() installs (module-global), which a file-level afterEach would clobber.
const resetProviderAndEnv = () => {
  setElicitationProvider(undefined);
  delete process.env.SWIPIUM_REQUIRE_ELICITATION;
};

describe('consumeConsent: single-use, action/affects binding', () => {
  afterEach(resetProviderAndEnv);

  it('rejects a missing or unknown consentId', () => {
    expect(consumeConsent(undefined, true).approved).toBe(false);
    expect(consumeConsent('nope1234', true).approved).toBe(false);
  });

  it('approves a matching re-call exactly once (single-use)', () => {
    const id = mint();
    const first = consumeConsent(id, true, { action: 'network_change', affects: { to: 'offline' } });
    expect(first.approved).toBe(true);
    const second = consumeConsent(id, true, { action: 'network_change', affects: { to: 'offline' } });
    expect(second.approved).toBe(false);
    expect(second.reason).toMatch(/unknown or already-used/);
  });

  it('binds to the exact action WITHOUT burning the id on a mismatch', () => {
    const id = mint();
    const wrongAction = consumeConsent(id, true, { action: 'write_path' });
    expect(wrongAction.approved).toBe(false);
    expect(wrongAction.reason).toMatch(/consent is for "network_change"/);
    const wrongAffects = consumeConsent(id, true, { action: 'network_change', affects: { to: 'online' } });
    expect(wrongAffects.approved).toBe(false);
    expect(wrongAffects.reason).toMatch(/does not match the affected target/);
    // Still valid for its real use — mismatches must not silently burn the challenge.
    expect(consumeConsent(id, true, { action: 'network_change', affects: { to: 'offline' } }).approved).toBe(true);
  });

  it('approve=false consumes the id and stays unapproved', () => {
    const id = mint();
    expect(consumeConsent(id, false).approved).toBe(false);
    expect(consumeConsent(id, true).approved).toBe(false); // burned
  });

  it('tags mechanism client-assertion by default and records it for the ledger', () => {
    const id = mint();
    const out = consumeConsent(id, true);
    expect(out.approved).toBe(true);
    expect(out.mechanism).toBe('client-assertion');
    expect(approvalMechanismFor(id)).toBe('client-assertion');
  });
});

describe('requestConsentDecision: mechanism tagging via elicitation provider', () => {
  afterEach(resetProviderAndEnv);

  it('approved provider → mechanism elicitation, and consumeConsent tags it', async () => {
    setElicitationProvider(async () => 'approved');
    const id = mint();
    const decision = await requestConsentDecision(id);
    expect(decision).toEqual({ mechanism: 'elicitation', approved: true });
    const out = consumeConsent(id, true, { action: 'network_change' });
    expect(out.approved).toBe(true);
    expect(out.mechanism).toBe('elicitation');
    expect(approvalMechanismFor(id)).toBe('elicitation');
  });

  it('declined provider → burns the challenge so the client cannot self-approve it', async () => {
    setElicitationProvider(async () => 'declined');
    const id = mint();
    const decision = await requestConsentDecision(id);
    expect(decision).toMatchObject({ mechanism: 'elicitation', approved: false, outcome: 'declined' });
    expect(consumeConsent(id, true).approved).toBe(false); // burned
  });

  // B4: a dismissed (MCP `cancel`) prompt is a refusal, NOT a fallback to model self-approval.
  it('cancelled provider → refusal (outcome cancelled), burned — no approve:true afterwards', async () => {
    setElicitationProvider(async () => 'cancelled');
    const id = mint();
    const decision = await requestConsentDecision(id);
    expect(decision).toMatchObject({ mechanism: 'elicitation', approved: false, outcome: 'cancelled' });
    const recall = consumeConsent(id, true, { action: 'network_change', affects: { to: 'offline' } });
    expect(recall.approved).toBe(false);
    expect(recall.reason).toMatch(/unknown or already-used/);
  });

  it('a provider that throws (timeout / transport error after sending) → cancelled refusal, burned', async () => {
    setElicitationProvider(async () => {
      throw new Error('Request timed out');
    });
    const id = mint();
    const decision = await requestConsentDecision(id);
    expect(decision.mechanism).toBe('elicitation');
    if (decision.mechanism === 'elicitation' && !decision.approved) {
      expect(decision.outcome).toBe('cancelled');
      expect(decision.reason).toMatch(/timed out/);
    }
    expect(consumeConsent(id, true).approved).toBe(false);
  });

  it('forwards the tool call abort signal to the provider', async () => {
    let seen: AbortSignal | undefined;
    setElicitationProvider(async (_req, ctx) => {
      seen = ctx?.signal;
      return 'approved';
    });
    const ac = new AbortController();
    const id = mint();
    await requestConsentDecision(id, { signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });

  it('a client re-call cannot approve a challenge while its prompt is outstanding', async () => {
    let release: (a: 'approved') => void = () => {};
    setElicitationProvider(() => new Promise((r) => (release = r)));
    const id = mint();
    const decision = requestConsentDecision(id);
    // The model races the dialog with approve:true — refused, and the challenge is burned.
    const race = consumeConsent(id, true, { action: 'network_change', affects: { to: 'offline' } });
    expect(race.approved).toBe(false);
    expect(race.reason).toMatch(/awaiting the out-of-band user prompt/);
    release('approved');
    await decision;
    expect(consumeConsent(id, true).approved).toBe(false);
  });

  it('unavailable provider → portable client-assertion fallback (envelope path)', async () => {
    setElicitationProvider(async () => 'unavailable');
    const id = mint();
    expect(await requestConsentDecision(id)).toEqual({ mechanism: 'client-assertion' });
    const out = consumeConsent(id, true, { action: 'network_change' });
    expect(out.approved).toBe(true);
    expect(out.mechanism).toBe('client-assertion');
  });

  it('no provider installed → client-assertion (portable default)', async () => {
    const id = mint();
    expect(await requestConsentDecision(id)).toEqual({ mechanism: 'client-assertion' });
  });

  it('SWIPIUM_REQUIRE_ELICITATION=1: high-risk + unavailable → refused and burned', async () => {
    process.env.SWIPIUM_REQUIRE_ELICITATION = '1';
    setElicitationProvider(async () => 'unavailable');
    const id = mint({ action: 'run_on_prod', risk: 'high' });
    const decision = await requestConsentDecision(id);
    expect(decision.mechanism).toBe('refused');
    if (decision.mechanism === 'refused') expect(decision.reason).toMatch(/SWIPIUM_REQUIRE_ELICITATION/);
    expect(consumeConsent(id, true).approved).toBe(false); // burned — no self-approval afterwards
  });

  // H10: the strict mode covers EVERY consent-gated action (builds, Metro, installs…), not only high.
  it.each(['low', 'medium'] as const)('SWIPIUM_REQUIRE_ELICITATION=1: %s risk + unavailable → refused too', async (risk) => {
    process.env.SWIPIUM_REQUIRE_ELICITATION = '1';
    setElicitationProvider(async () => 'unavailable');
    const id = mint({ action: 'start_metro', risk });
    const decision = await requestConsentDecision(id);
    expect(decision.mechanism).toBe('refused');
    expect(consumeConsent(id, true).approved).toBe(false);
  });

  it('without SWIPIUM_REQUIRE_ELICITATION, unavailable still falls back for any risk', async () => {
    setElicitationProvider(async () => 'unavailable');
    const id = mint({ risk: 'high' });
    expect(await requestConsentDecision(id)).toEqual({ mechanism: 'client-assertion' });
  });
});

describe('pending-challenge bounds (TTL + size cap)', () => {
  afterEach(() => {
    resetProviderAndEnv();
    vi.restoreAllMocks();
  });

  it('caps the pending map, evicting the oldest challenge first', () => {
    const first = mint();
    for (let i = 0; i < CONSENT_PENDING_CAP + 20; i++) mint();
    expect(pendingConsentCount()).toBeLessThanOrEqual(CONSENT_PENDING_CAP + 1);
    expect(consumeConsent(first, true).approved).toBe(false); // evicted
  });

  it('expires a challenge after CONSENT_TTL_MS', () => {
    const id = mint();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + CONSENT_TTL_MS + 1);
    const out = consumeConsent(id, true, { action: 'network_change', affects: { to: 'offline' } });
    expect(out.approved).toBe(false);
    expect(out.reason).toMatch(/expired/);
  });
});

/** Minimal fake driver: just enough for qa_start_session + qa_network (offline/online). */
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

describe('elicitation-aware consent through the in-memory server (qa_network)', () => {
  let client: Client;
  let sessions: import('../src/session/store.js').SessionStore;
  let fake: ReturnType<typeof makeFakeDriver>;
  let sessionId: string;
  let projectRoot: string;
  // The next answer the fake HUMAN gives to an elicitation/create request.
  let nextAnswer: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, boolean> };
  const elicited: string[] = [];

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-consent-project-'));
    fake = makeFakeDriver();
    setDriverFactoryForTests(() => fake);

    const ctx = createServer();
    sessions = ctx.sessions;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // `elicitation: { form: {} }` — the SDK's server-side elicitInput gate requires the
    // form sub-capability before it will send a form-mode elicitation/create request.
    client = new Client({ name: 'consent-test', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicited.push(req.params.message);
      return nextAnswer;
    });
    await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);

    const res = (await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult;
    sessionId = (res.structuredContent as { sessionId: string }).sessionId;
  });

  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    setElicitationProvider(undefined);
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('routes the consent out-of-band, re-invokes once, and ledgers mechanism elicitation', async () => {
    nextAnswer = { action: 'accept', content: { approve: true } };
    const res = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'offline' } })) as CallToolResult;
    const s = res.structuredContent as Record<string, unknown>;
    // The model never saw a requiresConsent envelope — the action ran after the human approved.
    expect(res.isError).toBeFalsy();
    expect(s.requiresConsent).toBeUndefined();
    expect(s.ok).toBe(true);
    expect(fake.setAirplaneCalls).toEqual([true]);
    expect(elicited.length).toBe(1);
    expect(elicited[0]).toMatch(/network_change/);
    // The mutation ledger records HOW the action was approved.
    const session = sessions.get(sessionId)!;
    const approved = session.mutations.find((m) => m.action === 'network_change' && m.status === 'approved');
    expect(approved?.consent?.approvalMechanism).toBe('elicitation');
  });

  it('a cancelled elicitation is a retry-safe refusal, ledgered, and never runs the action (B4)', async () => {
    nextAnswer = { action: 'cancel' };
    const res = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'online' } })) as CallToolResult;
    const s = res.structuredContent as Record<string, unknown>;
    expect(res.isError).toBe(true);
    expect(s.failureCode).toBe('CONSENT_CANCELLED');
    expect(s.retrySafe).toBe(true);
    expect(s.requiresConsent).toBeUndefined(); // the model never gets a self-approvable envelope
    expect(fake.setAirplaneCalls).toEqual([true]);
    const refused = sessions.get(sessionId)!.mutations.filter((m) => m.action === 'network_change' && m.status === 'refused');
    expect(refused.at(-1)?.consent).toMatchObject({ required: true, approved: false, approvalMechanism: 'elicitation' });
    // Re-calling the tool issues a FRESH prompt (and this time the human approves).
    const before = elicited.length;
    nextAnswer = { action: 'accept', content: { approve: true } };
    const again = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'online' } })) as CallToolResult;
    expect(again.isError).toBeFalsy();
    expect(elicited.length).toBe(before + 1);
    expect(fake.setAirplaneCalls).toEqual([true, false]);
  });

  it('a declined elicitation returns an error, ledgers a refusal, and never runs the action', async () => {
    nextAnswer = { action: 'decline' };
    const res = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'offline' } })) as CallToolResult;
    const s = res.structuredContent as Record<string, unknown>;
    expect(res.isError).toBe(true);
    expect(s.failureCode).toBe('CONSENT_DECLINED');
    expect(s.changedState).toBe(false);
    expect(fake.setAirplaneCalls).toEqual([true, false]); // unchanged — the flip never ran
    const last = sessions.get(sessionId)!.mutations.at(-1);
    expect(last).toMatchObject({ action: 'network_change', status: 'refused' });
  });
});
