// Secure-node presentation: a secure node's VALUE is always masked, but its label is only masked
// on input fields — a "Show password" toggle must stay findable by its label (device smoke test).
import { describe, expect, it } from 'vitest';
import { presentElements } from '../src/snapshot/present.js';
import { makeRedactor } from '../src/lib/redact.js';
import type { SnapshotElement } from '../src/snapshot/parse.js';

const el = (over: Partial<SnapshotElement>): SnapshotElement =>
  ({ ref: '@e1', role: 'button', clickable: true, bounds: [0, 0, 10, 10], ...over }) as SnapshotElement;

describe('presentElements secure masking', () => {
  const redact = makeRedactor(['Zq7!sEcr3t#Pw']);

  it('keeps the label of a secure non-input control (password visibility toggle)', () => {
    const { elements } = presentElements([el({ secure: true, label: 'Show password', role: 'button' })], redact);
    expect(elements[0].label).toBe('Show password');
  });

  it('masks label and value of a secure input field', () => {
    const { elements } = presentElements([el({ secure: true, role: 'text-field', label: 'Password', text: 'Zq7!sEcr3t#Pw' })], redact);
    expect(elements[0].label).toBe('«secure»');
    expect(elements[0].text).toBe('«secure»');
  });

  it('still masks the value of a secure non-input node and redacts registered secrets in labels', () => {
    const { elements } = presentElements([el({ secure: true, role: 'text', label: 'pin Zq7!sEcr3t#Pw', text: '1234' })], redact);
    expect(elements[0].text).toBe('«secure»');
    expect(elements[0].label).not.toContain('Zq7!sEcr3t#Pw');
  });
});
