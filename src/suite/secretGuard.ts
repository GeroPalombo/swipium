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

import { makeRedactor, redactDeep, REDACTED, type Redactor } from '../lib/redact.js';
import type { RecordedAction } from '../session/store.js';

/** Registered secret values, de-duplicated and non-empty. */
function secretList(secrets: Iterable<string> | undefined): string[] {
  if (!secrets) return [];
  return [...new Set([...secrets].filter((s) => typeof s === 'string' && s.length > 0))];
}

/** True when `value` is, or contains, a registered secret (exact match for any length; substring /
 *  token match with the same rules as the session redactor). */
export function containsSecret(value: string | undefined, secrets: string[], redact: Redactor): boolean {
  if (!value) return false;
  if (secrets.includes(value)) return true;
  return (redact(value) ?? value) !== value;
}

const PLACEHOLDER_RE = /^\$\{[^}]+\}$/;

export interface SecretSafeResult {
  actions: RecordedAction[];
  /** Number of recorded actions that carried a registered secret literal and were rewritten. */
  converted: number;
}

/**
 * Return a COPY of `actions` in which no registered secret value survives:
 *  - a `type` step whose literal text equals/contains a secret becomes a secret step (text dropped so
 *    the generators allocate an env-var placeholder; exportability needs-human-data);
 *  - any other string field (selector, assertion, url, screen, provenance…) containing a secret is
 *    redacted to «redacted» (a selector that IS a secret is not a usable locator anyway).
 * Existing ${VAR} placeholders are kept. Input actions are never mutated.
 */
export function secretSafeActions(actions: RecordedAction[], secretsIn: Iterable<string> | undefined): SecretSafeResult {
  const secrets = secretList(secretsIn);
  if (!secrets.length) return { actions, converted: 0 };
  const redact = makeRedactor(secrets);
  let converted = 0;
  const out = actions.map((a) => {
    let changed = false;
    let next: RecordedAction = a;
    if (a.action === 'type' && a.text && !PLACEHOLDER_RE.test(a.text) && containsSecret(a.text, secrets, redact)) {
      next = { ...a, text: undefined, secret: true, exportability: 'needs-human-data' };
      changed = true;
    }
    // Scrub every other string (selector/assertion/url/screen/provenance…). Exact-equal short secrets
    // (below the redactor's minimum) are replaced too.
    const scrubbed = redactDeep(next, (s?: string) => (s && secrets.includes(s) ? REDACTED : redact(s)) as string);
    if (JSON.stringify(scrubbed) !== JSON.stringify(next)) {
      next = scrubbed;
      changed = true;
    }
    if (changed) converted++;
    return next;
  });
  return { actions: out, converted };
}

export interface SecretLeak {
  path: string;
  line: number;
}

/** Find registered secret values (raw or XML/JSON-encoded) in generated file contents, comments
 *  included. */
export function findSecretLeaks(files: Array<{ path: string; content: string }>, secretsIn: Iterable<string> | undefined): SecretLeak[] {
  const secrets = secretList(secretsIn);
  if (!secrets.length) return [];
  const redact = makeRedactor(secrets);
  const leaks: SecretLeak[] = [];
  for (const f of files) {
    const lines = f.content.split('\n');
    // Same matching rules as the session redactor (values < 3 chars are not matched: they would
    // flag ordinary step numbers/words; recorded actions are already rewritten on exact equality).
    lines.forEach((line, i) => {
      if ((redact(line) ?? line) !== line) leaks.push({ path: f.path, line: i + 1 });
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
): void {
  const leaks = findSecretLeaks(files, secrets);
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
