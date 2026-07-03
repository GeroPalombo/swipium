// Error-envelope contract (v1-mvp-plan P1 §6): EVERY public tool, invoked with inputs
// crafted to fail fast (an unknown sessionId where the schema has one; minimal valid-shape
// args otherwise), must return a structured qaError envelope — `ok:false` with `what`,
// `failureCode`, `changedState`, `retrySafe`, and a non-empty `nextSteps` (src/lib/result.ts)
// — never an unhandled schema/runtime crash. Hermetic: HOME is a temp dir, device discovery
// is disabled, and every spawn/network seam is mocked to reject, so no tool can touch a real
// device, binary, or the network even if its failure path were missed.

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES } from '../src/version.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-contract-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

// Hard spawn/network kill-switch: reaching a real binary or socket from this test is a bug.
vi.mock('node:child_process', () => {
  const blocked = (): never => {
    throw new Error('child_process is disabled in the error-contract test');
  };
  return { spawn: blocked, spawnSync: blocked, exec: blocked, execFile: blocked, execSync: blocked, fork: blocked, default: {} };
});
vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  const rejected = () => Promise.reject(new Error('spawning is disabled in the error-contract test'));
  return { ...actual, run: rejected, runBinary: rejected };
});

const { createServer } = await import('../src/server.js');

const MISSING_SESSION = 'no-such-session';
const MISSING_ROOT = '/nonexistent/swipium-error-contract';
const MISSING_URI = 'swipium://session/none/report/missing.json';

/** Tools whose crafted call legitimately succeeds (static/read-only answers that need no
 * session or device). Asserted exactly — any other tool returning ok:true is a missed
 * failure path and fails the suite. */
const EXPECTED_OK = new Set<string>([
  'qa_agent_brief', // static orientation brief — no session, device, or fs involved
  'qa_capabilities', // static grouped listing of the tool surface
  'qa_doctor', // diagnostic envelope succeeds even when readiness checks fail
]);

/** Extra args for tools whose fail-fast path needs specific fields beyond the generated
 * minimal ones. */
const ARG_OVERRIDES: Record<string, Record<string, unknown>> = {
  qa_start_session: { projectRoot: MISSING_ROOT },
  qa_get_artifact: { uri: MISSING_URI },
};

interface JsonSchema {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

function minimalValue(name: string, schema: JsonSchema): unknown {
  if (name === 'sessionId') return MISSING_SESSION;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.anyOf?.length) return minimalValue(name, schema.anyOf[0]);
  switch (schema.type) {
    case 'string':
      if (/uri$/i.test(name)) return MISSING_URI;
      if (/root|path/i.test(name)) return MISSING_ROOT;
      return 'x';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const req of schema.required ?? []) {
        const prop = schema.properties?.[req];
        if (prop) out[req] = minimalValue(req, prop);
      }
      return out;
    }
    default:
      return 'x';
  }
}

/** Required fields get minimal valid-shape values; a sessionId property is ALWAYS set (even
 * when optional) so session-scoped tools hit their unknown-session fail-fast path. */
function craftArgs(inputSchema: JsonSchema | undefined, overrides: Record<string, unknown> | undefined): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = inputSchema?.properties ?? {};
  for (const req of inputSchema?.required ?? []) {
    if (props[req]) args[req] = minimalValue(req, props[req]);
  }
  if (props.sessionId && args.sessionId === undefined) args.sessionId = MISSING_SESSION;
  return { ...args, ...(overrides ?? {}) };
}

describe('error-envelope contract across the full tool surface', () => {
  let client: Client;
  const schemas = new Map<string, JsonSchema | undefined>();

  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('network disabled in the error-contract test'))),
    );
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'error-contract-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    for (const tool of (await client.listTools()).tools) {
      schemas.set(tool.name, tool.inputSchema as JsonSchema | undefined);
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it.each(TOOL_NAMES)('%s returns a structured qaError envelope (never a crash)', async (name) => {
    const args = craftArgs(schemas.get(name), ARG_OVERRIDES[name]);

    let res: CallToolResult;
    try {
      res = (await client.callTool({ name, arguments: args })) as CallToolResult;
    } catch (e) {
      throw new Error(`tool call crashed with a protocol-level error instead of a qaError envelope: ${String(e)}`, { cause: e });
    }

    const s = res.structuredContent as Record<string, unknown> | undefined;

    if (res.isError) {
      // An MCP-level error WITHOUT the structured qaError payload means the handler threw —
      // exactly the unhandled-crash class this contract forbids.
      expect(s, `handler threw instead of returning qaError. content: ${JSON.stringify(res.content)}`).toBeTruthy();
    }
    expect(s, `no structuredContent in response: ${JSON.stringify(res.content)}`).toBeTruthy();

    if (s!.ok === true) {
      expect(
        EXPECTED_OK.has(name),
        `${name} returned ok:true — add a failure-path arg override (or, if genuinely static, to EXPECTED_OK): ${JSON.stringify(s)}`,
      ).toBe(true);
      return;
    }

    // qaError contract (src/lib/result.ts QaErrorPayload).
    expect(s!.ok, `expected ok:false, got ${JSON.stringify(s)}`).toBe(false);
    expect(res.isError, 'qaError envelopes must also set isError:true').toBe(true);
    expect(typeof s!.what).toBe('string');
    expect((s!.what as string).length).toBeGreaterThan(0);
    expect(typeof s!.failureCode).toBe('string');
    expect((s!.failureCode as string).length).toBeGreaterThan(0);
    expect(typeof s!.changedState).toBe('boolean');
    expect(typeof s!.retrySafe).toBe('boolean');
    expect(Array.isArray(s!.nextSteps), `nextSteps missing: ${JSON.stringify(s)}`).toBe(true);
    expect((s!.nextSteps as unknown[]).length, 'nextSteps must be non-empty').toBeGreaterThan(0);
    for (const step of s!.nextSteps as unknown[]) expect(typeof step).toBe('string');
  });
});
