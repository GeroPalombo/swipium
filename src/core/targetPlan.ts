// Target Resolver (roadmap §5) — pick the best available device/simulator for a first run,
// deterministically, so "test this" does not depend on agent improvisation. PURE: callers
// gather the live inputs (online adb devices, AVDs, simulators, the resolved artifact's
// platform) and pass them in; this module applies the decision order and explains the choice.
//
// Decision order (§5):
//   1. Explicit platform/device request wins.
//   2. A platform-specific artifact constrains the platform.
//   3. Prefer an already-online device/simulator (fastest).
//   4. Prefer emulator/simulator for the first run.
//   5. Physical devices are visible but REFUSED (typed PHYSICAL_DEVICE_UNSUPPORTED): Swipium is
//      simulator/emulator-only by policy until the real-device threat model lands
//      (THREAT_MODEL.md non-goals, docs/physical-devices.md).
//   6. If nothing is running, boot the fastest known emulator/simulator.

import type { FailureCode } from '../oracle/failures.js';
import type { ArtifactPlatform, InstallTarget } from '../artifacts/resolve.js';

export type TargetSelection = 'android-emulator' | 'android-real' | 'ios-simulator' | 'ios-real';

export interface TargetInputs {
  requestedPlatform?: 'android' | 'ios';
  requestedDevice?: string; // adb serial, simulator udid, or AVD/sim name
  preferRealDevice?: boolean;
  artifactPlatform?: ArtifactPlatform;
  artifactInstallTargets?: InstallTarget[];
  /** `emulators`: online serials verified as emulators by device properties (ro.kernel.qemu /
   * ro.boot.qemu / Genymotion — see session/attach.ts classifyAndroidSerials). Needed for
   * emulators whose serial isn't `emulator-N` (e.g. `localhost:5555`, Genymotion). */
  android: { online: string[]; avds: string[]; emulators?: string[] };
  ios: {
    bootedSimulators: Array<{ udid: string; name: string }>;
    availableSimulators: Array<{ udid: string; name: string }>;
    realDevices?: string[];
  };
  /** Whether WebDriverAgent is available (structured iOS automation needs it). */
  wdaAvailable?: boolean;
}

export interface TargetPlan {
  selected: TargetSelection | null;
  device?: string; // specific serial/udid when one is chosen
  reason: string;
  alternatives: TargetSelection[];
  preconditions: string[];
  willBoot: boolean;
  bootTarget?: string; // AVD name or simulator udid to boot
  blocked?: { failureCode: FailureCode; detail: string };
}

/** Serial-pattern emulator check (adb names local emulators `emulator-<port>`). */
export function isEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+/.test(serial);
}

/** The policy predicate: pattern match OR property-verified emulator (TargetInputs.android.emulators). */
function emulatorPredicate(i: TargetInputs): (serial: string) => boolean {
  const verified = new Set(i.android.emulators ?? []);
  return (serial) => isEmulatorSerial(serial) || verified.has(serial);
}

/** Which platforms have ANY usable device (online or bootable)? Physical devices are not usable by policy. */
function platformsViable(i: TargetInputs): TargetSelection[] {
  const out: TargetSelection[] = [];
  const isEmulator = emulatorPredicate(i);
  if (i.android.online.some(isEmulator) || i.android.avds.length) out.push('android-emulator');
  if (i.ios.bootedSimulators.length || i.ios.availableSimulators.length) out.push('ios-simulator');
  return out;
}

/** Typed refusal for a visible physical device — agents get "why", not a bare NO_DEVICE. */
function physicalDeviceRefusal(device: string, alternatives: TargetSelection[]): TargetPlan {
  return {
    selected: null,
    reason: `Physical device ${device} is visible, but Swipium is simulator/emulator-only by policy (real user data — see docs/physical-devices.md).`,
    alternatives,
    preconditions: [],
    willBoot: false,
    blocked: {
      failureCode: 'PHYSICAL_DEVICE_UNSUPPORTED',
      detail: `Physical device ${device} is visible but refused: real-device testing is out of scope until its threat model lands. Use an emulator/simulator.`,
    },
  };
}

