// Per-call cancellation scope. The session driver is shared between a background job and the
// interactive tool calls made while it runs, so a cancellation signal must travel with the CALL,
// not live in a mutable slot on the driver: AsyncLocalStorage carries it through every await.
// Jobs run their work inside runWithSignal(jobSignal); interactive tools inside
// runWithSignal(extra.signal). Drivers read currentSignal() when they spawn adb or fetch WDA.

import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<AbortSignal | undefined>();

/** Run `fn` with `signal` as the current cancellation signal (replacing any outer one — a job's
 *  signal never leaks into an interactive call made from its context, and vice versa). */
export function runWithSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return scope.run(signal, fn);
}

/** The cancellation signal of the call currently executing, if any. */
export function currentSignal(): AbortSignal | undefined {
  return scope.getStore();
}
