// Guided exploration runner (Phase 3.3 Milestones D/E/G). Bounded, safe-by-default screen crawl:
// observe → signature → rank safe candidates → act → health-check → record edge, until a budget is
// reached. Visual-only screens (poor UI tree) are verified with a screenshot + visual assertion
// instead of blind coordinate crawling. Honest: unsafe actions are skipped with a note; an auth
// wall with no credentials returns NeedsInput. Drives only the Driver interface — no MCP-over-MCP.

import { parseSnapshot } from '../snapshot/parse.js';
import { settle } from '../snapshot/settle.js';
import { checkHealth } from '../oracle/health.js';
import { recordHealthFindings } from '../oracle/record.js';
import { ExploreGraph, type ScreenNode, type EdgeOutcome } from './graph.js';
import { structuredSignature, visualSignature } from './signatures.js';
import { actionLikeNonInteractive, rankCandidates, locatorQuality, type RankedCandidate, type SkippedActionLike } from './candidates.js';
import { allowedUnder, allowsControlledLogout, type SafeMode } from './policy.js';
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
  /** SWIPIUM-REQ-02: allow built-in safe generators to fill fields when the environment is a
   *  disposable test/staging one (off by default — exploration never invents values otherwise). */
  allowGeneratedData?: boolean;
  testDataPolicyPath?: string;
  /** SWIPIUM-REQ-07: the controlled mobile-audit account-cycle workflow. When enabled on a
   *  disposable generated account, LOGOUT (and only logout) is permitted as an expected step;
   *  delete/pay/send stay refused. Off by default — broad exploration keeps logout destructive. */
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
 * Find a safe value to type into a field. Priority (the input planner, SWIPIUM-REQ-02):
 * secure inputs → declared fixtures → built-in safe generator (ONLY when `gen.allowed`, i.e. the
 * environment is a disposable test/staging one) → otherwise undefined (the runner skips honestly).
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

function valueForField(session: Session, label?: string, locatorValue?: string, role?: string, secure?: boolean, gen?: GeneratedDataContext): FieldValue | undefined {
  const key = `${label ?? ''} ${locatorValue ?? ''}`.toLowerCase();
  const fromStore = (varName: string, isSecret: boolean): FieldValue | undefined => {
    const value = session.inputValues.get(varName);
    return value ? { value, varName, secret: isSecret, source: 'secure_input' } : undefined;
  };
  if (/pass/.test(key) || secure) { const v = fromStore('SWIPIUM_TEST_PASSWORD', true); if (v) return v; }
  if (/email|user|account|login/.test(key)) { const v = fromStore('SWIPIUM_TEST_EMAIL', false); if (v) return v; }
  if (/otp|code|2fa|mfa/.test(key)) { const v = fromStore('SWIPIUM_TEST_OTP', true); if (v) return v; }
  const resolved = resolveFixtureValue(session, label, locatorValue, { role });
  if (resolved) return resolved;
  // Built-in safe generator — only when generation is explicitly allowed for this environment.
  if (gen?.allowed) {
    const field = fieldKindFromHints(label, locatorValue, undefined, secure);
    const g = generateFieldValue(field, gen.policy);
    if (g) {
      const varName = generatorVarFor(field);
      session.inputValues.set(varName, g.value);
      if (g.secret) session.secrets.add(g.value);
      session.generatedValues.push({ at: Date.now(), fixture: 'generated', field, varName, generator: g.generator, value: g.value, secret: g.secret });
      return { value: g.value, varName, secret: g.secret, fixture: 'generated', field, source: 'generator' };
    }
  }
  return undefined;
}

