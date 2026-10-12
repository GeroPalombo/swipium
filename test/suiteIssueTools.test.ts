// Tool contracts through the in-memory MCP server (no device, HOME is a temp dir):
//  - qa_suite_update refuses an unsafe case id (path traversal, over-long) and writes nothing;
//  - qa_issue_log: re-logging an issue without `severity` keeps the stored severity,
//    an explicit severity still wins, and an uncategorized manual log says it was filed for triage.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
const { createServer } = await import('../src/server.js');

let client: Client;
const roots: string[] = [];
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'swipium-r3-tools-'));
  roots.push(r);
  return r;
};
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const sc = (r: CallToolResult) => (r.structuredContent ?? {}) as Record<string, unknown>;
const text = (r: CallToolResult) => (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  const { server } = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'r3-tools-test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
});
afterAll(async () => {
  await client.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('qa_suite_update case ids (an unvalidated id became a file path)', () => {
  it('a path-traversal id is INVALID_ARGUMENT and nothing is written', async () => {
    const projectRoot = newRoot();
    const escape = join(dirname(projectRoot), 'x.yaml');
    const r = await call('qa_suite_update', { projectRoot, source: 'manual', cases: [{ id: '../../../../x', title: 'Login works' }] });
    expect(r.isError).toBe(true);
    expect(sc(r).failureCode).toBe('INVALID_ARGUMENT');
    expect(text(r)).toMatch(/omit it to get an allocated id/);
    expect(existsSync(join(projectRoot, '.swipium'))).toBe(false);
    expect(existsSync(escape)).toBe(false);
  });

  it('a 300-char id is INVALID_ARGUMENT; omitting the id allocates a safe one', async () => {
    const projectRoot = newRoot();
    const long = await call('qa_suite_update', { projectRoot, source: 'manual', cases: [{ id: 'a'.repeat(300), title: 'Long id' }] });
    expect(sc(long).failureCode).toBe('INVALID_ARGUMENT');
    const ok = await call('qa_suite_update', { projectRoot, source: 'manual', cases: [{ title: 'Login works', functionality: 'Login' }] });
    expect(ok.isError).toBeFalsy();
    const created = JSON.stringify(sc(ok));
    expect(created).toMatch(/TC-[A-Z0-9]+-\d{3}/);
    // Mirror files stay inside .swipium (never outside the project).
    expect(readdirSync(projectRoot)).toEqual(['.swipium']);
  });
});

describe('qa_issue_log severity on re-log', () => {
  const obs = {
    title: 'Coupon field rejects valid codes',
    summary: 'Coupon field shows "invalid" for a valid code on the cart screen',
    platform: 'android',
  };

  it('keeps high when re-logged without severity; an explicit low still wins; a defaulted category is explained', async () => {
    const projectRoot = newRoot();
    const first = sc(await call('qa_issue_log', { projectRoot, mode: 'log', ...obs, severity: 'high' }));
    const issueId = first.issueId as string;
    expect(issueId).toBeTruthy();
    expect(JSON.stringify(first)).toMatch(/categoryNote|filed as mcp_limitation/);

    const again = sc(await call('qa_issue_log', { projectRoot, mode: 'log', ...obs }));
    expect(again.issueId).toBe(issueId);
    // history filtered by severity lists the issue only under its current severity.
    const listed = async (severity: string) =>
      JSON.stringify(sc(await call('qa_issue_log', { projectRoot, mode: 'history', severity }))).includes(issueId);
    expect(await listed('high')).toBe(true);
    expect(await listed('low')).toBe(false);

    await call('qa_issue_log', { projectRoot, mode: 'log', ...obs, severity: 'low' });
    expect(await listed('low')).toBe(true);
    expect(await listed('high')).toBe(false);
  });
});
