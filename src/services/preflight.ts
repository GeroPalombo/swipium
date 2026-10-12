// Execution preflight + consent: compute the privileged steps a high-level
// run will perform, so qa_test_this execute requests the SAME consent the lower-level tools would
// (boot, external-APK install, iOS .app install, build-from-source). The high-level tool must never
// be less safe than the tool it orchestrates.
//
// PURE: callers pass already-resolved facts (no device/filesystem here, except the caller hashes an
// external APK and passes the digest in).

import { emulatorBootArgs } from '../lib/android.js'; // pure argv builder: consent shows the real command

export type PrivilegedKind =
  | 'build_from_source'
  | 'boot_emulator'
  | 'boot_simulator'
  | 'install_apk'
  | 'install_external_apk'
  | 'install_ios_app'
  | 'install_ios_real'
  | 'aab_convert'
  | 'launch_app';

export type Risk = 'low' | 'medium' | 'high';

export interface PrivilegedStep {
  kind: PrivilegedKind;
  risk: Risk;
  affects: Record<string, unknown>;
  exactCommand?: string;
  consentRequired: boolean;
}

export interface ExecutionPreflight {
  steps: PrivilegedStep[];
  consentRequired: boolean;
  consentAction: 'test_this_plan';
  consentAffects: Record<string, unknown>;
  exactCommand: string;
  risk: Risk;
}

export interface TestThisPreflightInput {
  isAndroid: boolean;
  needBuild: boolean;
  buildPlatform?: 'android' | 'ios';
  buildCommand?: string;
  willBoot: boolean;
  bootTarget?: string;
  /** The online adb serial / simulator UDID the run targets (absent when it boots `bootTarget`).
   *  Named in the install commands + affects so the approval says WHICH device it applies to. */
  device?: string;
  headless?: boolean;
  isAab: boolean;
  /** Android: the APK that will be installed (after build/convert), if known. */
  apkPath?: string;
  /** Android: present + hashed when the APK is outside the project root. */
  externalApk?: { path: string; sha256: string };
  /** iOS: the .app that will be installed, if any. */
  iosApp?: string;
  /** iOS: whether the .app is outside the project root. */
  iosAppOutsideRoot?: boolean;
  /** iOS real device: install on physical hardware via devicectl (high risk). */
  iosReal?: boolean;
  iosRealUdid?: string;
  iosRealApp?: string;
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** Compute the privileged-step plan + a single combined consent for a qa_test_this execute run. */
export function buildTestThisPreflight(i: TestThisPreflightInput): ExecutionPreflight {
  const steps: PrivilegedStep[] = [];
  // The device every install below lands on (the online target, or the one this plan boots).
  const device = i.device ?? (i.willBoot ? i.bootTarget : undefined);
  const adbS = i.device ? `adb -s ${i.device}` : i.willBoot && i.bootTarget ? `adb -s <${i.bootTarget} once booted>` : 'adb';

  const bootStep: PrivilegedStep | undefined = i.willBoot
    ? {
        kind: i.isAndroid ? 'boot_emulator' : 'boot_simulator',
        risk: 'low',
        consentRequired: true,
        affects: { target: i.bootTarget, headless: i.headless ?? true },
        exactCommand: i.isAndroid
          ? `emulator ${emulatorBootArgs(String(i.bootTarget), i.headless !== false).join(' ')}`
          : `xcrun simctl boot ${i.bootTarget}`,
      }
    : undefined;
  // An Android run boots the AVD before the build (pipeline step A), so the consent lists it first too.
  if (bootStep && i.isAndroid) steps.push(bootStep);
  if (i.needBuild) {
    steps.push({
      kind: 'build_from_source',
      risk: 'high', // runs arbitrary repo scripts (gradle/xcodebuild/npm), same rating as qa_build
      consentRequired: true,
      affects: { platform: i.buildPlatform },
      exactCommand: i.buildCommand,
    });
  }
  if (i.isAab) {
    // Safe: writes a cached universal APK inside .swipium using local files. No consent.
    steps.push({ kind: 'aab_convert', risk: 'low', consentRequired: false, affects: {} });
  }
  if (bootStep && !i.isAndroid) steps.push(bootStep);
  if (i.isAndroid) {
    if (i.externalApk) {
      steps.push({
        kind: 'install_external_apk',
        risk: 'medium',
        consentRequired: true,
        affects: { path: i.externalApk.path, sha256: i.externalApk.sha256, ...(device ? { device } : {}) },
        exactCommand: `${adbS} install -r -g ${i.externalApk.path}`,
      });
    } else if (i.apkPath) {
      steps.push({
        kind: 'install_apk',
        risk: 'low',
        consentRequired: true, // every install is consent-gated (matches install_ios_app and qa_prepare_target)
        affects: { path: i.apkPath, ...(device ? { device } : {}) },
        exactCommand: `${adbS} install -r -g ${i.apkPath}`,
      });
    }
  } else if (i.iosReal) {
    // Installing on PHYSICAL hardware via devicectl is always high risk + consent.
    steps.push({
      kind: 'install_ios_real',
      risk: 'high',
      consentRequired: true,
      affects: { app: i.iosRealApp, udid: i.iosRealUdid },
      exactCommand: `xcrun devicectl device install app --device ${i.iosRealUdid ?? '<udid>'} ${i.iosRealApp ?? '<app>'}`,
    });
  } else if (i.iosApp) {
    steps.push({
      kind: 'install_ios_app',
      risk: i.iosAppOutsideRoot ? 'medium' : 'low',
      consentRequired: true,
      affects: { app: i.iosApp, external: !!i.iosAppOutsideRoot, ...(device ? { device } : {}) },
      exactCommand: `xcrun simctl install ${device ?? '<booted>'} ${i.iosApp}`,
    });
  }
  steps.push({ kind: 'launch_app', risk: 'low', consentRequired: false, affects: {} });

  const consentSteps = steps.filter((s) => s.consentRequired);
  const consentRequired = consentSteps.length > 0;
  const risk: Risk = consentSteps.reduce<Risk>((acc, s) => (RISK_ORDER[s.risk] > RISK_ORDER[acc] ? s.risk : acc), 'low');
  const exactCommand = consentSteps.map((s) => `• ${s.kind}${s.exactCommand ? `: ${s.exactCommand}` : ''}`).join('\n');
  const consentAffects = { steps: consentSteps.map((s) => ({ kind: s.kind, affects: s.affects })) };

  return { steps, consentRequired, consentAction: 'test_this_plan', consentAffects, exactCommand, risk };
}
