// qa_test_this execute pipeline — the background job that does the heavy device work:
// A. obtain an installable artifact (build from source / .aab → APK) → B. prepare
// (boot/install/launch) → C. smoke (+ first-run autonomy, optional guided exploration) →
// D. optional suite generation + durable app-map update → E. terminal state (./terminal.js
// generates the report and lands the uniform envelope on the job result).

import { buildPlan, type BuildPlatform } from '../../build/plan.js';
import { apkPackageId } from '../../lib/android.js';
import { executeBuild } from '../../services/build.js';
import { convertAabToApk } from '../../artifacts/bundletool.js';
import { prepareAndroid } from '../../services/prepareAndroid.js';
import { prepareIos } from '../../services/prepareIos.js';
import { runSmoke } from '../../services/smoke.js';
import { runExplore } from '../../explore/runner.js';
import { runFirstRun, resolveFirstRunPolicy, observeScreen } from '../../firstRun/firstRunRunner.js';
import { planFirstRun } from '../../firstRun/firstRunPlanner.js';
import type { AppMapPatch, ScreenPurpose } from '../../firstRun/types.js';
import { generateAndCompileSuite, type SuiteGenerationResult } from '../../services/suiteGenerate.js';
import { startProgress } from '../../session/progress.js';
import { staticCandidatesForObservation } from '../../appMap/screenMatch.js';
import { DirectDriver } from '../../drivers/DirectDriver.js';
import { log } from '../../lib/logger.js';
import { readFileSync } from 'node:fs';
import { extname, relative, sep } from 'node:path';
import type { Session, SessionStore, JobRecord } from '../../session/store.js';
import type { ExecuteArgs } from './types.js';
import { createFinisher } from './terminal.js';
import { NeedsInput, type NeedsInputPayload } from '../../lib/needsInput.js';
import { hasUsableCredentials, isLoginDeclined } from './sessionIntent.js';

/** The one NeedsInput question a first-run stop maps to, with the exact resume call bound to the session. */
export function firstRunQuestion(needsInput: { kind: string; reason: string }, sessionId: string, attempted: string[]): NeedsInputPayload {
  const base =
    needsInput.kind === 'otp_or_manual_verification'
      ? NeedsInput.otp(`First-run stopped: ${needsInput.reason}.`)
      : needsInput.kind === 'create_test_data'
        ? NeedsInput.createTestData(needsInput.reason)
        : NeedsInput.credentials(`First-run stopped: ${needsInput.reason}.`);
  return { ...base, attempted: [...attempted], resume: { tool: base.resume.tool, args: { sessionId, ...base.resume.args } } };
}

/** Compact view of the app-map summary for the job result (full map stays at appMapUri). */
function compactMapSummary(summary: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!summary) return undefined;
  const cov = (summary.coverage ?? {}) as Record<string, unknown>;
  return {
    staticScreens: summary.staticScreens,
    runtimeScreens: summary.runtimeScreens,
    features: Array.isArray(summary.features) ? summary.features.length : undefined,
    coveragePercent: cov.overallPercent,
  };
}

// Runtime screen purposes that should trigger first-run autonomy even when static auth detection
// missed them (SWIPIUM-REQ-02 Fix Group 5).
const FIRST_RUN_TRIGGER_PURPOSES: ReadonlySet<ScreenPurpose> = new Set<ScreenPurpose>([
  'login',
  'create_account',
  'login_or_create_account',
  'otp_or_email_verification',
  'onboarding',
  'permissions_prompt',
  'paywall',
]);

