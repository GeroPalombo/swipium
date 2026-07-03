// SWIPIUM-REQ-08 — executable mobile-audit checks. Each check observes the device through the
// Driver + evidence helpers and returns an honest result: it only reports `pass` when Swipium
// actually observed the evidence; otherwise `blocked`/`not_applicable`/`skipped`/`fail`. The runner
// (runner.ts) wraps these with id/title/profile and records issues for fail/blocked outcomes.
//
// Checks never purchase, bypass OTP, delete real accounts, or tap unknown external links.

import { rankCandidates } from '../explore/candidates.js';
import { allowsControlledLogout } from '../explore/policy.js';
import { parseSnapshot } from '../snapshot/parse.js';
import type { IssueCategory, IssueSeverity } from '../issues/schema.js';
import type { CheckStatus } from './results.js';
import { captureScreenshot, foreground, health, snapshotText, type AuditEvidenceCtx } from './evidence.js';

export interface RawCheckResult {
  status: CheckStatus;
  category?: IssueCategory;
  severity?: IssueSeverity;
  reason?: string;
  evidenceUris: string[];
  workflow?: string;
  screenId?: string;
  nextStep?: string;
}

const ok = (reason: string, evidenceUris: string[] = []): RawCheckResult => ({ status: 'pass', reason, evidenceUris });
const na = (reason: string): RawCheckResult => ({ status: 'not_applicable', reason, evidenceUris: [] });
const skip = (reason: string): RawCheckResult => ({ status: 'skipped', reason, evidenceUris: [] });

// ---- smoke ---------------------------------------------------------------------------------

export async function checkLaunch(ctx: AuditEvidenceCtx): Promise<RawCheckResult> {
  if (!ctx.appId) return skip('no app id known — cannot drive launch; relying on the current foreground app');
  try {
    await ctx.driver.terminateApp(ctx.appId).catch(() => {});
    await ctx.driver.launchApp(ctx.appId);
  } catch (e) {
    return {
      status: 'fail',
      category: 'app_bug',
      severity: 'blocker',
      reason: `app failed to launch: ${String((e as Error).message ?? e)}`,
      evidenceUris: [],
      nextStep: 'Confirm the app is installed and (for debug builds) Metro is reachable.',
    };
  }
  const fg = await foreground(ctx);
  const shot = await captureScreenshot(ctx, 'audit launch');
  const evidence = shot ? [shot] : [];
  if (fg && ctx.appId && fg.includes(ctx.appId.split('/')[0])) return ok(`launched, foreground=${fg}`, evidence);
  return {
    status: 'fail',
    category: 'app_bug',
    severity: 'high',
    reason: `expected ${ctx.appId} foreground, saw ${fg}`,
    evidenceUris: evidence,
  };
}

export async function checkHealthScan(ctx: AuditEvidenceCtx): Promise<RawCheckResult> {
  const h = await health(ctx);
  const shot = await captureScreenshot(ctx, 'audit health');
  const evidence = shot ? [shot] : [];
  if (!h.nativeHealthy) {
    const crash = h.nativeStatus === 'native_crash' || h.nativeStatus === 'anr';
    return {
      status: 'fail',
      category: 'blocker_app_bug',
      severity: 'blocker',
      reason: `native ${h.nativeStatus}`,
      evidenceUris: evidence,
      nextStep: crash ? 'Capture the crash/ANR log and fix it; do not blindly retry.' : undefined,
    };
  }
  if (h.appStatus === 'error')
    return {
      status: 'fail',
      category: 'blocker_app_bug',
      severity: 'blocker',
      reason: 'app error surface (RedBox/error boundary)',
      evidenceUris: evidence,
    };
  if (h.appStatus === 'degraded')
    return { status: 'fail', category: 'app_bug', severity: 'medium', reason: 'recoverable app warning (LogBox)', evidenceUris: evidence };
  return ok(`healthy (foreground=${h.foreground})`, evidence);
}

