// qa_test_feature execute on a valid session that has no driver prepares THAT session (its own
// root), never a new one from the projectRoot argument, and the bootstrap consent carries the
// sessionId so consent re-calls keep reusing it instead of creating a session per call.
// Hermetic: adb/simctl are mocked and the device prepare is stubbed.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-featboot-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
delete process.env.SWIPIUM_CONSENT_PREAPPROVE;

vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  which: vi.fn(async (bin: string) => bin === 'adb' || bin === 'emulator'),
  firstLine: vi.fn(async () => null),
  adbDevices: vi.fn(async () => []),
  listAvds: vi.fn(async () => ['Pixel_7']),
  findAapt2: vi.fn(() => null),
  apkPackageId: vi.fn(async () => 'com.example.app'),
}));
vi.mock('../src/lib/simctl.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/simctl.js')>()),
  simctlAvailable: vi.fn(async () => false),
  listSimulators: vi.fn(async () => []),
}));
vi.mock('../src/lib/spawn.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spawn.js')>()),
  run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'mocked', timedOut: false })),
}));
vi.mock('../src/services/prepareAndroid.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/prepareAndroid.js')>()),
  prepareAndroid: vi.fn(async () => ({ ok: false, failureCode: 'NO_DEVICE', error: 'stubbed prepare' })),
}));

const { createServer } = await import('../src/server.js');
type SessionStore = import('../src/session/store.js').SessionStore;

const tmp = mkdtempSync(join(tmpdir(), 'swipium-featboot-'));
function androidApp(name: string): string {
  const root = join(tmp, name);
  const files: Record<string, string> = {
    'settings.gradle': "include ':app'",
    'build.gradle': '',
    'app/build.gradle': "android { defaultConfig { applicationId 'com.example.app' } }",
    'app/build/outputs/apk/debug/app-debug.apk': 'PK-fake-apk',
    'app/src/main/java/com/example/LoginScreen.kt': 'class LoginScreen { fun login() {} }',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const sc = (r: CallToolResult) => (r.structuredContent ?? {}) as Record<string, unknown>;

let client: Client;
let sessions: SessionStore;
beforeAll(async () => {
  const ctx = createServer();
  sessions = ctx.sessions;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'feat-boot', version: '0' });
  await Promise.all([ctx.server.connect(st), client.connect(ct)]);
});
afterAll(async () => {
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;

describe('qa_test_feature bootstrap on an existing session', () => {
  it('prepares the given session (its root), not a new one from projectRoot, across consent re-calls', async () => {
    const root = androidApp('own');
    const elsewhere = androidApp('elsewhere');
    const sessionId = sc(await call('qa_start_session', { projectRoot: root })).sessionId as string;
    const before = sessions.list().length;
    const first = sc(await call('qa_test_feature', { sessionId, projectRoot: elsewhere, feature: 'login', mode: 'execute' }));
    expect(first.requiresConsent).toBe(true);
    expect(first.sessionId).toBe(sessionId);
    expect(JSON.stringify(first)).toContain(root);
    expect(JSON.stringify(first)).not.toContain(elsewhere);
    // A re-call (here: a stale consent id) still reuses the same session.
    const again = sc(await call('qa_test_feature', { sessionId, feature: 'login', mode: 'execute', consentId: 'deadbeef', approve: true }));
    expect(again.requiresConsent).toBe(true);
    expect(again.sessionId).toBe(sessionId);
    expect(sessions.list().length).toBe(before);
    const rows = sessions.get(sessionId)!.mutations.filter((m) => m.tool === 'qa_test_feature' && m.action === 'test_this_plan');
    expect(rows.map((m) => m.status)).toEqual(['requested', 'requested']);
  });

  it('a bootstrap without sessionId carries the new sessionId on its consent, and the consent is bound to it', async () => {
    const root = androidApp('fresh');
    const first = sc(await call('qa_test_feature', { projectRoot: root, feature: 'login', mode: 'execute' }));
    expect(first.requiresConsent).toBe(true);
    const sessionId = first.sessionId as string;
    expect(sessions.get(sessionId)?.root).toBe(root);
    const before = sessions.list().length;
    const own = await call('qa_test_feature', { sessionId, feature: 'login', mode: 'execute', consentId: first.consentId, approve: true });
    expect(sc(own).requiresConsent).toBeUndefined();
    expect(sc(own).sessionId).toBe(sessionId);
    expect(sessions.list().length).toBe(before);
    expect(sessions.get(sessionId)!.mutations.some((m) => m.action === 'test_this_plan' && m.status === 'approved')).toBe(true);
  });
});
