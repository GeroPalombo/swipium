// 2.3.0 MCP surface: SWIPIUM_TOOLS=core, alwaysLoad _meta, description budgets, output schemas,
// no `execution` key, progress notifications while waiting on a job, SWIPIUM_MAX_WAIT_MS, the
// tools/call element cap, client identity on 2026-07-28 connections, the skill resource, and
// compact state.json.

import { describe, expect, it, afterEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-surface-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const {
  createServer,
  clientInfoOf,
  hiddenToolNames,
  toolInputElementCount,
  ALWAYS_LOAD_TOOLS,
  MAX_TOOL_INPUT_ELEMENTS,
  SKILL_RESOURCE_URI,
} = await import('../src/server.js');
const { SERVER_INSTRUCTIONS } = await import('../src/tools/agent.js');
const { maxWaitMs, defaultWaitMs, MAX_JOB_WAIT_MS } = await import('../src/tools/jobs.js');
const { codexCoreTools } = await import('../src/cli/init.js');
const { TOOL_NAMES } = await import('../src/version.js');
const { SKILL_MD } = await import('../src/skills/content.js');

type Tool = { name: string; description?: string; outputSchema?: unknown; execution?: unknown; _meta?: Record<string, unknown> };

async function connect(env: Record<string, string | undefined> = {}) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const ctx = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'surface-test', version: '0' });
    await Promise.all([ctx.server.connect(st), client.connect(ct)]);
    return { ...ctx, client };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const roots: string[] = [];
afterEach(() => {
  delete process.env.SWIPIUM_MAX_WAIT_MS;
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('tools/list', () => {
  it('alwaysLoad on the canonical loop, output schemas on 4 tools, no execution key, no listChanged', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools as Tool[];
    expect(tools).toHaveLength(TOOL_NAMES.length);
    const always = tools.filter((t) => t._meta?.['anthropic/alwaysLoad'] === true).map((t) => t.name);
    expect(always.sort()).toEqual([...ALWAYS_LOAD_TOOLS].sort());
    expect(
      tools
        .filter((t) => t.outputSchema)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['qa_act', 'qa_job_status', 'qa_snapshot', 'qa_test_this']);
    for (const t of tools) expect(t.execution).toBeUndefined();
    expect(client.getServerCapabilities()?.tools?.listChanged).toBeFalsy();
    await client.close();
  });

  it('no tool description and not the server instructions exceed 2048 chars', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools as Tool[];
    for (const t of tools) expect((t.description ?? '').length, t.name).toBeLessThanOrEqual(2048);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    await client.close();
  });

  it('qa_test_this and qa_test_feature document execute as the default mode', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools as Array<
      Tool & { inputSchema: { properties: Record<string, { description?: string }> } }
    >;
    for (const name of ['qa_test_this', 'qa_test_feature']) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.inputSchema.properties.mode.description).toMatch(/^execute \(default/);
    }
    await client.close();
  });
});

