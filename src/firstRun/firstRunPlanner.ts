// SWIPIUM-REQ-02 — firstRunPlanner(): the per-screen brain of the first-run state machine. Given an
// observed screen, the session, the test-data policy, and the generated-account decision, it
// classifies the screen and returns a bounded, safe FirstRunPlan: the actions to take, the expected
// next screens, the stop conditions, and the app-map updates. PURE — no device access; the driver
// loop in firstRunRunner.ts executes the returned actions.

import type { SnapshotElement } from '../drivers/Driver.js';
import type { Session } from '../session/store.js';
import { classifyCurrentScreen, type ScreenObservation } from './classifyScreen.js';
import { planInputForField, type InputPlan, type InputPlanContext } from './inputPlanner.js';
import { chooseAuthIntent, planAuthActions, hasProvidedCredentials } from './authStateMachine.js';
import { planOnboardingStep } from './onboardingStateMachine.js';
import { planPaywall } from './paywallPolicy.js';
import type { GeneratedAccountDecision, TestDataPolicy } from './generatedDataPolicy.js';
import type { AppMapPatch, FirstRunPlan, ScreenClassification, PlannedAction } from './types.js';

export interface FirstRunPlanContext {
  policy: TestDataPolicy;
  decision: GeneratedAccountDecision;
  /** Deterministic generation for tests. */
  timestamp?: number;
  /** Previous screen signature, to record a transition into the app map. */
  fromSignature?: string;
}

// credential_setup ("Create Password" / "Choose a username") is a continuation of account creation,
// so it shares the auth/input planning path (fill generated credential fields, then submit).
const AUTH_PURPOSES = new Set(['login', 'create_account', 'login_or_create_account', 'credential_setup']);

function mapPatchFor(c: ScreenClassification, obs: ScreenObservation, fromSignature?: string): AppMapPatch {
  const runtimeLink = c.mapLinks.find((l) => l.kind === 'runtimeScreen');
  return {
    at: Date.now(),
    screenSignature: obs.screenSignature ?? obs.foreground,
    runtimeScreenId: runtimeLink?.id ?? `runtime:${obs.foreground}`,
    purpose: c.purpose,
    confidence: c.confidence,
    evidence: c.evidence,
    authState: obs.authState,
    links: c.mapLinks,
    ...(fromSignature ? { transition: { fromSignature, action: 'first_run_step', outcome: 'changed_screen' as const } } : {}),
  };
}

