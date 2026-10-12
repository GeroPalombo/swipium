// Device-choosing paths go through one resolver (exact UDID or unique exact
// name; else INVALID_ARGUMENT / MULTIPLE_DEVICES, never "the first booted"), and the SWIPIUM_DEVICE
// pin is the only candidate. One test per repro case (a) to (e), plus qa_ios erase getting a
// resolved UDID. Hermetic: simctl / adb / artifacts mocked, nothing boots or erases.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

// B is listed (and booted) first, so any "first booted" fallback would pick it.
const B = { udid: '0B0B0B0B-2222-4222-8222-000000000002', name: 'Other tester', state: 'Booted', runtime: 'iOS 18.0' };
const A = { udid: '0A0A0A0A-1111-4111-8111-000000000001', name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' };
const SE1 = { udid: '0C0C0C0C-3333-4333-8333-000000000003', name: 'iPhone SE', state: 'Shutdown', runtime: 'iOS 18.0' };
const SE2 = { udid: '0D0D0D0D-4444-4444-8444-000000000004', name: 'iPhone SE', state: 'Shutdown', runtime: 'iOS 18.0' };

const calls = vi.hoisted(() => ({ booted: [] as string[], erased: [] as string[] }));
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return {
    ...actual,
    simctlAvailable: async () => true,
    listSimulators: async () => [B, A, SE1, SE2],
    bootWithin: async (udid: string) => {
      calls.booted.push(udid);
      return { booted: true, elapsedMs: 1 };
    },
    erase: async (udid: string) => {
      calls.erased.push(udid);
    },
  };
});
vi.mock('../src/lib/android.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/android.js')>();
  return {
    ...actual,
    which: async (bin: string) => bin === 'adb',
    adbDevices: async () => ['emulator-5554'],
    listAvds: async () => ['Other_AVD', 'Pixel_7'],
  };
});
vi.mock('../src/artifacts/resolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/artifacts/resolve.js')>();
  return {
    ...actual,
    resolveArtifact: async ({ projectRoot }: { projectRoot: string }) => {
      const best = {
        path: join(projectRoot, 'build', 'App.app'),
        type: 'app',
        platform: 'ios',
        installableOn: ['ios-simulator'],
        appId: 'com.example.app',
        outsideRoot: false,
        warnings: [],
      };
      return { candidates: [best], best, newest: best, searchedLocations: [], warnings: [] };
    },
  };
});
const { createServer } = await import('../src/server.js');
const { SimctlDriver } = await import('../src/drivers/SimctlDriver.js');
const { bootstrapFeatureExecution } = await import('../src/featureTesting/executionBootstrap.js');
type SessionStore = import('../src/session/store.js').SessionStore;
type McpServer = import('@modelcontextprotocol/server').McpServer;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-devres-')));
writeFileSync(join(root, 'package.json'), '{"name":"devres"}');

let client: Client;
let sessions: SessionStore;
let server: McpServer;
beforeAll(async () => {
  const ctx = createServer();
  sessions = ctx.sessions;
  server = ctx.server;
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'devres', version: '0' });
  await Promise.all([ctx.server.connect(s), client.connect(c)]);
});
afterEach(() => {
  delete process.env.SWIPIUM_DEVICE;
  delete process.env.SWIPIUM_CONSENT_PREAPPROVE;
  calls.booted.length = 0;
  calls.erased.length = 0;
});
afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) =>
  ((await client.callTool({ name, arguments: args })) as CallToolResult).structuredContent as Record<string, unknown>;
const newSession = async () => (await call('qa_start_session', { projectRoot: root })).sessionId as string;
async function boundTo(sim: { udid: string }): Promise<string> {
  const sessionId = await newSession();
  const s = sessions.get(sessionId)!;
  s.driver = new SimctlDriver(sim.udid);
  s.device = sim.udid;
  return sessionId;
}

describe('(a) qa_ios boot without a pin: exact UDID or unique exact name, never the first booted', () => {
  it('an unknown name is INVALID_ARGUMENT and nothing boots (B, booted first, is not taken)', async () => {
    const sessionId = await newSession();
    const res = await call('qa_ios', { sessionId, action: 'boot', device: 'iPhone 99' });
    expect(res.failureCode).toBe('INVALID_ARGUMENT');
    expect(calls.booted).toEqual([]);
    expect(sessions.get(sessionId)!.device).toBeUndefined();
  });

  it('a substring is no longer a match', async () => {
    const res = await call('qa_ios', { sessionId: await newSession(), action: 'boot', device: 'iPhone' });
    expect(res.failureCode).toBe('INVALID_ARGUMENT');
    expect(calls.booted).toEqual([]);
  });

  it('a mistyped UDID is INVALID_ARGUMENT; a lowercase UDID boots that simulator', async () => {
    const typo = await call('qa_ios', { sessionId: await newSession(), action: 'boot', device: A.udid.replace('1111', '1112') });
    expect(typo.failureCode).toBe('INVALID_ARGUMENT');
    expect(calls.booted).toEqual([]);
    const lower = await call('qa_ios', { sessionId: await newSession(), action: 'boot', device: A.udid.toLowerCase() });
    expect(lower.udid).toBe(A.udid);
    expect(calls.booted).toEqual([A.udid]);
  });

  it('a name two simulators share is MULTIPLE_DEVICES', async () => {
    const res = await call('qa_ios', { sessionId: await newSession(), action: 'boot', device: 'iPhone SE' });
    expect(res.failureCode).toBe('MULTIPLE_DEVICES');
    expect(calls.booted).toEqual([]);
  });

  it('no device and two simulators booted is MULTIPLE_DEVICES', async () => {
    const res = await call('qa_ios', { sessionId: await newSession(), action: 'boot' });
    expect(res.failureCode).toBe('MULTIPLE_DEVICES');
    expect(calls.booted).toEqual([]);
  });
});

