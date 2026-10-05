// Operator pre-approval (SWIPIUM_CONSENT_PREAPPROVE, consent.ts header): headless clients answer
// elicitation automatically, so an operator can pre-approve exact action names in the server env.
// Covers parsing (exact names only, no wildcard), the decision path (approved without eliciting,
// still session-bound and single-use, wins over SWIPIUM_REQUIRE_ELICITATION), the action-name
// list staying in sync with the requireConsent call sites, the code-level tiers (runsCode needs
// SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1, wda_non_loopback never, test_this_plan sub-steps), the
// warn-level audit line, and the headless hint on CONSENT_DECLINED / CONSENT_CANCELLED (only when
// likely automatic; never for a failed elicitation) through the in-memory server.

import { describe, expect, it, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-preapprove-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
delete process.env.SWIPIUM_CONSENT_PREAPPROVE;

const {
  CONSENT_ACTIONS,
  CONSENT_ACTION_TIERS,
  actionRunsCode,
  operatorPolicyCovers,
  planRunsCodeSteps,
  preapproveHint,
  suggestConsentAction,
  parseConsentPreapproval,
  isOperatorPreapproved,
  warnIgnoredPreapprovals,
  requireConsent,
  consumeConsent,
  requestConsentDecision,
  runWithConsentScope,
  setElicitationProvider,
  approvalMechanismFor,
  peekConsent,
} = await import('../src/consent/consent.js');
const { createServer } = await import('../src/server.js');
const { DESTRUCTIVE } = await import('../src/tools/appControl.js');
const { WDA_XCODEBUILD_ACTIONS } = await import('../src/tools/wda.js');
const { buildTestThisPreflight } = await import('../src/services/preflight.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
type Driver = import('../src/drivers/Driver.js').Driver;

function mint(over: Partial<Parameters<typeof requireConsent>[0]> = {}): string {
  const res = requireConsent({ action: 'network_change', risk: 'medium', affects: { to: 'offline' }, explain: 'test', ...over });
  return (res.structuredContent as { consentId: string }).consentId;
}

const reset = () => {
  setElicitationProvider(undefined);
  delete process.env.SWIPIUM_CONSENT_PREAPPROVE;
  delete process.env.SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE;
  delete process.env.SWIPIUM_REQUIRE_ELICITATION;
};

const RUNS_CODE = [
  'build_from_source',
  'flow_mutation_run',
  'ocr_run',
  'seed_state',
  'start_metro',
  'suite_fresh_state_replay',
  'wda_build',
  'wda_start',
];

function testThisPlan(needBuild: boolean) {
  return buildTestThisPreflight({
    isAndroid: true,
    needBuild,
    buildPlatform: needBuild ? 'android' : undefined,
    buildCommand: needBuild ? './gradlew assembleDebug' : undefined,
    willBoot: true,
    bootTarget: 'Pixel_7',
    isAab: false,
    apkPath: '/p/app.apk',
  });
}

function peekReq(id: string) {
  const req = peekConsent(id);
  if (!req) throw new Error(`no pending consent ${id}`);
  return req;
}

function mintPlan(needBuild: boolean): string {
  const pf = testThisPlan(needBuild);
  return mint({ action: 'test_this_plan', risk: pf.risk, exactCommand: pf.exactCommand, affects: pf.consentAffects });
}

describe('parseConsentPreapproval: exact action names only', () => {
  it('keeps known names, ignores unknown names, wildcards and risk thresholds', () => {
    const { actions, ignored } = parseConsentPreapproval(' network_change, install_app ,,*,risk<=medium,boot_emulator');
    expect([...actions].sort()).toEqual(['install_app', 'network_change']);
    expect(ignored).toEqual(['*', 'risk<=medium', 'boot_emulator']);
  });

  it('is empty when unset', () => {
    expect(parseConsentPreapproval(undefined).actions.size).toBe(0);
    expect(isOperatorPreapproved('network_change')).toBe(false);
  });

  it('warns once on stderr for ignored names, with a near-miss suggestion and the blocked reason', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.env.SWIPIUM_CONSENT_PREAPPROVE = 'network_change,*,INSTALL-APP,build_from_source,wda_non_loopback';
      warnIgnoredPreapprovals();
      warnIgnoredPreapprovals();
      const warns = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"level":"warn"'));
      expect(warns).toHaveLength(2);
      expect(warns[0]).toContain('"*"');
      expect(warns[0]).toContain('did you mean install_app?');
      expect(warns[1]).toContain('SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1');
      expect(warns[1]).toContain('SWIPIUM_ALLOW_REMOTE_WDA');
    } finally {
      spy.mockRestore();
      reset();
    }
  });

  it('suggests case-insensitive near misses only', () => {
    expect(suggestConsentAction('Install_App')).toBe('install_app');
    expect(suggestConsentAction('instal_app')).toBe('install_app');
    expect(suggestConsentAction('*')).toBeUndefined();
    expect(suggestConsentAction('boot_emulator')).toBeUndefined();
  });

  it('runsCode actions need SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1', () => {
    expect(RUNS_CODE.filter((a) => actionRunsCode(a))).toEqual(RUNS_CODE);
    expect(CONSENT_ACTIONS.filter((a) => CONSENT_ACTION_TIERS[a].runsCode).sort()).toEqual(RUNS_CODE);
    const all = RUNS_CODE.join(',');
    const off = parseConsentPreapproval(`${all},install_app`);
    expect([...off.actions]).toEqual(['install_app']);
    expect(off.blocked.map((b) => b.name).sort()).toEqual(RUNS_CODE);
    expect(off.ignored).toEqual([]);
    expect(parseConsentPreapproval(all, 'true').actions.size).toBe(0); // exactly "1"
    expect([...parseConsentPreapproval(all, '1').actions].sort()).toEqual(RUNS_CODE);
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'build_from_source';
    expect(isOperatorPreapproved('build_from_source')).toBe(false);
    process.env.SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE = '1';
    expect(isOperatorPreapproved('build_from_source')).toBe(true);
    reset();
  });

  it('wda_non_loopback is never pre-approvable, even with the run-code opt-in', () => {
    const p = parseConsentPreapproval('wda_non_loopback', '1');
    expect(p.actions.size).toBe(0);
    expect(p.blocked[0].reason).toContain('SWIPIUM_ALLOW_REMOTE_WDA');
    expect(preapproveHint('wda_non_loopback')).toContain('SWIPIUM_ALLOW_REMOTE_WDA');
    expect(preapproveHint('wda_non_loopback')).not.toContain('SWIPIUM_CONSENT_PREAPPROVE=');
  });

  it('CONSENT_ACTIONS matches the action names minted by requireConsent call sites', () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const found = new Set<string>();
    for (const f of walk(join(import.meta.dirname, '..', 'src')).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:requireConsent|consumeConsent)\(/g)) {
        const a = src.slice(m.index, m.index + 600).match(/action:\s*'([a-z_]+)'/);
        if (a) found.add(a[1]);
      }
    }
    // Template names: qa_app_control (`app_${action}`) and qa_wda (`wda_${action}`), derived
    // from the source lists so a new destructive / xcodebuild action cannot drift.
    for (const a of DESTRUCTIVE) found.add(`app_${a}`);
    for (const a of WDA_XCODEBUILD_ACTIONS) found.add(`wda_${a}`);
    expect([...found].sort()).toEqual([...CONSENT_ACTIONS].sort());
  });
});

