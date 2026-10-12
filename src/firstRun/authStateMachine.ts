// Auth/create-account reasoning across screens. Given a classified auth screen and
// the per-field input plans, decide the intent (login vs. create-account) and assemble the ordered
// actions: fill every required field, then tap the matching submit control. PURE.

import type { SnapshotElement } from '../drivers/Driver.js';
import type { Session } from '../session/store.js';
import { isThirdPartySignIn } from '../explore/policy.js';
import type { InputPlan } from './inputPlanner.js';
import type { ScreenClassification, PlannedAction, ScreenPurpose, InputRequirement } from './types.js';

export type AuthIntent = 'login' | 'create_account';

const SUBMIT_CREATE = /\b(sign\s?up|create\s+(an\s+)?account|register|join|get\s+started|continue|next|done|submit)\b/i;
const SUBMIT_LOGIN = /\b(sign\s?in|log\s?in|continue|next|done|submit)\b/i;

/** Does the session already carry user-provided credentials (so we log in rather than create one)? */
export function hasProvidedCredentials(session: Session): boolean {
  return session.inputs.some((i) => /EMAIL|PASSWORD/.test(i.varName)) || session.inputValues.has('SWIPIUM_TEST_EMAIL');
}

/** Choose login vs. create-account for the screen. */
export function chooseAuthIntent(purpose: ScreenPurpose, session: Session, generationAllowed: boolean): AuthIntent {
  if (purpose === 'login') return 'login';
  if (purpose === 'create_account') return 'create_account';
  // credential_setup is a dedicated password/username step inside a signup flow: it IS account
  // creation. Log in only when the user already supplied credentials to reuse; otherwise create.
  if (purpose === 'credential_setup') return hasProvidedCredentials(session) ? 'login' : 'create_account';
  // login_or_create_account (or ambiguous): prefer login when the user gave credentials, else create
  // a throwaway account when generation is allowed.
  if (hasProvidedCredentials(session)) return 'login';
  return generationAllowed ? 'create_account' : 'login';
}

function findSubmit(elements: SnapshotElement[], intent: AuthIntent): SnapshotElement | undefined {
  const re = intent === 'create_account' ? SUBMIT_CREATE : SUBMIT_LOGIN;
  // Prefer a non-field clickable button matching the verb; exclude editable fields. Never a
  // third-party / OS sign-in ("Sign up with Apple" opened the iOS Apple Account alert).
  const buttons = elements.filter(
    (e) =>
      e.clickable &&
      !/EditText|TextField|TextInput|text-field/i.test(e.role) &&
      !isThirdPartySignIn({ label: e.label ?? e.text, id: e.id }) &&
      !isThirdPartySignIn({ label: e.text, id: e.id }),
  );
  return (
    buttons.find((e) => re.test(`${e.label ?? ''} ${e.text ?? ''} ${e.id ?? ''}`)) ??
    buttons.find((e) => /\b(continue|next|done|submit)\b/i.test(`${e.label ?? ''} ${e.text ?? ''}`))
  );
}

const SIGN_IN_LINK_EXACT = /^\s*(sign\s?in|log\s?in)\s*[.!>]?\s*$/i;
const SIGN_IN_LINK = /\b(sign\s?in|log\s?in)\b/i;
const EMAIL_LINK = /\b(by|with|use|via)\s+(e-?mail)\b|^\s*e-?mail\s*$/i;

/**
 * On a sign-up / login chooser (no fields: "Sign up with Apple / Google / Or by email / Already have
 * an account? Sign In"), find the in-app control that opens the email sign-in form.
 * "Sign In" first, then "by email". Third-party / OS sign-in stays excluded. A link may be plain
 * text (an RN <Text onPress>), so non-clickable elements count too, after clickable ones.
 */
