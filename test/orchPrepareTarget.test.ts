// qa_prepare_target install consent (MED #13): every install is consent-gated (like iOS) — an
// in-root APK included — and APK containment is decided on normalized real paths, so
// `<root>/sub/../../outside/x.apk` is an EXTERNAL install (higher risk + hash), not "inside root".

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-pt-home-'));
process.env.HOME = fakeHome;
delete process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;

vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  adbDevices: vi.fn(async () => ['emulator-5554']),
  listAvds: vi.fn(async () => []),
  apkPackageId: vi.fn(async () => 'com.example.app'),
}));
vi.mock('../src/lib/spawn.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spawn.js')>()),
  // pm list packages → nothing installed; getprop → emulator.
  run: vi.fn(async (_bin: string, args: string[]) => ({
    code: 0,
    stdout: args.includes('getprop') ? '[ro.kernel.qemu]: [1]\n[sys.boot_completed]: [1]\n' : '',
    stderr: '',
    timedOut: false,
  })),
}));

const { createServer } = await import('../src/server.js');
const { apkWithinRoot } = await import('../src/tools/prepareTarget.js');
type SessionStore = import('../src/session/store.js').SessionStore;

const base = mkdtempSync(join(tmpdir(), 'swipium-pt-'));
const root = join(base, 'app');
mkdirSync(join(root, 'sub'), { recursive: true });
mkdirSync(join(base, 'outside'), { recursive: true });
writeFileSync(join(root, 'build.gradle'), '');
writeFileSync(join(root, 'app.apk'), 'PK-in');
writeFileSync(join(base, 'outside', 'x.apk'), 'PK-out');

let client: Client;
let sessions: SessionStore;
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const sc = (r: CallToolResult) => (r.structuredContent ?? {}) as Record<string, unknown>;

beforeAll(async () => {
  const ctx = createServer();
  sessions = ctx.sessions;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'pt-test', version: '0' });
  await Promise.all([ctx.server.connect(st), client.connect(ct)]);
});
afterAll(async () => {
  await client.close();
  rmSync(base, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('apkWithinRoot', () => {
  it('normalizes .. segments before deciding containment', () => {
    expect(apkWithinRoot(join(root, 'app.apk'), root)).toBe(true);
    expect(apkWithinRoot(`${root}/sub/../../outside/x.apk`, root)).toBe(false);
    expect(apkWithinRoot(join(base, 'outside', 'x.apk'), root)).toBe(false);
  });
});

describe('qa_prepare_target consent', () => {
  it('an in-root APK install on a live emulator still requires consent (low risk)', async () => {
    const s = sessions.create(root, undefined, {});
    const r = await call('qa_prepare_target', { sessionId: s.id, appId: 'com.example.app', apk: join(root, 'app.apk') });
    const out = sc(r);
    expect(out.requiresConsent).toBe(true);
    expect(out.risk).toBe('low');
    expect(JSON.stringify(out.affects)).toContain('install_apk');
  });

  it('a ../ path escaping the root is an EXTERNAL install (hashed, medium risk)', async () => {
    const s = sessions.create(root, undefined, {});
    const r = await call('qa_prepare_target', { sessionId: s.id, appId: 'com.example.app', apk: `${root}/sub/../../outside/x.apk` });
    const out = sc(r);
    expect(out.requiresConsent).toBe(true);
    expect(out.risk).toBe('medium');
    expect(JSON.stringify(out.affects)).toContain('install_external_apk');
  });
});
