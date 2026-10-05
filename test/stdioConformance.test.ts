// I1: MCP conformance over REAL stdio. Every other MCP test uses InMemoryTransport, which never
// exercises the binary's stdout framing, stderr logging, stdin EOF handling or process exit.
// Here the project is compiled into a temp outDir (never ./dist, which other tests and the
// release build use) and spawned as `node <tmp>/dist/index.js` with the SDK's
// StdioClientTransport. Device access is hermetic: HOME, ANDROID_HOME and PATH point at a temp
// fake `adb` that logs every call and reports no devices. Device discovery stays ENABLED
// (SWIPIUM_DISABLE_DEVICE_DISCOVERY unset) so qa_wait really polls adb.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PROMPT_COUNT, SWIPIUM_VERSION, TOOL_COUNT } from '../src/version.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FAKE_ADB = `#!/bin/sh
echo "$(date +%s) $*" >> "$ADB_LOG"
[ "$1" = "devices" ] && printf 'List of devices attached\\n\\n'
exit 0
`;

describe.skipIf(process.platform === 'win32')('stdio conformance (real binary)', () => {
  let work = '';
  let entry = '';
  let adbLog = '';
  let project = '';
  let env: Record<string, string> = {};
  let transport: StdioClientTransport;
  let client: Client;
  const stderrChunks: string[] = [];
  const transportErrors: Error[] = [];

  const adbDevicesCalls = () =>
    readFileSync(adbLog, 'utf8')
      .split('\n')
      .filter((l) => /\sdevices\b/.test(l)).length;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'swipium-stdio-'));
    // Compiled output must resolve the repo's node_modules and load as ESM.
    const build = join(work, 'build');
    mkdirSync(build);
    writeFileSync(join(build, 'package.json'), JSON.stringify({ type: 'module' }));
    symlinkSync(join(REPO, 'node_modules'), join(build, 'node_modules'), 'dir');
    const tsc = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
    await promisify(execFile)(
      process.execPath,
      [tsc, '-p', join(REPO, 'tsconfig.json'), '--outDir', join(build, 'dist'), '--sourceMap', 'false'],
      { cwd: REPO, maxBuffer: 16 * 1024 * 1024 },
    );
    entry = join(build, 'dist', 'index.js');
    expect(existsSync(entry)).toBe(true);

    // Fake Android SDK: the same logging adb on PATH and under ANDROID_HOME/platform-tools.
    const sdk = join(work, 'sdk');
    const bin = join(sdk, 'platform-tools');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'adb'), FAKE_ADB);
    chmodSync(join(bin, 'adb'), 0o755);
    adbLog = join(work, 'adb.log');
    writeFileSync(adbLog, '');
    const home = join(work, 'home');
    mkdirSync(home);
    project = join(work, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'stdio-probe-app', version: '0.0.0' }));

    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
    delete base.SWIPIUM_DISABLE_DEVICE_DISCOVERY;
    delete base.SWIPIUM_PROJECT_ROOT;
    delete base.CLAUDE_PROJECT_DIR;
    delete base.SWIPIUM_LOG_LEVEL;
    delete base.NODE_OPTIONS; // vitest may inject loaders; the binary must run as shipped
    env = {
      ...base,
      HOME: home,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      ADB_LOG: adbLog,
      NODE_NO_WARNINGS: '1', // Node's own runtime warnings are not Swipium output
    };

    transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: project, env, stderr: 'pipe' });
    transport.stderr?.on('data', (d: Buffer) => stderrChunks.push(d.toString('utf8')));
    client = new Client({ name: 'stdio-conformance', version: '0' }, { capabilities: {} });
    client.onerror = (e) => transportErrors.push(e);
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('initialize reports the source version', () => {
    expect(client.getServerVersion()?.name).toBe('swipium');
    expect(client.getServerVersion()?.version).toBe(SWIPIUM_VERSION);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it('lists every tool, prompt and resource template', async () => {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(TOOL_COUNT);
    const prompts = await client.listPrompts();
    expect(prompts.prompts).toHaveLength(PROMPT_COUNT);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.length).toBeGreaterThan(0);
  });

  it('qa_status answers', async () => {
    const r = (await client.callTool({ name: 'qa_status', arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { ok?: boolean }).ok).toBe(true);
  });

  it('an unknown tool is an error, not a crash', async () => {
    const r = await client.callTool({ name: 'qa_nope', arguments: {} }).then(
      (v) => ({ isError: (v as CallToolResult).isError === true, code: undefined as number | undefined }),
      (e: { code?: number }) => ({ isError: true, code: e.code }),
    );
    expect(r.isError).toBe(true);
  });

  it('an unknown argument is INVALID_ARGUMENT', async () => {
    const r = (await client.callTool({ name: 'qa_status', arguments: { bogus: 1 } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { failureCode?: string }).failureCode).toBe('INVALID_ARGUMENT');
  });

  it('a missing required argument is an error envelope', async () => {
    const r = (await client.callTool({ name: 'qa_act', arguments: {} })) as CallToolResult;
    expect(r.isError).toBe(true);
    if (r.structuredContent) expect((r.structuredContent as { failureCode?: string }).failureCode).toBe('INVALID_ARGUMENT');
  });

  it('an unknown method is -32601', async () => {
    const err = await client.request({ method: 'swipium/nope', params: {} }, z.object({}).passthrough()).then(
      () => undefined,
      (e: { code?: number }) => e,
    );
    expect(err?.code).toBe(-32601);
  });

  it('an unknown resource is -32002', async () => {
    const err = await client.readResource({ uri: 'swipium://session/x/y/z' }).then(
      () => undefined,
      (e: { code?: number }) => e,
    );
    expect(err?.code).toBe(-32002);
  });

  it('a 4 MB argument gets a small error and keeps the connection', async () => {
    const r = (await client.callTool({
      name: 'qa_get_artifact',
      arguments: { uri: `swipium://session/x/${'a'.repeat(4_000_000)}` },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThan(100_000);
    const again = (await client.callTool({ name: 'qa_status', arguments: {} })) as CallToolResult;
    expect(again.isError).toBeFalsy();
  });

  it('serves 20 concurrent calls', async () => {
    const rs = (await Promise.all(
      Array.from({ length: 20 }, () => client.callTool({ name: 'qa_status', arguments: {} })),
    )) as CallToolResult[];
    expect(rs.every((r) => !r.isError)).toBe(true);
  });

  it('cancelling qa_wait stops adb polling within ~2 s', async () => {
    const s = (await client.callTool({ name: 'qa_start_session', arguments: { projectRoot: project } })) as CallToolResult;
    const sessionId = (s.structuredContent as { sessionId?: string }).sessionId;
    expect(sessionId, JSON.stringify(s.structuredContent)).toBeTruthy();
    const before = adbDevicesCalls();
    const ac = new AbortController();
    const pending = client
      .callTool({ name: 'qa_wait', arguments: { sessionId, for: 'device_online', timeoutMs: 30_000 } }, undefined, { signal: ac.signal })
      .catch(() => undefined);
    await sleep(2_500);
    expect(adbDevicesCalls()).toBeGreaterThan(before); // it really was polling
    ac.abort('test cancel');
    await pending;
    await sleep(2_000); // grace for an in-flight poll
    const atCancel = adbDevicesCalls();
    await sleep(3_000);
    expect(adbDevicesCalls()).toBe(atCancel);
  }, 20_000);

  it('keeps stdout pure JSON-RPC and stderr JSON lines', () => {
    expect(transportErrors.map(String)).toEqual([]);
    const lines = stderrChunks.join('').split('\n').filter(Boolean);
    const bad = lines.filter((l) => {
      try {
        JSON.parse(l);
        return false;
      } catch {
        return true;
      }
    });
    expect(bad).toEqual([]);
  });

  it('exits within 3 s when stdin closes mid-call', async () => {
    // Raw spawn (not the SDK transport, whose close() SIGTERMs after 2 s): end stdin while a
    // long qa_wait is in flight and require the process to exit on its own.
    const child = spawn(process.execPath, [entry], { cwd: project, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const waiters = new Map<number, (msg: Record<string, unknown>) => void>();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
      }
    });
    const send = (m: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    const request = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`no response to ${method}`)), 15_000);
        waiters.set(id, (m) => {
          clearTimeout(t);
          res(m);
        });
        send({ id, method, params });
      });
    const exited = new Promise<number>((res) => child.once('exit', () => res(Date.now())));
    try {
      await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } });
      send({ method: 'notifications/initialized' });
      const s = (await request(2, 'tools/call', { name: 'qa_start_session', arguments: { projectRoot: project } })) as {
        result?: { structuredContent?: { sessionId?: string } };
      };
      const sessionId = s.result?.structuredContent?.sessionId;
      expect(sessionId).toBeTruthy();
      send({ id: 3, method: 'tools/call', params: { name: 'qa_wait', arguments: { sessionId, for: 'device_online', timeoutMs: 30_000 } } });
      await sleep(500);
      const closedAt = Date.now();
      child.stdin.end();
      const exitedAt = await Promise.race([exited, sleep(3_000).then(() => undefined)]);
      expect(exitedAt, 'process still alive 3 s after stdin closed').toBeDefined();
      expect(exitedAt! - closedAt).toBeLessThanOrEqual(3_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 30_000);
});