/** Plan the next bounded first-run step for the observed screen. */
export function planFirstRun(obs: ScreenObservation, session: Session, ctx: FirstRunPlanContext): FirstRunPlan {
  const classification = classifyCurrentScreen(obs);
  const mapUpdates = [mapPatchFor(classification, obs, ctx.fromSignature)];
  const elements: SnapshotElement[] = obs.elements;
  const base = { classification, mapUpdates };

  const inputCtx: InputPlanContext = { policy: ctx.policy, generationAllowed: ctx.decision.allowed, timestamp: ctx.timestamp };
  let genIndex = 0;
  const planFor = (req: Parameters<typeof planInputForField>[1]): InputPlan =>
    planInputForField(session, req, { ...inputCtx, index: genIndex++ });

  // --- error / native crash → stop ---
  if (classification.purpose === 'error') {
    return {
      ...base,
      state: 'blocked',
      actions: [],
      expectedNextPurposes: [],
      stopConditions: ['app or native error on screen'],
      reason: 'app/native error encountered — first-run halted',
      pathTaken: 'none',
      nextRecommendedTool: 'qa_report',
    };
  }

  // --- OTP / email verification → stop with NeedsInput ---
  if (classification.purpose === 'otp_or_email_verification') {
    return {
      ...base,
      state: 'needs_input',
      actions: [],
      expectedNextPurposes: ['home', 'onboarding'],
      stopConditions: ['verification step requires a real code'],
      reason: 'account creation reached an OTP/email-verification step',
      needsInput: { kind: 'otp_or_manual_verification', reason: 'a one-time code / verification is required to continue' },
      pathTaken: 'create_account',
      nextRecommendedTool: 'qa_continue_from_blocker',
    };
  }

  // --- auth / create-account / credential-setup ---
  if (AUTH_PURPOSES.has(classification.purpose)) {
    const intent = chooseAuthIntent(classification.purpose, session, ctx.decision.allowed);
    // Report a dedicated credential-setup screen under its own path (not generic create_account).
    const pathTaken = classification.purpose === 'credential_setup' ? 'credential_setup' : intent;
    // Refuse to auto-create an account when the environment isn't safe and the user gave no creds.
    if (intent === 'create_account' && !ctx.decision.allowed) {
      return {
        ...base,
        state: 'unsafe',
        actions: [],
        expectedNextPurposes: [],
        stopConditions: ['unsafe environment for generated account creation'],
        reason: ctx.decision.reason,
        needsInput: { kind: 'credentials', reason: `${ctx.decision.reason}. Provide test credentials, or confirm this is a disposable test/staging environment.` },
        pathTaken,
        nextRecommendedTool: 'qa_continue_from_blocker',
      };
    }
    const auth = planAuthActions(classification, elements, intent, planFor);
    if (auth.needsInput.length > 0) {
      const first = auth.needsInput[0];
      return {
        ...base,
        state: 'needs_input',
        actions: [],
        expectedNextPurposes: auth.expectedNextPurposes,
        stopConditions: ['a required field has no safe value'],
        reason: first.reason,
        needsInput: { kind: first.kind, reason: first.reason },
        pathTaken,
        nextRecommendedTool: 'qa_continue_from_blocker',
      };
    }
    if (auth.actions.length === 0) {
      return {
        ...base,
        state: 'blocked',
        actions: [],
        expectedNextPurposes: auth.expectedNextPurposes,
        stopConditions: auth.blockedReasons,
        reason: auth.blockedReasons[0] ?? 'no auth actions could be planned',
        pathTaken,
      };
    }
    return {
      ...base,
      state: 'ready',
      actions: auth.actions,
      expectedNextPurposes: auth.expectedNextPurposes,
      stopConditions: ['no screen change after submit', 'OTP/verification gate', 'app error'],
      pathTaken,
    };
  }

  // --- permissions -> block for deliberate handling (never auto-grant) ---
  if (classification.purpose === 'permissions_prompt') {
    return {
      ...base,
      state: 'blocked',
      actions: [],
      expectedNextPurposes: ['onboarding', 'home', 'feature'],
      stopConditions: ['permission prompt requires deliberate handling'],
      reason: 'permission prompt encountered; not auto-granted',
      pathTaken: 'permissions',
      nextRecommendedTool: 'qa_first_run_continue',
    };
  }

  // --- paywall → record coverage, dismiss only via a safe visible path ---
  if (classification.purpose === 'paywall') {
    const pw = planPaywall(elements);
    if (pw.stop || !pw.action) {
      return {
        ...base,
        state: 'blocked',
        actions: [],
        expectedNextPurposes: ['home', 'feature'],
        stopConditions: ['paywall with no safe dismiss/skip/close'],
        reason: pw.coverage,
        pathTaken: 'paywall',
        nextRecommendedTool: 'qa_report',
      };
    }
    return {
      ...base,
      state: 'ready',
      actions: [pw.action],
      expectedNextPurposes: ['home', 'feature', 'onboarding'],
      stopConditions: ['no screen change after dismiss'],
      reason: pw.coverage,
      pathTaken: 'paywall',
    };
  }

  // --- onboarding → safe forward/skip ---
  if (classification.purpose === 'onboarding') {
    const step = planOnboardingStep(elements);
    if (!step.action) {
      return {
        ...base,
        state: 'blocked',
        actions: [],
        expectedNextPurposes: ['home', 'feature', 'permissions_prompt', 'paywall'],
        stopConditions: [step.blockedReason ?? 'no safe onboarding control'],
        reason: step.blockedReason,
        pathTaken: 'onboarding',
      };
    }
    return {
      ...base,
      state: 'ready',
      actions: [step.action],
      expectedNextPurposes: ['onboarding', 'home', 'feature', 'permissions_prompt', 'paywall'],
      stopConditions: ['no screen change after advancing', 'repeated onboarding'],
      pathTaken: 'onboarding',
    };
  }

  // --- home / feature / settings: first-run gating cleared ---
  if (classification.purpose === 'home' || classification.purpose === 'feature' || classification.purpose === 'settings') {
    return {
      ...base,
      state: 'completed',
      actions: [],
      expectedNextPurposes: [],
      stopConditions: ['reached home/feature — hand off to guided exploration'],
      reason: `reached ${classification.purpose} — first-run gates cleared`,
      pathTaken: hasProvidedCredentials(session) ? 'login' : 'home',
      nextRecommendedTool: 'qa_explore',
    };
  }

  // --- unknown ---
  return {
    ...base,
    state: 'blocked',
    actions: classification.safeActions.slice(0, 1),
    expectedNextPurposes: [],
    stopConditions: ['unknown screen — cannot plan a safe first-run step'],
    reason: classification.blockedReasons[0] ?? 'screen purpose is unknown',
    pathTaken: 'none',
  };
}

/** Convenience for tests/reporting: a one-line label of the path a plan would take. */
export function describePlan(plan: FirstRunPlan): string {
  return `${plan.classification.purpose} (conf ${plan.classification.confidence}) → ${plan.state}${plan.pathTaken ? ` [${plan.pathTaken}]` : ''}`;
}
