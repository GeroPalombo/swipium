// 2.1.2 review: one MCP tool call stays under ~50 s (Codex default tool_timeout_sec is 60).
//  - qa_wda build runs xcodebuild as a background job (qa_job_status), consent gating unchanged
//  - qa_wda start waits at most 45 s in-call, then returns ok status:"starting"; qa_wait
//    for:"wda_ready" polls /status (cancellable, same 50 s clamp)
//  - cancelled smoke / mobile-audit work is never recorded as a failure or issue
//  - shutdown cancels every running job before restoring network state
// Hermetic: xcodebuild (run + spawn), WDA /status and the process registry are faked.

import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = vi.hoisted(() => ({
  wdaReady: false,
  startWait: { ready: false, durationMs: 45_000 },
  startWaitCalls: [] as number[],
  childPid: 0,
  build: undefined as undefined | ((signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>),
  buildCalls: [] as string[][],
}));

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return {
    ...actual,
    run: async (cmd: string, args: string[], opts?: { signal?: AbortSignal }) => {
      if (cmd !== 'xcodebuild') return actual.run(cmd, args, opts as never);
      fake.buildCalls.push(args);
      return fake.build ? fake.build(opts?.signal) : { code: 0, stdout: '** TEST BUILD SUCCEEDED **', stderr: '', timedOut: false };
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, ...rest: unknown[]) => {
      if (cmd !== 'xcodebuild') return (actual.spawn as (...a: unknown[]) => unknown)(cmd, ...rest);
      const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = fake.childPid;
      child.unref = () => undefined;
      return child;
    },
  };
});

vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return {
    ...actual,
    xcodeAvailable: async () => ({ available: true, version: 'Xcode 26.6' }),
    checkWda: async () => (fake.wdaReady ? { reachable: true, ready: true } : { reachable: false, ready: false, error: 'ECONNREFUSED' }),
    waitForWdaReady: async (_url: string, timeoutMs: number) => {
      fake.startWaitCalls.push(timeoutMs);
      return { ...fake.startWait, status: { reachable: false, ready: false } };
    },
  };
});

vi.mock('../src/session/processRegistry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session/processRegistry.js')>();
  return { ...actual, registerManagedProcess: () => undefined, unregisterManagedProcess: () => undefined };
});

const { FakeDriver, buttonScreen, harness, structured } = await import('./actFixFake.js');
const { runWithSignal } = await import('../src/lib/abortScope.js');
const { WDA_START_CALL_WAIT_MS } = await import('../src/tools/wda.js');
const { cancelAllRunningJobs } = await import('../src/server.js');
const { runSmoke } = await import('../src/services/smoke.js');
const { runMobileAudit } = await import('../src/mobileAudit/runner.js');

const wdaDir = mkdtempSync(join(tmpdir(), 'swipium-wda-timeouts-'));
const WDA_PROJECT = join(wdaDir, 'WebDriverAgent.xcodeproj');
mkdirSync(WDA_PROJECT, { recursive: true });
const UDID = 'SIM-TIMEOUTS-1';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('wda-timeouts');
});
afterAll(async () => {
  await h.close();
  rmSync(wdaDir, { recursive: true, force: true });
});
beforeEach(() => {
  fake.wdaReady = false;
  fake.startWait = { ready: false, durationMs: 45_000 };
  fake.startWaitCalls.length = 0;
  fake.childPid = process.pid; // alive
  fake.build = undefined;
  fake.buildCalls.length = 0;
});

const sc = async (tool: string, args: Record<string, unknown>) => structured(await h.call(tool, args));

async function approved(sessionId: string, action: 'build' | 'start') {
  const base = { sessionId, action, device: UDID, wdaProjectPath: WDA_PROJECT };
  const gate = await sc('qa_wda', base);
  expect(gate.requiresConsent).toBe(true);
  return sc('qa_wda', { ...base, consentId: gate.consentId, approve: true });
}

describe('qa_wda build: background job', () => {
  it('returns {jobId, status:"running"} at once; the job ends done with the build result', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const started = await approved(sessionId, 'build');
    expect(started).toMatchObject({ ok: true, status: 'running', kind: 'wda_build' });
    expect(typeof started.jobId).toBe('string');
    const job = await sc('qa_job_status', { sessionId, jobId: started.jobId, waitMs: 5000 });
    expect(job.status).toBe('done');
    expect(fake.buildCalls[0]).toEqual(expect.arrayContaining(['-project', WDA_PROJECT, 'build-for-testing']));
    const s = h.sessions.get(sessionId)!;
    expect(s.mutations.some((m) => m.action === 'wda_build' && m.status === 'executed')).toBe(true);
  });

  it('consent is still required (no job without approval)', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const gate = await sc('qa_wda', { sessionId, action: 'build', device: UDID, wdaProjectPath: WDA_PROJECT });
    expect(gate.requiresConsent).toBe(true);
    expect(gate.jobId).toBeUndefined();
    expect(fake.buildCalls).toHaveLength(0);
    expect(h.sessions.get(sessionId)!.jobs.size).toBe(0);
  });

  it('a failed build fails the job with a classified failureCode and log', async () => {
    fake.build = async () => ({ code: 65, stdout: '', stderr: 'error: compile failed', timedOut: false });
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const started = await approved(sessionId, 'build');
    const job = await sc('qa_job_status', { sessionId, jobId: started.jobId, waitMs: 5000 });
    expect(job.status).toBe('failed');
    const rec = h.sessions.get(sessionId)!.jobs.get(started.jobId as string)!;
    expect(rec.result).toMatchObject({ failureCode: 'WDA_BUILD_FAILED' });
    expect(String(rec.result?.logUri)).toMatch(/^swipium:/);
  });

  it('qa_job_cancel aborts xcodebuild; the job stays cancelled, no executed mutation', async () => {
    fake.build = (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const started = await approved(sessionId, 'build');
    await new Promise((r) => setTimeout(r, 20));
    await sc('qa_job_cancel', { sessionId, jobId: started.jobId });
    await new Promise((r) => setTimeout(r, 20));
    const s = h.sessions.get(sessionId)!;
    expect(s.jobs.get(started.jobId as string)!.status).toBe('cancelled');
    expect(s.mutations.some((m) => m.action === 'wda_build' && (m.status === 'executed' || m.status === 'blocked'))).toBe(false);
  });
});

