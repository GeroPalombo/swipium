// Per-call cancellation scope. The session driver is shared between a background job and the
// interactive tool calls made while it runs, so a cancellation signal must travel with the CALL,
// not live in a mutable slot on the driver: AsyncLocalStorage carries it through every await.
// Jobs run their work inside runWithSignal(jobSignal); interactive tools inside
// runWithSignal(extra.signal). Drivers read currentSignal() when they spawn adb or fetch WDA.

import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<AbortSignal | undefined>();

/**
 * The `signal` parameter of the helpers below. `undefined` (or omitting it) falls back to the
 * CURRENT call's signal (currentSignal()), which is what polling loops want. Pass `null` to mean
 * "no signal at all": the helper then ignores the ambient call/job signal (e.g. cleanup work that
 * must finish even though the surrounding call was cancelled).
 */
export type SignalArg = AbortSignal | null | undefined;

function resolveSignal(signal: SignalArg): AbortSignal | undefined {
  return signal === null ? undefined : (signal ?? currentSignal());
}

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
 * cancellation signal (abortScope) has fired (`signal`: undefined = the current call's, null = only
 * inspect the error). Drivers wrap aborted adb/WDA calls in their own
 * messages ("uiautomator dump failed … AbortError", "WDA GET /source aborted (cancelled)"), so the
 * signal is the authoritative check.
 *
 * Every place that converts an error into a finding, toolError, snapshotFailure, health verdict or
 * mode switch must check this first and return a CANCELLED result instead: cancelled work is not
 * evidence about the app or the tool.
 */
export function isAbortError(e: unknown, signal?: SignalArg): boolean {
  if (resolveSignal(signal)?.aborted) return true;
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

/** Throw CancelledError when `signal` has fired (`undefined`: the current call's signal; `null`:
 *  never). Polling loops call this once per iteration so a cancelled call stops instead of
 *  polling until its deadline. */
export function throwIfCancelled(signal?: SignalArg): void {
  if (resolveSignal(signal)?.aborted) throw new CancelledError();
}

/**
 * Sleep `ms`, waking early (rejecting with CancelledError) when `signal` aborts (`undefined`: the
 * current call's signal; `null`: a plain uncancellable sleep). Use it for the pause between polls;
 * a plain setTimeout sleep keeps a cancelled call alive for the rest of its interval, and the loop
 * around it until its deadline.
 */
export function sleepOrCancel(ms: number, signalArg?: SignalArg): Promise<void> {
  const signal = resolveSignal(signalArg);
  if (signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
