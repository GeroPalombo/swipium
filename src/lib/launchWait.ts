// Post-launch wait: poll the foreground owner instead of a fixed sleep, so a launch that lands in
// a few hundred ms returns at once and a slow one still gets the old 2.5 s budget.

import { sleepOrCancel } from './abortScope.js';
import type { Driver } from '../drivers/Driver.js';

/** Same cap as the fixed sleep it replaces. */
export const LAUNCH_FOREGROUND_CAP_MS = 2500;
export const LAUNCH_FOREGROUND_POLL_MS = 250;

/** Poll `foregroundOwner()` until it belongs to `pkg` or `capMs` passes; returns the last owner
 * seen (the caller still decides launchedOk from it). Honors the call's cancellation. */
export async function waitForForeground(
  d: Pick<Driver, 'foregroundOwner'>,
  pkg: string,
  capMs = LAUNCH_FOREGROUND_CAP_MS,
): Promise<string> {
  const deadline = Date.now() + capMs;
  for (;;) {
    const fg = await d.foregroundOwner();
    const left = deadline - Date.now();
    if (fg.startsWith(pkg) || left <= 0) return fg;
    await sleepOrCancel(Math.min(LAUNCH_FOREGROUND_POLL_MS, left));
  }
}

/** Prepare paths re-check the foreground this long after it first belongs to the app. */
export const LAUNCH_RECHECK_MS = 1000;

/** Prepare-path launch check: waitForForeground, then (when the app came up) ONE more foreground
 * read LAUNCH_RECHECK_MS later, so a crash right after the first frame still reports
 * launchedOk:false as the old fixed 2.5 s wait did. qa_app_control restart skips the re-check
 * (later health checks catch a crash there). Returns the last owner seen. */
export async function waitForLaunch(d: Pick<Driver, 'foregroundOwner'>, pkg: string, capMs = LAUNCH_FOREGROUND_CAP_MS): Promise<string> {
  const fg = await waitForForeground(d, pkg, capMs);
  if (!fg.startsWith(pkg)) return fg;
  await sleepOrCancel(LAUNCH_RECHECK_MS);
  return d.foregroundOwner();
}