describe('qa_wda start: bounded in-call wait', () => {
  it('waits at most 45 s and returns ok status:"starting" while the process lives', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const res = await approved(sessionId, 'start');
    expect(fake.startWaitCalls).toEqual([WDA_START_CALL_WAIT_MS]);
    expect(WDA_START_CALL_WAIT_MS).toBeLessThanOrEqual(45_000);
    expect(res).toMatchObject({ ok: true, started: true, ready: false, status: 'starting', startupTimeoutMs: 120_000 });
    expect(res.remainingStartupMs).toBe(75_000);
  });

  it('a process that already exited is WDA_START_FAILED, not "starting"', async () => {
    fake.childPid = 2 ** 22 + 12345; // not a live pid
    fake.startWait = { ready: false, durationMs: 3000 };
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const res = await approved(sessionId, 'start');
    expect(res.failureCode).toBe('WDA_START_FAILED');
    expect(String(res.what)).toMatch(/exited/);
  });

  it('ready within the window: ready:true as before', async () => {
    fake.startWait = { ready: true, durationMs: 1200 };
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    expect(await approved(sessionId, 'start')).toMatchObject({ ok: true, started: true, ready: true });
  });
});

describe('qa_wait for:"wda_ready"', () => {
  it('satisfied once /status is ready; an old 180000 timeout is clamped with a note', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    setTimeout(() => (fake.wdaReady = true), 200);
    const res = await sc('qa_wait', { sessionId, for: 'wda_ready', timeoutMs: 180_000 });
    expect(res).toMatchObject({ ok: true, satisfied: true, condition: 'wda_ready', webDriverAgentUrl: 'http://127.0.0.1:8100' });
    expect(String((res.notes as string[])[0])).toMatch(/clamped to 50000/);
  });

  it('timedOut with the last /status when WDA never comes up', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const res = await sc('qa_wait', { sessionId, for: 'wda_ready', timeoutMs: 0 });
    expect(res).toMatchObject({ satisfied: false, timedOut: true, condition: 'wda_ready' });
  });

  it('cancellation stops polling and returns CANCELLED', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const ac = new AbortController();
    const started = Date.now();
    const p = h.client.callTool(
      { name: 'qa_wait', arguments: { sessionId, for: 'wda_ready', timeoutMs: 30_000 } },
      {
        signal: ac.signal,
      },
    );
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('cancelled work is not recorded as a failure', () => {
  it('runSmoke under a cancelled signal: baseline skipped (intentionally_skipped), cancelled:true', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const s = h.sessions.get(sessionId)!;
    const ctl = new AbortController();
    ctl.abort();
    const r = await runWithSignal(ctl.signal, () => runSmoke(h.sessions, s, new FakeDriver(buttonScreen('A', 1))));
    expect(r.cancelled).toBe(true);
    expect(r.baseline.launch).toMatchObject({ outcome: 'skipped', cancelled: true });
    const notes = s.notes.filter((n) => n.workflow === 'launch_smoke');
    expect(notes.every((n) => n.outcome === 'skipped' && n.category === 'intentionally_skipped')).toBe(true);
    expect(s.notes.some((n) => n.outcome === 'fail')).toBe(false);
  });

  it('runMobileAudit under a cancelled signal unwinds without recording checks or issues', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const s = h.sessions.get(sessionId)!;
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      runWithSignal(ctl.signal, () =>
        runMobileAudit(h.sessions, s, new FakeDriver(buttonScreen('A', 1)), { profile: 'smoke', now: new Date().toISOString() }),
      ),
    ).rejects.toMatchObject({ name: 'CancelledError' });
  });
});

describe('shutdown cancels running jobs', () => {
  it('cancelAllRunningJobs aborts every running job and leaves finished ones alone', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const s = h.sessions.get(sessionId)!;
    const running = h.sessions.createJob(s, 'demo');
    const done = h.sessions.createJob(s, 'demo');
    h.sessions.updateJob(s, done, { status: 'done' });
    const signal = h.sessions.abortSignal(s, running.jobId)!;
    expect(cancelAllRunningJobs(h.sessions)).toBeGreaterThanOrEqual(1);
    expect(signal.aborted).toBe(true);
    expect(s.jobs.get(running.jobId)!.status).toBe('cancelled');
    expect(s.jobs.get(done.jobId)!.status).toBe('done');
    expect(cancelAllRunningJobs(h.sessions)).toBe(0);
  });
});
