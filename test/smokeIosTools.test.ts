// Real iOS simulator smoke (Swipium 2.0.0) regressions for qa_ios / qa_wda / WDA home:
//  2  qa_ios launch/terminate work once WDA is attached (session driver = WdaDriver) — simctl
//     drives the simulator whatever the automation backend; typed NO_DEVICE when none is bound
//  3  WDA "home" uses the session-less POST /wda/homescreen (the /session/:id form 404s)
//  4  the post-restart rehydrate note points iOS sessions at qa_prepare_ios_target
//  5  qa_wda build auto-discovers ~/.appium's appium-webdriveragent and reports wdaBuildProduct
//  1b qa_wda stop recovers a WDA it started even when the registry entry was lost
// Hermetic: temp HOME (with an ~/.appium fixture), simctl / xcodebuild / ps are mocked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-smokeios-tools-')));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
delete process.env.APPIUM_HOME;
delete process.env.WDA_PROJECT_PATH;
delete process.env.WEBDRIVERAGENT_PROJECT;

const APPIUM_WDA = join(
  fakeHome,
  '.appium',
  'node_modules',
  'appium-xcuitest-driver',
  'node_modules',
  'appium-webdriveragent',
  'WebDriverAgent.xcodeproj',
);
mkdirSync(APPIUM_WDA, { recursive: true });

const UDID = '190EA878-5D54-416C-B858-E60588B0DAF9';

const simCalls = vi.hoisted(() => [] as string[]);
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return {
    ...actual,
    simctlAvailable: async () => true,
    listSimulators: async () => [{ udid: '190EA878-5D54-416C-B858-E60588B0DAF9', name: 'iPhone 17', state: 'Booted', runtime: 'iOS 26.0' }],
    launchApp: async (udid: string, id: string) => void simCalls.push(`launch ${udid} ${id}`),
    terminateApp: async (udid: string, id: string) => void simCalls.push(`terminate ${udid} ${id}`),
    isInstalled: async () => true,
  };
});

const xcodebuildCalls = vi.hoisted(() => [] as string[][]);
vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    ...actual,
    run: async (cmd: string, args: string[], opts?: unknown) => {
      if (cmd !== 'xcodebuild') return actual.run(cmd, args, opts as never);
      xcodebuildCalls.push(args);
      const dd = args[args.indexOf('-derivedDataPath') + 1];
      fs.mkdirSync(path.join(dd, 'Build', 'Products', 'Debug-iphonesimulator', 'WebDriverAgentRunner-Runner.app'), { recursive: true });
      return { code: 0, stdout: '** TEST BUILD SUCCEEDED **', stderr: '', timedOut: false };
    },
  };
});

vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return {
    ...actual,
    xcodeAvailable: async () => ({ available: true, version: 'Xcode 26.6' }),
    checkWda: async () => ({ reachable: false, ready: false }),
    // Only the fixture HOME — never the dev machine's global npm roots.
    discoverAppiumWdaProjects: (home?: string, env?: NodeJS.ProcessEnv) => actual.discoverAppiumWdaProjects(home, env, []),
  };
});

const scan = vi.hoisted(() => ({ found: [] as number[], killed: [] as number[], sigs: [] as unknown[] }));
vi.mock('../src/session/processRegistry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session/processRegistry.js')>();
  return {
    ...actual,
    findManagedWdaProcesses: (sig: unknown) => (scan.sigs.push(sig), scan.found),
    killManagedWda: (pid: number) => (scan.killed.push(pid), true),
  };
});

const { createServer } = await import('../src/server.js');
const { WdaDriver } = await import('../src/drivers/WdaDriver.js');
const { SimctlDriver } = await import('../src/drivers/SimctlDriver.js');
const { pressWdaHome, discoverAppiumWdaProjects } = await import('../src/lib/wda.js');
const { rehydrateNote, REHYDRATE_NOTE } = await import('../src/session/attach.js');
const { boundSimulatorUdid } = await import('../src/tools/ios.js');
type SessionStore = import('../src/session/store.js').SessionStore;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-smokeios-proj-')));
writeFileSync(join(root, 'package.json'), '{"name":"smokeios"}');

