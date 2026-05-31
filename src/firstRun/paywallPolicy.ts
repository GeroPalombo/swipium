// SWIPIUM-REQ-02 — paywall policy. Swipium NEVER purchases. It records paywall coverage and only
// closes/skips when there is a clearly safe visible dismiss/restore/skip path. PURE.

import type { SnapshotElement } from '../drivers/Driver.js';
import type { PlannedAction } from './types.js';

// Controls that buy / subscribe — must never be auto-tapped.
const PURCHASE = /\b(subscribe|buy|purchase|start\s+(free\s+)?trial|upgrade|continue\s+to\s+payment|pay|unlock\s+premium|get\s+premium|choose\s+plan|select\s+plan)\b/i;
// Safe ways off a paywall.
const SAFE_DISMISS: Array<{ re: RegExp; rank: number; why: string }> = [
  { re: /\b(skip)\b/i, rank: 4, why: 'skip the paywall' },
  { re: /\b(not\s+now|maybe\s+later|no\s+thanks|dismiss)\b/i, rank: 4, why: 'dismiss the paywall' },
  { re: /\b(close|✕|×|x)\b/i, rank: 3, why: 'close the paywall' },
  { re: /\b(continue\s+(with\s+)?free|free\s+version|stay\s+free|use\s+free)\b/i, rank: 3, why: 'continue on the free tier' },
  { re: /\b(restore\s+purchase[s]?)\b/i, rank: 1, why: 'restore purchases (non-destructive)' },
];
// Android/iOS close-affordances by id/accessibility.
const CLOSE_ID = /(^|[:/])(close|btn_close|dismiss|cancel|x_button|close_button|nav_close)\b/i;

export interface PaywallDecision {
  /** A safe dismiss/skip/close action, when one is clearly present. */
  action?: PlannedAction;
  /** Always set — paywall coverage to record regardless of whether we can dismiss. */
  coverage: string;
  /** True when there is no safe exit and the first-run run should stop here. */
  stop: boolean;
}

function isPurchase(el: SnapshotElement): boolean {
  return PURCHASE.test(`${el.label ?? ''} ${el.text ?? ''} ${el.id ?? ''}`);
}

/** Decide how to handle a classified paywall. Never returns a purchase action. */
export function planPaywall(elements: SnapshotElement[]): PaywallDecision {
  let best: { el: SnapshotElement; rank: number; why: string } | undefined;
  for (const el of elements) {
    if (!el.clickable) continue;
    if (isPurchase(el)) continue; // never buy
    const hay = `${el.label ?? ''} ${el.text ?? ''}`;
    let match = SAFE_DISMISS.find((d) => d.re.test(hay));
    if (!match && CLOSE_ID.test(el.id ?? '')) match = { re: CLOSE_ID, rank: 3, why: 'close the paywall (close affordance)' };
    if (!match) continue;
    if (!best || match.rank > best.rank) best = { el, rank: match.rank, why: match.why };
  }

  const coverage = 'paywall encountered — recorded coverage; no purchase attempted';
  if (!best) {
    return { coverage, stop: true };
  }
  const el = best.el;
  return {
    coverage,
    stop: false,
    action: {
      type: best.rank >= 4 ? 'skip' : 'tap',
      targetRef: el.ref,
      label: el.label ?? el.text,
      locator: { strategy: el.id ? 'id' : el.label ? 'accessibility' : 'text', value: el.id ?? el.label ?? el.text },
      bounds: el.bounds,
      reason: best.why,
      risk: 'safe',
    },
  };
}
