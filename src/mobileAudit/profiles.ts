// SWIPIUM Mobile QA Toolkit — profile + check definitions (SWIPIUM-REQ-07 "Mobile QA Toolkit").
//
// A named, profile-based mobile-release audit. PURE data + selection logic: the qa_mobile_audit tool
// turns a chosen profile into an ordered checklist (with expected behavior + report classification)
// and a safety contract the agent executes via the existing driver tools (qa_act / qa_snapshot /
// qa_app_control / qa_network …). Keeping the catalog pure makes profile behavior unit-testable.

import type { IssueCategory } from '../issues/schema.js';

export type AuditProfile = 'smoke' | 'account_cycle' | 'store_compliance' | 'resilience' | 'release_gate';

export const ALL_PROFILES: AuditProfile[] = ['smoke', 'account_cycle', 'store_compliance', 'resilience', 'release_gate'];

export interface AuditCheck {
  id: string;
  title: string;
  expected: string;
  /** Report classification when this check FAILS / the surface is missing. */
  classification: IssueCategory;
  /** Steps may include a controlled logout / account-delete only inside the account-cycle workflow. */
  requiresAccountCycle?: boolean;
  /** True when the check needs safe generated test data. */
  requiresGeneratedData?: boolean;
}

const CHECKS: Record<string, AuditCheck> = {
  launch: {
    id: 'launch',
    title: 'App launch + main screen',
    expected: 'App launches and renders its main screen with no crash/RedBox.',
    classification: 'blocker_app_bug',
  },
  health_scan: {
    id: 'health_scan',
    title: 'Crash / RedBox / log scan',
    expected: 'No native crash, RedBox, unhandled exception, or error surface on the main flow.',
    classification: 'app_bug',
  },
  navigation: {
    id: 'navigation',
    title: 'Basic navigation',
    expected: 'Primary tabs / navigation are reachable and stable.',
    classification: 'app_bug',
  },

  privacy_link: {
    id: 'privacy_link',
    title: 'Privacy Policy link',
    expected: 'Privacy Policy link exists, opens, and is reachable.',
    classification: 'store_compliance',
  },
  terms_link: {
    id: 'terms_link',
    title: 'Terms link',
    expected: 'Terms link exists where account/payment/subscription surfaces need it.',
    classification: 'store_compliance',
  },
  account_deletion: {
    id: 'account_deletion',
    title: 'Account deletion path',
    expected: 'Account/settings exposes a delete-account or data-deletion flow when the app has accounts.',
    classification: 'store_compliance',
  },
  subscription_management: {
    id: 'subscription_management',
    title: 'Subscription management / restore',
    expected: 'Paywall/account exposes restore-purchase and a manage-subscription path or clear system handoff.',
    classification: 'store_compliance',
  },
  paywall: {
    id: 'paywall',
    title: 'Paywall classification',
    expected: 'Soft paywall can be dismissed or a free path exists; a hard paywall is recorded without purchase.',
    classification: 'hard_gate',
  },
  external_links: {
    id: 'external_links',
    title: 'External links',
    expected: 'External links (support/help/store) open without crashing the app.',
    classification: 'improvement',
  },

  create_account: {
    id: 'create_account',
    title: 'Create account',
    expected: 'A safe generated account can be created in test/staging.',
    classification: 'app_bug',
    requiresAccountCycle: true,
    requiresGeneratedData: true,
  },
  logout: {
    id: 'logout',
    title: 'Logout',
    expected: 'User can log out from the disposable test account.',
    classification: 'app_bug',
    requiresAccountCycle: true,
  },
  login_again: {
    id: 'login_again',
    title: 'Login again',
    expected: 'The same generated account can log back in.',
    classification: 'app_bug',
    requiresAccountCycle: true,
    requiresGeneratedData: true,
  },
  forgot_password: {
    id: 'forgot_password',
    title: 'Forgot password surface',
    expected: 'A forgot-password entrypoint exists and accepts a test email without consuming email/OTP.',
    classification: 'improvement',
    requiresAccountCycle: true,
  },

  offline_entry: {
    id: 'offline_entry',
    title: 'Offline entry',
    expected: 'App handles offline state gracefully (expected offline message, no crash/blank).',
    classification: 'app_bug',
  },
  network_restoration: {
    id: 'network_restoration',
    title: 'Network restoration',
    expected: 'App recovers after connectivity returns.',
    classification: 'app_bug',
  },
  process_relaunch: {
    id: 'process_relaunch',
    title: 'Process kill / relaunch',
    expected: 'After process kill + relaunch the app restores or returns to a sane state.',
    classification: 'app_bug',
  },
  rotation: {
    id: 'rotation',
    title: 'Rotation',
    expected: 'Rotation (where supported) does not crash or lose critical state.',
    classification: 'improvement',
  },

  locator_readiness: {
    id: 'locator_readiness',
    title: 'Accessibility / test IDs',
    expected: 'Important buttons/fields have stable locators.',
    classification: 'accessibility_readiness',
  },
  issue_recurrence: {
    id: 'issue_recurrence',
    title: 'Issue-ledger recurrence',
    expected: 'No previously-fixed issue has regressed (issue ledger reports no reopened fingerprints).',
    classification: 'app_bug',
  },
};

