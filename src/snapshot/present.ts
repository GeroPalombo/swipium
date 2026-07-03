// Present snapshot elements to the model with sensitive-mode applied:
//  - secure fields → value masked to «secure»
//  - any known secret value (typed into a secure field) → scrubbed everywhere
//  - the list is capped at MAX_PRESENTED_ELEMENTS (context-blowup guard): when over the cap,
//    the most interaction-relevant elements (focused/clickable/fields/scrollables) are kept,
//    document order is preserved, and a trailing hint says how to see the rest.
// Used by qa_snapshot and qa_act so neither leaks credentials nor floods the context.

import type { SnapshotElement } from '../drivers/Driver.js';
import { renderElements } from './parse.js';
import type { Redactor } from '../lib/redact.js';

/** Max elements rendered/returned per snapshot (qa_snapshot / qa_act post-action observation). */
export const MAX_PRESENTED_ELEMENTS = 60;

/** Higher = more interaction-relevant; used only to choose WHICH elements survive the cap. */
function relevance(e: SnapshotElement): number {
  return (e.focused ? 4 : 0) + (e.clickable ? 2 : 0) + (e.role === 'text-field' || e.role === 'scrollable' ? 1 : 0);
}

export function presentElements(
  elements: SnapshotElement[],
  redact: Redactor,
  opts: { max?: number } = {},
): { elements: SnapshotElement[]; rendered: string; omitted: number } {
  const masked = elements.map((e) =>
    e.secure
      ? { ...e, label: e.label ? '«secure»' : undefined, text: e.text ? '«secure»' : undefined }
      : { ...e, label: redact(e.label), text: redact(e.text) },
  );
  const max = opts.max ?? MAX_PRESENTED_ELEMENTS;
  if (masked.length <= max) {
    return { elements: masked, rendered: renderElements(masked), omitted: 0 };
  }
  // Keep the top-N by interaction relevance, then restore document order so the list still
  // reads top-to-bottom like the screen.
  const kept = masked
    .map((e, i) => ({ e, i }))
    .sort((a, b) => relevance(b.e) - relevance(a.e) || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.e);
  const omitted = masked.length - kept.length;
  const rendered =
    renderElements(kept) +
    `\n…${omitted} more element(s) not shown — re-run qa_snapshot with { filter } (or qa_inspect a ref) to see them.`;
  return { elements: kept, rendered, omitted };
}
