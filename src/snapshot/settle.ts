// Settle oracle: wait until the accessibility tree stops changing.
// With OS animations disabled this converges fast. Bounded, so it never waits forever.
//
// Latency: a uiautomator dump itself takes ~1-2 s on real devices, so the poll interval is
// ADAPTIVE (sleep only `intervalMs - lastDumpDuration`), and every dump is bounded by the
// remaining settle deadline with at most SETTLE_DUMP_ATTEMPTS attempts, so one stuck dump can no
// longer run 5 attempts x 20 s past the settle budget.

//
// Stability is judged on a normalized FINGERPRINT (X4), not the raw XML: surfaced elements only,
// bounds bucketed, volatile text (clocks, percentages, progress values) masked, so a ticking clock
// or a progress bar no longer keeps the screen "unsettled" for the whole budget.
//
// Fast accept (P1, Android `direct` only): the FIRST post-action dump is accepted as settled when it
// differs from the pre-action fingerprint and shows no busy markers. Otherwise the 2-dump confirm runs.

import type { Driver } from '../drivers/Driver.js';
import { CancelledError, currentSignal, isAbortError, sleepOrCancel } from '../lib/abortScope.js';
import { stableHash } from '../lib/stableHash.js';
import { parseSnapshot, type ParsedSnapshot, type RawNode } from './parse.js';

export interface SettleResult {
  xml: string;
  settled: boolean;
  /** The parsed final dump (undefined when nothing could be dumped / parsed). */
  parsed?: ParsedSnapshot;
  /** True when the first dump was accepted without a confirming second dump (P1). */
  fastAccepted?: boolean;
}

const VOLATILE_CLS = /SeekBar|ProgressBar|RatingBar/i;
const BUSY_CLS = /ProgressBar|ActivityIndicator|Lottie/i;
const BUSY_TEXT = /loading|cargando/i;

function maskVolatile(s: string): string {
  return s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '#:#').replace(/\d+(?:[.,]\d+)?\s?%/g, '#%');
}

/** Normalized fingerprint of a screen's surfaced nodes (pass parsed.fullByRef.values()). */
export function screenFingerprint(nodes: Iterable<RawNode>): string {
  const b = (v: number) => Math.round(v / 8);
  const rows = [...nodes].map((n) => {
    const vol = VOLATILE_CLS.test(n.cls);
    return [
      n.cls,
      n.id,
      vol ? '' : maskVolatile(n.text),
      vol ? '' : maskVolatile(n.desc),
      n.bounds.map(b),
      n.attrs.checked ?? '',
      n.attrs.selected ?? '',
      n.focused,
    ];
  });
  return stableHash(rows);
}

/** A screen still working: progress / activity indicators, Lottie, "loading" copy, a near-empty tree. */
export function looksBusy(all: RawNode[]): boolean {
  if (all.length < 3) return true;
  return all.some((n) => BUSY_CLS.test(n.cls) || n.attrs.indeterminate === 'true' || BUSY_TEXT.test(`${n.text} ${n.desc}`));
}

function fingerprintXml(xml: string): { fp: string; parsed?: ParsedSnapshot } {
  try {
    const parsed = parseSnapshot(xml);
    return { fp: screenFingerprint(parsed.fullByRef.values()), parsed };
  } catch {
    return { fp: `raw:${xml}` };
  }
}

let fastAccepts = 0;
/** How many settles were fast-accepted in this process (P1 rate, for logs/tests). */
export function settleFastAccepts(): number {
  return fastAccepts;
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
    /** A dump the caller just took (e.g. scroll untilVisible's last probe). Used as the first
     * sample instead of dumping again. `at` = when it was captured. */
    seed?: { xml: string; at: number };
    /** Fingerprint (screenFingerprint) of the screen before the action; enables the fast accept. */
    preFingerprint?: string;
  } = {},
): Promise<SettleResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const stableForMs = opts.stableForMs ?? 600;
  const intervalMs = opts.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  // Cancellation (abortScope): a cancelled call/job throws CancelledError instead of re-dumping
  // (each aborted dump fails fast) until the settle deadline.
  const signal = currentSignal();
  const cancelled = (e?: unknown) => (e === undefined ? !!signal?.aborted : isAbortError(e, signal));
  const dumpOpts = () => ({
    timeoutMs: Math.max(SETTLE_MIN_DUMP_TIMEOUT_MS, deadline - Date.now()),
    attempts: SETTLE_DUMP_ATTEMPTS,
  });

  let lastXml = '';
  let last: { fp: string; parsed?: ParsedSnapshot } = { fp: '' };
  let lastDumpMs = 0;
  let stableSince: number;
  if (opts.seed?.xml) {
    lastXml = opts.seed.xml;
    last = fingerprintXml(lastXml);
    stableSince = opts.seed.at;
  } else {
    const started = Date.now();
    try {
      lastXml = await driver.dumpXml(dumpOpts());
      last = fingerprintXml(lastXml);
      if (
        driver.kind === 'direct' &&
        opts.preFingerprint &&
        last.parsed &&
        last.fp !== opts.preFingerprint &&
        !looksBusy(last.parsed.allNodes)
      ) {
        fastAccepts++;
        return { xml: lastXml, settled: true, parsed: last.parsed, fastAccepted: true };
      }
    } catch (e) {
      if (cancelled(e)) throw new CancelledError();
      /* try again in the loop */
    }
    lastDumpMs = Date.now() - started;
    stableSince = Date.now();
  }

  while (Date.now() < deadline) {
    const wait = Math.min(Math.max(0, intervalMs - lastDumpMs), Math.max(0, deadline - Date.now()));
    if (cancelled()) throw new CancelledError();
    if (wait > 0) await sleepOrCancel(wait, signal);
    if (Date.now() >= deadline && lastXml) break;
    const started = Date.now();
    let cur: string;
    try {
      cur = await driver.dumpXml(dumpOpts());
    } catch (e) {
      if (cancelled(e)) throw new CancelledError();
      lastDumpMs = Date.now() - started;
      continue;
    }
    lastDumpMs = Date.now() - started;
    const now = cur === lastXml ? last : fingerprintXml(cur);
    lastXml = cur;
    if (now.fp === last.fp) {
      last = now;
      if (Date.now() - stableSince >= stableForMs) return { xml: cur, settled: true, parsed: now.parsed };
    } else {
      last = now;
      stableSince = Date.now();
    }
  }
  return { xml: lastXml, settled: false, parsed: last.parsed };
}
