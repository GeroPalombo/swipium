// SWIPIUM-REQ-02 — first-screen / runtime-screen classifier.
//
// classifyCurrentScreen() decides what a screen IS (login, create-account, onboarding, paywall,
// permissions, home, …) from BOTH the runtime UI snapshot and any static app-map/code context.
// PURE: it takes an already-observed snapshot (elements + visible text + foreground + auth state)
// so the driver loop in firstRunRunner.ts is the only side-effecting part. Output carries a
// confidence and the evidence behind it so callers can validate against code / the app map and so
// the classification can be stored with provenance.

import type { SnapshotElement } from '../drivers/Driver.js';
import { classifyRisk } from '../explore/policy.js';
import type {
  ScreenClassification,
  ScreenPurpose,
  InputRequirement,
  FieldKind,
  PlannedAction,
  MapLink,
} from './types.js';

export interface StaticScreenCandidate {
  id: string;
  purpose?: ScreenPurpose;
  /** Match hints — text/route names the static screen is known by. */
  hints?: string[];
}

export interface ScreenObservation {
  elements: SnapshotElement[];
  /** Joined visible text (text + content-desc). Provided so callers can pre-filter / OCR-augment. */
  visibleText?: string;
  foreground: string;
  screenshotUri?: string;
  authState?: string; // e.g. 'auth_required' | 'authenticated'
  screenSignature?: string;
  staticCandidates?: StaticScreenCandidate[];
  /** Native error signals (redbox / ANR / crash dialog) the observer already detected. */
  nativeError?: boolean;
  appError?: boolean;
}

const FIELD_RULES: Array<{ field: FieldKind; re: RegExp }> = [
  { field: 'confirm_password', re: /\b(confirm|repeat|re-?enter)\s*pass/i },
  { field: 'password', re: /\b(pass(word)?|secret|pwd)\b/i },
  { field: 'username', re: /\b(user\s?name|handle|nickname|display\s*handle)\b/i },
  { field: 'email', re: /\b(e-?mail|login|account)\b/i },
  { field: 'otp', re: /\b(otp|code|2fa|mfa|verification|verify)\b/i },
  { field: 'first_name', re: /\b(first\s*name|given\s*name)\b/i },
  { field: 'last_name', re: /\b(last\s*name|family\s*name|surname)\b/i },
  { field: 'name', re: /\b(full\s*name|display\s*name|your\s*name|name)\b/i },
  { field: 'phone', re: /\b(phone|mobile|tel)\b/i },
  { field: 'date_of_birth', re: /\b(birth|dob|birthday)\b/i },
  { field: 'city', re: /\bcity\b/i },
  { field: 'address', re: /\b(address|street)\b/i },
  { field: 'search', re: /\b(search|query|find|filter)\b/i },
];

/** Classify a field kind from its visible hints (label / id / text) and secure flag. */
export function fieldKindFromHints(label?: string, id?: string, text?: string, secure?: boolean): FieldKind {
  const hay = `${label ?? ''} ${id ?? ''} ${text ?? ''}`.trim();
  if (secure) {
    return /\b(confirm|repeat|re-?enter)\b/i.test(hay) ? 'confirm_password' : 'password';
  }
  for (const rule of FIELD_RULES) {
    if (rule.re.test(hay)) return rule.field;
  }
  return 'generic';
}

function classifyField(el: SnapshotElement): FieldKind {
  return fieldKindFromHints(el.label, el.id, el.text, el.secure);
}

function isEditable(el: SnapshotElement): boolean {
  return el.role === 'text-field' || /EditText|TextField|TextInput/i.test(el.role) || el.secure === true;
}

/** Build the typed input requirements from the editable fields on the screen. */
export function requiredInputsFor(elements: SnapshotElement[]): InputRequirement[] {
  return elements.filter(isEditable).map((el) => {
    const field = classifyField(el);
    const strategy = el.id ? 'id' : el.label ? 'accessibility' : el.text ? 'text' : 'coordinate';
    const value = el.id ?? el.label ?? el.text;
    return {
      ref: el.ref,
      field,
      label: el.label ?? el.text,
      secure: el.secure === true || field === 'password' || field === 'confirm_password',
      required: true,
      locator: { strategy, value },
      bounds: el.bounds,
    };
  });
}

