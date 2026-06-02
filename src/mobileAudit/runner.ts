// SWIPIUM-REQ-08 — executable mobile-audit runner. Orchestrates the existing driver capabilities
// (health, snapshot, network, first-run, guided exploration) into a profile-based audit that
// produces honest, evidence-backed check results and records issue-ledger entries. It NEVER claims
// a check passed without observed evidence, never purchases / bypasses OTP / deletes real accounts,
// and always restores network it changed.

import { recordObservation } from '../issues/index.js';
import { queryIssues } from '../issues/index.js';
import type { IssueEnvironment, IssuePlatform, SourceRevision } from '../issues/schema.js';
import { restoreNetwork } from '../tools/network.js';
import { runFirstRun } from '../firstRun/firstRunRunner.js';
import type { Driver } from '../drivers/Driver.js';
import type { Session, SessionStore } from '../session/store.js';
import { checksForProfile, type AuditProfile } from './profiles.js';
import * as C from './checks.js';
import type { RawCheckResult } from './checks.js';
import { snapshotText, foreground, type AuditEvidenceCtx } from './evidence.js';
import { auditReleaseImpact, type AuditRunState, type MobileAuditCheckResult, type MobileAuditRunResult } from './results.js';

export interface MobileAuditRunOptions {
  profile: AuditProfile;
  allowGeneratedData?: boolean;
  allowTestAccountDeletion?: boolean;
  offlineMode?: boolean;
  sourceRevision?: SourceRevision;
  now: string;
  reportUri?: string;
}

function platformOf(driver: Driver): IssuePlatform {
  return driver.kind === 'wda' || driver.kind === 'simulator' ? 'ios' : 'android';
}
function environmentOf(session: Session, platform: IssuePlatform): IssueEnvironment {
  if (session.headless !== undefined) return platform === 'ios' ? 'simulator' : 'emulator';
  return process.env.CI ? 'ci' : 'unknown';
}

