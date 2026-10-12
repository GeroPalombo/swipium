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
import { wdaDeviceOwnership } from '../lib/wdaDevice.js';
import { loadWdaConfig } from '../lib/wdaConfig.js';
import { isEmulatorSerial } from '../core/targetPlan.js';
import type { Session, SessionStore } from './store.js';
import type { Driver } from '../drivers/Driver.js';
import type { FailureCode } from '../oracle/failures.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { qaError } from '../lib/result.js';

/** What `getprop` says about an online adb device (H6). */
export interface AndroidDeviceProbe {
  serial: string;
  /** Could the device properties be read at all (offline/unauthorized > false)? */
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

/** One `getprop` call > emulator + boot state. */
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

/** Split online serials by policy. Callers of planTarget pass `emulators` as
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

/** IOS NEW-A: on the visual-only simulator backend, the answer for a session that DID run on WDA
 *  for its simulator whose WDA no longer answers: WDA_UNREACHABLE with the restart steps, instead
 *  of a BACKEND_UNSUPPORTED that hides the cause. Undefined when the session never had a WDA, or
 *  its WDA answers again (then the caller's "attach WDA" advice is right). */
export async function lostWdaResult(session: Session, what: string): Promise<CallToolResult | undefined> {
  const udid = session.device;
  if (!udid || !isSimulatorUdid(udid)) return undefined;
  // Also a WDA that hung while prepare created its session (a `blocked` wda_attach in the ledger).
  const tried = [...(session.mutations ?? [])]
    .reverse()
    .find(
      (m) =>
        ['wda_attach', 'wda_start', 'wda_reuse'].includes(m.action) &&
        (m.status === 'executed' || m.status === 'blocked') &&
        typeof m.target?.webDriverAgentUrl === 'string' &&
        String(m.target?.udid ?? '').toUpperCase() === udid.toUpperCase(),
    )?.target?.webDriverAgentUrl;
  const url = session.transportFallback?.wdaUrl ?? session.wdaUrl ?? (typeof tried === 'string' ? tried : undefined);
  if (!url) return undefined;
  if ((await checkWda(url, 1500).catch(() => undefined))?.reachable) return undefined;
  return qaError({
    what: `${what}: this session's WebDriverAgent at ${url} is not responding (hung or stopped), so it runs visual-only`,
    changedState: false,
    retrySafe: true,
    failureCode: 'WDA_UNREACHABLE',
    nextSteps: [
      `Restart WDA: qa_wda { action:"stop", device:"${udid}" }, then qa_wda { action:"setup", device:"${udid}" } and qa_wda { action:"attach" }, then retry.`,
    ],
  });
}

/** PURE: the typed refusal for a probed device, or null when it may be bound. Same policy
 * as core/targetPlan (PHYSICAL_DEVICE_UNSUPPORTED) plus a boot-completed gate. */
export function attachBlocker(p: AndroidDeviceProbe): AttachBlocked | null {
  if (!p.propsRead) {
    return {
      failureCode: 'DEVICE_NOT_READY',
      detail: `Could not read device properties from ${p.serial} (offline, unauthorized, or still starting). Wait for it to come online, then retry.`,
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
      detail: `Emulator ${p.serial} is still booting (sys.boot_completed != 1). Wait for boot to finish, then retry.`,
    };
  }
  return null;
}

export interface DeviceResolution {
  sessionDevice?: string; // bound to the session AND still online
  available: string[]; // all online serials
  effective?: string; // the device to act on (session > arg > pin > single-online)
  needSelection: boolean; // >1 online and none chosen
  /** 'arg': the caller named it; 'pin': SWIPIUM_DEVICE picked it (the operator chose it, not the call). */
  source: 'session' | 'arg' | 'pin' | 'single-online' | 'none';
}

/** TEST SEAM (P1 §6). When set, getDriver() binds the driver this factory returns instead of
 * discovering a real device, so handler-level tests can drive tools with a fake driver and no
 * adb. Never set in production code paths; a no-op unless a test installs it. */
let testDriverFactory: ((session: Session) => Driver | undefined) | undefined;
export function setDriverFactoryForTests(factory?: (session: Session) => Driver | undefined): void {
  testDriverFactory = factory;
}

/** Operator device pin (server env, never repo config): an adb serial, AVD name, or simulator
 *  UDID/name. Used as the default target when a call names no device and the session has none,
 *  and nothing else is ever auto-picked while it is set. */
export const DEVICE_PIN_ENV = 'SWIPIUM_DEVICE';
export function operatorDevicePin(): string | undefined {
  const v = process.env[DEVICE_PIN_ENV]?.trim();
  return v ? v : undefined;
}

/** CR-PIN: the one rule for "is this the pinned device": an exact match ignoring case, for every
 *  kind of id (adb serial, AVD name, simulator UDID or name). Never a substring match. */
export function pinMatches(pin: string, value: string | undefined): boolean {
  return !!value && value.toLowerCase() === pin.toLowerCase();
}

/** E2E NEW-5: the NO_DEVICE text when the pin names no simulator (it names the pin, not "requested"). */
export function pinNoSimulatorMessage(pin: string): string {
  return `${DEVICE_PIN_ENV}=${pin} (server env) matches no available iOS simulator (UDID or exact name), so no other simulator was used.`;
}
export function pinFixStep(): string {
  return `Fix or unset ${DEVICE_PIN_ENV} in the MCP server's env (an adb serial, AVD name, or simulator UDID / exact name), then restart the server.`;
}

/** E2E NEW-5: the one pin resolver for simulators: the simulator whose UDID the pin is, else every
 *  simulator with exactly that name (pinMatches, ignoring case). More than one = ambiguous. */
export function simulatorsForPin<T extends { udid: string; name: string }>(pin: string, sims: T[]): T[] {
  const byUdid = sims.filter((s) => pinMatches(pin, s.udid));
  return byUdid.length ? byUdid : sims.filter((s) => pinMatches(pin, s.name));
}
export function pinAmbiguousMessage(pin: string, matches: Array<{ udid: string; name: string }>): string {
  return `${DEVICE_PIN_ENV}=${pin} (server env) names ${matches.length} simulators (${matches.map((s) => `${s.name} ${s.udid}`).join(', ')}), so none was used. Pin one by its UDID.`;
}

/** The device the pin names among what is present: an online adb serial, an AVD, else the ONE
 *  simulator it names (UDID or exact name). Several simulators sharing the pinned name is
 *  `ambiguous`. Undefined fields when the pin names nothing present (the caller refuses then). */
export function pinnedTarget<T extends { udid: string; name: string }>(
  pin: string,
  online: string[],
  avds: string[],
  sims: T[],
): { device?: string; platform?: 'android' | 'ios'; ambiguous?: T[] } {
  const serial = online.find((s) => pinMatches(pin, s)) ?? avds.find((a) => pinMatches(pin, a));
  if (serial) return { device: serial, platform: 'android' };
  const pinnedSims = simulatorsForPin(pin, sims);
  if (pinnedSims.length > 1) return { ambiguous: pinnedSims };
  return pinnedSims[0] ? { device: pinnedSims[0].udid, platform: 'ios' } : {};
}

/** With SWIPIUM_DEVICE set, the refusal text for an explicitly requested device that is NOT the
 *  pinned one (else undefined). Same device by another name passes: the pinned AVD running as the
 *  requested serial (or vice versa), or a simulator's UDID vs its name (`sims`). */
export async function devicePinConflict(
  requested: string | undefined,
  online: string[],
  sims: Array<{ udid: string; name: string }> = [],
): Promise<string | undefined> {
  const pin = operatorDevicePin();
  if (!pin || !requested) return undefined;
  // A pinned simulator name that several simulators share pins none of them (never "either one").
  const pinnedSims = simulatorsForPin(pin, sims);
  if (pinnedSims.length > 1) return pinAmbiguousMessage(pin, pinnedSims);
  if (pinMatches(pin, requested)) return undefined;
  const sameSim = (s: { udid: string; name: string }, v: string) => pinMatches(v, s.udid) || pinMatches(v, s.name);
  if (pinnedSims.some((s) => sameSim(s, requested))) return undefined;
  const reqSerial = online.find((s) => pinMatches(requested, s));
  const pinSerial = online.find((s) => pinMatches(pin, s));
  const [reqAvd, pinAvd] = await Promise.all([
    reqSerial ? emulatorAvdName(reqSerial) : undefined,
    pinSerial ? emulatorAvdName(pinSerial) : undefined,
  ]);
  if (pinMatches(pin, reqAvd) || pinMatches(requested, pinAvd)) return undefined;
  return `${DEVICE_PIN_ENV}=${pin} pins this server to that device; "${requested}" is a different device, so nothing was done on it.`;
}

/** The AVD name of a running emulator serial (`adb emu avd name`, else ro.boot.qemu.avd_name), or undefined. */
export async function emulatorAvdName(serial: string): Promise<string | undefined> {
  try {
    const r = await run('adb', ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 5000 });
    const first = r.code === 0 ? r.stdout.split(/\r?\n/)[0]?.trim() : '';
    // AVD names are [A-Za-z0-9._-]; anything else is console noise ("OK", "KO: ...", an auth banner).
    if (first && first !== 'OK' && /^[\w.-]+$/.test(first)) return first;
  } catch {
    /* fall through to getprop */
  }
  try {
    const r = await run('adb', ['-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name'], { timeoutMs: 5000 });
    const v = r.code === 0 ? r.stdout.trim() : '';
    return /^[\w.-]+$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The online serial running AVD `avd` (a requested AVD that is already up is bound, never booted twice). */
export async function onlineSerialForAvd(avd: string, online: string[]): Promise<string | undefined> {
  const emus = await verifiedEmulatorSerials(online);
  const names = await Promise.all(emus.map(emulatorAvdName));
  const i = names.findIndex((n) => pinMatches(avd, n));
  return i >= 0 ? emus[i] : undefined;
}

/** The AVD an Android plan targets: the AVD it boots, or the one its online emulator runs. Pins
 *  `expo run:android --device` so the build installs on the consented emulator, not any device. */
export async function androidTargetAvd(t: { device?: string; willBoot: boolean; bootTarget?: string }): Promise<string | undefined> {
  if (t.willBoot) return t.bootTarget;
  return t.device ? emulatorAvdName(t.device) : undefined;
}

/** The AVD Swipium booted for `serial` in this session (mutation ledger boot_emulator), so an
 *  offline session device is re-booted as ITSELF, never replaced by another AVD. */
export function sessionAvdFor(session: Pick<Session, 'mutations'>, serial: string | undefined): string | undefined {
  if (!serial) return undefined;
  for (let i = session.mutations.length - 1; i >= 0; i--) {
    const m = session.mutations[i];
    if ((m.action !== 'boot_emulator' && m.action !== 'bind_emulator') || m.status !== 'executed') continue;
    const t = (m.target ?? {}) as { avd?: unknown; device?: unknown };
    if (t.device === serial && typeof t.avd === 'string') return t.avd;
  }
  return undefined;
}

/** Is this session's bound device provably gone (Android serial not online, iOS simulator not
 *  Booted)? 'unknown' when there is no device, discovery is off (tests), or the probe failed. Cheap
 *  (one `adb devices` or `simctl list`), for qa_status. */
export async function sessionDeviceState(session: Session): Promise<'online' | 'gone' | 'unknown'> {
  const dev = session.device;
  if (!dev || testDriverFactory || process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY) return 'unknown';
  const kind = session.driver?.kind ?? session.driverKind;
  const ios = kind === 'wda' || kind === 'simulator' || (kind !== 'direct' && isSimulatorUdid(dev));
  if (ios) {
    const sim = await listSimulators()
      .then((l) => l.find((x) => x.udid === dev))
      .catch(() => null);
    if (sim === null) return 'unknown';
    return sim?.state === 'Booted' ? 'online' : 'gone';
  }
  if (kind === 'remote') return 'unknown'; // Appium-managed: not ours to probe
  return (await adbDevices()).includes(dev) ? 'online' : 'gone';
}

/** Remember the AVD of an emulator bound BY SERIAL (bind_emulator ledger row), so a later offline
 *  session device is re-booted as that AVD, the same as one Swipium booted. No-op when the AVD is
 *  already known for that serial, the serial is not an emulator, or its AVD name can't be read. */
export async function rememberBoundAvd(
  sessions: Pick<SessionStore, 'recordMutation'>,
  session: Session,
  serial: string,
  tool: string,
): Promise<void> {
  if (!isEmulatorSerial(serial) || sessionAvdFor(session, serial)) return;
  const avd = await emulatorAvdName(serial);
  if (!avd) return;
  sessions.recordMutation(session, {
    tool,
    action: 'bind_emulator',
    risk: 'low',
    target: { avd, device: serial },
    consent: { required: false, approved: true },
    status: 'executed',
    detail: `bound ${serial} (AVD ${avd})`,
  });
}

/** Other sessions of this process with a LIVE driver on `device`(two sessions on one device
 *  fight over the foreground app and the WDA session). */
export function otherLiveSessionsOn(all: Session[], self: Session, device: string): string[] {
  return all.filter((o) => o.id !== self.id && o.device === device && !!o.driver).map((o) => o.id);
}

export async function resolveDevice(session: Session, prefer?: string): Promise<DeviceResolution> {
  // Test-isolation hook: when set, device auto-discovery is
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
  // A session already bound to a device that is now offline is never swapped for another online
  // device ("a session is only re-bound to its own device").
  if (session.device) return { sessionDevice, available, effective: undefined, needSelection: false, source: 'none' };
  // Operator pin: only the pinned device (serial, or the serial running the pinned AVD) is eligible.
  const pin = operatorDevicePin();
  if (pin) {
    const pinned = available.find((s) => pinMatches(pin, s)) ?? (await onlineSerialForAvd(pin, available));
    return { sessionDevice, available, effective: pinned, needSelection: false, source: pinned ? 'pin' : 'none' };
  }
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

export interface GetDriverOptions {
  /** false: never bind a device to a session that has none (report / read-only callers must not
   *  adopt and capture an online device the user never chose). Default true. */
  autoBind?: boolean;
}

export async function getDriver(
  session: Session,
  opts: GetDriverOptions = {},
): Promise<{
  driver?: Driver;
  rehydrated: boolean;
  needSelection?: boolean;
  /** Set when a device is online but may not be bound (physical device / still booting). */
  blocked?: AttachBlocked;
  /** Human-readable transport note (e.g. WDA unreachable > simctl fallback; WDA restored). */
  note?: string;
}> {
  if (session.driver) {
    // A rehydrated WDA session running on the simctl fallback retries WDA (throttled). A brief
    // outage during rehydrate must not leave the session downgraded for its whole life.
    if (session.transportFallback && session.driver.kind !== 'simulator') session.transportFallback = undefined; // re-attached explicitly
    if (session.transportFallback) {
      const upgraded = await retryWdaTransport(session);
      if (upgraded) return { driver: upgraded, rehydrated: true, note: WDA_RESTORED_NOTE };
    }
    return { driver: session.driver, rehydrated: false };
  }
  if (testDriverFactory) {
    // Tests own device resolution entirely. Never fall through to real adb discovery.
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
  if (!session.device && opts.autoBind === false) return { driver: undefined, rehydrated: false, needSelection: false };
  const res = await resolveDevice(session);
  if (session.device && res.effective !== session.device) {
    const others = res.available.filter((s) => s !== session.device);
    const avd = sessionAvdFor(session, session.device);
    return {
      driver: undefined,
      rehydrated: false,
      needSelection: false,
      blocked: {
        failureCode: 'DEVICE_NOT_READY',
        detail:
          `This session's device ${session.device}${avd ? ` (AVD ${avd})` : ''} is not online. ` +
          `It was NOT re-bound to ${others.length ? `another device (online: ${others.join(', ')})` : 'any other device'}.`,
        nextSteps: [
          `Bring ${session.device} back online${avd ? ` (qa_prepare_target avd="${avd}")` : ''}, or switch deliberately with qa_prepare_target device="<serial>" (or start a new session).`,
        ],
      },
    };
  }
  if (res.effective) {
    // H6: never auto-bind a physical phone or a still-booting emulator (same policy as
    // planTarget, enforced here too because this path bypasses the target planner).
    const blocked = attachBlocker(await probeAndroidDevice(res.effective));
    if (blocked) return { driver: undefined, rehydrated: false, needSelection: false, blocked };
    // The lone online Android emulator is not "the single device" when iOS simulators are also
    // booted: the session may be meant for one of those. Ask instead of adopting it.
    if (res.source === 'single-online') {
      const booted = (await iosProbe.listSimulators().catch(() => [] as Simulator[])).filter((s) => /^booted$/i.test(s.state));
      if (booted.length) {
        return {
          driver: undefined,
          rehydrated: false,
          needSelection: true,
          blocked: {
            failureCode: 'MULTIPLE_DEVICES',
            detail:
              `Android emulator ${res.effective} and ${booted.length} iOS simulator(s) (${booted.map((s) => s.udid).join(', ')}) are online; ` +
              'this session has no device, so none was auto-bound.',
            nextSteps: [
              `Bind one deliberately: qa_prepare_target { device:"${res.effective}", bindOnly:true } or qa_prepare_ios_target { device:"<udid>" }.`,
            ],
          },
        };
      }
    }
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

/** A WDA that answers AND is not provably another simulator's (GOAL-5: every simulator's WDA
 *  defaults to the same port, so "reachable" alone could re-bind this session to another device's
 *  WDA). An unknown owner is accepted (external / remote WDA); only a proven mismatch is refused.
 *  `unverified` (lsof / ps timed out) is accepted too: the only caller passes this session's own
 *  recorded WDA URL for `udid`, the one case where every resolver accepts it (CR P10). */
async function wdaReachableFor(url: string, udid?: string): Promise<boolean> {
  const status = await checkWda(url, 1500).catch(() => undefined);
  if (!status?.reachable) return false;
  if (!udid) return true;
  const own = await wdaDeviceOwnership(url, status, udid).catch(() => undefined);
  return own?.owner !== 'other';
}

/** Test seams for the iOS rebind (listSimulators / WDA reachability). */
let iosProbe: {
  listSimulators: () => Promise<Simulator[]>;
  wdaReachable: (url: string, udid?: string) => Promise<boolean>;
} = {
  listSimulators,
  wdaReachable: wdaReachableFor,
};
export function setIosProbeForTests(probe?: Partial<typeof iosProbe>): void {
  iosProbe = {
    listSimulators: probe?.listSimulators ?? listSimulators,
    wdaReachable: probe?.wdaReachable ?? wdaReachableFor,
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
 * simulator that is not booted is a typed DEVICE_NOT_READY, never a fallback to another device. */
async function rebindIosSimulator(
  session: Session,
  udid: string,
): Promise<{ driver?: Driver; rehydrated: boolean; needSelection?: boolean; blocked?: AttachBlocked; note?: string }> {
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
          ? `iOS simulator ${sim.name} (${udid}) is not booted (state: ${sim.state}). This session stays bound to it; nothing else was attached.`
          : `iOS simulator ${udid} was not found among available simulators. This session stays bound to it; nothing else was attached.`,
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
  let note: string | undefined;
  if (wdaUrl && (await iosProbe.wdaReachable(wdaUrl, udid))) {
    driver = wdaDriverFor(session, wdaUrl, udid);
    session.transportFallback = undefined;
  } else {
    driver = new SimctlDriver(udid);
    if (session.driverKind === 'wda' && wdaUrl) {
      // Persisted transport is WDA but it is unreachable right now: run on simctl for the moment,
      // but keep driverKind/wdaUrl as persisted (store.writeState skips the sync while this is
      // set) and retry WDA on the next getDriver calls.
      const now = Date.now();
      session.transportFallback = { wanted: 'wda', wdaUrl, since: now, lastProbeAt: now };
      note = wdaFallbackNote(wdaUrl);
      if (!session.workarounds.includes(note)) session.workarounds.push(note);
    }
  }
  session.driver = driver;
  session.lastSnapshot = undefined; // refs invalid after (re)bind
  return { driver, rehydrated: true, ...(note ? { note } : {}) };
}

// reuseRunningApp > forceAppLaunch:false + shouldTerminateApp:false: a rehydrate must never
// terminate + relaunch the app under test (see createWdaSession).
function wdaDriverFor(session: Session, wdaUrl: string, udid: string): Driver {
  const cfg = loadWdaConfig(session.root);
  return new WdaDriver(wdaUrl, {
    udid,
    bundleId: session.appId,
    capabilities: cfg?.capabilities,
    settings: cfg?.settings,
    reuseRunningApp: true,
  });
}

/** Minimum gap between WDA re-probes while a session runs on the simctl fallback. */
export const WDA_RETRY_INTERVAL_MS = 10_000;

const wdaFallbackNote = (wdaUrl: string): string =>
  `WDA at ${wdaUrl} was unreachable when this iOS session was re-attached; running on the simctl fallback ` +
  `(visual/lifecycle only; no structured snapshot). The session stays a WDA session and WDA is retried ` +
  `automatically; or re-attach with qa_wda.`;

export const WDA_RESTORED_NOTE = 'WDA is reachable again. This session is back on its WDA transport (previous @eN refs are invalid).';

/** Re-probe the persisted WDA endpoint of a fallback session (throttled); rebind on success. */
async function retryWdaTransport(session: Session): Promise<Driver | undefined> {
  const fb = session.transportFallback;
  if (!fb || !session.device) return undefined;
  const now = Date.now();
  if (now - fb.lastProbeAt < WDA_RETRY_INTERVAL_MS) return undefined;
  fb.lastProbeAt = now;
  if (!(await iosProbe.wdaReachable(fb.wdaUrl, session.device).catch(() => false))) return undefined;
  const driver = wdaDriverFor(session, fb.wdaUrl, session.device);
  session.driver = driver;
  session.transportFallback = undefined;
  session.lastSnapshot = undefined;
  return driver;
}

/** Post-restart reattach note, platform-aware: iOS sessions relaunch via qa_prepare_ios_target
 *  (qa_prepare_target is the Android/Expo path). iOS = an iOS driver (simctl / WDA) or a
 *  simulator-UDID device. */
export function rehydrateNote(session?: Pick<Session, 'device' | 'driver'>): string {
  const driver = session?.driver;
  const ios = driver instanceof SimctlDriver || driver instanceof WdaDriver || isSimulatorUdid(session?.device);
  return (
    'Note: reattached the device transport after a restart. The app may not be in the ' +
    `foreground (relaunch with ${ios ? 'qa_prepare_ios_target' : 'qa_prepare_target'}) and previous @eN refs are invalid (re-run qa_snapshot).`
  );
}

/** Platform-neutral form for callers without the session at hand (prefer rehydrateNote(session)). */
export const REHYDRATE_NOTE =
  'Note: reattached the device transport after a restart. The app may not be in the ' +
  'foreground (relaunch with qa_prepare_target on Android, qa_prepare_ios_target on iOS) and previous @eN refs are invalid (re-run qa_snapshot).';

/** GOAL-18: the NO_DEVICE "prepare first" step, platform-aware. An iOS session (iOS driver or
 *  persisted iOS transport, a simulator UDID, or a qa_test_this run with platform "ios") is told to
 *  use qa_prepare_ios_target, never the Android-only qa_prepare_target. */
export function prepareFirstStep(session: Pick<Session, 'device' | 'driver' | 'driverKind' | 'lastTestThisArgs'>, then?: string): string {
  const kind = session.driver?.kind ?? session.driverKind;
  const ios =
    kind === 'simulator' ||
    kind === 'wda' ||
    (kind === undefined && isSimulatorUdid(session.device)) ||
    (kind === undefined && !session.device && session.lastTestThisArgs?.flags?.platform === 'ios');
  return `Call ${ios ? 'qa_prepare_ios_target' : 'qa_prepare_target'} first${then ? `, then ${then}` : ''}.`;
}
