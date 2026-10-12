// Pre-launch journeys through qa_test_this / qa_continue_from_blocker, driven in-memory with fakes
// (no devices): plan-mode next actions must actually execute (no re-plan loop), physical phones are
// refused or ignored (never picked), missing adb is its own failure, iOS without WDA degrades to a
// visual-only smoke instead of blocking the default run, stale consent ids are explained, and a
// blocker resume replays the original goal. Hermetic: HOME is a temp dir, adb/simctl/WDA/spawn mocked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-journey-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const env = vi.hoisted(() => ({
  bins: new Set<string>(),
  online: [] as string[],
  avds: [] as string[],
  simPresent: false,
  sims: [] as Array<{ udid: string; name: string; state: string; runtime: string }>,
  /** Loopback WDA ports that answer /status, and the simulator UDID whose process listens there. */
  wda: new Map<number, string>(),
  lsofTimeout: false,
}));

vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  which: vi.fn(async (bin: string) => env.bins.has(bin)),
  firstLine: vi.fn(async () => null),
  adbDevices: vi.fn(async () => [...env.online]),
  listAvds: vi.fn(async () => [...env.avds]),
  findAapt2: vi.fn(() => null),
  apkPackageId: vi.fn(async () => 'com.example.app'),
}));
vi.mock('../src/lib/simctl.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/simctl.js')>()),
  simctlAvailable: vi.fn(async () => env.simPresent),
  listSimulators: vi.fn(async () => env.sims),
}));
vi.mock('../src/lib/wda.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/wda.js')>()),
  checkWda: vi.fn(async (url: string) =>
    env.wda.has(Number(new URL(url).port)) ? { reachable: true, ready: true } : { reachable: false, ready: false },
  ),
}));
// getprop: emulator-N → qemu emulator; anything else → a physical phone.
vi.mock('../src/lib/spawn.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spawn.js')>()),
  run: vi.fn(async (bin: string, args: string[]) => {
    // lsof / ps for a WDA port owner: pid 7<port> runs inside the simulator recorded in env.wda.
    const port = Number(args.find((a) => a.startsWith('-iTCP:'))?.slice(6));
    if (bin === 'lsof' && env.lsofTimeout) return { code: null, stdout: '', stderr: '', timedOut: true };
    if (bin === 'lsof' && env.wda.has(port)) return { code: 0, stdout: `7${port}\n`, stderr: '', timedOut: false };
    const pid = bin === 'ps' ? Number(args[args.length - 1]) : NaN;
    if (bin === 'ps' && env.wda.has(pid - 70000))
      return {
        code: 0,
        stdout: `/Users/x/Library/Developer/CoreSimulator/Devices/${env.wda.get(pid - 70000)}/data/Containers/Bundle/Application/X/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner\n`,
        stderr: '',
        timedOut: false,
      };
    const serial = args[0] === '-s' ? args[1] : '';
    if (args.includes('getprop')) {
      const emu = /^emulator-/.test(serial);
      return {
        code: 0,
        stdout: `[ro.kernel.qemu]: [${emu ? '1' : '0'}]\n[ro.hardware]: [${emu ? 'ranchu' : 'qcom'}]\n[sys.boot_completed]: [1]\n`,
        stderr: '',
        timedOut: false,
      };
    }
    return { code: 1, stdout: '', stderr: 'mocked', timedOut: false };
  }),
}));

const { createServer } = await import('../src/server.js');
const { preferredWdaPort } = await import('../src/lib/wdaDevice.js');
type SessionStore = import('../src/session/store.js').SessionStore;

const realPlatform = process.platform;
const tmp = mkdtempSync(join(tmpdir(), 'swipium-journey-'));
let client: Client;
let sessions: SessionStore;

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
const sc = (r: CallToolResult) => (r.structuredContent ?? {}) as Record<string, unknown>;
const text = (r: CallToolResult) => (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

function project(name: string, files: Record<string, string>): string {
  const root = join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const expoPkg = JSON.stringify({ name: 'demo', dependencies: { expo: '1', 'react-native': '1' } });
const androidApp = () =>
  project(`android-${Math.random().toString(36).slice(2)}`, {
    'settings.gradle': "include ':app'",
    'build.gradle': '',
    'app/build.gradle': "android { defaultConfig { applicationId 'com.example.app' } }",
    'app/build/outputs/apk/debug/app-debug.apk': 'PK-fake-apk',
  });

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const ctx = createServer();
  sessions = ctx.sessions;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'journey-test', version: '0' });
  await Promise.all([ctx.server.connect(st), client.connect(ct)]);
});

