import { describe, expect, it } from 'vitest';
import { makeRedactor } from '../src/lib/redact.js';

describe('redaction', () => {
  it('redacts registered secret values without changing unrelated text', () => {
    const redact = makeRedactor(new Set(['secret-token', 'hunter2']));
    expect(redact('token=secret-token password=hunter2 mode=test')).toBe('token=«redacted» password=«redacted» mode=test');
  });
});
