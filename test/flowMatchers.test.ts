// Flow matching helpers: secret-name detection for run-together names, and visible() with a query
// that is itself a full Android resource id.

import { describe, expect, it } from 'vitest';
import { isSecretVarName } from '../src/flows/schema.js';
import { visible } from '../src/flows/run.js';

describe('isSecretVarName: run-together credential names', () => {
  it.each([
    'SWIPIUM_TEST_VERIFICATIONCODE',
    'SECURITYCODE',
    'SWIPIUM_TEST_ONETIMECODE',
    'SWIPIUM_TEST_PINNUMBER',
    'SWIPIUM_TEST_AUTHKEY',
    'SWIPIUM_TEST_PASSWORD',
    'SWIPIUM_VERIFICATION_CODE',
  ])('%s is a secret', (name) => expect(isSecretVarName(name)).toBe(true));

  it.each(['SHIPPING', 'KEYWORD', 'BARCODE', 'SPINNER', 'SWIPIUM_TEST_EMAIL'])('%s is not a secret', (name) =>
    expect(isSecretVarName(name)).toBe(false),
  );
});

describe('visible() and full resource ids', () => {
  const tree = { allNodes: [{ text: '', desc: '', id: 'com.acme.checkout:id/pay' }] };
  it('a full resource id query matches that id', () => {
    expect(visible(tree, 'com.acme.checkout:id/pay')).toBe(true);
    expect(visible(tree, 'com.acme.checkout:id/cancel')).toBe(false);
  });
  it('a word from the package name alone does not match', () => {
    expect(visible(tree, 'checkout')).toBe(false);
    expect(visible(tree, 'pay')).toBe(true);
  });
});
