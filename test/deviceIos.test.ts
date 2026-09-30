// Regression tests for real-device iOS smoke findings (Swipium 2.0.0):
//  E  a rehydrated iOS session (device = simulator UDID) re-binds ITS simulator — never a lone
//     online Android emulator — and an unbooted simulator is a typed DEVICE_NOT_READY
//  H  WdaDriver press "back" taps the nav-bar back button, else edge-swipes (no WDA /back call)
//  G  WdaDriver.hideKeyboard reports false (not an untyped throw) when WDA cannot dismiss

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-device-ios-home-'));
delete process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const runMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return { ...actual, run: runMock };
});

const wda = vi.hoisted(() => ({
  source: '',
  tapWdaPoint: vi.fn(async () => {}),
  dragWdaPoint: vi.fn(async () => {}),
  wdaWindowSize: vi.fn(async () => ({ width: 402, height: 874 })),
  wdaKeyboardShown: vi.fn(async () => true),
  dismissWdaKeyboard: vi.fn(async () => {}),
  wdaFetchBack: vi.fn(),
}));
vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return {
    ...actual,
    wdaSource: async () => wda.source,
    tapWdaPoint: wda.tapWdaPoint,
    dragWdaPoint: wda.dragWdaPoint,
    wdaWindowSize: wda.wdaWindowSize,
    wdaKeyboardShown: wda.wdaKeyboardShown,
    dismissWdaKeyboard: wda.dismissWdaKeyboard,
    pressWdaBack: wda.wdaFetchBack,
  };
});

const { getDriver, setIosProbeForTests, blockedDeviceResult, isSimulatorUdid } = await import('../src/session/attach.js');
const { SessionStore } = await import('../src/session/store.js');
const { WdaDriver, iosBackButtonPoint } = await import('../src/drivers/WdaDriver.js');
const { WdaHttpError } = await import('../src/lib/wda.js');

const UDID = '8F3C2A10-1B2C-4D5E-8F90-ABCDEF123456';
const EMU_PROPS = '[ro.kernel.qemu]: [1]\n[sys.boot_completed]: [1]\n[ro.hardware]: [ranchu]\n';
let online: string[] = [];

function answer(_cmd: string, args: string[]): Promise<RunResult> {
  if (args[0] === 'devices') {
    return Promise.resolve({
      code: 0,
      stdout: `List of devices attached\n${online.map((s) => `${s}\tdevice`).join('\n')}\n`,
      stderr: '',
      timedOut: false,
    });
  }
  if (args.includes('getprop')) return Promise.resolve({ code: 0, stdout: EMU_PROPS, stderr: '', timedOut: false });
  return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
}

function newSession() {
  const store = new SessionStore();
  const s = store.create(mkdtempSync(join(tmpdir(), 'swipium-device-ios-proj-')));
  return { store, s };
}

