// qa_test_this execute preflight: every app install is consent-gated on both platforms (an APK inside
// the project root used to install silently while the iOS equivalent asked), and a source build is
// rated high risk like qa_build.
import { describe, expect, it } from 'vitest';
import { buildTestThisPreflight } from '../src/services/preflight.js';

const base = { needBuild: false, willBoot: false, isAab: false };

describe('buildTestThisPreflight consent', () => {
  it('requires consent to install an in-root APK and shows the exact command', () => {
    const p = buildTestThisPreflight({ ...base, isAndroid: true, apkPath: '/repo/app/build/app-debug.apk' });
    expect(p.consentRequired).toBe(true);
    expect(p.exactCommand).toContain('install_apk: adb install -r -g /repo/app/build/app-debug.apk');
  });

  it('still requires consent for the iOS simulator install (parity)', () => {
    const p = buildTestThisPreflight({ ...base, isAndroid: false, iosApp: '/repo/build/App.app' });
    expect(p.consentRequired).toBe(true);
  });

  it('rates a build from source as high risk', () => {
    const p = buildTestThisPreflight({
      ...base,
      isAndroid: true,
      needBuild: true,
      buildPlatform: 'android',
      buildCommand: './gradlew assembleDebug',
    });
    expect(p.risk).toBe('high');
  });

  it('launching an already-installed app alone needs no consent', () => {
    const p = buildTestThisPreflight({ ...base, isAndroid: true });
    expect(p.consentRequired).toBe(false);
  });
});
