// Per-call cancellation scope. The session driver is shared between a background job and the
// interactive tool calls made while it runs, so a cancellation signal must travel with the CALL,
// not live in a mutable slot on the driver: AsyncLocalStorage carries it through every await.
// Jobs run their work inside runWithSignal(jobSignal); interactive tools inside
// runWithSignal(extra.signal). Drivers read currentSignal() when they spawn adb or fetch WDA.

import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<AbortSignal | undefined>();

/** Run `fn` with `signal` as the current cancellation signal (replacing any outer one: a job's
 *  signal never leaks into an interactive call made from its context, and vice versa). */
export function runWithSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return scope.run(signal, fn);
}

/** The cancellation signal of the call currently executing, if any. */
export function currentSignal(): AbortSignal | undefined {
  return scope.getStore();
}

/**
 * Is `e` the result of a CANCELLATION rather than a real failure? True when the error (or any
 * error in its `cause` chain) is an AbortError / has code ABORT_ERR, or when the current call's
 * cancellation signal (abortScope) has fired. Drivers wrap aborted adb/WDA calls in their own
 * messages ("uiautomator dump failed … AbortError", "WDA GET /source aborted (cancelled)"), so the
 * signal is the authoritative check.
 *
 * Every place that converts an error into a finding, toolError, snapshotFailure, health verdict or
 * mode switch must check this first and return a CANCELLED result instead: cancelled work is not
 * evidence about the app or the tool.
 */
export function isAbortError(e: unknown, signal: AbortSignal | undefined = currentSignal()): boolean {
  if (signal?.aborted) return true;
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 6; depth++) {
    const err = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if (err.name === 'AbortError' || err.name === 'CancelledError' || err.code === 'ABORT_ERR') return true;
    cur = err.cause;
  }
  return false;
}

/** Thrown by long-running work (e.g. the explore runner) to unwind a cancelled step without
 *  recording it as a failure. */
export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}