describe('E: iOS session resume never falls back to an Android emulator', () => {
  beforeEach(() => {
    runMock.mockReset();
    runMock.mockImplementation(answer);
    online = ['emulator-5554'];
  });
  afterEach(() => setIosProbeForTests(undefined));

  it('recognizes simulator UDIDs', () => {
    expect(isSimulatorUdid(UDID)).toBe(true);
    expect(isSimulatorUdid('emulator-5554')).toBe(false);
  });

  it('saved booted UDID + one online emulator → SimctlDriver for the UDID, no adb bind', async () => {
    setIosProbeForTests({
      listSimulators: async () => [{ udid: UDID, name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' }],
      wdaReachable: async () => false,
    });
    const { s } = newSession();
    s.device = UDID;
    const r = await getDriver(s);
    expect(r.driver?.kind).toBe('simulator');
    expect(r.driver?.currentDevice()).toBe(UDID);
    expect(r.rehydrated).toBe(true);
    expect(s.device).toBe(UDID);
    expect(runMock.mock.calls.some((c) => (c[1] as string[])[0] === 'devices')).toBe(false);
  });

  it('re-binds WDA when the session had attached it and it is reachable', async () => {
    setIosProbeForTests({
      listSimulators: async () => [{ udid: UDID, name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' }],
      wdaReachable: async (url) => url === 'http://127.0.0.1:8100',
    });
    const { store, s } = newSession();
    s.device = UDID;
    store.recordMutation(s, {
      tool: 'qa_wda',
      action: 'wda_attach',
      risk: 'medium',
      target: { webDriverAgentUrl: 'http://127.0.0.1:8100', udid: UDID },
      consent: { required: false, approved: true },
      status: 'executed',
    });
    const r = await getDriver(s);
    expect(r.driver?.kind).toBe('wda');
    expect(r.driver?.currentDevice()).toBe(UDID);
    expect(s.device).toBe(UDID);
  });

  it('saved UDID not booted → typed DEVICE_NOT_READY, nothing bound, device untouched', async () => {
    setIosProbeForTests({
      listSimulators: async () => [{ udid: UDID, name: 'iPhone 16', state: 'Shutdown', runtime: 'iOS 18.0' }],
    });
    const { s } = newSession();
    s.device = UDID;
    const r = await getDriver(s);
    expect(r.driver).toBeUndefined();
    expect(r.blocked?.failureCode).toBe('DEVICE_NOT_READY');
    expect(s.device).toBe(UDID);
    expect(s.driver).toBeUndefined();
    const res = blockedDeviceResult(r.blocked)!;
    expect((res.structuredContent as { nextSteps: string[] }).nextSteps.join(' ')).toContain(`qa_ios action:"boot" device:"${UDID}"`);
  });

  it('an offline Android device is not silently replaced by a different online emulator', async () => {
    const { s } = newSession();
    s.device = 'emulator-5556';
    const r = await getDriver(s);
    expect(r.driver).toBeUndefined();
    expect(r.blocked?.failureCode).toBe('DEVICE_NOT_READY');
    expect(s.device).toBe('emulator-5556');
  });
});

const src = (bar: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Settings" label="Settings" enabled="true" visible="true" x="0" y="0" width="402" height="874">` +
  `<XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" x="0" y="0" width="402" height="874">` +
  bar +
  `<XCUIElementTypeTable type="XCUIElementTypeTable" enabled="true" visible="true" x="0" y="116" width="402" height="758"/>` +
  `</XCUIElementTypeWindow></XCUIElementTypeApplication>`;
const NAV_WITH_BACK = src(
  `<XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="General" enabled="true" visible="true" x="0" y="62" width="402" height="54">` +
    `<XCUIElementTypeButton type="XCUIElementTypeButton" name="Settings" label="Settings" enabled="true" visible="true" x="8" y="66" width="100" height="44"/>` +
    `<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="General" label="General" enabled="true" visible="true" x="170" y="75" width="62" height="22"/>` +
    `</XCUIElementTypeNavigationBar>`,
);
const ROOT_NAV_TRAILING_ONLY = src(
  `<XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="Settings" enabled="true" visible="true" x="0" y="62" width="402" height="54">` +
    `<XCUIElementTypeButton type="XCUIElementTypeButton" name="Edit" label="Edit" enabled="true" visible="true" x="330" y="66" width="60" height="44"/>` +
    `</XCUIElementTypeNavigationBar>`,
);

describe('H: iOS back on WDA', () => {
  beforeEach(() => {
    wda.tapWdaPoint.mockClear();
    wda.dragWdaPoint.mockClear();
    wda.wdaFetchBack.mockClear();
  });

  it('taps the navigation bar back button when present', async () => {
    wda.source = NAV_WITH_BACK;
    const d = new WdaDriver('http://127.0.0.1:8100', { sessionId: 'S1', udid: UDID });
    await d.pressKey('back');
    expect(wda.tapWdaPoint).toHaveBeenCalledWith('http://127.0.0.1:8100', 'S1', 58, 88);
    expect(wda.dragWdaPoint).not.toHaveBeenCalled();
    expect(wda.wdaFetchBack).not.toHaveBeenCalled();
    expect(d.lastBackVia).toBe('nav_button');
  });

  it('a trailing-only nav bar is not "back" → left-edge swipe at mid-height', async () => {
    wda.source = ROOT_NAV_TRAILING_ONLY;
    expect(iosBackButtonPoint(ROOT_NAV_TRAILING_ONLY)).toBeNull();
    const d = new WdaDriver('http://127.0.0.1:8100', { sessionId: 'S1', udid: UDID });
    await d.pressKey('back');
    expect(wda.tapWdaPoint).not.toHaveBeenCalled();
    expect(wda.dragWdaPoint).toHaveBeenCalledWith('http://127.0.0.1:8100', 'S1', 2, 437, 241, 437, expect.any(Number));
    expect(wda.wdaFetchBack).not.toHaveBeenCalled();
    expect(d.lastBackVia).toBe('edge_swipe');
  });

  it('no nav button and no screen size → BACKEND_UNSUPPORTED', async () => {
    wda.source = '<?xml version="1.0"?><XCUIElementTypeApplication type="XCUIElementTypeApplication"/>';
    wda.wdaWindowSize.mockRejectedValueOnce(new Error('no /window/size'));
    const d = new WdaDriver('http://127.0.0.1:8100', { sessionId: 'S1', udid: UDID });
    await expect(d.pressKey('back')).rejects.toThrow(/BACKEND_UNSUPPORTED/);
  });
});

describe('G: WdaDriver.hideKeyboard when WDA cannot dismiss', () => {
  it('resolves false instead of throwing an untyped error', async () => {
    wda.dismissWdaKeyboard.mockRejectedValueOnce(
      new WdaHttpError(
        400,
        'Did not know how to dismiss the keyboard. Try to dismiss it in the way supported by your application under test.',
        '',
      ),
    );
    const d = new WdaDriver('http://127.0.0.1:8100', { sessionId: 'S1', udid: UDID });
    await expect(d.hideKeyboard()).resolves.toBe(false);
  });
});