export async function checkNavigation(ctx: AuditEvidenceCtx): Promise<RawCheckResult> {
  let xml = '';
  try {
    xml = await ctx.driver.dumpXml();
  } catch {
    return skip('no UI tree available to evaluate navigation');
  }
  let elements;
  try {
    elements = parseSnapshot(xml).allNodes.map((n, i) => ({
      ref: `@n${i}`,
      role: n.cls,
      label: n.desc || undefined,
      text: n.text || undefined,
      id: n.id || undefined,
      clickable: n.clickable === true,
      bounds: n.bounds,
    }));
  } catch {
    return skip('could not parse the UI tree');
  }
  const candidates = rankCandidates(elements as never);
  const safe = candidates.find((c) => c.risk === 'safe' && c.bounds);
  if (!safe || !safe.bounds) return skip('no safe navigation control found on this screen');
  const before = await foreground(ctx);
  try {
    await ctx.driver.tapXY(Math.round(safe.bounds.x + safe.bounds.w / 2), Math.round(safe.bounds.y + safe.bounds.h / 2));
  } catch {
    return skip('navigation tap not supported on this backend');
  }
  const h = await health(ctx);
  if (!h.healthy)
    return {
      status: 'fail',
      category: 'app_bug',
      severity: 'high',
      reason: `navigation tap "${safe.label ?? ''}" produced ${h.nativeStatus}/${h.appStatus}`,
      evidenceUris: [],
    };
  const after = await foreground(ctx);
  return ok(`navigated safely via "${safe.label ?? safe.locator?.value ?? 'control'}" (${before}→${after})`);
}

// ---- store compliance ----------------------------------------------------------------------

