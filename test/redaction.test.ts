import { describe, expect, it } from 'vitest';
import { makeRedactor, redactDeep } from '../src/lib/redact.js';

describe('redaction', () => {
  it('redacts registered secret values without changing unrelated text', () => {
    const redact = makeRedactor(new Set(['secret-token', 'hunter2']));
    expect(redact('token=secret-token password=hunter2 mode=test')).toBe('token=«redacted» password=«redacted» mode=test');
  });

  // Review §4: secure-field values are ALWAYS redacted, whatever their length. Short values
  // (< 4 chars) match as whole tokens so "abc" does not blank "abcdef" / "status".
  it('redacts a short (3-char) secure value as a standalone token, not inside longer words', () => {
    const redact = makeRedactor(new Set(['abc', 'wxyz']));
    expect(redact('a=abc b=wxyz status=abcdef xabc')).toBe('a=«redacted» b=«redacted» status=abcdef xabc');
  });

  it('redacts a 3-digit CVV wherever it stands alone, but not inside longer numbers', () => {
    const redact = makeRedactor(['123']);
    expect(redact('CVV 123 entered; cvv=123; order #12345; build 1234')).toBe(
      'CVV «redacted» entered; cvv=«redacted»; order #12345; build 1234',
    );
    // A digit secret glued to letters is NOT matched: "@e123" element refs / "v1.123" must survive.
    expect(redact('code:CVV123 ref=@e123 v1.123.0')).toBe('code:CVV123 ref=@e123 v1.123.0');
  });

  it('a 4-digit PIN (2026) is redacted as a token but does not blank years inside longer digit runs', () => {
    const redact = makeRedactor(['2026']);
    expect(redact('pin=2026')).toBe('pin=«redacted»');
    expect(redact('ts=20260928 build 120265 v2026')).toBe('ts=20260928 build 120265 v2026');
  });

  it('long digit secrets (≥ 8 digits) and ordinary passwords still match as substrings', () => {
    const redact = makeRedactor(['12345678', 'p4ss']);
    expect(redact('acct=x12345678y pw=xp4ssx')).toBe('acct=x«redacted»y pw=x«redacted»x');
  });

  it('redacts XML/JSON-escaped spellings of a secret (escaping cannot hide it)', () => {
    const redact = makeRedactor(['P@ss&w0rd"x']);
    expect(redact('<failure message="P@ss&amp;w0rd&quot;x"/>')).toBe('<failure message="«redacted»"/>');
    expect(redact(JSON.stringify({ pw: 'P@ss&w0rd"x' }))).toBe('{"pw":"«redacted»"}');
  });

  it('treats regex metacharacters in short secrets literally', () => {
    const redact = makeRedactor(['a.c', '*+?']);
    expect(redact('abc a.c *+? *')).toBe('abc «redacted» «redacted» *');
  });

  it('replaces longer secrets first so a substring secret never leaves partial leftovers', () => {
    const redact = makeRedactor(['hunter2', 'hunter2-extended']);
    expect(redact('a=hunter2-extended b=hunter2')).toBe('a=«redacted» b=«redacted»');
  });

  it('redactDeep scrubs every nested string and keeps structure/non-strings intact', () => {
    const input = { steps: ['type hunter2', { detail: 'otp 123 ok' }], n: 123, ok: true, nested: { x: null } };
    const out = redactDeep(input, ['hunter2', '123']);
    expect(out).toEqual({ steps: ['type «redacted»', { detail: 'otp «redacted» ok' }], n: 123, ok: true, nested: { x: null } });
    expect(input.steps[0]).toBe('type hunter2'); // not mutated
    expect(redactDeep('pw hunter2', makeRedactor(['hunter2']))).toBe('pw «redacted»');
  });
});
