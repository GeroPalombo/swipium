// qa_wda setup / start over this simulator's own hung WDA (it listens but does not answer /status)
// never starts a second WDA next to it: WDA_UNREACHABLE with "qa_wda stop" guidance, no consent,
// no xcodebuild. A WDA that is simply not running still starts as before.
// Hermetic: /status, the listener check and xcodebuild are faked.

import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = vi.hoisted(() => ({ hung: false, spawnCalls: [] as string[][], buildCalls: [] as string[][] }));

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return {
    ...actual,
    run: async (cmd: string, args: string[], opts?: unknown) => {
      if (cmd !== 'xcodebuild') return actual.run(cmd, args, opts as never);
      fake.buildCalls.push(args);
      return { code: 0, stdout: '** TEST BUILD SUCCEEDED **', stderr: '', timedOut: false };
    },
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, ...rest: unknown[]) => {
      if (cmd !== 'xcodebuild') return (actual.spawn as (...a: unknown[]) => unknown)(cmd, ...rest);
      fake.spawnCalls.push(rest[0] as string[]);
      const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = process.pid;
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
    checkWda: async () =>
      fake.hung
        ? { reachable: false, ready: false, error: 'This operation was aborted' }
        : { reachable: false, ready: false, error: 'ECONNREFUSED' },
    waitForWdaReady: async () => ({ ready: true, durationMs: 10, status: { reachable: true, ready: true } }),
  };
});
vi.mock('../src/lib/wdaDevice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wdaDevice.js')>();
  return { ...actual, ownButUnresponsive: async () => fake.hung };
});
vi.mock('../src/session/processRegistry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session/processRegistry.js')>();
  return { ...actual, registerManagedProcess: () => undefined, unregisterManagedProcess: () => undefined };
});

const { FakeDriver, buttonScreen, harness, structured } = await import('./actFixFake.js');

const dir = mkdtempSync(join(tmpdir(), 'swipium-wda-hung-'));
const WDA_PROJECT = join(dir, 'WebDriverAgent.xcodeproj');
mkdirSync(WDA_PROJECT, { recursive: true });
const SIM = '6C1E1C1A-1B2C-4D3E-8F90-0123456789AB';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('wda-setup-hung');
});
afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  fake.hung = false;
  fake.spawnCalls.length = 0;
  fake.buildCalls.length = 0;
});
const sc = async (tool: string, args: Record<string, unknown>) => structured(await h.call(tool, args));

describe('qa_wda setup over a hung WDA of this simulator', () => {
  it('returns WDA_UNREACHABLE with qa_wda stop guidance and starts nothing', async () => {
    fake.hung = true;
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    for (const action of ['setup', 'start']) {
      const res = await sc('qa_wda', { sessionId, action, device: SIM, wdaProjectPath: WDA_PROJECT });
      expect(res.failureCode).toBe('WDA_UNREACHABLE');
      expect(res.requiresConsent).toBeUndefined();
      expect((res.nextSteps as string[]).join(' ')).toContain('qa_wda { action:"stop"');
    }
    expect(fake.spawnCalls).toHaveLength(0);
    expect(fake.buildCalls).toHaveLength(0);
  });

  it('a WDA that is not running at all still goes to the start consent', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const res = await sc('qa_wda', { sessionId, action: 'setup', device: SIM, wdaProjectPath: WDA_PROJECT });
    expect(res.failureCode).toBeUndefined();
    expect(res.requiresConsent).toBe(true);
  });
});
