// SWIPIUM-REQ-02 — the first-run driver loop. The ONLY side-effecting part of the first-run lane:
// observe → planFirstRun → execute the bounded action(s) → record evidence/app-map → repeat until
// the requested mode's stop condition. Generated values are recorded as evidence (non-secret) or
// added to the redaction set (secret); they never appear in the read-only plan.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSnapshot } from '../snapshot/parse.js';
import { settle } from '../snapshot/settle.js';
import { structuredSignature } from '../explore/signatures.js';
import { resolveFixtureValue, hasDisposableState } from '../fixtures/catalog.js';
import type { Driver } from '../drivers/Driver.js';
import type { Session, SessionStore, RecordedAction } from '../session/store.js';
import { planFirstRun } from './firstRunPlanner.js';
import {
  loadTestDataPolicy,
  classifyEnvironment,
  decideGeneratedAccount,
  generateFieldValue,
  type TestDataPolicy,
  type EnvironmentClassification,
  type GeneratedAccountDecision,
} from './generatedDataPolicy.js';
import type { AppMapPatch, FirstRunPlan, PlannedAction, ScreenPurpose, FieldKind } from './types.js';
import type { AppKnowledgeMap } from '../appMap/schema.js';
import { staticCandidatesForObservation } from '../appMap/screenMatch.js';

export type FirstRunMode = 'one_step' | 'until_gate' | 'until_home';

export interface FirstRunOptions {
  mode: FirstRunMode;
  allowGeneratedAccount?: boolean;
  testDataPolicyPath?: string;
  maxSteps?: number;
  maxDurationMs?: number;
  /** Deterministic generation for tests. */
  timestamp?: number;
  /** Durable app map (Vision Gap Fix 2) — supplies static screen candidates so each runtime screen is
   *  classified against code/app-map context, not runtime UI alone, and links to its static screen id. */
  appMap?: AppKnowledgeMap;
}

