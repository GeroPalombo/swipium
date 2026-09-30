// Every tool that resolves a project root reports WHERE it came from (`rootSource`, additive),
// and says so in the text when the root was only guessed from the server's working directory.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-rootsource-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
delete process.env.SWIPIUM_PROJECT_ROOT;
delete process.env.CLAUDE_PROJECT_DIR;

const { createServer } = await import('../src/server.js');

describe('rootSource on project-root-resolving tools', () => {
  let client: Client;
  let project: string;
  const originalCwd = process.cwd();

  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-rootsource-app-')));
    writeFileSync(join(project, 'package.json'), '{"name":"app"}'); // a project marker → usable cwd
    const { server } = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'root-source-test', version: '0' }); // no MCP roots capability
    await Promise.all([server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    process.chdir(originalCwd);
    await client.close();
    rmSync(project, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('a cwd-sourced root is reported as rootSource:"cwd" with an override note in the text', async () => {
    process.chdir(project);
    const res = (await client.callTool({ name: 'qa_issue_log', arguments: { mode: 'history' } })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.rootSource).toBe('cwd');
    expect(sc.projectRoot).toBe(project);
    const text = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).toContain(`project root taken from server cwd: ${project}; pass projectRoot to override`);
  });

  it('an explicit projectRoot is rootSource:"arg" and carries no cwd note', async () => {
    const res = (await client.callTool({ name: 'qa_issue_log', arguments: { mode: 'history', projectRoot: project } })) as CallToolResult;
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.rootSource).toBe('arg');
    const text = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).not.toContain('taken from server cwd');
  });
});
