// H9 — Android/iOS awareness. After `qa_ios boot` the next-best-action must route to the iOS
// prepare tool; qa_resolve_target include:["context","plan"] must count iOS simulators as devices; qa_device_info /
// qa_orientation must not return ok:true-with-nulls (or run adb) on an iOS backend; and
// qa_prepare_target must refuse a physical Android device with the same typed
// PHYSICAL_DEVICE_UNSUPPORTED as the qa_test_this planner (not an outdated "1.0.0" message).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sims = [
  { udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' },
  { udid: '11111111-2222-3333-4444-555555555555', name: 'iPad Air', state: 'Shutdown', runtime: 'iOS 18.0' },
];

vi.mock('../src/lib/simctl.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/simctl.js')>()),
  simctlAvailable: vi.fn(async () => true),
  listSimulators: vi.fn(async () => sims),
}));
vi.mock('../src/lib/android.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/android.js')>()),
  which: vi.fn(async () => false), // no adb / emulator / xcodebuild on this "host"
  firstLine: vi.fn(async () => null),
  adbDevices: vi.fn(async () => []),
  listAvds: vi.fn(async () => []),
  findAapt2: vi.fn(() => null),
}));
const getDriverMock = vi.fn();
vi.mock('../src/session/attach.js', async (orig) => ({
  ...(await orig<typeof import('../src/session/attach.js')>()),
  getDriver: (...a: unknown[]) => getDriverMock(...a),
}));

const { nextBestAction, sessionPlatform } = await import('../src/tools/agent.js');
const { detectContext, hasAnyDevice } = await import('../src/context/detect.js');
const { registerDevice } = await import('../src/tools/device.js');
const { physicalDeviceRefusalFor } = await import('../src/tools/prepareTarget.js');
const { buildPlan } = await import('../src/plan/plan.js');

const realPlatform = process.platform;
const root = mkdtempSync(join(tmpdir(), 'swipium-platform-'));
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '1', 'react-native': '1' } }));
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  rmSync(root, { recursive: true, force: true });
});

function session(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    root,
    jobs: new Map(),
    recordedActions: [],
    findings: [],
    workarounds: [],
    ...over,
  } as never;
}

describe('nextBestAction is platform-aware (H9)', () => {
  it('bound iOS simulator with no app → qa_prepare_ios_target', () => {
    const a = nextBestAction(session({ device: sims[0].udid }));
    expect(a.tool).toBe('qa_prepare_ios_target');
    expect(a.args).toMatchObject({ sessionId: 's1', device: sims[0].udid });
  });
  it('driver kind wins over device shape', () => {
    expect(sessionPlatform({ device: 'whatever', driver: { kind: 'wda' } } as never)).toBe('ios');
    expect(sessionPlatform({ device: sims[0].udid, driver: { kind: 'direct' } } as never)).toBe('android');
  });
  it('bound Android emulator with no app → qa_prepare_target (unchanged)', () => {
    expect(nextBestAction(session({ device: 'emulator-5554' })).tool).toBe('qa_prepare_target');
  });
});

describe('project context / workflow plan (qa_resolve_target include) count iOS simulators (H9)', () => {
  it('lists booted + available simulators and does not demand adb when iOS is usable', async () => {
    const ctx = await detectContext(root);
    expect(ctx.devices.iosBooted.map((d) => d.name)).toEqual(['iPhone 16']);
    expect(ctx.devices.iosAvailable.map((d) => d.name)).toEqual(['iPad Air']);
    expect(hasAnyDevice(ctx.devices)).toBe(true);
    expect(ctx.blockers.some((b) => /adb not found/.test(b))).toBe(false);
    expect(ctx.blockers.some((b) => /No online device/.test(b))).toBe(false);
  });
  it('a plan with only an iOS simulator is not missing_device', async () => {
    const ctx = await detectContext(root);
    const plan = buildPlan({
      framework: ctx.framework,
      hasDevice: hasAnyDevice(ctx.devices),
      hasApk: true,
      appPrepared: false,
      fixtures: [],
      auth: {},
      blockers: ctx.blockers,
      flows: [],
    } as never);
    expect(plan.blocked.some((w: { category: string }) => w.category === 'missing_device')).toBe(false);
  });
  it('tolerates absence: non-macOS hosts report no simulators', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const ctx = await detectContext(root);
      expect(ctx.devices.iosBooted).toEqual([]);
      expect(ctx.devices.iosAvailable).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
    }
  });
});

type Handler = (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
function deviceTools() {
  const tools = new Map<string, Handler>();
  const s = { id: 's1', root };
  const sessions = { get: () => s, addEnvChange: vi.fn(), recordMutation: vi.fn() };
  registerDevice({ registerTool: (n: string, _c: unknown, h: Handler) => tools.set(n, h) } as never, sessions as never);
  return tools;
}

describe('qa_device_info / qa_orientation on iOS (H9)', () => {
  const iosDriver = { kind: 'simulator', currentDevice: () => sims[0].udid, screenSize: async () => ({ width: 393, height: 852 }) };

  it('qa_device_info reports simctl facts instead of ok:true with all-null Android props', async () => {
    getDriverMock.mockResolvedValue({ driver: iosDriver });
    const r = await deviceTools().get('qa_device_info')!({ sessionId: 's1' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      platform: 'ios',
      props: { name: 'iPhone 16', runtime: 'iOS 18.0', state: 'Booted' },
      screen: { width: 393, height: 852 },
    });
  });

  it('qa_orientation returns typed BACKEND_UNSUPPORTED on iOS (no adb spawned)', async () => {
    getDriverMock.mockResolvedValue({ driver: iosDriver });
    const r = await deviceTools().get('qa_orientation')!({ sessionId: 's1', orientation: 'landscape' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.failureCode).toBe('BACKEND_UNSUPPORTED');
  });

  it('qa_device_info on an unknown non-Android backend is BACKEND_UNSUPPORTED', async () => {
    getDriverMock.mockResolvedValue({ driver: { kind: 'remote', currentDevice: () => 'x' } });
    const r = await deviceTools().get('qa_device_info')!({ sessionId: 's1' });
    expect(r.structuredContent?.failureCode).toBe('BACKEND_UNSUPPORTED');
  });
});

describe('qa_prepare_target physical-device policy (H9)', () => {
  it('refuses a physical serial with the planner’s PHYSICAL_DEVICE_UNSUPPORTED wording', () => {
    const r = physicalDeviceRefusalFor('R58M12345');
    expect(r?.what).toMatch(/simulator\/emulator-only by policy/);
    expect(r?.what).not.toMatch(/1\.0\.0/);
  });
  it('lets an emulator through', () => {
    expect(physicalDeviceRefusalFor('emulator-5554')).toBeNull();
  });
});
