// Smoke service (hardening P0.1): the server-side smoke loop, extracted from the qa_smoke tool so
// BOTH the tool and qa_test_this execute mode run the exact same path (no MCP-over-transport). It
// launches the app, runs the deterministic baseline (snapshot quality + health + evidence shot),
// then runs every saved flow, recording a structured qa_note per workflow.

import { readFileSync } from 'node:fs';
import { parseSnapshot } from '../snapshot/parse.js';
import { adoptSnapshot, noteScreenMutation } from '../snapshot/fresh.js';
import { settle } from '../snapshot/settle.js';
import { checkHealth, isMetroRequiredFinding, type HealthResult } from '../oracle/health.js';
import * as sim from '../lib/simctl.js';
import { RENDER_WAIT_MS, waitForAppRender, type RenderWaitResult } from '../snapshot/renderWait.js';
import { metroListening } from '../lib/metroState.js';
import { recordHealthFindings } from '../oracle/record.js';
import { listFlowFiles } from '../flows/discover.js';
import { isMutatingFlowStep, parseFlow } from '../flows/schema.js';
import { runFlow, type FlowRunResult } from '../flows/run.js';
import type { Driver } from '../drivers/Driver.js';
import type { Session, SessionStore, TestNote, TestOutcome } from '../session/store.js';
import type { Flow } from '../flows/schema.js';
import { isAbortError, throwIfCancelled } from '../lib/abortScope.js';
import { AUTOMATION_DRIFT_NOTE, FAILURES } from '../oracle/failures.js';
import { WDA_SESSION_CREATE_MS, withWdaCall } from '../lib/wda.js';
import { isDeviceGoneError } from '../lib/deviceGone.js';
import { captureGuardSync } from '../lib/captureGuard.js';
import { currentScreenTitle } from '../lib/steps.js';
import type { RawNode } from '../snapshot/parse.js';

/** Per-request WDA timeout once WDA returned no UI source for the whole render wait
 *  (one re-probe, then the health check / screenshot), so a hung WDA can't stretch the baseline. */
const WDA_HUNG_PROBE_MS = 5000;

export interface SmokeResult {
  baseline: Record<string, unknown>;
  /** `skipped`: not run because it needs consent qa_smoke never asks for (mutating or external
   *  provider steps); not counted in flowsTotal and not a failure. */
  flows: Array<{ name: string; passed: boolean; skipped?: boolean; failedAtStep?: number; reason?: string }>;
  flowsPassed: number;
  /** Flows that ran or were attempted (consent-skipped flows excluded; see flowsSkipped). */
  flowsTotal: number;
  flowsSkipped?: number;
  /** The call/job was cancelled: the remaining work was skipped (not recorded as failures). */
  cancelled?: boolean;
}

const CANCELLED_REASON = 'cancelled: the call/job was aborted; not evidence about the app';

export interface SmokeOptions {
  launch?: boolean;
  runFlows?: boolean;
  variables?: Record<string, string>;
  /** Prepare found WebDriverAgent hung (POST /session timed out and /status did not
   *  answer). The app is not launched or judged again: the smoke records WDA_UNREACHABLE and blocks
   *  the saved flows instead of running a visual-only "launch pass". The text says what hung. */
  wdaUnreachable?: string;
}

/** The health verdict for a hung WDA, without one more WDA call (each would wait out its timeout):
 *  the same wda_unreachable finding checkHealth records for an empty WDA source. */
function wdaUnreachableHealth(detail: string): HealthResult {
  return {
    healthy: false,
    nativeHealthy: false,
    appHealthy: true,
    nativeStatus: 'wda_unreachable',
    appStatus: 'ok',
    foreground: 'unknown',
    findings: [{ severity: 'high', layer: 'native', kind: 'wda_unreachable', detail }],
  };
}

/** Mutating steps qa_smoke refuses to run implicitly (repo flows are untrusted): the CI set plus
 *  any `openUrl` that interpolates a `${VAR}` (would carry a resolved value off-device). */
