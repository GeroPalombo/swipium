// Centralized device resolution + lazy driver attach (Phase 2.1). One place decides
// "which device" so qa_doctor / qa_prepare_target / UI tools
// all agree: a session-bound device, the single online device, or "needs selection".

import { adbDevices } from '../lib/android.js';
import { run } from '../lib/spawn.js';
import { DirectDriver } from '../drivers/DirectDriver.js';
import { SimctlDriver } from '../drivers/SimctlDriver.js';
import { WdaDriver } from '../drivers/WdaDriver.js';
import { listSimulators, type Simulator } from '../lib/simctl.js';
import { checkWda } from '../lib/wda.js';
import { loadWdaConfig } from '../lib/wdaConfig.js';
import { isEmulatorSerial } from '../core/targetPlan.js';
import type { Session } from './store.js';
import type { Driver } from '../drivers/Driver.js';
import type { FailureCode } from '../oracle/failures.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaError } from '../lib/result.js';

/** What `getprop` says about an online adb device (H6). */
export interface AndroidDeviceProbe {
  serial: string;
  /** Could the device properties be read at all (offline/unauthorized → false)? */
  propsRead: boolean;
  emulator: boolean;
  /** sys.boot_completed == 1 */
  booted: boolean;
}

/** PURE: parse `adb shell getprop` output (`[key]: [value]` lines). */
export function parseGetprop(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of stdout.matchAll(/^\[([^\]]+)\]:\s*\[([^\]]*)\]/gm)) out[m[1]] = m[2];
  return out;
}

/** PURE: emulator/boot verdict from a serial + its properties. Emulator = the adb serial
 * pattern OR the qemu flags (`localhost:5555`, `127.0.0.1:NNNN` emulators) OR Genymotion. */
export function classifyAndroidProps(serial: string, props: Record<string, string>): { emulator: boolean; booted: boolean } {
  const emulator =
    isEmulatorSerial(serial) ||
    props['ro.kernel.qemu'] === '1' ||
    props['ro.boot.qemu'] === '1' ||
    /^(goldfish|ranchu)$/.test(props['ro.hardware'] ?? '') ||
    !!props['ro.genymotion.version'] ||
    /^genymotion$/i.test(props['ro.product.manufacturer'] ?? '');
  return { emulator, booted: props['sys.boot_completed'] === '1' };
}

/** One `getprop` call → emulator + boot state. */
export async function probeAndroidDevice(serial: string): Promise<AndroidDeviceProbe> {
  try {
    const r = await run('adb', ['-s', serial, 'shell', 'getprop'], { timeoutMs: 8000 });
    const props = parseGetprop(r.stdout);
    if (r.code !== 0 || Object.keys(props).length === 0) {
      return { serial, propsRead: false, emulator: isEmulatorSerial(serial), booted: false };
    }
    return { serial, propsRead: true, ...classifyAndroidProps(serial, props) };
  } catch {
    return { serial, propsRead: false, emulator: isEmulatorSerial(serial), booted: false };
  }
}

/** Split online serials by policy — callers of planTarget pass `emulators` as
 * TargetInputs.android.emulators so non-`emulator-N` emulators are not refused as physical. */
export async function classifyAndroidSerials(
  serials: string[],
): Promise<{ emulators: string[]; physical: string[]; booting: string[]; unknown: string[] }> {
  const probes = await Promise.all(serials.map(probeAndroidDevice));
  return {
    emulators: probes.filter((p) => p.emulator).map((p) => p.serial),
    physical: probes.filter((p) => p.propsRead && !p.emulator).map((p) => p.serial),
    booting: probes.filter((p) => p.propsRead && p.emulator && !p.booted).map((p) => p.serial),
    unknown: probes.filter((p) => !p.propsRead).map((p) => p.serial),
  };
}

/** Emulator serials among `online`: `emulator-N` directly, any other serial via one getprop
 * probe (ro.kernel.qemu / ro.boot.qemu / Genymotion). Feed to TargetInputs.android.emulators. */
export async function verifiedEmulatorSerials(online: string[]): Promise<string[]> {
  const verdicts = await Promise.all(online.map(async (s) => isEmulatorSerial(s) || (await probeAndroidDevice(s)).emulator));
  return online.filter((_, i) => verdicts[i]);
}

export type AttachBlocked = { failureCode: FailureCode; detail: string; nextSteps?: string[] };

/** Shared "why is there no driver" answer for tools: the typed refusal when getDriver saw an
 * online device it may not bind (physical / still booting), else undefined so the caller's
 * generic "No device attached" stands. Usage: `return blockedDeviceResult(blocked) ?? qaError(…)`. */
export function blockedDeviceResult(blocked?: AttachBlocked): CallToolResult | undefined {
  if (!blocked) return undefined;
  const notReady = blocked.failureCode === 'DEVICE_NOT_READY';
  return qaError({
    what: blocked.detail,
    changedState: false,
    retrySafe: notReady,
    failureCode: blocked.failureCode,
    nextSteps: blocked.nextSteps?.length
      ? blocked.nextSteps
      : notReady
        ? ['Wait for the emulator to finish booting, then retry.']
        : ['Start an Android emulator (qa_prepare_target boots one), then retry.'],
  });
}