beforeEach(() => {
  env.bins = new Set(['adb', 'emulator']);
  env.online = [];
  env.avds = [];
  env.simPresent = false;
  env.sims = [];
  env.wda = new Map();
  env.lsofTimeout = false;
});

afterAll(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('plan mode never loops', () => {
  it('an Expo project without an APK → next action is qa_test_this with mode:"execute" and the original goal', async () => {
    env.avds = ['Pixel_7'];
    const root = project('expo-nobuild', { 'package.json': expoPkg, 'app.json': '{"expo":{"name":"demo"}}' });
    const r = await call('qa_test_this', { projectRoot: root, mode: 'plan', platform: 'android', goal: 'release_gate' });
    expect(r.isError).toBeFalsy();
    const next = sc(r).nextAction as { tool: string; args: Record<string, unknown> };
    expect(next.tool).toBe('qa_test_this');
    expect(next.args).toMatchObject({ mode: 'execute', goal: 'release_gate', platform: 'android', sessionId: sc(r).sessionId });
    // Following it must reach execution (a consent request), not an identical plan.
    const exec = await call('qa_test_this', next.args);
    expect(sc(exec).requiresConsent).toBe(true);
    expect(sc(exec).plan).toBeUndefined();
  });

  it('the .aab conversion step also carries mode:"execute" + flags', async () => {
    env.avds = ['Pixel_7'];
    const root = project('aab-only', {
      'settings.gradle': "include ':app'",
      'build.gradle': '',
      'app/build/outputs/bundle/release/app-release.aab': 'PK-fake-aab',
    });
    const r = await call('qa_test_this', { projectRoot: root, mode: 'plan', fastSmoke: true });
    const steps = sc(r).plan as Array<{ tool: string; args?: Record<string, unknown> }>;
    const convert = steps.find((s) => s.tool === 'qa_test_this');
    expect(convert?.args).toMatchObject({ mode: 'execute', fastSmoke: true });
  });
});

describe('physical devices and missing adb (plan side)', () => {
  it('phone online + AVD available → plans a boot of the AVD, never the phone', async () => {
    env.online = ['R58M123ABC'];
    env.avds = ['Pixel_7'];
    const r = await call('qa_test_this', { projectRoot: androidApp(), mode: 'plan', goal: 'smoke' });
    expect(r.isError).toBeFalsy();
    const target = sc(r).target as { willBoot: boolean; bootTarget?: string; device?: string };
    expect(target).toMatchObject({ willBoot: true, bootTarget: 'Pixel_7' });
    expect(target.device).toBeUndefined();
  });

  it('phone only → PHYSICAL_DEVICE_UNSUPPORTED with AVD creation steps (not "No Android device online")', async () => {
    env.online = ['R58M123ABC'];
    const r = await call('qa_test_this', { projectRoot: androidApp(), goal: 'smoke' });
    expect(r.isError).toBe(true);
    expect(sc(r).failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
    expect(JSON.stringify(sc(r).nextSteps)).toMatch(/avdmanager|Device Manager/);
    expect(JSON.stringify(sc(r).nextSteps)).toContain('qa_test_this');
  });

  it('no adb on PATH → ADB_NOT_FOUND (distinct from NO_DEVICE); no emulator → NO_DEVICE pointing at AVD creation', async () => {
    env.bins = new Set();
    const noAdb = await call('qa_test_this', { projectRoot: androidApp(), goal: 'smoke' });
    expect(sc(noAdb).failureCode).toBe('ADB_NOT_FOUND');
    expect(JSON.stringify(sc(noAdb).nextSteps)).toMatch(/platform-tools/);

    env.bins = new Set(['adb']);
    const none = await call('qa_test_this', { projectRoot: androidApp(), goal: 'smoke' });
    expect(sc(none).failureCode).toBe('NO_DEVICE');
    const steps = JSON.stringify(sc(none).nextSteps);
    expect(steps).toMatch(/avdmanager|Device Manager/);
    expect(steps).not.toContain('qa_doctor');
    const explained = sc(await call('qa_explain_blocker', { failureCode: 'ADB_NOT_FOUND' }));
    expect(explained.failureCode).toBe('ADB_NOT_FOUND');
  });
});

describe('iOS without WebDriverAgent', () => {
  const iosApp = () =>
    project(`ios-${Math.random().toString(36).slice(2)}`, {
      'App.xcodeproj/project.pbxproj': '// fake',
      'build/Build/Products/Debug-iphonesimulator/App.app/Info.plist':
        '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.example.ios</string></dict></plist>',
      'build/Build/Products/Debug-iphonesimulator/App.app/App': 'bin',
    });
  const sim = { udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' };

  it('default execute (no goal) degrades to a visual-only smoke instead of WDA_UNREACHABLE', async () => {
    env.bins = new Set();
    env.simPresent = true;
    env.sims = [sim];
    const r = await call('qa_test_this', { projectRoot: iosApp(), mode: 'execute', platform: 'ios' });
    expect(sc(r).failureCode).toBeUndefined();
    expect(sc(r).requiresConsent).toBe(true); // reaches the install consent — not blocked
    const s = sessions.get(sc(r).sessionId as string)!;
    expect(s.workarounds.join('\n')).toMatch(/WebDriverAgent not ready .* running the iOS smoke only/);
  });

  it('an explicit WDA-only goal blocks precisely and offers the goal:"smoke" alternative', async () => {
    env.bins = new Set();
    env.simPresent = true;
    env.sims = [sim];
    const r = await call('qa_test_this', { projectRoot: iosApp(), mode: 'execute', platform: 'ios', goal: 'create_automation_suite' });
    expect(sc(r).failureCode).toBe('WDA_UNREACHABLE');
    expect(String(sc(r).what)).toMatch(/suite generation/);
    expect(sc(r).requiresWdaFor).toContain('suite generation');
    expect((sc(r).nextSteps as string[]).join('\n')).toContain('"goal":"smoke"');
    // The blocked plan never binds the simulator, so the WDA steps name it.
    expect(JSON.stringify(sc(r).nextSteps)).toContain(sim.udid);
  });

  it("finds the simulator's own WDA on its per-simulator port (not only ios.wda.url / :8100)", async () => {
    env.bins = new Set();
    env.simPresent = true;
    env.sims = [sim];
    env.wda.set(preferredWdaPort(sim.udid), sim.udid);
    const r = await call('qa_test_this', { projectRoot: iosApp(), mode: 'execute', platform: 'ios', goal: 'create_automation_suite' });
    expect(sc(r).failureCode).toBeUndefined();
    expect(JSON.stringify(sc(r))).not.toContain('WDA_UNREACHABLE');
    expect(sc(r).requiresConsent).toBe(true); // passes the WDA gate, reaches the install consent
  });

  it('a WDA answering on the per-simulator port but running in ANOTHER simulator is not used', async () => {
    env.bins = new Set();
    env.simPresent = true;
    env.sims = [sim];
    env.wda.set(preferredWdaPort(sim.udid), '11111111-2222-3333-4444-555555555555');
    const r = await call('qa_test_this', { projectRoot: iosApp(), mode: 'execute', platform: 'ios', goal: 'create_automation_suite' });
    expect(sc(r).failureCode).toBe('WDA_UNREACHABLE');
  });

  it('a reachable :8100 WDA whose owner could not be verified (lsof timed out) is not used', async () => {
    env.bins = new Set();
    env.simPresent = true;
    env.sims = [sim];
    env.wda.set(8100, sim.udid);
    env.lsofTimeout = true;
    const r = await call('qa_test_this', { projectRoot: iosApp(), mode: 'execute', platform: 'ios', goal: 'create_automation_suite' });
    expect(sc(r).failureCode).toBe('WDA_UNREACHABLE');
    env.lsofTimeout = false;
    const ok = await call('qa_test_this', { projectRoot: iosApp(), mode: 'execute', platform: 'ios', goal: 'create_automation_suite' });
    expect(sc(ok).failureCode).toBeUndefined();
  });

  it("an unverified WDA is usable when it is this session's own recorded WDA for the simulator", async () => {
    env.bins = new Set();
    env.simPresent = true;
    env.sims = [sim];
    env.wda.set(8100, sim.udid);
    env.lsofTimeout = true;
    const root = iosApp();
    const sessionId = sc(await call('qa_start_session', { projectRoot: root })).sessionId as string;
    const args = { sessionId, projectRoot: root, mode: 'execute', platform: 'ios', goal: 'create_automation_suite' };
    // Another URL than the session's own: still not used.
    sessions.recordMutation(sessions.get(sessionId)!, {
      tool: 'qa_wda',
      action: 'wda_attach',
      risk: 'low',
      target: { udid: sim.udid, webDriverAgentUrl: 'http://127.0.0.1:8555' },
      consent: { required: false, approved: true },
      status: 'executed',
    });
    expect(sc(await call('qa_test_this', args)).failureCode).toBe('WDA_UNREACHABLE');
    sessions.recordMutation(sessions.get(sessionId)!, {
      tool: 'qa_wda',
      action: 'wda_attach',
      risk: 'low',
      target: { udid: sim.udid, webDriverAgentUrl: 'http://127.0.0.1:8100' },
      consent: { required: false, approved: true },
      status: 'executed',
    });
    const r = await call('qa_test_this', args);
    expect(sc(r).failureCode).toBeUndefined();
    expect(JSON.stringify(sc(r))).not.toContain('WDA_UNREACHABLE');
  });

  it('a wrong-case SWIPIUM_DEVICE pin finds the simulator; a name two simulators share is MULTIPLE_DEVICES', async () => {
    env.bins = new Set();
    env.simPresent = true;
    env.sims = [sim];
    process.env.SWIPIUM_DEVICE = 'iphone 16';
    try {
      const r = await call('qa_test_this', { projectRoot: iosApp(), mode: 'plan', platform: 'ios', goal: 'smoke' });
      expect(sc(r).failureCode).toBeUndefined();
      expect(JSON.stringify(sc(r).target)).toContain(sim.udid);
      env.sims = [sim, { ...sim, udid: '99999999-8888-4777-8666-555555555555' }];
      const twice = await call('qa_test_this', { projectRoot: iosApp(), mode: 'plan', platform: 'ios', goal: 'smoke' });
      expect(sc(twice).failureCode).toBe('MULTIPLE_DEVICES');
    } finally {
      delete process.env.SWIPIUM_DEVICE;
    }
  });
});

describe('consent ids', () => {
  it('a bogus consentId is explained, and the new challenge carries sessionId', async () => {
    env.avds = ['Pixel_7'];
    const r = await call('qa_test_this', {
      projectRoot: androidApp(),
      mode: 'execute',
      goal: 'smoke',
      consentId: 'deadbeef',
      approve: true,
    });
    const out = sc(r);
    expect(out.requiresConsent).toBe(true);
    expect(out.consentNote).toMatch(/consent deadbeef unknown or expired; new challenge issued/);
    expect(out.consentId).not.toBe('deadbeef');
    expect(typeof out.sessionId).toBe('string');
    expect(text(r)).toContain('unknown or expired');
    // Re-calling with just the sessionId reuses the same session.
    const again = await call('qa_test_this', { sessionId: out.sessionId, mode: 'execute', goal: 'smoke' });
    expect(sc(again).sessionId).toBe(out.sessionId);
  });
});

describe('blocker resume replays the original intent, and decline handling', () => {
  it('release_gate → monorepo_target → resume keeps goal', async () => {
    const root = project('mono', {
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*'] }),
      'apps/one/package.json': expoPkg,
      'apps/one/app.json': '{"expo":{"name":"one"}}',
      'apps/two/package.json': expoPkg,
      'apps/two/app.json': '{"expo":{"name":"two"}}',
    });
    const r = await call('qa_test_this', { projectRoot: root, mode: 'execute', goal: 'release_gate', goalText: 'checkout' });
    expect(sc(r).kind).toBe('monorepo_target');
    const sid = sc(r).sessionId as string;
    const cont = sc(await call('qa_continue_from_blocker', { sessionId: sid, kind: 'monorepo_target', values: { target: 'apps/one' } }));
    const next = cont.nextAction as { tool: string; args: Record<string, unknown> };
    expect(next.args).toMatchObject({ mode: 'execute', goal: 'release_gate', goalText: 'checkout', sessionId: sid });
    // Persisted on the session → survives a server restart (fresh store rehydrates it from disk).
    sessions.flushAll();
    const { SessionStore } = await import('../src/session/store.js');
    const rehydrated = new SessionStore().get(sid)!;
    expect(rehydrated.lastTestThisArgs).toMatchObject({ goal: 'release_gate', goalText: 'checkout' });
  });

  it('"test pre-login only" marks login out of scope (not an unknown input) and never claims credentials were registered', async () => {
    const s = sessions.create(tmp, undefined, {});
    const r = await call('qa_continue_from_blocker', { sessionId: s.id, kind: 'credentials', values: { choice: 'test pre-login only' } });
    const out = sc(r);
    expect(out.loginOutOfScope).toBe(true);
    expect(out.ignored).toEqual([]);
    const next = out.nextAction as { why: string; args: Record<string, unknown> };
    expect(next.why).toMatch(/out of scope/);
    expect(next.why).not.toMatch(/credentials registered/);
    expect(next.args).toMatchObject({ mode: 'execute', stopOnNeedsInput: false });
    expect(sessions.get(s.id)!.milestones.login_declined).toBeTypeOf('number');
  });

  it('an OTP field named `code` is treated as secret (redacted, never echoed)', async () => {
    const s = sessions.create(tmp, undefined, {});
    const r = await call('qa_continue_from_blocker', { sessionId: s.id, kind: 'otp_or_manual_verification', values: { code: '482913' } });
    expect(text(r)).not.toContain('482913');
    expect(JSON.stringify(sc(r).accepted)).toContain('redacted');
    expect(sessions.get(s.id)!.inputs.find((i) => i.varName === 'SWIPIUM_TEST_OTP')?.secret).toBe(true);
  });
});

describe('credentials after a restart', () => {
  it('stored credential metadata without values re-asks instead of going straight to consent', async () => {
    env.avds = ['Pixel_7'];
    const root = androidApp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'a', dependencies: { '@react-native-firebase/auth': '1' } }));
    const first = await call('qa_test_this', { projectRoot: root, goal: 'smoke' });
    const s = sessions.get(sc(first).sessionId as string)!;
    // Simulate a rehydrated session: metadata survived, raw values did not.
    s.inputs.push({ varName: 'SWIPIUM_TEST_EMAIL', secret: false, source: 'needs_input:credentials' } as never);
    s.inputValues.clear();
    const r = await call('qa_test_this', { sessionId: s.id, mode: 'execute', goal: 'test_login' });
    expect(sc(r).kind).toBe('credentials');
    expect(String(sc(r).question)).toMatch(/server restart/);
  });
});

describe('surface: responseMode + preferRealDevice (#14, #15)', () => {
  it('qa_test_this accepts responseMode and stores it on the session; preferRealDevice is documented as out of scope', async () => {
    env.avds = ['Pixel_7'];
    const r = await call('qa_test_this', { projectRoot: androidApp(), goal: 'smoke', responseMode: 'compact' });
    expect(sessions.get(sc(r).sessionId as string)!.responseMode).toBe('compact');
    const tools = await client.listTools();
    const tt = tools.tools.find((t) => t.name === 'qa_test_this')!;
    const props = (tt.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.preferRealDevice.description).toBe('Out of scope: returns PHYSICAL_DEVICE_UNSUPPORTED.');
    expect(props.responseMode).toBeDefined();
  });
});
