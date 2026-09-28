// Remote-WDA hardening: the repository config can no longer point iOS automation at a remote WDA
// (qa_wda: allowNonLoopbackUrls in .swipium/config.json no longer skips consent; prepareIos never
// auto-connects to a non-loopback ios.wda.url). Only a per-call consent or the user-level
// SWIPIUM_ALLOW_REMOTE_WDA pre-approves. `::1` counts as loopback. `qa_wda start` refuses while
// a live managed WDA exists for the session (the old one used to be orphaned).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-wdasec-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
delete process.env.SWIPIUM_ALLOW_REMOTE_WDA;

const probes: string[] = [];
vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return {
    ...actual,
    xcodeAvailable: async () => ({ available: true, version: 'Xcode 26.0' }),
    checkWda: async (url: string) => (probes.push(url), { reachable: false, ready: false }),
    createWdaSession: async (url: string) => {
      probes.push(url);
      throw new Error('connect ECONNREFUSED');
    },
  };
});
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return {
    ...actual,
    simctlAvailable: async () => true,
    listSimulators: async () => [{ udid: 'SIM-1', name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' }],
  };
});

const REMOTE = 'http://10.9.8.7:8100';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-wdasec-project-')));
mkdirSync(join(root, '.swipium'), { recursive: true });
writeFileSync(join(root, 'package.json'), '{"name":"wdasec"}');
writeFileSync(
  join(root, '.swipium', 'config.json'),
  JSON.stringify({ ios: { wda: { url: REMOTE, allowNonLoopbackUrls: [REMOTE], reuse: false } } }),
);

const { isLoopbackWdaUrl, remoteWdaAllowedByUser } = await import('../src/lib/wda.js');
const { createServer } = await import('../src/server.js');
const { prepareIos } = await import('../src/services/prepareIos.js');
type SessionStore = import('../src/session/store.js').SessionStore;

describe('loopback detection', () => {
  it('treats [::1], localhost and 127/8 as loopback; others not', () => {
    expect(isLoopbackWdaUrl('http://[::1]:8100')).toBe(true);
    expect(isLoopbackWdaUrl('http://localhost:8100')).toBe(true);
    expect(isLoopbackWdaUrl('http://127.0.0.2:8100')).toBe(true);
    expect(isLoopbackWdaUrl(REMOTE)).toBe(false);
    expect(isLoopbackWdaUrl('http://localhost.evil.example:8100')).toBe(false);
    expect(isLoopbackWdaUrl('http://127.0.0.1.evil.example')).toBe(false);
    expect(isLoopbackWdaUrl('file:///etc/passwd')).toBe(false);
  });
  it('SWIPIUM_ALLOW_REMOTE_WDA is an exact-URL list', () => {
    expect(remoteWdaAllowedByUser(REMOTE, { SWIPIUM_ALLOW_REMOTE_WDA: `http://a:1, ${REMOTE}/` })).toBe(true);
    expect(remoteWdaAllowedByUser(REMOTE, { SWIPIUM_ALLOW_REMOTE_WDA: 'http://10.9.8.7:8101' })).toBe(false);
    expect(remoteWdaAllowedByUser(REMOTE, {})).toBe(false);
  });
});

describe('remote WDA from repository config', () => {
  let client: Client;
  let sessions: SessionStore;
  beforeAll(async () => {
    const ctx = createServer();
    sessions = ctx.sessions;
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'wdasec', version: '0' });
    await Promise.all([ctx.server.connect(s), client.connect(c)]);
  });
  afterAll(async () => {
    await client.close();
    for (const d of [fakeHome, root]) rmSync(d, { recursive: true, force: true });
  });
  beforeEach(() => {
    probes.length = 0;
    delete process.env.SWIPIUM_ALLOW_REMOTE_WDA;
  });

  const sc = (r: unknown) => (r as CallToolResult).structuredContent as Record<string, unknown>;
  const newSession = async () =>
    sc(await client.callTool({ name: 'qa_start_session', arguments: { projectRoot: root } })).sessionId as string;

  it('qa_wda: repo allowNonLoopbackUrls no longer pre-approves — refused, nothing contacted', async () => {
    const sessionId = await newSession();
    const res = sc(await client.callTool({ name: 'qa_wda', arguments: { sessionId, action: 'attach' } }));
    expect(res.failureCode).toBe('DESTRUCTIVE_REFUSED');
    expect(String(res.what)).toContain('repository config');
    expect(probes).toEqual([]);
  });

  it('qa_wda: allowNonLoopback → consent prompt labelled as repository-configured', async () => {
    const sessionId = await newSession();
    const res = sc(await client.callTool({ name: 'qa_wda', arguments: { sessionId, action: 'attach', allowNonLoopback: true } }));
    expect(res.requiresConsent).toBe(true);
    expect(String(res.explain)).toMatch(/configured by the repository \(\.swipium\/config\.json\) — unreviewed/);
    expect(probes).toEqual([]);
  });

  it('qa_wda: user-level SWIPIUM_ALLOW_REMOTE_WDA pre-approves that exact URL', async () => {
    process.env.SWIPIUM_ALLOW_REMOTE_WDA = REMOTE;
    const sessionId = await newSession();
    const res = sc(await client.callTool({ name: 'qa_wda', arguments: { sessionId, action: 'attach' } }));
    expect(res.requiresConsent).toBeUndefined();
    expect(res.failureCode).not.toBe('DESTRUCTIVE_REFUSED');
    expect(probes).toContain(REMOTE);
  });

  it('prepareIos never auto-connects to a non-loopback repo WDA URL', async () => {
    const sessionId = await newSession();
    const session = sessions.get(sessionId)!;
    const auto = await prepareIos(sessions, session, { launch: false, attachWda: 'auto' });
    expect(auto.ok).toBe(true);
    expect(auto.mode).toBe('visual-fallback');
    expect(auto.wda).toEqual({ reachable: false, url: REMOTE });
    const required = await prepareIos(sessions, session, { launch: false, attachWda: 'required' });
    expect(required.ok).toBe(false);
    expect(required.failureCode).toBe('DESTRUCTIVE_REFUSED');
    expect(probes).toEqual([]);
  });

  it('qa_wda start refuses while a live managed WDA is registered for the session', async () => {
    process.env.SWIPIUM_ALLOW_REMOTE_WDA = REMOTE; // get past the URL gate
    const sessionId = await newSession();
    mkdirSync(join(fakeHome, '.swipium'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.swipium', 'processes.json'),
      JSON.stringify([{ pid: process.pid, kind: 'wda', serverPid: process.pid, sessionId, startedAt: Date.now(), endpoint: REMOTE }]),
    );
    const res = sc(
      await client.callTool({
        name: 'qa_wda',
        arguments: { sessionId, action: 'start', device: 'SIM-1', wdaProjectPath: 'WDA.xcodeproj' },
      }),
    );
    expect(res.failureCode).toBe('WDA_START_FAILED');
    expect(res.managedPid).toBe(process.pid);
    expect(res.requiresConsent).toBeUndefined();
    rmSync(join(fakeHome, '.swipium', 'processes.json'), { force: true });
  });
});
