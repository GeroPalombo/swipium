// Wait for the soft keyboard after a focus tap (shared by qa_act and the flow runner).

import type { Driver } from '../drivers/Driver.js';
import { isAbortError, sleepOrCancel } from '../lib/abortScope.js';

/** Minimum wait after a focus tap when the keyboard was already shown (field hop). */
export const IME_HOP_FLOOR_MS = 250;

/** After the focus tap, wait for the soft keyboard instead of a fixed sleep. Poll
 * imeShown() in ~100ms steps up to capMs (the old sleep), proceeding as soon as it's up.
 * The tap stays a REAL touch (RN ignores synthetic focus, so tap-then-type is required);
 * backends whose imeShown() throws get the original fixed sleep. */
export async function awaitIme(d: Driver, capMs: number, floorMs = 0): Promise<void> {
  const started = Date.now();
  const deadline = started + capMs;
  try {
    while (Date.now() < deadline) {
      if (await d.imeShown()) {
        // Field hop: the IME was ALREADY up before the tap, so "shown" says nothing about the
        // new field having focus yet, so give RN a floor to move focus before typing.
        const rest = floorMs - (Date.now() - started);
        if (rest > 0) await sleepOrCancel(rest);
        return;
      }
      await sleepOrCancel(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  } catch (e) {
    if (isAbortError(e)) throw e; // cancelled: unwind, the action's catch returns CANCELLED
    // imeShown unsupported here: keep the original fixed-sleep behavior
    await sleepOrCancel(Math.max(0, deadline - Date.now()));
  }
}