const SUITE_MIME_BY_EXT: Record<string, string> = {
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.py': 'text/x-python',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

/**
 * Register generated suite files as session artifacts (SWIP-07). qa_get_artifact and the
 * swipium:// resource template resolve only URIs recorded via sessions.saveArtifact, so pushing
 * bare `file://` paths into the job artifacts advertised an unfetchable deliverable. Each written
 * file is copied into the session's artifact store and its swipium:// URI pushed into `artifacts`;
 * the on-disk location stays visible in the artifact label (repo-relative path) and in the job
 * result's `suite.written`. Names are prefixed with their .swipium subdir (pages/login.yaml →
 * pages-login.yaml) so same-named files from different subdirs cannot collide.
 */
export function registerSuiteArtifacts(sessions: SessionStore, session: Session, written: string[], artifacts: string[]): string[] {
  const uris: string[] = [];
  const seen = new Set<string>();
  for (const w of written) {
    if (seen.has(w)) continue;
    seen.add(w);
    const rel = relative(session.root, w);
    const name = rel
      .replace(/^\.swipium[\\/]/, '')
      .split(sep)
      .join('-');
    const mime = SUITE_MIME_BY_EXT[extname(w).toLowerCase()] ?? 'text/plain';
    try {
      const uri = sessions.saveArtifact(session, 'suite', name, readFileSync(w, 'utf8'), mime, `generated suite file (${rel})`);
      uris.push(uri);
      if (!artifacts.includes(uri)) artifacts.push(uri);
    } catch (e) {
      log('warn', 'suite artifact registration failed', { path: w, err: String(e) });
    }
  }
  return uris;
}

export async function runExecutePipeline(sessions: SessionStore, session: Session, job: JobRecord, a: ExecuteArgs): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const attempted: string[] = [];
  const artifacts: string[] = [];
  const firstRunPatches: AppMapPatch[] = []; // first-run classifications folded into the durable map (§D)
  // Suite outputs (set in the terminal section) are embedded in the report, not just the job result.
  let suiteForReport: SuiteGenerationResult | undefined;
  // Every terminal state — completed OR blocked — generates a report artifact (Milestone B).
  const finish = createFinisher({ sessions, session, job, a, attempted, artifacts, getSuiteForReport: () => suiteForReport, upd });

  try {
    // ---- A. obtain an installable artifact ----
    let apkPath = a.isAndroid ? a.effectiveApk : undefined;
    let appPath = !a.isAndroid ? a.art.best?.path : undefined;
    let appId = a.art.best?.appId ?? a.scan.appId ?? undefined;

    if (a.needBuild) {
      const prog = startProgress(sessions, session, job, a.isAndroid ? 'building_android' : 'building_ios', {
        statusText: 'Building the app from source.',
        nextExpected: 'Resolve the produced artifact, then install.',
      });
      attempted.push('build from source');
      const targetPlatform: BuildPlatform = (a.platform ?? (a.scan.framework === 'native-ios' ? 'ios' : 'android')) as BuildPlatform;
      const plan = await buildPlan({ projectRoot: session.root, platform: targetPlatform });
      const res = await executeBuild(sessions, session, plan, {
        signal,
        onProgress: (p) => prog.event(p, { statusText: `Building: ${p}` }),
      });
      if (res.logUri) artifacts.push(res.logUri);
      if (signal?.aborted) return;
      if (!res.ok) {
        const code = res.failureCode ?? 'BUILD_FAILED';
        return await finish('blocked', code, `Build failed (${code}). A build failure is not a test failure. Log: ${res.logUri ?? 'n/a'}`, {
          buildLog: res.logUri,
        });
      }
      if (!res.artifact) {
        const code = res.failureCode ?? 'BUILD_ARTIFACT_UNRESOLVED_AFTER_SUCCESS';
        const searched = res.searchedLocations?.length ? ` Searched: ${res.searchedLocations.slice(0, 6).join(', ')}` : '';
        return await finish(
          'blocked',
          code,
          `Build succeeded, but Swipium could not resolve the produced ${a.isAndroid ? 'APK' : 'simulator app'}. This is not an app build failure. Log: ${res.logUri ?? 'n/a'}.${searched}`,
          { buildLog: res.logUri },
        );
      }
      prog.done('Build complete.');
      if (a.isAndroid) apkPath = res.artifact.path;
      else appPath = res.artifact.path;
      appId = res.artifact.appId ?? appId;
    } else if (a.isAab && a.art.best) {
      const prog = startProgress(sessions, session, job, 'converting_aab', { statusText: 'Converting .aab → universal APK (bundletool).' });
      attempted.push('aab → apk conversion');
      const conv = await convertAabToApk(a.art.best.path, session.root, { signal });
      if (signal?.aborted) return;
      if (!conv.ok) {
        return await finish(
          'blocked',
          conv.failureCode ?? 'AAB_NEEDS_BUNDLETOOL',
          `❌ Could not convert the .aab (${conv.failureCode}): ${conv.error}. Install bundletool or build an APK directly.`,
        );
      }
      prog.done('Universal APK ready.');
      apkPath = conv.apkPath;
      sessions.addWorkaround(session, 'converted .aab → universal .apk for install');
    }

    // ---- B. prepare (boot/install/launch) ----
    if (a.isAndroid) {
      if (!apkPath) return await finish('blocked', 'NO_BUILD_ARTIFACT', '❌ No installable APK to prepare.');
      if (!appId) appId = (await apkPackageId(apkPath)) ?? undefined;
      if (!appId) return await finish('blocked', 'BUNDLE_ID_NOT_FOUND', '❌ Could not determine the app id from the APK.');
      const rnDebug = a.scan.metroNeed === 'likely';
      const prog = startProgress(sessions, session, job, 'preparing_android', {
        statusText: `Installing + launching ${appId}.`,
        nextExpected: 'Run smoke.',
      });
      attempted.push('prepare android (boot/install/launch)');
      // No unchecked cast: a session left on an iOS (WDA/simctl) driver gets a fresh adb driver.
      const driver = session.driver instanceof DirectDriver ? session.driver : new DirectDriver();
      driver.setSignal(signal);
      const res = await prepareAndroid(
        sessions,
        session,
        driver,
        {
          needBoot: a.target.willBoot,
          bootTarget: a.target.bootTarget,
          serial: a.target.device,
          resolvedAppId: appId,
          apkPath,
          rnDebug,
          allowLaunchWithoutMetro: false,
          mutationConsent: a.mutationConsent,
        },
        { signal, onProgress: (p) => prog.event(p) },
      );
      if (res.aborted) return;
      if (!res.ok) {
        if (res.failureCode === 'METRO_REQUIRED') prog.needsUser('Metro must be serving for this debug build.');
        return await finish('blocked', res.failureCode ?? 'APP_LAUNCH_FAILED', `❌ Prepare failed: ${res.error}`);
      }
      prog.done(res.resultText ?? 'App launched.');
    } else {
      const prog = startProgress(sessions, session, job, 'preparing_ios', {
        statusText: 'Booting simulator + installing/launching .app.',
        nextExpected: 'Run smoke.',
      });
      attempted.push('prepare ios (boot/install/launch)');
      const res = await prepareIos(
        sessions,
        session,
        { app: appPath, bundleId: appId, simulator: a.target.device, attachWda: 'auto', mutationConsent: a.mutationConsent },
        { onProgress: (p) => prog.event(p) },
      );
      if (!res.ok) return await finish('blocked', res.failureCode ?? 'APP_LAUNCH_FAILED', `❌ iOS prepare failed: ${res.error}`);
      prog.done(res.resultText ?? 'iOS app launched.');
    }

    if (signal?.aborted) return;
    // ---- C. smoke ----
    const smokeProg = startProgress(sessions, session, job, 'smoke', { statusText: 'Running the smoke pass + saved flows.' });
    attempted.push('smoke');
    const driver = session.driver;
    if (!driver) return await finish('blocked', 'NO_DEVICE', '❌ No driver bound after prepare.');
    const smoke = await runSmoke(sessions, session, driver, { variables: sessions.inputVariables(session) });
    sessions.milestone(session, 'smoke_completed'); // persisted flag — qa_status must not re-recommend qa_smoke
    for (const art of session.artifacts) if (!artifacts.includes(art.uri)) artifacts.push(art.uri);
    smokeProg.done(`smoke done — flows ${smoke.flowsPassed}/${smoke.flowsTotal}.`);

    let pendingQuestion: NeedsInputPayload | undefined;
    // ---- C1.5 first-run autonomy (SWIPIUM-REQ-02): when the app appears gated AND the environment
    //      is a disposable test/staging one where generated accounts are policy-safe, progress
    //      through auth/onboarding before exploring. Safe-by-default: in an unknown/production-like
    //      environment the decision is "not allowed" and this block is skipped (pre-login coverage
    //      stands, and the optional credentials question is still surfaced). ----
    if ((smoke.baseline.launch as { outcome?: string } | undefined)?.outcome !== 'fail') {
      try {
        // Fix Group 5: trigger first-run from the ACTUAL first runtime screen, not only the static
        // auth signal. Classify the current screen read-only; if it is auth/onboarding/paywall/
        // permission/verification, route through first-run logic (which itself refuses generated
        // account creation in unknown/production-like environments and surfaces NeedsInput instead).
        const { policy, decision } = resolveFirstRunPolicy(session);
        let runtimePurpose: ScreenPurpose | undefined;
        try {
          const obs = await observeScreen(sessions, session, driver);
          // Fix 2: corroborate the observed first screen with static app-map candidates.
          const staticCandidates = a.prelaunchMap
            ? staticCandidatesForObservation(a.prelaunchMap, { foreground: obs.foreground, visibleText: obs.visibleText })
            : undefined;
          runtimePurpose = planFirstRun(
            { ...obs, screenSignature: obs.screenSignature, appError: obs.appError, staticCandidates },
            session,
            { policy, decision },
          ).classification.purpose;
        } catch {
          /* classification best-effort; fall back to the static signal */
        }
        const shouldFirstRun = a.scan.likelyAuth || (runtimePurpose != null && FIRST_RUN_TRIGGER_PURPOSES.has(runtimePurpose));
        if (shouldFirstRun) {
          const frProg = startProgress(sessions, session, job, 'first_run', {
            statusText: 'First-run autonomy: auth/onboarding with safe test data.',
          });
          attempted.push(`first-run autonomy (trigger: ${a.scan.likelyAuth ? 'static_auth' : `runtime_${runtimePurpose}`})`);
          const fr = await runFirstRun(
            sessions,
            session,
            driver,
            { mode: 'until_home', appMap: a.prelaunchMap },
            { signal, onProgress: (p) => frProg.event(p) },
          );
          for (const u of fr.evidenceUris) if (!artifacts.includes(u)) artifacts.push(u);
          firstRunPatches.push(...fr.mapUpdates); // folded into the durable app map in §D
          sessions.addWorkaround(session, `first-run: ${fr.pathTaken} path → ${fr.accountOutcome} (${fr.environment.environment} env)`);
          frProg.done(`first-run ${fr.state} — account ${fr.accountOutcome}`);
          if (fr.needsInput && !isLoginDeclined(session)) pendingQuestion = firstRunQuestion(fr.needsInput, session.id, attempted);
        }
      } catch (e) {
        log('warn', 'test_this first-run autonomy failed', { jobId: job.jobId, err: String(e) });
      }
    }

    // A first-run question the caller asked to stop on (stopOnNeedsInput / goal:test_login) ends the
    // job in needs_input — the ONE question + resume call ride on the result (report still generated).
    if (pendingQuestion && a.stopOnNeedsInput) {
      return await finish(
        'needs_input',
        undefined,
        `❓ test-this ${a.mode} paused after smoke: ${pendingQuestion.question}\nsmoke: launch=${(smoke.baseline.launch as { outcome?: string } | undefined)?.outcome ?? 'unknown'}, flows ${smoke.flowsPassed}/${smoke.flowsTotal}.`,
        { needsInput: pendingQuestion },
      );
    }
    // Otherwise the question is OPTIONAL: pre-login coverage stands, and the question is surfaced on
    // the completed result instead of being dropped.
    const optionalQuestion: NeedsInputPayload | undefined =
      pendingQuestion ??
      (a.optionalQuestion && !hasUsableCredentials(session) && !isLoginDeclined(session)
        ? {
            ...a.optionalQuestion,
            resume: { tool: a.optionalQuestion.resume.tool, args: { sessionId: session.id, ...a.optionalQuestion.resume.args } },
          }
        : undefined);

    // ---- C2. optional guided exploration (§9.1) ----
    if (a.explore && (smoke.baseline.launch as { outcome?: string } | undefined)?.outcome !== 'fail') {
      const exProg = startProgress(sessions, session, job, 'exploring', { statusText: 'Guided exploration of reachable screens.' });
      attempted.push('guided exploration');
      try {
        const ex = await runExplore(
          sessions,
          session,
          driver,
          { stopOnAuth: a.stopOnNeedsInput, goal: a.goalText },
          { signal, onProgress: (p) => exProg.event(p) },
        );
        const at = Date.now();
        const graphUri = sessions.saveArtifact(
          session,
          'explore',
          `graph-${at}.json`,
          JSON.stringify(ex.graph.serialize(new Date(at).toISOString()), null, 2),
          'application/json',
          'exploration screen graph',
        );
        const graphMdUri = sessions.saveArtifact(
          session,
          'explore',
          `graph-${at}.md`,
          ex.graph.toMarkdown(new Date(at).toISOString()),
          'text/markdown',
          'exploration screen graph (readable)',
        );
        sessions.setExploration(session, {
          at,
          graphUri,
          graphMdUri,
          state: ex.state,
          stoppedReason: ex.stoppedReason,
          summary: ex.summary,
        });
        if (!artifacts.includes(graphUri)) artifacts.push(graphUri);
        exProg.done(`explored ${ex.summary.screensVisited} screens`);
      } catch (e) {
        exProg.done(`exploration error: ${String(e)}`);
      }
    }

    // ---- D. optional suite generation (Milestone C — really writes + compiles, or honest skip) ----
    let suite: SuiteGenerationResult | undefined;
    if (a.generateSuite) {
      const suiteProg = startProgress(sessions, session, job, 'suite_generating', {
        statusText: 'Generating + compiling a POM suite from the run.',
      });
      attempted.push('generate suite');
      suite = generateAndCompileSuite(sessions, session, { save: true, compile: true });
      if (suite.skipped) {
        suiteProg.done(`suite skipped — ${suite.skippedReason}`);
      } else {
        registerSuiteArtifacts(sessions, session, suite.written, artifacts);
        sessions.addWorkaround(session, `generated a POM suite (${suite.compiledFlows.filter((c) => c.ok).length} runnable flow(s))`);
        suiteProg.done(`suite ready — runnable=${suite.suiteRunnable}`);
      }
      suiteForReport = suite; // embed suite outputs in the report artifact (item 3)
    }

    // ---- D2. App Knowledge Map (SWIPIUM-REQ-01) — update the durable map after runtime execution.
    // Best-effort: a map failure must never turn a passing run into a blocked one.
    let appMap: { appMapUri?: string; appMapSummary?: Record<string, unknown>; mapCoverageDelta?: Record<string, number> } | undefined;
    try {
      const { buildAppMap, summarizeMap, quickCoverage } = await import('../../appMap/build.js');
      const at = new Date().toISOString();
      const before = quickCoverage(session.root, at);
      // If guided exploration ran, merge its screen graph too (links runtime → static screens).
      let exploreGraph: import('../../explore/graph.js').SerializedGraph | null = null;
      if (session.exploration?.graphUri) {
        const found = sessions.findArtifact(session.exploration.graphUri);
        if (found) {
          try {
            exploreGraph = JSON.parse(readFileSync(found.rec.path, 'utf8'));
          } catch {
            /* ignore unreadable graph */
          }
        }
      }
      // Static topology was already built/refreshed pre-launch (Fix 1) — merge runtime on top. With no
      // existing map (pre-launch failed) runtime_merge still rescans static (doRescan when !existed).
      const built = buildAppMap(session.root, {
        mode: 'runtime_merge',
        at,
        sessionId: session.id,
        exploreGraph,
        firstRunPatches,
        persist: true,
      });
      const after = built.map.coverage;
      appMap = {
        appMapUri: built.save?.resourceUri,
        appMapSummary: summarizeMap(built.map),
        mapCoverageDelta: {
          coveragePercent: after.overallPercent - before.overallPercent,
          runtimeScreens: after.runtimeScreens - before.runtimeScreens,
          staticScreens: after.staticScreens - before.staticScreens,
        },
      };
      if (built.save?.resourceUri && !artifacts.includes(built.save.resourceUri)) artifacts.push(built.save.resourceUri);
    } catch (e) {
      log('warn', 'test_this app map update failed', { jobId: job.jobId, err: String(e) });
    }

    // ---- E. terminal state (report is generated inside finish) ----
    const launchOutcome = (smoke.baseline.launch as { outcome?: string } | undefined)?.outcome;
    const hardFail = session.findings.some((f) => f.severity === 'high') || launchOutcome === 'fail';
    // Compact: counts + paths, not every compiled flow (the report artifact embeds the full suite).
    const suiteResult = suite
      ? {
          generated: !suite.skipped,
          skippedReason: suite.skippedReason,
          written: suite.written.slice(0, 20),
          writtenCount: suite.written.length,
          runnableFlows: suite.compiledFlows.filter((c) => c.ok).length,
          totalFlows: suite.compiledFlows.length,
          suiteRunnable: suite.suiteRunnable,
          readinessLabels: suite.readinessLabels,
          manifestPath: suite.manifestPath ?? null,
        }
      : undefined;
    const summary =
      `${hardFail ? '⚠️' : '✅'} test-this ${a.mode} ${hardFail ? 'finished with findings' : 'completed'} on ${a.target.selected}.\n` +
      `smoke: launch=${launchOutcome ?? 'unknown'}, flows ${smoke.flowsPassed}/${smoke.flowsTotal}; findings=${session.findings.length}.` +
      (suite
        ? `\nsuite: ${suite.skipped ? `skipped (${suite.skippedReason})` : `${suite.compiledFlows.filter((c) => c.ok).length}/${suite.compiledFlows.length} runnable flow(s)`}`
        : '') +
      (optionalQuestion ? `\noptional question (pre-login coverage only so far): ${optionalQuestion.question}` : '');
    await finish('completed', undefined, summary + (appMap?.appMapUri ? `\nappMap: ${appMap.appMapUri}` : ''), {
      ...(optionalQuestion ? { optionalQuestion } : {}),
      smoke: { launch: launchOutcome ?? 'unknown', flowsPassed: smoke.flowsPassed, flowsTotal: smoke.flowsTotal },
      highFindings: session.findings.filter((f) => f.severity === 'high').length,
      ...(suiteResult ? { suite: suiteResult } : {}),
      ...(appMap
        ? { appMapUri: appMap.appMapUri, appMapSummary: compactMapSummary(appMap.appMapSummary), mapCoverageDelta: appMap.mapCoverageDelta }
        : {}),
    });
  } catch (e) {
    if (signal?.aborted) return;
    log('error', 'test_this execute pipeline failed', { jobId: job.jobId, err: String(e) });
    await finish('blocked', 'UNKNOWN', `❌ Execution error: ${String(e)}`);
  }
}