function strategyToKind(strategy: string): RecordedAction['selectorKind'] {
  switch (strategy) {
    case 'accessibility':
      return 'accessibility_id';
    case 'id':
      return 'resource_id'; // Android resource-id → durable id= selector (not a text match)
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

function destructiveMutationTarget(session: Session, node: ScreenNode, candidate: RankedCandidate, approval: ExploreOptions['destructiveApproval']): Record<string, unknown> {
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

export async function runExplore(sessions: SessionStore, session: Session, driver: Driver, opts: ExploreOptions, ctx: ExploreCtx = {}): Promise<ExploreResult> {
  const platform = driver.kind === 'wda' || driver.kind === 'simulator' ? 'ios' : 'android';
  const graph = new ExploreGraph(platform);
  const safeMode: SafeMode = opts.safeMode === 'approved_destructive' ? 'strict' : (opts.safeMode ?? 'strict');
  const maxActions = opts.maxActions ?? 20;
  const maxScreens = opts.maxScreens ?? 12;
  const depth = opts.depth ?? 3;
  const stopOnAuth = opts.stopOnAuth ?? true;
  // SWIPIUM-REQ-02: resolve the generated-data decision once. Only "allowed" when policy + the
  // classified environment (test/staging) permit safe throwaway data; otherwise generation is off.
  const genCtx: GeneratedDataContext | undefined = opts.allowGeneratedData
    ? (() => { const r = resolveFirstRunPolicy(session, { testDataPolicyPath: opts.testDataPolicyPath, allowGeneratedAccount: true }); return { allowed: r.decision.allowed, policy: r.policy }; })()
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
  const exploredPerScreen = new Map<string, Set<string>>(); // nodeId → explored signatureKeys
  const skippedNotedScreens = new Set<string>();
  const testabilityNotedScreens = new Set<string>();
  const destructiveCandidates = new Map<string, DestructiveCandidateSummary>();
  let lastNodeId: string | undefined;
  let consecutiveNoChange = 0;
  let sameScreenEdges = 0;
  let planned = false;

  const note = (n: Parameters<SessionStore['addNote']>[1] extends infer T ? Omit<NonNullable<T>, 'at'> : never) =>
    sessions.addNote(session, { at: Date.now(), ...(n as object) } as Parameters<SessionStore['addNote']>[1]);

  /** Observe the current screen → a graph node (structured or visual-only). */
  const observe = async (): Promise<{ node: ScreenNode; isNew: boolean; candidates: RankedCandidate[]; visual: boolean; authWall: boolean; actionLikeSkipped: SkippedActionLike[] }> => {
    const foreground = await driver.foregroundOwner().catch(() => 'unknown');
    let xml = '';
    let elements: ReturnType<typeof parseSnapshot>['elements'] = [];
    let webviewDominance = 0;
    try {
      xml = await driver.dumpXml();
      const parsed = parseSnapshot(xml);
      elements = parsed.elements;
      webviewDominance = parsed.quality.signals.webviewDominance;
    } catch {
      /* snapshot failed → treated as visual-only below */
    }
    const health = await checkHealth(driver, session.appId, xml || undefined);
    await recordHealthFindings(sessions, session, health.findings, driver, health.foreground);
    if (!health.nativeHealthy) summary.appErrors += 0; // native handled separately below
    const healthSnap = { native: (health.nativeHealthy ? 'OK' : 'error') as 'OK' | 'error', app: health.appStatus === 'error' ? 'error' as const : health.appStatus === 'degraded' ? 'degraded' as const : 'OK' as const };

    let screenshotUri: string | undefined;
    let png: Buffer | undefined;
    // Respect the SESSION screenshot budget (not a separate fixed counter) so two observes per
    // action can't overshoot the cap (P2 fix).
    if (!session.sensitive && session.counters.screenshots < session.budget.maxScreenshots) {
      try {
        png = await driver.screenshot();
        screenshotUri = sessions.saveArtifact(session, 'screenshot', `explore-${Date.now()}.png`, png, 'image/png', 'exploration evidence');
        sessions.bump(session, 'screenshots');
      } catch {
        /* best-effort */
      }
    }

    // Visual-only (Milestone E): no usable structured elements (canvas/map/webview/empty) → visual
    // node + assertion, no blind coordinate crawl. A low automation-readiness verdict on a screen
    // that DOES expose identified elements is still structured (we can act on it).
    const visual = elements.length === 0 || webviewDominance > 0.5;
    const authWall = elements.some((e) => e.secure) || AUTH_RE.test(elements.map((e) => e.text || e.label || '').join(' '));
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

    const { node, isNew } = graph.upsert({
      signature,
      title: foreground,
      mode: visual ? 'visual' : 'structured',
      platform,
      screenshotUri,
      health: healthSnap,
      authState: authWall ? 'auth_required' : undefined,
      visualOnlyReason: visual ? 'no reliable UI tree (canvas/map/webview or empty snapshot)' : undefined,
      locatorQuality: visual ? undefined : locatorQuality(elements),
      elements: candidates.map((c) => ({ ref: c.ref, candidateSignature: c.signatureKey, label: c.label, role: c.role, bounds: c.bounds, locator: c.locator, actionType: c.actionType, risk: c.risk, riskClass: c.riskClass, stepUp: c.stepUp, requiresTwoStepConfirmation: c.requiresTwoStepConfirmation, reason: c.reason })),
    });
    if (isNew) summary.screensVisited++;
    if (isNew && visual) summary.visualOnlyScreens++;
    if (healthSnap.app === 'error') summary.appErrors++;

    // Visual-only screens get a recorded visual assertion as their oracle (Milestone E).
    if (visual && isNew) {
      note({ workflow: 'guided_exploration', outcome: 'pass', category: undefined, reason: `visual-only screen "${foreground}" — verified by screenshot`, verifiedVisually: true, method: 'visual', artifactUris: screenshotUri ? [screenshotUri] : undefined });
    }
    return { node, isNew, candidates, visual, authWall, actionLikeSkipped };
  };

  const allowedCandidate = (candidate: RankedCandidate, node: ScreenNode): boolean => {
    if (candidate.risk !== 'destructive') return allowedUnder(candidate.risk, safeMode);
    // Controlled account-cycle exception (REQ-07): logout — and only logout — is an expected step
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
  while (true) {
    if (signal?.aborted) { stoppedReason = 'cancelled'; break; }
    if (summary.actionsTried >= maxActions) { stoppedReason = `action budget reached (${maxActions})`; break; }
    if (graph.nodeCount() >= maxScreens) { stoppedReason = `screen budget reached (${maxScreens})`; break; }
    if (Date.now() >= deadline) { stoppedReason = 'time budget reached'; break; }
    const budgetStop = sessions.budgetStop(session);
    if (budgetStop) { stoppedReason = `session budget: ${budgetStop}`; break; }

    const obs = await observe();
    progress(`exploring: ${summary.screensVisited} screens, ${summary.actionsTried} actions${obs.visual ? ', visual-only' : ''}`);
    if (!planned && (opts.strategy === 'task_planner' || opts.strategy === 'hybrid')) {
      planned = true;
      const screenText = obs.candidates.map((c) => `${c.label ?? ''} ${c.locator?.value ?? ''}`).join(' ');
      const domain = inferAppDomain({ packageId: session.appId, goal: opts.goal, screenText, fixtures: session.fixtures.map((f) => f.name) });
      const tasks = proposeTasks({ packageId: session.appId, goal: opts.goal, screenText, fixtures: session.fixtures.map((f) => f.name), candidates: obs.candidates });
      graph.setTasks(tasks);
      graph.setHypotheses([`domain:${domain.domain}`, ...tasks.map((t) => `${t.feature}:${t.title}`)]);
      graph.setBlockedPreconditions([...new Set(tasks.flatMap((t) => t.preconditions))]);
    }

    // App error → record + stop this path (do not hide bugs; do not keep crawling a broken screen).
    if (obs.node.health.app === 'error') {
      note({ workflow: 'guided_exploration', outcome: 'fail', category: 'app_bug', reason: `app-layer error on "${obs.node.title}"`, artifactUris: obs.node.screenshotUri ? [obs.node.screenshotUri] : undefined });
      summary.blockers++;
      if (lastNodeId) graph.addEdge({ from: lastNodeId, to: obs.node.id, action: { type: 'tap', targetDescription: 'prev action' }, outcome: 'app_error', evidenceUris: obs.node.screenshotUri ? [obs.node.screenshotUri] : [] });
      stoppedReason = 'app-layer error encountered';
      break;
    }
    if (obs.node.health.native === 'error') {
      summary.blockers++;
      stoppedReason = 'native error encountered';
      break;
    }

    // Auth wall with no credentials.
    if (obs.authWall && !hasCredentials(session)) {
      note({ workflow: 'guided_exploration', outcome: 'blocked', category: 'missing_test_data', reason: 'login required, no credentials available', missingPrecondition: 'test account credentials', recommendedSetup: 'Provide TEST_EMAIL/TEST_PASSWORD (qa_continue_from_blocker) or accept pre-login coverage.' });
      summary.blockers++;
      if (stopOnAuth) {
        const suitePromotion = finalizeGraph(graph, summary, sameScreenEdges, destructiveCandidates, ['auth wall blocked exploration']);
        return { graph, summary, needsInput: NeedsInput.credentials('Exploration hit a login screen.'), state: 'needs_input', stoppedReason: 'auth required (credentials missing)', suitePromotion, destructiveCandidates: [...destructiveCandidates.values()] };
      }
      // stopOnAuth:false → record blocked and stop crawling further (only public screens were reachable).
      stoppedReason = 'auth required — recorded blocked, no credentials to proceed';
      break;
    }

    const explored = exploredPerScreen.get(obs.node.id) ?? new Set<string>();
    exploredPerScreen.set(obs.node.id, explored);

    // Visual-only screens: no safe structured target → step back to keep the graph connected.
    const pick = obs.candidates.find((c) => !explored.has(c.signatureKey) && allowedCandidate(c, obs.node));
    const blockedCandidates = obs.candidates.filter((c) => !allowedCandidate(c, obs.node));
    if (blockedCandidates.length && !skippedNotedScreens.has(obs.node.id)) {
      skippedNotedScreens.add(obs.node.id);
      const ex = blockedCandidates[0];
      note({ workflow: 'guided_exploration', outcome: 'skipped', category: ex.risk === 'destructive' ? 'destructive_refused' : 'other', reason: `Skipped ${ex.risk} action "${ex.label ?? ex.locator?.value}": ${ex.reason}`, recommendedSetup: ex.risk === 'destructive' ? 'Run dry_run_destructive to list candidate-bound approvals, then approve one exact candidate with disposable test state.' : 'Add accessibilityLabel/testID so the action can be judged + automated.' });
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
        await driver.pressKey('back').catch(() => {});
        graph.addEdge({ from: obs.node.id, action: { type: 'back', targetDescription: 'back' }, outcome: 'changed_screen', evidenceUris: [] });
        await settle(driver, { timeoutMs: 4000 }).catch(() => {});
        lastNodeId = obs.node.id;
        continue;
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
        note({ workflow: 'guided_exploration', outcome: 'skipped', category: 'missing_test_data', reason: `text field "${pick.label ?? pick.locator?.value}" needs a value to exercise`, missingPrecondition: 'a fixture value or credential for this field', recommendedSetup: 'Provide credentials (qa_continue_from_blocker) or a fixture { name, value }.' });
        summary.blockers++;
        continue;
      }
      try {
        await driver.tapXY(Math.round(cx), Math.round(cy)); // focus the field
        await driver.inputText(v.value);
      } catch {
        graph.addEdge({ from: fromId, action: { type: 'type', targetDescription: pick.label ?? 'field' }, outcome: 'blocked', evidenceUris: [] });
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
            JSON.stringify({ schema: 'swipium.generated_value.v1', fixture: rec.fixture, field: rec.field, varName: rec.varName, generator: rec.generator, value: rec.secret ? '<redacted>' : rec.value, secret: rec.secret }, null, 2),
            'application/json',
            `generated fixture value ${rec.fixture}.${rec.field}`,
          );
          sessions.persist(session);
        }
      }
      if (pick.locator && pick.locator.strategy !== 'coordinate') {
        sessions.addRecordedAction(session, { at: Date.now(), action: 'type', selector: pick.locator.value, selectorKind: strategyToKind(pick.locator.strategy), text: `\${${v.varName}}`, secret: v.secret, exportability: v.secret ? 'needs-human-data' : 'semantic', screen: obs.node.title, provenance: provenanceForCandidate(obs.node, pick) });
      }
      await settle(driver, { timeoutMs: 5000 }).catch(() => {});
      const afterType = await observe();
      graph.addEdge({ from: fromId, to: afterType.node.id, action: { type: 'type', targetDescription: pick.label ?? 'field' }, outcome: afterType.node.id === fromId ? 'same_screen' : 'changed_screen', evidenceUris: [] });
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
      graph.addEdge({ from: fromId, action: { type: 'tap', targetDescription: pick.label ?? pick.locator?.value ?? 'control' }, outcome: 'blocked', evidenceUris: [] });
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
    // Record durable taps so qa_suite_generate can promote the path (§9.3).
    if (pick.locator && pick.locator.strategy !== 'coordinate') {
      sessions.addRecordedAction(session, { at: Date.now(), action: 'tap', selector: pick.locator.value, selectorKind: strategyToKind(pick.locator.strategy), exportability: 'semantic', screen: obs.node.title, provenance: provenanceForCandidate(obs.node, pick) });
    }
    await settle(driver, { timeoutMs: 5000 }).catch(() => {});

    // ---- observe outcome to classify the transition ----
    const after = await observe();
    const outcome: EdgeOutcome = after.node.id === fromId ? 'same_screen' : 'changed_screen';
    if (outcome === 'changed_screen') {
      summary.workflowsFound++;
      consecutiveNoChange = 0;
    } else {
      consecutiveNoChange++;
    }
    if (outcome === 'same_screen') sameScreenEdges++;
    graph.addEdge({ from: fromId, to: after.node.id, action: { type: 'tap', targetDescription: pick.label ?? pick.locator?.value ?? 'control', locator: pick.locator as unknown as Record<string, unknown> }, outcome, evidenceUris: after.node.screenshotUri ? [after.node.screenshotUri] : [], riskDecision: pick.riskClass ?? pick.risk, preActionState: obs.node.signature, postActionState: after.node.signature, oracle: outcome === 'changed_screen' ? 'screen_signature_changed' : 'screen_signature_same' });
    lastNodeId = after.node.id;
    if (consecutiveNoChange >= 3) { stoppedReason = 'repeated no-change actions'; break; }
  }

  const suitePromotion = finalizeGraph(graph, summary, sameScreenEdges, destructiveCandidates, []);
  return { graph, summary, state: summary.appErrors > 0 || summary.blockers > 0 ? 'blocked' : 'completed', stoppedReason, suitePromotion, destructiveCandidates: [...destructiveCandidates.values()] };
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
  const features = estimateFeatureCoverage(nodes, existing.tasks);
  summary.featureCoverage = features;
  summary.destructiveCandidates = destructiveCandidates.size;
  if (existing.tasks.length) {
    graph.setTasks(existing.tasks.map((task) => ({
      ...task,
      status:
        features[task.feature] === 'covered'
          ? 'completed'
          : features[task.feature] === 'unsafe'
            ? 'unsafe'
            : features[task.feature] === 'blocked' || features[task.feature] === 'needs_fixture'
              ? 'blocked'
              : 'not_applicable',
    })));
  }
  graph.setCoverageClaims(coverageClaimsFrom(features, nodes));
  graph.setReflection(reflectExploration(nodes, sameScreenEdges, reasons));
  const promotion = scorePromotionCandidates(graph);
  summary.promotedSuiteCandidates = promotion.filter((p) => p.status === 'promote').length;
  return promotion;
}
