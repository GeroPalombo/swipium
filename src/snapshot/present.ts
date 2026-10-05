// Present snapshot elements to the model with sensitive-mode applied:
//  - secure fields > value masked to «secure»
//  - any known secret value (typed into a secure field) > scrubbed everywhere
//  - the list is capped at MAX_PRESENTED_ELEMENTS (context-blowup guard): when over the cap,
//    the most interaction-relevant elements (focused/clickable/fields/scrollables) are kept,
//    document order is preserved, and a trailing hint says how to see the rest.
// Used by qa_snapshot and qa_act so neither leaks credentials nor floods the context.
//
// Payload shape: Claude Code and Codex show the model structuredContent, not the text block, so the
// `elements` a tool returns are the same one-line @eN strings the text block renders
// (renderElementLine), not one JSON object per element (~60% smaller). responseMode "verbose"
// returns the full objects instead. Internal code never reads the encoded result: it reads
// session.lastSnapshot (raw nodes) or a fresh parseSnapshot.

import type { SnapshotElement } from '../drivers/Driver.js';
import { renderElementLine } from './parse.js';
import type { Redactor } from '../lib/redact.js';
import { currentResponseMode } from '../lib/result.js';

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
): {
  /** The masked (and capped) element objects. */
  elements: SnapshotElement[];
  /** One renderElementLine per element in `elements`. */
  lines: string[];
  /** What a tool puts under `elements` in its result: `lines`, or the objects in verbose mode. */
  payload: SnapshotElement[] | string[];
  /** The text-block rendering: `lines` plus a trailing "N more" hint when capped. */
  rendered: string;
  omitted: number;
} {
  // A secure node's VALUE is always masked. Its label (content-desc / accessibility label) is only
  // masked on input fields: on a "Show password" toggle or a "Password" caption the label is UI
  // copy, not the secret, and hiding it leaves the agent unable to find the control.
  const masked = elements.map((e) =>
    e.secure
      ? {
          ...e,
          label: e.role === 'text-field' ? (e.label ? '«secure»' : undefined) : redact(e.label),
          text: e.text ? '«secure»' : undefined,
        }
      : { ...e, label: redact(e.label), text: redact(e.text) },
  );
  const max = opts.max ?? MAX_PRESENTED_ELEMENTS;
  const verbose = currentResponseMode() === 'verbose';
  if (masked.length <= max) {
    const lines = masked.map(renderElementLine);
    return { elements: masked, lines, payload: verbose ? masked : lines, rendered: lines.join('\n'), omitted: 0 };
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
  const lines = kept.map(renderElementLine);
  const rendered =
    lines.join('\n') + `\n…${omitted} more element(s) not shown. Re-run qa_snapshot with { filter } (or qa_inspect a ref) to see them.`;
  return { elements: kept, lines, payload: verbose ? kept : lines, rendered, omitted };
}
