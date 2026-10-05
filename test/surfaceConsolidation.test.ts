// 1.6.0 surface consolidation: behavior that moved into surviving tools must keep working there.
//  - qa_status without sessionId = first-call orientation (was qa_agent_brief + qa_capabilities);
//    with sessionId + goal = goal-biased nextBestAction (was qa_next_best_action).
//  - qa_resolve_target include:["context","plan"] (was qa_detect_context + qa_plan), iOS-aware.
//  - qa_job_status waitMs long-poll (was qa_wait for:"job_done").
//  - qa_wda `device` (canonical) with `udid` as a deprecated alias.
//  - qa_ios no longer accepts wda_* / screenshot actions; qa_wait no longer accepts job_done.
// Hermetic: HOME is a temp dir, device discovery is disabled, adb/simctl are mocked.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-consolidation-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const sims = [
  { udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' },
  { udid: '11111111-2222-3333-4444-555555555555', name: 'iPad Air', state: 'Shutdown', runtime: 'iOS 18.0' },
];
vi.mock('../src/lib/simctl.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/simctl.js')>()),
  simctlAvailable: vi.fn(async () => true),
  listSimulators: vi.fn(async () => sims),
}));
vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  which: vi.fn(async () => false),
  firstLine: vi.fn(async () => null),
  adbDevices: vi.fn(async () => []),
  listAvds: vi.fn(async () => []),
  findAapt2: vi.fn(() => null),
}));

const { createServer } = await import('../src/server.js');
const { CAPABILITY_GROUPS } = await import('../src/core/capabilityGroups.js');
const { TOOL_COUNT } = await import('../src/version.js');
type SessionStore = import('../src/session/store.js').SessionStore;

