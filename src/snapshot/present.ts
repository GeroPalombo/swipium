// Present snapshot elements to the model with sensitive-mode applied:
//  - secure fields → value masked to «secure»
//  - any known secret value (typed into a secure field) → scrubbed everywhere
// Used by qa_snapshot and qa_act so neither leaks credentials.

import type { SnapshotElement } from '../drivers/Driver.js';
import { renderElements } from './parse.js';
import type { Redactor } from '../lib/redact.js';

export function presentElements(
  elements: SnapshotElement[],
  redact: Redactor,
): { elements: SnapshotElement[]; rendered: string } {
  const masked = elements.map((e) =>
    e.secure
      ? { ...e, label: e.label ? '«secure»' : undefined, text: e.text ? '«secure»' : undefined }
      : { ...e, label: redact(e.label), text: redact(e.text) },
  );
  return { elements: masked, rendered: renderElements(masked) };
}