/** PURE: the typed refusal for a probed device, or null when it may be bound. Same policy
 * as core/targetPlan (PHYSICAL_DEVICE_UNSUPPORTED) plus a boot-completed gate. */
export function attachBlocker(p: AndroidDeviceProbe): AttachBlocked | null {
  if (!p.propsRead) {
    return {
      failureCode: 'DEVICE_NOT_READY',
      detail: `Could not read device properties from ${p.serial} (offline, unauthorized, or still starting) — wait for it to come online, then retry.`,
    };
  }
  if (!p.emulator) {
    return {
      failureCode: 'PHYSICAL_DEVICE_UNSUPPORTED',
      detail: `Physical device ${p.serial} is online but refused: Swipium is simulator/emulator-only by policy (docs/physical-devices.md). Use an emulator.`,
    };
  }
  if (!p.booted) {
    return {
      failureCode: 'DEVICE_NOT_READY',
      detail: `Emulator ${p.serial} is still booting (sys.boot_completed != 1) — wait for boot to finish, then retry.`,
    };
  }
  return null;
}

export interface DeviceResolution {
  sessionDevice?: string; // bound to the session AND still online
  available: string[]; // all online serials
  effective?: string; // the device to act on (session > arg > single-online)
  needSelection: boolean; // >1 online and none chosen
  source: 'session' | 'arg' | 'single-online' | 'none';
}

/** TEST SEAM (P1 §6). When set, getDriver() binds the driver this factory returns instead of
 * discovering a real device — so handler-level tests can drive tools with a fake driver and no
 * adb. Never set in production code paths; a no-op unless a test installs it. */
let testDriverFactory: ((session: Session) => Driver | undefined) | undefined;
export function setDriverFactoryForTests(factory?: (session: Session) => Driver | undefined): void {
  testDriverFactory = factory;
}

export async function resolveDevice(session: Session, prefer?: string): Promise<DeviceResolution> {
  // Test-isolation hook (SWIPIUM-REQ-08 regression requirement): when set, device auto-discovery is
  // disabled so "no device" tests assert no-device behavior even on a machine with a live emulator.
  if (process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY) {
    return { sessionDevice: undefined, available: [], effective: undefined, needSelection: false, source: 'none' };
  }
  const available = await adbDevices();
  const sessionDevice = session.device && available.includes(session.device) ? session.device : undefined;
  if (prefer) {
    return available.includes(prefer)
      ? { sessionDevice, available, effective: prefer, needSelection: false, source: 'arg' }
      : { sessionDevice, available, effective: undefined, needSelection: false, source: 'none' };
  }
  if (sessionDevice) return { sessionDevice, available, effective: sessionDevice, needSelection: false, source: 'session' };
  if (available.length === 1) return { sessionDevice, available, effective: available[0], needSelection: false, source: 'single-online' };
  if (available.length > 1) return { sessionDevice, available, effective: undefined, needSelection: true, source: 'none' };
  return { sessionDevice, available, effective: undefined, needSelection: false, source: 'none' };
}

/** Bind a serial to the session (used after prepare/boot or single-online auto-bind). */
export function bindDevice(session: Session, serial: string): DirectDriver {
  const driver = new DirectDriver(serial);
  session.device = serial;
  session.driver = driver;
  return driver;
}

export async function getDriver(session: Session): Promise<{
  driver?: Driver;
  rehydrated: boolean;
  needSelection?: boolean;
  /** Set when a device is online but may not be bound (physical device / still booting). */
  blocked?: AttachBlocked;
}> {
  if (session.driver) return { driver: session.driver, rehydrated: false };
  if (testDriverFactory) {
    // Tests own device resolution entirely — never fall through to real adb discovery.
    const driver = testDriverFactory(session);
    if (!driver) return { driver: undefined, rehydrated: false, needSelection: false };
    session.driver = driver;
    session.device = session.device ?? driver.currentDevice() ?? 'test-device';
    return { driver, rehydrated: false };
  }
  // A session that already has a device is only ever re-bound to THAT device (and platform):
  // an iOS simulator UDID never falls through to adb discovery (which would bind a lone Android
  // emulator and overwrite session.device), and an offline Android serial never silently
  // becomes a different online one.
  // The persisted transport (state.json driverKind) is authoritative; the UDID shape is the fallback
  // for sessions persisted before driverKind existed.
  const persistedIos = session.driverKind === 'wda' || session.driverKind === 'simulator';
  const persistedAndroid = session.driverKind === 'direct';
  if (session.device && (persistedIos || (!persistedAndroid && isSimulatorUdid(session.device))))
    return rebindIosSimulator(session, session.device);
  const res = await resolveDevice(session);
  if (session.device && res.effective && res.effective !== session.device) {
    return {
      driver: undefined,
      rehydrated: false,
      needSelection: false,
      blocked: {
        failureCode: 'DEVICE_NOT_READY',
        detail: `This session's device ${session.device} is not online — it was NOT re-bound to ${res.effective} (a different device).`,
        nextSteps: [
          `Bring ${session.device} back online, or switch deliberately with qa_prepare_target device="${res.effective}" (or start a new session).`,
        ],
      },
    };
  }
  if (res.effective) {
    // H6: never auto-bind a physical phone or a still-booting emulator — same policy as
    // planTarget, enforced here too because this path bypasses the target planner.
    const blocked = attachBlocker(await probeAndroidDevice(res.effective));
    if (blocked) return { driver: undefined, rehydrated: false, needSelection: false, blocked };
    bindDevice(session, res.effective);
    session.lastSnapshot = undefined; // refs invalid after (re)bind
    return { driver: session.driver, rehydrated: true };
  }
  return { driver: undefined, rehydrated: false, needSelection: res.needSelection };
}