const PROFILE_CHECKS: Record<AuditProfile, string[]> = {
  smoke: ['launch', 'health_scan', 'navigation'],
  account_cycle: ['create_account', 'logout', 'login_again', 'forgot_password'],
  store_compliance: ['privacy_link', 'terms_link', 'account_deletion', 'subscription_management', 'paywall', 'external_links'],
  resilience: ['offline_entry', 'network_restoration', 'process_relaunch', 'rotation'],
  release_gate: [], // composed below
};

// release_gate combines smoke + account-cycle + store-compliance + resilience + readiness + recurrence.
PROFILE_CHECKS.release_gate = [
  ...PROFILE_CHECKS.smoke,
  ...PROFILE_CHECKS.account_cycle,
  ...PROFILE_CHECKS.store_compliance,
  ...PROFILE_CHECKS.resilience,
  'locator_readiness',
  'issue_recurrence',
];

export function checksForProfile(profile: AuditProfile): AuditCheck[] {
  return PROFILE_CHECKS[profile].map((id) => CHECKS[id]);
}

export interface AccountCycleSafety {
  /** Logout is permitted as an expected step only inside account_cycle / release_gate. */
  allowsLogout: boolean;
  /** Generated disposable accounts only; requires test/staging or explicit permission. */
  requiresGeneratedData: boolean;
  /** Account deletion is inspected and only confirmed when destructive test-account cleanup is allowed. */
  allowsAccountDeletion: boolean;
  /** A real user account is never deleted. */
  neverDeletesRealAccount: true;
  /** OTP/MFA still returns needs_input unless a test-code provider is configured. */
  otpReturnsNeedsInput: true;
  reasons: string[];
}

export interface AuditOptions {
  allowGeneratedData?: boolean;
  allowTestAccountDeletion?: boolean;
  offlineMode?: boolean;
}

/**
 * Resolve the account-cycle safety contract for a profile. Logout is permitted ONLY in the
 * controlled account-cycle / release-gate profiles, never in broad exploration (spec §Account-cycle
 * safety). A real account is never deleted; OTP/MFA always returns needs_input.
 */
export function accountCycleSafety(profile: AuditProfile, opts: AuditOptions = {}): AccountCycleSafety {
  const controlled = profile === 'account_cycle' || profile === 'release_gate';
  const reasons: string[] = [];
  if (controlled) reasons.push('account-cycle profile: logout permitted as an expected step on a disposable account');
  else reasons.push('logout stays destructive outside the controlled account-cycle workflow');
  if (controlled && !opts.allowGeneratedData) reasons.push('generated-data permission required: pass allowGeneratedData in test/staging');
  if (opts.allowTestAccountDeletion) reasons.push('test-account deletion allowed by explicit policy (disposable accounts only)');
  return {
    allowsLogout: controlled,
    requiresGeneratedData: controlled,
    allowsAccountDeletion: controlled && opts.allowTestAccountDeletion === true,
    neverDeletesRealAccount: true,
    otpReturnsNeedsInput: true,
    reasons,
  };
}
