// Automation Kernel V2: Selector IR V2. One normalized selector model shared by
// Flow V2, the Appium audit, and flow repair. Parses the existing Swipium selector string
// grammar, normalizes Android resource ids, scores risk/portability, preserves provenance, and
// refuses unsupported strategies per backend. NEVER generates XPath. (Maestro interop left the
// public surface in 1.5.0; the `maestro_import` SelectorSource remains valid for flows recorded
// by earlier versions.)

import type { BackendCapabilities } from './capabilities.js';
import { selectorSupported } from './capabilities.js';
import type { SelectorHints, SelectorIR, SelectorSource, SelectorStrategy } from './types.js';

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
 * OCR / image selectors come from dedicated flow steps, not this string grammar. See selectorForVisual().
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

/** A coordinate selector (tapAt). Always last-resort, non-portable, high risk. */
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
