// Sensitive-mode redaction. Two mechanisms:
//  1. isSecureNode → a field whose VALUE must never be shown (password/OTP/etc.).
//  2. makeRedactor → scrub known secret values (things typed into secure fields) from any
//     string we emit (snapshots, inspect, report, dump-xml artifacts, logs).

import type { RawNode } from '../snapshot/parse.js';

const SECRET_RE = /password|passwd|otp|one.?time|pin\b|cvv|card.?number|secret|token|security.?code/i;

export function isSecureNode(n: Pick<RawNode, 'id' | 'desc' | 'attrs'>): boolean {
  return n.attrs?.password === 'true' || SECRET_RE.test(n.id) || SECRET_RE.test(n.desc);
}

export type Redactor = ((s?: string) => string | undefined) & {
  /** Number of registered secret values too short (< TOKEN_REDACTION_MIN chars) to be matched
   * safely; they are NOT redacted. Callers should surface a warning when this is > 0. */
  skippedShortSecrets?: number;
};

export const REDACTED = '«redacted»';

/** Values of at least this length are scrubbed as plain SUBSTRINGS (catches a password embedded
 * in a URL, argv or JSON blob). Floor: anything shorter matches ordinary text everywhere. */
export const SUBSTRING_REDACTION_MIN = 4;
/** Digit-only values shorter than this (PINs, OTPs, CVVs) are scrubbed as whole TOKENS instead:
 * a 4-digit PIN "2026" must not blank the year inside "20260928" or a build number. */
export const NUMERIC_TOKEN_MAX = 8;
/** Values shorter than this are never matched at all: a 1–2 char secret ("7", "ab") would blank
 * step numbers, element refs ("@e7"), versions ("1.7.0") and ordinary words. They are reported
 * via `Redactor.skippedShortSecrets` so the caller can warn that redaction was not applied. */
export const TOKEN_REDACTION_MIN = 3;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Encoded spellings a secret can take once it has been serialized into an artifact/report
 * (XML/HTML entities, JSON string escaping). Redacting only the raw form lets `P@ss&w0rd`
 * survive as `P@ss&amp;w0rd` in JUnit/SARIF output. */
function encodedVariants(sec: string): string[] {
  const xml = sec.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const xmlNum = xml.replace(/&apos;/g, '&#39;');
  const json = JSON.stringify(sec).slice(1, -1);
  return [...new Set([xml, xmlNum, json])].filter((v) => v !== sec);
}

type Matcher = { kind: 'substring'; value: string } | { kind: 'token'; re: RegExp };

/**
 * Build a redactor for SECRET values (everything registered in `session.secrets` is a value
 * captured from a secure field — password / PIN / OTP / CVV — or a secret flow variable).
 * Matching rule by value:
 *  - < TOKEN_REDACTION_MIN chars: NOT matched (would corrupt ordinary text); counted in
 *    `skippedShortSecrets` so callers can warn;
 *  - substring: values with ≥ SUBSTRING_REDACTION_MIN chars that are not short digit runs —
 *    every occurrence is scrubbed, even inside a longer token (passwords, API tokens);
 *  - token: 3-char values and digit-only values shorter than NUMERIC_TOKEN_MAX (PINs/OTPs/CVVs)
 *    — scrubbed only where they stand alone: the value must not touch a letter or digit, and a
 *    digit value must not be part of a dotted number ("CVV 123", "cvv=123", "is 123." redact;
 *    "12345", "@e123", "v1.123.0", "20260928" do not).
 * Encoded variants (XML entities, JSON escaping) of each secret are scrubbed too.
 * NOTE: redacting serialized JSON/XML as TEXT can still hit numeric values/attributes — for
 * structured artifacts use `redactStructuredText`.
 */
export function makeRedactor(secrets: Iterable<string>): Redactor {
  const all = [...new Set([...secrets].filter((x) => typeof x === 'string' && x.length > 0))];
  const values = all.filter((v) => v.length >= TOKEN_REDACTION_MIN);
  const skippedShortSecrets = all.length - values.length;
  const expanded = [...new Set(values.flatMap((v) => [v, ...encodedVariants(v)]))].sort((a, b) => b.length - a.length);
  const matchers: Matcher[] = expanded.map((v) => {
    const digits = /^\d+$/.test(v);
    if (v.length >= SUBSTRING_REDACTION_MIN && !(digits && v.length < NUMERIC_TOKEN_MAX)) return { kind: 'substring', value: v };
    const before = digits ? '(?<![\\p{L}\\p{N}_@])(?<!\\p{N}\\.)' : '(?<![\\p{L}\\p{N}])';
    const after = digits ? '(?![\\p{L}\\p{N}_])(?!\\.\\p{N})' : '(?![\\p{L}\\p{N}])';
    return { kind: 'token', re: new RegExp(`${before}${escapeRe(v)}${after}`, 'gu') };
  });
  const redactor: Redactor = (s?: string) => {
    if (!s || matchers.length === 0) return s;
    let out = s;
    for (const m of matchers) {
      if (m.kind === 'substring') {
        if (out.includes(m.value)) out = out.split(m.value).join(REDACTED);
      } else {
        out = out.replace(m.re, REDACTED);
      }
    }
    return out;
  };
  redactor.skippedShortSecrets = skippedShortSecrets;
  return redactor;
}