function visibleTextOf(obs: ScreenObservation): string {
  if (obs.visibleText) return obs.visibleText;
  return obs.elements.map((e) => `${e.text ?? ''} ${e.label ?? ''}`).join(' ').trim();
}

interface Signal {
  re: RegExp;
  weight: number;
  label: string;
}

// Lexical signals per purpose. Confidence is the summed weight of matched signals, squashed to 0..1.
const LOGIN = /\b(sign\s?in|log\s?in)\b/i;
const REGISTER = /\b(sign\s?up|create\s+(an?\s+|your\s+)?account|register|join now|join free|get\s+started\s+free)\b/i;
const CREDENTIAL_SETUP = /\b(create\s+(a\s+)?password|set\s+(a\s+|your\s+)?password|choose\s+(a\s+)?password|create\s+(a\s+)?username|choose\s+(a\s+)?username|set\s+up\s+(your\s+)?(login|credentials?)|credential\s+setup)\b/i;
const OTP = /\b(verification code|one-?time|enter the code|otp|magic link|we sent|6-digit|verify your (email|phone|number))\b/i;
const ONBOARDING = /\b(get started|next|skip|continue|welcome|let'?s go|swipe|tour|set up your)\b/i;
const PAYWALL = /\b(subscribe|free trial|start trial|restore purchase|upgrade|premium|unlock|per month|per year|\/mo\b|\$\d|monthly|annually|billed)\b/i;
const PERMISSION = /\b(allow|don'?t allow|while using the app|location|camera|microphone|notifications?|photos|contacts|bluetooth)\b/i;
const HOME = /\b(home|feed|dashboard|explore|search|profile|settings|library|inbox|for you)\b/i;
const SETTINGS = /\b(settings|preferences|account settings|privacy|notifications)\b/i;
const ERROR = /\b(something went wrong|unfortunately|has stopped|isn'?t responding|render error|unhandled|red\s?box|try again later)\b/i;

/**
 * Classify the current screen. Combines field structure (password + email → auth) with lexical
 * signals and any static app-map candidate matches.
 */
export function classifyCurrentScreen(obs: ScreenObservation): ScreenClassification {
  const text = visibleTextOf(obs);
  const requiredInputs = requiredInputsFor(obs.elements);
  const hasPassword = requiredInputs.some((i) => i.field === 'password' || i.field === 'confirm_password');
  const hasConfirmPassword = requiredInputs.some((i) => i.field === 'confirm_password');
  const hasEmail = requiredInputs.some((i) => i.field === 'email');
  const hasOtpField = requiredInputs.some((i) => i.field === 'otp');
  const evidence: string[] = [];
  const blockedReasons: string[] = [];

  const hasLogin = LOGIN.test(text);
  const hasRegister = REGISTER.test(text);
  const hasUsername = requiredInputs.some((i) => i.field === 'username');
  const hasCredentialSetupCopy = CREDENTIAL_SETUP.test(text);

  // Scored candidates → pick the strongest.
  const scores: Partial<Record<ScreenPurpose, number>> = {};
  const note = (p: ScreenPurpose, w: number, why: string) => {
    scores[p] = (scores[p] ?? 0) + w;
    evidence.push(`${p}: ${why}`);
  };

  // Hard error first.
  if (obs.nativeError) { note('error', 5, 'native error/ANR/crash dialog'); }
  if (obs.appError || ERROR.test(text)) note('error', 3, 'error/redbox copy on screen');

  // Auth family.
  if (hasOtpField || OTP.test(text)) note('otp_or_email_verification', 3, hasOtpField ? 'OTP/code field present' : 'verification/one-time-code copy');
  // Credential-setup step: "create/set/choose password|username" copy, or a password (+confirm)
  // and/or username field with no email and no sign-in verb — a dedicated credential-creation step
  // inside a multi-step signup. Detected BEFORE the email+password auth branch so it wins when the
  // copy is explicit.
  const credentialSetupByFields = (hasPassword || hasUsername) && !hasEmail && !hasLogin;
  if (hasCredentialSetupCopy) note('credential_setup', 3.5, 'create/set/choose password or username copy');
  else if (credentialSetupByFields && (hasConfirmPassword || hasUsername || hasRegister)) {
    note('credential_setup', 2.5, 'password/username setup fields without email or sign-in verb');
  }
  if (hasPassword && hasEmail) {
    if (hasRegister && hasLogin) note('login_or_create_account', 3, 'both sign-in and sign-up choices present');
    else if (hasConfirmPassword || hasRegister) note('create_account', 3, 'register/create copy with email+password (confirm field)');
    else if (hasLogin) note('login', 3, 'sign-in copy with email+password');
    else note('login', 1.5, 'email+password fields without explicit verb');
  } else if (hasPassword) {
    note(hasRegister ? 'create_account' : 'login', 1.5, 'password field present');
  } else {
    if (hasLogin) note('login', 1, 'sign-in copy (no detected password field yet)');
    if (hasRegister) note('create_account', 1, 'register/create-account copy');
  }

  // Other gates.
  if (PAYWALL.test(text)) note('paywall', 3, 'subscribe/trial/restore/price copy');
  if (PERMISSION.test(text) && /\b(allow|don'?t allow|while using)\b/i.test(text)) note('permissions_prompt', 2.5, 'permission dialog copy');
  if (ONBOARDING.test(text) && !hasPassword) note('onboarding', 2, 'onboarding/get-started/next/skip copy');
  if (SETTINGS.test(text)) note('settings', 1, 'settings/preferences copy');
  if (HOME.test(text) && !hasPassword && !PAYWALL.test(text)) note('home', 1.5, 'home/feed/dashboard/tabs with no blocking gate');

  // Static app-map candidates corroborate a purpose.
  const mapLinks: MapLink[] = [];
  for (const cand of obs.staticCandidates ?? []) {
    const matched = (cand.hints ?? []).some((h) => text.toLowerCase().includes(h.toLowerCase()));
    if (cand.purpose && (matched || (obs.staticCandidates ?? []).length === 1)) {
      note(cand.purpose, matched ? 1.5 : 0.5, `app-map static screen "${cand.id}" suggests ${cand.purpose}`);
      mapLinks.push({ kind: 'staticScreen', id: cand.id, confidence: matched ? 0.6 : 0.3 });
    }
  }

  const ranked = (Object.entries(scores) as Array<[ScreenPurpose, number]>).sort((a, b) => b[1] - a[1]);
  const [purpose, topScore] = ranked[0] ?? (['unknown', 0] as [ScreenPurpose, number]);
  const total = ranked.reduce((s, [, w]) => s + w, 0) || 1;
  // Confidence blends the absolute evidence weight and its dominance over the runner-up.
  const dominance = ranked.length > 1 ? topScore / total : 1;
  const confidence = topScore === 0 ? 0.2 : Math.min(0.98, 0.35 + Math.min(topScore, 5) * 0.1) * (0.6 + 0.4 * dominance);

  if (purpose === 'unknown' || topScore === 0) {
    blockedReasons.push('no decisive structural or lexical signal — screen purpose is unknown');
  }

  // Safe actions: navigation/forward controls that are non-destructive (for onboarding/permission).
  const safeActions: PlannedAction[] = [];
  for (const el of obs.elements) {
    if (!el.clickable) continue;
    const label = el.label ?? el.text;
    const risk = classifyRisk({ label, id: el.id, role: el.role });
    if (risk.risk === 'safe') {
      safeActions.push({
        type: 'tap',
        targetRef: el.ref,
        label,
        locator: { strategy: el.id ? 'id' : el.label ? 'accessibility' : 'text', value: el.id ?? el.label ?? el.text },
        bounds: el.bounds,
        reason: risk.reason,
        risk: 'safe',
      });
    }
  }

  const runtimeId = obs.screenSignature ? `runtime:${obs.screenSignature}` : `runtime:${obs.foreground}`;
  mapLinks.unshift({ kind: 'runtimeScreen', id: runtimeId, confidence });

  return {
    purpose: purpose ?? 'unknown',
    confidence: Number(confidence.toFixed(3)),
    evidence,
    requiredInputs,
    safeActions,
    blockedReasons,
    mapLinks,
  };
}

/** Convenience: the set of field kinds a classification needs filled (deduped, required first). */
export function neededFieldKinds(c: ScreenClassification): FieldKind[] {
  return [...new Set(c.requiredInputs.map((i) => i.field))];
}
