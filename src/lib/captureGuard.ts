// One screenshot guard for every capture path (report evidence, checkpoints, smoke, explore, flows,
// health evidence, first run, audit, OCR). qa_screenshot and qa_visual keep their own user-facing
// refusal text (and force:true) but share the same rule through secureStateCached/secureStateRefreshed:
//   - a sensitive session never captures pixels;
//   - a secure field (password/OTP) on the current screen withholds the capture;
//   - an unknown screen (no fresh tree, e.g. a WDA-less simulator) is allowed, as before.
// Pixels are never redactable, so "withheld" is the only safe answer on a secure screen.
//
// Every non-driver `.screenshot(` call in src/ goes through this module or carries a
// `// capture-guard: <reason>` marker on the line above (test/captureGuardCallers.test.ts).

import type { Driver } from '../drivers/Driver.js';
import type { Session } from '../session/store.js';
import { isSecureNode } from './redact.js';
import { parseSnapshot, type RawNode } from '../snapshot/parse.js';
import { freshSnapshot } from '../snapshot/fresh.js';

export type CaptureWithheldReason = 'sensitive' | 'secure_field';
export type CaptureVerdict = { ok: true } | { ok: false; reason: CaptureWithheldReason; note: string };
export type SecureScreenState = 'secure' | 'clear' | 'unknown';

const WITHHELD_NOTE: Record<CaptureWithheldReason, string> = {
  sensitive: 'screenshot withheld (sensitive session)',
  secure_field: 'screenshot withheld (secure field)',
};

function withheld(reason: CaptureWithheldReason): CaptureVerdict {
  return { ok: false, reason, note: WITHHELD_NOTE[reason] };
}

/** secure/clear from the session's cached tree while it is still fresh (no action or screen change
 *  since, no age limit); unknown without one. `seen.nodes` receives the tree the answer came from. */
export function secureStateCached(session: Session, seen?: { nodes?: RawNode[] }): SecureScreenState {
  const snap = session.lastSnapshot ? freshSnapshot(session, Number.POSITIVE_INFINITY) : undefined;
  if (!snap) return 'unknown';
  if (seen) seen.nodes = snap.allNodes;
  return [...snap.fullByRef.values()].some((n) => isSecureNode(n)) ? 'secure' : 'clear';
}

/** secureStateCached, but a structured backend (adb / WDA) re-dumps once when the cache is missing
 *  or stale, so a stale "no password field" never lets a login screen through. The dump only informs
 *  the guard: session.lastSnapshot (the agent's @ref numbering) is left untouched. A WDA-less
 *  simulator cannot dump, so it stays unknown; so does a failed or empty dump. */
export async function secureStateRefreshed(session: Session, driver: Driver, seen?: { nodes?: RawNode[] }): Promise<SecureScreenState> {
  const cached = secureStateCached(session, seen);
  if (cached !== 'unknown' || driver.kind === 'simulator') return cached;
  try {
    const parsed = parseSnapshot(await driver.dumpXml());
    if (parsed.allNodes.length === 0) return 'unknown';
    if (seen) seen.nodes = parsed.allNodes;
    return parsed.allNodes.some((n) => isSecureNode(n)) ? 'secure' : 'clear';
  } catch {
    return 'unknown';
  }
}

/**
 * Synchronous guard: uses `nodes` when the caller already holds the current tree (qa_act's
 * post-action snapshot, a flow step's dump), else the session's cached tree while it is still
 * fresh. Never touches the device.
 */
export function captureGuardSync(session: Pick<Session, 'sensitive'> & Partial<Session>, nodes?: RawNode[]): CaptureVerdict {
  if (session.sensitive) return withheld('sensitive');
  if (nodes && nodes.length) return nodes.some((n) => isSecureNode(n)) ? withheld('secure_field') : { ok: true };
  return secureStateCached(session as Session) === 'secure' ? withheld('secure_field') : { ok: true };
}

/**
 * Async guard: like captureGuardSync, but when no tree is in hand and the cached one is stale, a
 * structured backend (adb / WDA) re-dumps once. `refresh:false` skips that dump (hot paths that
 * must not add a device call).
 */
export async function canCaptureScreenshot(
  session: Session,
  driver?: Driver,
  opts: { nodes?: RawNode[]; refresh?: boolean } = {},
): Promise<CaptureVerdict> {
  if (session.sensitive || (opts.nodes && opts.nodes.length) || opts.refresh === false || !driver)
    return captureGuardSync(session, opts.nodes);
  return (await secureStateRefreshed(session, driver)) === 'secure' ? withheld('secure_field') : { ok: true };
}

/** Thrown by capture helpers that have no result shape of their own (runOcr) when the guard
 *  withholds the capture. */
export class CaptureWithheldError extends Error {
  constructor(readonly verdict: Extract<CaptureVerdict, { ok: false }>) {
    super(verdict.note);
    this.name = 'CaptureWithheldError';
  }
}
