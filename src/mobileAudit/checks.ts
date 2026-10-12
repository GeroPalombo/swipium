// Executable mobile-audit checks. Each check observes the device through the
// Driver + evidence helpers and returns an honest result: it only reports `pass` when Swipium
// actually observed the evidence; otherwise `blocked`/`not_applicable`/`skipped`/`fail`. The runner
// (runner.ts) wraps these with id/title/profile and records issues for fail/blocked outcomes.
//
// Checks never purchase, bypass OTP, delete real accounts, or tap unknown external links.

import { rankCandidates } from '../explore/candidates.js';
import { allowsControlledLogout } from '../explore/policy.js';
import { parseSnapshot } from '../snapshot/parse.js';
import { waitForAppRender, type RenderWaitResult } from '../snapshot/renderWait.js';
import type { IssueCategory, IssueSeverity } from '../issues/schema.js';
import type { CheckStatus } from './results.js';
import { isAbortError } from '../lib/abortScope.js';
import { metroListening } from '../lib/metroState.js';
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
  /** Stable failure code (src/oracle/failures.ts) for a blocked / failed check, e.g. BLANK_SCREEN. */
  failureCode?: string;
}

const ok = (reason: string, evidenceUris: string[] = []): RawCheckResult => ({ status: 'pass', reason, evidenceUris });
const na = (reason: string): RawCheckResult => ({ status: 'not_applicable', reason, evidenceUris: [] });
const skip = (reason: string): RawCheckResult => ({ status: 'skipped', reason, evidenceUris: [] });

// ---- smoke ---------------------------------------------------------------------------------

export async function checkLaunch(ctx: AuditEvidenceCtx): Promise<RawCheckResult> {
  if (!ctx.appId) return skip('no app id known, cannot drive launch; relying on the current foreground app');
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
  // The relaunched app shows its splash first: the health / navigation / readiness checks that follow
  // read the tree, and judged an empty splash ("no interactive controls", GOAL-26).
  const render = await renderWait(ctx);
  const fg = await foreground(ctx);
  const shot = await captureScreenshot(ctx, 'audit launch');
  const evidence = shot ? [shot] : [];
  // `no_tree`: no UI tree was ever read, so nothing was judged; the foreground check below decides.
  if (render && !render.ready && render.reason !== 'no_tree')
    return {
      status: 'blocked',
      reason: render.loadingText
        ? `app never finished rendering: "${render.loadingText}" still visible after ${Math.round(render.waitedMs / 1000)} s`
        : `app showed only a blank / splash screen after ${Math.round(render.waitedMs / 1000)} s; launch not verified`,
      evidenceUris: evidence,
      failureCode: 'BLANK_SCREEN',
      nextStep: 'For a debug RN/Expo build, wait until Metro finished bundling (qa_wait { for:"metro_ready" }) and re-run.',
    };
  if (fg && ctx.appId && fg.includes(ctx.appId.split('/')[0])) return ok(`launched, foreground=${fg}`, evidence);
  return {
    status: 'fail',
    category: 'app_bug',
    severity: 'high',
    reason: `expected ${ctx.appId} foreground, saw ${fg}`,
    evidenceUris: evidence,
  };
}

/** Bounded wait for the app's first rendered screen (one dump when it already rendered). */
async function renderWait(ctx: AuditEvidenceCtx): Promise<RenderWaitResult | undefined> {
  return waitForAppRender(ctx.driver, {
    visualOnly: ctx.session.mode === 'visual-fallback' || ctx.driver.kind === 'simulator',
    timeoutMs: 20_000,
    metroProbe: () => metroListening(),
  }).catch((e) => {
    if (isAbortError(e)) throw e;
    return undefined;
  });
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
  return ok(`navigated safely via "${safe.label ?? safe.locator?.value ?? 'control'}" (${before} > ${after})`);
}

// ---- store compliance ----------------------------------------------------------------------

function found(text: string, ...needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

/** GOAL-26: "no check passes without evidence" applies to failures too. Only the current screen is
 *  inspected, so a link/path that is not on it is NOT VERIFIED (blocked, no issue recorded), never a
 *  store-compliance fail: it usually lives under Settings / About / Profile. */
function notVerifiedOnThisScreen(what: string, evidenceUris: string[] = []): RawCheckResult {
  return {
    status: 'blocked',
    reason: `not verified: no ${what} on the inspected screen (only the current screen is checked; it is usually under Settings / About / Profile)`,
    evidenceUris,
    nextStep: `Navigate to Settings / About (qa_act) and re-run the audit there, or verify the ${what} manually.`,
  };
}

export async function checkPrivacyLink(ctx: AuditEvidenceCtx, text: string): Promise<RawCheckResult> {
  const shot = await captureScreenshot(ctx, 'audit privacy');
  if (found(text, 'privacy policy', 'privacy notice')) return ok('Privacy Policy surface found', shot ? [shot] : []);
  return notVerifiedOnThisScreen('Privacy Policy link', shot ? [shot] : []);
}

export async function checkTermsLink(ctx: AuditEvidenceCtx, text: string): Promise<RawCheckResult> {
  const shot = await captureScreenshot(ctx, 'audit terms');
  if (found(text, 'terms of service', 'terms of use', 'terms and conditions', 'terms'))
    return ok('Terms surface found', shot ? [shot] : []);
  return notVerifiedOnThisScreen('Terms link', shot ? [shot] : []);
}

export async function checkAccountDeletion(ctx: AuditEvidenceCtx, text: string): Promise<RawCheckResult> {
  const hasAccountContext = found(text, 'account', 'profile', 'sign out', 'log out', 'settings');
  if (!hasAccountContext) return na('no account/profile surface observed, account deletion not applicable here');
  if (found(text, 'delete account', 'delete your account', 'data deletion', 'close account', 'remove account'))
    return ok('account deletion / data-deletion path found');
  return notVerifiedOnThisScreen('delete-account / data-deletion path (an account surface is present)');
}

export async function checkSubscriptionManagement(ctx: AuditEvidenceCtx, text: string): Promise<RawCheckResult> {
  const hasSub = found(text, 'subscribe', 'subscription', 'premium', 'free trial', 'upgrade');
  if (!hasSub) return na('no subscription/paywall surface observed');
  if (found(text, 'restore purchase', 'restore purchases', 'manage subscription', 'manage your subscription'))
    return ok('restore / manage-subscription path found');
  return notVerifiedOnThisScreen('restore-purchase / manage-subscription path (a subscription surface is present)');
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
    reason: 'hard paywall with no permitted test path, recorded without purchase',
    evidenceUris: [],
    nextStep: 'A hard gate stops only this workflow, not the whole run.',
  };
}

