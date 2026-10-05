// 2.2.0 review: one MCP tool call stays under ~50 s (Codex default tool_timeout_sec is 60), also on
// an iOS Simulator cold boot (simctl boot + bootstatus can take minutes).
//  - qa_ios boot waits at most SIMULATOR_BOOT_CALL_WAIT_MS, then returns ok status:"booting" with
//    the simulator already bound; the boot keeps going in the background
//  - qa_wait for:"simulator_booted" polls it (cancellable, same 50 s clamp)
//  - qa_prepare_ios_target hands a still-booting prepare to a background job
//  - internal callers (prepareIos without bootWaitMs, as in qa_test_this jobs) wait for the full boot
// Hermetic: every xcrun call is faked through spawn.run; simctlAvailable and WDA are faked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

const fake = vi.hoisted(() => ({
  state: 'Shutdown',
  probeBooted: false,
  gate: undefined as undefined | Promise<void>,
  release: () => {},
  fail: (_msg: string) => {},
  callWait: undefined as number | undefined, // overrides the in-call boot wait (tests cannot wait 40 s)
  waitCalls: [] as number[],
  xcrun: [] as string[][],
}));

function newGate(): void {
  fake.gate = new Promise<void>((resolve, reject) => {
    fake.release = () => resolve();
    fake.fail = (msg: string) => reject(new Error(msg));
  });
  fake.gate.catch(() => {});
}

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
  return {
    ...actual,
    run: async (cmd: string, args: string[], opts?: unknown) => {
      if (cmd !== 'xcrun') return actual.run(cmd, args, opts as never);
      fake.xcrun.push(args);
      const sub = args[1];
      if (sub === 'list')
        return ok(
          JSON.stringify({
            devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: UDID, name: 'iPhone 16', state: fake.state }] },
          }),
        );
      if (sub === 'boot') {
        fake.state = 'Booted'; // simctl boot returns once the device is Booted; bootstatus waits for the rest
        return ok();
      }
      if (sub === 'bootstatus' && args.includes('-b')) {
        try {
          await fake.gate;
          fake.probeBooted = true;
          return ok('Device already booted');
        } catch (e) {
          return { code: 1, stdout: '', stderr: String((e as Error).message), timedOut: false };
        }
      }
      if (sub === 'bootstatus') return fake.probeBooted ? ok() : { code: null, stdout: '', stderr: '', timedOut: true };
      return ok();
    },
  };
});

vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return {
    ...actual,
    simctlAvailable: async () => true,
    bootWithin: (udid: string, waitMs: number) => {
      fake.waitCalls.push(waitMs);
      return actual.bootWithin(udid, fake.callWait ?? waitMs);
    },
  };
});

vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return { ...actual, checkWda: async () => ({ reachable: false, ready: false, error: 'ECONNREFUSED' }) };
});

const { FakeDriver, buttonScreen, harness, structured } = await import('./actFixFake.js');
const sim = await import('../src/lib/simctl.js');
const { prepareIos } = await import('../src/services/prepareIos.js');
const { PREPARE_IOS_BOOT_CALL_WAIT_MS } = await import('../src/tools/prepareIosTarget.js');

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('sim-boot-timeouts');
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  sim.resetBootTrackingForTests();
  fake.state = 'Shutdown';
  fake.probeBooted = false;
  fake.callWait = undefined;
  fake.waitCalls.length = 0;
  fake.xcrun.length = 0;
  newGate();
});

const sc = async (tool: string, args: Record<string, unknown>) => structured(await h.call(tool, args));
const newSession = () => h.start(new FakeDriver(buttonScreen('A', 1)));