describe('(b) qa_prepare_target under an iOS pin', () => {
  it('without device, an iOS pin refuses instead of binding or booting an Android device', async () => {
    process.env.SWIPIUM_DEVICE = A.udid;
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'prepare_plan';
    const res = await call('qa_prepare_target', { sessionId: await newSession(), bindOnly: true });
    expect(res.failureCode).toBe('DEVICE_PINNED');
    expect(JSON.stringify(res)).not.toMatch(/emulator-5554|Other_AVD/);
  });

  it('an AVD pin boots that AVD, not the first one', async () => {
    process.env.SWIPIUM_DEVICE = 'pixel_7';
    const res = await call('qa_prepare_target', { sessionId: await newSession(), bindOnly: true });
    expect(res.requiresConsent).toBe(true);
    expect(JSON.stringify(res)).toMatch(/Pixel_7/);
    expect(JSON.stringify(res)).not.toMatch(/Other_AVD/);
  });
});

describe('(c) qa_test_feature device pick under the pin', () => {
  const boot = (device?: string, platform?: 'ios' | 'android') =>
    bootstrapFeatureExecution({ server, sessions, projectRoot: root, feature: 'login', device, platform, deferPrepare: true });

  it('without device, the pinned simulator is the target (not the first booted one)', async () => {
    process.env.SWIPIUM_DEVICE = A.udid;
    const r = await boot();
    const text = JSON.stringify(r);
    expect(text).toContain(`xcrun simctl install ${A.udid}`);
    expect(text).not.toContain(B.udid);
  });

  it('another device is DEVICE_PINNED; a platform the pin does not cover is refused', async () => {
    process.env.SWIPIUM_DEVICE = A.udid;
    const other = await boot(B.udid);
    expect(other.ok).toBe(false);
    expect(JSON.stringify(other)).toMatch(/DEVICE_PINNED/);
    const android = await boot(undefined, 'android');
    expect(android.ok).toBe(false);
    expect(JSON.stringify(android)).toMatch(/DEVICE_PINNED/);
  });

  it('a pinned name two simulators share is MULTIPLE_DEVICES', async () => {
    process.env.SWIPIUM_DEVICE = 'iPhone SE';
    const r = await boot();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/MULTIPLE_DEVICES/);
  });
});

describe('(d) a pinned name two simulators share pins neither', () => {
  it('pre-approved qa_ios erase of either is MULTIPLE_DEVICES and nothing is erased', async () => {
    process.env.SWIPIUM_DEVICE = 'iPhone SE';
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'erase_device';
    for (const sim of [SE1, SE2]) {
      const res = await call('qa_ios', { sessionId: await boundTo(sim), action: 'erase', device: sim.udid });
      expect(res.failureCode).toBe('MULTIPLE_DEVICES');
    }
    expect(calls.erased).toEqual([]);
  });

  it('qa_ios boot without device is MULTIPLE_DEVICES', async () => {
    process.env.SWIPIUM_DEVICE = 'iPhone SE';
    const res = await call('qa_ios', { sessionId: await newSession(), action: 'boot' });
    expect(res.failureCode).toBe('MULTIPLE_DEVICES');
    expect(calls.booted).toEqual([]);
  });
});

describe('(e) qa_wda stop checks the pin', () => {
  it('stop on another simulator is DEVICE_PINNED', async () => {
    process.env.SWIPIUM_DEVICE = A.udid;
    const res = await call('qa_wda', { sessionId: await newSession(), action: 'stop', device: B.udid });
    expect(res.failureCode).toBe('DEVICE_PINNED');
  });
});

describe('qa_ios erase gets a resolved UDID', () => {
  it('a name is resolved to its UDID and the consent prompt shows the UDID', async () => {
    const sessionId = await boundTo(A);
    const res = await call('qa_ios', { sessionId, action: 'erase', device: 'iphone 16' });
    expect(res.requiresConsent).toBe(true);
    expect(JSON.stringify(res)).toContain(`xcrun simctl erase ${A.udid}`);
  });

  it('"booted", a substring or an unknown name is refused before consent', async () => {
    const sessionId = await boundTo(A);
    for (const device of ['booted', 'iPhone', 'nope']) {
      const res = await call('qa_ios', { sessionId, action: 'erase', device });
      expect(res.failureCode).toBe('INVALID_ARGUMENT');
      expect(res.requiresConsent).toBeUndefined();
    }
    expect(calls.erased).toEqual([]);
  });
});