export function findSignInLink(elements: SnapshotElement[]): SnapshotElement | undefined {
  const text = (e: SnapshotElement) => (e.label || e.text || '').trim();
  const candidates = elements
    .filter(
      (e) =>
        !/EditText|TextField|TextInput|text-field/i.test(e.role) &&
        !isThirdPartySignIn({ label: e.label ?? e.text, id: e.id }) &&
        !isThirdPartySignIn({ label: e.text, id: e.id }) &&
        text(e).length > 0 &&
        text(e).length <= 60,
    )
    .sort((a, b) => Number(b.clickable) - Number(a.clickable));
  return (
    candidates.find((e) => SIGN_IN_LINK_EXACT.test(text(e))) ??
    candidates.find((e) => SIGN_IN_LINK.test(text(e))) ??
    candidates.find((e) => EMAIL_LINK.test(text(e)))
  );
}

export interface AuthPlanResult {
  intent: AuthIntent;
  actions: PlannedAction[];
  /** Field plans that bubbled up a NeedsInput (e.g. OTP, unsafe environment). */
  needsInput: Array<{ kind: string; reason: string }>;
  blockedReasons: string[];
  expectedNextPurposes: ScreenPurpose[];
}

/** Assemble the ordered auth actions. `planFor` maps a requirement to its already-computed InputPlan. */
export function planAuthActions(
  classification: ScreenClassification,
  elements: SnapshotElement[],
  intent: AuthIntent,
  planFor: (req: InputRequirement) => InputPlan,
): AuthPlanResult {
  const actions: PlannedAction[] = [];
  const needsInput: AuthPlanResult['needsInput'] = [];
  const blockedReasons: string[] = [];

  for (const req of classification.requiredInputs) {
    const plan = planFor(req);
    if (plan.decision === 'needs_input') {
      needsInput.push({ kind: plan.kind, reason: plan.reason });
      continue;
    }
    if (plan.decision === 'skip') {
      blockedReasons.push(plan.reason);
      continue;
    }
    actions.push({
      type: 'type',
      targetRef: req.ref,
      label: req.label,
      locator: req.locator,
      bounds: req.bounds,
      field: req.field,
      value: { varName: plan.varName, secret: plan.secret, source: plan.source, generator: plan.generator },
      reason: `fill ${req.field} via ${plan.source}`,
      risk: 'safe',
    });
  }

  // A chooser with no fields: open the in-app sign-in form instead of looking for a submit button.
  if (intent === 'login' && classification.requiredInputs.length === 0) {
    const link = findSignInLink(elements);
    if (link) {
      actions.push({
        type: 'tap',
        targetRef: link.ref,
        label: link.label ?? link.text,
        locator: { strategy: link.id ? 'id' : link.label ? 'accessibility' : 'text', value: link.id ?? link.label ?? link.text },
        bounds: link.bounds,
        reason: 'open the email sign-in form',
        risk: 'safe',
      });
    } else {
      blockedReasons.push('sign-up chooser: no email login form reached (no in-app "Sign In" or "by email" control found)');
    }
  } else if (needsInput.length === 0) {
    // Only add the submit step if every required field could be filled (no outstanding NeedsInput).
    const submit = findSubmit(elements, intent);
    if (submit) {
      actions.push({
        type: 'tap',
        targetRef: submit.ref,
        label: submit.label ?? submit.text,
        locator: { strategy: submit.id ? 'id' : submit.label ? 'accessibility' : 'text', value: submit.id ?? submit.label ?? submit.text },
        bounds: submit.bounds,
        reason: `submit the ${intent === 'create_account' ? 'account-creation' : 'login'} form`,
        risk: 'safe',
      });
    } else {
      blockedReasons.push(`no ${intent} submit control found on the screen`);
    }
  }

  const expectedNextPurposes: ScreenPurpose[] =
    intent === 'login' && classification.requiredInputs.length === 0
      ? ['login', 'login_or_create_account', 'home', 'feature']
      : intent === 'create_account'
        ? ['otp_or_email_verification', 'onboarding', 'permissions_prompt', 'paywall', 'home', 'feature']
        : ['onboarding', 'permissions_prompt', 'paywall', 'home', 'feature', 'otp_or_email_verification'];

  return { intent, actions, needsInput, blockedReasons, expectedNextPurposes };
}
