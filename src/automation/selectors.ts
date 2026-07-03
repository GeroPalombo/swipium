// Automation Kernel V2 — Workstream 2: Selector IR V2. One normalized selector model shared by
// Flow V2, Maestro import/export, the Appium audit, and flow repair. Parses the existing Swipium
// selector string grammar, normalizes Android resource ids, scores risk/portability, preserves
// provenance, and refuses unsupported strategies per backend. NEVER generates XPath.

import type { BackendCapabilities } from './capabilities.js';
import { selectorSupported } from './capabilities.js';
import type { SelectorHints, SelectorIR, SelectorSource, SelectorStrategy } from './types.js';
import { isVisualStrategy } from './types.js';

const PLATFORM_FOR_STRATEGY: Partial<Record<SelectorStrategy, SelectorIR['platform']>> = {
  resource_id: 'android',
  ios_predicate: 'ios',
  ios_class_chain: 'ios',
};

const PORTABLE_STRATEGIES: readonly SelectorStrategy[] = ['accessibility_id', 'text', 'ocr_text', 'image'];

/** Normalize the many Android resource-id spellings to a bare id (last `/` segment). */
export function normalizeResourceId(value: string): string {
  const trimmed = value.trim();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function riskFor(strategy: SelectorStrategy, value: string, hints?: SelectorHints): SelectorIR['risk'] {
  switch (strategy) {
    case 'accessibility_id':
    case 'resource_id':
      return 'low';
    case 'ios_predicate':
    case 'ios_class_chain':
      return 'medium';
    case 'text': {
      // Plain text is CI-brittle (copy/localization). Stable structural hints lower the risk.
      const hasStableHint = !!(hints?.boundsBucket || hints?.screenSignature || hints?.className);
      return hasStableHint ? 'medium' : 'high';
    }
    case 'ocr_text':
    case 'image':
      return 'high';
    case 'coordinate':
      return 'high';
    default:
      return 'high';
  }
}

/**
 * Parse one Swipium selector string into Selector IR. Recognizes the existing grammar:
 *   `id=foo`, `id/foo`, `com.example:id/foo`, `accessibility id=foo`, `name=foo`,
 *   `predicate string=...`, `class chain=...`, and bare text.
 * OCR / image selectors come from dedicated flow steps, not this string grammar — see selectorForVisual().
 */
export function parseSelector(
  raw: string,
  opts: { source?: SelectorSource; platform?: SelectorIR['platform']; hints?: SelectorHints } = {},
): SelectorIR {
  const source: SelectorSource = opts.source ?? 'flow';
  const hints = opts.hints;
  const s = raw.trim();

  const make = (strategy: SelectorStrategy, value: string): SelectorIR => ({
    strategy,
    value,
    platform: opts.platform ?? PLATFORM_FOR_STRATEGY[strategy] ?? 'cross_platform',
    source,
    hints,
    risk: riskFor(strategy, value, hints),
    portable: PORTABLE_STRATEGIES.includes(strategy),
  });

  let m: RegExpMatchArray | null;
  if ((m = s.match(/^id\s*=\s*(.+)$/i))) return make('resource_id', normalizeResourceId(m[1]));
  if ((m = s.match(/^accessibility id\s*=\s*(.+)$/i))) return make('accessibility_id', m[1].trim());
  if ((m = s.match(/^name\s*=\s*(.+)$/i))) return make('text', m[1].trim());
  if ((m = s.match(/^predicate string\s*=\s*(.+)$/i))) return make('ios_predicate', m[1].trim());
  if ((m = s.match(/^class chain\s*=\s*(.+)$/i))) return make('ios_class_chain', m[1].trim());
  // `com.example:id/foo` or `id/foo` without an explicit `id=` prefix is still an Android resource id.
  if (/^[\w.]*:id\//.test(s) || /^id\//.test(s)) return make('resource_id', normalizeResourceId(s));
  return make('text', s);
}

/** Build a visual (OCR/image) Selector IR from a dedicated visual flow step. */
export function selectorForVisual(
  strategy: 'ocr_text' | 'image',
  value: string,
  opts: { source?: SelectorSource; hints?: SelectorHints } = {},
): SelectorIR {
  return {
    strategy,
    value,
    platform: 'cross_platform',
    source: opts.source ?? 'flow',
    hints: opts.hints,
    risk: 'high',
    portable: true,
  };
}

/** A coordinate selector (tapAt) — always last-resort, non-portable, high risk. */
export function selectorForCoordinate(value: string, source: SelectorSource = 'flow'): SelectorIR {
  return { strategy: 'coordinate', value, platform: 'cross_platform', source, risk: 'high', portable: false };
}

export interface SelectorBackendCheck {
  supported: boolean;
  code?: 'BACKEND_UNSUPPORTED';
  detail?: string;
  nextStep?: string;
}

/** Refuse selectors a backend cannot honor (e.g. an iOS predicate on Android DirectDriver). */
export function checkSelectorBackend(ir: SelectorIR, caps: BackendCapabilities): SelectorBackendCheck {
  if (selectorSupported(caps, ir.strategy)) return { supported: true };
  return {
    supported: false,
    code: 'BACKEND_UNSUPPORTED',
    detail: `${ir.strategy} selector is not supported on ${caps.backend}.`,
    nextStep: nextStepForUnsupportedSelector(ir.strategy, caps),
  };
}

function nextStepForUnsupportedSelector(strategy: SelectorStrategy, caps: BackendCapabilities): string {
  if (strategy === 'ios_predicate' || strategy === 'ios_class_chain') {
    return 'Use an iOS WDA or Appium XCUITest backend, or replace it with an accessibility id.';
  }
  if ((strategy === 'accessibility_id' || strategy === 'resource_id' || strategy === 'text') && !caps.structuredTree) {
    return 'Attach WDA or Appium for structured selectors, or rewrite the step as a visual/OCR check.';
  }
  return `Attach a backend that supports ${strategy}.`;
}

export interface SelectorCiRisk {
  risk: SelectorIR['risk'];
  code?: 'HIGH_RISK_SELECTOR';
  detail?: string;
  nextStep?: string;
}

/** CI-readiness check: plain text without stable hints is high risk and flagged. */
export function checkSelectorCiRisk(ir: SelectorIR): SelectorCiRisk {
  if (ir.strategy === 'text' && ir.risk === 'high') {
    return {
      risk: 'high',
      code: 'HIGH_RISK_SELECTOR',
      detail: 'Plain-text selector with no stable hints is brittle under copy/localization changes.',
      nextStep: 'Pair it with a stable accessibility id / resource id, or add structural hints (boundsBucket, screenSignature).',
    };
  }
  return { risk: ir.risk };
}

/** A selector match candidate from a parsed snapshot — just enough to detect ambiguity. */
export interface SelectorMatchCandidate {
  resourceId?: string;
  accessibilityId?: string;
  text?: string;
  boundsBucket?: string;
  screenSignature?: string;
}

export type SelectorResolution =
  | { ok: true; match: SelectorMatchCandidate }
  | { ok: false; code: 'AMBIGUOUS_SELECTOR' | 'SELECTOR_NOT_FOUND'; detail: string; matches: number };

/**
 * Resolve a (resource_id | accessibility_id) selector against parsed candidates. Duplicate matches
 * are AMBIGUOUS_SELECTOR unless the IR's hints (boundsBucket / screenSignature) disambiguate to one.
 */
export function resolveSelector(ir: SelectorIR, candidates: SelectorMatchCandidate[]): SelectorResolution {
  const key = (c: SelectorMatchCandidate): string | undefined =>
    ir.strategy === 'resource_id'
      ? c.resourceId
        ? normalizeResourceId(c.resourceId)
        : undefined
      : ir.strategy === 'accessibility_id'
        ? c.accessibilityId
        : ir.strategy === 'text'
          ? c.text
          : undefined;

  let matches = candidates.filter((c) => key(c) === ir.value);
  if (matches.length === 0) {
    return { ok: false, code: 'SELECTOR_NOT_FOUND', detail: `No element matches ${ir.strategy}=${ir.value}.`, matches: 0 };
  }
  if (matches.length === 1) return { ok: true, match: matches[0] };

  // Try to disambiguate by hints.
  if (ir.hints?.boundsBucket) {
    const narrowed = matches.filter((c) => c.boundsBucket === ir.hints!.boundsBucket);
    if (narrowed.length === 1) return { ok: true, match: narrowed[0] };
    if (narrowed.length) matches = narrowed;
  }
  if (ir.hints?.screenSignature) {
    const narrowed = matches.filter((c) => c.screenSignature === ir.hints!.screenSignature);
    if (narrowed.length === 1) return { ok: true, match: narrowed[0] };
  }
  return {
    ok: false,
    code: 'AMBIGUOUS_SELECTOR',
    detail: `${matches.length} elements match ${ir.strategy}=${ir.value}; add a disambiguating hint (boundsBucket/screenSignature) or a unique testID.`,
    matches: matches.length,
  };
}

export interface AppiumLocator {
  using: 'id' | 'accessibility id' | '-ios predicate string' | '-ios class chain' | '-android uiautomator';
  value: string;
}

/**
 * Export a Selector IR to an Appium native locator strategy. NEVER returns XPath — visual/coordinate
 * strategies have no Appium native locator and return null (the caller must mark them manual_review).
 */
export function selectorToAppium(ir: SelectorIR): AppiumLocator | null {
  switch (ir.strategy) {
    case 'resource_id':
      return { using: 'id', value: ir.value };
    case 'accessibility_id':
      return { using: 'accessibility id', value: ir.value };
    case 'ios_predicate':
      return { using: '-ios predicate string', value: ir.value };
    case 'ios_class_chain':
      return { using: '-ios class chain', value: ir.value };
    case 'text':
      // Prefer a UiAutomator native text matcher over XPath for Android.
      return { using: '-android uiautomator', value: `new UiSelector().text("${ir.value.replace(/"/g, '\\"')}")` };
    default:
      return null;
  }
}

/** Convert a Maestro selector block (string | { id|text|... }) to Selector IR without semantic loss. */
export function selectorFromMaestro(value: unknown, source: SelectorSource = 'maestro_import'): SelectorIR | null {
  if (typeof value === 'string') return parseSelector(value, { source });
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id === 'string') return parseSelector(`id=${v.id}`, { source });
  if (typeof v['accessibility id'] === 'string') return parseSelector(`accessibility id=${v['accessibility id']}`, { source });
  if (typeof v.label === 'string') return parseSelector(`accessibility id=${v.label}`, { source });
  if (typeof v.text === 'string') return parseSelector(v.text, { source });
  return null;
}

/** True when the strategy is a structured (non-visual) locator. */
export function isStructuredSelector(ir: SelectorIR): boolean {
  return !isVisualStrategy(ir.strategy) && ir.strategy !== 'coordinate';
}
