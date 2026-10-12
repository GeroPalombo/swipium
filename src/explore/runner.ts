// Guided exploration runner (Phase 3.3 Milestones D/E/G). Bounded, safe-by-default screen crawl:
// observe > signature > rank safe candidates > act > health-check > record edge, until a budget is
// reached. Visual-only screens (poor UI tree) are verified with a screenshot + visual assertion
// instead of blind coordinate crawling. Honest: unsafe actions are skipped with a note; an auth
// wall with no credentials returns NeedsInput. Drives only the Driver interface, no MCP-over-MCP.

import { parseSnapshot } from '../snapshot/parse.js';
import { settle } from '../snapshot/settle.js';
import { waitForAppRender } from '../snapshot/renderWait.js';
import { iosAlertCancel, ownsForeground, permissionDeniedNote } from '../snapshot/overlays.js';
import { noteScreenMutation } from '../snapshot/fresh.js';
import { checkHealth } from '../oracle/health.js';
import { recordHealthFindings } from '../oracle/record.js';
import { CancelledError, isAbortError } from '../lib/abortScope.js';
import { ExploreGraph, type ScreenNode, type EdgeOutcome } from './graph.js';
import { structuredSignature, visualSignature } from './signatures.js';
import { actionLikeNonInteractive, rankCandidates, locatorQuality, type RankedCandidate, type SkippedActionLike } from './candidates.js';
import { allowedUnder, allowsControlledLogout, isThirdPartySignIn, type SafeMode } from './policy.js';
import { FEATURE_KEYS, coverageClaimsFrom, estimateFeatureCoverage, inferAppDomain, proposeTasks, reflectExploration } from './planner.js';
import { scorePromotionCandidates, type SuitePromotionCandidate } from './suite.js';
import { hasDisposableState, resolveFixtureValue, type ResolvedFixtureValue } from '../fixtures/catalog.js';
import { fieldKindFromHints } from '../firstRun/classifyScreen.js';
import { generateFieldValue, type TestDataPolicy } from '../firstRun/generatedDataPolicy.js';
import { resolveFirstRunPolicy } from '../firstRun/firstRunRunner.js';
import type { FieldKind } from '../firstRun/types.js';
import { NeedsInput, type NeedsInputPayload } from '../lib/needsInput.js';
import type { Driver } from '../drivers/Driver.js';
import type { SelectorProvenance, Session, SessionStore, RecordedAction } from '../session/store.js';

export interface DestructiveCandidateSummary {
  screenSignature: string;
  candidateSignature: string;
  label?: string;
  locator?: unknown;
  riskClass?: string;
}

export interface ExploreOptions {
  goal?: string;
  depth?: number;
  maxActions?: number;
  maxScreens?: number;
  maxDurationMs?: number;
  safeMode?: SafeMode;
  strategy?: 'crawl' | 'task_planner' | 'hybrid';
  destructiveApproval?: {
    sessionId: string;
    screenSignature: string;
    candidateSignature: string;
    label?: string;
    locator?: { strategy?: string; value?: string };
    riskClass?: string;
    consentId?: string;
    confirmHighImpact?: boolean;
    expiresAt?: number;
    singleUse?: boolean;
    requiresDisposableState?: boolean;
  };
  includeTextEntry?: boolean;
  stopOnAuth?: boolean;
  generateSuite?: boolean;
  /** Allow built-in safe generators to fill fields when the environment is a
   *  disposable test/staging one (off by default: exploration never invents values otherwise). */
  allowGeneratedData?: boolean;
  testDataPolicyPath?: string;
  /** The controlled mobile-audit account-cycle workflow. When enabled on a
   *  disposable generated account, LOGOUT (and only logout) is permitted as an expected step;
   *  delete/pay/send stay refused. Off by default, so broad exploration keeps logout destructive. */
  accountCycle?: { enabled: boolean; disposableAccount: boolean };
}

export interface TestabilityBlocker {
  screen: string;
  visibleText?: string;
  role: string;
  bounds: { x: number; y: number; w: number; h: number };
  clickable: boolean;
  recommendation: string;
  manualCandidate: { x: number; y: number };
}

export interface ExploreSummary {
  screensVisited: number;
  actionsTried: number;
  workflowsFound: number;
  blockers: number;
  appErrors: number;
  visualOnlyScreens: number;
  unsafeActionsSkipped: number;
  featureCoverage: Record<(typeof FEATURE_KEYS)[number], string>;
  destructiveCandidates: number;
  promotedSuiteCandidates: number;
  testabilityBlockers: TestabilityBlocker[];
}

export interface ExploreResult {
  graph: ExploreGraph;
  summary: ExploreSummary;
  needsInput?: NeedsInputPayload;
  state: 'completed' | 'blocked' | 'needs_input';
  stoppedReason: string;
  suitePromotion: SuitePromotionCandidate[];
  destructiveCandidates: DestructiveCandidateSummary[];
}