function planAndroid(i: TargetInputs, reasonPrefix: string): TargetPlan {
  const online = i.android.online;
  const isEmulator = emulatorPredicate(i);
  const real = online.find((s) => !isEmulator(s));
  const emu = online.find((s) => isEmulator(s));

  if (i.preferRealDevice && real) {
    // Even an explicit request is refused — the policy is server-side, not client-negotiable.
    return physicalDeviceRefusal(real, emu || i.android.avds.length ? ['android-emulator'] : []);
  }
  if (emu) {
    return {
      selected: 'android-emulator',
      device: emu,
      reason:
        `${reasonPrefix}emulator ${emu} is already online (fastest).` +
        (real ? ` (Physical device ${real} is visible but out of scope — simulator-only policy.)` : ''),
      alternatives: [],
      preconditions: [],
      willBoot: false,
    };
  }
  if (i.android.avds.length) {
    return {
      selected: 'android-emulator',
      reason:
        `${reasonPrefix}no emulator online — will boot AVD "${i.android.avds[0]}".` +
        (real ? ` (Physical device ${real} is visible but out of scope — simulator-only policy.)` : ''),
      alternatives: [],
      preconditions: ['emulator boot (~30-60s)'],
      willBoot: true,
      bootTarget: i.android.avds[0],
    };
  }
  if (real) return physicalDeviceRefusal(real, []);
  return {
    selected: null,
    reason: `${reasonPrefix}no Android device online and no AVD to boot.`,
    alternatives: [],
    preconditions: [],
    willBoot: false,
    blocked: { failureCode: 'NO_DEVICE', detail: 'No Android device online and no AVD available — create one (qa_doctor).' },
  };
}

function planIos(i: TargetInputs, reasonPrefix: string): TargetPlan {
  const iosPre = i.wdaAvailable === false ? ['WDA required for structured iOS tap/type/snapshot (qa_wda); else visual-only'] : [];
  if (i.preferRealDevice && i.ios.realDevices?.length) {
    // Even an explicit request is refused — the policy is server-side, not client-negotiable.
    const simViable = i.ios.bootedSimulators.length > 0 || i.ios.availableSimulators.length > 0;
    return physicalDeviceRefusal(i.ios.realDevices[0], simViable ? ['ios-simulator'] : []);
  }
  if (i.ios.bootedSimulators.length) {
    const s = i.ios.bootedSimulators[0];
    return {
      selected: 'ios-simulator',
      device: s.udid,
      reason: `${reasonPrefix}simulator "${s.name}" is already booted (fastest).`,
      alternatives: [],
      preconditions: iosPre,
      willBoot: false,
    };
  }
  if (i.ios.availableSimulators.length) {
    const s = i.ios.availableSimulators[0];
    return {
      selected: 'ios-simulator',
      reason: `${reasonPrefix}no simulator booted — will boot "${s.name}".`,
      alternatives: [],
      preconditions: ['simulator boot (~10-30s)', ...iosPre],
      willBoot: true,
      bootTarget: s.udid,
    };
  }
  return {
    selected: null,
    reason: `${reasonPrefix}no iOS simulator booted or available.`,
    alternatives: [],
    preconditions: [],
    willBoot: false,
    blocked: {
      failureCode: 'SIMULATOR_RUNTIME_MISSING',
      detail: 'No iOS simulator available — install a runtime / create a simulator in Xcode.',
    },
  };
}

/** PURE: the typed blocker for an artifact that can never install on the chosen target, or null. */
export function artifactTargetMismatch(
  selected: TargetSelection,
  installTargets: InstallTarget[] | undefined,
): { failureCode: FailureCode; detail: string } | null {
  if (!installTargets || installTargets.length === 0) return null; // unknown / archive-only → don't second-guess here
  if (installTargets.includes(selected as InstallTarget)) return null;
  // Specific, common impossibilities get a precise code.
  if (selected === 'ios-simulator' && installTargets.includes('ios-real')) {
    return {
      failureCode: 'IPA_NEEDS_REAL_DEVICE',
      detail: 'The resolved artifact installs only on a real iOS device, but the plan selected the simulator.',
    };
  }
  if (selected === 'ios-real' && installTargets.includes('ios-simulator')) {
    return { failureCode: 'IOS_APP_WRONG_ARCH', detail: 'The resolved artifact is a simulator .app, but the plan selected a real device.' };
  }
  return {
    failureCode: 'WRONG_ARCH',
    detail: `The resolved artifact installs on [${installTargets.join(', ')}], not the selected ${selected}.`,
  };
}

