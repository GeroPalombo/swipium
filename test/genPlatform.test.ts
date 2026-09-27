// Real-device smoke regressions (B, C):
//  B. An Android-only session generated conftest.py / capabilities.js defaulting SWIPIUM_PLATFORM to
//     "ios", and platform:"ios" was reported as appium-uiautomator2 "Android-only (or default)".
//     Resolution order: explicit arg → session device platform → project profile → android.
//  C. The generated Python suite failed its OWN validation (it uses UiAutomator2Options /
//     XCUITestOptions, not a literal `platformName`).

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-gen-platform-home-'));
process.env.HOME = fakeHome;

const { buildProjectProfile } = await import('../src/automationGen/projectProfile.js');
const { buildSuitePlan } = await import('../src/automationGen/suitePlan.js');
const { sessionDevicePlatform } = await import('../src/automationGen/platformResolve.js');
const { SessionStore } = await import('../src/session/store.js');
const { assembleAutomationSuite } = await import('../src/services/automationGenerate.js');
const { validateGeneratedSuite } = await import('../src/automationGen/validation.js');
type RecordedAction = import('../src/session/store.js').RecordedAction;

const roots: string[] = [];
function root(files: Record<string, string> = {}): string {
  const r = mkdtempSync(join(tmpdir(), 'swipium-gen-platform-proj-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(r, p, '..'), { recursive: true });
    writeFileSync(join(r, p), c);
  }
  roots.push(r);
  return r;
}
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const IOS_SIM = '8F3C2A10-1B2C-4D5E-8F90-ABCDEF123456';

function sessionOn(device: string, driverKind?: 'direct' | 'wda' | 'simulator', lang: 'python' | 'typescript' = 'python') {
  const store = new SessionStore();
  const s = store.create(root({ 'package.json': '{"name":"x"}' }));
  s.device = device;
  if (driverKind) s.driver = { kind: driverKind } as never;
  s.appId = 'com.example.app';
  const a: RecordedAction = {
    at: 0,
    action: 'tap',
    selector: 'login_btn',
    selectorKind: 'resource_id',
    exportability: 'semantic',
    screen: 'Login',
  };
  store.addRecordedAction(s, a);
  return { store, s, lang };
}

function fileOf(files: Array<{ path: string; content: string }>, re: RegExp): string {
  const f = files.find((x) => re.test(x.path));
  expect(f, String(re)).toBeDefined();
  return f!.content;
}

describe('sessionDevicePlatform', () => {
  it('driver kind is authoritative; else Android serial vs iOS UDID shape', () => {
    expect(sessionDevicePlatform({ device: 'emulator-5554' } as never)).toBe('android');
    expect(sessionDevicePlatform({ device: 'R58M123ABC' } as never)).toBe('android');
    expect(sessionDevicePlatform({ device: IOS_SIM } as never)).toBe('ios');
    expect(sessionDevicePlatform({ device: '00008030-001A2B3C4D5E6F7A' } as never)).toBe('ios');
    expect(sessionDevicePlatform({ device: IOS_SIM, driver: { kind: 'direct' } } as never)).toBe('android');
    expect(sessionDevicePlatform({ device: 'emulator-5554', driver: { kind: 'wda' } } as never)).toBe('ios');
    expect(sessionDevicePlatform({} as never)).toBeUndefined();
  });
});

describe('platform resolution: explicit → session device → project → android (B)', () => {
  it('Android-only session on a project with no platform evidence → android default + UiAutomator2', () => {
    const { s } = sessionOn('emulator-5554', 'direct');
    const a = assembleAutomationSuite(s, { language: 'python' });
    expect(a.profile.primaryPlatform).toBe('android');
    expect(a.profile.platformSource).toBe('session');
    expect(a.profile.defaultBackend).toBe('appium-uiautomator2');
    expect(a.profile.platforms.android.level).not.toBe('none');
    expect(fileOf(a.files, /conftest\.py$/)).toContain('os.environ.get("SWIPIUM_PLATFORM", "android")');
    const js = assembleAutomationSuite(s, { language: 'javascript' });
    expect(fileOf(js.files, /capabilities\.js$/)).toContain(`process.env.SWIPIUM_PLATFORM || "android"`);
    expect(fileOf(js.files, /README\.md$/)).toContain('`android` (default)');
  });

  it('iOS simulator session → ios default + XCUITest', () => {
    const { s } = sessionOn(IOS_SIM);
    const a = assembleAutomationSuite(s, { language: 'python' });
    expect(a.profile.primaryPlatform).toBe('ios');
    expect(a.profile.defaultBackend).toBe('appium-xcuitest');
    expect(fileOf(a.files, /conftest\.py$/)).toContain('os.environ.get("SWIPIUM_PLATFORM", "ios")');
    expect(a.plan.primaryPlatform).toBe('ios');
    expect(a.plan.backends.default).toBe('appium-xcuitest');
  });

  it('explicit platform:"ios" beats an Android session and is never reported as UiAutomator2 / "Android-only"', () => {
    const { s } = sessionOn('emulator-5554', 'direct');
    const a = assembleAutomationSuite(s, { language: 'typescript', platform: 'ios' });
    expect(a.profile.defaultBackend).toBe('appium-xcuitest');
    expect(a.profile.platformSource).toBe('explicit');
    expect(a.profile.platforms.ios.level).not.toBe('none');
    expect(a.profile.reasons.join('\n')).not.toMatch(/Android-only/);
    expect(fileOf(a.files, /capabilities\.ts$/)).toContain(`process.env.SWIPIUM_PLATFORM || "ios"`);
  });

  it('explicit platform:"ios" on a bare project (no session) → XCUITest', () => {
    const p = buildProjectProfile(root(), { platform: 'ios' });
    expect(p.defaultBackend).toBe('appium-xcuitest');
    expect(p.platforms.ios.level).toBe('evidence_only');
    expect(buildSuitePlan(p).platforms.ios).toBe(true);
  });

  it('project profile decides without session/arg; nothing at all → android default', () => {
    const iosOnly = buildProjectProfile(root({ 'ios/Podfile': '' }));
    expect(iosOnly.defaultBackend).toBe('appium-xcuitest');
    expect(iosOnly.platformSource).toBe('project');
    const dual = buildProjectProfile(root({ 'ios/Podfile': '', 'android/build.gradle': '' }));
    expect(dual.defaultBackend).toBe('appium-uiautomator2');
    expect(dual.secondaryBackend).toBe('appium-xcuitest');
    const dualOnIos = buildProjectProfile(root({ 'ios/Podfile': '', 'android/build.gradle': '' }), { sessionPlatform: 'ios' });
    expect(dualOnIos.defaultBackend).toBe('appium-xcuitest');
    expect(dualOnIos.secondaryBackend).toBe('appium-uiautomator2');
    const none = buildProjectProfile(root());
    expect(none.defaultBackend).toBe('appium-uiautomator2');
    expect(none.platformSource).toBe('default');
  });
});

describe('generated Python passes its own validation (C)', () => {
  for (const [label, device] of [
    ['android', 'emulator-5554'],
    ['ios', IOS_SIM],
  ] as const) {
    it(`${label} pytest suite has no INVALID_CAPABILITIES`, () => {
      const { s } = sessionOn(device);
      const a = assembleAutomationSuite(s, { language: 'python' });
      const v = validateGeneratedSuite(a.files, { secrets: a.model.secrets, secretValues: s.secrets });
      expect(v.findings.filter((f) => f.code === 'INVALID_CAPABILITIES' || f.code === 'NO_CAPABILITIES')).toEqual([]);
      expect(v.ok).toBe(true);
    });
  }

  it('still rejects a conftest with neither platformName nor typed options', () => {
    const v = validateGeneratedSuite([{ path: 'conftest.py', content: 'import os\n# UiAutomator2 mentioned only\n' }]);
    expect(v.findings.some((f) => f.code === 'INVALID_CAPABILITIES')).toBe(true);
  });
});