export async function runMobileAudit(
  sessions: SessionStore,
  session: Session,
  driver: Driver,
  opts: MobileAuditRunOptions,
): Promise<MobileAuditRunResult> {
  const platform = platformOf(driver);
  const environment = environmentOf(session, platform);
  const ev: AuditEvidenceCtx = { sessions, session, driver, appId: session.appId };
  const issueIds: string[] = [];
  const recurrenceWarnings: string[] = [];
  let state: AuditRunState = 'completed';

  // Record a fail/blocked check as an issue (the check IS the classifier → forceCategory). Returns
  // the issue id, or undefined when the check has no category (pure environment/setup gap).
  const recordIssue = async (title: string, raw: RawCheckResult): Promise<string | undefined> => {
    if (raw.status !== 'fail' && raw.status !== 'blocked') return undefined;
    if (!raw.category) return undefined;
    const fg = raw.screenId ?? (await foreground(ev));
    const res = recordObservation(
      session.root,
      {
        title: `audit: ${title}`,
        summary: raw.reason ?? title,
        screenPurpose: fg,
        workflow: raw.workflow ?? title,
        steps: raw.nextStep ? [raw.nextStep] : undefined,
      },
      opts.now,
      { environment, forceCategory: raw.category, severityHint: raw.severity },
      {
        appId: session.appId,
        platform,
        environment,
        sourceRevision: opts.sourceRevision,
        run: { sessionId: session.id, reportUri: opts.reportUri },
        links: { evidenceRefs: raw.evidenceUris.map((uri) => ({ kind: 'evidence', uri })), appMapRefs: [{ screenId: fg }] },
      },
    );
    if (res.recurrenceMessage) recurrenceWarnings.push(res.recurrenceMessage);
    return res.issueId;
  };

  const checks: MobileAuditCheckResult[] = [];
  const finalize = async (id: string, title: string, raw: RawCheckResult): Promise<void> => {
    const issueId = await recordIssue(title, raw);
    if (issueId) issueIds.push(issueId);
    checks.push({ id, title, profile: opts.profile, status: raw.status, category: raw.category, severity: raw.severity, issueId, reason: raw.reason, evidenceUris: raw.evidenceUris, workflow: raw.workflow, screenId: raw.screenId, nextStep: raw.nextStep });
  };

  const profilesToRun: AuditProfile[] =
    opts.profile === 'release_gate' ? ['smoke', 'account_cycle', 'store_compliance', 'resilience'] : [opts.profile];

  for (const prof of profilesToRun) {
    if (prof === 'smoke') {
      await finalize('launch', 'App launch + main screen', await C.checkLaunch(ev));
      await finalize('health_scan', 'Crash / RedBox / log scan', await C.checkHealthScan(ev));
      await finalize('navigation', 'Basic navigation', await C.checkNavigation(ev));
    } else if (prof === 'store_compliance') {
      const text = await snapshotText(ev);
      await finalize('privacy_link', 'Privacy Policy link', await C.checkPrivacyLink(ev, text));
      await finalize('terms_link', 'Terms link', await C.checkTermsLink(ev, text));
      await finalize('account_deletion', 'Account deletion path', await C.checkAccountDeletion(ev, text));
      await finalize('subscription_management', 'Subscription management / restore', await C.checkSubscriptionManagement(ev, text));
      await finalize('paywall', 'Paywall classification', await C.checkPaywall(ev, text));
      await finalize('external_links', 'External links', C.checkExternalLinks());
    } else if (prof === 'resilience') {
      try {
        await finalize('offline_entry', 'Offline entry', await C.checkOfflineEntry(ev));
        await finalize('network_restoration', 'Network restoration', await C.checkNetworkRestoration(ev));
        await finalize('process_relaunch', 'Process kill / relaunch', await C.checkProcessRelaunch(ev));
        await finalize('rotation', 'Rotation', C.checkRotation());
      } finally {
        // GUARANTEED network restore — even if a resilience check threw (REQ-08 safety).
        try {
          await driver.setAirplane(false);
          await restoreNetwork(sessions, session, driver);
        } catch {
          /* best-effort */
        }
      }
    } else if (prof === 'account_cycle') {
      const acState = await runAccountCycle(sessions, session, driver, opts, finalize);
      if (acState !== 'completed' && state === 'completed') state = acState;
    }
  }

  // Recurrence: a previously-fixed blocker/high issue reopened this run is a release blocker.
  const reopened = queryIssues(session.root, opts.now, { includeSuppressed: false }).recurrenceCandidates;
  const blockingRecurrence = reopened.some((r) => (r.severity === 'blocker' || r.severity === 'high') && (r.category === 'app_bug' || r.category === 'blocker_app_bug'));
  for (const r of reopened) if (r.lastRecurrenceMessage && !recurrenceWarnings.includes(r.lastRecurrenceMessage)) recurrenceWarnings.push(r.lastRecurrenceMessage);

  // release_gate adds locator readiness + an explicit issue-ledger recurrence check. The recurrence
  // check POINTS AT the existing reopened issue (no duplicate issue is created); plan/execute agree.
  if (opts.profile === 'release_gate') {
    await finalize('locator_readiness', 'Accessibility / test IDs', await C.checkLocatorReadiness(ev));
    if (reopened.length === 0) {
      checks.push({ id: 'issue_recurrence', title: 'Issue-ledger recurrence', profile: 'release_gate', status: 'pass', reason: 'no previously-fixed issue has regressed', evidenceUris: [] });
    } else {
      const top = reopened.find((r) => r.severity === 'blocker' || r.severity === 'high') ?? reopened[0];
      const blocking = top.severity === 'blocker' || top.severity === 'high';
      checks.push({
        id: 'issue_recurrence',
        title: 'Issue-ledger recurrence',
        profile: 'release_gate',
        status: blocking ? 'fail' : 'blocked',
        category: top.category,
        severity: top.severity,
        issueId: top.issueId, // link to the EXISTING reopened issue, not a new one
        reason: top.lastRecurrenceMessage ?? `${reopened.length} previously-fixed issue(s) regressed`,
        evidenceUris: [],
        nextStep: 'A regressed blocker/high issue blocks release; re-fix and re-verify.',
      });
    }
  }

  const releaseImpact = auditReleaseImpact(checks, blockingRecurrence);
  return { profile: opts.profile, state, releaseImpact, checks, issueIds, recurrenceWarnings };
}