export interface FirstRunCtx {
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface FirstRunStepRecord {
  index: number;
  purpose: ScreenPurpose;
  confidence: number;
  state: FirstRunPlan['state'];
  pathTaken?: FirstRunPlan['pathTaken'];
  actions: Array<{ type: string; label?: string; field?: FieldKind; outcome: 'done' | 'blocked' | 'no_change' }>;
  evidenceUris: string[];
  screenSignature: string;
  reason?: string;
}

export interface FirstRunResult {
  state: FirstRunPlan['state'];
  stoppedReason: string;
  steps: FirstRunStepRecord[];
  environment: EnvironmentClassification;
  decision: GeneratedAccountDecision;
  policySource: string;
  generatedVariables: Array<{ varName: string; field?: string; generator?: string; value: string | '<redacted>'; secret: boolean; artifactUri?: string }>;
  mapUpdates: AppMapPatch[];
  mapArtifactUri?: string;
  evidenceUris: string[];
  needsInput?: { kind: string; reason: string };
  pathTaken: FirstRunPlan['pathTaken'];
  nextRecommendedTool?: string;
  accountOutcome: 'created' | 'used_provided_credentials' | 'reached_verification' | 'pre_login_only' | 'refused_unsafe' | 'not_applicable';
}

const GATE_PURPOSES: ReadonlySet<ScreenPurpose> = new Set(['paywall', 'otp_or_email_verification', 'permissions_prompt']);
const TERMINAL_PURPOSES: ReadonlySet<ScreenPurpose> = new Set(['home', 'feature', 'settings']);

export interface Observation {
  elements: ReturnType<typeof parseSnapshot>['elements'];
  foreground: string;
  visibleText: string;
  screenSignature: string;
  screenshotUri?: string;
  appError: boolean;
}

const APP_ERROR_RE = /(redbox|render error|unhandled (js )?exception|com\.facebook\.react.*Exception|ReactNativeJS.*Error)/i;

/** Observe the current screen → elements + signature + a budget-aware evidence screenshot. Shared by
 *  the read-only plan tool and the executing runner. */
export async function observeScreen(sessions: SessionStore, session: Session, driver: Driver): Promise<Observation> {
  const foreground = await driver.foregroundOwner().catch(() => 'unknown');
  let xml = '';
  let elements: Observation['elements'] = [];
  try {
    xml = await driver.dumpXml();
    elements = parseSnapshot(xml).elements;
  } catch {
    /* visual-only / no tree */
  }
  let screenshotUri: string | undefined;
  if (!session.sensitive && session.counters.screenshots < session.budget.maxScreenshots) {
    try {
      const png = await driver.screenshot();
      screenshotUri = sessions.saveArtifact(session, 'screenshot', `firstrun-${Date.now()}.png`, png, 'image/png', 'first-run evidence');
      sessions.bump(session, 'screenshots');
    } catch {
      /* best-effort */
    }
  }
  const visibleText = elements.map((e) => `${e.text ?? ''} ${e.label ?? ''}`).join(' ').trim();
  const screenSignature = elements.length ? structuredSignature(elements, { foreground, keyboardShown: false }) : `visual:${foreground}`;
  return { elements, foreground, visibleText, screenSignature, screenshotUri, appError: APP_ERROR_RE.test(xml) };
}

/** Resolve policy + environment + the generated-account decision for a session (read-only). */
export function resolveFirstRunPolicy(session: Session, opts: { testDataPolicyPath?: string; allowGeneratedAccount?: boolean } = {}): {
  policy: TestDataPolicy; policySource: string; environment: EnvironmentClassification; decision: GeneratedAccountDecision;
} {
  const { policy, source: policySource } = loadTestDataPolicy(session.root, opts.testDataPolicyPath);
  const environment = classifyEnvironment(gatherEnvironmentSignals(session));
  const decision = decideGeneratedAccount(policy, environment, opts.allowGeneratedAccount);
  return { policy, policySource, environment, decision };
}

/** Best-effort production/environment signals from the project config (cheap, side-effect free). */
function gatherEnvironmentSignals(session: Session): Parameters<typeof classifyEnvironment>[0] {
  const declaredEnvironment = session.fixtures.find((f) => f.environment)?.environment;
  const apiBaseUrls: string[] = [];
  let configText = '';
  for (const rel of ['app.json', 'app.config.json', 'eas.json', join('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml')]) {
    const p = join(session.root, rel);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      configText += `\n${raw}`;
      for (const m of raw.matchAll(/https?:\/\/[^\s"'<]+/g)) apiBaseUrls.push(m[0]);
    } catch {
      /* best-effort */
    }
  }
  return {
    appId: session.appId,
    apiBaseUrls: [...new Set(apiBaseUrls)].slice(0, 12),
    hasDisposableState: hasDisposableState(session),
    declaredEnvironment,
    configText: configText.slice(0, 4000),
  };
}

export async function runFirstRun(
  sessions: SessionStore,
  session: Session,
  driver: Driver,
  opts: FirstRunOptions,
  ctx: FirstRunCtx = {},
): Promise<FirstRunResult> {
  const { policy, policySource, environment, decision } = resolveFirstRunPolicy(session, opts);
  const platform = driver.kind === 'wda' || driver.kind === 'simulator' ? 'ios' : 'android';

  const maxSteps = opts.maxSteps ?? (opts.mode === 'one_step' ? 1 : 8);
  const deadline = Date.now() + (opts.maxDurationMs ?? 4 * 60_000);
  const progress = (t: string) => ctx.onProgress?.(t);

  const steps: FirstRunStepRecord[] = [];
  const mapUpdates: AppMapPatch[] = [];
  const evidenceUris: string[] = [];
  const genCache = new Map<string, string>();
  const generatedVariables: FirstRunResult['generatedVariables'] = [];
  let fromSignature: string | undefined;
  let lastSignature: string | undefined;
  let sameSignatureCount = 0;
  let result: Partial<FirstRunResult> = {};
  let finalState: FirstRunPlan['state'] = 'blocked';
  let stoppedReason = 'first-run complete';
  let needsInput: FirstRunResult['needsInput'];
  let pathTaken: FirstRunPlan['pathTaken'] = 'none';
  let nextRecommendedTool: string | undefined;
  let createdAccount = false;
  let usedProvidedCreds = false;
  let reachedVerification = false;
  let refusedUnsafe = false;

  const observe = () => observeScreen(sessions, session, driver);

  const recordGenerated = (varName: string, field: FieldKind, value: string, secret: boolean, generator?: string) => {
    if (generatedVariables.some((g) => g.varName === varName)) return;
    session.inputValues.set(varName, value);
    if (secret) session.secrets.add(value);
    const rec = { at: Date.now(), fixture: 'first_run', field, varName, generator: generator ?? 'first_run', value, secret };
    session.generatedValues.push(rec);
    let artifactUri: string | undefined;
    if (policy.recordGeneratedValues && !secret) {
      artifactUri = sessions.saveArtifact(
        session,
        'generated_data',
        `generated-${varName.toLowerCase()}-${Date.now()}.json`,
        JSON.stringify({ schema: 'swipium.generated_value.v1', field, varName, generator, value, secret }, null, 2),
        'application/json',
        `generated first-run value ${field}`,
      );
    }
    sessions.persist(session);
    generatedVariables.push({ varName, field, generator, value: secret ? '<redacted>' : value, secret, artifactUri });
  };

  /** Resolve the raw value for a planned type action (secrets never live in the plan object). */
  const resolveTypeValue = (action: PlannedAction): string | undefined => {
    const v = action.value;
    if (!v) return undefined;
    if (v.source === 'secure_input') return session.inputValues.get(v.varName);
    if (v.source === 'fixture') {
      const r = resolveFixtureValue(session, action.label, action.locator?.value, { role: action.field });
      return r?.value;
    }
    // generator — generate once, cache so confirm-password matches password.
    if (genCache.has(v.varName)) return genCache.get(v.varName);
    const gen = generateFieldValue(action.field ?? 'generic', policy, { timestamp: opts.timestamp, index: genCache.size });
    if (!gen) return undefined;
    genCache.set(v.varName, gen.value);
    recordGenerated(v.varName, action.field ?? 'generic', gen.value, gen.secret, gen.generator);
    return gen.value;
  };

  const executeAction = async (action: PlannedAction, screen: string): Promise<'done' | 'blocked' | 'no_change'> => {
    const cx = Math.round((action.bounds?.[0] ?? 0) + ((action.bounds?.[2] ?? 0) - (action.bounds?.[0] ?? 0)) / 2);
    const cy = Math.round((action.bounds?.[1] ?? 0) + ((action.bounds?.[3] ?? 0) - (action.bounds?.[1] ?? 0)) / 2);
    if (action.type === 'type') {
      const raw = resolveTypeValue(action);
      if (raw == null) return 'blocked';
      try {
        await driver.tapXY(cx, cy);
        await driver.inputText(raw);
      } catch {
        return 'blocked';
      }
      sessions.bump(session, 'actions');
      if (action.value && action.locator && action.locator.strategy && action.locator.strategy !== 'coordinate') {
        sessions.addRecordedAction(session, {
          at: Date.now(), action: 'type', selector: action.locator.value, selectorKind: selectorKind(action.locator.strategy),
          text: `\${${action.value.varName}}`, secret: action.value.secret, exportability: action.value.secret ? 'needs-human-data' : 'semantic', screen,
        } as RecordedAction);
      }
      return 'done';
    }
    // tap / skip
    try {
      await driver.tapXY(cx, cy);
    } catch {
      return 'blocked';
    }
    sessions.bump(session, 'actions');
    if (action.locator && action.locator.strategy && action.locator.strategy !== 'coordinate') {
      sessions.addRecordedAction(session, {
        at: Date.now(), action: 'tap', selector: action.locator.value, selectorKind: selectorKind(action.locator.strategy),
        exportability: 'semantic', screen,
      } as RecordedAction);
    }
    return 'done';
  };

  for (let i = 0; i < maxSteps; i++) {
    if (ctx.signal?.aborted) { stoppedReason = 'cancelled'; break; }
    if (Date.now() >= deadline) { finalState = 'blocked'; stoppedReason = 'time budget reached'; break; }
    const budgetStop = sessions.budgetStop(session);
    if (budgetStop) { finalState = 'blocked'; stoppedReason = `session budget: ${budgetStop}`; break; }

    const obs = await observe();
    const staticCandidates = opts.appMap ? staticCandidatesForObservation(opts.appMap, { foreground: obs.foreground, visibleText: obs.visibleText }) : undefined;
    const plan = planFirstRun({ ...obs, screenSignature: obs.screenSignature, appError: obs.appError, staticCandidates, authState: session.auth.loginScreenSeen ? 'auth_required' : undefined }, session, {
      policy, decision, timestamp: opts.timestamp, fromSignature,
    });
    mapUpdates.push(...plan.mapUpdates);
    if (obs.screenshotUri) evidenceUris.push(obs.screenshotUri);
    progress(`first-run: ${plan.classification.purpose} → ${plan.state}`);

    // Record a classification note (auth-state side-effects too).
    if (AUTH_PURPOSES_RUNTIME.has(plan.classification.purpose)) sessions.markAuth(session, { loginScreenSeen: true, loginScreenSeenAt: Date.now() });
    sessions.addNote(session, {
      at: Date.now(), workflow: 'first_run', outcome: plan.state === 'completed' ? 'pass' : plan.state === 'ready' ? 'pass' : plan.state === 'unsafe' ? 'skipped' : plan.state === 'needs_input' ? 'blocked' : 'blocked',
      category: plan.state === 'unsafe' ? 'destructive_refused' : plan.state === 'needs_input' ? 'missing_test_data' : undefined,
      reason: `${plan.classification.purpose} (confidence ${plan.classification.confidence})${plan.reason ? ` — ${plan.reason}` : ''}`,
      artifactUris: obs.screenshotUri ? [obs.screenshotUri] : undefined,
      method: obs.elements.length ? 'structured' : 'visual',
    });

    pathTaken = plan.pathTaken ?? pathTaken;
    nextRecommendedTool = plan.nextRecommendedTool;

    const stepRec: FirstRunStepRecord = {
      index: i, purpose: plan.classification.purpose, confidence: plan.classification.confidence,
      state: plan.state, pathTaken: plan.pathTaken, actions: [], evidenceUris: obs.screenshotUri ? [obs.screenshotUri] : [],
      screenSignature: obs.screenSignature, reason: plan.reason,
    };

    // Terminal / pause states.
    if (plan.state === 'completed') { steps.push(stepRec); finalState = 'completed'; stoppedReason = plan.reason ?? 'reached home/feature'; if (plan.pathTaken === 'login' && usedProvidedCreds === false && createdAccount === false && hasProvidedCredsNow(session)) usedProvidedCreds = true; break; }
    if (plan.state === 'needs_input') { steps.push(stepRec); finalState = 'needs_input'; needsInput = plan.needsInput; stoppedReason = plan.reason ?? 'needs input'; if (plan.classification.purpose === 'otp_or_email_verification') reachedVerification = true; break; }
    if (plan.state === 'unsafe') { steps.push(stepRec); finalState = 'unsafe'; needsInput = plan.needsInput; refusedUnsafe = true; stoppedReason = plan.reason ?? 'unsafe'; break; }
    if (plan.state === 'blocked') { steps.push(stepRec); finalState = 'blocked'; stoppedReason = plan.reason ?? plan.stopConditions[0] ?? 'blocked'; break; }

    // state === 'ready' → execute the planned actions.
    let typedCredential = false;
    for (const action of plan.actions) {
      if (ctx.signal?.aborted) break;
      const outcome = await executeAction(action, obs.foreground);
      stepRec.actions.push({ type: action.type, label: action.label, field: action.field, outcome });
      if (action.type === 'type' && (action.field === 'password' || action.field === 'email')) typedCredential = true;
      if (action.type === 'type' && action.field === 'password') {
        sessions.markAuth(session, { loginPerformed: true, loginPerformedAt: Date.now() });
        if (action.value?.source === 'generator') createdAccount = true;
        else if (action.value?.source === 'secure_input') usedProvidedCreds = true;
      }
      await settle(driver, { timeoutMs: 4000 }).catch(() => {});
    }
    steps.push(stepRec);

    // Progress detection: did the screen change?
    if (lastSignature === obs.screenSignature) {
      sameSignatureCount++;
    } else {
      sameSignatureCount = 0;
    }
    lastSignature = obs.screenSignature;
    fromSignature = obs.screenSignature;
    if (sameSignatureCount >= 2) { finalState = 'blocked'; stoppedReason = 'repeated no-change actions'; break; }

    // Mode-based stop after acting.
    if (opts.mode === 'one_step') { finalState = 'ready'; stoppedReason = 'one step executed'; break; }
    // For until_gate / until_home, peek at the next screen on the next iteration; loop continues.
    if (i === maxSteps - 1) { finalState = 'ready'; stoppedReason = 'step budget reached'; }
    void typedCredential;
  }

  // Persist the app-map patches as a forward-compatible artifact (REQ-01 will consume these).
  let mapArtifactUri: string | undefined;
  if (mapUpdates.length) {
    mapArtifactUri = sessions.saveArtifact(
      session, 'app_map', `first-run-map-${Date.now()}.json`,
      JSON.stringify({ schema: 'swipium.app_map_patch.v1', appId: session.appId ?? null, platform, patches: mapUpdates }, null, 2),
      'application/json', 'first-run app-map classifications',
    );
    evidenceUris.push(mapArtifactUri);
  }

  const accountOutcome: FirstRunResult['accountOutcome'] =
    refusedUnsafe ? 'refused_unsafe'
      : reachedVerification ? 'reached_verification'
        : createdAccount ? 'created'
          : usedProvidedCreds ? 'used_provided_credentials'
            : session.auth.loginScreenSeen ? 'pre_login_only'
              : 'not_applicable';

  result = {
    state: finalState, stoppedReason, steps, environment, decision, policySource,
    generatedVariables, mapUpdates, mapArtifactUri, evidenceUris, needsInput, pathTaken, nextRecommendedTool, accountOutcome,
  };
  return result as FirstRunResult;
}

const AUTH_PURPOSES_RUNTIME: ReadonlySet<ScreenPurpose> = new Set(['login', 'create_account', 'login_or_create_account']);

function hasProvidedCredsNow(session: Session): boolean {
  return session.inputs.some((i) => /EMAIL|PASSWORD/.test(i.varName));
}

function selectorKind(strategy: string): RecordedAction['selectorKind'] {
  switch (strategy) {
    case 'accessibility': return 'accessibility_id';
    case 'id': return 'resource_id';
    case 'text': return 'text';
    default: return 'coords';
  }
}

// Re-exported for callers that want gate/terminal sets.
export { GATE_PURPOSES, TERMINAL_PURPOSES };
