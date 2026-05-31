// Settle oracle (DESIGN §5): wait until the accessibility tree stops changing.
// With OS animations disabled this converges fast. Bounded — never waits forever.

import type { Driver } from '../drivers/Driver.js';

export interface SettleResult {
  xml: string;
  settled: boolean;
}

export async function settle(
  driver: Driver,
  opts: { timeoutMs?: number; stableForMs?: number; intervalMs?: number } = {},
): Promise<SettleResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const stableForMs = opts.stableForMs ?? 600;
  const intervalMs = opts.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;

  let lastXml = '';
  try {
    lastXml = await driver.dumpXml();
  } catch {
    /* try again in the loop */
  }
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let cur: string;
    try {
      cur = await driver.dumpXml();
    } catch {
      continue;
    }
    if (cur === lastXml) {
      if (Date.now() - stableSince >= stableForMs) return { xml: cur, settled: true };
    } else {
      lastXml = cur;
      stableSince = Date.now();
    }
  }
  return { xml: lastXml, settled: false };
}