let client: Client;
let sessions: SessionStore;
beforeAll(async () => {
  const ctx = createServer();
  sessions = ctx.sessions;
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'smokeios', version: '0' });
  await Promise.all([ctx.server.connect(s), client.connect(c)]);
});
afterAll(async () => {
  await client.close();
  for (const d of [fakeHome, root]) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  simCalls.length = 0;
  xcodebuildCalls.length = 0;
  scan.found = [];
  scan.killed.length = 0;
  scan.sigs.length = 0;
});

const sc = (r: unknown) => (r as CallToolResult).structuredContent as Record<string, unknown>;
const call = async (name: string, args: Record<string, unknown>) => sc(await client.callTool({ name, arguments: args }));
const newSession = async () => (await call('qa_start_session', { projectRoot: root })).sessionId as string;

describe('2: qa_ios launch/terminate with WDA attached', () => {
  it('a WdaDriver-bound session launches/terminates through simctl on the bound simulator', async () => {
    const sessionId = await newSession();
    const s = sessions.get(sessionId)!;
    s.driver = new WdaDriver('http://127.0.0.1:8100', { udid: UDID, sessionId: 'wda-sid' });
    s.device = UDID;
    const launched = await call('qa_ios', { sessionId, action: 'launch', bundleId: 'com.apple.Preferences' });
    expect(launched.ok).toBe(true);
    const terminated = await call('qa_ios', { sessionId, action: 'terminate', bundleId: 'com.apple.Preferences' });
    expect(terminated.ok).toBe(true);
    expect(simCalls).toEqual([`launch ${UDID} com.apple.Preferences`, `terminate ${UDID} com.apple.Preferences`]);
    expect(s.driver).toBeInstanceOf(WdaDriver); // the WDA attachment is kept
  });

  it('driver udid is used when session.device is unset', () => {
    expect(boundSimulatorUdid({ device: undefined, driver: new WdaDriver('http://127.0.0.1:8100', { udid: UDID }) })).toBe(UDID);
    expect(boundSimulatorUdid({ device: undefined, driver: new SimctlDriver(UDID) })).toBe(UDID);
    expect(boundSimulatorUdid({ device: 'emulator-5554', driver: undefined })).toBeUndefined();
  });

  it('no simulator bound → typed NO_DEVICE (not UNKNOWN)', async () => {
    const sessionId = await newSession();
    const res = await call('qa_ios', { sessionId, action: 'launch', bundleId: 'com.apple.Preferences' });
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('NO_DEVICE');
    expect(simCalls).toEqual([]);
  });
});

describe('3: WDA home is the session-less POST /wda/homescreen', () => {
  it('pressWdaHome and WdaDriver.pressKey("home") hit /wda/homescreen', async () => {
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      urls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response('{"value":null}', { status: 200 });
    });
    try {
      await pressWdaHome('http://127.0.0.1:8100/');
      await new WdaDriver('http://127.0.0.1:8100', { udid: UDID, sessionId: 'SID-1' }).pressKey('home');
    } finally {
      spy.mockRestore();
    }
    expect(urls).toEqual(['POST http://127.0.0.1:8100/wda/homescreen', 'POST http://127.0.0.1:8100/wda/homescreen']);
  });
});

describe('4: rehydrate note is platform-aware', () => {
  it('iOS → qa_prepare_ios_target; Android → qa_prepare_target', () => {
    expect(rehydrateNote({ device: UDID, driver: undefined })).toContain('qa_prepare_ios_target');
    expect(rehydrateNote({ device: undefined, driver: new WdaDriver('http://127.0.0.1:8100', { udid: UDID }) })).toContain(
      'qa_prepare_ios_target',
    );
    const android = rehydrateNote({ device: 'emulator-5554', driver: undefined });
    expect(android).toContain('qa_prepare_target');
    expect(android).not.toContain('qa_prepare_ios_target');
    expect(REHYDRATE_NOTE).toContain('qa_prepare_ios_target on iOS');
  });
});

