// Typed INVALID_ARGUMENT for caller errors (no device, spawn mocked):
//  - unknownSessionError is the one envelope for a bogus sessionId (errorContract.test.ts
//    asserts it across the whole tool surface);
//  - malformed app ids rejected by driver-side validation (assertAndroidAppId) surface as a typed
//    qaError / blocked ledger / flow failureCode instead of a raw throw or UNKNOWN.

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-invalid-arg-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  const rejected = () => Promise.reject(new Error('spawning is disabled in the invalid-argument test'));
  return { ...actual, run: rejected, runBinary: rejected };
});

const getDriverMock = vi.hoisted(() => vi.fn());
vi.mock('../src/session/attach.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session/attach.js')>();
  return { ...actual, getDriver: getDriverMock };
});

const { createServer } = await import('../src/server.js');
const { unknownSessionError, isInvalidArgumentError, invalidArgumentError } = await import('../src/lib/result.js');
const { assertAndroidAppId } = await import('../src/drivers/DirectDriver.js');
const { classifyFlowDriverError } = await import('../src/flows/run.js');
const { prepareStateProfile } = await import('../src/state/profile.js');

const BAD_APP_ID = 'com.x; rm -rf /sdcard';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, JSON.stringify(res.content)).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

describe('result helpers', () => {
  it('unknownSessionError is a typed, retry-safe INVALID_ARGUMENT', () => {
    const s = unknownSessionError('nope').structuredContent as Record<string, unknown>;
    expect(s).toMatchObject({ ok: false, failureCode: 'INVALID_ARGUMENT', retrySafe: true, changedState: false });
    expect(s.what).toContain('nope');
    expect((s.nextSteps as string[]).join(' ')).toMatch(/qa_status/);
    const custom = unknownSessionError('nope', ['Omit sessionId.']).structuredContent as Record<string, unknown>;
    expect(custom.nextSteps).toEqual(['Omit sessionId.']);
  });

  it('recognizes driver INVALID_ARGUMENT errors by code or prefix', () => {
    const e = thrown(() => assertAndroidAppId(BAD_APP_ID));
    expect(isInvalidArgumentError(e)).toBe(true);
    expect(isInvalidArgumentError(new Error('INVALID_ARGUMENT: bad'))).toBe(true);
    expect(isInvalidArgumentError(new Error('adb: device offline'))).toBe(false);
    expect(isInvalidArgumentError('INVALID_ARGUMENT: string, not Error')).toBe(false);
    const s = invalidArgumentError(e as Error, ['fix it']).structuredContent as Record<string, unknown>;
    expect(s).toMatchObject({ failureCode: 'INVALID_ARGUMENT', changedState: false, retrySafe: true, nextSteps: ['fix it'] });
    expect(s.what).not.toMatch(/^INVALID_ARGUMENT/);
  });
});

describe('classifyFlowDriverError', () => {
  it('maps INVALID_ARGUMENT (code or message prefix) to INVALID_ARGUMENT', () => {
    expect(classifyFlowDriverError(thrown(() => assertAndroidAppId(BAD_APP_ID)))).toBe('INVALID_ARGUMENT');
    expect(classifyFlowDriverError(Object.assign(new Error('bad input'), { code: 'INVALID_ARGUMENT' }))).toBe('INVALID_ARGUMENT');
    expect(classifyFlowDriverError('Error: INVALID_ARGUMENT: "x" is not a valid Android application id')).toBe('INVALID_ARGUMENT');
    // Unrelated messages keep their existing classification / fallback.
    expect(classifyFlowDriverError(new Error('something odd'))).toBe('UNKNOWN');
    expect(classifyFlowDriverError(new Error('no such element'))).toBe('ELEMENT_NOT_FOUND');
  });
});

