// Defense in depth against secret leaks into GENERATED assets and persisted state.
//
// The recorder (qa_act) is supposed to mark a value typed into a secure field as `secret` and
// record a ${VAR} placeholder. But a registered secret (session.secrets) typed into a field the UI
// does NOT flag as secure is recorded as a plain literal — and every generator downstream (flow YAML,
// POM/suite, Appium JS/TS/Python, test cases, test-suite.json) would then write it in plaintext.
//
// This module is the emit-time backstop every generator and the session persister go through:
//   - secretSafeActions: rewrite recorded actions so any literal that EQUALS or CONTAINS a registered
//     secret becomes a secret step (placeholder var, needs-human-data) — never the raw value;
//   - findSecretLeaks / assertNoSecretLeaks: scan generated text for registered secret values
//     (raw + XML/JSON-encoded spellings) and FAIL generation loudly instead of writing a leak.

import { makeRedactor, REDACTED, TOKEN_REDACTION_MIN, type Redactor } from '../lib/redact.js';
import type { RecordedAction } from '../session/store.js';

/** Registered secret values, de-duplicated and non-empty. */
function secretList(secrets: Iterable<string> | undefined): string[] {
  if (!secrets) return [];
  return [...new Set([...secrets].filter((s) => typeof s === 'string' && s.length > 0))];
}

/** A "weak" (dictionary-like / short) secret — QA passwords such as "test", "admin", "demo",
 *  "password", "Login": letters only, or a short alphanumeric run. Substring-matching these would
 *  flag template text ("testID", "tests:") and structural identifiers (resource_id "password",
 *  screen "Login"), so they are matched as whole tokens / whole string literals only. Anything with
 *  a symbol, or a longer mixed alphanumeric value, stays a "strong" secret (substring-matched). */
