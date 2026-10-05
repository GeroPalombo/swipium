// I1: MCP conformance over REAL stdio. Every other MCP test uses InMemoryTransport, which never
// exercises the binary's stdout framing, stderr logging, stdin EOF handling or process exit.
// Here the project is compiled into a temp outDir (never ./dist, which other tests and the
// release build use) and spawned as `node <tmp>/dist/index.js` with the SDK's
// StdioClientTransport. Device access is hermetic: HOME, ANDROID_HOME and PATH point at a temp
// fake `adb` that logs every call and reports no devices. Device discovery stays ENABLED
// (SWIPIUM_DISABLE_DEVICE_DISCOVERY unset) so qa_wait really polls adb.
//
// Two protocol generations against the same binary:
//  - 2025: the SDK Client (default `initialize` negotiation, 2025-11-25);
//  - 2026-07-28: raw JSON-RPC (server/discover, per-request `_meta`, NO initialize), including the
//    consent prompt carried by an InputRequiredResult. For that part the fake adb also reports one
//    booted emulator while the ADB_DEVICE_FLAG file exists, so qa_network reaches its consent gate.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { PROMPT_COUNT, REMOVED_TOOLS, SWIPIUM_VERSION, TOOL_COUNT, TOOL_NAMES } from '../src/version.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FAKE_ADB = `#!/bin/sh
echo "$(date +%s) $*" >> "$ADB_LOG"
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\\n'
  [ -n "$ADB_DEVICE_FLAG" ] && [ -f "$ADB_DEVICE_FLAG" ] && printf 'emulator-5554\\tdevice\\n'
  printf '\\n'
  exit 0
fi
case "$*" in
  *"shell getprop sys.boot_completed") echo 1 ;;
  *"shell getprop ro.build.version.sdk") echo 34 ;;
  *"shell getprop") printf '[ro.kernel.qemu]: [1]\\n[sys.boot_completed]: [1]\\n[ro.build.version.sdk]: [34]\\n' ;;