describe('5: qa_wda build auto-discovers the Appium WebDriverAgent', () => {
  it('discoverAppiumWdaProjects finds ~/.appium/**/appium-webdriveragent', () => {
    expect(discoverAppiumWdaProjects(fakeHome, {}, [])[0]).toBe(APPIUM_WDA);
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-smokeios-nohome-')));
    try {
      const nested = join(
        bare,
        '.appium',
        'node_modules',
        '@scope',
        'x',
        'node_modules',
        'appium-webdriveragent',
        'WebDriverAgent.xcodeproj',
      );
      mkdirSync(nested, { recursive: true });
      expect(discoverAppiumWdaProjects(bare, {}, [])).toEqual([nested]);
      expect(discoverAppiumWdaProjects(join(bare, 'none'), {}, [])).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('build without wdaProjectPath uses the discovered project and reports wdaBuildProduct', async () => {
    const sessionId = await newSession();
    const gate = await call('qa_wda', { sessionId, action: 'build', device: UDID });
    expect(gate.requiresConsent).toBe(true);
    expect(String(gate.exactCommand)).toContain(APPIUM_WDA);
    // build runs as a background job (2.2.0): the result lands on the job.
    const started = await call('qa_wda', { sessionId, action: 'build', device: UDID, consentId: gate.consentId, approve: true });
    expect(started).toMatchObject({ ok: true, status: 'running' });
    expect((await call('qa_job_status', { sessionId, jobId: started.jobId, waitMs: 5000 })).status).toBe('done');
    const built = sessions.get(sessionId)!.jobs.get(started.jobId as string)!.result as Record<string, unknown>;
    expect(built.built).toBe(true);
    expect(built.wdaProjectPath).toBe(APPIUM_WDA);
    expect(built.wdaProjectSource).toBe('appium-discovered');
    expect(built.wdaBuildProduct).toMatchObject({ built: true });
    expect(String((built.wdaBuildProduct as { productPath: string }).productPath)).toMatch(/WebDriverAgentRunner-Runner\.app$/);
    expect(xcodebuildCalls[0]).toEqual(expect.arrayContaining(['-project', APPIUM_WDA, 'build-for-testing']));
    // …and a later status (no path passed) still reports the product instead of null.
    const status = await call('qa_wda', { sessionId, action: 'status' });
    expect(status.wdaBuildProduct).toMatchObject({ built: true });
  });
});

describe('1b: qa_wda stop recovers a started WDA whose registry entry was lost', () => {
  it('locates it by the recorded start signature and stops it', async () => {
    const sessionId = await newSession();
    const s = sessions.get(sessionId)!;
    sessions.recordMutation(s, {
      tool: 'qa_wda',
      action: 'wda_start',
      risk: 'medium',
      target: { udid: UDID, projectPath: APPIUM_WDA, derivedDataPath: '/dd', pid: 16824, webDriverAgentUrl: 'http://127.0.0.1:8100' },
      status: 'executed',
    });
    scan.found = [16824];
    const res = await call('qa_wda', { sessionId, action: 'stop' });
    expect(res).toMatchObject({ ok: true, stopped: true, pid: 16824, recovered: true });
    expect(scan.sigs).toEqual([{ projectPath: APPIUM_WDA, udid: UDID, derivedDataPath: '/dd', port: 8100 }]);
    expect(scan.killed).toEqual([16824]);
  });

  it('nothing started / nothing matching → stopped:false, nothing signalled', async () => {
    const sessionId = await newSession();
    expect(await call('qa_wda', { sessionId, action: 'stop' })).toMatchObject({ ok: true, stopped: false });
    expect(scan.killed).toEqual([]);
  });
});
