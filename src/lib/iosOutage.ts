// iOS backend outage diagnosis. When a WDA-backed or simctl-backed call fails with a connection-
// style error ("fetch failed", ECONNREFUSED, "current state: Shutdown"), say WHY: the simulator was
// shut down (NO_DEVICE, re-boot it), or WebDriverAgent died (WDA_UNREACHABLE, restart and
// re-attach it). A refused connection or a shut-down simulator means nothing reached the device
// (changedState false); a connection dropped mid-request may have. Without this, those failures
// surface as SNAPSHOT_FAILED / UNKNOWN with Android (adb) advice.

import { SimctlDriver } from '../drivers/SimctlDriver.js';
import { WdaDriver } from '../drivers/WdaDriver.js';
import type { FailureCode } from '../oracle/failures.js';
import type { Session } from '../session/store.js';
import { checkWda, isSimulatorUdid } from './wda.js';
import * as sim from './simctl.js';

export interface IosOutage {
  failureCode: FailureCode;
  what: string;
  nextSteps: string[];
  /** False when nothing can have reached the device (simulator down, connection refused). */
  changedState: boolean;
}

/** Errors that mean the backend is gone rather than that the UI misbehaved. */
const OUTAGE_RE =
  /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|current state: Shutdown|Unable to lookup in current state|device is not booted|not booted/i;

/** True for an iOS session (WDA or simctl backend). */
export function isIosSession(session: Pick<Session, 'driver'>): boolean {
  return session.driver instanceof WdaDriver || session.driver instanceof SimctlDriver;
}

/**
 * Diagnose a failed iOS call. Undefined when the session is not iOS, the error is not
 * connection-shaped, or both the simulator and WDA look healthy (a genuine UI/backend error).
 */
export async function diagnoseIosOutage(session: Pick<Session, 'driver' | 'device'>, error: unknown): Promise<IosOutage | undefined> {
  const driver = session.driver;
  if (!(driver instanceof WdaDriver) && !(driver instanceof SimctlDriver)) return undefined;
  const msg = String((error as Error)?.message ?? error);
  const cause = String(((error as Error)?.cause as Error | undefined)?.message ?? '');
  if (!OUTAGE_RE.test(`${msg} ${cause}`)) return undefined;
  const udid = session.device ?? driver.currentDevice();
  if (udid && isSimulatorUdid(udid)) {
    const state = (await sim.listSimulators().catch(() => [])).find((s) => s.udid.toUpperCase() === udid.toUpperCase())?.state;
    if (state && state !== 'Booted') {
      return {
        failureCode: 'NO_DEVICE', // same code as every other device-gone path (lib/deviceGone.ts)
        what: `iOS simulator ${udid} is ${state.toLowerCase()} (it was shut down during the session)`,
        nextSteps: [
          'Boot it again with qa_prepare_ios_target (or qa_ios { action:"boot" }).',
          'A managed WebDriverAgent stops with its simulator: then run qa_wda { action:"setup" } and qa_wda { action:"attach" } for structured automation.',
        ],
        changedState: false,
      };
    }
  }
  if (driver instanceof WdaDriver) {
    const status = await checkWda(driver.baseUrl, 1500).catch(() => ({ reachable: false }));
    if (!status.reachable) {
      // WDA is down now. Only a refused connection proves the request never reached it: a generic
      // "fetch failed" also covers a request that WDA received and then hung on or dropped (header /
      // body timeout, reset), so anything not positively refused may have changed state.
      const causeCode = String(((error as Error)?.cause as { code?: unknown } | undefined)?.code ?? '');
      const refused = /ECONNREFUSED/i.test(`${msg} ${cause} ${causeCode}`);
      return {
        failureCode: 'WDA_UNREACHABLE',
        what: `WebDriverAgent at ${driver.baseUrl} is not running${refused ? ' (connection refused; nothing was sent to the device)' : ''}`,
        nextSteps: ['Restart it with qa_wda { action:"start" } (or action:"setup"), then qa_wda { action:"attach" }, then re-snapshot.'],
        changedState: !refused,
      };
    }
  }
  return undefined;
}
