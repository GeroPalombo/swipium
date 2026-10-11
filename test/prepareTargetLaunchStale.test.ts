// R2: qa_prepare_target's already-installed launch path changes the screen without counting an
// action, so it must mark the stored session snapshot stale (noteScreenMutation). adb is faked.

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-pls-home-'));
process.env.HOME = fakeHome;
delete process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;

vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  adbDevices: vi.fn(async () => ['emulator-5554']),
  listAvds: vi.fn(async () => []),
}));
vi.mock('../src/lib/spawn.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spawn.js')>()),
  run: vi.fn(async (_bin: string, args: string[]) => {
    const cmd = args.join(' ');
    let stdout = '';
    if (args.includes('getprop')) stdout = '[ro.kernel.qemu]: [1]\n[sys.boot_completed]: [1]\n';
    else if (cmd.includes('pm list packages')) stdout = 'package:com.example.app\n';
    else if (cmd.includes('resolve-activity')) stdout = 'com.example.app/.Main\n';
    else if (cmd.includes('dumpsys')) stdout = 'mCurrentFocus=Window{1 u0 com.example.app/com.example.app.Main}\n';
    return { code: 0, stdout, stderr: '', timedOut: false };
  }),
}));

const { createServer } = await import('../src/server.js');
const { actionSeq } = await import('../src/snapshot/fresh.js');

const root = mkdtempSync(join(tmpdir(), 'swipium-pls-'));
writeFileSync(join(root, 'build.gradle'), '');
let client: Client;
let ctx: ReturnType<typeof createServer>;

beforeAll(async () => {
  ctx = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'pls-test', version: '0' });
  await Promise.all([ctx.server.connect(st), client.connect(ct)]);
});
afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

it('launching an installed app marks the stored snapshot stale', async () => {
  const s = ctx.sessions.create(root, undefined, {});
  const before = actionSeq(s);
  const r = (await client.callTool({
    name: 'qa_prepare_target',
    arguments: { sessionId: s.id, appId: 'com.example.app' },
  })) as CallToolResult;
  expect(JSON.stringify(r.structuredContent)).toContain('launchedOk');
  expect(actionSeq(s)).toBeGreaterThan(before);
});
