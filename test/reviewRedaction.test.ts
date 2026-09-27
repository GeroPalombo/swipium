// Review round 2: short secrets must never corrupt JSON/XML artifacts or ordinary text.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRedactor, redactStructuredText, redactXmlText, structuredKindOf, REDACTED } from '../src/lib/redact.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-review-redact-home-'));
process.env.HOME = fakeHome;
const { SessionStore } = await import('../src/session/store.js');
const root = mkdtempSync(join(tmpdir(), 'swipium-review-redact-project-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('short-secret floor and digit boundaries', () => {
  it('never matches 1–2 char secrets and reports them as skipped', () => {
    const r = makeRedactor(['7', 'ab']);
    const text = 'Step 7 of 12: tap @e7; 7 issues; build 1.7.0; ab test';
    expect(r(text)).toBe(text);
    expect(r.skippedShortSecrets).toBe(2);
    expect(makeRedactor(['hunter22']).skippedShortSecrets).toBe(0);
  });

  it('keeps a 3-digit CVV redacted in plain text but not inside refs/versions/numbers', () => {
    const r = makeRedactor(['123']);
    expect(r('cvv 123')).toBe(`cvv ${REDACTED}`);
    expect(r('your cvv is 123.')).toBe(`your cvv is ${REDACTED}.`);
    expect(r('ref @e123 v1.123.0 1234 123.5')).toBe('ref @e123 v1.123.0 1234 123.5');
  });
});

describe('structural redaction', () => {
  it('JSON: numeric values are never rewritten; strings and keys are; output stays valid', () => {
    const r = makeRedactor(['123', 'hunter22']);
    const src =
      JSON.stringify({ counters: { actions: 123 }, steps: [{ durationMs: 123, note: 'cvv 123' }], hunter22: 'pw hunter22' }, null, 2) +
      '\n';
    const out = redactStructuredText(src, 'json', r);
    const parsed = JSON.parse(out);
    expect(parsed.counters.actions).toBe(123);
    expect(parsed.steps[0]).toEqual({ durationMs: 123, note: `cvv ${REDACTED}` });
    expect(parsed[REDACTED]).toBe(`pw ${REDACTED}`);
    expect(out.endsWith('}\n')).toBe(true);
    expect(out).toContain('\n  "counters"'); // indentation preserved
  });

  it('JSON: key collisions after redaction are disambiguated, not dropped', () => {
    const out = JSON.parse(
      redactStructuredText(JSON.stringify({ hunter22: 1, 'hunter22 ': 2, [REDACTED]: 3 }), 'json', makeRedactor(['hunter22'])),
    );
    expect(Object.values(out).sort()).toEqual([1, 2, 3]);
    expect(Object.keys(out)).toContain(`${REDACTED}#2`);
  });

  it('JSON: falls back to text redaction when content does not parse', () => {
    expect(redactStructuredText('{"a":"hunter22"}\n{"b":1', 'json', makeRedactor(['hunter22']))).toBe(`{"a":"${REDACTED}"}\n{"b":1`);
  });

  it('XML: only attribute values / text nodes / CDATA; geometry attributes untouched', () => {
    const r = makeRedactor(['4821', "it's"]);
    const xml = `<node index="4821" bounds="[0,4821][1080,2400]" text="4821" desc='4821'>pin 4821<![CDATA[4821]]><x t="it&apos;s" u='it"s'/></node>`;
    expect(redactXmlText(xml, r)).toBe(
      `<node index="4821" bounds="[0,4821][1080,2400]" text="${REDACTED}" desc='${REDACTED}'>pin ${REDACTED}<![CDATA[${REDACTED}]]><x t="${REDACTED}" u='it"s'/></node>`,
    );
  });

  it('classifies by mime and file name', () => {
    expect(structuredKindOf('application/json', 'x')).toBe('json');
    expect(structuredKindOf('application/sarif+json')).toBe('json');
    expect(structuredKindOf('text/plain', 'report.json')).toBe('json');
    expect(structuredKindOf('application/xml')).toBe('xml');
    expect(structuredKindOf('text/plain', 'dump.txt')).toBe('text');
  });
});

describe('saveArtifact uses structural redaction and flags skipped short secrets', () => {
  it('a CVV "123" keeps {"actions":123} valid JSON', () => {
    const store = new SessionStore();
    const s = store.create(root);
    s.secrets.add('123');
    store.saveArtifact(s, 'report', 'r.json', JSON.stringify({ actions: 123, note: 'cvv 123' }), 'application/json');
    const rec = s.artifacts.at(-1)!;
    expect(JSON.parse(readFileSync(rec.path, 'utf8'))).toEqual({ actions: 123, note: `cvv ${REDACTED}` });
    expect(rec.redaction).toBe('applied');
  });

  it('a 1-char secret leaves text intact and marks redaction partial with a note', () => {
    const store = new SessionStore();
    const s = store.create(root);
    s.secrets.add('7');
    store.saveArtifact(s, 'logs', 'l.txt', 'Step 7 @e7 1.7.0', 'text/plain');
    const rec = s.artifacts.at(-1)!;
    expect(readFileSync(rec.path, 'utf8')).toBe('Step 7 @e7 1.7.0');
    expect(rec.redaction).toBe('partial');
    expect(rec.redactionNote).toMatch(/shorter than 3/);
  });
});
