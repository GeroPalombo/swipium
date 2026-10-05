// I7: SWIPIUM_LOG_LEVEL filters stderr lines below the level, and at debug the tool wrapper emits
// one metadata-only line per call (never argument values).

import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-loglevel-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { log, currentLogLevel, logEnabled } = await import('../src/lib/logger.js');
const { createServer } = await import('../src/server.js');

const prevLevel = process.env.SWIPIUM_LOG_LEVEL;

function captureStderr(): { lines: () => Record<string, unknown>[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => {
  if (prevLevel === undefined) delete process.env.SWIPIUM_LOG_LEVEL;
  else process.env.SWIPIUM_LOG_LEVEL = prevLevel;
});

describe('logger level filter', () => {
  it('defaults to info and ignores unknown values', () => {
    delete process.env.SWIPIUM_LOG_LEVEL;
    expect(currentLogLevel()).toBe('info');
    process.env.SWIPIUM_LOG_LEVEL = 'chatty';
    expect(currentLogLevel()).toBe('info');
    process.env.SWIPIUM_LOG_LEVEL = ' DEBUG ';
    expect(currentLogLevel()).toBe('debug');
  });

  it('inherited Object names (constructor, __proto__, toString) are unknown values, not a silencer', () => {
    for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      process.env.SWIPIUM_LOG_LEVEL = v;
      expect(currentLogLevel(), v).toBe('info');
      expect(logEnabled('error'), v).toBe(true);
      expect(logEnabled('info'), v).toBe(true);
      expect(logEnabled('debug'), v).toBe(false);
    }
  });

  it('drops lines below the level', () => {
    const cap = captureStderr();
    try {
      delete process.env.SWIPIUM_LOG_LEVEL;
      log('debug', 'd0');
      log('info', 'i0');
      process.env.SWIPIUM_LOG_LEVEL = 'warn';
      log('info', 'i1');
      log('warn', 'w1');
      log('error', 'e1');
      process.env.SWIPIUM_LOG_LEVEL = 'error';
      log('warn', 'w2');
      log('error', 'e2');
      process.env.SWIPIUM_LOG_LEVEL = 'debug';
      log('debug', 'd3');
    } finally {
      cap.restore();
    }
    expect(cap.lines().map((l) => l.msg)).toEqual(['i0', 'w1', 'e1', 'e2', 'd3']);
    process.env.SWIPIUM_LOG_LEVEL = 'error';
    expect(logEnabled('warn')).toBe(false);
    expect(logEnabled('error')).toBe(true);
  });
});

describe('per-call debug line', () => {
  const ctx = createServer();
  const client = new Client({ name: 'loglevel-test', version: '0' });

  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([ctx.server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  const SECRET = 'hunter2-should-never-be-logged';

  it('logs tool, sessionId, durationMs, isError, failureCode, cancelled and never argument values', async () => {
    process.env.SWIPIUM_LOG_LEVEL = 'debug';
    const cap = captureStderr();
    try {
      await client.callTool({ name: 'qa_status', arguments: {} });
      await client.callTool({ name: 'qa_note', arguments: { sessionId: 'no-such-session', workflow: SECRET, outcome: 'pass' } });
    } finally {
      cap.restore();
    }
    const calls = cap.lines().filter((l) => l.msg === 'tool call');
    expect(calls).toHaveLength(2);
    const [status, note] = calls;
    expect(status).toMatchObject({ level: 'debug', tool: 'qa_status', isError: false, cancelled: false });
    expect(typeof status.durationMs).toBe('number');
    expect(status.sessionId).toBeUndefined();
    expect(note).toMatchObject({ tool: 'qa_note', sessionId: 'no-such-session', isError: true, cancelled: false });
    expect(typeof note.failureCode).toBe('string');
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(Object.keys(note).sort()).toEqual([
      'cancelled',
      'durationMs',
      'failureCode',
      'isError',
      'level',
      'msg',
      'sessionId',
      'tool',
      'ts',
    ]);
  });

  it('envelopes built before the handler runs (unknown argument, schema validation) still log a tool-call line', async () => {
    process.env.SWIPIUM_LOG_LEVEL = 'debug';
    const cap = captureStderr();
    try {
      await client.callTool({ name: 'qa_status', arguments: { [SECRET]: 1 } });
      await client.callTool({ name: 'qa_get_artifact', arguments: {} });
    } finally {
      cap.restore();
    }
    const calls = cap.lines().filter((l) => l.msg === 'tool call');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ tool: 'qa_status', isError: true, failureCode: 'INVALID_ARGUMENT', cancelled: false });
    expect(calls[1]).toMatchObject({ tool: 'qa_get_artifact', isError: true, failureCode: 'INVALID_ARGUMENT' });
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it('emits nothing at the default level', async () => {
    delete process.env.SWIPIUM_LOG_LEVEL;
    const cap = captureStderr();
    try {
      await client.callTool({ name: 'qa_status', arguments: {} });
    } finally {
      cap.restore();
    }
    expect(cap.lines().filter((l) => l.msg === 'tool call')).toHaveLength(0);
  });
});