const realPlatform = process.platform;
const projectRoot = mkdtempSync(join(tmpdir(), 'swipium-consolidation-project-'));
let client: Client;
let sessions: SessionStore;

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
const sc = (r: CallToolResult) => (r.structuredContent ?? {}) as Record<string, unknown>;

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '1', 'react-native': '1' } }));
  const ctx = createServer();
  sessions = ctx.sessions;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'consolidation-test', version: '0' });
  await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  await client.close();
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('qa_status', () => {
  it('without sessionId returns first-call orientation + capability groups (no session needed)', async () => {
    const r = await call('qa_status', {});
    expect(r.isError).toBeFalsy();
    const o = sc(r);
    expect(o.orientation).toBe(true);
    expect(o.tools).toBe(TOOL_COUNT);
    expect(o.firstCall).toMatchObject({ tool: 'qa_test_this', args: { mode: 'execute' } });
    expect(o.polling).toMatchObject({ tool: 'qa_job_status' });
    const groups = o.capabilityGroups as Array<{ group: string; tools: string[] }>;
    expect(groups.map((g) => g.group)).toEqual(CAPABILITY_GROUPS.map((g) => g.group));
    expect(groups.flatMap((g) => g.tools)).toHaveLength(TOOL_COUNT);
    expect(o.nextBestAction).toMatchObject({ tool: 'qa_test_this' });
  });

  it('goal biases nextBestAction — with and without a session', async () => {
    const orient = sc(await call('qa_status', { goal: 'release_gate' }));
    expect(orient.nextBestAction).toMatchObject({ tool: 'qa_test_this', args: { mode: 'execute', goal: 'release_gate' } });

    const s = sessions.create(projectRoot, undefined, {});
    const plain = sc(await call('qa_status', { sessionId: s.id }));
    expect(plain.sessionId).toBe(s.id);
    expect(plain.nextBestAction).toMatchObject({ tool: 'qa_test_this', args: { sessionId: s.id, mode: 'execute' } });
    expect((plain.nextBestAction as { args: Record<string, unknown> }).args.goal).toBeUndefined();

    const withGoal = sc(await call('qa_status', { sessionId: s.id, goal: 'explore' }));
    expect(withGoal.nextBestAction).toMatchObject({ tool: 'qa_test_this', args: { goal: 'explore' } });
  });

  it('reports a WDA-less simulator session as visual-only (not the stored "structured" default)', async () => {
    const { SimctlDriver } = await import('../src/drivers/SimctlDriver.js');
    const udid = '190EA878-5D54-416C-B858-E60588B0DAF9';
    const s = sessions.create(projectRoot, undefined, {});
    s.driver = new SimctlDriver(udid);
    s.device = udid;
    expect(s.mode).toBe('structured');
    const r = await call('qa_status', { sessionId: s.id });
    expect(sc(r).mode).toBe('visual-only');
    const text = (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).toContain('(mode=visual-only)');
    expect(text).not.toContain('mode=structured');
  });

  it('an unknown sessionId is a typed error pointing at orientation', async () => {
    const r = await call('qa_status', { sessionId: 'nope' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(sc(r).nextSteps)).toContain('qa_status without sessionId');
  });
});

describe('qa_resolve_target include', () => {
  it('omits context/plan by default', async () => {
    const r = sc(await call('qa_resolve_target', { projectRoot, platform: 'ios' }));
    expect(r.selected).toBeTruthy();
    expect(r.context).toBeUndefined();
    expect(r.plan).toBeUndefined();
  });

  it('include:["context","plan"] returns iOS-aware context and a READY/BLOCKED/UNSAFE plan', async () => {
    const r = await call('qa_resolve_target', { projectRoot, platform: 'ios', include: ['context', 'plan'] });
    expect(r.isError).toBeFalsy();
    const out = sc(r);
    const ctx = out.context as { framework: string; devices: { iosBooted: Array<{ name: string }>; iosAvailable: unknown[] } };
    expect(ctx.framework).toBe('expo');
    expect(ctx.devices.iosBooted.map((d) => d.name)).toEqual(['iPhone 16']);
    expect(ctx.devices.iosAvailable).toHaveLength(1);
    const plan = out.plan as {
      framework: string;
      ready: unknown[];
      blocked: Array<{ category: string }>;
      unsafe: Array<{ reason: string }>;
    };
    expect(plan.framework).toBe('expo');
    expect(Array.isArray(plan.ready)).toBe(true);
    // A booted simulator counts as a device — nothing is missing_device.
    expect(plan.blocked.some((w) => w.category === 'missing_device')).toBe(false);
    // Debug RN/Expo: fresh_start stays UNSAFE (bundle_cache_loss).
    expect(plan.unsafe.some((w) => w.reason === 'bundle_cache_loss')).toBe(true);
    expect((r.content?.[0] as { text: string }).text).toMatch(/READY/);
  });
});

describe('qa_job_status waitMs', () => {
  it('returns as soon as the job reaches a terminal state', async () => {
    const s = sessions.create(projectRoot, undefined, {});
    const job = sessions.createJob(s, 'demo');
    setTimeout(() => sessions.updateJob(s, job, { status: 'done', result: { state: 'completed' } }), 200);
    const started = Date.now();
    const out = sc(await call('qa_job_status', { sessionId: s.id, jobId: job.jobId, waitMs: 10_000 }));
    expect(out.status).toBe('done');
    expect(out.result).toEqual({ state: 'completed' });
    expect(out.waited).toMatchObject({ timedOut: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('times out with the job still running (bounded)', async () => {
    const s = sessions.create(projectRoot, undefined, {});
    const job = sessions.createJob(s, 'demo');
    const out = sc(await call('qa_job_status', { sessionId: s.id, jobId: job.jobId, waitMs: 300 }));
    expect(out.status).toBe('running');
    expect(out.waited).toMatchObject({ timedOut: true });
  });

  it('without waitMs returns immediately (no waited block)', async () => {
    const s = sessions.create(projectRoot, undefined, {});
    const job = sessions.createJob(s, 'demo');
    const out = sc(await call('qa_job_status', { sessionId: s.id, jobId: job.jobId }));
    expect(out.status).toBe('running');
    expect(out.waited).toBeUndefined();
  });
});

describe('qa_wda device / udid alias', () => {
  const bound = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  const other = '99999999-8888-7777-6666-555555555555';
  function boundSession() {
    const s = sessions.create(projectRoot, undefined, {});
    s.device = bound;
    return s;
  }

  it('device is canonical: a mismatch with the bound device is refused before any network call', async () => {
    const r = sc(await call('qa_wda', { sessionId: boundSession().id, action: 'attach', device: other }));
    expect(r.failureCode).toBe('STALE_WDA_DEVICE');
    expect(String(r.what)).toContain(other);
  });

  it('udid still works as a deprecated alias of device', async () => {
    const r = sc(await call('qa_wda', { sessionId: boundSession().id, action: 'attach', udid: other }));
    expect(r.failureCode).toBe('STALE_WDA_DEVICE');
    expect(String(r.what)).toContain(other);
  });

  it('conflicting device and udid are rejected', async () => {
    const r = sc(await call('qa_wda', { sessionId: boundSession().id, action: 'attach', device: bound, udid: other }));
    expect(r.failureCode).toBe('INVALID_ARGUMENT');
  });
});

describe('removed actions are rejected by the schema', () => {
  it('qa_ios no longer accepts wda_* or screenshot', async () => {
    const s = sessions.create(projectRoot, undefined, {});
    for (const action of ['wda_status', 'wda_attach', 'screenshot']) {
      const r = await call('qa_ios', { sessionId: s.id, action });
      expect(r.isError, action).toBe(true);
    }
  });

  it('qa_wait no longer accepts for:"job_done"', async () => {
    const s = sessions.create(projectRoot, undefined, {});
    const r = await call('qa_wait', { sessionId: s.id, for: 'job_done', jobId: 'x' });
    expect(r.isError).toBe(true);
  });
});