describe('prepareStateProfile', () => {
  it('blocks a malformed Android app id before touching the device', async () => {
    const driver = {
      kind: 'direct',
      clearData: vi.fn(),
      launchApp: vi.fn(),
      terminateApp: vi.fn(async () => {}),
      currentDevice: () => 'emulator-5554',
    };
    const sessions = { addEnvChange: vi.fn() };
    const session = { appId: BAD_APP_ID, root: fakeHome, fixtures: [] };
    const ledger = await prepareStateProfile(
      sessions as never,
      session as never,
      driver as never,
      { name: 'fresh', reset: { android: 'clearData' }, launch: { clearState: true } } as never,
    );
    expect(ledger.status).toBe('state_blocked');
    expect(ledger.steps[0]).toMatchObject({ kind: 'validate.arguments', status: 'blocked' });
    expect(ledger.steps[0].detail).toMatch(/INVALID_ARGUMENT/);
    expect(driver.clearData).not.toHaveBeenCalled();
    expect(driver.launchApp).not.toHaveBeenCalled();
  });

  it('blocks a malformed permission name before any mutation', async () => {
    const driver = { kind: 'direct', clearData: vi.fn(), launchApp: vi.fn(), currentDevice: () => 'emulator-5554' };
    const ledger = await prepareStateProfile(
      { addEnvChange: vi.fn() } as never,
      { appId: 'com.example.app', root: fakeHome, fixtures: [] } as never,
      driver as never,
      { name: 'perm', reset: { android: 'clearData' }, launch: { permissions: { 'android.permission.CAMERA; reboot': 'allow' } } } as never,
    );
    expect(ledger.status).toBe('state_blocked');
    expect(ledger.steps[0].detail).toMatch(/permission name/);
    expect(driver.clearData).not.toHaveBeenCalled();
  });
});

describe('tool layer', () => {
  let client: Client;
  let sessions: ReturnType<typeof createServer>['sessions'];
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-invalid-arg-proj-'));
    const ctx = createServer();
    sessions = ctx.sessions;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'invalid-argument-test', version: '0' });
    await Promise.all([ctx.server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  beforeEach(() => getDriverMock.mockReset());

  async function newSession(appId?: string): Promise<string> {
    const started = structured((await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult);
    const id = started.sessionId as string;
    if (appId) sessions.get(id)!.appId = appId;
    return id;
  }

  it('qa_prepare_target rejects a malformed appId at entry', async () => {
    const sessionId = await newSession();
    const s = structured(
      (await client.callTool({ name: 'qa_prepare_target', arguments: { sessionId, appId: BAD_APP_ID } })) as CallToolResult,
    );
    expect(s).toMatchObject({ ok: false, failureCode: 'INVALID_ARGUMENT', changedState: false });
  });

  it('qa_app_control rejects a malformed Android appId before any device call', async () => {
    const driver = { kind: 'direct', launchApp: vi.fn(), terminateApp: vi.fn(), foregroundOwner: vi.fn(async () => 'x') };
    getDriverMock.mockResolvedValue({ driver });
    const sessionId = await newSession(BAD_APP_ID);
    const s = structured(
      (await client.callTool({ name: 'qa_app_control', arguments: { sessionId, action: 'force_stop' } })) as CallToolResult,
    );
    expect(s).toMatchObject({ ok: false, failureCode: 'INVALID_ARGUMENT', changedState: false });
    expect(driver.terminateApp).not.toHaveBeenCalled();
  });

  it('qa_app_control maps a driver-thrown INVALID_ARGUMENT to a typed error', async () => {
    const err = Object.assign(new Error('INVALID_ARGUMENT: bad id'), { code: 'INVALID_ARGUMENT' });
    const driver = {
      kind: 'wda',
      terminateApp: vi.fn(async () => {
        throw err;
      }),
      foregroundOwner: vi.fn(async () => 'x'),
    };
    getDriverMock.mockResolvedValue({ driver });
    const sessionId = await newSession('com.example.app');
    const s = structured(
      (await client.callTool({ name: 'qa_app_control', arguments: { sessionId, action: 'force_stop' } })) as CallToolResult,
    );
    expect(s).toMatchObject({ ok: false, failureCode: 'INVALID_ARGUMENT', what: 'bad id' });
  });
});
