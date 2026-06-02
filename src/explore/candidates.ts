// Candidate action ranking (Phase 3.3 §8). From a parsed snapshot, produce ranked ExploreElements:
// prioritize useful low-risk coverage (nav, tabs, named safe buttons, list items) and deprioritize
// unlabeled icons + coordinate-only targets — which also surface as locator-quality issues. PURE.

import type { SnapshotElement } from '../drivers/Driver.js';
import { classifyRisk } from './policy.js';
import type { ExploreElement, LocatorInfo } from './graph.js';

const NAV = /\b(home|tab|menu|settings?|search|explore|discover|profile|account|back|next|map|list|history|notifications?|messages?|dashboard|library|feed|overview)\b/i;

function locatorFor(e: SnapshotElement): LocatorInfo {
  if (e.id) return { strategy: 'id', value: e.id, durability: 'high' };
  if (e.label) return { strategy: 'accessibility', value: e.label, durability: 'high' };
  if (e.text) return { strategy: 'text', value: e.text, durability: 'medium' };
  const c = bounds(e);
  return { strategy: 'coordinate', value: `${Math.round(c.x + c.w / 2)},${Math.round(c.y + c.h / 2)}`, durability: 'low' };
}

function bounds(e: SnapshotElement): { x: number; y: number; w: number; h: number } {
  const [x1, y1, x2, y2] = e.bounds;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Priority score (higher = explore sooner). */
function score(e: SnapshotElement, locator: LocatorInfo, risk: string): number {
  let s = 0;
  const label = `${e.text ?? ''} ${e.label ?? ''} ${e.id ?? ''}`;
  if (NAV.test(label)) s += 50; // navigation / tabs first
  if (risk === 'safe') s += 30;
  if (risk === 'destructive') s -= 200;
  if (risk === 'unknown') s -= 10;
  // durable locators are worth more (and teach the suite better selectors)
  s += locator.durability === 'high' ? 20 : locator.durability === 'medium' ? 8 : -15;
  if (locator.strategy === 'coordinate') s -= 20; // coordinate-only is brittle/low-value
  if (e.text || e.label) s += 10; // has a human handle
  return s;
}

export interface RankedCandidate extends ExploreElement {
  score: number;
  signatureKey: string; // stable key to mark "already explored on this screen"
}

export interface RankOptions {
  /** Signature keys already exercised on this screen (skip them). */
  explored?: Set<string>;
  includeTextEntry?: boolean;
}

/** Rank the actionable elements of a parsed snapshot into explore candidates, best first. */
export function rankCandidates(elements: SnapshotElement[], opts: RankOptions = {}): RankedCandidate[] {
  const explored = opts.explored ?? new Set<string>();
  const out: RankedCandidate[] = [];
  for (const e of elements) {
    const editable = /EditText|Text[-_ ]?Field|TextInput|SearchView/i.test(e.role) || e.secure;
    const actionType: ExploreElement['actionType'] = editable ? 'type' : e.clickable ? 'tap' : 'tap';
    if (editable && !opts.includeTextEntry) continue; // no blind typing without a value source
    if (!e.clickable && !editable) continue; // only actionable elements
    const locator = locatorFor(e);
    const { risk, reason, riskClass, stepUp, requiresTwoStepConfirmation } = classifyRisk({ label: e.text || e.label, id: e.id, role: e.role });
    const b = bounds(e);
    const signatureKey = `${actionType}:${locator.strategy}:${locator.value}`;
    if (explored.has(signatureKey)) continue;
    out.push({
      ref: e.ref,
      label: e.text || e.label,
      role: e.role,
      bounds: b,
      locator,
      actionType,
      secure: e.secure,
      risk,
      riskClass,
      stepUp,
      requiresTwoStepConfirmation,
      reason,
      score: score(e, locator, risk),
      signatureKey,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

const ACTION_LIKE_TEXT = /\b(continue|begin|start|started|next|skip|done|submit|confirm|cancel|allow|deny|accept|decline|get started|sign\s?up|sign\s?in|log\s?in|log\s?out|sign\s?out|register|join|subscribe|upgrade|unlock|buy|purchase|checkout|select|choose|create|save|send|share|retry|try again|finish|proceed|got it|continue with|let'?s go)\b/i;

export interface SkippedActionLike {
  ref: string;
  visibleText?: string;
  role: string;
  bounds: { x: number; y: number; w: number; h: number };
  clickable: boolean;
}

export function actionLikeNonInteractive(elements: SnapshotElement[]): SkippedActionLike[] {
  const out: SkippedActionLike[] = [];
  for (const e of elements) {
    const editable = /EditText|Text[-_ ]?Field|TextInput|SearchView/i.test(e.role) || e.secure;
    if (e.clickable || editable) continue;
    const text = (e.text ?? e.label ?? '').trim();
    if (!text) continue;
    const wordCount = text.split(/\s+/).length;
    if (!ACTION_LIKE_TEXT.test(text) && wordCount > 4) continue;
    out.push({ ref: e.ref, visibleText: text, role: e.role, bounds: bounds(e), clickable: !!e.clickable });
  }
  return out;
}

/** Locator-readiness grade for a screen (Phase 3.3 §9.4) — drives the report's testability advice. */
export function locatorQuality(elements: SnapshotElement[]): { grade: 'A' | 'B' | 'C' | 'D'; missingStableLocators: number; coordinateOnlyTargets: number } {
  const actionable = elements.filter((e) => e.clickable);
  if (actionable.length === 0) return { grade: 'A', missingStableLocators: 0, coordinateOnlyTargets: 0 };
  let stable = 0;
  let coordinateOnly = 0;
  for (const e of actionable) {
    if (e.id || e.label) stable++;
    else if (!e.text) coordinateOnly++;
  }
  const ratio = stable / actionable.length;
  const grade = ratio >= 0.9 ? 'A' : ratio >= 0.7 ? 'B' : ratio >= 0.4 ? 'C' : 'D';
  return { grade, missingStableLocators: actionable.length - stable, coordinateOnlyTargets: coordinateOnly };
}