/** Bounded, honest account-cycle: create (first-run) → logout (controlled explore). Steps that
 *  cannot be confirmed are reported blocked/needs_input/skipped, never a false pass. */
async function runAccountCycle(
  sessions: SessionStore,
  session: Session,
  driver: Driver,
  opts: MobileAuditRunOptions,
  finalize: (id: string, title: string, raw: RawCheckResult) => Promise<void>,
): Promise<AuditRunState> {
  if (!opts.allowGeneratedData) {
    const blocked: RawCheckResult = { status: 'blocked', category: 'missing_test_data', severity: 'medium', reason: 'account-cycle needs generated disposable-account data; re-run with allowGeneratedData in a test/staging environment', evidenceUris: [], workflow: 'account_cycle' };
    await finalize('create_account', 'Create account', blocked);
    await finalize('logout', 'Logout', { status: 'skipped', reason: 'account not created', evidenceUris: [] });
    await finalize('login_again', 'Login again', { status: 'skipped', reason: 'account not created', evidenceUris: [] });
    await finalize('forgot_password', 'Forgot password surface', { status: 'skipped', reason: 'account not created', evidenceUris: [] });
    return 'needs_input';
  }

  let createResult: RawCheckResult;
  let runState: AuditRunState = 'completed';
  try {
    const fr = await runFirstRun(sessions, session, driver, { mode: 'until_home', allowGeneratedAccount: true });
    switch (fr.accountOutcome) {
      case 'created':
      case 'used_provided_credentials':
        createResult = { status: 'pass', reason: `account ${fr.accountOutcome} (${fr.pathTaken ?? 'auth'})`, evidenceUris: fr.evidenceUris, workflow: 'account_cycle' };
        break;
      case 'reached_verification':
        createResult = { status: 'blocked', category: 'hard_gate', severity: 'medium', reason: 'account creation reached an OTP/verification gate (needs a real code)', evidenceUris: fr.evidenceUris, workflow: 'account_cycle' };
        runState = 'needs_input';
        break;
      case 'refused_unsafe':
        createResult = { status: 'blocked', category: 'missing_test_data', severity: 'medium', reason: fr.stoppedReason || 'environment unsafe for generated account creation', evidenceUris: fr.evidenceUris, workflow: 'account_cycle' };
        runState = 'unsafe';
        break;
      default:
        createResult = { status: 'blocked', reason: `account creation ${fr.accountOutcome}: ${fr.stoppedReason}`, evidenceUris: fr.evidenceUris, workflow: 'account_cycle' };
    }
  } catch (e) {
    createResult = { status: 'fail', category: 'app_bug', severity: 'high', reason: `account creation errored: ${String((e as Error).message ?? e)}`, evidenceUris: [], workflow: 'account_cycle' };
  }
  await finalize('create_account', 'Create account', createResult);

  // Logout is attempted only through the controlled disposable-account exploration (logout permitted
  // there; delete/pay/send stay refused). We cannot positively confirm a logout without app-specific
  // oracles, so the outcome is honest: skipped/blocked unless the create step already failed.
  if (createResult.status === 'pass') {
    // Controlled logout: find + tap a logout control (disposable account only) and READ the resulting
    // logged-out auth surface immediately — without a full exploration that would auto-re-login via the
    // stored generated credentials and hide the forgot-password entrypoint (REQ-08 account-cycle bug).
    const ev: AuditEvidenceCtx = { sessions, session, driver, appId: session.appId };
    let loggedOutText = '';
    try {
      const lo = await C.findAndTapLogout(ev, true);
      loggedOutText = lo.loggedOutText;
      if (lo.tapped && lo.authSurface) await finalize('logout', 'Logout', { status: 'pass', reason: 'logged out — reached a logged-out auth surface', evidenceUris: [], workflow: 'account_cycle' });
      else if (lo.tapped) await finalize('logout', 'Logout', { status: 'skipped', reason: 'tapped a logout control but did not clearly reach a logged-out auth surface — confirm manually', evidenceUris: [], workflow: 'account_cycle' });
      else await finalize('logout', 'Logout', { status: 'fail', category: 'improvement', severity: 'low', reason: 'no logout control found on the post-login screens', evidenceUris: [], workflow: 'account_cycle', nextStep: 'Expose a logout control once signed in.' });
    } catch (e) {
      await finalize('logout', 'Logout', { status: 'fail', category: 'app_bug', severity: 'high', reason: `logout attempt errored: ${String((e as Error).message ?? e)}`, evidenceUris: [], workflow: 'account_cycle' });
    }

    // Forgot-password is evaluated on the LOGGED-OUT auth surface captured above (right after logout),
    // BEFORE login_again returns to home — otherwise a valid "Forgot password?" link on the login
    // screen would be falsely reported missing. Finalized after login_again to keep output order.
    const forgotResult = C.checkForgotPassword(loggedOutText);

    // Login again: re-run first-run, which now reuses the generated credentials (hasProvidedCredentials
    // → login intent). Pass ONLY when an authenticated/home state is observed; OTP/MFA → needs_input.
    try {
      const fr2 = await runFirstRun(sessions, session, driver, { mode: 'until_home', allowGeneratedAccount: true });
      let login: RawCheckResult;
      if (fr2.state === 'completed') login = { status: 'pass', reason: `re-authenticated to home with the generated account (${fr2.pathTaken ?? 'login'})`, evidenceUris: fr2.evidenceUris, workflow: 'account_cycle' };
      else if (fr2.accountOutcome === 'reached_verification') login = { status: 'blocked', category: 'hard_gate', severity: 'medium', reason: 'login-again hit an OTP/verification gate (needs a real code)', evidenceUris: fr2.evidenceUris, workflow: 'account_cycle' };
      else if (fr2.needsInput) login = { status: 'blocked', category: 'hard_gate', severity: 'medium', reason: `login-again needs input: ${fr2.needsInput.reason}`, evidenceUris: fr2.evidenceUris, workflow: 'account_cycle' };
      else login = { status: 'fail', category: 'app_bug', severity: 'high', reason: `could not log back in with the generated account (${fr2.state}: ${fr2.stoppedReason})`, evidenceUris: fr2.evidenceUris, workflow: 'account_cycle' };
      await finalize('login_again', 'Login again', login);
    } catch (e) {
      await finalize('login_again', 'Login again', { status: 'fail', category: 'app_bug', severity: 'high', reason: `login-again errored: ${String((e as Error).message ?? e)}`, evidenceUris: [], workflow: 'account_cycle' });
    }

    // Finalize forgot-password with the evidence captured on the logged-out surface (above).
    await finalize('forgot_password', 'Forgot password surface', forgotResult);
  } else {
    for (const [id, title] of [['logout', 'Logout'], ['login_again', 'Login again'], ['forgot_password', 'Forgot password surface']] as const) {
      await finalize(id, title, { status: 'skipped', reason: 'account not established this run', evidenceUris: [], workflow: 'account_cycle' });
    }
  }
  return runState;
}

/** Plan-only: the profile checklist + account-cycle safety, without driving the device. */
export function planMobileAudit(profile: AuditProfile): { checks: ReturnType<typeof checksForProfile> } {
  return { checks: checksForProfile(profile) };
}
