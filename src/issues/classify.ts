// SWIPIUM Issue Log — policy-trained issue classifier (SWIPIUM-REQ-07 "Classifier Rules").
//
// Runs AFTER raw health/log extraction and BEFORE report rendering. Turns a normalized observation
// into a category + severity + owner + release impact, distinguishing real product defects from
// expected simulator / StoreKit / Google Play Billing / RevenueCat noise, hard gates, and readiness
// improvements. Built-in rules encode the spec's taxonomy; an optional `.swipium/issues/policy.json`
// can ADD or OVERRIDE rules. PURE — no clock, no fs.

import type {
  IssueCategory,
  IssueClassification,
  IssueEnvironment,
  IssueObservation,
  IssueOwner,
  IssueSeverity,
  ReleaseImpact,
} from './schema.js';
import { defaultReleaseImpact } from './schema.js';

/** A declarative classifier rule (mirrors the policy.json `match` shape). */
export interface ClassifierRule {
  name: string;
  match: {
    failureCode?: string[];
    messageIncludes?: string[]; // any-of substring match (case-insensitive) against title+summary+message
    environment?: IssueEnvironment[];
    httpStatus?: number[];
    subsystem?: string[];
    screenPurpose?: string[];
  };
  category: IssueCategory;
  severity: IssueSeverity;
  owner?: IssueOwner;
  releaseImpact?: ReleaseImpact;
}

export interface ClassifierPolicy {
  classifiers?: {
    environmentNoise?: ClassifierRule[];
    blockers?: ClassifierRule[];
    hardGates?: ClassifierRule[];
    improvements?: ClassifierRule[];
    rules?: ClassifierRule[];
  };
}

export interface ClassifyContext {
  environment?: IssueEnvironment;
  /** Whether this is part of an explicit offline / auth-negative / paywall test (changes intent). */
  expectedOffline?: boolean;
  authNegativeTest?: boolean;
  /** A real release-gate purchase flow on a device elevates billing failures. */
  realDevicePurchaseFlow?: boolean;
  policy?: ClassifierPolicy;
  /** Caller-supplied category (e.g. an agent's qa_note category) used only when the built-in rules
   *  cannot classify the observation — never overrides a strong app-defect signal. */
  categoryHint?: IssueCategory;
  severityHint?: IssueSeverity;
  /** Authoritative category from a caller that IS the classifier (e.g. a mobile-audit check) —
   *  overrides the built-in rules entirely. Use when the observer already decided the category. */
  forceCategory?: IssueCategory;
}

const OWNER_BY_CATEGORY: Record<IssueCategory, IssueOwner> = {
  app_bug: 'app',
  blocker_app_bug: 'app',
  environment_noise: 'test_env',
  expected_gate: 'test_env',
  hard_gate: 'test_env',
  improvement: 'app',
  missing_test_data: 'test_env',
  mcp_limitation: 'mcp',
  security_privacy: 'app',
  store_compliance: 'app',
  accessibility_readiness: 'app',
};