export interface ExploreCtx {
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

const AUTH_RE = /\b(sign in|log\s?in|password|email|username|continue with|create account)\b/i;

function hasCredentials(session: Session): boolean {
  return session.inputs.some((i) => /EMAIL|PASSWORD/.test(i.varName));
}

/**
 * Find a safe value to type into a field. Priority (the input planner):
 * secure inputs > declared fixtures > built-in safe generator (ONLY when `gen.allowed`, i.e. the
 * environment is a disposable test/staging one) > otherwise undefined (the runner skips honestly).
 * Default behavior is unchanged: with no generation context, values are never invented.
 */
type FieldValue = ResolvedFixtureValue | { value: string; varName: string; secret: boolean; source: 'secure_input' };

/** Generation context threaded from runExplore when policy + environment allow safe test data. */
export interface GeneratedDataContext {
  allowed: boolean;
  policy: TestDataPolicy;
}

function generatorVarFor(field: FieldKind): string {
  if (field === 'email') return 'SWIPIUM_TEST_EMAIL';
  if (field === 'password' || field === 'confirm_password') return 'SWIPIUM_TEST_PASSWORD';
  if (field === 'otp') return 'SWIPIUM_TEST_OTP';
  return `SWIPIUM_GEN_${field.toUpperCase()}`;
}

function valueForField(
  session: Session,
  label?: string,
  locatorValue?: string,
  role?: string,
  secure?: boolean,
  gen?: GeneratedDataContext,
): FieldValue | undefined {
  const key = `${label ?? ''} ${locatorValue ?? ''}`.toLowerCase();
  const fromStore = (varName: string, isSecret: boolean): FieldValue | undefined => {
    const value = session.inputValues.get(varName);
    return value ? { value, varName, secret: isSecret, source: 'secure_input' } : undefined;
  };
  if (/pass/.test(key) || secure) {
    const v = fromStore('SWIPIUM_TEST_PASSWORD', true);
    if (v) return v;
  }
  if (/email|user|account|login/.test(key)) {
    const v = fromStore('SWIPIUM_TEST_EMAIL', false);
    if (v) return v;
  }
  if (/otp|code|2fa|mfa/.test(key)) {
    const v = fromStore('SWIPIUM_TEST_OTP', true);
    if (v) return v;
  }
  const resolved = resolveFixtureValue(session, label, locatorValue, { role });
  if (resolved) return resolved;
  // Built-in safe generator, only when generation is explicitly allowed for this environment.
  if (gen?.allowed) {
    const field = fieldKindFromHints(label, locatorValue, undefined, secure);
    const g = generateFieldValue(field, gen.policy);
    if (g) {
      const varName = generatorVarFor(field);
      session.inputValues.set(varName, g.value);
      if (g.secret) session.secrets.add(g.value);
      session.generatedValues.push({
        at: Date.now(),
        fixture: 'generated',
        field,
        varName,
        generator: g.generator,
        value: g.value,
        secret: g.secret,
      });
      return { value: g.value, varName, secret: g.secret, fixture: 'generated', field, source: 'generator' };
    }
  }
  return undefined;
}

/** LOG-22: a human screen name from the UI tree: the top-most short, non-clickable text in the top
 *  band (toolbar / large title). Undefined when there is none (the caller falls back to the
 *  foreground package). */
function screenTitleOf(
  elements: Array<{ text?: string; label?: string; clickable: boolean; bounds: [number, number, number, number] }>,
): string | undefined {
  if (!elements.length) return undefined;
  const height = Math.max(...elements.map((e) => e.bounds[3] || 0));
  const top = height ? height * 0.28 : Number.POSITIVE_INFINITY;
  const candidates = elements
    .map((e) => ({ e, t: (e.text || e.label || '').trim() }))
    .filter(({ e, t }) => !e.clickable && t.length >= 2 && t.length <= 40 && !/^\d[\d:.,\s]*$/.test(t))
    .sort((a, b) => a.e.bounds[1] - b.e.bounds[1]);
  return (candidates.find(({ e }) => e.bounds[1] <= top) ?? candidates[0])?.t;
}

function strategyToKind(strategy: string): RecordedAction['selectorKind'] {
  switch (strategy) {
    case 'accessibility':
      return 'accessibility_id';
    case 'id':
      return 'resource_id'; // Android resource-id > durable id= selector (not a text match)
    case 'text':
      return 'text';
    default:
      return 'coords';
  }
}

function boundsBucket(bounds?: RankedCandidate['bounds']): string | undefined {
  if (!bounds) return undefined;
  const bucket = (n: number) => Math.floor(n / 50) * 50;
  return `${bucket(bounds.x)},${bucket(bounds.y)},${bucket(bounds.x + bounds.w)},${bucket(bounds.y + bounds.h)}`;
}

function provenanceForCandidate(node: ScreenNode, candidate: RankedCandidate): SelectorProvenance {
  return {
    originalScreenSignature: node.signature,
    elementRole: candidate.role,
    text: candidate.label,
    resourceId: candidate.locator?.strategy === 'id' ? candidate.locator.value : undefined,
    boundsBucket: boundsBucket(candidate.bounds),
    screenshotUri: node.screenshotUri,
    selectorKind: candidate.locator?.strategy,
    selectorValue: candidate.locator?.value,
  };
}

function destructiveMutationTarget(
  session: Session,
  node: ScreenNode,
  candidate: RankedCandidate,
  approval: ExploreOptions['destructiveApproval'],
): Record<string, unknown> {
  return {
    sessionId: session.id,
    screenSignature: node.signature,
    candidateSignature: candidate.signatureKey,
    label: candidate.label ?? null,
    locator: candidate.locator ?? null,
    riskClass: candidate.riskClass ?? null,
    stepUp: candidate.stepUp ?? false,
    requiresTwoStepConfirmation: candidate.requiresTwoStepConfirmation ?? false,
    confirmHighImpact: approval?.confirmHighImpact === true,
    requiresDisposableState: true,
  };
}

export async function runExplore(
  sessions: SessionStore,
  session: Session,
  driver: Driver,
  opts: ExploreOptions,
  ctx: ExploreCtx = {},
): Promise<ExploreResult> {
  const platform = driver.kind === 'wda' || driver.kind === 'simulator' ? 'ios' : 'android';
  const graph = new ExploreGraph(platform);
  const safeMode: SafeMode = opts.safeMode === 'approved_destructive' ? 'strict' : (opts.safeMode ?? 'strict');
  const maxActions = opts.maxActions ?? 20;
  const maxScreens = opts.maxScreens ?? 12;
  const depth = opts.depth ?? 3;
  const stopOnAuth = opts.stopOnAuth ?? true;
  let authNoted = false;
  // Resolve the generated-data decision once. Only "allowed" when policy + the
  // classified environment (test/staging) permit safe throwaway data; otherwise generation is off.
  const genCtx: GeneratedDataContext | undefined = opts.allowGeneratedData
    ? (() => {
        const r = resolveFirstRunPolicy(session, { testDataPolicyPath: opts.testDataPolicyPath, allowGeneratedAccount: true });
        return { allowed: r.decision.allowed, policy: r.policy };
      })()
    : undefined;
  const startedAt = Date.now();
  const deadline = startedAt + (opts.maxDurationMs ?? 6 * 60_000);
  const signal = ctx.signal;
  const progress = (t: string) => ctx.onProgress?.(t);

  const summary: ExploreSummary = {
    screensVisited: 0,
    actionsTried: 0,
    workflowsFound: 0,
    blockers: 0,
    appErrors: 0,
    visualOnlyScreens: 0,
    unsafeActionsSkipped: 0,
    featureCoverage: Object.create(null),
    destructiveCandidates: 0,
    promotedSuiteCandidates: 0,
    testabilityBlockers: [],
  };
  const exploredPerScreen = new Map<string, Set<string>>(); // nodeId > explored signatureKeys
  // LOG-22: control (signatureKey) > screen it already led to. The same overflow button or tab on
  // another screen opens a screen we have seen, so it is not worth an action again.
  const ledTo = new Map<string, string>();
  const skippedNotedScreens = new Set<string>();
  const testabilityNotedScreens = new Set<string>();
  const destructiveCandidates = new Map<string, DestructiveCandidateSummary>();
  let lastNodeId: string | undefined;
  let consecutiveNoChange = 0;
  let leftAppCount = 0;
  let sameScreenEdges = 0;
  // GOAL NEW-R4-1: navigation steps (back, relaunch, alert close) are device actions too: they count
  // against maxActions with the taps. A back is checked on the next observe (pendingBack); a screen
  // whose back did not leave it is never backed out of again.
  let navSteps = 0;
  let pendingBack: string | undefined;
  const backFailed = new Set<string>();
  const inAppBackTried = new Set<string>();
  let relaunches = 0;
  let rootAfterRelaunch = false;
  let alertDismissals = 0;
  let planned = false;

  // GOAL-9: never map the RN splash / "Bundling 47%" screen as the app's first screen. Bounded;
  // returns after one dump when the screen already looks rendered.
  try {
    await waitForAppRender(driver, { visualOnly: session.mode === 'visual-fallback' || driver.kind === 'simulator', timeoutMs: 20_000 });
  } catch {
    // A cancel here falls through: the main loop sees the aborted signal and stops as "cancelled"
    // with the (empty) graph finalized, like a cancel at any later point.
  }

  const note = (n: Parameters<SessionStore['addNote']>[1] extends infer T ? Omit<NonNullable<T>, 'at'> : never) =>
    sessions.addNote(session, { at: Date.now(), ...(n as object) } as Parameters<SessionStore['addNote']>[1]);

  // The last settle's final dump, consumed by the next observe() instead of dumping again (P5).
  let settledXml: string | undefined;
  const settleAndKeep = async (timeoutMs: number) => {
    settledXml = (await settle(driver, { timeoutMs }).catch(() => undefined))?.xml || undefined;
  };

  /** Observe the current screen as a graph node (structured or visual-only). */
  const observe = async (): Promise<{
    node: ScreenNode;
    isNew: boolean;
    candidates: RankedCandidate[];
    visual: boolean;
    authWall: boolean;
    actionLikeSkipped: SkippedActionLike[];
    foreground: string;
    leftApp: boolean;
    alert: ReturnType<typeof iosAlertCancel>;
  }> => {
    let xml = '';
    let elements: ReturnType<typeof parseSnapshot>['elements'] = [];
    let webviewDominance = 0;
    let alert: ReturnType<typeof iosAlertCancel> = null;
    const seeded = settledXml;
    settledXml = undefined;
    // Respect the SESSION screenshot budget (not a separate fixed counter) so two observes per
    // action can't overshoot the cap (P2 fix). The screenshot runs alongside the dump (P5).
    const wantShot = !session.sensitive && session.counters.screenshots < session.budget.maxScreenshots;
    const [dumped, shot] = await Promise.all([
      seeded !== undefined
        ? Promise.resolve<string | Error>(seeded)
        : driver.dumpXml().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
      wantShot ? driver.screenshot().catch(() => undefined) : Promise.resolve(undefined),
    ]);
    if (dumped instanceof Error) {
      // Cancelled job: an aborted dump is not a visual-only screen, a finding or a blocker.
      if (isAbortError(dumped, signal)) throw new CancelledError('exploration cancelled');
      /* snapshot failed, so treated as visual-only below */
    } else {
      try {
        xml = dumped;
        const parsed = parseSnapshot(xml);
        elements = parsed.elements;
        webviewDominance = parsed.quality.signals.webviewDominance;
        alert = iosAlertCancel(parsed.allNodes);
      } catch {
        /* unparsable dump, so treated as visual-only below */
      }
    }
    if (signal?.aborted) throw new CancelledError('exploration cancelled');
    const health = await checkHealth(driver, session.appId, xml || undefined);
    // P5: the health check already resolved the foreground (from the dump's root package when it is
    // the app under test, else dumpsys), so no separate up-front foregroundOwner call.
    const foreground = health.foreground;
    if (health.cancelled || signal?.aborted) throw new CancelledError('exploration cancelled');
    await recordHealthFindings(sessions, session, health.findings, driver, health.foreground);
    if (!health.nativeHealthy) summary.appErrors += 0; // native handled separately below
    const healthSnap = {
      native: (health.nativeHealthy ? 'OK' : 'error') as 'OK' | 'error',
      app: health.appStatus === 'error' ? ('error' as const) : health.appStatus === 'degraded' ? ('degraded' as const) : ('OK' as const),
    };

    const png: Buffer | undefined = shot;

    // Visual-only (Milestone E): no usable structured elements (canvas/map/webview/empty) means visual
    // node + assertion, no blind coordinate crawl. A low automation-readiness verdict on a screen
    // that DOES expose identified elements is still structured (we can act on it).
    const visual = elements.length === 0 || webviewDominance > 0.5;
    // IOS NEW-6: auth wording alone (an optional "Sign in to your Apple Account" row on Settings) is not
    // a wall. It is one when there is a secure field, or auth wording on a screen with an input field
    // or few other controls to explore.
    const authText = AUTH_RE.test(elements.map((e) => e.text || e.label || '').join(' '));
    const otherControls = elements.filter((e) => e.clickable && !AUTH_RE.test(`${e.text ?? ''} ${e.label ?? ''}`)).length;
    const hasInput = elements.some(
      (e) => /EditText|Text[-_ ]?Field|TextInput|SearchView/i.test(e.role) && !/search/i.test(`${e.id ?? ''} ${e.label ?? ''}`),
    );
    const authWall = elements.some((e) => e.secure) || (authText && (hasInput || otherControls < 4));
    const ctxSig = { foreground, keyboardShown: false };
    let signature: string;
    let candidates: RankedCandidate[] = [];
    let actionLikeSkipped: SkippedActionLike[] = [];
    if (visual) {
      const size = (await driver.screenSize().catch(() => null)) ?? { width: 0, height: 0 };
      signature = png ? visualSignature(png, size, ctxSig) : `visual:noshot:${foreground}`;
    } else {
      signature = structuredSignature(elements, ctxSig);
      candidates = rankCandidates(elements, { includeTextEntry: opts.includeTextEntry });
      if (candidates.length === 0) actionLikeSkipped = actionLikeNonInteractive(elements);
    }

    // GOAL NEW-R3-3: one evidence screenshot per screen. A revisit (back navigation, a re-observe while
    // a slow app renders) keeps the screen's first shot and costs no screenshot budget; an app error
    // always gets fresh evidence. The capture itself still feeds the visual signature above.
    let screenshotUri: string | undefined;
    if (png && (!graph.bySignature(signature)?.screenshotUri || healthSnap.app === 'error')) {
      try {
        screenshotUri = sessions.saveArtifact(session, 'screenshot', `explore-${Date.now()}.png`, png, 'image/png', 'exploration evidence');
        sessions.bump(session, 'screenshots');
      } catch {
        /* best-effort */
      }
    }

    // GOAL-13: another app (Safari from an attribution link, SpringBoard) is in front. Not an app
    // screen: the loop drops it and returns to the app. Permission dialogs, system surfaces and a
    // foreign activity inside the app's own task (Settings search) are not "left the app".
    // GOAL NEW-R4-2: on iOS only SpringBoard hosts system prompts; another app in front (iOS Settings
    // reached from an alert) has left the app even when its screen reads like a permission prompt.
    const fgPkg = (foreground ?? '').split('/')[0];
    const systemHost = platform !== 'ios' || /^com\.apple\.springboard$/i.test(fgPkg);
    const leftApp =
      !!session.appId &&
      !!fgPkg &&
      fgPkg !== 'unknown' &&
      !ownsForeground(session.appId, fgPkg) &&
      !(
        systemHost && health.findings.some((f) => ['foreign_activity_in_app_task', 'permission_dialog', 'system_surface'].includes(f.kind))
      );
    const { node, isNew } = graph.upsert({
      signature,
      // LOG-22: name the screen after its visible title, not the package (every screen used to be
      // called "com.google.android.deskclock").
      title: visual ? foreground : (screenTitleOf(elements) ?? foreground),
      mode: visual ? 'visual' : 'structured',
      platform,
      screenshotUri,
      health: healthSnap,
      authState: authWall ? 'auth_required' : undefined,
      visualOnlyReason: visual ? 'no reliable UI tree (canvas/map/webview or empty snapshot)' : undefined,
      locatorQuality: visual ? undefined : locatorQuality(elements),
      elements: candidates.map((c) => ({
        ref: c.ref,
        candidateSignature: c.signatureKey,
        label: c.label,
        role: c.role,
        bounds: c.bounds,
        locator: c.locator,
        actionType: c.actionType,
        risk: c.risk,
        riskClass: c.riskClass,
        stepUp: c.stepUp,
        requiresTwoStepConfirmation: c.requiresTwoStepConfirmation,
        reason: c.reason,
      })),
    });
    if (isNew) summary.screensVisited++;
    if (isNew && visual) summary.visualOnlyScreens++;
    if (healthSnap.app === 'error') summary.appErrors++;

    // Visual-only screens get a recorded visual assertion as their oracle (Milestone E).
    if (visual && isNew) {
      note({
        workflow: 'guided_exploration',
        outcome: 'pass',
        category: undefined,
        reason: `visual-only screen "${foreground}", verified by screenshot`,
        verifiedVisually: true,
        method: 'visual',
        artifactUris: screenshotUri ? [screenshotUri] : undefined,
      });
    }
    return { node, isNew, candidates, visual, authWall, actionLikeSkipped, foreground, leftApp, alert };
  };

  const allowedCandidate = (candidate: RankedCandidate, node: ScreenNode): boolean => {
    // GOAL NEW-R4-2: a third-party / OS sign-in leaves the app in every safe mode, balanced included.
    if (isThirdPartySignIn({ label: candidate.label, id: candidate.locator?.strategy === 'id' ? candidate.locator.value : undefined }))
      return false;
    if (candidate.risk !== 'destructive') return allowedUnder(candidate.risk, safeMode);
    // Controlled account-cycle exception: logout (and only logout) is an expected step
    // on a disposable generated account inside the mobile-audit account-cycle workflow.
    if (
      opts.accountCycle?.enabled &&
      allowsControlledLogout(
        { label: candidate.label, id: candidate.locator?.value, role: candidate.locator?.strategy },
        { accountCycle: true, disposableAccount: opts.accountCycle.disposableAccount },
      )
    ) {
      return true;
    }
    const rec = {
      screenSignature: node.signature,
      candidateSignature: candidate.signatureKey,
      label: candidate.label,
      locator: candidate.locator,
      riskClass: candidate.riskClass,
    };
    destructiveCandidates.set(`${node.signature}:${candidate.signatureKey}`, rec);
    if (safeMode !== 'approved_destructive_candidate') return false;
    const approval = opts.destructiveApproval;
    if (!approval) return false;
    if (approval.expiresAt && Date.now() > approval.expiresAt) return false;
    if (approval.sessionId !== session.id) return false;
    if (approval.requiresDisposableState !== false && !hasDisposableState(session)) return false;
    if (approval.screenSignature !== node.signature) return false;
    if (approval.candidateSignature !== candidate.signatureKey) return false;
    if (approval.label && candidate.label && approval.label !== candidate.label) return false;
    if (approval.locator?.value && candidate.locator?.value !== approval.locator.value) return false;
    if ((candidate.stepUp || candidate.requiresTwoStepConfirmation) && approval.confirmHighImpact !== true) return false;
    return true;
  };

  // ---- main loop ----
  let stoppedReason = 'exploration complete';
  // A cancelled job unwinds via CancelledError (thrown by observe). It's never recorded as a finding,
  // blocker or visual-only screen; the partial graph is still finalized below.
  try {
    while (true) {
      if (signal?.aborted) {
        stoppedReason = 'cancelled';
        break;
      }
      if (summary.actionsTried + navSteps >= maxActions) {
        stoppedReason = `action budget reached (${maxActions}${navSteps ? `, ${navSteps} of them back / relaunch / alert-close steps` : ''})`;
        break;
      }
      if (graph.nodeCount() >= maxScreens) {
        stoppedReason = `screen budget reached (${maxScreens})`;
        break;
      }
      if (Date.now() >= deadline) {
        // The result state is "blocked" for this stop (see the return below), so a run cut off by
        // its clock never reads as a completed exploration.
        stoppedReason = `time budget reached (${Math.round((Date.now() - startedAt) / 1000)} s; ${summary.actionsTried} actions, ${navSteps} navigation steps)`;
        break;
      }
      const budgetStop = sessions.budgetStop(session);
      if (budgetStop) {
        stoppedReason = `session budget: ${budgetStop}`;
        break;
      }

      const obs = await observe();
      progress(`exploring: ${summary.screensVisited} screens, ${summary.actionsTried} actions${obs.visual ? ', visual-only' : ''}`);
      // GOAL NEW-R4-1: judge the last back step by the screen it produced. iOS has no system back key
      // (WdaDriver taps a navigation-bar back button or edge-swipes), so a back can do nothing: that is
      // a no-change action, and that screen is never backed out of again.
      if (pendingBack) {
        const from = pendingBack;
        pendingBack = undefined;
        const moved = obs.node.id !== from;
        graph.addEdge({
          from,
          ...(obs.leftApp ? {} : { to: obs.node.id }),
          action: { type: 'back', targetDescription: 'back' },
          outcome: obs.leftApp ? 'blocked' : moved ? 'changed_screen' : 'same_screen',
          evidenceUris: [],
          oracle: moved ? 'screen_signature_changed' : 'screen_signature_same',
        });
        if (moved) {
          consecutiveNoChange = 0;
        } else {
          backFailed.add(from);
          sameScreenEdges++;
          consecutiveNoChange++;
          if (consecutiveNoChange >= 3) {
            stoppedReason = 'repeated no-change actions';
            break;
          }
        }
      }
      // GOAL NEW-R4-2: an alert (a system one like "Sign in to your Apple Account", or the app's own)
      // is closed with its cancel action, never explored: its other buttons ("Settings") leave the app.
      // The alert screen is not an app screen and earns no coverage.
      if (obs.alert) {
        if (obs.isNew) {
          graph.removeNode(obs.node.id);
          summary.screensVisited = Math.max(0, summary.screensVisited - 1);
          if (obs.visual) summary.visualOnlyScreens = Math.max(0, summary.visualOnlyScreens - 1);
        }
        const cancel = obs.alert.cancel;
        if (!cancel || alertDismissals >= 5) {
          stoppedReason = cancel
            ? `an alert ("${obs.alert.title}") kept coming back after ${alertDismissals} closes`
            : `an alert ("${obs.alert.title}") covers the app and has no cancel / close button; its buttons are not explored`;
          break;
        }
        alertDismissals++;
        navSteps++;
        sessions.bump(session, 'actions');
        await driver.tapXY(cancel.x, cancel.y).catch(() => {});
        noteScreenMutation(session);
        note({
          workflow: 'guided_exploration',
          outcome: 'skipped',
          category: 'other',
          reason: `closed the alert "${obs.alert.title}" with "${cancel.label}"${permissionDeniedNote(cancel.label)}; alert buttons are not explored`,
        });
        await settleAndKeep(4000);
        continue;
      }
      // GOAL-13: the last action left the app. Don't map/credit the foreign screen; go back to the app.
      // GOAL NEW-R4-2: also when the run STARTS in another app (iOS Settings left in front by an earlier
      // run): that screen must not become the graph's root and earn coverage.
      if (obs.leftApp && session.appId) {
        if (obs.isNew) {
          graph.removeNode(obs.node.id);
          summary.screensVisited = Math.max(0, summary.screensVisited - 1);
          if (obs.visual) summary.visualOnlyScreens = Math.max(0, summary.visualOnlyScreens - 1);
        }
        leftAppCount++;
        note({
          workflow: 'guided_exploration',
          outcome: 'skipped',
          category: 'other',
          reason: `an action left the app (foreground ${obs.foreground}); that screen is not counted as an app screen; returning to ${session.appId}`,
        });
        if (leftAppCount >= 3) {
          stoppedReason = `exploration left the app ${leftAppCount} times (external links / system UI)`;
          break;
        }
        await driver.launchApp(session.appId).catch(() => {});
        noteScreenMutation(session);
        await settleAndKeep(4000);
        continue;
      }
      // The screen a relaunch opens IS the app's first screen now (the home screen's signature can
      // change during the run, e.g. after "Change map style"): make it the root, so "nothing left
      // here" ends the run instead of another back / relaunch round.
      if (rootAfterRelaunch) {
        rootAfterRelaunch = false;
        graph.rootId = obs.node.id;
      }
      if (!planned && (opts.strategy === 'task_planner' || opts.strategy === 'hybrid')) {
        planned = true;
        const screenText = obs.candidates.map((c) => `${c.label ?? ''} ${c.locator?.value ?? ''}`).join(' ');
        const domain = inferAppDomain({
          packageId: session.appId,
          goal: opts.goal,
          screenText,
          fixtures: session.fixtures.map((f) => f.name),
        });
        const tasks = proposeTasks({
          packageId: session.appId,
          goal: opts.goal,
          screenText,
          fixtures: session.fixtures.map((f) => f.name),
          candidates: obs.candidates,
        });
        graph.setTasks(tasks);
        graph.setHypotheses([`domain:${domain.domain}`, ...tasks.map((t) => `${t.feature}:${t.title}`)]);
        graph.setBlockedPreconditions([...new Set(tasks.flatMap((t) => t.preconditions))]);
      }

      // App error: record + stop this path (do not hide bugs; do not keep crawling a broken screen).
      if (obs.node.health.app === 'error') {
        note({
          workflow: 'guided_exploration',
          outcome: 'fail',
          category: 'app_bug',
          reason: `app-layer error on "${obs.node.title}"`,
          artifactUris: obs.node.screenshotUri ? [obs.node.screenshotUri] : undefined,
        });
        summary.blockers++;
        if (lastNodeId)
          graph.addEdge({
            from: lastNodeId,
            to: obs.node.id,
            action: { type: 'tap', targetDescription: 'prev action' },
            outcome: 'app_error',
            evidenceUris: obs.node.screenshotUri ? [obs.node.screenshotUri] : [],
          });
        stoppedReason = 'app-layer error encountered';
        break;
      }
      if (obs.node.health.native === 'error') {
        summary.blockers++;
        stoppedReason = 'native error encountered';
        break;
      }

      // Auth wall with no credentials.
      if (obs.authWall && !hasCredentials(session) && !authNoted) {
        note({
          workflow: 'guided_exploration',
          outcome: 'blocked',
          category: 'missing_test_data',
          reason: 'login required, no credentials available',
          missingPrecondition: 'test account credentials',
          recommendedSetup: 'Provide SWIPIUM_TEST_EMAIL/SWIPIUM_TEST_PASSWORD (qa_continue_from_blocker) or accept pre-login coverage.',
        });
        summary.blockers++;
        if (stopOnAuth) {
          const suitePromotion = finalizeGraph(graph, summary, sameScreenEdges, destructiveCandidates, ['auth wall blocked exploration']);
          return {
            graph,
            summary,
            needsInput: NeedsInput.credentials('Exploration hit a login screen.'),
            state: 'needs_input',
            stoppedReason: 'auth required (credentials missing)',
            suitePromotion,
            destructiveCandidates: [...destructiveCandidates.values()],
          };
        }
        // stopOnAuth:false: the wall is recorded (note above); keep exploring the reachable pre-login
        // surface. Auth controls are not "safe", so strict mode never taps into the login itself.
        authNoted = true;
      }

      const explored = exploredPerScreen.get(obs.node.id) ?? new Set<string>();
      exploredPerScreen.set(obs.node.id, explored);

      // Visual-only screens: no safe structured target, so step back to keep the graph connected.
      const pick = obs.candidates.find((c) => !explored.has(c.signatureKey) && !ledTo.has(c.signatureKey) && allowedCandidate(c, obs.node));
      const blockedCandidates = obs.candidates.filter((c) => !allowedCandidate(c, obs.node));
      if (blockedCandidates.length && !skippedNotedScreens.has(obs.node.id)) {
        skippedNotedScreens.add(obs.node.id);
        const ex = blockedCandidates[0];
        note({
          workflow: 'guided_exploration',
          outcome: 'skipped',
          category: ex.risk === 'destructive' ? 'destructive_refused' : 'other',
          reason: `Skipped ${ex.risk} action "${ex.label ?? ex.locator?.value}": ${ex.reason}`,
          recommendedSetup:
            ex.risk === 'destructive'
              ? 'Run dry_run_destructive to list candidate-bound approvals, then approve one exact candidate with disposable test state.'
              : 'Add accessibilityLabel/testID so the action can be judged + automated.',
        });
        summary.unsafeActionsSkipped += blockedCandidates.length;
      }

      if (!pick) {
        if (obs.actionLikeSkipped.length && !testabilityNotedScreens.has(obs.node.id)) {
          testabilityNotedScreens.add(obs.node.id);
          for (const s of obs.actionLikeSkipped.slice(0, 8)) {
            summary.testabilityBlockers.push({
              screen: obs.node.title ?? 'unknown',
              visibleText: s.visibleText,
              role: s.role,
              bounds: s.bounds,
              clickable: s.clickable,
              recommendation: `"${s.visibleText}" looks tappable but the UI tree marks it non-interactive. Add accessibilityRole="button" and a stable testID or accessibility identifier.`,
              manualCandidate: { x: Math.round(s.bounds.x + s.bounds.w / 2), y: Math.round(s.bounds.y + s.bounds.h / 2) },
            });
          }
          note({
            workflow: 'guided_exploration',
            outcome: 'blocked',
            category: 'mcp_limitation',
            reason: `No safe actionable elements on "${obs.node.title}". ${obs.actionLikeSkipped.length} visible action-like text element(s) are not clickable in the UI tree.`,
            missingPrecondition: 'tappable controls with accessibilityRole and testID',
            recommendedSetup: `Add accessibilityRole="button" and a stable testID to primary buttons such as "${obs.actionLikeSkipped[0].visibleText}".`,
          });
        }
        // Nothing safe+new here. Go back to keep exploring; if we're at the root with nothing, stop.
        if (lastNodeId && obs.node.id !== graph.rootId && depth > 1) {
          // GOAL NEW-R4-1: back once per screen; the next observe records whether it moved.
          if (!backFailed.has(obs.node.id)) {
            navSteps++;
            sessions.bump(session, 'actions');
            await driver.pressKey('back').catch(() => {});
            noteScreenMutation(session); // a stored snapshot is stale now
            pendingBack = obs.node.id;
            await settleAndKeep(4000);
            lastNodeId = obs.node.id;
            continue;
          }
          // Back did not leave this screen (no system back on iOS, no navigation-bar back button). Try
          // the app's own back / close control once (a JS header's "Back"), then relaunch the app to
          // get back to its first screen, at most twice per run.
          const inAppBack = inAppBackTried.has(obs.node.id)
            ? undefined
            : obs.candidates.find(
                (c) =>
                  c.actionType === 'tap' &&
                  allowedCandidate(c, obs.node) &&
                  (/^(back|go back|navigate up|close)$/i.test((c.label ?? '').trim()) ||
                    /(^|[-_.])(back|close)([-_.]?(button|btn))?$/i.test(
                      c.locator?.strategy === 'coordinate' ? '' : (c.locator?.value ?? ''),
                    )),
              );
          if (inAppBack?.bounds) {
            const b = inAppBack.bounds;
            inAppBackTried.add(obs.node.id);
            navSteps++;
            sessions.bump(session, 'actions');
            await driver.tapXY(Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)).catch(() => {});
            noteScreenMutation(session);
            pendingBack = obs.node.id;
            await settleAndKeep(4000);
            lastNodeId = obs.node.id;
            continue;
          }
          if (session.appId && relaunches < 2) {
            relaunches++;
            navSteps++;
            sessions.bump(session, 'actions');
            note({
              workflow: 'guided_exploration',
              outcome: 'skipped',
              category: 'other',
              reason: `back did not leave "${obs.node.title}"; relaunching ${session.appId} to continue from its first screen`,
            });
            await driver.terminateApp(session.appId).catch(() => {});
            await driver.launchApp(session.appId).catch(() => {});
            noteScreenMutation(session);
            await waitForAppRender(driver, {
              visualOnly: session.mode === 'visual-fallback' || driver.kind === 'simulator',
              timeoutMs: 10_000,
            }).catch(() => {});
            await settleAndKeep(4000);
            lastNodeId = obs.node.id;
            rootAfterRelaunch = true;
            continue;
          }
          stoppedReason = `no way back from "${obs.node.title}" (back did not change the screen, relaunch limit reached)`;
          break;
        }
        stoppedReason = 'no further safe, unexplored actions';
        break;
      }

      // ---- act on the chosen candidate ----
      explored.add(pick.signatureKey);
      const cx = (pick.bounds?.x ?? 0) + (pick.bounds?.w ?? 0) / 2;
      const cy = (pick.bounds?.y ?? 0) + (pick.bounds?.h ?? 0) / 2;
      const fromId = obs.node.id;

      // Text entry only with a value source (P1 fix): never type blindly. If none, skip honestly.
      if (pick.actionType === 'type') {
        const v = valueForField(session, pick.label, pick.locator?.value, pick.role, pick.secure, genCtx);
        if (!v) {
          note({
            workflow: 'guided_exploration',
            outcome: 'skipped',
            category: 'missing_test_data',
            reason: `text field "${pick.label ?? pick.locator?.value}" needs a value to exercise`,
            missingPrecondition: 'a fixture value or credential for this field',
            recommendedSetup: 'Provide credentials (qa_continue_from_blocker) or a fixture { name, value }.',
          });
          summary.blockers++;
          continue;
        }
        try {
          await driver.tapXY(Math.round(cx), Math.round(cy)); // focus the field
          await driver.inputText(v.value);
        } catch {
          graph.addEdge({
            from: fromId,
            action: { type: 'type', targetDescription: pick.label ?? 'field' },
            outcome: 'blocked',
            evidenceUris: [],
          });
          continue;
        }
        summary.actionsTried++;
        sessions.bump(session, 'actions');
        if (v.secret) session.secrets.add(v.value);
        if (v.source === 'generator') {
          const rec = session.generatedValues.find((g) => g.varName === v.varName && g.fixture === v.fixture && g.field === v.field);
          if (rec && !rec.artifactUri) {
            rec.artifactUri = sessions.saveArtifact(
              session,
              'generated_data',
              `generated-${v.varName.toLowerCase()}-${Date.now()}.json`,
              JSON.stringify(
                {
                  schema: 'swipium.generated_value.v1',
                  fixture: rec.fixture,
                  field: rec.field,
                  varName: rec.varName,
                  generator: rec.generator,
                  value: rec.secret ? '<redacted>' : rec.value,
                  secret: rec.secret,
                },
                null,
                2,
              ),
              'application/json',
              `generated fixture value ${rec.fixture}.${rec.field}`,
            );
            sessions.persist(session);
          }
        }
        if (pick.locator && pick.locator.strategy !== 'coordinate') {
          sessions.addRecordedAction(session, {
            at: Date.now(),
            action: 'type',
            selector: pick.locator.value,
            selectorKind: strategyToKind(pick.locator.strategy),
            text: `\${${v.varName}}`,
            secret: v.secret,
            exportability: v.secret ? 'needs-human-data' : 'semantic',
            screen: obs.node.title,
            provenance: provenanceForCandidate(obs.node, pick),
          });
        }
        await settleAndKeep(5000);
        const afterType = await observe();
        graph.addEdge({
          from: fromId,
          to: afterType.node.id,
          action: { type: 'type', targetDescription: pick.label ?? 'field' },
          outcome: afterType.node.id === fromId ? 'same_screen' : 'changed_screen',
          evidenceUris: [],
        });
        lastNodeId = afterType.node.id;
        continue;
      }

      try {
        await driver.tapXY(Math.round(cx), Math.round(cy));
      } catch {
        if (pick.risk === 'destructive') {
          sessions.recordMutation(session, {
            tool: 'qa_explore',
            action: 'destructive_ui_candidate',
            risk: 'high',
            target: destructiveMutationTarget(session, obs.node, pick, opts.destructiveApproval),
            consent: { required: true, consentId: opts.destructiveApproval?.consentId, approved: true },
            status: 'blocked',
            detail: 'Approved destructive exploration candidate could not be tapped.',
          });
        }
        graph.addEdge({
          from: fromId,
          action: { type: 'tap', targetDescription: pick.label ?? pick.locator?.value ?? 'control' },
          outcome: 'blocked',
          evidenceUris: [],
        });
        continue;
      }
      if (pick.risk === 'destructive') {
        sessions.recordMutation(session, {
          tool: 'qa_explore',
          action: 'destructive_ui_candidate',
          risk: 'high',
          target: destructiveMutationTarget(session, obs.node, pick, opts.destructiveApproval),
          consent: { required: true, consentId: opts.destructiveApproval?.consentId, approved: true },
          status: 'executed',
          detail: 'Approved destructive exploration candidate tapped.',
        });
      }
      summary.actionsTried++;
      sessions.bump(session, 'actions');
      // Record durable taps so qa_generate target:"suite" can promote the path (§9.3).
      if (pick.locator && pick.locator.strategy !== 'coordinate') {
        sessions.addRecordedAction(session, {
          at: Date.now(),
          action: 'tap',
          selector: pick.locator.value,
          selectorKind: strategyToKind(pick.locator.strategy),
          exportability: 'semantic',
          screen: obs.node.title,
          provenance: provenanceForCandidate(obs.node, pick),
        });
      }
      await settleAndKeep(5000);

      // ---- observe outcome to classify the transition ----
      const after = await observe();
      if (after.leftApp && session.appId) {
        // GOAL-13: the tap opened another app (external link, system UI). Record the edge as
        // blocked, drop the foreign screen, and return to the app.
        if (after.isNew) {
          graph.removeNode(after.node.id);
          summary.screensVisited = Math.max(0, summary.screensVisited - 1);
          if (after.visual) summary.visualOnlyScreens = Math.max(0, summary.visualOnlyScreens - 1);
        }
        graph.addEdge({
          from: fromId,
          action: {
            type: 'tap',
            targetDescription: `${pick.label ?? pick.locator?.value ?? 'control'} (left the app: ${after.foreground})`,
          },
          outcome: 'blocked',
          evidenceUris: after.node.screenshotUri ? [after.node.screenshotUri] : [],
        });
        // Don't promote an app-leaving tap into generated suites/flows.
        const lastRec = session.recordedActions.at(-1);
        if (lastRec?.action === 'tap' && pick.locator && lastRec.selector === pick.locator.value) session.recordedActions.pop();
        leftAppCount++;
        note({
          workflow: 'guided_exploration',
          outcome: 'skipped',
          category: 'other',
          reason: `tapping "${pick.label ?? pick.locator?.value ?? 'control'}" left the app (foreground ${after.foreground}); not counted as an app screen`,
        });
        if (leftAppCount >= 3) {
          stoppedReason = `exploration left the app ${leftAppCount} times (external links / system UI)`;
          break;
        }
        await driver.launchApp(session.appId).catch(() => {});
        noteScreenMutation(session);
        await settleAndKeep(4000);
        lastNodeId = fromId;
        continue;
      }
      const outcome: EdgeOutcome = after.node.id === fromId ? 'same_screen' : 'changed_screen';
      if (outcome === 'changed_screen') {
        ledTo.set(pick.signatureKey, after.node.id);
        // LOG-22: a popup opened from the overflow button is that menu, not its first row ("Screen saver").
        if (after.isNew && /\b(more options|overflow)\b/i.test(`${pick.label ?? ''} ${pick.locator?.value ?? ''}`))
          after.node.title = `${pick.label ?? 'More options'} menu`;
        summary.workflowsFound++;
        consecutiveNoChange = 0;
      } else {
        consecutiveNoChange++;
      }
      if (outcome === 'same_screen') sameScreenEdges++;
      graph.addEdge({
        from: fromId,
        to: after.node.id,
        action: {
          type: 'tap',
          targetDescription: pick.label ?? pick.locator?.value ?? 'control',
          locator: pick.locator as unknown as Record<string, unknown>,
        },
        outcome,
        evidenceUris: after.node.screenshotUri ? [after.node.screenshotUri] : [],
        riskDecision: pick.riskClass ?? pick.risk,
        preActionState: obs.node.signature,
        postActionState: after.node.signature,
        oracle: outcome === 'changed_screen' ? 'screen_signature_changed' : 'screen_signature_same',
      });
      lastNodeId = after.node.id;
      if (consecutiveNoChange >= 3) {
        stoppedReason = 'repeated no-change actions';
        break;
      }
    }
  } catch (e) {
    if (!(e instanceof CancelledError) && !(signal?.aborted && isAbortError(e, signal))) throw e;
    stoppedReason = 'cancelled';
  }