describe('SWIPIUM_TOOLS=core', () => {
  it('lists only the core set and explains a call to a hidden tool', async () => {
    const core = new Set(codexCoreTools());
    expect(hiddenToolNames({ SWIPIUM_TOOLS: 'all' }).size).toBe(0);
    const { client } = await connect({ SWIPIUM_TOOLS: 'core' });
    const listed = ((await client.listTools()).tools as Tool[]).map((t) => t.name);
    expect(listed.length).toBeLessThan(TOOL_NAMES.length);
    for (const n of listed) expect(core.has(n)).toBe(true);
    const hidden = TOOL_NAMES.find((n) => !core.has(n))!;
    const r = (await client.callTool({ name: hidden, arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(hidden);
    expect(r.content[0].text).toContain('SWIPIUM_TOOLS=all');
    await client.close();
  });
});

describe('SWIPIUM_MAX_WAIT_MS', () => {
  it('defaults to 50000 and clamps to 1000..230000', () => {
    expect(maxWaitMs({})).toBe(MAX_JOB_WAIT_MS);
    expect(maxWaitMs({ SWIPIUM_MAX_WAIT_MS: '110000' })).toBe(110_000);
    expect(maxWaitMs({ SWIPIUM_MAX_WAIT_MS: '999999' })).toBe(230_000);
    expect(maxWaitMs({ SWIPIUM_MAX_WAIT_MS: '5' })).toBe(1_000);
    expect(maxWaitMs({ SWIPIUM_MAX_WAIT_MS: 'abc' })).toBe(MAX_JOB_WAIT_MS);
    expect(defaultWaitMs({})).toBe(45_000);
    expect(defaultWaitMs({ SWIPIUM_MAX_WAIT_MS: '110000' })).toBe(105_000);
  });

  it('qa_job_status waits past 50 s only when raised (cap read per call)', async () => {
    const { client, sessions } = await connect();
    const root = mkdtempSync(join(tmpdir(), 'swipium-surface-proj-'));
    roots.push(root);
    const s = sessions.create(root);
    const job = sessions.createJob(s, 'test:wait');
    process.env.SWIPIUM_MAX_WAIT_MS = '1000';
    const t0 = Date.now();
    const r = (await client.callTool({ name: 'qa_job_status', arguments: { sessionId: s.id, jobId: job.jobId, waitMs: 60_000 } })) as {
      structuredContent: { waited: { timedOut: boolean; waitedMs: number } };
    };
    expect(r.structuredContent.waited.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
    sessions.updateJob(s, job, { status: 'done' });
    await client.close();
  });
});

describe('report head is not copied twice', () => {
  it('qa_job_status copies only the headline into summary when the result carries reportHead', async () => {
    const { client, sessions } = await connect();
    const root = mkdtempSync(join(tmpdir(), 'swipium-surface-proj-'));
    roots.push(root);
    const s = sessions.create(root);
    const job = sessions.createJob(s, 'test_this:execute');
    const head = 'Verdicts: app PASS\n- finding one';
    sessions.updateJob(s, job, {
      status: 'done',
      result: { state: 'completed', reportHead: head },
      resultText: `test-this completed.\n\n${head}`,
    });
    const r = (await client.callTool({ name: 'qa_job_status', arguments: { sessionId: s.id, jobId: job.jobId } })) as {
      structuredContent: { summary: string; result: { reportHead: string } };
    };
    expect(r.structuredContent.result.reportHead).toBe(head);
    expect(r.structuredContent.summary).not.toContain('finding one');
    await client.close();
  });
});

describe('progress notifications', () => {
  it('qa_job_status emits monotonically increasing notifications/progress while waiting', async () => {
    const { client, sessions } = await connect();
    const root = mkdtempSync(join(tmpdir(), 'swipium-surface-proj-'));
    roots.push(root);
    const s = sessions.create(root);
    const job = sessions.createJob(s, 'test:progress');
    const now = Date.now();
    const step = (statusText: string) =>
      sessions.updateJob(s, job, {
        progress: statusText,
        progressDetail: { phase: 'p', startedAt: now, updatedAt: Date.now(), statusText, userActionRequired: false },
      });
    step('one');
    const timers = [
      setTimeout(() => step('two'), 1_200),
      setTimeout(() => step('three'), 2_400),
      setTimeout(() => sessions.updateJob(s, job, { status: 'done' }), 3_600),
    ];
    const seen: Array<{ progress: number; message?: string }> = [];
    await client.callTool(
      { name: 'qa_job_status', arguments: { sessionId: s.id, jobId: job.jobId, waitMs: 10_000 } },
      { onprogress: (p) => seen.push(p) },
    );
    timers.forEach(clearTimeout);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i].progress).toBeGreaterThan(seen[i - 1].progress);
    expect(seen.map((p) => p.message ?? '').join('|')).toContain('one');
    await client.close();
  });

  it('nothing is sent without a progressToken', async () => {
    const { client, sessions } = await connect();
    const root = mkdtempSync(join(tmpdir(), 'swipium-surface-proj-'));
    roots.push(root);
    const s = sessions.create(root);
    const job = sessions.createJob(s, 'test:noprogress');
    const notes: unknown[] = [];
    client.fallbackNotificationHandler = async (n) => void notes.push(n);
    setTimeout(() => sessions.updateJob(s, job, { status: 'done' }), 1_500);
    await client.callTool({ name: 'qa_job_status', arguments: { sessionId: s.id, jobId: job.jobId, waitMs: 5_000 } });
    expect(notes).toEqual([]);
    await client.close();
  });
});

describe('tools/call argument cap', () => {
  it('counts elements and rejects payloads over MAX_TOOL_INPUT_ELEMENTS', async () => {
    expect(toolInputElementCount({ a: [1, 2, { b: 3 }] })).toBe(5);
    const { client } = await connect();
    const big = Array.from({ length: MAX_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => i);
    const r = (await client.callTool({ name: 'qa_status', arguments: { big } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(String(MAX_TOOL_INPUT_ELEMENTS));
    await client.close();
  });
});

describe('skill resource', () => {
  it(`serves ${'skill://swipium-qa/SKILL.md'} with the shipped SKILL_MD`, async () => {
    const { client } = await connect();
    const listed = (await client.listResources()).resources.map((r) => r.uri);
    expect(listed).toContain(SKILL_RESOURCE_URI);
    const read = await client.readResource({ uri: SKILL_RESOURCE_URI });
    expect((read.contents[0] as { text: string }).text).toBe(SKILL_MD);
    await client.close();
  });
});

describe('client identity', () => {
  it('2025 era: from initialize', async () => {
    const { client, server } = await connect();
    expect(clientInfoOf(server)?.name).toBe('surface-test');
    await client.close();
  });

  it('2026-07-28 (no initialize): from the per-request _meta clientInfo', async () => {
    let instance: ReturnType<typeof createServer>['server'] | undefined;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const waiters = new Map<number, (m: unknown) => void>();
    clientSide.onmessage = (m) => {
      const id = (m as { id?: number }).id;
      if (typeof id === 'number') waiters.get(id)?.(m);
    };
    await clientSide.start();
    const handle = serveStdio(
      ({ era }) => {
        const built = createServer({ era }).server;
        if (era === 'modern') instance = built;
        return built;
      },
      { transport: serverSide },
    );
    let id = 0;
    const request = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((resolve) => {
        const n = ++id;
        waiters.set(n, resolve);
        void clientSide.send({
          jsonrpc: '2.0',
          id: n,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'modern-client', version: '1' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        });
      });
    await request('server/discover');
    await request('tools/call', { name: 'qa_status', arguments: {} });
    expect(instance).toBeDefined();
    expect(clientInfoOf(instance!)?.name).toBe('modern-client');
    await handle.close();
  });
});

describe('state.json', () => {
  it('is written without indentation', () => {
    const { sessions } = createServer();
    const root = mkdtempSync(join(tmpdir(), 'swipium-surface-proj-'));
    roots.push(root);
    const s = sessions.create(root);
    sessions.flushAll();
    const raw = readFileSync(join(s.dir, 'state.json'), 'utf8');
    expect(raw).not.toContain('\n');
    expect(JSON.parse(raw).counts).toEqual({ artifacts: 0, findings: 0, notes: 0 });
  });
});
