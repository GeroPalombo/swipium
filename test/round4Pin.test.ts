// Round-4 SWIPIUM_DEVICE refusals and simulator names (CR P5, IOS NEW-B / NEW-C):
//  - qa_wda {device:"<name>"} resolves the name to its UDID, so the pin applies (DEVICE_PINNED before consent);
//  - qa_ios erase on another simulator under the pin: DEVICE_PINNED before consent;
//  - qa_ios launch {device} on a non-bound simulator: refused (INVALID_ARGUMENT, nothing launched);
//    the bound simulator by name runs.
// Hermetic: temp HOME, simctl mocked, no xcodebuild.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const A = { udid: '0A0A0A0A-1111-4111-8111-000000000001', name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' };
const B = { udid: '0B0B0B0B-2222-4222-8222-000000000002', name: 'iPhone SE (3rd generation)', state: 'Booted', runtime: 'iOS 18.0' };
const launched = vi.hoisted(() => [] as Array<{ udid: string; bundleId: string }>);
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return {
    ...actual,
    simctlAvailable: async () => true,
    listSimulators: async () => [A, B],
    launchApp: async (udid: string, bundleId: string) => {
      launched.push({ udid, bundleId });
    },
    isInstalled: async () => true,
  };
});

const { createServer } = await import('../src/server.js');
const { SimctlDriver } = await import('../src/drivers/SimctlDriver.js');
type SessionStore = import('../src/session/store.js').SessionStore;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-r4-pin-')));
writeFileSync(join(root, 'package.json'), '{"name":"r4pin"}');

let client: Client;
let sessions: SessionStore;
beforeAll(async () => {
  const ctx = createServer();
  sessions = ctx.sessions;
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'r4pin', version: '0' });
  await Promise.all([ctx.server.connect(s), client.connect(c)]);
});
afterEach(() => {
  delete process.env.SWIPIUM_DEVICE;
});
afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) =>
  ((await client.callTool({ name, arguments: args })) as CallToolResult).structuredContent as Record<string, unknown>;

async function boundTo(sim: typeof A): Promise<string> {
  const sessionId = (await call('qa_start_session', { projectRoot: root })).sessionId as string;
  const s = sessions.get(sessionId)!;
  s.driver = new SimctlDriver(sim.udid);
  s.device = sim.udid;
  s.appId = 'com.example.app';
  return sessionId;
}

describe('SWIPIUM_DEVICE refusals (CR P5)', () => {
  it('qa_wda setup with another simulator by NAME is DEVICE_PINNED before any consent', async () => {
    process.env.SWIPIUM_DEVICE = A.udid;
    const sessionId = (await call('qa_start_session', { projectRoot: root })).sessionId as string;
    const res = await call('qa_wda', { sessionId, action: 'setup', device: 'iphone se (3rd generation)', wdaProjectPath: 'WDA.xcodeproj' });
    expect(res.failureCode).toBe('DEVICE_PINNED');
    expect(res.requiresConsent).toBeUndefined();
  });

  it('qa_wda with a partial or unknown simulator name is INVALID_ARGUMENT', async () => {
    const sessionId = (await call('qa_start_session', { projectRoot: root })).sessionId as string;
    const ambiguous = await call('qa_wda', { sessionId, action: 'setup', device: 'iPhone', wdaProjectPath: 'WDA.xcodeproj' });
    expect(ambiguous.failureCode).toBe('INVALID_ARGUMENT'); // a substring is not a match
    expect(String(ambiguous.what)).toMatch(/matches no available simulator/);
    const unknown = await call('qa_wda', { sessionId, action: 'setup', device: 'Pixel 9', wdaProjectPath: 'WDA.xcodeproj' });
    expect(unknown.failureCode).toBe('INVALID_ARGUMENT');
  });

  it('qa_ios erase of another simulator under the pin is DEVICE_PINNED before any consent', async () => {
    process.env.SWIPIUM_DEVICE = 'iphone 16'; // wrong case still pins A
    const sessionId = await boundTo(A);
    const res = await call('qa_ios', { sessionId, action: 'erase', device: B.udid });
    expect(res.failureCode).toBe('DEVICE_PINNED');
    expect(res.requiresConsent).toBeUndefined();
  });
});

describe('qa_ios {device} on actions other than boot / erase (IOS NEW-C)', () => {
  it('another simulator is refused and nothing is launched; the bound one by name runs', async () => {
    const sessionId = await boundTo(A);
    launched.length = 0;
    const other = await call('qa_ios', { sessionId, action: 'launch', device: B.udid });
    expect(other.failureCode).toBe('INVALID_ARGUMENT');
    expect(String(other.what)).toMatch(/not this session's simulator/);
    expect(launched).toEqual([]);

    const same = await call('qa_ios', { sessionId, action: 'launch', device: 'iphone 16' });
    expect(same.ok).toBe(true);
    expect(launched).toEqual([{ udid: A.udid, bundleId: 'com.example.app' }]);
  });

  it('under the pin, another simulator is DEVICE_PINNED', async () => {
    process.env.SWIPIUM_DEVICE = A.udid;
    const sessionId = await boundTo(A);
    const res = await call('qa_ios', { sessionId, action: 'launch', device: B.name });
    expect(res.failureCode).toBe('DEVICE_PINNED');
  });
});
