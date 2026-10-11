// 2.3.0 review R2: qa_ios launch / terminate / openurl change the screen outside WDA, so a
// snapshot taken just before them must stop counting as fresh (text/id targets reuse a fresh one).
// Hermetic: temp HOME, simctl mocked.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-ios-stale-')));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const UDID = '190EA878-5D54-416C-B858-E60588B0DAF9';
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return {
    ...actual,
    simctlAvailable: async () => true,
    listSimulators: async () => [{ udid: UDID, name: 'iPhone 17', state: 'Booted', runtime: 'iOS 26.0' }],
    launchApp: async () => undefined,
    terminateApp: async () => undefined,
    openUrl: async () => undefined,
    isInstalled: async () => true,
  };
});

const { createServer } = await import('../src/server.js');
const { SimctlDriver } = await import('../src/drivers/SimctlDriver.js');
const { actionSeq, freshSnapshot } = await import('../src/snapshot/fresh.js');
type SessionStore = import('../src/session/store.js').SessionStore;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-ios-stale-proj-')));
writeFileSync(join(root, 'package.json'), '{"name":"iosstale"}');

let client: Client;
let sessions: SessionStore;
beforeAll(async () => {
  const ctx = createServer();
  sessions = ctx.sessions;
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'iosstale', version: '0' });
  await Promise.all([ctx.server.connect(s), client.connect(c)]);
});
afterAll(async () => {
  await client.close();
  for (const d of [fakeHome, root]) rmSync(d, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) =>
  ((await client.callTool({ name, arguments: args })) as CallToolResult).structuredContent as Record<string, unknown>;

describe('qa_ios screen changes mark the stored snapshot stale', () => {
  it.each([
    ['launch', { bundleId: 'com.apple.Preferences' }],
    ['terminate', { bundleId: 'com.apple.Preferences' }],
    ['openurl', { url: 'prefs:root=General' }],
  ])('%s', async (action, extra) => {
    const sessionId = (await call('qa_start_session', { projectRoot: root })).sessionId as string;
    const s = sessions.get(sessionId)!;
    s.driver = new SimctlDriver(UDID);
    s.device = UDID;
    s.lastSnapshot = { fullByRef: new Map(), signatures: new Set(), allNodes: [], at: Date.now(), actionSeq: actionSeq(s) };
    expect(freshSnapshot(s, 60_000)).toBeDefined();
    const res = await call('qa_ios', { sessionId, action, ...extra });
    expect(res.ok).toBe(true);
    expect(freshSnapshot(s, 60_000)).toBeUndefined();
  });
});