function haystack(obs: IssueObservation): string {
  return [
    obs.title,
    obs.summary,
    obs.failureCode,
    obs.exception?.message,
    obs.exception?.type,
    obs.subsystem,
    obs.packageName,
    obs.visibleText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function ruleMatches(rule: ClassifierRule, obs: IssueObservation, ctx: ClassifyContext): boolean {
  const m = rule.match;
  const hay = haystack(obs);
  if (m.failureCode && (!obs.failureCode || !m.failureCode.includes(obs.failureCode))) return false;
  if (m.messageIncludes && !m.messageIncludes.some((s) => hay.includes(s.toLowerCase()))) return false;
  if (m.environment && (!ctx.environment || !m.environment.includes(ctx.environment))) return false;
  if (m.httpStatus && (obs.http?.status == null || !m.httpStatus.includes(obs.http.status))) return false;
  if (m.subsystem && (!obs.subsystem || !m.subsystem.includes(obs.subsystem))) return false;
  if (m.screenPurpose && (!obs.screenPurpose || !m.screenPurpose.includes(obs.screenPurpose))) return false;
  return true;
}

function fromRule(rule: ClassifierRule, reason: string): IssueClassification {
  const category = rule.category;
  const severity = rule.severity;
  return {
    category,
    severity,
    owner: rule.owner ?? OWNER_BY_CATEGORY[category],
    confidence: 0.9,
    reason,
    releaseImpact: rule.releaseImpact ?? defaultReleaseImpact(category, severity),
  };
}

const BILLING_SUBSYSTEMS = new Set(['revenuecat', 'storekit', 'google_play_billing', 'billing']);

/** Built-in classifier: returns the most specific classification for an observation. */
export function classifyObservation(obs: IssueObservation, ctx: ClassifyContext = {}): IssueClassification {
  const hay = haystack(obs);
  const env = ctx.environment ?? 'unknown';
  const isSim = env === 'simulator' || env === 'emulator';

  // --- 0. Authoritative override: the caller already classified (e.g. a mobile-audit check) ---
  if (ctx.forceCategory) {
    const category = ctx.forceCategory;
    const severity = ctx.severityHint ?? 'medium';
    return {
      category,
      severity,
      owner: OWNER_BY_CATEGORY[category],
      confidence: 0.95,
      reason: 'classified by the observing audit check',
      releaseImpact: defaultReleaseImpact(category, severity),
    };
  }

  // --- 1. User-supplied policy rules win first (most specific intent) ---
  const pol = ctx.policy?.classifiers;
  if (pol) {
    for (const bucket of [pol.blockers, pol.hardGates, pol.environmentNoise, pol.improvements, pol.rules]) {
      for (const rule of bucket ?? []) {
        if (ruleMatches(rule, obs, ctx)) return fromRule(rule, `policy rule "${rule.name}"`);
      }
    }
  }

  // --- 2. Hard gates (stop the workflow, not the run; not an app bug by themselves) ---
  if (/\botp\b|one-?time|mfa|2fa|verification code|magic link/.test(hay)) {
    return mk('hard_gate', 'medium', 'OTP/MFA challenge requires a real user code — workflow gated, not an app bug');
  }
  if (obs.screenPurpose === 'paywall' && /hard paywall|no free|purchase required|must subscribe/.test(hay)) {
    return mk('hard_gate', 'medium', 'Hard paywall with no permitted test path — recorded without purchase');
  }

  // --- 3. Expected environment noise (sim/emulator billing/store + explicit offline) ---
  if (ctx.expectedOffline && /no internet|offline|no connection|network unavailable/.test(hay)) {
    return mk('environment_noise', 'info', 'Network unavailable during an explicit offline test — expected');
  }
  if (obs.subsystem && BILLING_SUBSYSTEMS.has(obs.subsystem) && isSim && !ctx.realDevicePurchaseFlow) {
    return mk('environment_noise', 'info', `${obs.subsystem} warning on ${env} — sandbox/simulator noise, not a product defect`);
  }
  if (/revenuecat/.test(hay) && /sandbox/.test(hay) && isSim) {
    return mk('environment_noise', 'info', 'RevenueCat sandbox warning on simulator/emulator — expected');
  }
  if (/storekit/.test(hay) && /(sandbox|test|simulator)/.test(hay) && isSim) {
    return mk('environment_noise', 'info', 'StoreKit sandbox/test warning on simulator — expected');
  }
  if (
    /billing_unavailable|billing service unavailable|billing.*unavailable/.test(hay) &&
    env === 'emulator' &&
    !ctx.realDevicePurchaseFlow
  ) {
    return mk('environment_noise', 'info', 'Google Play billing unavailable on emulator — environment, not an app bug');
  }
  if (/missing.*(product|offering|sku)/.test(hay) && isSim && !ctx.realDevicePurchaseFlow) {
    return mk('environment_noise', 'info', 'Missing production purchase products in a local simulator run — expected');
  }

  // --- 4. Real billing/entitlement failure on device or during release-gate purchase ---
  if ((obs.subsystem && BILLING_SUBSYSTEMS.has(obs.subsystem)) || /checkout|subscription|entitlement|purchase/.test(hay)) {
    if (ctx.realDevicePurchaseFlow || env === 'device') {
      return mk('app_bug', 'high', 'Checkout/subscription/entitlement failure on a real device or release-gate purchase flow');
    }
  }

  // --- 5. App defects: React/JS/native + crashes ---
  const fc = obs.failureCode;
  if (fc === 'REDBOX' || /red\s?box/.test(hay)) return mk('blocker_app_bug', 'blocker', 'React Native RedBox — fatal JS/runtime error');
  if (fc === 'NATIVE_CRASH' || /native crash|sigsegv|sigabrt/.test(hay)) return mk('blocker_app_bug', 'blocker', 'Fatal native crash');
  if (fc === 'ANR' || /\banr\b|not responding/.test(hay)) return mk('blocker_app_bug', 'blocker', 'Application not responding (ANR)');
  if (fc === 'ERROR_BOUNDARY' || /error boundary/.test(hay))
    return mk('app_bug', 'high', 'Error boundary fallback shown during a normal workflow');
  if (obs.exception?.type || /unhandled (js )?exception|typeerror|referenceerror|cannot read propert/.test(hay)) {
    return mk('app_bug', 'high', 'Unhandled JS exception during a user workflow');
  }
  if (/(module|package).*(not found|resolution failed|cannot find)|unable to resolve module|import error/.test(hay)) {
    return mk('app_bug', 'high', 'Package import / module resolution failure');
  }

  // --- 6. HTTP / API rules ---
  const status = obs.http?.status;
  if (status != null) {
    if (status >= 500) return mk('app_bug', 'high', `HTTP ${status} from app-owned backend`, 'backend');
    if (status === 404 || status === 410)
      return mk('app_bug', 'high', `HTTP ${status} for an app route/content endpoint that should exist`, 'backend');
    if ((status === 401 || status === 403) && !ctx.authNegativeTest) {
      return mk('app_bug', 'high', `HTTP ${status} with invalid/missing/expired app token (not an auth-negative test)`, 'backend');
    }
  }

  // --- 7. Missing assets / routes ---
  if (/missing (required )?(asset|route)|asset not found|404 not found/.test(hay)) {
    return mk('app_bug', 'medium', 'Missing required asset or route');
  }

  // --- 8. Improvements / readiness (non-blocking) ---
  if (
    fc === 'MISSING_DURABLE_LOCATOR' ||
    fc === 'COORDINATE_ONLY_FLOW' ||
    /accessibility id|missing testid|unstable locator|no durable locator/.test(hay)
  ) {
    return mk('accessibility_readiness', 'low', 'Missing accessibility IDs / unstable locators — readiness improvement, not a blocker');
  }
  if (fc === 'LOGBOX' || /logbox|console warning|non-fatal warning|slow network|missing (empty|loading|error) state/.test(hay)) {
    return mk('improvement', 'low', 'Non-fatal warning / readiness gap — precaution, not a blocker');
  }

  // --- 9. Privacy / store-compliance & missing test data ---
  if (/privacy policy|terms of service|account deletion|delete account|data deletion|manage subscription|restore purchase/.test(hay)) {
    return mk('store_compliance', 'high', 'Store-compliance surface (privacy/terms/account-deletion/subscription) issue');
  }
  if (fc === 'MISSING_TEST_DATA' || fc === 'AUTH_GATE' || fc === 'MISSING_FIXTURE' || /no test (data|account)|fixture missing/.test(hay)) {
    return mk('missing_test_data', 'medium', 'Required test data / fixture missing — provide it, not an app bug');
  }

  // --- 10. Fallback ---
  // Honor a caller-supplied category (e.g. an explicit qa_note category) when no built-in rule
  // matched — this is how hard-gate / store-compliance / improvement notes still land correctly.
  if (ctx.categoryHint) {
    return mk(ctx.categoryHint, ctx.severityHint ?? 'medium', `classified from caller-supplied category "${ctx.categoryHint}"`);
  }
  return mk('mcp_limitation', 'low', 'Unclassified observation — recorded for triage');

  function mk(category: IssueCategory, severity: IssueSeverity, reason: string, owner?: IssueOwner): IssueClassification {
    return {
      category,
      severity,
      owner: owner ?? OWNER_BY_CATEGORY[category],
      confidence: 0.85,
      reason,
      releaseImpact: defaultReleaseImpact(category, severity),
    };
  }
}
