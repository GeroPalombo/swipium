// Exploration safety policy (Phase 3.3 §7). Classify an actionable control's risk so strict-mode
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

// Verbs that mutate data, money, identity, or messaging — never auto-tapped in strict mode.
const DESTRUCTIVE = /\b(delete|remove|clear|reset|wipe|erase|discard|pay|buy|purchase|checkout|subscribe|unsubscribe|place\s+order|submit\s+order|send|invite|log\s?out|sign\s?out|deactivate|deregister|block|report|withdraw|transfer|export|share|permission|allow|deny)\b/i;
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
// Confirmation-style verbs: dangerous only as the YES of a destructive dialog — treat as unknown
// (skipped in strict) unless paired with a destructive verb.
const CONFIRM = /\b(confirm|submit|proceed|ok|yes|agree|accept|continue)\b/i;
// Clearly-safe navigation/inspection words.
const SAFE = /\b(home|back|close|cancel|dismiss|settings?|search|menu|profile|account|info|details?|tab|next|explore|discover|map|list|history|help|about|notifications?|messages?|filter|sort|view|open|show|more|overview|dashboard|library|feed|favou?rites?)\b/i;

export interface RiskInput {
  label?: string; // visible text / content-desc / accessibility label
  id?: string; // resource-id (android) / accessibility id (ios)
  role?: string; // class / inferred role
}

/**
 * Classify an action's risk. Destructive verbs win; a bare confirm/submit is `unknown` (skipped in
 * strict); recognizable navigation is `safe`; everything else is `unknown`.
 */
export function classifyHighImpact(i: RiskInput): { riskClass: HighImpactClass; stepUp: boolean; requiresTwoStepConfirmation: boolean } | undefined {
  const hay = `${i.label ?? ''} ${i.id ?? ''}`.trim();
  for (const [riskClass, re] of HIGH_IMPACT) {
    if (!re.test(hay)) continue;
    const stepUp = riskClass === 'payment' || riskClass === 'account_delete' || riskClass === 'bulk_delete' || riskClass === 'message_send';
    return { riskClass, stepUp, requiresTwoStepConfirmation: stepUp || riskClass === 'permission_change' };
  }
  if (DESTRUCTIVE.test(hay)) return { riskClass: 'generic_destructive', stepUp: false, requiresTwoStepConfirmation: true };
  return undefined;
}

export function classifyRisk(i: RiskInput): { risk: Risk; reason: string; riskClass?: HighImpactClass; stepUp?: boolean; requiresTwoStepConfirmation?: boolean } {
  const hay = `${i.label ?? ''} ${i.id ?? ''}`.trim();
  if (!hay) return { risk: 'unknown', reason: 'unlabeled control — no text/accessibility id to judge safety' };
  const impact = classifyHighImpact(i);
  if (impact) return { risk: 'destructive', reason: `matches a high-impact action (${impact.riskClass})`, ...impact };
  if (DESTRUCTIVE.test(hay)) return { risk: 'destructive', reason: `matches a destructive action ("${(hay.match(DESTRUCTIVE) ?? [''])[0]}")`, riskClass: 'generic_destructive', requiresTwoStepConfirmation: true };
  // Android dialog negative button is safe (backs out); positive button is the confirm.
  if (/(^|[:/])button2$/i.test(i.id ?? '')) return { risk: 'safe', reason: 'dialog negative/cancel button' };
  if (/(^|[:/])button1$/i.test(i.id ?? '') || CONFIRM.test(hay)) return { risk: 'unknown', reason: 'confirmation control — risky as the YES of a destructive dialog; skipped in strict mode' };
  if (SAFE.test(hay)) return { risk: 'safe', reason: `recognized navigation/inspection control ("${(hay.match(SAFE) ?? [''])[0]}")` };
  return { risk: 'unknown', reason: 'unrecognized control — risk cannot be inferred from its label' };
}

/** Should this action run under the given safe mode? */
export function allowedUnder(risk: Risk, mode: SafeMode): boolean {
  if (risk === 'safe') return true;
  if (risk === 'destructive') return false;
  return mode === 'balanced'; // unknown controls are only allowed in explicit balanced exploration.
}

/** Context for the controlled mobile-audit account-cycle workflow (SWIPIUM-REQ-07). */
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

/**
 * Resolve whether an action runs, honoring the controlled account-cycle logout exception. Falls
 * back to the standard allowedUnder() decision for everything else.
 */
export function allowedUnderWithAccountCycle(i: RiskInput, mode: SafeMode, ctx?: AccountCycleContext): boolean {
  const { risk } = classifyRisk(i);
  if (risk === 'destructive' && ctx && allowsControlledLogout(i, ctx)) return true;
  return allowedUnder(risk, mode);
}
