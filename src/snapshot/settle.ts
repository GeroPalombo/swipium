// Settle oracle: wait until the accessibility tree stops changing.
// With OS animations disabled this converges fast. Bounded — never waits forever.
//
// Latency: a uiautomator dump itself takes ~1–2 s on real devices, so the poll interval is
// ADAPTIVE (sleep only `intervalMs - lastDumpDuration`), and every dump is bounded by the
// remaining settle deadline with at most SETTLE_DUMP_ATTEMPTS attempts — one stuck dump can no
// longer run 5 attempts x 20 s past the settle budget.

import type { Driver } from '../drivers/Driver.js';

export interface SettleResult {
  xml: string;
  settled: boolean;
}

/** Attempts per dump inside the settle loop (the loop itself is the retry). */
export const SETTLE_DUMP_ATTEMPTS = 2;
/** Floor for a single dump's timeout, so the last dump before the deadline is still usable. */
export const SETTLE_MIN_DUMP_TIMEOUT_MS = 1500;

export async function settle(
  driver: Driver,
  opts: {
    timeoutMs?: number;
    stableForMs?: number;
    intervalMs?: number;
    /** A dump the caller just took (e.g. scroll untilVisible's last probe) — used as the first
     * sample instead of dumping again. `at` = when it was captured. */
    seed?: { xml: string; at: number };
  } = {},
): Promise<SettleResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const stableForMs = opts.stableForMs ?? 600;
  const intervalMs = opts.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  const dumpOpts = () => ({
    timeoutMs: Math.max(SETTLE_MIN_DUMP_TIMEOUT_MS, deadline - Date.now()),
    attempts: SETTLE_DUMP_ATTEMPTS,
  });

  let lastXml = '';
  let lastDumpMs = 0;
  let stableSince: number;
  if (opts.seed?.xml) {
    lastXml = opts.seed.xml;
    stableSince = opts.seed.at;
  } else {
    const started = Date.now();
    try {
      lastXml = await driver.dumpXml(dumpOpts());
    } catch {
      /* try again in the loop */
    }
    lastDumpMs = Date.now() - started;
    stableSince = Date.now();
  }

  while (Date.now() < deadline) {
    const wait = Math.min(Math.max(0, intervalMs - lastDumpMs), Math.max(0, deadline - Date.now()));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (Date.now() >= deadline && lastXml) break;
    const started = Date.now();
    let cur: string;
    try {
      cur = await driver.dumpXml(dumpOpts());
    } catch {
      lastDumpMs = Date.now() - started;
      continue;
    }
    lastDumpMs = Date.now() - started;
    if (cur === lastXml) {
      if (Date.now() - stableSince >= stableForMs) return { xml: cur, settled: true };
    } else {
      lastXml = cur;
      stableSince = Date.now();
    }
  }
  return { xml: lastXml, settled: false };
}
