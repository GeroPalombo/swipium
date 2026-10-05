// F2: cancellation (notifications/cancelled > the call's scoped signal) must stop every polling
// loop promptly instead of polling until its deadline: qa_wait, qa_job_status long-poll, the
// qa_act wait path, flow waitForVisible, settle and the Android boot wait. Cancelled work comes
// back as CANCELLED (or CancelledError in helpers), never as a failure.
// F6: qa_wait timeoutMs is bounded: integer >= 0, default 45000, larger values clamped to 50000 (with a note).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';

const adbDevicesCalls: number[] = [];
vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  adbDevices: vi.fn(async () => {
    adbDevicesCalls.push(Date.now());
    return [];
  }),
}));

const { FakeDriver, buttonScreen, harness, structured } = await import('./actFixFake.js');
const { CancelledError, isAbortError, runWithSignal, sleepOrCancel, throwIfCancelled } = await import('../src/lib/abortScope.js');
const { registerWait, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS } = await import('../src/tools/wait.js');
const { registerJobs, MAX_JOB_WAIT_MS, RECOMMENDED_JOB_WAIT_MS } = await import('../src/tools/jobs.js');
const { settle } = await import('../src/snapshot/settle.js');
const { waitForBoot } = await import('../src/lib/android.js');
const { runFlow } = await import('../src/flows/run.js');
const { waitForWdaReady } = await import('../src/lib/wda.js');
const { DirectDriver } = await import('../src/drivers/DirectDriver.js');
const { TEST_THIS_WAIT_DEFAULT_MS, TEST_THIS_WAIT_MAX_MS } = await import('../src/orchestration/testThis/execute.js');
const { ACT_TIMEOUT_MAX_MS } = await import('../src/tools/act.js');

type Handler = (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => Promise<CallToolResult>;

/** Capture tool handlers + configs without a transport. */
function capture(register: (server: never) => void) {
  const tools = new Map<string, { cfg: { inputSchema?: Record<string, unknown>; description?: string }; h: Handler }>();
  register({ registerTool: (n: string, cfg: never, h: Handler) => tools.set(n, { cfg, h }) } as never);
  return tools;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('cancel-loops');
});
afterAll(async () => {
  await h.close();
});

describe('abortScope helpers', () => {
  it('sleepOrCancel wakes on abort with CancelledError, and sleeps normally without a signal', async () => {
    const ctl = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ctl.signal, () => sleepOrCancel(10_000));
    setTimeout(() => ctl.abort(), 50);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(sleepOrCancel(10)).resolves.toBeUndefined();
    const done = new AbortController();
    done.abort();
    await expect(sleepOrCancel(10, done.signal)).rejects.toBeInstanceOf(CancelledError);
    expect(() => throwIfCancelled(done.signal)).toThrow(CancelledError);
    expect(() => throwIfCancelled(new AbortController().signal)).not.toThrow();
  });
});

describe('qa_wait', () => {
  it('stops polling adb as soon as the call is cancelled (direct handler > CANCELLED)', async () => {
    const saved = process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;
    delete process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;
    try {
      const tools = capture((s) => registerWait(s, h.sessions));
      const id = await h.start(new FakeDriver(buttonScreen('A', 1)));
      const ctl = new AbortController();
      adbDevicesCalls.length = 0;
      const started = Date.now();
      const p = runWithSignal(ctl.signal, () =>
        tools.get('qa_wait')!.h({ sessionId: id, for: 'device_online', timeoutMs: 30_000 }, { mcpReq: { signal: ctl.signal } }),
      );
      setTimeout(() => ctl.abort(), 200);
      const res = await p;
      expect(Date.now() - started).toBeLessThan(1000); // not the 30 s deadline, not even one 1.5 s interval
      expect(structured(res).failureCode).toBe('CANCELLED');
      const polls = adbDevicesCalls.length;
      await delay(1800);
      expect(adbDevicesCalls.length).toBe(polls);
    } finally {
      process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = saved;
    }
  });

  it('a client-side cancel (notifications/cancelled) ends the server-side poll too', async () => {
    const saved = process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;
    delete process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;
    try {
      const id = await h.start(new FakeDriver(buttonScreen('A', 1)));
      const ctl = new AbortController();
      adbDevicesCalls.length = 0;
      const p = h.client.callTool(
        { name: 'qa_wait', arguments: { sessionId: id, for: 'device_online', timeoutMs: 30_000 } },
        {
          signal: ctl.signal,
        },
      );
      await delay(300);
      ctl.abort();
      await expect(p).rejects.toBeTruthy();
      await delay(200); // let notifications/cancelled reach the server
      const polls = adbDevicesCalls.length;
      expect(polls).toBeGreaterThan(0);
      await delay(2000); // the old loop polled every 1.5 s until the deadline
      expect(adbDevicesCalls.length).toBe(polls);
    } finally {
      process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = saved;
    }
  });

  it('timeoutMs: integer >= 0, default 45000; old larger values are clamped to 50000, not rejected', async () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(45_000);
    expect(MAX_WAIT_TIMEOUT_MS).toBe(50_000);
    const id = await h.start(new FakeDriver(buttonScreen('A', 1)));
    for (const timeoutMs of [-1, 1.5]) {
      const r = await h.call('qa_wait', { sessionId: id, for: 'device_online', timeoutMs });
      expect(r.isError, `timeoutMs=${timeoutMs}`).toBe(true);
    }
    const ok = structured(await h.call('qa_wait', { sessionId: id, for: 'device_online', timeoutMs: 0 }));
    expect(ok.timedOut).toBe(true);
    expect(ok.notes).toBeUndefined();
    // 180000 (documented before 2.2.0) is accepted and clamped; cancel it so the test stays fast.
    const tools = capture((s) => registerWait(s, h.sessions));
    const ctl = new AbortController();
    const p = runWithSignal(ctl.signal, () =>
      tools.get('qa_wait')!.h({ sessionId: id, for: 'device_online', timeoutMs: 180_000 }, { mcpReq: { signal: ctl.signal } }),
    );
    setTimeout(() => ctl.abort(), 100);
    expect(((await p).structuredContent as Record<string, unknown>).failureCode).toBe('CANCELLED');
    const schema = tools.get('qa_wait')!.cfg.inputSchema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(schema.timeoutMs.safeParse(180_000).success).toBe(true);
    expect(schema.timeoutMs.safeParse(60_000).success).toBe(true);
  });
});

