// Locator suggestions + durability scoring (NEXT-PLAN: Locator And Maintainability). For each
// element, recommend the most durable way to target it and score how brittle that is, following
// the QA-standard priority: accessibility id / content-desc > resource-id / test tag > stable
// visible text > relative structure > coordinate/image (last resort). The screen-level
// "automation readiness" grade tells a developer how much of the UI needs testIDs.

import type { SnapshotElement } from '../drivers/Driver.js';

export type LocatorTier = 'accessibility' | 'resource_id' | 'visible_text' | 'structure' | 'coordinate';
export type LocatorPlatform = 'android' | 'ios' | 'generic';

const TIER_DURABILITY: Record<LocatorTier, number> = {
  accessibility: 95,
  resource_id: 88,
  visible_text: 60,
  structure: 30,
  coordinate: 10,
};

export interface LocatorSuggestion {
  ref: string;
  role: string;
  tier: LocatorTier;
  durability: number; // 0..100
  locator: string | null; // recommended selector value (null → only coordinates)
  rationale: string;
  needsTestId: boolean; // an interactive control without a durable id → recommend one
  platform?: LocatorPlatform;
  locatorKind?: 'accessibility_identifier' | 'accessibility_label' | 'resource_id' | 'visible_text' | 'structure' | 'coordinate';
  suggestedTestId?: string;
}

// Framework-noise resource ids that aren't durable QA handles.
const NOISE_ID = /(^android:id\/)|(:id\/(content|action_bar|decor_content_parent|navigationBarBackground|statusBarBackground)$)/i;
const isMeaningful = (s?: string): s is string => !!s && s.trim().length > 0;

function roleStem(role: string): string {
  const cleaned = role.split('.').pop()?.replace(/^XCUIElementType/i, '') || role;
  const stem = cleaned.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return stem || 'element';
}

function textStem(value: string | undefined): string | null {
  if (!isMeaningful(value)) return null;
  const stem = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/g, '');
  return stem.length >= 2 ? stem : null;
}

function refStem(ref: string): string {
  return ref.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'control';
}

function suggestedHandle(el: SnapshotElement, platform: LocatorPlatform): string {
  const label = textStem(el.label) ?? textStem(el.text);
  const role = roleStem(el.role);
  const suffix = platform === 'ios' ? role : `${role}_testid`;
  return label ? `${label}_${suffix}` : `${role}_${refStem(el.ref)}`;
}

function dynamicTextReason(value: string | undefined): string | null {
  if (!isMeaningful(value)) return null;
  const text = value.trim();
  if (text.length > 60) return 'text is long and likely to change with content or localization';
  if (/\b\d{1,2}[:/.-]\d{1,2}([:/.-]\d{2,4})?\b/.test(text)) return 'text contains a date/time-like value';
  if (/\b\d+(?:[.,]\d+)?\b/.test(text) && /[$€£¥%]|\b(items?|results?|messages?|notifications?|total|balance|km|mi|min|sec|hours?)\b/i.test(text)) return 'text contains count, currency, percent, or measurement data';
  if (/[0-9a-f]{8,}/i.test(text)) return 'text contains an id/hash-like token';
  return null;
}