export function checkExternalLinks(): RawCheckResult {
  return skip('external links are not auto-opened for safety; verify manually');
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
  if (!ctx.appId) return skip('no app id known, cannot drive a kill/relaunch');
  try {
    await ctx.driver.terminateApp(ctx.appId);
    await ctx.driver.launchApp(ctx.appId);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    // A WDA / transport timeout is a tool or environment failure, not an app bug (R5 must-fix 3).
    if (isAbortError(e)) throw e;
    if (TOOL_ERROR_RE.test(msg)) return toolBlocked(`relaunch could not be driven: ${msg}`);
    return { status: 'fail', category: 'app_bug', severity: 'high', reason: `relaunch failed: ${msg}`, evidenceUris: [] };
  }
  // Same render wait as the smoke's launch check: judging the splash right after a relaunch read a
  // WDA hiccup or an empty tree as an unhealthy app. The wait's last tree feeds the health check, so
  // a rendered app costs one dump, not two.
  const render = await renderWait(ctx);
  const h = await health(ctx, render?.xml);
  const shot = await captureScreenshot(ctx, 'audit relaunch');
  const evidence = shot ? [shot] : [];
  if (h.deviceGone || h.nativeStatus === 'wda_unreachable')
    return toolBlocked(
      h.deviceGone ? 'the device went offline after the relaunch' : 'WebDriverAgent did not return a UI source after the relaunch',
      evidence,
    );
  if (!h.healthy)
    return {
      status: 'fail',
      category: 'app_bug',
      severity: 'high',
      reason: `app unhealthy after relaunch (${h.nativeStatus}/${h.appStatus})`,
      evidenceUris: evidence,
    };
  return ok('app returned to a sane state after kill/relaunch', evidence);
}

/** A driver / WDA transport failure, not something the app did. */
const TOOL_ERROR_RE = /timed? ?out|timeout|ECONNREFUSED|ECONNRESET|socket hang up|WebDriverAgent|\bWDA\b/i;

/** Blocked with no category: the runner records no issue and the release impact is at most WARN. */
function toolBlocked(reason: string, evidenceUris: string[] = []): RawCheckResult {
  return {
    status: 'blocked',
    reason: `${reason} (tool / environment, not an app bug)`,
    evidenceUris,
    nextStep: 'Check the device connection (and WebDriverAgent on iOS), then re-run the audit.',
  };
}

export function checkRotation(): RawCheckResult {
  return skip('rotation is not driven automatically; verify manually where supported');
}

// ---- account-cycle: controlled logout ------------------------------------------------------

export interface LogoutResult {
  tapped: boolean;
  /** Visible text of the screen AFTER the logout tap (the logged-out auth surface, when reached). */
  loggedOutText: string;
  /** Whether the post-logout screen looks like a logged-out auth/login surface. */
  authSurface: boolean;
}

/**
 * Find and tap a "Log out" control on the current screen, gated by the controlled account-cycle
 * policy (logout permitted only on a disposable account; delete/pay/send stay refused). Returns the
 * post-logout screen text so the caller can check the forgot-password entrypoint on the LOGGED-OUT
 * surface, without a full exploration that would auto-re-login via stored credentials.
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
 * falsely failing (account-cycle bug fix).
 */
export function checkForgotPassword(loggedOutText: string): RawCheckResult {
  const isAuthSurface = /sign\s?in|log\s?in|email|password|username|forgot|create account/.test(loggedOutText);
  const hasForgot = /forgot.?password|reset.?password|forgot your password|trouble signing in/.test(loggedOutText);
  if (hasForgot)
    return {
      status: 'pass',
      reason: 'forgot-password entrypoint is present on the logged-out auth surface (not exercised: Swipium never consumes email/OTP)',
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
    reason: 'logout not confirmed: could not reach the logged-out auth surface to check the forgot-password entrypoint',
    evidenceUris: [],
    workflow: 'account_cycle',
  };
}

// ---- readiness -----------------------------------------------------------------------------

export async function checkLocatorReadiness(ctx: AuditEvidenceCtx): Promise<RawCheckResult> {
  const render = await renderWait(ctx); // earlier checks may have relaunched / backgrounded the app
  let xml = '';
  try {
    xml = render?.xml ?? (await ctx.driver.dumpXml());
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