function found(text: string, ...needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

export async function checkPrivacyLink(ctx: AuditEvidenceCtx, text: string): Promise<RawCheckResult> {
  const shot = await captureScreenshot(ctx, 'audit privacy');
  if (found(text, 'privacy policy', 'privacy notice')) return ok('Privacy Policy surface found', shot ? [shot] : []);
  return {
    status: 'fail',
    category: 'store_compliance',
    severity: 'high',
    reason: 'no Privacy Policy link found on the inspected screens',
    evidenceUris: shot ? [shot] : [],
    nextStep: 'Expose a Privacy Policy link (required for app stores).',
  };
}

export async function checkTermsLink(ctx: AuditEvidenceCtx, text: string): Promise<RawCheckResult> {
  const shot = await captureScreenshot(ctx, 'audit terms');
  if (found(text, 'terms of service', 'terms of use', 'terms and conditions', 'terms'))
    return ok('Terms surface found', shot ? [shot] : []);
  return {
    status: 'fail',
    category: 'store_compliance',
    severity: 'medium',
    reason: 'no Terms link found on the inspected screens',
    evidenceUris: shot ? [shot] : [],
  };
}

export async function checkAccountDeletion(ctx: AuditEvidenceCtx, text: string): Promise<RawCheckResult> {
  const hasAccountContext = found(text, 'account', 'profile', 'sign out', 'log out', 'settings');
  if (!hasAccountContext) return na('no account/profile surface observed — account deletion not applicable here');
  if (found(text, 'delete account', 'delete your account', 'data deletion', 'close account', 'remove account'))
    return ok('account deletion / data-deletion path found');
  return {
    status: 'fail',
    category: 'store_compliance',
    severity: 'high',
    reason: 'account surface present but no delete-account / data-deletion path found',
    evidenceUris: [],
    nextStep: 'Expose an account/data deletion flow (required where the app has accounts).',
  };
}

export async function checkSubscriptionManagement(ctx: AuditEvidenceCtx, text: string): Promise<RawCheckResult> {
  const hasSub = found(text, 'subscribe', 'subscription', 'premium', 'free trial', 'upgrade');
  if (!hasSub) return na('no subscription/paywall surface observed');
  if (found(text, 'restore purchase', 'restore purchases', 'manage subscription', 'manage your subscription'))
    return ok('restore / manage-subscription path found');
  return {
    status: 'fail',
    category: 'store_compliance',
    severity: 'medium',
    reason: 'subscription surface present but no restore-purchase / manage-subscription path found',
    evidenceUris: [],
  };
}

export async function checkPaywall(ctx: AuditEvidenceCtx, text: string): Promise<RawCheckResult> {
  const isPaywall = found(text, 'subscribe', 'free trial', 'start trial', 'unlock premium', 'upgrade to');
  if (!isPaywall) return na('no paywall observed');
  const hasFreePath = found(text, 'not now', 'maybe later', 'skip', 'continue free', 'no thanks', 'close', 'dismiss');
  if (hasFreePath) return ok('soft paywall with a free/dismiss path');
  return {
    status: 'blocked',
    category: 'hard_gate',
    severity: 'medium',
    reason: 'hard paywall with no permitted test path — recorded without purchase',
    evidenceUris: [],
    nextStep: 'A hard gate stops only this workflow, not the whole run.',
  };
}

export function checkExternalLinks(): RawCheckResult {
  return skip('external links are not auto-opened for safety — verify manually');
}

// ---- resilience ----------------------------------------------------------------------------

const OFFLINE_COPY = ['no internet', 'no connection', 'offline', 'check your connection', 'network unavailable', 'no network'];

export async function checkOfflineEntry(ctx: AuditEvidenceCtx): Promise<RawCheckResult> {
  try {
    await ctx.driver.setAirplane(true);
  } catch {
    return { status: 'blocked', reason: 'network manipulation unavailable on this backend', evidenceUris: [] };
  }
  const h = await health(ctx);
  const text = await snapshotText(ctx);
  const shot = await captureScreenshot(ctx, 'audit offline');
  const evidence = shot ? [shot] : [];
  if (!h.healthy)
    return {
      status: 'fail',
      category: 'app_bug',
      severity: 'high',
      reason: `app unhealthy offline (${h.nativeStatus}/${h.appStatus})`,
      evidenceUris: evidence,
    };
  if (found(text, ...OFFLINE_COPY)) return ok('app shows an expected offline state', evidence);
  return ok('app stayed healthy offline (no explicit offline message observed)', evidence);
}

export async function checkNetworkRestoration(ctx: AuditEvidenceCtx): Promise<RawCheckResult> {
  try {
    await ctx.driver.setAirplane(false);
  } catch {
    return { status: 'blocked', reason: 'network manipulation unavailable on this backend', evidenceUris: [] };
  }
  const h = await health(ctx);
  if (!h.healthy)
    return {
      status: 'fail',
      category: 'app_bug',
      severity: 'high',
      reason: `app did not recover after connectivity returned (${h.nativeStatus}/${h.appStatus})`,
      evidenceUris: [],
    };
  return ok('app recovered after network restoration');
}

export async function checkProcessRelaunch(ctx: AuditEvidenceCtx): Promise<RawCheckResult> {
  if (!ctx.appId) return skip('no app id known — cannot drive a kill/relaunch');
  try {
    await ctx.driver.terminateApp(ctx.appId);
    await ctx.driver.launchApp(ctx.appId);
  } catch (e) {
    return {
      status: 'fail',
      category: 'app_bug',
      severity: 'high',
      reason: `relaunch failed: ${String((e as Error).message ?? e)}`,
      evidenceUris: [],
    };
  }
  const h = await health(ctx);
  const shot = await captureScreenshot(ctx, 'audit relaunch');
  if (!h.healthy)
    return {
      status: 'fail',
      category: 'app_bug',
      severity: 'high',
      reason: `app unhealthy after relaunch (${h.nativeStatus}/${h.appStatus})`,
      evidenceUris: shot ? [shot] : [],
    };
  return ok('app returned to a sane state after kill/relaunch', shot ? [shot] : []);
}

export function checkRotation(): RawCheckResult {
  return skip('rotation is not driven automatically — verify manually where supported');
}

// ---- account-cycle: controlled logout ------------------------------------------------------

export interface LogoutResult {
  tapped: boolean;
  /** Visible text of the screen AFTER the logout tap — the logged-out auth surface, when reached. */
  loggedOutText: string;
  /** Whether the post-logout screen looks like a logged-out auth/login surface. */
  authSurface: boolean;
}

/**
 * Find and tap a "Log out" control on the current screen, gated by the controlled account-cycle
 * policy (logout permitted only on a disposable account; delete/pay/send stay refused). Returns the
 * post-logout screen text so the caller can check the forgot-password entrypoint on the LOGGED-OUT
 * surface — without a full exploration that would auto-re-login via stored credentials.
 */
export async function findAndTapLogout(ctx: AuditEvidenceCtx, disposableAccount: boolean): Promise<LogoutResult> {
  let xml = '';
  try {
    xml = await ctx.driver.dumpXml();
  } catch {
    return { tapped: false, loggedOutText: '', authSurface: false };
  }
  let nodes;
  try {
    nodes = parseSnapshot(xml).allNodes;
  } catch {
    return { tapped: false, loggedOutText: '', authSurface: false };
  }
  const logout = nodes.find((n) => n.clickable && /log\s?out|sign\s?out/i.test(`${n.text} ${n.desc} ${n.id}`));
  if (!logout) return { tapped: false, loggedOutText: await snapshotText(ctx), authSurface: false };
  // Controlled exception: only a genuine logout, only on a disposable account.
  if (!allowsControlledLogout({ label: logout.text || logout.desc, id: logout.id }, { accountCycle: true, disposableAccount })) {
    return { tapped: false, loggedOutText: await snapshotText(ctx), authSurface: false };
  }
  const [x1, y1, x2, y2] = logout.bounds;
  try {
    await ctx.driver.tapXY(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
  } catch {
    return { tapped: false, loggedOutText: await snapshotText(ctx), authSurface: false };
  }
  const loggedOutText = await snapshotText(ctx);
  const authSurface = /sign\s?in|log\s?in|email|password|username|forgot|create account/.test(loggedOutText);
  return { tapped: true, loggedOutText, authSurface };
}

/**
 * Evaluate the forgot-password entrypoint from the LOGGED-OUT auth surface (captured right after
 * logout, before any re-login). Pass when a forgot/reset link is present; a confirmed login screen
 * without one is an improvement; if logout couldn't reach an auth surface, return blocked rather than
 * falsely failing (REQ-08 account-cycle bug fix).
 */
export function checkForgotPassword(loggedOutText: string): RawCheckResult {
  const isAuthSurface = /sign\s?in|log\s?in|email|password|username|forgot|create account/.test(loggedOutText);
  const hasForgot = /forgot.?password|reset.?password|forgot your password|trouble signing in/.test(loggedOutText);
  if (hasForgot)
    return {
      status: 'pass',
      reason: 'forgot-password entrypoint is present on the logged-out auth surface (not exercised — Swipium never consumes email/OTP)',
      evidenceUris: [],
      workflow: 'account_cycle',
    };
  if (isAuthSurface)
    return {
      status: 'fail',
      category: 'improvement',
      severity: 'low',
      reason: 'no forgot-password entrypoint on the logged-out login screen',
      evidenceUris: [],
      workflow: 'account_cycle',
      nextStep: 'Add a forgot/reset-password entrypoint on the login screen.',
    };
  return {
    status: 'blocked',
    reason: 'logout not confirmed — could not reach the logged-out auth surface to check the forgot-password entrypoint',
    evidenceUris: [],
    workflow: 'account_cycle',
  };
}

// ---- readiness -----------------------------------------------------------------------------

export async function checkLocatorReadiness(ctx: AuditEvidenceCtx): Promise<RawCheckResult> {
  let xml = '';
  try {
    xml = await ctx.driver.dumpXml();
  } catch {
    return skip('no UI tree available to assess locator readiness');
  }
  let nodes;
  try {
    nodes = parseSnapshot(xml).allNodes;
  } catch {
    return skip('could not parse the UI tree');
  }
  const clickable = nodes.filter((n) => n.clickable === true);
  if (clickable.length === 0) return skip('no interactive controls on this screen');
  const durable = clickable.filter((n) => n.id || n.desc);
  const pct = Math.round((durable.length / clickable.length) * 100);
  if (pct >= 70) return ok(`${pct}% of interactive controls have durable locators`);
  return {
    status: 'fail',
    category: 'accessibility_readiness',
    severity: 'low',
    reason: `only ${pct}% of interactive controls have durable locators (testID/accessibility id)`,
    evidenceUris: [],
    nextStep: 'Add accessibility identifiers / testIDs to important controls.',
  };
}