export function planTarget(i: TargetInputs): TargetPlan {
  const plan = planTargetCore(i);
  // Refuse impossible artifact/target combinations (plan §7). Only when a target was selected
  // and the artifact's install targets are known and exclude it.
  if (plan.selected && !plan.blocked) {
    const mismatch = artifactTargetMismatch(plan.selected, i.artifactInstallTargets);
    if (mismatch) {
      return { ...plan, blocked: mismatch, reason: `${plan.reason} BUT ${mismatch.detail}` };
    }
  }
  return plan;
}

function planTargetCore(i: TargetInputs): TargetPlan {
  // 1. Explicit device wins — figure out its platform from where it appears.
  if (i.requestedDevice) {
    const dev = i.requestedDevice;
    if (i.android.online.includes(dev) || i.android.avds.includes(dev)) {
      const online = i.android.online.includes(dev);
      const isEmulator = emulatorPredicate(i);
      if (online && !isEmulator(dev)) {
        return physicalDeviceRefusal(dev, i.android.online.some(isEmulator) || i.android.avds.length ? ['android-emulator'] : []);
      }
      return {
        selected: 'android-emulator',
        device: online ? dev : undefined,
        reason: `Honoring requested device "${dev}".`,
        alternatives: [],
        preconditions: [],
        willBoot: !online,
        bootTarget: online ? undefined : dev,
      };
    }
    const simBooted = i.ios.bootedSimulators.find((s) => s.udid === dev || s.name === dev);
    const simAvail = i.ios.availableSimulators.find((s) => s.udid === dev || s.name === dev);
    if (simBooted)
      return {
        selected: 'ios-simulator',
        device: simBooted.udid,
        reason: `Honoring requested simulator "${dev}".`,
        alternatives: [],
        preconditions: [],
        willBoot: false,
      };
    if (simAvail)
      return {
        selected: 'ios-simulator',
        reason: `Honoring requested simulator "${dev}" — will boot it.`,
        alternatives: [],
        preconditions: ['simulator boot'],
        willBoot: true,
        bootTarget: simAvail.udid,
      };
    if (i.ios.realDevices?.includes(dev))
      return physicalDeviceRefusal(dev, i.ios.bootedSimulators.length || i.ios.availableSimulators.length ? ['ios-simulator'] : []);
    return {
      selected: null,
      reason: `Requested device "${dev}" is not online/available.`,
      alternatives: [],
      preconditions: [],
      willBoot: false,
      blocked: { failureCode: 'NO_DEVICE', detail: `Device "${dev}" not found among online devices/simulators.` },
    };
  }

  // 2. Explicit platform, else artifact-constrained platform.
  const platform = i.requestedPlatform ?? (i.artifactPlatform as 'android' | 'ios' | undefined);
  if (platform === 'android') return planAndroid(i, 'Android chosen: ');
  if (platform === 'ios') return planIos(i, 'iOS chosen: ');

  // 3-6. No constraint: pick deterministically. Prefer a platform with an online device,
  // then a bootable one; tie → Android (most common QA-first target).
  const androidOnline = i.android.online.length > 0;
  const iosBooted = i.ios.bootedSimulators.length > 0;
  if (androidOnline && !iosBooted) return planAndroid(i, 'Auto: Android device already online — ');
  if (iosBooted && !androidOnline) return planIos(i, 'Auto: iOS simulator already booted — ');
  if (androidOnline && iosBooted) {
    const a = planAndroid(i, 'Auto: both online, defaulting to Android — ');
    a.alternatives = [...new Set<TargetSelection>([...a.alternatives, 'ios-simulator'])];
    return a;
  }
  // Nothing online: boot the fastest available (simulator boots faster than an emulator).
  const viable = platformsViable(i);
  if (i.ios.availableSimulators.length) {
    const p = planIos(i, 'Auto: nothing online — booting a simulator (fastest) — ');
    p.alternatives = [...new Set<TargetSelection>([...p.alternatives, ...viable.filter((v) => v !== 'ios-simulator')])];
    return p;
  }
  if (i.android.avds.length) {
    const p = planAndroid(i, 'Auto: nothing online — booting an emulator — ');
    p.alternatives = [...new Set<TargetSelection>([...p.alternatives, ...viable.filter((v) => v !== 'android-emulator')])];
    return p;
  }
  return {
    selected: null,
    reason: 'No device or simulator is online or bootable on this machine.',
    alternatives: [],
    preconditions: [],
    willBoot: false,
    blocked: {
      failureCode: 'NO_DEVICE',
      detail: 'No Android emulator/device and no iOS simulator available — set one up (qa_doctor / Xcode).',
    },
  };
}
