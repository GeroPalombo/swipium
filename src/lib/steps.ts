// Shared bits for the step timeline writers (qa_act, flows, smoke, explore, qa_note): the screen
// label, a bounded wait for best-effort device calls, and the failure evidence (screenshot + UI
// dump) attached to a failed step. Evidence is best-effort: it never fails the step or the tool,
// and it never counts toward the screenshot budget.

import type { Driver } from '../drivers/Driver.js';
import type { RawNode } from '../snapshot/parse.js';
import { TRANSPORT_FAILURE_CODES, type Session, type SessionStore, type StepRecord } from '../session/store.js';
import { canCaptureScreenshot } from './captureGuard.js';

/** Cap for a failure screenshot / dump: a slow device must not stretch a failed call much. */
export const STEP_CAPTURE_TIMEOUT_MS = 5000;

/** Failure codes that never capture evidence: the action was refused before it ran (validation,
 *  overlay, budget), the call was cancelled, or the device is gone (it would only add timeouts). */
const NO_CAPTURE_CODES = new Set(['INVALID_ARGUMENT', 'OVERLAY_OBSTRUCTION', 'CANCELLED', 'BUDGET_EXHAUSTED']);

export function skipsFailureCapture(code?: string): boolean {
  return !!code && (NO_CAPTURE_CODES.has(code) || TRANSPORT_FAILURE_CODES.has(code));
}

/** The visible screen title: the first short non-clickable text near the top. */
export function screenTitleFromNodes(nodes: RawNode[] | undefined): string | undefined {
  if (!nodes?.length) return undefined;
  const height = nodes[0].bounds[3] || 0;
  const topBand = height ? height * 0.28 : Number.POSITIVE_INFINITY;
  const candidates = nodes
    .filter((n) => n.text && n.text.trim().length >= 2 && n.text.trim().length <= 40 && !n.clickable)
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
  const header = candidates.find((n) => n.bounds[1] <= topBand) ?? candidates[0];
  return header?.text?.trim() || undefined;
}

export function currentScreenTitle(session: Session): string | undefined {
  return screenTitleFromNodes(session.lastSnapshot?.allNodes);
}

export const TIMED_OUT = Symbol('timed out');

/** Resolve with the promise's value, or TIMED_OUT after `ms` (the promise keeps running). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface FailedStepEvidence {
  failureCode?: string;
  /** The tree the caller holds for the current screen (guard input). */
  nodes?: RawNode[];
  /** Raw XML the caller already holds; saved as the step's dump. Never rebuilt from nodes. */
  xml?: string;
  /** The caller captured (or withheld) the screenshot itself: reuse it, don't capture again. */
  reuse?: { screenshotUri?: string; screenshotSkipped?: string };
  /** Take one fresh dump when no XML is in hand (flows). */
  freshDump?: boolean;
  label: string;
}

/** Attach failure evidence to step `i`. Never throws. */
export async function captureFailedStepEvidence(
  sessions: SessionStore,
  session: Session,
  d: Driver | undefined,
  i: number,
  ev: FailedStepEvidence,
): Promise<void> {
  try {
    if (skipsFailureCapture(ev.failureCode)) {
      if (ev.failureCode && TRANSPORT_FAILURE_CODES.has(ev.failureCode))
        sessions.updateStep(session, i, { screenshotSkipped: 'not captured (device unreachable)' });
      return;
    }
    if (session.sensitive) {
      // No pixels and no dump in a sensitive session.
      sessions.updateStep(session, i, { screenshotSkipped: 'screenshot withheld (sensitive session)' });
      return;
    }
    const patch: Partial<Pick<StepRecord, 'screenshotUri' | 'dumpUri' | 'screenshotSkipped'>> = {};
    if (ev.reuse) {
      if (ev.reuse.screenshotUri) patch.screenshotUri = ev.reuse.screenshotUri;
      else if (ev.reuse.screenshotSkipped) patch.screenshotSkipped = ev.reuse.screenshotSkipped;
    } else if (d) {
      // A failure can land before any settle (no tree in hand, stale cache): a structured backend
      // then re-dumps once so a just-opened login/OTP screen is still checked. Failure path only.
      // canCaptureScreenshot never throws (a failed dump reads as unknown).
      const g = await withTimeout(canCaptureScreenshot(session, d, { nodes: ev.nodes, refresh: true }), STEP_CAPTURE_TIMEOUT_MS);
      // A guard that cannot answer in time withholds: a slow device is no reason to risk pixels.
      if (g === TIMED_OUT) patch.screenshotSkipped = 'screenshot timed out';
      else if (!g.ok) patch.screenshotSkipped = g.note;
      else {
        // capture-guard: guarded by canCaptureScreenshot above
        const png = await withTimeout(d.screenshot(), STEP_CAPTURE_TIMEOUT_MS).catch(() => undefined);
        if (Buffer.isBuffer(png))
          patch.screenshotUri = sessions.saveArtifact(
            session,
            'screenshot',
            `step-${i}-fail-${Date.now()}.png`,
            png,
            'image/png',
            ev.label,
          );
        else patch.screenshotSkipped = png === TIMED_OUT ? 'screenshot timed out' : 'screenshot failed';
      }
    }
    let xml = ev.xml;
    if (!xml && ev.freshDump && d) {
      const got = await withTimeout(d.dumpXml(), STEP_CAPTURE_TIMEOUT_MS).catch(() => undefined);
      if (typeof got === 'string') xml = got;
    }
    if (xml) patch.dumpUri = sessions.saveArtifact(session, 'dump', `step-${i}-dump-${Date.now()}.xml`, xml, 'application/xml', ev.label);
    if (Object.keys(patch).length) sessions.updateStep(session, i, patch);
  } catch {
    /* best-effort evidence */
  }
}
