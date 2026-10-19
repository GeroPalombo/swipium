// Paywall detection: a price ("Pro $9.99", "4,99 €", "$9.99/mo") or an offer (subscribe, free
// trial, restore purchases) classifies a paywall; "Go Premium" / "Upgrade" / "Unlock" alone on a
// freemium home does not. The paywall close glyphs (✕ ×) are recognised as a safe dismiss.

import { describe, expect, it } from 'vitest';
import { classifyCurrentScreen, hasPaywallCopy } from '../src/firstRun/classifyScreen.js';
import { planPaywall } from '../src/firstRun/paywallPolicy.js';
import type { SnapshotElement } from '../src/drivers/Driver.js';

const el = (ref: string, label: string, y: number): SnapshotElement => ({
  ref,
  role: 'Button',
  label,
  bounds: [40, y, 1040, y + 80],
  clickable: true,
});
const purposeOf = (visibleText: string) => classifyCurrentScreen({ elements: [], visibleText, foreground: 'com.example.app' }).purpose;

describe('hasPaywallCopy', () => {
  it.each([
    'Pro $9.99',
    'Go Pro for $4.99',
    'Premium 4,99 €',
    'Only 9.99 USD',
    'Plus 9.99/mo',
    'Start your free trial',
    'Subscribe now',
    'Restore purchases',
    'Billed annually',
  ])('paywall: %s', (t) => expect(hasPaywallCopy(t)).toBe(true));
  it.each(['Go Premium', 'Upgrade', 'Unlock all features', 'Monthly summary', 'Home  Feed  Go Premium', 'Version 2.3'])(
    'not a paywall alone: %s',
    (t) => expect(hasPaywallCopy(t)).toBe(false),
  );
});

describe('classifyCurrentScreen', () => {
  it('a freemium home with a "Go Premium" upsell is home, not paywall', () => {
    expect(purposeOf('Home  Feed  Profile  Go Premium')).toBe('home');
  });
  it('a priced plan screen is a paywall', () => {
    expect(purposeOf('Unlock Premium  Pro $9.99  Continue')).toBe('paywall');
  });
});

describe('planPaywall close glyphs', () => {
  it.each(['✕', '×'])('%s is a safe close', (glyph) => {
    const d = planPaywall([el('e1', 'Subscribe', 900), el('e2', glyph, 100)]);
    expect(d.stop).toBe(false);
    expect(d.action?.targetRef).toBe('e2');
  });
  it('a purchase button is never the action', () => {
    const d = planPaywall([el('e1', 'Subscribe', 900)]);
    expect(d.stop).toBe(true);
    expect(d.action).toBeUndefined();
  });
});
