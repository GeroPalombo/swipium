// Automation Kernel V2 — Workstream 4: Wait and Stability Engine. Explicit wait contracts that
// replace scattered sleeps. Assertions act as efficient condition waits (Maestro parity); idle waits
// label their source as app_declared | backend | heuristic (Espresso parity); tap retry is explicit
// and recorded, never a hidden loop. All executors take an injectable clock so they are deterministic
// in tests and never block on real wall-clock during unit runs.

import type { WaitSource } from './types.js';

export interface WaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface WaitForConditionResult {
  ok: boolean;
  elapsedMs: number;
  polls: number;
  timedOut: boolean;
}

/**
 * Poll `condition` until it returns true or `timeoutMs` elapses. Exits early the instant the
 * condition holds. Always evaluates the condition at least once.
 */
export async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; intervalMs?: number; clock?: WaitClock },
): Promise<WaitForConditionResult> {
  const clock = opts.clock ?? realClock;
  const interval = Math.max(1, opts.intervalMs ?? 250);
  const start = clock.now();
  let polls = 0;
  // First, immediate check.
  polls += 1;
  if (await condition()) return { ok: true, elapsedMs: clock.now() - start, polls, timedOut: false };
  while (clock.now() - start < opts.timeoutMs) {
    await clock.sleep(interval);
    polls += 1;
    if (await condition()) return { ok: true, elapsedMs: clock.now() - start, polls, timedOut: false };
  }
  return { ok: false, elapsedMs: clock.now() - start, polls, timedOut: true };
}

export interface WaitForVisibleResult extends WaitForConditionResult {
  visible: boolean;
}

/** Wait until an element is visible (assertion-as-wait). */
export async function waitForVisible(
  isVisible: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; intervalMs?: number; clock?: WaitClock },
): Promise<WaitForVisibleResult> {
  const r = await waitForCondition(isVisible, opts);
  return { ...r, visible: r.ok };
}

/** Wait until an element is NOT visible — e.g. a spinner / modal disappears. */
export async function waitForNotVisible(
  isVisible: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; intervalMs?: number; clock?: WaitClock },
): Promise<WaitForVisibleResult> {
  const r = await waitForCondition(async () => !(await isVisible()), opts);
  return { ...r, visible: !r.ok };
}

export interface WaitForIdleResult {
  ok: boolean;
  source: WaitSource;
  elapsedMs: number;
  polls: number;
  timedOut: boolean;
  /** True only when the idle proof came from an app-declared idling resource. */
  appProof: boolean;
  detail: string;
}

/**
 * Wait for the UI to settle. The caller declares which idle source is in play:
 *  - app_declared: an Espresso/RN idling resource the app exposes (the only true proof)
 *  - backend: WDA/XCTest waitForIdle or driver-level idle
 *  - heuristic: best-effort settling (screenshot stability etc.) — labeled as NOT app proof
 */
export async function waitForIdle(
  isIdle: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; source: WaitSource; intervalMs?: number; clock?: WaitClock },
): Promise<WaitForIdleResult> {
  const r = await waitForCondition(isIdle, opts);
  const appProof = opts.source === 'app_declared' && r.ok;
  const detail =
    opts.source === 'app_declared'
      ? r.ok ? 'app-declared idling resource reported idle' : 'app-declared idling resource did not settle within timeout'
      : opts.source === 'backend'
        ? r.ok ? 'backend (WDA/XCTest) idle reported' : 'backend idle did not settle within timeout'
        : r.ok ? 'heuristic settling reached (not app-declared proof)' : 'heuristic settling did not stabilize within timeout';
  return { ok: r.ok, source: opts.source, elapsedMs: r.elapsedMs, polls: r.polls, timedOut: r.timedOut, appProof, detail };
}

export interface AnimationWaitResult {
  ok: boolean;
  timedOut: boolean;
  elapsedMs: number;
  /** Reaching the timeout is a pass-with-warning, matching Maestro waitForAnimationToEnd semantics. */
  warning?: string;
}

/** waitForAnimationToEnd — on timeout, pass with a warning rather than fail. */
export async function waitForAnimationToEnd(
  isAnimating: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; intervalMs?: number; clock?: WaitClock },
): Promise<AnimationWaitResult> {
  const r = await waitForCondition(async () => !(await isAnimating()), opts);
  if (r.ok) return { ok: true, timedOut: false, elapsedMs: r.elapsedMs };
  return {
    ok: true,
    timedOut: true,
    elapsedMs: r.elapsedMs,
    warning: `animation did not end within ${opts.timeoutMs}ms; continuing (pass-with-warning).`,
  };
}

export interface TapAttempt {
  index: number;
  changed: boolean;
  signatureBefore?: string;
  signatureAfter?: string;
}

export interface RetryTapResult {
  ok: boolean;
  attempts: TapAttempt[];
  retried: boolean;
  changed: boolean;
}

/**
 * Tap with explicit `retryTapIfNoChange` semantics. Taps once; if the UI did not change AND retry is
 * enabled, taps exactly one more time. Every attempt (with before/after signatures) is recorded so
 * the retry is visible in the plan and evidence — never a hidden loop.
 */
export async function retryTapIfNoChange(
  doTap: () => Promise<void> | void,
  screenSignature: () => Promise<string | undefined> | string | undefined,
  opts: { enabled: boolean },
): Promise<RetryTapResult> {
  const attempts: TapAttempt[] = [];
  const before1 = await screenSignature();
  await doTap();
  const after1 = await screenSignature();
  const changed1 = before1 !== after1;
  attempts.push({ index: 0, changed: changed1, signatureBefore: before1, signatureAfter: after1 });

  if (changed1 || !opts.enabled) {
    return { ok: true, attempts, retried: false, changed: changed1 };
  }

  const before2 = after1;
  await doTap();
  const after2 = await screenSignature();
  const changed2 = before2 !== after2;
  attempts.push({ index: 1, changed: changed2, signatureBefore: before2, signatureAfter: after2 });
  return { ok: true, attempts, retried: true, changed: changed2 };
}
