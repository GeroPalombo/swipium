// One screenshot guard for every capture path (report evidence, checkpoints, smoke, explore, flows,
// health evidence, first run, audit, OCR). qa_screenshot and qa_visual keep their own user-facing
// refusal text but share the same rule:
//   - a sensitive session never captures pixels;
//   - a secure field (password/OTP) on the current screen withholds the capture;
//   - an unknown screen (no fresh tree, e.g. a WDA-less simulator) is allowed, as before.
// Pixels are never redactable, so "withheld" is the only safe answer on a secure screen.

import type { Driver } from '../drivers/Driver.js';
import type { Session } from '../session/store.js';
import { isSecureNode } from './redact.js';
import { parseSnapshot, type RawNode } from '../snapshot/parse.js';
import { freshSnapshot } from '../snapshot/fresh.js';

export type CaptureWithheldReason = 'sensitive' | 'secure_field';
export type CaptureVerdict = { ok: true } | { ok: false; reason: CaptureWithheldReason; note: string };

const WITHHELD_NOTE: Record<CaptureWithheldReason, string> = {
  sensitive: 'screenshot withheld (sensitive session)',
  secure_field: 'screenshot withheld (secure field)',
};

function withheld(reason: CaptureWithheldReason): CaptureVerdict {
  return { ok: false, reason, note: WITHHELD_NOTE[reason] };
}

/**
 * Synchronous guard: uses `nodes` when the caller already holds the current tree (qa_act's
 * post-action snapshot, a flow step's dump), else the session's cached tree while it is still
 * fresh. Never touches the device.
 */
export function captureGuardSync(session: Pick<Session, 'sensitive'> & Partial<Session>, nodes?: RawNode[]): CaptureVerdict {
  if (session.sensitive) return withheld('sensitive');
  if (nodes && nodes.length) return nodes.some((n) => isSecureNode(n)) ? withheld('secure_field') : { ok: true };
  const snap = session.lastSnapshot ? freshSnapshot(session as Session, Number.POSITIVE_INFINITY) : undefined;
  if (snap && [...snap.fullByRef.values()].some((n) => isSecureNode(n))) return withheld('secure_field');
  return { ok: true };
}

/**
 * Async guard: like captureGuardSync, but when no tree is in hand and the cached one is stale, a
 * structured backend (adb / WDA) re-dumps once so a stale "no password field" never lets a login
 * screen through. `refresh:false` skips that dump (hot paths that must not add a device call).
 */
export async function canCaptureScreenshot(
  session: Session,
  driver?: Driver,
  opts: { nodes?: RawNode[]; refresh?: boolean } = {},
): Promise<CaptureVerdict> {
  if (session.sensitive) return withheld('sensitive');
  if (opts.nodes && opts.nodes.length) return captureGuardSync(session, opts.nodes);
  const snap = session.lastSnapshot ? freshSnapshot(session, Number.POSITIVE_INFINITY) : undefined;
  if (snap) return [...snap.fullByRef.values()].some((n) => isSecureNode(n)) ? withheld('secure_field') : { ok: true };
  if (opts.refresh === false || !driver || driver.kind === 'simulator') return { ok: true };
  try {
    const parsed = parseSnapshot(await driver.dumpXml());
    return parsed.allNodes.some((n) => isSecureNode(n)) ? withheld('secure_field') : { ok: true };
  } catch {
    return { ok: true };
  }
}