export function suggestLocator(el: SnapshotElement, opts: { platform?: LocatorPlatform } = {}): LocatorSuggestion {
  const platform = opts.platform ?? 'generic';
  const base = { ref: el.ref, role: el.role };
  if (platform === 'ios') {
    // iOS/XCUITest priority: accessibilityIdentifier first. Labels/names are useful, but copy
    // and localization often change them; clickable controls without identifiers still need work.
    if (isMeaningful(el.id) && !NOISE_ID.test(el.id)) {
      return { ...base, platform, locatorKind: 'accessibility_identifier', tier: 'accessibility', durability: TIER_DURABILITY.accessibility, locator: el.id, rationale: 'accessibilityIdentifier — preferred durable iOS/XCUITest locator', needsTestId: false };
    }
    if (isMeaningful(el.label)) {
      return { ...base, platform, locatorKind: 'accessibility_label', tier: 'accessibility', durability: 78, locator: el.label, rationale: 'accessibility label/name — usable, but add an accessibilityIdentifier for CI-stable iOS flows', needsTestId: el.clickable, suggestedTestId: el.clickable ? suggestedHandle(el, platform) : undefined };
    }
    if (isMeaningful(el.text)) {
      const short = el.text.trim().length <= 2 || /^\d+$/.test(el.text.trim());
      return { ...base, platform, locatorKind: 'visible_text', tier: 'visible_text', durability: short ? 35 : 58, locator: el.text, rationale: short ? 'visible value/text is short or numeric — brittle on iOS; add an accessibilityIdentifier' : 'visible value/text — usable but copy/localization dependent; prefer accessibilityIdentifier', needsTestId: el.clickable, suggestedTestId: el.clickable ? suggestedHandle(el, platform) : undefined };
    }
    if (el.clickable) {
      return { ...base, platform, locatorKind: 'structure', tier: 'structure', durability: TIER_DURABILITY.structure, locator: null, rationale: 'hittable control has no accessibilityIdentifier, label, or text — predicate/class-chain/coordinates only; add an accessibilityIdentifier', needsTestId: true, suggestedTestId: suggestedHandle(el, platform) };
    }
    return { ...base, platform, locatorKind: 'coordinate', tier: 'coordinate', durability: TIER_DURABILITY.coordinate, locator: null, rationale: 'no durable iOS handle — visual/coordinate targeting only', needsTestId: el.clickable, suggestedTestId: el.clickable ? suggestedHandle(el, platform) : undefined };
  }

  // 1) accessibility id / content description (most durable; survives copy + layout changes)
  if (isMeaningful(el.label)) {
    return { ...base, platform, locatorKind: 'accessibility_label', tier: 'accessibility', durability: TIER_DURABILITY.accessibility, locator: el.label, rationale: 'content-desc / accessibility label — durable and a11y-friendly', needsTestId: false };
  }
  // 2) resource-id / test tag (durable when it's a real testID, not framework noise)
  if (isMeaningful(el.id) && !NOISE_ID.test(el.id)) {
    return { ...base, platform, locatorKind: 'resource_id', tier: 'resource_id', durability: TIER_DURABILITY.resource_id, locator: el.id, rationale: 'resource-id / testID — durable', needsTestId: false };
  }
  // 3) stable visible text (works, but copy/localization can change it)
  if (isMeaningful(el.text)) {
    const short = el.text.trim().length <= 2 || /^\d+$/.test(el.text.trim());
    return { ...base, platform, locatorKind: 'visible_text', tier: 'visible_text', durability: short ? 40 : TIER_DURABILITY.visible_text, locator: el.text, rationale: short ? 'visible text, but very short/numeric — brittle; add a testID' : 'visible text — usable but breaks if copy/localization changes', needsTestId: el.clickable, suggestedTestId: el.clickable ? suggestedHandle(el, platform) : undefined };
  }
  // 4) relative structure (no handle at all on an interactive control)
  if (el.clickable) {
    return { ...base, platform, locatorKind: 'structure', tier: 'structure', durability: TIER_DURABILITY.structure, locator: null, rationale: 'clickable but has no id/label/text — only structural/coordinate targeting; add a testID', needsTestId: true, suggestedTestId: suggestedHandle(el, platform) };
  }
  // 5) coordinate / image (last resort)
  return { ...base, platform, locatorKind: 'coordinate', tier: 'coordinate', durability: TIER_DURABILITY.coordinate, locator: null, rationale: 'no durable handle — coordinate/image match only', needsTestId: el.clickable, suggestedTestId: el.clickable ? suggestedHandle(el, platform) : undefined };
}

export type ReadinessGrade = 'A' | 'B' | 'C' | 'D';

export interface AutomationReadiness {
  grade: ReadinessGrade;
  durablePct: number; // % of interactive controls with an accessibility/resource_id locator
  interactiveCount: number;
  durableCount: number;
  needTestIds: Array<{ ref: string; role: string; hint: string; suggestedTestId?: string }>;
  platform?: LocatorPlatform;
}

export function automationReadiness(suggestions: LocatorSuggestion[], elements: SnapshotElement[], opts: { platform?: LocatorPlatform } = {}): AutomationReadiness {
  const platform = opts.platform ?? 'generic';
  const interactive = elements.filter((e) => e.clickable);
  const byRef = new Map(suggestions.map((s) => [s.ref, s]));
  const durable = interactive.filter((e) => {
    const s = byRef.get(e.ref);
    if (platform === 'ios') return s?.locatorKind === 'accessibility_identifier';
    const t = s?.tier;
    return t === 'accessibility' || t === 'resource_id';
  });
  const durablePct = interactive.length ? Math.round((durable.length / interactive.length) * 100) : 100;
  const grade: ReadinessGrade = durablePct >= 90 ? 'A' : durablePct >= 70 ? 'B' : durablePct >= 50 ? 'C' : 'D';
  const needTestIds = suggestions
    .filter((s) => s.needsTestId)
    .map((s) => ({ ref: s.ref, role: s.role, hint: byRef.get(s.ref)?.locator ? `currently targeted by ${byRef.get(s.ref)!.tier}: "${byRef.get(s.ref)!.locator}"` : 'no durable handle', suggestedTestId: s.suggestedTestId }));
  return { grade, durablePct, interactiveCount: interactive.length, durableCount: durable.length, needTestIds, platform };
}