  const suitePromotion = finalizeGraph(graph, summary, sameScreenEdges, destructiveCandidates, []);
  return {
    graph,
    summary,
    // GOAL-12: a SESSION budget stop is not a completed exploration (often nothing was explored at
    // all). Report it as blocked (BUDGET_EXHAUSTED in the job result), never "completed".
    // GOAL NEW-R4-1: neither is a run cut off by its own time budget (the 6-minute back loop read as
    // a completed, SHIP-worthy exploration).
    state:
      summary.appErrors > 0 ||
      summary.blockers > 0 ||
      stoppedReason.startsWith('session budget:') ||
      stoppedReason.startsWith('time budget reached') ||
      // R5 N4: an alert with no way to close it, leaving the app again and again, or no way back is
      // not a completed exploration when it tested nothing (no action, or no real app screen).
      (/^(an alert \(|exploration left the app|no way back)/.test(stoppedReason) &&
        (summary.actionsTried === 0 || summary.screensVisited - summary.visualOnlyScreens === 0))
        ? 'blocked'
        : 'completed',
    stoppedReason,
    suitePromotion,
    destructiveCandidates: [...destructiveCandidates.values()],
  };
}

function finalizeGraph(
  graph: ExploreGraph,
  summary: ExploreSummary,
  sameScreenEdges: number,
  destructiveCandidates: Map<string, DestructiveCandidateSummary>,
  reasons: string[],
): SuitePromotionCandidate[] {
  const nodes = graph.allNodes();
  const existing = graph.serialize(new Date(0).toISOString());
  const features = estimateFeatureCoverage(nodes, existing.tasks, graph.allEdges());
  summary.featureCoverage = features;
  summary.destructiveCandidates = destructiveCandidates.size;
  if (existing.tasks.length) {
    graph.setTasks(
      existing.tasks.map((task) => ({
        ...task,
        status:
          features[task.feature] === 'covered'
            ? 'completed'
            : features[task.feature] === 'unsafe'
              ? 'unsafe'
              : features[task.feature] === 'blocked' || features[task.feature] === 'needs_fixture'
                ? 'blocked'
                : 'not_applicable',
      })),
    );
  }
  graph.setCoverageClaims(coverageClaimsFrom(features, nodes));
  graph.setReflection(reflectExploration(nodes, sameScreenEdges, reasons));
  const promotion = scorePromotionCandidates(graph);
  summary.promotedSuiteCandidates = promotion.filter((p) => p.status === 'promote').length;
  return promotion;
}
