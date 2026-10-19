// Tool parameter contracts through the in-memory server:
//  - qa_suite_* with an unknown sessionId is the standard unknown-session error, never a silent
//    fallback to another root;
//  - qa_explore's bounds are positive integers;
//  - parameter descriptions say what the code does (qa_wda webDriverAgentUrl default, qa_explore
//    depth, qa_test_feature timeoutMs, qa_prepare_ios_target device matching).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-params-home-'));
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
const { createServer } = await import('../src/server.js');

let client: Client;
const root = mkdtempSync(join(tmpdir(), 'swipium-params-'));
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const sc = (r: CallToolResult) => (r.structuredContent ?? {}) as Record<string, unknown>;

beforeAll(async () => {
  const { server } = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'params-test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
});
afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

describe('qa_suite_* unknown sessionId', () => {
  it.each([
    ['qa_suite_read', {}],
    ['qa_suite_update', { source: 'manual', cases: [{ title: 'Login works' }] }],
    ['qa_suite_generate', {}],
    ['qa_suite_export', { format: 'json' }],
    ['qa_suite_lint', {}],
  ])('%s is INVALID_ARGUMENT naming the session', async (name, extra) => {
    const r = await call(name, { sessionId: 'nope1234', projectRoot: root, ...extra });
    expect(r.isError).toBe(true);
    expect(sc(r).failureCode).toBe('INVALID_ARGUMENT');
    expect(String(sc(r).what)).toContain('Unknown sessionId "nope1234"');
  });
});

describe('qa_explore bounds', () => {
  it.each([
    ['depth', 1.5],
    ['depth', 0],
    ['maxActions', -1],
    ['maxScreens', 2.5],
    ['maxDurationMs', 0],
  ])('%s=%s is rejected', async (key, value) => {
    const sessionId = sc(await call('qa_start_session', { projectRoot: root })).sessionId as string;
    const r = await call('qa_explore', { sessionId, [key]: value });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/INVALID_ARGUMENT|invalid/i);
  });
});

describe('parameter descriptions match the code', () => {
  it('names the real defaults and matching rules', async () => {
    const { tools } = await client.listTools();
    const prop = (tool: string, key: string) =>
      String(
        ((tools.find((t) => t.name === tool)?.inputSchema.properties ?? {}) as Record<string, { description?: string }>)[key]?.description,
      );
    expect(prop('qa_wda', 'webDriverAgentUrl')).toMatch(/this session's WDA.*ios\.wda\.url/);
    expect(prop('qa_explore', 'depth')).toMatch(/Not a depth limit/);
    expect(prop('qa_test_feature', 'timeoutMs')).toMatch(/Ignored/);
    expect(prop('qa_prepare_ios_target', 'device')).toMatch(/exact name/);
    expect(prop('qa_prepare_ios_target', 'device')).not.toMatch(/substring/);
  });
});