describe('qa_job_status long-poll', () => {
  it('caps at 50 s, recommends 45 s, and still accepts the old 60000', async () => {
    expect(MAX_JOB_WAIT_MS).toBe(50_000);
    expect(RECOMMENDED_JOB_WAIT_MS).toBeLessThan(MAX_JOB_WAIT_MS);
    const id = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const s = h.sessions.get(id)!;
    const job = h.sessions.createJob(s, 'demo');
    setTimeout(() => h.sessions.updateJob(s, job, { status: 'done' }), 100);
    const out = structured(await h.call('qa_job_status', { sessionId: id, jobId: job.jobId, waitMs: 60_000 }));
    expect(out.status).toBe('done');
  });

  it('cancelling the poll returns CANCELLED at once and leaves the job running', async () => {
    const tools = capture((srv) => registerJobs(srv, h.sessions));
    const id = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const s = h.sessions.get(id)!;
    const job = h.sessions.createJob(s, 'demo');
    const ctl = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ctl.signal, () =>
      tools.get('qa_job_status')!.h({ sessionId: id, jobId: job.jobId, waitMs: 30_000 }, { mcpReq: { signal: ctl.signal } }),
    );
    setTimeout(() => ctl.abort(), 100);
    const res = await p;
    expect(Date.now() - started).toBeLessThan(600);
    expect(structured(res).failureCode).toBe('CANCELLED');
    expect(h.sessions.get(id)!.jobs.get(job.jobId)!.status).toBe('running');
  });
});

describe('qa_act wait', () => {
  it('a cancelled element wait stops dumping and is not a tool error', async () => {
    const d = new FakeDriver(buttonScreen('A', 1));
    const id = await h.start(d);
    const before = d.got('dumpXml').length;
    const ctl = new AbortController();
    const p = h.client.callTool(
      { name: 'qa_act', arguments: { sessionId: id, action: 'wait', for: { text: 'Never there' }, timeoutMs: 20_000 } },
      { signal: ctl.signal },
    );
    await delay(300);
    ctl.abort();
    await expect(p).rejects.toBeTruthy();
    await delay(200);
    const dumps = d.got('dumpXml').length;
    expect(dumps).toBeGreaterThan(before);
    await delay(1200);
    expect(d.got('dumpXml').length).toBe(dumps);
    expect(h.sessions.get(id)!.toolErrors ?? []).toEqual([]);
  });
});

describe('flow waitForVisible', () => {
  it('a cancelled wait step stops polling and is classified CANCELLED', async () => {
    const d = new FakeDriver(buttonScreen('A', 1));
    const id = await h.start(d);
    const session = h.sessions.get(id)!;
    const ctl = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ctl.signal, () =>
      runFlow(h.sessions, session, d, {
        name: 'cancel-me',
        mode: 'structured',
        fixtures: [],
        setup: [],
        teardown: [],
        provenance: [],
        steps: [{ kind: 'waitForVisible', query: 'Never there', timeoutMs: 20_000 }],
      }),
    );
    setTimeout(() => ctl.abort(), 200);
    const res = await p;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.passed).toBe(false);
    expect(res.steps[0].failureCode).toBe('CANCELLED');
  });
});

