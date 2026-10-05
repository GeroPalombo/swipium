// I4: input validation failures (missing required arg, wrong type) used to come back as an isError
// text "MCP error -32602: Input validation error: ..." with a raw zod dump and no structuredContent.
// Swipium's own tools/call handler validates against each tool's strict schema before the handler
// runs and returns the typed INVALID_ARGUMENT envelope. Unknown tool names keep the SDK 1.x answer.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-validation-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer, invalidArgumentsError } = await import('../src/server.js');
const { checkToolArgs, strictToolSchema } = await import('../src/lib/toolSchema.js');
const { z } = await import('zod');

let client: Client;
beforeAll(async () => {
  const ctx = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'validation-envelope-test', version: '0' });
  await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
});
afterAll(async () => {
  await client.close();
  rmSync(fakeHome, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
const sc = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;

describe('input validation > INVALID_ARGUMENT envelope', () => {
  it('missing required argument', async () => {
    const res = await call('qa_get_artifact', {});
    expect(res.isError).toBe(true);
    const s = sc(res);
    expect(s.failureCode).toBe('INVALID_ARGUMENT');
    expect(s.ok).toBe(false);
    expect(s.retrySafe).toBe(true);
    expect(s.changedState).toBe(false);
    expect(String(s.what)).toContain('uri: Required');
    expect(String(s.what)).not.toContain('"code"'); // no raw zod dump
    expect(s.acceptedParameters).toEqual(['uri', 'mode']);
    expect((s.invalidArguments as Array<{ path: string }>)[0].path).toBe('uri');
    expect((s.nextSteps as string[]).join(' ')).toContain('"uri"');
  });

  it('wrong type and bad enum value, all fields listed', async () => {
    const res = await call('qa_get_artifact', { uri: 5, mode: 'bogus' });
    const s = sc(res);
    expect(s.failureCode).toBe('INVALID_ARGUMENT');
    expect(String(s.what)).toMatch(/uri: Expected string, received number/);
    expect(String(s.what)).toMatch(/mode: /);
  });

  it('unknown tool stays the SDK error (no envelope)', async () => {
    const res = await call('qa_definitely_not_a_tool', {});
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(JSON.stringify(res.content)).toMatch(/not found/);
  });

  it('legacy call shapes still map to STALE_CLIENT', async () => {
    const res = await call('qa_wait', { sessionId: 'x', for: 'job_done' });
    expect(sc(res).failureCode).toBe('STALE_CLIENT');
  });

  it('checkToolArgs reports nested paths with array indexes, and the envelope joins them', () => {
    const schema = strictToolSchema({ steps: z.array(z.object({ text: z.string() })), n: z.number().optional() });
    const bad = checkToolArgs(schema, { steps: [{ text: 1 }], n: 'x' });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.map((i) => i.path)).toEqual(['steps[0].text', 'n']);
    const s = invalidArgumentsError('qa_x', bad.issues, bad.total, ['steps', 'n']).structuredContent as Record<string, unknown>;
    expect(s.what).toBe(
      'qa_x: invalid arguments: steps[0].text: Expected string, received number; n: Expected number, received string. Nothing was run.',
    );
    expect(s.acceptedParameters).toEqual(['steps', 'n']);
    expect(checkToolArgs(schema, { steps: [] })).toEqual({ ok: true, data: { steps: [] } });
  });

  it('strict schemas reject undeclared keys (unknownArguments envelope precedes per-field issues)', async () => {
    const s = sc(await call('qa_get_artifact', { uri: 5, bogus: 1 }));
    expect(s.failureCode).toBe('INVALID_ARGUMENT');
    expect(s.unknownArguments).toEqual(['bogus']);
    expect(checkToolArgs(strictToolSchema({ a: z.string() }), { a: 'x', b: 1 }).ok).toBe(false);
  });
});

describe('echoed caller input is capped (a 2 MB key used to produce a 10 MB response)', () => {
  const key = 'k'.repeat(2 * 1024 * 1024);

  it('unknown top-level argument with a 2 MB name', async () => {
    const res = await call('qa_status', { [key]: 1 });
    expect(res.isError).toBe(true);
    const s = sc(res);
    expect(s.failureCode).toBe('INVALID_ARGUMENT');
    expect(JSON.stringify(res).length).toBeLessThan(64 * 1024);
    const shown = (s.unknownArguments as string[])[0];
    expect(shown.length).toBeLessThan(130);
    expect(shown).toMatch(/^k{100}\.\.\.\[2097152 chars\]$/);
    expect((s.nextSteps as string[])[0].length).toBeLessThan(2100);
  });

  it('many unknown keys are listed up to 20, with a count', async () => {
    const args = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`bogus${i}`, i]));
    const s = sc(await call('qa_status', args));
    expect((s.unknownArguments as string[]).length).toBe(20);
    expect(s.unknownArgumentCount).toBe(500);
    expect(String(s.what)).toContain('(+480 more)');
  });

  it('a validation issue path through a record key is capped', async () => {
    const res = await call('qa_smoke', { sessionId: 's', variables: { [key]: 5 } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res).length).toBeLessThan(64 * 1024);
    const issues = sc(res).invalidArguments as Array<{ path: string; message: string }>;
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) expect(i.path.length).toBeLessThan(130);
  });
});