export interface LocatorReadinessIssue {
  code: 'IOS_MISSING_ACCESSIBILITY_IDENTIFIER' | 'IOS_DUPLICATE_LABEL' | 'DYNAMIC_TEXT_LOCATOR' | 'COORDINATE_ONLY';
  severity: 'info' | 'warn';
  message: string;
  refs: string[];
  suggestion: string;
  suggestedTestIds?: Array<{ ref: string; name: string }>;
}

export function locatorReadinessIssues(suggestions: LocatorSuggestion[], elements: SnapshotElement[], opts: { platform?: LocatorPlatform } = {}): LocatorReadinessIssue[] {
  const platform = opts.platform ?? 'generic';
  const issues: LocatorReadinessIssue[] = [];
  const byRef = new Map(elements.map((e) => [e.ref, e]));

  if (platform === 'ios') {
    const missing = suggestions.filter((s) => s.needsTestId && byRef.get(s.ref)?.clickable);
    if (missing.length) {
      const nameCounts = missing.reduce<Record<string, number>>((acc, s) => {
        if (s.suggestedTestId) acc[s.suggestedTestId] = (acc[s.suggestedTestId] ?? 0) + 1;
        return acc;
      }, {});
      issues.push({
        code: 'IOS_MISSING_ACCESSIBILITY_IDENTIFIER',
        severity: 'warn',
        message: `${missing.length} interactive iOS control(s) lack a stable accessibilityIdentifier.`,
        refs: missing.map((s) => s.ref),
        suggestion: 'Add SwiftUI .accessibilityIdentifier(...), UIKit accessibilityIdentifier, or React Native testID for these controls.',
        suggestedTestIds: missing
          .filter((s) => s.suggestedTestId)
          .map((s) => ({ ref: s.ref, name: nameCounts[s.suggestedTestId!] > 1 ? `${s.suggestedTestId}_${refStem(s.ref)}` : s.suggestedTestId! })),
      });
    }
    const labels = new Map<string, string[]>();
    for (const e of elements) {
      const label = e.label?.trim();
      if (!label || !e.clickable) continue;
      const key = label.toLowerCase();
      labels.set(key, [...(labels.get(key) ?? []), e.ref]);
    }
    for (const [label, refs] of labels) {
      if (refs.length < 2) continue;
      issues.push({
        code: 'IOS_DUPLICATE_LABEL',
        severity: 'warn',
        message: `Duplicate iOS accessibility label "${label}" appears on ${refs.length} interactive controls.`,
        refs,
        suggestion: 'Keep user-facing labels, but give each control a unique accessibilityIdentifier for automation.',
      });
    }
    const dynamicText = suggestions
      .filter((s) => s.locatorKind === 'visible_text' || s.locatorKind === 'accessibility_label')
      .map((s) => ({ suggestion: s, reason: dynamicTextReason(s.locator ?? undefined) }))
      .filter((x): x is { suggestion: LocatorSuggestion; reason: string } => !!x.reason);
    if (dynamicText.length) {
      issues.push({
        code: 'DYNAMIC_TEXT_LOCATOR',
        severity: 'warn',
        message: `${dynamicText.length} iOS locator candidate(s) depend on dynamic text.`,
        refs: dynamicText.map((x) => x.suggestion.ref),
        suggestion: 'Avoid dynamic labels/text in CI flows; add stable accessibilityIdentifier values and target those instead.',
      });
    }
  }

  const coordinateOnly = suggestions.filter((s) => s.tier === 'structure' || s.tier === 'coordinate');
  if (coordinateOnly.length) {
    issues.push({
      code: 'COORDINATE_ONLY',
      severity: 'warn',
      message: `${coordinateOnly.length} element(s) have no semantic locator and would require structure, image, or coordinates.`,
      refs: coordinateOnly.map((s) => s.ref),
      suggestion: platform === 'ios' ? 'Add accessibilityIdentifier values before relying on these controls in CI.' : 'Add testID/resource-id/content-desc values before relying on these controls in CI.',
    });
  }

  return issues;
}
