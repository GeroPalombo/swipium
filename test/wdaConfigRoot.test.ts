// Real-device smoke (2.0.0): qa_doctor checked the WDA cache under the SERVER cwd instead of the
// resolved project root (SWIPIUM_PROJECT_ROOT), and qa_wda echoed the configured default
// `wdaConfig.derivedDataPath` instead of the derivedDataPath the caller passed.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-wda-root-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

// No real toolchain probing: Xcode/simctl/WDA status are stubbed; config + root logic stay real.
vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return {
    ...actual,
    xcodeAvailable: async () => ({ available: true, version: 'Xcode 26.0' }),
    checkWda: async () => ({ reachable: false, ready: false }),
  };
});
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return { ...actual, simctlAvailable: async () => true, listSimulators: async () => [] };
});

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-wda-root-project-')));
mkdirSync(join(root, '.swipium'), { recursive: true });
writeFileSync(join(root, 'package.json'), '{"name":"wda-root-fixture"}');
writeFileSync(join(root, '.swipium', 'config.json'), JSON.stringify({ ios: { wda: { derivedDataPath: 'custom-dd' } } }));
const savedEnv = process.env.SWIPIUM_PROJECT_ROOT;
process.env.SWIPIUM_PROJECT_ROOT = root;

const { createServer } = await import('../src/server.js');

describe('WDA config is read from the resolved project root', () => {
  let client: Client;
  beforeAll(async () => {
    const ctx = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'wda-root-test', version: '0' });
    await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
  });
  afterAll(async () => {
    await client.close();
    if (savedEnv === undefined) delete process.env.SWIPIUM_PROJECT_ROOT;
    else process.env.SWIPIUM_PROJECT_ROOT = savedEnv;
    for (const d of [fakeHome, root]) rmSync(d, { recursive: true, force: true });
  });

  const sc = (r: unknown) => (r as CallToolResult).structuredContent as Record<string, unknown>;

  it('qa_doctor checks the WDA cache under SWIPIUM_PROJECT_ROOT, not the server cwd', async () => {
    expect(process.cwd()).not.toBe(root);
    const res = sc(await client.callTool({ name: 'qa_doctor', arguments: { platform: 'ios' } }));
    const wda = res.wda as { projectRoot: string; config: { derivedDataPath: string }; buildProduct: { checkedPath: string } };
    expect(wda.projectRoot).toBe(root);
    expect(wda.config.derivedDataPath).toBe(join(root, 'custom-dd'));
    expect(wda.buildProduct.checkedPath).toBe(join(root, 'custom-dd'));
  });

  it('qa_wda echoes the derivedDataPath that was passed (resolved), not the configured default', async () => {
    const sessionId = sc(await client.callTool({ name: 'qa_start_session', arguments: { projectRoot: root } })).sessionId as string;
    const res = sc(await client.callTool({ name: 'qa_wda', arguments: { sessionId, action: 'tune', derivedDataPath: 'passed/dd' } }));
    expect((res.wdaConfig as { derivedDataPath: string }).derivedDataPath).toBe(join(root, 'passed', 'dd'));
    const abs = join(root, 'abs-dd');
    const res2 = sc(await client.callTool({ name: 'qa_wda', arguments: { sessionId, action: 'tune', derivedDataPath: abs } }));
    expect((res2.wdaConfig as { derivedDataPath: string }).derivedDataPath).toBe(abs);
  });
});