esac
exit 0
`;

/** The compiled binary + hermetic fake environment, built once for every describe below. */
interface Fixture {
  work: string;
  entry: string;
  adbLog: string;
  project: string;
  env: Record<string, string>;
}
let fixture: Promise<Fixture> | undefined;
function prepareFixture(): Promise<Fixture> {
  fixture ??= (async () => {
    const work = mkdtempSync(join(tmpdir(), 'swipium-stdio-'));
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
    const entry = join(build, 'dist', 'index.js');
    expect(existsSync(entry)).toBe(true);

    // Fake Android SDK: the same logging adb on PATH and under ANDROID_HOME/platform-tools.
    const sdk = join(work, 'sdk');
    const bin = join(sdk, 'platform-tools');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'adb'), FAKE_ADB);
    chmodSync(join(bin, 'adb'), 0o755);
    const adbLog = join(work, 'adb.log');
    writeFileSync(adbLog, '');
    const home = join(work, 'home');
    mkdirSync(home);
    const project = join(work, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'stdio-probe-app', version: '0.0.0' }));

    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
    delete base.SWIPIUM_DISABLE_DEVICE_DISCOVERY;
    delete base.SWIPIUM_PROJECT_ROOT;
    delete base.CLAUDE_PROJECT_DIR;
    delete base.SWIPIUM_LOG_LEVEL;
    delete base.SWIPIUM_CONSENT_PREAPPROVE;
    delete base.SWIPIUM_REQUIRE_ELICITATION;
    delete base.NODE_OPTIONS; // vitest may inject loaders; the binary must run as shipped
    const env = {
      ...base,
      HOME: home,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      ADB_LOG: adbLog,
      NODE_NO_WARNINGS: '1', // Node's own runtime warnings are not Swipium output
    };
    return { work, entry, adbLog, project, env };
  })();
  return fixture;
}

afterAll(async () => {
  const f = await fixture?.catch(() => undefined);
  if (f?.work) rmSync(f.work, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('stdio conformance (real binary)', () => {
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
    ({ entry, adbLog, project, env } = await prepareFixture());

    transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: project, env, stderr: 'pipe' });
    transport.stderr?.on('data', (d: Buffer) => stderrChunks.push(d.toString('utf8')));
    client = new Client({ name: 'stdio-conformance', version: '0' }, { capabilities: {} });
    client.onerror = (e) => transportErrors.push(e);
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
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

  it('an unknown resource is -32602 with the URI in data (SDK v2; Swipium <= 2.1 sent -32002)', async () => {
    const err = await client.readResource({ uri: 'swipium://session/x/y/z' }).then(
      () => undefined,
      (e: { code?: number; data?: { uri?: string } }) => e,
    );
    expect(err?.code).toBe(-32602);
    expect(err?.data?.uri).toBe('swipium://session/x/y/z');
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
      .callTool({ name: 'qa_wait', arguments: { sessionId, for: 'device_online', timeoutMs: 30_000 } }, { signal: ac.signal })
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

type RawMsg = {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

/** A spawned binary spoken to in raw newline-delimited JSON-RPC, as a protocol 2026-07-28 client:
 * every request carries the per-request `_meta` envelope; nothing ever sends `initialize`. */
function spawnModern(f: Fixture, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [f.entry], { cwd: f.project, env: { ...f.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdoutErrors: string[] = [];
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => stderr.push(d));
  let buf = '';
  let nextId = 0;
  const waiters = new Map<number, (m: RawMsg) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as RawMsg;
        if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
      } catch {
        stdoutErrors.push(line);
      }
    }
  });
  const meta = (caps: Record<string, unknown>) => ({
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'stdio-conformance-2026', version: '0' },
    'io.modelcontextprotocol/clientCapabilities': caps,
  });
  const send = (m: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const start = (method: string, params: Record<string, unknown> = {}, caps: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const reply = new Promise<RawMsg>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no response to ${method}`)), 15_000);
      waiters.set(id, (m) => {
        clearTimeout(t);
        res(m);
      });
    });
    send({ id, method, params: { ...params, _meta: meta(caps) } });
    return { id, reply };
  };
  return {
    child,
    stderr,
    stdoutErrors,
    start,
    request: (method: string, params?: Record<string, unknown>, caps?: Record<string, unknown>) => start(method, params, caps).reply,
    notify: (method: string, params: Record<string, unknown>) => send({ method, params }),
    close: async () => {
      const exited = new Promise((r) => child.once('exit', r));
      child.stdin.end();
      await Promise.race([exited, sleep(3_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

describe.skipIf(process.platform === 'win32')('stdio conformance, protocol 2026-07-28 (real binary, raw JSON-RPC)', () => {
  const ELICIT = { elicitation: { form: {}, url: {} }, roots: {} }; // what Claude Code 2.1.289 declares
  let f: Fixture;
  let deviceFlag = '';
  let srv: ReturnType<typeof spawnModern>;
  const adbLines = (re: RegExp) =>
    readFileSync(f.adbLog, 'utf8')
      .split('\n')
      .filter((l) => re.test(l)).length;
  const sc = (m: RawMsg) => (m.result?.structuredContent ?? {}) as Record<string, unknown>;

  beforeAll(async () => {
    f = await prepareFixture();
    deviceFlag = join(f.work, 'device-online');
    srv = spawnModern(f, { ADB_DEVICE_FLAG: deviceFlag });
  }, 120_000);

  afterAll(async () => {
    await srv?.close();
  });

  it('answers server/discover with 2026-07-28, identity, instructions and cache hints (no initialize)', async () => {
    const r = (await srv.request('server/discover')).result!;
    expect(r.supportedVersions).toContain('2026-07-28');
    expect((r.capabilities as Record<string, unknown>).tools).toBeDefined();
    expect((r._meta as Record<string, { name: string; version: string }>)['io.modelcontextprotocol/serverInfo']).toEqual({
      name: 'swipium',
      version: SWIPIUM_VERSION,
    });
    expect(typeof r.instructions).toBe('string');
    expect(r).toMatchObject({ resultType: 'complete', ttlMs: 3_600_000, cacheScope: 'public' });
  });

  it('tools/list is complete, sorted by name, cacheable and free of $schema', async () => {
    const r = (await srv.request('tools/list')).result!;
    const tools = r.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(TOOL_COUNT);
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(tools.every((t) => !('$schema' in t.inputSchema))).toBe(true);
    expect(r).toMatchObject({ resultType: 'complete', ttlMs: 3_600_000, cacheScope: 'public' });
    const prompts = (await srv.request('prompts/list')).result!;
    expect(prompts.prompts).toHaveLength(PROMPT_COUNT);
  });

  it('tools/call happy path carries resultType complete', async () => {
    const r = await srv.request('tools/call', { name: 'qa_status', arguments: {} });
    expect(r.result?.resultType).toBe('complete');
    expect(sc(r).ok).toBe(true);
  });

  it('INVALID_ARGUMENT and STALE_CLIENT envelopes keep their shape', async () => {
    const bad = await srv.request('tools/call', { name: 'qa_status', arguments: { bogus: 1 } });
    expect(bad.result?.isError).toBe(true);
    expect(sc(bad)).toMatchObject({ failureCode: 'INVALID_ARGUMENT', unknownArguments: ['bogus'] });
    const missing = await srv.request('tools/call', { name: 'qa_act', arguments: {} });
    expect(sc(missing).failureCode).toBe('INVALID_ARGUMENT');
    const removed = Object.keys(REMOVED_TOOLS)[0];
    const stale = await srv.request('tools/call', { name: removed, arguments: {} });
    expect(sc(stale)).toMatchObject({ failureCode: 'STALE_CLIENT', removedCall: removed });
  });

  it('an unknown resource is -32602 with the URI in data; resources/list is never cached', async () => {
    const r = await srv.request('resources/read', { uri: 'swipium://session/x/y/z' });
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.data?.uri).toBe('swipium://session/x/y/z');
    const list = (await srv.request('resources/list')).result!;
    expect(list).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
  });

  it('project root falls back to the cwd without roots/list, even when the client declares roots', async () => {
    const r = await srv.request('tools/call', { name: 'qa_start_session', arguments: {} }, ELICIT);
    expect(sc(r)).toMatchObject({ ok: true, rootSource: 'cwd' });
    expect(realpathSync(String(sc(r).projectRoot))).toBe(realpathSync(f.project)); // macOS /var > /private/var
  });

  it('notifications/cancelled stops qa_wait adb polling within ~2 s', async () => {
    const s = await srv.request('tools/call', { name: 'qa_start_session', arguments: { projectRoot: f.project } });
    const sessionId = sc(s).sessionId;
    expect(sessionId).toBeTruthy();
    const devicesCalls = () => adbLines(/\sdevices\b/);
    const before = devicesCalls();
    const pending = srv.start('tools/call', { name: 'qa_wait', arguments: { sessionId, for: 'device_online', timeoutMs: 30_000 } });
    await sleep(2_500);
    expect(devicesCalls()).toBeGreaterThan(before);
    srv.notify('notifications/cancelled', { requestId: pending.id, reason: 'test cancel' });
    await sleep(2_000);
    const atCancel = devicesCalls();
    await sleep(3_000);
    expect(devicesCalls()).toBe(atCancel);
  }, 20_000);

  describe('consent via InputRequiredResult (qa_network on a fake booted emulator)', () => {
    let sessionId = '';
    const enable = () => adbLines(/airplane-mode enable/);
    const disable = () => adbLines(/airplane-mode disable/);
    const call = (args: Record<string, unknown>, caps: Record<string, unknown> = ELICIT, extra: Record<string, unknown> = {}) =>
      srv.request('tools/call', { name: 'qa_network', arguments: args, ...extra }, caps);
    const answer = (args: Record<string, unknown>, requestState: unknown, response: Record<string, unknown>) =>
      call(args, ELICIT, { requestState, inputResponses: { swipium_consent: response } });

    beforeAll(async () => {
      writeFileSync(deviceFlag, '1');
      const s = await srv.request('tools/call', { name: 'qa_start_session', arguments: { projectRoot: f.project } });
      sessionId = String(sc(s).sessionId);
    });

    it('accept + approve runs the action once; a replayed answer is rejected', async () => {
      const args = { sessionId, action: 'offline' };
      const first = await call(args);
      expect(first.result?.resultType).toBe('input_required');
      const ask = (first.result!.inputRequests as Record<string, { method: string; params: Record<string, unknown> }>).swipium_consent;
      expect(ask.method).toBe('elicitation/create');
      expect(ask.params.message).toMatch(/network_change/);
      expect(JSON.stringify(first.result)).not.toMatch(/consentId/);
      expect(enable()).toBe(0);
      const state = first.result!.requestState;
      const done = await answer(args, state, { action: 'accept', content: { approve: true } });
      expect(done.result?.resultType).toBe('complete');
      expect(sc(done).ok).toBe(true);
      expect(enable()).toBe(1);
      const replay = await answer(args, state, { action: 'accept', content: { approve: true } });
      expect(replay.error).toMatchObject({ code: -32602, data: { reason: 'invalid_request_state' } });
      expect(enable()).toBe(1);
    }, 20_000);

    it('decline > CONSENT_DECLINED, cancel > CONSENT_CANCELLED, nothing runs', async () => {
      const args = { sessionId, action: 'online' };
      const a = await call(args);
      const declined = await answer(args, a.result!.requestState, { action: 'decline' });
      expect(sc(declined)).toMatchObject({ failureCode: 'CONSENT_DECLINED', changedState: false });
      const b = await call(args);
      const cancelled = await answer(args, b.result!.requestState, { action: 'cancel' });
      expect(sc(cancelled)).toMatchObject({ failureCode: 'CONSENT_CANCELLED', retrySafe: true });
      expect(disable()).toBe(0);
    });

    it('a forged or re-targeted answer is rejected and never runs the action', async () => {
      const forged = await answer({ sessionId, action: 'online' }, 'swp1.forged', { action: 'accept', content: { approve: true } });
      expect(forged.error?.code).toBe(-32602);
      const a = await call({ sessionId, action: 'online' });
      const moved = await answer({ sessionId, action: 'offline' }, a.result!.requestState, {
        action: 'accept',
        content: { approve: true },
      });
      expect(moved.error?.code).toBe(-32602);
      const spent = await answer({ sessionId, action: 'online' }, a.result!.requestState, { action: 'accept', content: { approve: true } });
      expect(spent.error?.code).toBe(-32602);
      expect(disable()).toBe(0);
      expect(enable()).toBe(1);
    });

    it('a client without form elicitation gets the portable consent envelope', async () => {
      const r = await call({ sessionId, action: 'online' }, { roots: {} });
      expect(r.result?.resultType).toBe('complete');
      expect(sc(r)).toMatchObject({ requiresConsent: true, action: 'network_change' });
      expect(typeof sc(r).consentId).toBe('string');
      expect(disable()).toBe(0);
    });

    it('an operator pre-approved action skips the prompt', async () => {
      const pre = spawnModern(f, { ADB_DEVICE_FLAG: deviceFlag, SWIPIUM_CONSENT_PREAPPROVE: 'network_change' });
      try {
        const s = await pre.request('tools/call', { name: 'qa_start_session', arguments: { projectRoot: f.project } });
        const r = await pre.request(
          'tools/call',
          { name: 'qa_network', arguments: { sessionId: sc(s).sessionId, action: 'online' } },
          ELICIT,
        );
        expect(r.result?.resultType).toBe('complete');
        expect(sc(r).ok).toBe(true);
        expect(disable()).toBe(1);
      } finally {
        await pre.close();
      }
    }, 20_000);
  });

  it('exits within 3 s when stdin closes mid-call', async () => {
    const one = spawnModern(f);
    try {
      await one.request('server/discover');
      const s = await one.request('tools/call', { name: 'qa_start_session', arguments: { projectRoot: f.project } });
      one.start('tools/call', { name: 'qa_wait', arguments: { sessionId: sc(s).sessionId, for: 'device_online', timeoutMs: 30_000 } });
      await sleep(500);
      const exited = new Promise<number>((res) => one.child.once('exit', () => res(Date.now())));
      const closedAt = Date.now();
      one.child.stdin.end();
      const exitedAt = await Promise.race([exited, sleep(3_000).then(() => undefined)]);
      expect(exitedAt, 'process still alive 3 s after stdin closed').toBeDefined();
      expect(exitedAt! - closedAt).toBeLessThanOrEqual(3_000);
    } finally {
      if (one.child.exitCode === null && one.child.signalCode === null) one.child.kill('SIGKILL');
    }
  }, 20_000);

  it('keeps stdout pure JSON-RPC and stderr JSON lines', () => {
    expect(srv.stdoutErrors).toEqual([]);
    const lines = srv.stderr.join('').split('\n').filter(Boolean);
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
});