export function isWeakSecret(value: string): boolean {
  if (!/^[\p{L}\p{N}_-]+$/u.test(value)) return false;
  return /^\p{L}+$/u.test(value) || value.length < 8;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Redactor used for recorded USER CONTENT (typed text, url, assertion prose): strong secrets are
 *  scrubbed as substrings (session-redactor rules); weak secrets only as whole tokens. */
function contentRedactor(secrets: string[]): Redactor {
  const strong = makeRedactor(secrets.filter((s) => !isWeakSecret(s)));
  const weak = secrets
    .filter((s) => isWeakSecret(s))
    .sort((a, b) => b.length - a.length)
    .map((s) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(s)}(?![\\p{L}\\p{N}_])`, 'gu'));
  const r: Redactor = (v?: string) => {
    if (!v) return v;
    let out = strong(v) ?? v;
    for (const re of weak) out = out.replace(re, REDACTED);
    return out;
  };
  return r;
}

/** True when `value` is, or contains, a registered secret (exact match for any length; substring /
 *  token match with the same rules as the session redactor). */
export function containsSecret(value: string | undefined, secrets: string[], redact: Redactor): boolean {
  if (!value) return false;
  if (secrets.includes(value)) return true;
  return (redact(value) ?? value) !== value;
}

const PLACEHOLDER_RE = /^\$\{[^}]+\}$/;

/** A user-provided session input (qa_continue_from_blocker / needs_input) bound to its flow
 *  variable. Values are in-memory only (Session.inputValues); never persisted. */
export interface InputBinding {
  varName: string;
  value: string;
  secret: boolean;
}

/** The session's stored inputs as bindings (varName → raw value, secret flag from metadata). */
export function inputBindings(session: {
  inputs?: Array<{ varName: string; secret: boolean }>;
  inputValues?: Map<string, string>;
}): InputBinding[] {
  const out: InputBinding[] = [];
  for (const [varName, value] of session.inputValues ?? new Map<string, string>()) {
    if (typeof value !== 'string' || !value) continue;
    const meta = session.inputs?.find((i) => i.varName === varName);
    out.push({ varName, value, secret: meta?.secret ?? false });
  }
  return out;
}

/** Recorded typed text that equals a stored session input value → that input's `${VAR}` placeholder
 *  (secret inputs AND non-secret ones such as SWIPIUM_TEST_EMAIL). Returns undefined otherwise. */
export function inputPlaceholderFor(text: string | undefined, inputs: InputBinding[] | undefined): InputBinding | undefined {
  if (!text || !inputs?.length || PLACEHOLDER_RE.test(text)) return undefined;
  return inputs.find((b) => b.value === text);
}

/** A flow-variable name the runner can resolve from the environment: SWIPIUM_-prefixed, [A-Za-z0-9_]. */
export function swipiumVarName(name: string): string {
  const n = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^SWIPIUM_/.test(n) ? n : `SWIPIUM_${n}`;
}

/** ONE naming rule for secret placeholders across every generator (flow YAML, POM/suite, Appium).
 *  Every emitted name is SWIPIUM_-prefixed — the flow runner resolves env vars ONLY for SWIPIUM_*
 *  names, so a generated flow replays from env in CI:
 *  reuse a meaningful ${VAR} already on the step (e.g. a stored input's SWIPIUM_TEST_PASSWORD; an
 *  unprefixed name gets the SWIPIUM_ prefix) — but rename a generic recorder placeholder (SECRET_N) —
 *  else name it from the field (password/otp/token/pin → SWIPIUM_TEST_*), else SWIPIUM_SECRET_N. */
export function secretVarName(a: { text?: string; selector?: string }, index: number): string {
  const existing = a.text?.match(/^\$\{([^}]+)\}$/);
  if (existing && !/^SECRET_\d+$/i.test(existing[1])) return swipiumVarName(existing[1]);
  const key = `${a.selector ?? ''}`.toLowerCase();
  if (/pass/.test(key)) return 'SWIPIUM_TEST_PASSWORD';
  if (/otp|code|2fa|mfa/.test(key)) return 'SWIPIUM_TEST_OTP';
  if (/token|api[_-]?key/.test(key)) return 'SWIPIUM_TEST_TOKEN';
  if (/pin/.test(key)) return 'SWIPIUM_TEST_PIN';
  return `SWIPIUM_SECRET_${index}`;
}

export interface SecretSafeResult {
  actions: RecordedAction[];
  /** Number of recorded actions that carried a registered secret literal and were rewritten. */
  converted: number;
}

/**
 * Return a COPY of `actions` in which no registered secret value survives in recorded USER CONTENT:
 *  - a `type` step whose literal text equals a stored session input becomes that input's ${VAR}
 *    (secret input → secret step; non-secret input such as an email stays a data placeholder);
 *  - a `type` step whose literal text equals/contains a secret becomes a secret step (text dropped so
 *    the generators allocate an env-var placeholder; exportability needs-human-data);
 *  - user-content prose (url, assertion, warning, OCR text) containing a secret is redacted.
 * Selector / screen / action / id fields are NEVER rewritten: a resource_id "password" or a screen
 * "Login" is a locator, not a leak, and rewriting it to «redacted» makes the step unreplayable (and
 * persisted state.json would carry the broken locator across a restart).
 * Existing ${VAR} placeholders are kept. Input actions are never mutated.
 */
export function secretSafeActions(
  actions: RecordedAction[],
  secretsIn: Iterable<string> | undefined,
  inputs?: InputBinding[],
): SecretSafeResult {
  const secrets = secretList(secretsIn);
  if (!secrets.length && !inputs?.length) return { actions, converted: 0 };
  const redact = contentRedactor(secrets);
  const scrub = (v?: string): string | undefined => (v ? (secrets.includes(v) ? REDACTED : (redact(v) ?? v)) : v);
  let converted = 0;
  const out = actions.map((a) => {
    let next: RecordedAction = a;
    if (a.action === 'type' && a.text && !PLACEHOLDER_RE.test(a.text)) {
      const bound = inputPlaceholderFor(a.text, inputs);
      if (bound) {
        const secret = bound.secret || containsSecret(a.text, secrets, redact);
        next = {
          ...a,
          text: `\${${swipiumVarName(bound.varName)}}`,
          ...(secret ? { secret: true, exportability: 'needs-human-data' as const } : {}),
        };
      } else if (secrets.length && containsSecret(a.text, secrets, redact)) {
        next = { ...a, text: undefined, secret: true, exportability: 'needs-human-data' };
      }
    }
    if (secrets.length) {
      const url = scrub(next.url);
      const assertion = scrub(next.assertion);
      const warning = scrub(next.warning);
      const ocr = next.provenance?.visual?.ocrText;
      const ocrScrubbed = scrub(ocr);
      if (url !== next.url || assertion !== next.assertion || warning !== next.warning || ocrScrubbed !== ocr) {
        next = { ...next, url, assertion, warning };
        if (ocrScrubbed !== ocr && next.provenance?.visual)
          next.provenance = { ...next.provenance, visual: { ...next.provenance.visual, ocrText: ocrScrubbed } };
        for (const k of ['url', 'assertion', 'warning'] as const) if (next[k] === undefined) delete next[k];
      }
    }
    if (next !== a) converted++;
    return next;
  });
  return { actions: converted ? out : actions, converted };
}

/** Structural identifiers of a recording (selectors, screen names/signatures, provenance ids): a
 *  weak secret equal to one of these is a LOCATOR in generated output, not a leaked value. */
export function structuralLiterals(actions: RecordedAction[] | undefined): string[] {
  const out = new Set<string>();
  for (const a of actions ?? []) {
    for (const v of [
      a.selector,
      a.screen,
      a.screenSig,
      a.provenance?.resourceId,
      a.provenance?.accessibilityLabel,
      a.provenance?.selectorValue,
      a.provenance?.text,
      a.provenance?.className,
      a.provenance?.originalScreenSignature,
    ])
      if (typeof v === 'string' && v) out.add(v);
  }
  return [...out];
}

/** Redactor for GENERATED structured output (test-suite.json cases…): strong secrets are scrubbed
 *  as substrings everywhere (session-redactor rules); a weak secret only when a WHOLE string value
 *  equals it and that value is not a structural identifier of the recording (selector/screen) —
 *  never inside template prose or locators. */
export function generatedOutputRedactor(secretsIn: Iterable<string> | undefined, structuralIn?: Iterable<string>): Redactor {
  const secrets = secretList(secretsIn);
  const strong = makeRedactor(secrets.filter((s) => !isWeakSecret(s)));
  const weak = new Set(secrets.filter((s) => isWeakSecret(s)));
  const structural = new Set(structuralIn ?? []);
  const r: Redactor = (v?: string) => {
    if (!v) return v;
    if (weak.has(v) && !structural.has(v)) return REDACTED;
    return strong(v) ?? v;
  };
  return r;
}

export interface SecretLeak {
  path: string;
  line: number;
}

export interface FindSecretLeaksOptions {
  /** Selector/screen strings from the recording (see structuralLiterals): a WEAK secret equal to one
   *  of them is a locator in the generated output and is not reported. */
  structural?: Iterable<string>;
}

/** Whole string-literal occurrence of `s` in VALUE position: "s" / 's' / `s` (not an object key
 *  `"s":`), or a bare YAML scalar value (`key: s`, `- s`). */
function weakLiteralRe(s: string): RegExp {
  const e = escapeRe(s);
  return new RegExp(`(["'\`])${e}\\1(?!\\s*:)|(?:^|:\\s|-\\s)\\s*${e}\\s*(?:#.*)?$`, 'u');
}

/** Find registered secret values in generated file contents, comments included.
 *  - strong secrets (symbols / long mixed values): raw or XML/JSON-encoded SUBSTRING, anywhere;
 *  - weak secrets (dictionary-like / short — isWeakSecret): only where the generated text carries
 *    the value as a whole string literal / scalar value (an emitted data literal), and not when that
 *    value is one of the recording's structural identifiers (a selector or screen name). Template
 *    text ("testID", "tests:", "tests/x.smoke.yaml") never matches. */
export function findSecretLeaks(
  files: Array<{ path: string; content: string }>,
  secretsIn: Iterable<string> | undefined,
  opts: FindSecretLeaksOptions = {},
): SecretLeak[] {
  const secrets = secretList(secretsIn);
  if (!secrets.length) return [];
  const structural = new Set(opts.structural ?? []);
  const redact = makeRedactor(secrets.filter((s) => !isWeakSecret(s)));
  const weak = secrets.filter((s) => isWeakSecret(s) && s.length >= TOKEN_REDACTION_MIN && !structural.has(s)).map(weakLiteralRe);
  const leaks: SecretLeak[] = [];
  for (const f of files) {
    const lines = f.content.split('\n');
    // Same matching rules as the session redactor (values < 3 chars are not matched: they would
    // flag ordinary step numbers/words; recorded actions are already rewritten on exact equality).
    lines.forEach((line, i) => {
      if ((redact(line) ?? line) !== line || weak.some((re) => re.test(line))) leaks.push({ path: f.path, line: i + 1 });
    });
  }
  return leaks;
}

/** Thrown when generated output would contain a registered secret value. Callers must NOT write. */
export class SecretLeakError extends Error {
  readonly code = 'SECRET_IN_GENERATED_OUTPUT';
  constructor(
    readonly leaks: SecretLeak[],
    where: string,
  ) {
    super(
      `${where}: refusing to write generated output — a registered secret value would be written in plaintext ` +
        `(${leaks
          .slice(0, 5)
          .map((l) => `${l.path}:${l.line}`)
          .join(', ')}${leaks.length > 5 ? `, +${leaks.length - 5} more` : ''})`,
    );
    this.name = 'SecretLeakError';
  }
}

/** Throw SecretLeakError when any file contains a registered secret value. */
export function assertNoSecretLeaks(
  files: Array<{ path: string; content: string }>,
  secrets: Iterable<string> | undefined,
  where: string,
  opts: FindSecretLeaksOptions = {},
): void {
  const leaks = findSecretLeaks(files, secrets, opts);
  if (leaks.length) throw new SecretLeakError(leaks, where);
}

/** Redact registered secret values from qa_note prose (workflow/reason/setup text) before notes feed
 *  generated test cases or persisted state. URIs and structured fields are left alone. */
export function secretSafeNotes<
  T extends { workflow: string; reason?: string; missingPrecondition?: string; requiredState?: string; recommendedSetup?: string },
>(notes: T[], secretsIn: Iterable<string> | undefined): T[] {
  const secrets = secretList(secretsIn);
  if (!secrets.length) return notes;
  const redact = makeRedactor(secrets);
  const r = (v?: string) => (v ? (redact(v) ?? v) : v);
  return notes.map((n) => ({
    ...n,
    workflow: r(n.workflow) ?? n.workflow,
    reason: r(n.reason),
    missingPrecondition: r(n.missingPrecondition),
    requiredState: r(n.requiredState),
    recommendedSetup: r(n.recommendedSetup),
  }));
}