/** Attribute / key names that carry geometry or indices, never user-typed content. A 4-digit
 * PIN must not blank `bounds="[0,4821][1080,2400]"`. */
const NON_CONTENT_KEYS = new Set(['bounds', 'x', 'y', 'width', 'height', 'index', 'instance', 'rect', 'frame']);

/** Redact serialized XML without touching markup: only attribute values, text nodes, CDATA
 * sections and comments. */
export function redactXmlText(xml: string, redact: Redactor): string {
  const r = (t: string): string => redact(t) ?? t;
  const sections = xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, t: string) => `<![CDATA[${r(t)}]]>`)
    .replace(/<!--([\s\S]*?)-->/g, (_m, t: string) => `<!--${r(t)}-->`);
  const attr = sections.replace(/([\w:.-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g, (m, name: string, eq: string, dq?: string, sq?: string) => {
    if (NON_CONTENT_KEYS.has(name.toLowerCase())) return m;
    const q = dq !== undefined ? '"' : "'";
    const val = dq ?? sq ?? '';
    return `${name}${eq}${q}${redact(val) ?? val}${q}`;
  });
  return attr.replace(/>([^<]+)</g, (_m, text: string) => `>${redact(text) ?? text}<`);
}

/** Redact a parsed JSON value structurally: string values and keys go through the redactor,
 * numbers/booleans/null are never touched. A key that collides after redaction is suffixed
 * (`«redacted»#2`) instead of silently dropping an entry. */
export function redactJsonValue(value: unknown, redact: Redactor): unknown {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key && NON_CONTENT_KEYS.has(key.toLowerCase()) ? v : (redact(v) ?? v);
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[uniqueKey(out, redact(k) ?? k)] = walk(x, k);
    return out;
  };
  return walk(value);
}

/** `key`, or `key#2`, `key#3`… — the first spelling not already present in `obj`. */
export function uniqueKey(obj: Record<string, unknown>, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return key;
  let i = 2;
  while (Object.prototype.hasOwnProperty.call(obj, `${key}#${i}`)) i++;
  return `${key}#${i}`;
}

export type StructuredKind = 'json' | 'xml' | 'text';

/** Classify an artifact for redaction by mime (and file name as a fallback). */
export function structuredKindOf(mime: string, name = ''): StructuredKind {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m === 'application/json' || m.endsWith('+json') || /\.json$/i.test(name)) return 'json';
  if (m === 'application/xml' || m === 'text/xml' || m.endsWith('+xml') || /\.xml$/i.test(name)) return 'xml';
  return 'text';
}

/**
 * Redact a serialized artifact without corrupting its structure:
 *  - JSON: parse → redact string values/keys → re-stringify (indentation preserved); numeric
 *    values are never rewritten, so `{"actions":123}` stays valid with a CVV "123" registered.
 *    Falls back to text redaction only when the content does not parse (e.g. NDJSON);
 *  - XML: only attribute values (minus geometry attributes) and text nodes;
 *  - anything else: plain text redaction.
 */
export function redactStructuredText(text: string, kind: StructuredKind, redact: Redactor): string {
  if (kind === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return redact(text) ?? text;
    }
    const indentMatch = /^[[{]\r?\n([ \t]+)/.exec(text);
    const indent = indentMatch ? indentMatch[1] : undefined;
    const out = JSON.stringify(redactJsonValue(parsed, redact), null, indent);
    return /\n$/.test(text) ? `${out}\n` : out;
  }
  if (kind === 'xml') return redactXmlText(text, redact);
  return redact(text) ?? text;
}

/**
 * Deep-redact any JSON-like value: every string (object values, array items, nested) goes through the redactor; structure, numbers and booleans are preserved. Use it on a
 * whole report/export payload BEFORE serializing it, so escaping can never hide a secret from
 * the redactor. Accepts a secret list or a prebuilt Redactor. Cycles are left as-is.
 */
export function redactDeep<T>(value: T, secretsOrRedactor: Iterable<string> | Redactor): T {
  const redact = typeof secretsOrRedactor === 'function' ? secretsOrRedactor : makeRedactor(secretsOrRedactor);
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v) ?? v;
    if (!v || typeof v !== 'object') return v;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    if (Buffer.isBuffer(v) || v instanceof Date || v instanceof Map || v instanceof Set) return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value) as T;
}
