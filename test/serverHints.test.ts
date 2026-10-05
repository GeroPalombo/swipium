// Stale-client hints: removed 1.5 tool names and legacy call shapes (qa_ios wda_* / screenshot,
// qa_wait for:"job_done") return a typed STALE_CLIENT error with the replacement call + hint,
// not a raw "Tool not found" / zod validation message. Also: tools/list carries no per-schema
// `$schema` key and still validates in the SDK client.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-serverhints-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer } = await import('../src/server.js');
const { REMOVED_TOOLS, STALE_CLIENT_HINT, TOOL_COUNT } = await import('../src/version.js');

describe('stale-client hints + tools/list shape', () => {
  let client: Client;
  beforeAll(async () => {
    const ctx = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'server-hints-test', version: '0' });
    await Promise.all([ctx.server.connect(s), client.connect(c)]);
  });
  afterAll(async () => {
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;

  it.each(Object.keys(REMOVED_TOOLS))('removed tool %s → STALE_CLIENT with the replacement', async (name) => {
    const res = await call(name, { sessionId: 'x' });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.failureCode).toBe('STALE_CLIENT');
    expect(sc.replacement).toBe(REMOVED_TOOLS[name]);
    expect(sc.clientHint).toBe(STALE_CLIENT_HINT);
  });

  it('legacy qa_ios wda_attach / screenshot and qa_wait job_done → STALE_CLIENT', async () => {
    const wda = (await call('qa_ios', { sessionId: 'x', action: 'wda_attach' })).structuredContent as Record<string, unknown>;
    expect(wda.failureCode).toBe('STALE_CLIENT');
    expect(wda.replacement).toMatch(/qa_wda .*action: "attach"/);
    const shot = (await call('qa_ios', { sessionId: 'x', action: 'screenshot' })).structuredContent as Record<string, unknown>;
    expect(shot.replacement).toMatch(/^qa_screenshot/);
    const wait = (await call('qa_wait', { sessionId: 'x', for: 'job_done', jobId: 'j' })).structuredContent as Record<string, unknown>;
    expect(wait.failureCode).toBe('STALE_CLIENT');
    expect(wait.replacement).toMatch(/qa_job_status/);
  });

  it('genuinely unknown tools stay the SDK error; ordinary validation errors are INVALID_ARGUMENT, not STALE_CLIENT', async () => {
    const unknown = await call('qa_definitely_not_a_tool', {});
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toBeUndefined();
    const bad = await call('qa_ios', { sessionId: 'x', action: 'bogus' });
    expect(bad.isError).toBe(true);
    // validationEnvelope.test.ts covers the envelope itself
    expect((bad.structuredContent as Record<string, unknown>).failureCode).toBe('INVALID_ARGUMENT');
    expect(String((bad.structuredContent as Record<string, unknown>).what)).toMatch(/^qa_ios: invalid arguments: action: /);
  });

  it('tools/list: no $schema per inputSchema, and the SDK client validates it', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(TOOL_COUNT);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect('$schema' in t.inputSchema, t.name).toBe(false);
    }
    // descriptions did not grow legacy enum values
    const ios = tools.find((t) => t.name === 'qa_ios')!;
    expect(JSON.stringify(ios.inputSchema)).not.toMatch(/wda_attach|"screenshot"/);
  });
});
