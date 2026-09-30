// Real-device smoke (2.0.0): qa_flow_check / qa_flow_run mode:"plan" without a session failed
// "Flow not found. Looked for: (no project root)" even with SWIPIUM_PROJECT_ROOT set, and the
// error was failureCode UNKNOWN. Flow tools now resolve the root like every other tool
// (projectRoot arg → session → MCP roots → env → cwd marker) and return typed codes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-flow-root-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

function makeProject(flowName: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-flow-root-project-')));
  mkdirSync(join(root, '.swipium', 'flows'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"flow-root-fixture"}');
  writeFileSync(
    join(root, '.swipium', 'flows', `${flowName}.yaml`),
    `name: ${flowName}\nsteps:\n  - assertVisible: Home\n  - tap: Start\n`,
  );
  return root;
}

const envRoot = makeProject('env-smoke');
const argRoot = makeProject('arg-smoke');
const savedEnv = process.env.SWIPIUM_PROJECT_ROOT;
process.env.SWIPIUM_PROJECT_ROOT = envRoot;

const { createServer } = await import('../src/server.js');

describe('flow tools resolve the project root without a session', () => {
  let client: Client;
  beforeAll(async () => {
    const ctx = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'flow-root-test', version: '0' });
    await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
  });
  afterAll(async () => {
    await client.close();
    if (savedEnv === undefined) delete process.env.SWIPIUM_PROJECT_ROOT;
    else process.env.SWIPIUM_PROJECT_ROOT = savedEnv;
    for (const d of [fakeHome, envRoot, argRoot]) rmSync(d, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult & { structuredContent: Record<string, unknown> };

  it('qa_flow_check finds a named flow via SWIPIUM_PROJECT_ROOT', async () => {
    const res = await call('qa_flow_check', { flow: 'env-smoke' });
    expect(res.structuredContent.ok).toBe(true);
    expect(res.structuredContent.name).toBe('env-smoke');
    expect(String(res.structuredContent.source)).toBe(join(envRoot, '.swipium', 'flows', 'env-smoke.yaml'));
  });

  it('qa_flow_run mode:"plan" finds a named flow via SWIPIUM_PROJECT_ROOT', async () => {
    const res = await call('qa_flow_run', { mode: 'plan', flow: 'env-smoke', backend: 'android-direct' });
    expect(res.structuredContent.ok).toBe(true);
    expect(res.structuredContent.flow).toBe('env-smoke');
  });

  it('an explicit projectRoot arg wins over the env', async () => {
    const check = await call('qa_flow_check', { flow: 'arg-smoke', projectRoot: argRoot });
    expect(check.structuredContent.ok).toBe(true);
    const plan = await call('qa_flow_run', { mode: 'plan', flow: 'arg-smoke', projectRoot: argRoot, backend: 'ios-wda' });
    expect(plan.structuredContent.ok).toBe(true);
  });

  it('a missing flow is FLOW_NOT_FOUND (not UNKNOWN) and lists where it looked', async () => {
    for (const [tool, extra] of [
      ['qa_flow_check', {}],
      ['qa_flow_run', { mode: 'plan' }],
    ] as const) {
      const res = await call(tool, { flow: 'nope', ...extra });
      expect(res.structuredContent.ok).toBe(false);
      expect(res.structuredContent.failureCode).toBe('FLOW_NOT_FOUND');
      expect(String(res.structuredContent.what)).toContain(join(envRoot, '.swipium', 'flows', 'nope.yaml'));
    }
  });

  it('no flow and no flowYaml is INVALID_ARGUMENT; invalid YAML is INVALID_FLOW', async () => {
    const missing = await call('qa_flow_check', {});
    expect(missing.structuredContent.failureCode).toBe('INVALID_ARGUMENT');
    const invalid = await call('qa_flow_check', { flowYaml: 'steps: 3' });
    expect(invalid.structuredContent.failureCode).toBe('INVALID_FLOW');
  });
});