describe('requestConsentDecision with operator pre-approval', () => {
  afterEach(reset);

  it('approves a listed action without eliciting, ledgered as operator-policy, single-use', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'network_change';
    const provider = vi.fn(async () => 'declined' as const);
    setElicitationProvider(provider);
    const id = mint();
    expect(await requestConsentDecision(id)).toEqual({ mechanism: 'operator-policy', approved: true });
    expect(provider).not.toHaveBeenCalled();
    const out = consumeConsent(id, true, { action: 'network_change', affects: { to: 'offline' } });
    expect(out).toMatchObject({ approved: true, mechanism: 'operator-policy' });
    expect(approvalMechanismFor(id)).toBe('operator-policy');
    expect(consumeConsent(id, true).approved).toBe(false); // single-use
  });

  it('stays session-bound', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'network_change';
    const id = runWithConsentScope('session-a', () => mint());
    await requestConsentDecision(id);
    const other = runWithConsentScope('session-b', () => consumeConsent(id, true));
    expect(other.approved).toBe(false);
    expect(other.reason).toMatch(/different session/);
    expect(runWithConsentScope('session-a', () => consumeConsent(id, true)).mechanism).toBe('operator-policy');
  });

  it('does not cover actions that are not listed', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'install_app';
    setElicitationProvider(async () => 'declined');
    const id = mint();
    expect(await requestConsentDecision(id)).toMatchObject({ mechanism: 'elicitation', approved: false, outcome: 'declined' });
  });

  it('logs each operator-policy approval at warn with the action and exact command', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'network_change';
    process.env.SWIPIUM_LOG_LEVEL = 'warn';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await requestConsentDecision(mint({ exactCommand: 'adb shell svc wifi disable' }));
      await requestConsentDecision(mint({ exactCommand: 'x'.repeat(500) }));
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('operator policy'));
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ level: 'warn', action: 'network_change', exactCommand: 'adb shell svc wifi disable' });
      const long = JSON.parse(lines[1]);
      expect(long.exactCommandHead).toHaveLength(200);
      expect(long.exactCommandSha256).toMatch(/^[0-9a-f]{16}$/);
      expect(long.exactCommand).toBeUndefined();
    } finally {
      spy.mockRestore();
      delete process.env.SWIPIUM_LOG_LEVEL;
    }
  });

  it('a listed runsCode action without the opt-in falls through to the prompt', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'seed_state';
    const provider = vi.fn(async () => 'declined' as const);
    setElicitationProvider(provider);
    const id = mint({ action: 'seed_state', affects: { fixture: 'f', type: 'script' } });
    expect(await requestConsentDecision(id)).toMatchObject({ mechanism: 'elicitation', approved: false });
    expect(provider).toHaveBeenCalledOnce();
  });

  it('test_this_plan without a build step is covered by its own name', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'test_this_plan';
    const id = mintPlan(false);
    expect(planRunsCodeSteps(peekReq(id))).toEqual([]);
    expect(await requestConsentDecision(id)).toEqual({ mechanism: 'operator-policy', approved: true });
  });

  it('test_this_plan with a build step needs build_from_source pre-approvable too', async () => {
    const provider = vi.fn(async () => 'declined' as const);
    setElicitationProvider(provider);
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'test_this_plan';
    const id = mintPlan(true);
    expect(planRunsCodeSteps(peekReq(id))).toEqual(['build_from_source']);
    expect(operatorPolicyCovers(peekReq(id))).toMatchObject({ approved: false, reason: expect.stringContaining('build_from_source') });
    expect(await requestConsentDecision(id)).toMatchObject({ mechanism: 'elicitation', approved: false });
    // Listed but no run-code opt-in: still not covered.
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'test_this_plan,build_from_source';
    expect(operatorPolicyCovers(peekReq(mintPlan(true))).approved).toBe(false);
    // Opt-in alone (build_from_source not listed): still not covered.
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'test_this_plan';
    process.env.SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE = '1';
    expect(operatorPolicyCovers(peekReq(mintPlan(true))).approved).toBe(false);
    // Both: covered.
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'test_this_plan,build_from_source';
    expect(await requestConsentDecision(mintPlan(true))).toEqual({ mechanism: 'operator-policy', approved: true });
    expect(provider).toHaveBeenCalledOnce();
  });

  it('test_this_plan step detection fails closed on a malformed affects payload', () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'test_this_plan';
    const req = {
      action: 'test_this_plan',
      risk: 'high' as const,
      explain: 'x',
      exactCommand: '• build_from_source: npm run build',
      affects: {},
    };
    expect(planRunsCodeSteps(req)).toEqual(['build_from_source']);
    expect(operatorPolicyCovers(req).approved).toBe(false);
    expect(preapproveHint('test_this_plan', req)).toContain('SWIPIUM_CONSENT_PREAPPROVE=test_this_plan,build_from_source');
    expect(preapproveHint('test_this_plan', req)).toContain('SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1');
  });

  it('carries the elicitation failure when the prompt errored instead of being answered', async () => {
    setElicitationProvider(async () => {
      throw new Error('Request timed out');
    });
    const d = await requestConsentDecision(mint());
    expect(d).toMatchObject({ mechanism: 'elicitation', approved: false, outcome: 'cancelled', failure: 'Request timed out' });
  });

  it('wins over SWIPIUM_REQUIRE_ELICITATION=1 (explicit operator decision)', async () => {
    process.env.SWIPIUM_REQUIRE_ELICITATION = '1';
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'network_change';
    setElicitationProvider(async () => 'unavailable');
    expect(await requestConsentDecision(mint())).toEqual({ mechanism: 'operator-policy', approved: true });
    delete process.env.SWIPIUM_CONSENT_PREAPPROVE;
    expect((await requestConsentDecision(mint())).mechanism).toBe('refused');
  });
});

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