describe('qa_ios boot: bounded in-call wait', () => {
  it('booted within the window: status:"booted", bound, waited at most SIMULATOR_BOOT_CALL_WAIT_MS', async () => {
    fake.release();
    const sessionId = await newSession();
    const res = await sc('qa_ios', { sessionId, action: 'boot', device: UDID });
    expect(res).toMatchObject({ ok: true, udid: UDID, bound: true, booted: true, status: 'booted' });
    expect(fake.waitCalls).toEqual([sim.SIMULATOR_BOOT_CALL_WAIT_MS]);
    expect(sim.SIMULATOR_BOOT_CALL_WAIT_MS).toBeLessThanOrEqual(45_000);
    expect(h.sessions.get(sessionId)!.device).toBe(UDID);
  });

  it('still booting: ok status:"booting" with udid/name/elapsed/next, and the simulator is bound', async () => {
    fake.callWait = 50;
    const sessionId = await newSession();
    const res = await sc('qa_ios', { sessionId, action: 'boot', device: UDID });
    expect(res).toMatchObject({ ok: true, status: 'booting', booted: false, bound: true, udid: UDID, name: 'iPhone 16' });
    expect(typeof res.elapsedMs).toBe('number');
    expect(String(res.next)).toMatch(/qa_wait .*simulator_booted/);
    const s = h.sessions.get(sessionId)!;
    expect(s.device).toBe(UDID);
    expect(s.milestones.simulator_boot_end).toBeUndefined();
    expect(sim.bootInFlight(UDID)).toBe(true);
  });

  it('cancelling a qa_ios boot call returns promptly; the boot keeps running', async () => {
    fake.callWait = 30_000;
    const sessionId = await newSession();
    const ac = new AbortController();
    const started = Date.now();
    const p = h.client.callTool({ name: 'qa_ios', arguments: { sessionId, action: 'boot', device: UDID } }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(sim.bootInFlight(UDID)).toBe(true);
  });
});

describe('qa_wait for:"simulator_booted"', () => {
  it('poll succeeds once the background boot finishes; an old 180000 timeout is clamped with a note', async () => {
    fake.callWait = 50;
    const sessionId = await newSession();
    expect((await sc('qa_ios', { sessionId, action: 'boot', device: UDID })).status).toBe('booting');
    setTimeout(() => fake.release(), 200);
    const res = await sc('qa_wait', { sessionId, for: 'simulator_booted', timeoutMs: 180_000 });
    expect(res).toMatchObject({ ok: true, satisfied: true, condition: 'simulator_booted', udid: UDID });
    expect(String((res.notes as string[])[0])).toMatch(/clamped to 50000/);
    expect(h.sessions.get(sessionId)!.milestones.simulator_boot_end).toBeTypeOf('number');
  });

  it('timedOut (call again) while the simulator is still booting', async () => {
    fake.callWait = 50;
    const sessionId = await newSession();
    await sc('qa_ios', { sessionId, action: 'boot', device: UDID });
    const res = await sc('qa_wait', { sessionId, for: 'simulator_booted', timeoutMs: 300 });
    expect(res).toMatchObject({ satisfied: false, timedOut: true, condition: 'simulator_booted', udid: UDID });
    expect(res.simulator).toMatchObject({ state: 'booting' });
  });

  it('a boot that failed in the background is reported, not polled forever', async () => {
    fake.callWait = 50;
    const sessionId = await newSession();
    await sc('qa_ios', { sessionId, action: 'boot', device: UDID });
    fake.fail('Unable to boot device');
    const res = await sc('qa_wait', { sessionId, for: 'simulator_booted', timeoutMs: 5000 });
    expect(res).toMatchObject({ ok: false, failureCode: 'SIMULATOR_BOOT_FAILED' });
    expect(String(res.what)).toMatch(/Unable to boot device/);
  });

  it('a simulator booted outside this process is satisfied via simctl bootstatus', async () => {
    fake.release();
    const sessionId = await newSession();
    await sc('qa_ios', { sessionId, action: 'boot', device: UDID });
    sim.resetBootTrackingForTests();
    const res = await sc('qa_wait', { sessionId, for: 'simulator_booted', timeoutMs: 2000 });
    expect(res).toMatchObject({ satisfied: true });
    expect(fake.xcrun.some((a) => a[1] === 'bootstatus' && !a.includes('-b'))).toBe(true);
  });

  it('no simulator bound: NO_DEVICE pointing at qa_ios boot', async () => {
    const sessionId = await newSession();
    const res = await sc('qa_wait', { sessionId, for: 'simulator_booted', timeoutMs: 100 });
    expect(res).toMatchObject({ ok: false, failureCode: 'NO_DEVICE' });
  });

  it('cancellation stops polling and returns promptly', async () => {
    fake.callWait = 50;
    const sessionId = await newSession();
    await sc('qa_ios', { sessionId, action: 'boot', device: UDID });
    const ac = new AbortController();
    const started = Date.now();
    const p = h.client.callTool(
      { name: 'qa_wait', arguments: { sessionId, for: 'simulator_booted', timeoutMs: 30_000 } },
      { signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('qa_prepare_ios_target', () => {
  it('a boot still running after the in-call wait continues as a job (status:"booting"); the job finishes the prepare', async () => {
    fake.callWait = 50;
    const sessionId = await newSession();
    const res = await sc('qa_prepare_ios_target', { sessionId, device: UDID, attachWda: 'skip' });
    expect(fake.waitCalls).toEqual([PREPARE_IOS_BOOT_CALL_WAIT_MS]);
    expect(PREPARE_IOS_BOOT_CALL_WAIT_MS).toBeLessThanOrEqual(45_000);
    expect(res).toMatchObject({ ok: true, status: 'booting', udid: UDID, name: 'iPhone 16', bound: true, kind: 'prepare_ios' });
    expect(String(res.next)).toMatch(/qa_job_status/);
    expect(h.sessions.get(sessionId)!.device).toBe(UDID);

    const running = await sc('qa_job_status', { sessionId, jobId: res.jobId, waitMs: 200 });
    expect(running.status).toBe('running');
    expect(fake.xcrun.some((a) => a[1] === 'launch')).toBe(false); // nothing past the boot yet

    fake.release();
    const job = await sc('qa_job_status', { sessionId, jobId: res.jobId, waitMs: 5000 });
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ udid: UDID, launched: true, mode: 'visual-fallback' });
  });

  it('booted within the window: the prepare finishes in the same call', async () => {
    fake.release();
    const sessionId = await newSession();
    const res = await sc('qa_prepare_ios_target', { sessionId, device: UDID, attachWda: 'skip' });
    expect(res).toMatchObject({ ok: true, udid: UDID, launched: true });
    expect(res.jobId).toBeUndefined();
  });
});

describe('internal (job) callers keep the full boot wait', () => {
  it('prepareIos without bootWaitMs waits for the whole boot, never returns booting', async () => {
    const sessionId = await newSession();
    const session = h.sessions.get(sessionId)!;
    let settled = false;
    const p = prepareIos(h.sessions, session, { simulator: UDID, launch: false, attachWda: 'skip' }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);
    fake.release();
    const r = await p;
    expect(r).toMatchObject({ ok: true, udid: UDID });
    expect(r.booting).toBeUndefined();
    expect(fake.waitCalls).toEqual([]);
  });

  it('joins a boot already in flight instead of installing onto a half-booted simulator', async () => {
    fake.callWait = 50;
    const sessionId = await newSession();
    await sc('qa_ios', { sessionId, action: 'boot', device: UDID }); // simctl now lists it Booted, bootstatus pending
    const bootCalls = () => fake.xcrun.filter((a) => a[1] === 'boot').length;
    expect(bootCalls()).toBe(1);
    let settled = false;
    const p = prepareIos(h.sessions, h.sessions.get(sessionId)!, { simulator: UDID, launch: false, attachWda: 'skip' }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);
    fake.release();
    expect(await p).toMatchObject({ ok: true });
    expect(bootCalls()).toBe(1);
  });
});
