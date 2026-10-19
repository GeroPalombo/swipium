// qa_test_this called without sessionId creates its session before asking for the test_this_plan
// consent. The approved re-invocation (elicitation, operator pre-approval, or the 2026
// InputRequiredResult retry) must run IN that session: no second session, and the requested and
// approved ledger rows land on the same one. The consent is minted in the session's scope, so it
// cannot be spent from another session. The pipeline is stubbed (no device work runs).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport as ServerInMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-ttconsent-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
delete process.env.SWIPIUM_CONSENT_PREAPPROVE;

const env = vi.hoisted(() => ({ avds: ['Pixel_7'] as string[] }));

vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  which: vi.fn(async (bin: string) => bin === 'adb' || bin === 'emulator'),
  firstLine: vi.fn(async () => null),
  adbDevices: vi.fn(async () => []),
  listAvds: vi.fn(async () => [...env.avds]),
  findAapt2: vi.fn(() => null),
  apkPackageId: vi.fn(async () => 'com.example.app'),
}));
vi.mock('../src/lib/simctl.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/simctl.js')>()),
  simctlAvailable: vi.fn(async () => false),
  listSimulators: vi.fn(async () => []),
}));
vi.mock('../src/lib/spawn.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spawn.js')>()),
  run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'mocked', timedOut: false })),
}));
const pipeline = vi.hoisted(() => ({ ran: [] as string[], crash: false }));
vi.mock('../src/orchestration/testThis/pipeline.js', () => ({
  runExecutePipeline: vi.fn(
    async (
      sessions: import('../src/session/store.js').SessionStore,
      session: import('../src/session/store.js').Session,
      job: import('../src/session/store.js').JobRecord,
    ) => {
      pipeline.ran.push(session.id);
      if (pipeline.crash) throw new Error('report writer exploded');
      sessions.updateJobIfRunning(session, job, { status: 'done', result: { state: 'completed' }, endedAt: Date.now() });
    },
  ),
}));

const { createServer, consentReinvokeArgs, CONSENT_INPUT_KEY } = await import('../src/server.js');
const { setElicitationProvider } = await import('../src/consent/consent.js');
type SessionStore = import('../src/session/store.js').SessionStore;