function mutatingSteps(flow: Flow): Array<{ step: number; kind: string }> {
  const out: Array<{ step: number; kind: string }> = [];
  [...flow.setup, ...flow.steps, ...flow.teardown].forEach((step, index) => {
    if (isMutatingFlowStep(step)) out.push({ step: index + 1, kind: step.kind });
  });
  return out;
}

function externalProviderSteps(flow: Flow): Array<{ step: number; kind: string }> {
  const out: Array<{ step: number; kind: string }> = [];
  [...flow.setup, ...flow.steps, ...flow.teardown].forEach((step, index) => {
    if (step.kind === 'tapOcrText' || step.kind === 'assertOcrText') out.push({ step: index + 1, kind: step.kind });
  });
  return out;
}

/** Steps whose failure means "the recorded locator/starting state no longer matches", which for a
 *  Swipium-generated flow is automation drift, not evidence of an app defect. */
const LOCATOR_STEP_KINDS = new Set(['waitForVisible', 'tap', 'inputText', 'scrollTo']);

/** How a saved flow's failure is filed:
 *  - missing variables / fixtures (missing_data bucket) > blocked + missing_test_data, never a fail;
 *  - the flow's app is not installed (BUNDLE_ID_NOT_FOUND) > blocked + other: a setup problem, not a
 *    Swipium limitation (it read "limited by Swipium/MCP capabilities");
 *  - tool-side codes (mcp_limitation / environment bucket) > fail + mcp_limitation;
 *  - a Swipium-GENERATED flow failing on a locator step (selector timeout / not found) > fail +
 *    'other' (automation / flaky locator), not app_bug;
 *  - everything else (a hand-written assertion, a crash) stays app_bug. */
export function classifyFlowFailure(
  r: FlowRunResult,
  yamlText: string,
): { outcome: TestOutcome; category: NonNullable<TestNote['category']>; note?: string; recommendedSetup?: string } {
  // GOAL new: the session budget ran out mid-replay. Not a flow, locator or app failure.
  if (r.failureCode === 'BUDGET_EXHAUSTED')
    return {
      outcome: 'skipped',
      category: 'intentionally_skipped',
      note: 'BUDGET_EXHAUSTED: the session budget ran out, not a flow or app failure; raise it with qa_start_session { budget } and re-run',
    };
  const bucket = r.failureCode ? FAILURES[r.failureCode]?.bucket : undefined;
  if (bucket === 'missing_data') return { outcome: 'blocked', category: 'missing_test_data', note: 'missing test input, not an app bug' };
  if (r.failureCode === 'BUNDLE_ID_NOT_FOUND')
    return {
      outcome: 'blocked',
      category: 'other',
      note: "BUNDLE_ID_NOT_FOUND: the flow's app is not installed on this device, a setup problem, not an app or Swipium failure",
      recommendedSetup:
        "Install the app this flow launches (qa_prepare_target / qa_prepare_ios_target), or fix the flow's appId if it belongs to another app, then re-run.",
    };
  if (bucket === 'mcp_limitation' || bucket === 'environment' || bucket === 'unsafe_refused')
    return { outcome: 'fail', category: 'mcp_limitation' };
  const generated = /^#\s*(Generated|Compiled) by Swipium/m.test(yamlText);
  const failedKind = r.steps.find((s) => s.index === r.failedAtStep && !s.ok)?.kind ?? r.steps.find((s) => !s.ok)?.kind;
  if (generated && failedKind && LOCATOR_STEP_KINDS.has(failedKind))
    return {
      outcome: 'fail',
      category: 'other',
      note: AUTOMATION_DRIFT_NOTE, // the report keys on this text: drift is never an app failure
    };
  return { outcome: 'fail', category: 'app_bug' };
}

