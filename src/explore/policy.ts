// Exploration safety policy. Classify an actionable control's risk so strict-mode
// exploration never taps something destructive (delete / pay / send / logout / confirm-of-destruction)
// without explicit approval. Lexical + structural (Android button1/button2, role) signals; PURE.

export type Risk = 'safe' | 'unknown' | 'destructive';
export type SafeMode = 'strict' | 'balanced' | 'dry_run_destructive' | 'approved_destructive_candidate' | 'approved_destructive';
export type HighImpactClass =
  | 'payment'
  | 'message_send'
  | 'external_invite'
  | 'account_delete'
  | 'bulk_delete'
  | 'permission_change'
  | 'logout'
  | 'data_export'
  | 'generic_destructive';

// Verbs that mutate data, money, identity, or messaging. Never auto-tapped in strict mode.
const DESTRUCTIVE =
  /\b(delete|remove|clear|reset|wipe|erase|discard|pay|buy|purchase|checkout|subscribe|unsubscribe|place\s+order|submit\s+order|send|invite|log\s?out|sign\s?out|deactivate|deregister|block|report|withdraw|transfer|export|share|permission|allow|deny)\b/i;
const HIGH_IMPACT: Array<[HighImpactClass, RegExp]> = [
  ['payment', /\b(pay|buy|purchase|checkout|subscribe|place\s+order|submit\s+order|transfer|withdraw)\b/i],
  ['message_send', /\b(send|message|sms|email)\b/i],
  ['external_invite', /\b(invite|share)\b/i],
  ['account_delete', /\b(delete|deactivate|deregister|close)\s+(account|profile)\b/i],
  ['bulk_delete', /\b(delete|remove|clear|wipe|erase)\s+(all|everything|history|data|items|records)\b/i],
  ['permission_change', /\b(permission|allow|deny|grant|revoke|location|camera|photos|contacts|microphone)\b/i],
  ['logout', /\b(log\s?out|sign\s?out)\b/i],
  ['data_export', /\b(export|download|share)\s+(data|report|records|history)\b/i],
];
// Confirmation-style verbs: dangerous only as the YES of a destructive dialog, so treat as unknown
// (skipped in strict) unless paired with a destructive verb.
const CONFIRM = /\b(confirm|submit|proceed|ok|yes|agree|accept|continue)\b/i;
// Clearly-safe navigation/inspection words.
const SAFE =
  /\b(home|back|close|cancel|settings?|search|menu|profile|account|info|details?|tab|next|explore|discover|map|list|history|help|about|notifications?|messages?|filter|sort|view|open|show|more|overview|dashboard|library|feed|favou?rites?)\b/i;

// State-changing but not destructive ("Dismiss" on an upcoming-alarm row dismissed the alarm).
// Skipped in strict mode like any unknown control; a dialog's negative button (button2) stays safe.
const STATE_CHANGE =
  /\b(dismiss|archive|unarchive|snooze|mute|unmute|mark\s+(as\s+)?(read|unread|done|complete)|turn\s+(on|off)|enable|disable|undo)\b/i;

// Controls that open another app (e.g. Mapbox "Improve this map" opens Safari).
const EXTERNAL =
  /\b(improve this map|telemetry|attribution|mapbox|openstreetmap|open in (safari|browser|chrome|maps)|rate (us|this app)|app store|play store|visit (our )?(website|site)|privacy policy|terms of (service|use))\b/i;
// Third-party / OS sign-in ("Sign up with Apple", "Continue with Google",
// social-signin.apple-button). It starts an account flow outside the app (an iOS Apple Account
// alert, a Google account picker, a browser), so first-run, exploration and generated flows never tap it.
const SIGN_IN_PROVIDERS = 'apple|google|facebook|microsoft|twitter|github|linkedin';
const THIRD_PARTY_SIGN_IN_LABEL = new RegExp(
  `\\b((sign|log)\\s?(in|up)|continue|register|join)\\s+(with|using|via)\\s+(${SIGN_IN_PROVIDERS})\\b`,
  'i',
);
const THIRD_PARTY_SIGN_IN_ID = new RegExp(
  `social[-_.]?(sign|log)[-_]?(in|up)|social[-_.]?(auth|login)|(${SIGN_IN_PROVIDERS})[-_.]?(sign[-_]?(in|up)|log[-_]?in|auth|oauth)|(sign[-_]?(in|up)|login|auth)[-_.]?(with[-_.]?)?(${SIGN_IN_PROVIDERS})\\b`,
  'i',
);

/** Third-party / OS sign-in control (Sign in with Apple / Google / Facebook ...)? PURE. */
export function isThirdPartySignIn(i: Pick<RiskInput, 'label' | 'id'>): boolean {
  return THIRD_PARTY_SIGN_IN_LABEL.test(i.label ?? '') || THIRD_PARTY_SIGN_IN_ID.test(i.id ?? '');
}

// Tab bars / bottom navigation, by class (Android, iOS) or by id segment.
const TAB_ROLE = /TabView|TabWidget|BottomNavigation|NavigationBarItem|NavigationRail|XCUIElementTypeTab\b|\bTab\b/i;
const TAB_ID = /(^|[:/_.-])(tab|tabs|nav|navigation)([_.-]|$)/i;