const tmp = mkdtempSync(join(tmpdir(), 'swipium-ttconsent-'));
function androidApp(): string {
  const root = join(tmp, `android-${Math.random().toString(36).slice(2)}`);
  const files: Record<string, string> = {
    'settings.gradle': "include ':app'",
    'build.gradle': '',
    'app/build.gradle': "android { defaultConfig { applicationId 'com.example.app' } }",
    'app/build/outputs/apk/debug/app-debug.apk': 'PK-fake-apk',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const sc = (r: { structuredContent?: unknown }) => (r.structuredContent ?? {}) as Record<string, unknown>;
const sessionsFor = (sessions: SessionStore, root: string) => sessions.list().filter((s) => s.root === root);
const planRows = (sessions: SessionStore, id: string) =>
  sessions
    .get(id)!
    .mutations.filter((m) => m.action === 'test_this_plan')
    .map((m) => m.status);

beforeEach(() => {
  pipeline.ran = [];
  pipeline.crash = false;
  delete process.env.SWIPIUM_CONSENT_PREAPPROVE;
});
afterAll(() => {
  setElicitationProvider(undefined);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('consentReinvokeArgs', () => {
  it('adds the envelope session only when the call had none', () => {
    expect(consentReinvokeArgs({ mode: 'execute' }, 'c1', 'S1')).toEqual({
      mode: 'execute',
      sessionId: 'S1',
      consentId: 'c1',
      approve: true,
    });
    expect(consentReinvokeArgs({ sessionId: 'S0' }, 'c1', 'S1')).toEqual({ sessionId: 'S0', consentId: 'c1', approve: true });
    expect(consentReinvokeArgs({ mode: 'execute' }, 'c1', undefined)).toEqual({ mode: 'execute', consentId: 'c1', approve: true });
  });
});

describe('qa_test_this without sessionId through the 2025 server', () => {
  let client: Client;
  let sessions: SessionStore;
  let answer: { action: 'accept'; content: { approve: boolean } } = { action: 'accept', content: { approve: true } };

  beforeAll(async () => {
    const ctx = createServer();
    sessions = ctx.sessions;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'tt-consent', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async () => answer);
    await Promise.all([ctx.server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    await client.close();
  });
  beforeEach(() => {
    answer = { action: 'accept', content: { approve: true } };
  });

  it('an elicitation approval runs the job in the session the first call created', async () => {
    const root = androidApp();
    const r = (await client.callTool({
      name: 'qa_test_this',
      arguments: { projectRoot: root, mode: 'execute', goal: 'smoke' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(sc(r).jobId).toBeTypeOf('string');
    const all = sessionsFor(sessions, root);
    expect(all).toHaveLength(1);
    expect(sc(r).sessionId).toBe(all[0].id);
    expect(pipeline.ran).toEqual([all[0].id]);
    expect(planRows(sessions, all[0].id)).toEqual(['requested', 'approved']);
  });

  it('an operator pre-approval runs the job in the same session too', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'test_this_plan';
    const root = androidApp();
    const r = (await client.callTool({
      name: 'qa_test_this',
      arguments: { projectRoot: root, mode: 'execute', goal: 'smoke' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const all = sessionsFor(sessions, root);
    expect(all).toHaveLength(1);
    expect(pipeline.ran).toEqual([all[0].id]);
    expect(planRows(sessions, all[0].id)).toEqual(['requested', 'approved']);
    const approved = sessions.get(all[0].id)!.mutations.find((m) => m.action === 'test_this_plan' && m.status === 'approved');
    expect(approved?.consent?.approvalMechanism).toBe('operator-policy');
  });
  it('a pipeline crash that escapes its own handler marks the job failed, not running forever', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'test_this_plan';
    pipeline.crash = true;
    const root = androidApp();
    const r = sc(await client.callTool({ name: 'qa_test_this', arguments: { projectRoot: root, mode: 'execute', goal: 'smoke' } }));
    const job = sessions.get(r.sessionId as string)!.jobs.get(r.jobId as string)!;
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(job.error).toContain('report writer exploded');
  });
});

describe('qa_test_this consent is bound to its session (client-assertion)', () => {
  let client: Client;

  beforeAll(async () => {
    const ctx = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'tt-consent-portable', version: '0' });
    await Promise.all([ctx.server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    await client.close();
  });

  it('cannot be spent by a re-call that would create another session, but works in its own', async () => {
    const root = androidApp();
    const first = sc(await client.callTool({ name: 'qa_test_this', arguments: { projectRoot: root, mode: 'execute', goal: 'smoke' } }));
    expect(first.requiresConsent).toBe(true);
    const consentId = first.consentId as string;
    const elsewhere = sc(
      await client.callTool({
        name: 'qa_test_this',
        arguments: { projectRoot: root, mode: 'execute', goal: 'smoke', consentId, approve: true },
      }),
    );
    expect(elsewhere.requiresConsent).toBe(true);
    expect(String(elsewhere.consentNote)).toMatch(/different session/);
    expect(pipeline.ran).toEqual([]);
    const own = sc(
      await client.callTool({
        name: 'qa_test_this',
        arguments: { sessionId: first.sessionId, mode: 'execute', goal: 'smoke', consentId, approve: true },
      }),
    );
    expect(own.jobId).toBeTypeOf('string');
    expect(pipeline.ran).toEqual([first.sessionId]);
  });
});

describe('qa_test_this without sessionId through the 2026 InputRequiredResult retry', () => {
  let sessions: SessionStore;
  let transport: ServerInMemoryTransport;
  let handle: { close(): Promise<void> };
  let nextId = 0;
  type Msg = { id?: number; result?: Record<string, unknown> };
  const waiters = new Map<number, (m: Msg) => void>();
  const ELICIT = { elicitation: { form: {} } };
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Msg>((resolve, reject) => {
      const id = ++nextId;
      const t = setTimeout(() => reject(new Error(`no response to ${method}`)), 10_000);
      waiters.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      void transport.send({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'tt-p2026', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': ELICIT,
          },
        },
      });
    });

  beforeAll(async () => {
    const { SessionStore } = await import('../src/session/store.js');
    sessions = new SessionStore();
    const [clientSide, serverSide] = ServerInMemoryTransport.createLinkedPair();
    transport = clientSide;
    transport.onmessage = (m) => {
      const msg = m as Msg;
      if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
    };
    await transport.start();
    handle = serveStdio(({ era }) => createServer({ era, sessions }).server, { transport: serverSide });
    await request('server/discover');
  });
  afterAll(async () => {
    await handle.close();
  });

  it('the answered retry runs in the session the first call created', async () => {
    const root = androidApp();
    const args = { projectRoot: root, mode: 'execute', goal: 'smoke' };
    const first = await request('tools/call', { name: 'qa_test_this', arguments: args });
    expect(first.result?.resultType).toBe('input_required');
    const done = await request('tools/call', {
      name: 'qa_test_this',
      arguments: args,
      requestState: first.result!.requestState,
      inputResponses: { [CONSENT_INPUT_KEY]: { action: 'accept', content: { approve: true } } },
    });
    expect(sc(done.result ?? {}).jobId).toBeTypeOf('string');
    const all = sessionsFor(sessions, root);
    expect(all).toHaveLength(1);
    expect(pipeline.ran).toEqual([all[0].id]);
    expect(planRows(sessions, all[0].id)).toEqual(['requested', 'approved']);
  });
});
