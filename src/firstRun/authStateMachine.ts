// SWIPIUM-REQ-02 — auth/create-account reasoning across screens. Given a classified auth screen and
// the per-field input plans, decide the intent (login vs. create-account) and assemble the ordered
// actions: fill every required field, then tap the matching submit control. PURE.

import type { SnapshotElement } from '../drivers/Driver.js';
import type { Session } from '../session/store.js';
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
  // Prefer a non-field clickable button matching the verb; exclude editable fields.
  const buttons = elements.filter((e) => e.clickable && !/EditText|TextField|TextInput|text-field/i.test(e.role));
  return (
    buttons.find((e) => re.test(`${e.label ?? ''} ${e.text ?? ''} ${e.id ?? ''}`)) ??
    buttons.find((e) => /\b(continue|next|done|submit)\b/i.test(`${e.label ?? ''} ${e.text ?? ''}`))
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

  // Only add the submit step if every required field could be filled (no outstanding NeedsInput).
  if (needsInput.length === 0) {
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
    intent === 'create_account'
      ? ['otp_or_email_verification', 'onboarding', 'permissions_prompt', 'paywall', 'home', 'feature']
      : ['onboarding', 'permissions_prompt', 'paywall', 'home', 'feature', 'otp_or_email_verification'];

  return { intent, actions, needsInput, blockedReasons, expectedNextPurposes };
}