export interface RiskInput {
  label?: string; // visible text / content-desc / accessibility label
  id?: string; // resource-id (android) / accessibility id (ios)
  role?: string; // class / inferred role
}

/**
 * Classify an action's risk. Destructive verbs win; a bare confirm/submit is `unknown` (skipped in
 * strict); recognizable navigation is `safe`; everything else is `unknown`.
 */
export function classifyHighImpact(
  i: RiskInput,
): { riskClass: HighImpactClass; stepUp: boolean; requiresTwoStepConfirmation: boolean } | undefined {
  const hay = `${i.label ?? ''} ${i.id ?? ''}`.trim();
  for (const [riskClass, re] of HIGH_IMPACT) {
    if (!re.test(hay)) continue;
    const stepUp = riskClass === 'payment' || riskClass === 'account_delete' || riskClass === 'bulk_delete' || riskClass === 'message_send';
    return { riskClass, stepUp, requiresTwoStepConfirmation: stepUp || riskClass === 'permission_change' };
  }
  if (DESTRUCTIVE.test(hay)) return { riskClass: 'generic_destructive', stepUp: false, requiresTwoStepConfirmation: true };
  return undefined;
}

export function classifyRisk(i: RiskInput): {
  risk: Risk;
  reason: string;
  riskClass?: HighImpactClass;
  stepUp?: boolean;
  requiresTwoStepConfirmation?: boolean;
} {
  const hay = `${i.label ?? ''} ${i.id ?? ''}`.trim();
  if (!hay) return { risk: 'unknown', reason: 'unlabeled control: no text/accessibility id to judge safety' };
  if (isThirdPartySignIn(i))
    return {
      risk: 'unknown',
      reason: 'third-party / OS sign-in (Apple, Google, ...): starts an account flow outside the app; never auto-tapped',
    };
  const impact = classifyHighImpact(i);
  if (impact) return { risk: 'destructive', reason: `matches a high-impact action (${impact.riskClass})`, ...impact };
  if (DESTRUCTIVE.test(hay))
    return {
      risk: 'destructive',
      reason: `matches a destructive action ("${(hay.match(DESTRUCTIVE) ?? [''])[0]}")`,
      riskClass: 'generic_destructive',
      requiresTwoStepConfirmation: true,
    };
  // Android dialog negative button is safe (backs out); positive button is the confirm.
  if (/(^|[:/])button2$/i.test(i.id ?? '')) return { risk: 'safe', reason: 'dialog negative/cancel button' };
  if (STATE_CHANGE.test(hay))
    return { risk: 'unknown', reason: `state-changing control ("${(hay.match(STATE_CHANGE) ?? [''])[0]}"); skipped in strict mode` };
  if (/(^|[:/])button1$/i.test(i.id ?? '') || CONFIRM.test(hay))
    return { risk: 'unknown', reason: 'confirmation control: risky as the YES of a destructive dialog; skipped in strict mode' };
  // Links that open another app (map attribution / telemetry, store, web pages) leave the
  // app under test; not safe to auto-tap in strict exploration.
  if (EXTERNAL.test(hay))
    return { risk: 'unknown', reason: 'external link: likely opens another app (browser/store); skipped in strict mode' };
  if (SAFE.test(hay)) return { risk: 'safe', reason: `recognized navigation/inspection control ("${(hay.match(SAFE) ?? [''])[0]}")` };
  // Bottom-navigation / tab-bar items are navigation by structure, whatever their label
  // ("Alarms", "Timers", "Stopwatch"), and ids like tab_menu_alarm name them so.
  if (isTabLike(i)) return { risk: 'safe', reason: 'tab / bottom-navigation item (structural navigation)' };
  return { risk: 'unknown', reason: 'unrecognized control: risk cannot be inferred from its label' };
}

/** Structural tab / bottom-navigation item (by class or id segment). */
export function isTabLike(i: Pick<RiskInput, 'id' | 'role'>): boolean {
  return TAB_ROLE.test(i.role ?? '') || TAB_ID.test(i.id ?? '');
}

/** Should this action run under the given safe mode? */
export function allowedUnder(risk: Risk, mode: SafeMode): boolean {
  if (risk === 'safe') return true;
  if (risk === 'destructive') return false;
  return mode === 'balanced'; // unknown controls are only allowed in explicit balanced exploration.
}

/** Context for the controlled mobile-audit account-cycle workflow. */
export interface AccountCycleContext {
  /** True only inside the named account-cycle / release-gate mobile-audit workflow. */
  accountCycle: boolean;
  /** Generated disposable account in use (required for the logout exception). */
  disposableAccount: boolean;
}

/**
 * Logout is classified destructive for broad exploration (a sensible default). The mobile QA
 * toolkit needs a NARROW exception: inside the controlled account-cycle workflow, on a disposable
 * generated account, logout is an expected step. This never relaxes other destructive actions
 * (delete/pay/send) and never applies outside the account-cycle workflow.
 */
export function allowsControlledLogout(i: RiskInput, ctx: AccountCycleContext): boolean {
  if (!ctx.accountCycle || !ctx.disposableAccount) return false;
  const impact = classifyHighImpact(i);
  return impact?.riskClass === 'logout';
}