const SIMULATOR_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** iOS simulator UDIDs are UUIDs; adb serials never are. */
export function isSimulatorUdid(device: string | undefined): boolean {
  return !!device && SIMULATOR_UDID_RE.test(device);
}

/** Test seams for the iOS rebind (listSimulators / WDA reachability). */
let iosProbe: {
  listSimulators: () => Promise<Simulator[]>;
  wdaReachable: (url: string) => Promise<boolean>;
} = {
  listSimulators,
  wdaReachable: async (url) => !!(await checkWda(url, 1500).catch(() => ({ reachable: false }))).reachable,
};
export function setIosProbeForTests(probe?: Partial<typeof iosProbe>): void {
  iosProbe = {
    listSimulators: probe?.listSimulators ?? listSimulators,
    wdaReachable: probe?.wdaReachable ?? (async (url) => !!(await checkWda(url, 1500).catch(() => ({ reachable: false }))).reachable),
  };
}

/** The WDA URL this session last attached successfully for `udid` (persisted mutation ledger). */
function lastWdaUrlFor(session: Session, udid: string): string | undefined {
  for (let i = session.mutations.length - 1; i >= 0; i--) {
    const m = session.mutations[i];
    if (m.action !== 'wda_attach' || m.status !== 'executed') continue;
    const t = (m.target ?? {}) as { webDriverAgentUrl?: unknown; udid?: unknown };
    if (typeof t.webDriverAgentUrl !== 'string') continue;
    if (t.udid != null && t.udid !== udid) continue;
    return t.webDriverAgentUrl;
  }
  return undefined;
}

/** Re-bind a rehydrated iOS session to ITS simulator: WDA (structured) when the session had
 * attached WDA and that endpoint is reachable again, else SimctlDriver (visual/lifecycle). A
 * simulator that is not booted is a typed DEVICE_NOT_READY — never a fallback to another device. */
async function rebindIosSimulator(
  session: Session,
  udid: string,
): Promise<{ driver?: Driver; rehydrated: boolean; needSelection?: boolean; blocked?: AttachBlocked }> {
  const sims = await iosProbe.listSimulators().catch(() => [] as Simulator[]);
  const sim = sims.find((x) => x.udid.toUpperCase() === udid.toUpperCase());
  if (!sim || !/^booted$/i.test(sim.state)) {
    return {
      driver: undefined,
      rehydrated: false,
      needSelection: false,
      blocked: {
        failureCode: 'DEVICE_NOT_READY',
        detail: sim
          ? `iOS simulator ${sim.name} (${udid}) is not booted (state: ${sim.state}) — this session stays bound to it; nothing else was attached.`
          : `iOS simulator ${udid} was not found among available simulators — this session stays bound to it; nothing else was attached.`,
        nextSteps: [`Boot it with qa_ios action:"boot" device:"${udid}" (or qa_prepare_ios_target), then retry.`],
      },
    };
  }
  // Persisted transport first: a session that ran on WDA re-binds to ITS persisted WDA URL; one that
  // ran on simctl stays on simctl. Only a legacy state.json (no driverKind) falls back to the ledger.
  const wdaUrl =
    session.driverKind === 'wda'
      ? (session.wdaUrl ?? lastWdaUrlFor(session, udid))
      : session.driverKind === 'simulator'
        ? undefined
        : lastWdaUrlFor(session, udid);
  let driver: Driver;
  if (wdaUrl && (await iosProbe.wdaReachable(wdaUrl))) {
    const cfg = loadWdaConfig(session.root);
    // reuseRunningApp → forceAppLaunch:false + shouldTerminateApp:false: a rehydrate must never
    // terminate + relaunch the app under test (see createWdaSession).
    driver = new WdaDriver(wdaUrl, {
      udid,
      bundleId: session.appId,
      capabilities: cfg?.capabilities,
      settings: cfg?.settings,
      reuseRunningApp: true,
    });
  } else {
    driver = new SimctlDriver(udid);
  }
  session.driver = driver;
  session.lastSnapshot = undefined; // refs invalid after (re)bind
  return { driver, rehydrated: true };
}

export const REHYDRATE_NOTE =
  'Note: reattached the device transport after a restart — the app may not be in the ' +
  'foreground (relaunch with qa_prepare_target) and previous @eN refs are invalid (re-run qa_snapshot).';