describe('headless client through the in-memory server (qa_network)', () => {
  let client: Client;
  let sessions: import('../src/session/store.js').SessionStore;
  let fake: ReturnType<typeof makeFakeDriver>;
  let sessionId: string;
  let projectRoot: string;
  // Headless clients answer instantly: codex exec declines, claude -p cancels.
  let nextAnswer: { action: 'accept' | 'decline' | 'cancel' };
  let answerDelayMs = 0;
  let answerThrows = false;
  let elicited = 0;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-preapprove-project-'));
    fake = makeFakeDriver();
    setDriverFactoryForTests(() => fake);
    const ctx = createServer();
    sessions = ctx.sessions;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'headless', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async () => {
      elicited++;
      if (answerThrows) throw new Error('client transport exploded');
      if (answerDelayMs) await new Promise((r) => setTimeout(r, answerDelayMs));
      return nextAnswer;
    });
    await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
    const res = (await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult;
    sessionId = (res.structuredContent as { sessionId: string }).sessionId;
  });

  afterEach(() => {
    delete process.env.SWIPIUM_CONSENT_PREAPPROVE;
    answerDelayMs = 0;
    answerThrows = false;
  });

  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    setElicitationProvider(undefined);
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('an instant decline carries the action, likelyAutomatic and the pre-approve hint', async () => {
    nextAnswer = { action: 'decline' };
    const res = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'offline' } })) as CallToolResult;
    const s = res.structuredContent as Record<string, unknown>;
    expect(s.failureCode).toBe('CONSENT_DECLINED');
    expect(s).toMatchObject({ action: 'network_change', likelyAutomatic: true, retrySafe: false });
    expect((s.nextSteps as string[]).join(' ')).toContain('SWIPIUM_CONSENT_PREAPPROVE=network_change');
    expect(fake.setAirplaneCalls).toEqual([]);
  });

  it('an instant cancel stays retry-safe but says not to loop and carries the hint', async () => {
    nextAnswer = { action: 'cancel' };
    const res = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'offline' } })) as CallToolResult;
    const s = res.structuredContent as Record<string, unknown>;
    expect(s).toMatchObject({ failureCode: 'CONSENT_CANCELLED', retrySafe: true, action: 'network_change', likelyAutomatic: true });
    const steps = (s.nextSteps as string[]).join(' ');
    expect(steps).toMatch(/do not re-call in a loop/);
    expect(steps).toContain('SWIPIUM_CONSENT_PREAPPROVE=network_change');
  });

  it('a slow (human) decline is not flagged automatic and carries no pre-approve hint', async () => {
    nextAnswer = { action: 'decline' };
    answerDelayMs = 1600;
    const res = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'offline' } })) as CallToolResult;
    const s = res.structuredContent as Record<string, unknown>;
    expect(s).toMatchObject({ failureCode: 'CONSENT_DECLINED', likelyAutomatic: false });
    expect(JSON.stringify(s)).not.toContain('SWIPIUM_CONSENT_PREAPPROVE');
    expect(fake.setAirplaneCalls).toEqual([]);
  });

  it('a failed elicitation is not "answered too fast": likelyAutomatic false, ledgered as transport/abort', async () => {
    answerThrows = true;
    const res = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'offline' } })) as CallToolResult;
    const s = res.structuredContent as Record<string, unknown>;
    expect(s).toMatchObject({ failureCode: 'CONSENT_CANCELLED', retrySafe: true, likelyAutomatic: false });
    expect(typeof s.elicitationFailure).toBe('string');
    const steps = (s.nextSteps as string[]).join(' ');
    expect(steps).not.toMatch(/too fast/);
    expect(steps).not.toContain('SWIPIUM_CONSENT_PREAPPROVE');
    const refused = sessions
      .get(sessionId)!
      .mutations.filter((m) => m.action === 'network_change' && m.status === 'refused')
      .at(-1);
    expect(refused?.detail).toMatch(/^transport\/abort/);
    expect(fake.setAirplaneCalls).toEqual([]);
  });

  it('a pre-approved action runs without eliciting and is ledgered as operator-policy', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'network_change';
    nextAnswer = { action: 'decline' };
    const before = elicited;
    const res = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'offline' } })) as CallToolResult;
    const s = res.structuredContent as Record<string, unknown>;
    expect(res.isError).toBeFalsy();
    expect(s.requiresConsent).toBeUndefined();
    expect(elicited).toBe(before);
    expect(fake.setAirplaneCalls).toEqual([true]);
    const approved = sessions.get(sessionId)!.mutations.find((m) => m.action === 'network_change' && m.status === 'approved');
    expect(approved?.consent?.approvalMechanism).toBe('operator-policy');
  });

  it('a bogus consentId for a listed action is not honoured; a fresh challenge is minted and pre-approved', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'network_change';
    const res = (await client.callTool({
      name: 'qa_network',
      arguments: { sessionId, action: 'online', consentId: 'deadbeef', approve: true },
    })) as CallToolResult;
    // The bogus id is rejected; the tool mints a fresh challenge which the operator policy then approves.
    expect(res.isError).toBeFalsy();
    expect(fake.setAirplaneCalls).toEqual([true, false]);
  });
});
