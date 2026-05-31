// SWIPIUM-REQ-02 — onboarding progression. Prefer non-destructive forward/skip controls
// (Next / Continue / Skip / Get started / Done) and never tap a destructive or unknown control.
// PURE: returns the single best forward action (or none) for a classified onboarding screen.

import type { SnapshotElement } from '../drivers/Driver.js';
import { classifyRisk } from '../explore/policy.js';
import type { PlannedAction } from './types.js';

// Forward controls, ranked: an explicit "skip" finishes onboarding fastest; otherwise advance.
const FORWARD_RANKED: Array<{ re: RegExp; rank: number; why: string }> = [
  { re: /\b(skip)\b/i, rank: 5, why: 'skip onboarding' },
  { re: /\b(get\s+started|let'?s\s+go|start)\b/i, rank: 4, why: 'start using the app' },
  { re: /\b(done|finish|complete)\b/i, rank: 4, why: 'finish onboarding' },
  { re: /\b(continue)\b/i, rank: 3, why: 'continue onboarding' },
  { re: /\b(next)\b/i, rank: 2, why: 'advance to the next onboarding step' },
  { re: /\b(maybe\s+later|not\s+now|no\s+thanks)\b/i, rank: 1, why: 'dismiss an optional onboarding prompt' },
];

export interface OnboardingStep {
  action?: PlannedAction;
  blockedReason?: string;
}

/** Pick the safest forward control on an onboarding screen. */
export function planOnboardingStep(elements: SnapshotElement[]): OnboardingStep {
  let best: { el: SnapshotElement; rank: number; why: string } | undefined;
  for (const el of elements) {
    if (!el.clickable) continue;
    const hay = `${el.label ?? ''} ${el.text ?? ''} ${el.id ?? ''}`;
    const match = FORWARD_RANKED.find((f) => f.re.test(hay));
    if (!match) continue;
    // Never advance via something the risk classifier flags as destructive.
    if (classifyRisk({ label: el.label ?? el.text, id: el.id, role: el.role }).risk === 'destructive') continue;
    if (!best || match.rank > best.rank) best = { el, rank: match.rank, why: match.why };
  }
  if (!best) {
    return { blockedReason: 'no safe forward/skip control found on the onboarding screen' };
  }
  const el = best.el;
  return {
    action: {
      type: 'tap',
      targetRef: el.ref,
      label: el.label ?? el.text,
      locator: { strategy: el.id ? 'id' : el.label ? 'accessibility' : 'text', value: el.id ?? el.label ?? el.text },
      bounds: el.bounds,
      reason: best.why,
      risk: 'safe',
    },
  };
}