describe('settle', () => {
  it('throws CancelledError instead of re-dumping until the deadline', async () => {
    const d = new FakeDriver(buttonScreen('A', 1));
    let n = 0;
    d.dumpXml = async () => `<hierarchy>${n++}</hierarchy>`; // never stable
    const ctl = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ctl.signal, () => settle(d, { timeoutMs: 10_000 }));
    setTimeout(() => ctl.abort(), 150);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('uncancelled settle behaves as before', async () => {
    const d = new FakeDriver(buttonScreen('A', 1));
    const r = await settle(d, { timeoutMs: 3000, stableForMs: 100, intervalMs: 20 });
    expect(r.settled).toBe(true);
  });
});

describe('waitForBoot', () => {
  let dir: string;
  let oldPath: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cancel-loops-adb-'));
    // Fake adb: online at once, never finishes booting.
    writeFileSync(
      join(dir, 'adb'),
      ['#!/bin/sh', 'case "$*" in', '  *getprop*) echo 0 ;;', '  *uiautomator*) exec sleep 5 ;;', '  *) exit 0 ;;', 'esac'].join('\n'),
    );
    chmodSync(join(dir, 'adb'), 0o755);
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${process.env.PATH}`;
  });
  afterAll(() => {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a cancelled boot wait throws CancelledError instead of polling for 180 s', async () => {
    const ctl = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ctl.signal, () => waitForBoot('emulator-5554', 180_000));
    setTimeout(() => ctl.abort(), 300);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('without cancellation it still times out with false', async () => {
    await expect(waitForBoot('emulator-5554', 300)).resolves.toBe(false);
  });
});

describe('DirectDriver.dumpXml retry loop', () => {
  let dir: string;
  let oldPath: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cancel-loops-dump-'));
    writeFileSync(join(dir, 'adb'), ['#!/bin/sh', 'case "$*" in', '  *uiautomator*) exec sleep 5 ;;', '  *) exit 0 ;;', 'esac'].join('\n'));
    chmodSync(join(dir, 'adb'), 0o755);
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${process.env.PATH}`;
  });
  afterAll(() => {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a cancelled dump is rethrown at once instead of retried', async () => {
    const d = new DirectDriver('emulator-5554');
    const ctl = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ctl.signal, () => d.dumpXml({ attempts: 5 }));
    setTimeout(() => ctl.abort(), 200);
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    expect(isAbortError(err, undefined)).toBe(true);
    expect(String(err)).not.toMatch(/after \d+ attempt/);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('waitForWdaReady', () => {
  it('a cancelled startup wait throws CancelledError instead of polling /status until the timeout', async () => {
    const ctl = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ctl.signal, () => waitForWdaReady('http://127.0.0.1:9', 20_000, 1000));
    setTimeout(() => ctl.abort(), 200);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('qa_test_this waitForCompletion window', () => {
  it('timeoutMs: integer >= 0 (default 45000); above 50000 is clamped with a note, not rejected', async () => {
    expect(TEST_THIS_WAIT_DEFAULT_MS).toBe(45_000);
    expect(TEST_THIS_WAIT_MAX_MS).toBe(50_000);
    for (const timeoutMs of [-1, 2.5]) {
      const r = await h.call('qa_test_this', { mode: 'execute', waitForCompletion: true, timeoutMs });
      expect(r.isError, `timeoutMs=${timeoutMs}`).toBe(true);
      expect(structured(r).failureCode).toBe('INVALID_ARGUMENT');
    }
    const big = structured(await h.call('qa_test_this', { mode: 'plan', timeoutMs: 120_000 }));
    expect(big.failureCode).not.toBe('INVALID_ARGUMENT');
    expect(String(big.notes)).toContain('timeoutMs 120000 clamped to 50000');
  });
});

describe('qa_act timeoutMs', () => {
  it('rejects negatives and clamps values above 50000 with a note', async () => {
    expect(ACT_TIMEOUT_MAX_MS).toBe(50_000);
    const id = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const neg = await h.call('qa_act', { sessionId: id, action: 'wait', for: { settled: true }, timeoutMs: -1 });
    expect(neg.isError).toBe(true);
    const big = await h.call('qa_act', { sessionId: id, action: 'wait', for: { settled: true }, timeoutMs: 120_000 });
    expect(big.isError).toBeFalsy();
    expect(String(structured(big).notes)).toContain('timeoutMs 120000 clamped to 50000');
  });
});