export async function runSmoke(sessions: SessionStore, session: Session, d: Driver, opts: SmokeOptions = {}): Promise<SmokeResult> {
  // Smoke's own notes; a saved flow it replays is noted as a flow (origin 'flow') below.
  const note = (n: Omit<TestNote, 'at'>) => sessions.addNote(session, { at: Date.now(), origin: 'smoke', ...n });
  const smokeStarted = Date.now();
  // One timeline step for the launch + health baseline.
  const launchStep = (result: 'ok' | 'failed', failureCode?: string, screenshotUri?: string, screenshotSkipped?: string) =>
    sessions.addStep(session, {
      source: 'smoke',
      action: 'launch',
      target: `launch + health${session.appId ? ` ${session.appId}` : ''}`,
      result,
      ...(failureCode ? { failureCode } : {}),
      durationMs: Date.now() - smokeStarted,
      screen: currentScreenTitle(session),
      ...(screenshotUri ? { screenshotUri } : {}),
      ...(screenshotSkipped ? { screenshotSkipped } : {}),
    });
  const doLaunch = opts.launch ?? !!session.appId;
  const baseline: Record<string, unknown> = {};
  let cancelled = false;
  let flowsBlockedBy: string | undefined; // baseline blocker that makes every flow meaningless
  let flowsBlockedNeed = 'Metro serving the JS bundle'; // what the blocked flows are missing
  let flowsBlockedTag = 'METRO_REQUIRED';

  // ---- baseline: launch > snapshot quality > health > evidence screenshot ----
  try {
    // WDA hung while prepare created its session (or while the launch below re-created
    // one): nothing on screen is judged, the saved flows are blocked (WDA_UNREACHABLE).
    let hungDetail = opts.wdaUnreachable;
    let launchedAt = Date.now(); // the "no UI source for N s" clock starts after the launch
    let settledTree = true;
    if (doLaunch && session.appId && !hungDetail) {
      try {
        // A session (re)created by the launch is capped: WDA's default 60 s for POST /session would
        // be the first of several full timeouts against a hung WDA.
        await withWdaCall({ timeoutMs: WDA_SESSION_CREATE_MS }, () => d.launchApp(session.appId!));
      } catch (e) {
        if (d.kind !== 'wda' || !/WDA POST \/session timed out/.test(String(e))) throw e;
        hungDetail = `WebDriverAgent did not create a session within ${WDA_SESSION_CREATE_MS / 1000} s after the launch (${String(e)})`;
      }
      launchedAt = Date.now();
      noteScreenMutation(session); // a snapshot from before the launch is stale (the dump below may fail)
      if (!hungDetail) {
        sessions.milestone(session, 'smoke_launch'); // the app under test was launched: qa_report's "reached the app"
        settledTree = !!(await settle(d, { timeoutMs: 8000 })).xml;
      }
    }
    // RN/Expo: don't judge the splash / "Bundling 47%" screen. Bounded wait until the app rendered.
    let render: RenderWaitResult | undefined;
    // Also with launch:false: the app may have just been (re)launched outside Swipium.
    if (session.appId && !hungDetail)
      render = await waitForAppRender(d, {
        visualOnly: session.mode === 'visual-fallback' || d.kind === 'simulator',
        metroProbe: () => metroListening(),
        // A settle that never read a tree already spent part of the one render bound
        // (launch to verdict stays within ~30 s plus the 5 s re-probe below against a hung WDA).
        ...(d.kind === 'wda' && !settledTree ? { timeoutMs: Math.max(5000, RENDER_WAIT_MS - (Date.now() - launchedAt)) } : {}),
      });
    throwIfCancelled();
    // WebDriverAgent returned no UI source for the whole render wait (after a cold
    // simulator boot it can hang while the app sits on its splash: /status and /source stop
    // answering). Every further WDA call would wait out its own 30 s timeout and every saved flow
    // would replay against it, so one short re-probe decides. Still no tree: WDA_UNREACHABLE (a
    // tool / environment failure, not the app's), the rest of the baseline runs with short WDA
    // timeouts and the saved flows are blocked.
    let wdaHung = false;
    if (d.kind === 'wda' && render && !render.ready && render.reason === 'no_tree') {
      const again = await d.dumpXml({ timeoutMs: WDA_HUNG_PROBE_MS }).catch((e: unknown) => {
        if (isAbortError(e)) throw e;
        if (isDeviceGoneError(e)) throw new Error('device offline: the bound emulator/simulator is no longer reachable (NO_DEVICE)');
        return undefined;
      });
      if (again === undefined) wdaHung = true;
      else render = { ...render, xml: again };
    }
    if (hungDetail) wdaHung = true;
    const hungForMs = Date.now() - launchedAt; // settle + render wait + re-probe: the real wait
    const boundedWda = <T>(fn: () => Promise<T>): Promise<T> => (wdaHung ? withWdaCall({ timeoutMs: WDA_HUNG_PROBE_MS }, fn) : fn());
    let quality: string | undefined;
    let screenNodes: RawNode[] | undefined;
    if (session.mode !== 'visual-fallback' && !wdaHung) {
      try {
        // The render wait's last tree is this screen: don't pay another (slow on iOS) dump for it.
        const parsed = adoptSnapshot(session, parseSnapshot(render?.xml ?? (await d.dumpXml())));
        quality = parsed.quality.verdict;
        screenNodes = parsed.allNodes;
      } catch {
        /* visual-only screen, health + screenshot still run */
      }
    }
    // A hung WDA: a wda_unreachable verdict with no further WDA call (a third dump, or the foreground
    // lookup's two /activeAppInfo requests, would each wait out their timeout).
    const health = wdaHung
      ? wdaUnreachableHealth(hungDetail ?? 'WebDriverAgent did not return a UI source')
      : await checkHealth(d, session.appId);
    // A health probe interrupted by cancellation reads as unhealthy: never record it as a finding.
    throwIfCancelled();
    if (health.deviceGone) throw new Error('device offline: the bound emulator/simulator is no longer reachable (NO_DEVICE)');
    await boundedWda(() => recordHealthFindings(sessions, session, health.findings, d, health.foreground));
    // WDA not returning a UI source (hung, or died mid-run) is a
    // tool / environment failure, not the app's: WDA_UNREACHABLE, blocked, never app_bug.
    const toolFailure = health.nativeStatus === 'wda_unreachable' && health.appStatus !== 'error';
    // A bundle-load RedBox ("No script URL provided" / "Unable to load script") or the Expo
    // dev-client launcher: the debug build has no JS bundle. Environment blocker, METRO_REQUIRED.
    const metroRequired = health.findings.some(isMetroRequiredFinding);
    // A wait that never read a tree (`no_tree`) judged nothing: app health is "unverified" below.
    const notRendered = render && !render.ready && render.reason !== 'no_tree' ? render : undefined;
    // Timed out on a blank tree (splash only), or on a loading screen ("Bundling 72%", the app's own
    // "Loading…" view; a cold Metro bundle can take 30-90 s): the app was never seen, so the launch
    // is not judged either way and is blocked, not an app bug.
    const blankLaunch = !!notRendered;
    // No UI tree was read (visual-only / dump failed) or only a blank splash: app-layer health was NOT
    // checked, so it is "unverified", never "ok" (a RedBox on a visual-only iOS run used to read as app OK).
    const appHealthLabel = (quality === undefined || blankLaunch) && health.appStatus === 'ok' ? 'unverified' : health.appStatus;
    const fatalApp =
      !metroRequired && health.appStatus === 'error' ? health.findings.find((f) => f.layer === 'app' && f.severity === 'high') : undefined;
    if (metroRequired) flowsBlockedBy = 'METRO_REQUIRED: the debug build has no JS bundle (RedBox / Expo dev launcher at launch)';
    else if (toolFailure) {
      // Every flow step would wait on the same unresponsive WDA and then be blamed on locator drift.
      flowsBlockedBy = 'WDA_UNREACHABLE: WebDriverAgent did not return a UI source after the launch; flows not run';
      flowsBlockedNeed = 'a responsive WebDriverAgent';
      flowsBlockedTag = 'WDA_UNREACHABLE';
    } else if (fatalApp || blankLaunch) {
      // Every saved flow restarts into the same broken / blank launch: don't spend ~25 s per flow
      // and then blame "locator drift". The flows are blocked by the launch failure.
      flowsBlockedBy = fatalApp
        ? `launch failed: ${fatalApp.detail}${fatalApp.evidence ? ` ("${fatalApp.evidence.slice(0, 80)}")` : ''}; flows not run`
        : 'launch not verified: the app showed only a blank / splash / loading screen; flows not run';
      flowsBlockedNeed = fatalApp ? 'an app that launches without a fatal error screen' : 'the app rendering its first screen';
      flowsBlockedTag = fatalApp ? 'launch failed' : 'app not rendered';
    }
    let shotUri: string | undefined;
    // A sensitive session or a secure field on the launch screen: no pixels, the baseline note says
    // so instead. The guard reads the tree just dumped (no extra device call against a hung WDA).
    const guard = captureGuardSync(session, screenNodes);
    const screenshotSkipped = guard.ok ? undefined : guard.note;
    if (!screenshotSkipped) {
      try {
        // A hung WDA can't screenshot either: simctl captures the simulator screen without it.
        const hungUdid = wdaHung && d.kind === 'wda' ? d.currentDevice() : undefined;
        // capture-guard: guarded by captureGuardSync above
        const png = hungUdid ? await sim.screenshot(hungUdid) : await boundedWda(() => d.screenshot());
        shotUri = sessions.saveArtifact(
          session,
          'screenshot',
          `smoke-baseline-${Date.now()}.png`,
          png,
          'image/png',
          'qa_smoke baseline evidence',
        );
        sessions.bump(session, 'screenshots');
      } catch {
        /* best-effort */
      }
    }
    const outcome: TestOutcome =
      metroRequired || toolFailure
        ? 'blocked'
        : !health.nativeHealthy || health.appStatus === 'error'
          ? 'fail'
          : blankLaunch
            ? 'blocked'
            : 'pass';
    note({
      workflow: 'launch_smoke',
      outcome,
      category:
        toolFailure && !metroRequired ? 'mcp_limitation' : outcome === 'blocked' ? 'other' : outcome === 'fail' ? 'app_bug' : undefined,
      reason:
        (metroRequired ? 'METRO_REQUIRED: debug RN/Expo build has no JS bundle (Metro not serving / dev launcher showing). ' : '') +
        (toolFailure && !metroRequired
          ? `WDA_UNREACHABLE: ${
              hungDetail
                ? hungDetail
                : `WebDriverAgent did not return a UI source${wdaHung ? ` for ${Math.round(hungForMs / 1000)} s after the launch (it can hang on the splash after a cold simulator boot)` : ''}`
            }: a tool / environment failure, launch NOT verified. `
          : '') +
        (notRendered?.blank
          ? `app showed no UI after ${Math.round(notRendered.waitedMs / 1000)} s (blank / splash screen only; a cold Metro bundle can take this long): launch NOT verified. `
          : notRendered
            ? `app never finished rendering: "${notRendered.loadingText ?? 'loading'}" still visible after ${Math.round(notRendered.waitedMs / 1000)} s (still loading; a cold Metro bundle can take this long): launch NOT verified. `
            : '') +
        `native=${health.nativeHealthy ? 'ok' : health.nativeStatus} app=${appHealthLabel}` +
        (quality ? ` quality=${quality}` : '') +
        (screenshotSkipped ? ` (${screenshotSkipped})` : ''),
      ...(metroRequired
        ? {
            missingPrecondition: 'Metro serving the JS bundle',
            recommendedSetup:
              'Start Metro for this project (qa_metro { action:"start" } or `npx expo start`), wait until it is serving, then re-run.',
          }
        : toolFailure
          ? {
              missingPrecondition: 'a responsive WebDriverAgent',
              recommendedSetup:
                'Restart WDA (qa_wda { action:"stop" }, then qa_wda { action:"setup" } and qa_wda attach) or relaunch the app (qa_ios terminate + launch), then re-run.',
            }
          : blankLaunch && outcome === 'blocked'
            ? {
                missingPrecondition: 'the app rendering its first screen',
                recommendedSetup:
                  'If Metro is still bundling, wait for it (qa_wait { for:"metro_ready" }) and re-run. If the app never leaves its splash / loading screen, that is the bug: check qa_device_info { logs } and qa_screenshot.',
              }
            : {}),
      artifactUris: shotUri ? [shotUri] : undefined,
    });
    const launchFailureCode =
      outcome === 'pass'
        ? undefined
        : metroRequired
          ? 'METRO_REQUIRED'
          : toolFailure
            ? 'WDA_UNREACHABLE'
            : blankLaunch && outcome === 'blocked'
              ? 'BLANK_SCREEN'
              : outcome === 'fail'
                ? 'APP_LAUNCH_FAILED'
                : undefined;
    const step = launchStep(outcome === 'pass' ? 'ok' : 'failed', launchFailureCode, shotUri, screenshotSkipped);
    const launchNote = session.notes.at(-1);
    if (launchNote?.workflow === 'launch_smoke') {
      launchNote.stepRange = [step.i, step.i];
      sessions.persist(session);
    }
    baseline.launch = {
      outcome,
      nativeHealth: health.nativeHealthy ? 'ok' : health.nativeStatus,
      appHealth: appHealthLabel,
      quality,
      screenshotUri: shotUri,
      ...(metroRequired ? { metroRequired: true, failureCode: 'METRO_REQUIRED' } : {}),
      ...(toolFailure && !metroRequired ? { failureCode: 'WDA_UNREACHABLE', ...(wdaHung ? { wdaHung: true } : {}) } : {}),
      ...(blankLaunch && outcome === 'blocked'
        ? { notRendered: notRendered?.blank ? 'blank' : 'loading', failureCode: 'BLANK_SCREEN' }
        : {}),
      ...(render && render.waitedMs > 0 ? { renderWait: { ready: render.ready, waitedMs: render.waitedMs, reason: render.reason } } : {}),
      ...(screenshotSkipped ? { screenshotSkipped } : {}),
    };
  } catch (e) {
    if (isAbortError(e)) {
      cancelled = true;
      note({ workflow: 'launch_smoke', outcome: 'skipped', category: 'intentionally_skipped', reason: CANCELLED_REASON });
      baseline.launch = { outcome: 'skipped', cancelled: true };
    } else {
      const offline = /NO_DEVICE/.test(String(e));
      const step = launchStep('failed', offline ? 'NO_DEVICE' : 'UNKNOWN');
      note({
        workflow: 'launch_smoke',
        outcome: 'fail',
        category: 'mcp_limitation',
        reason: `baseline failed: ${String(e)}`,
        stepRange: [step.i, step.i],
      });
      baseline.launch = { outcome: 'fail', error: String(e) };
    }
  }

  // ---- run saved flows ----
  const flowResults: SmokeResult['flows'] = [];
  if (!cancelled && (opts.runFlows ?? true)) {
    for (const f of listFlowFiles(session.root)) {
      if (isAbortError(undefined)) {
        cancelled = true;
        break;
      }
      if (flowsBlockedBy) {
        note({
          workflow: f.name,
          outcome: 'blocked',
          category: 'other',
          reason: flowsBlockedBy,
          missingPrecondition: flowsBlockedNeed,
        });
        flowResults.push({ name: f.name, passed: false, reason: `blocked (${flowsBlockedTag})` });
        continue;
      }
      const stop = sessions.budgetStop(session);
      if (stop) {
        note({ workflow: f.name, outcome: 'skipped', category: 'intentionally_skipped', reason: `budget: ${stop}` });
        flowResults.push({ name: f.name, passed: false, reason: `skipped (budget)` });
        continue;
      }
      const { flow, errors } = parseFlow(readFileSync(f.path, 'utf8'));
      if (errors.length || !flow) {
        note({
          workflow: f.name,
          outcome: 'blocked',
          category: 'other',
          reason: `flow invalid: ${errors[0] ?? 'parse error'}`,
          requiredState: 'a valid flow file',
        });
        flowResults.push({ name: f.name, passed: false, reason: 'invalid flow' });
        continue;
      }
      const mutating = mutatingSteps(flow);
      if (mutating.length) {
        // Still a blocked note (the flow did not run, which the gate must see), but a skip in the
        // smoke counts, not a failed flow.
        const reason = `skipped: mutating steps (${mutating.map((m) => `${m.step}:${m.kind}`).join(', ')}) need flow_mutation_run consent; run it with qa_flow_run`;
        note({
          workflow: f.name,
          outcome: 'blocked',
          category: 'destructive_refused',
          reason,
          recommendedSetup:
            'Run this flow with qa_flow_run and approve the flow_mutation_run consent (qa_smoke never runs mutating flows).',
        });
        flowResults.push({ name: f.name, passed: false, skipped: true, reason });
        continue;
      }
      const providerSteps = externalProviderSteps(flow);
      if (providerSteps.length) {
        const reason = `skipped: external visual-provider steps (${providerSteps.map((m) => `${m.step}:${m.kind}`).join(', ')}) need provider consent; run it with qa_flow_run`;
        note({
          workflow: f.name,
          outcome: 'blocked',
          category: 'destructive_refused',
          reason,
          recommendedSetup: 'Run this flow with qa_flow_run and approve the provider consent, or run it through reviewed CI configuration.',
        });
        flowResults.push({ name: f.name, passed: false, skipped: true, reason });
        continue;
      }
      let r: FlowRunResult;
      try {
        r = await runFlow(sessions, session, d, flow, { variables: opts.variables });
      } catch (e) {
        if (isAbortError(e)) {
          cancelled = true;
          note({ workflow: f.name, outcome: 'skipped', category: 'intentionally_skipped', reason: CANCELLED_REASON });
          flowResults.push({ name: f.name, passed: false, reason: 'cancelled' });
          break;
        }
        note({ workflow: f.name, outcome: 'fail', category: 'mcp_limitation', reason: `flow run error: ${String(e)}` });
        flowResults.push({ name: f.name, passed: false, reason: String(e) });
        continue;
      }
      if (!r.passed && (r.failureCode === 'CANCELLED' || isAbortError(undefined))) {
        cancelled = true;
        note({ workflow: f.name, outcome: 'skipped', category: 'intentionally_skipped', reason: CANCELLED_REASON });
        flowResults.push({ name: f.name, passed: false, failedAtStep: r.failedAtStep, reason: 'cancelled' });
        break;
      }
      const failShot = r.steps.find((s) => s.screenshotUri)?.screenshotUri;
      const failure = r.passed ? undefined : classifyFlowFailure(r, readFileSync(f.path, 'utf8'));
      note({
        workflow: f.name,
        outcome: r.passed ? 'pass' : (failure?.outcome ?? 'fail'),
        category: failure?.category,
        reason: r.passed
          ? `${r.steps.length} steps in ${Math.round(r.durationMs / 100) / 10}s`
          : `${failure?.outcome === 'skipped' ? 'stopped' : 'failed'} at step ${r.failedAtStep}: ${r.reason}${failure?.note ? ` (${failure.note})` : ''}`,
        ...(failure?.outcome === 'blocked'
          ? {
              missingPrecondition: r.reason,
              recommendedSetup:
                failure.recommendedSetup ??
                'Provide the flow variables via qa_flow_run { variables }, stored session inputs, or SWIPIUM_* environment variables, then re-run.',
            }
          : {}),
        artifactUris: failShot ? [failShot] : undefined,
        origin: 'flow',
        ...(r.visualStep ? { visualStep: true } : {}),
        ...(r.stepRange ? { stepRange: r.stepRange } : {}),
      });
      flowResults.push({ name: f.name, passed: r.passed, failedAtStep: r.failedAtStep, reason: r.reason });
      // WDA went unreachable during this flow: the remaining flows would each wait
      // out the same timeouts, so they are blocked instead.
      if (!r.passed && r.failureCode === 'WDA_UNREACHABLE' && !flowsBlockedBy) {
        flowsBlockedBy = `WDA_UNREACHABLE: WebDriverAgent stopped answering during flow ${f.name}; remaining flows not run`;
        flowsBlockedNeed = 'a responsive WebDriverAgent';
        flowsBlockedTag = 'WDA_UNREACHABLE';
      }
    }
  }

  return {
    baseline,
    flows: flowResults,
    flowsPassed: flowResults.filter((f) => f.passed).length,
    flowsTotal: flowResults.filter((f) => !f.skipped).length,
    ...(flowResults.some((f) => f.skipped) ? { flowsSkipped: flowResults.filter((f) => f.skipped).length } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
}
