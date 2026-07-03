// Centralized device resolution + lazy driver attach (Phase 2.1). One place decides
// "which device" so qa_doctor / qa_prepare_target / UI tools
// all agree: a session-bound device, the single online device, or "needs selection".

import { adbDevices } from '../lib/android.js';
import { DirectDriver } from '../drivers/DirectDriver.js';
import type { Session } from './store.js';
import type { Driver } from '../drivers/Driver.js';

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

export async function getDriver(session: Session): Promise<{ driver?: Driver; rehydrated: boolean; needSelection?: boolean }> {
  if (session.driver) return { driver: session.driver, rehydrated: false };
  if (testDriverFactory) {
    // Tests own device resolution entirely — never fall through to real adb discovery.
    const driver = testDriverFactory(session);
    if (!driver) return { driver: undefined, rehydrated: false, needSelection: false };
    session.driver = driver;
    session.device = session.device ?? driver.currentDevice() ?? 'test-device';
    return { driver, rehydrated: false };
  }
  const res = await resolveDevice(session);
  if (res.effective) {
    bindDevice(session, res.effective);
    session.lastSnapshot = undefined; // refs invalid after (re)bind
    return { driver: session.driver, rehydrated: true };
  }
  return { driver: undefined, rehydrated: false, needSelection: res.needSelection };
}

export const REHYDRATE_NOTE =
  'Note: reattached the device transport after a restart — the app may not be in the ' +
  'foreground (relaunch with qa_prepare_target) and previous @eN refs are invalid (re-run qa_snapshot).';
