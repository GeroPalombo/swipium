// qa_test_this execute pipeline: the background job that does the heavy device work:
// A. obtain an installable artifact (build from source / .aab > APK) > B. prepare
// (boot/install/launch) > C. smoke (+ first-run autonomy, optional guided exploration) >
// D. optional suite generation + durable app-map update > E. terminal state (./terminal.js
// generates the report and lands the uniform envelope on the job result).

import { buildPlan, type BuildPlatform } from '../../build/plan.js';
import { apkPackageId } from '../../lib/android.js';
import { executeBuild } from '../../services/build.js';
import { convertAabToApk } from '../../artifacts/bundletool.js';
import { prepareAndroid } from '../../services/prepareAndroid.js';
import { prepareIos } from '../../services/prepareIos.js';
import { androidTargetAvd } from '../../session/attach.js';
import { runSmoke } from '../../services/smoke.js';
import { linkExploreStep, runExplore } from '../../explore/runner.js';
import { runFirstRun, resolveFirstRunPolicy, observeScreen } from '../../firstRun/firstRunRunner.js';
import { planFirstRun } from '../../firstRun/firstRunPlanner.js';
import type { AppMapPatch, ScreenPurpose } from '../../firstRun/types.js';
import { generateAndCompileSuite, type SuiteGenerationResult } from '../../services/suiteGenerate.js';
import { startProgress } from '../../session/progress.js';
import { staticCandidatesForObservation } from '../../appMap/screenMatch.js';
import { DirectDriver } from '../../drivers/DirectDriver.js';
import { log } from '../../lib/logger.js';
import * as sim from '../../lib/simctl.js';
import { readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { bundleServing, metroListening, METRO_PORT } from '../../lib/metroState.js';
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
// missed them.
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
 * Register generated suite files as session artifacts. qa_get_artifact and the
 * swipium:// resource template resolve only URIs recorded via sessions.saveArtifact, so pushing
 * bare `file://` paths into the job artifacts advertised an unfetchable deliverable. Each written
 * file is copied into the session's artifact store and its swipium:// URI pushed into `artifacts`;
 * the on-disk location stays visible in the artifact label (repo-relative path) and in the job
 * result's `suite.written`. Names are prefixed with their .swipium subdir (pages/login.yaml >
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

/** The blocker after a launch into a bundle-load RedBox / the Expo dev launcher. "Start Metro" is
 *  wrong when another project's Metro holds the port (qa_metro start refuses: METRO_WRONG_PROJECT)
 *  and loops when this project's Metro already serves and the dev client just isn't connected. */
async function metroBlocker(session: Session, isAndroid: boolean): Promise<{ code: string; summary: string; howToFix?: string }> {
  const srv = await bundleServing(undefined, session.root);
  if (srv.wrongProject) {
    const how = `Stop the other project's Metro (${srv.metroProjectRoot ?? 'unknown root'}); Swipium did not start it, so it will not stop it for you. Then start this project's Metro and re-run.`;
    return { code: 'METRO_WRONG_PROJECT', summary: `❌ The app launched without its JS bundle: ${srv.detail}. ${how}`, howToFix: how };
  }
  // This project's Metro answers on localhost (IPv6 ::1, e.g. `expo start --localhost`)
  // but not on 127.0.0.1, where the dev client / adb reverse connects. "Start Metro" would loop.
  if (srv.serving && !(await metroListening(METRO_PORT, '127.0.0.1'))) {
    const how =
      `This project's Metro is serving on localhost (::1) port ${METRO_PORT}, but nothing answers on 127.0.0.1:${METRO_PORT}, where the app connects ("Could not connect to development server"). ` +
      `Restart Metro so it listens on all interfaces (drop --localhost, or stop it and run qa_metro { action:"start" }), then re-run.`;
    return { code: 'METRO_REQUIRED', summary: `❌ ${how}`, howToFix: how };
  }
  if (srv.serving && session.findings.some((f) => f.kind === 'expo_dev_launcher')) {
    const url = `http://localhost:${METRO_PORT}`;
    const scheme = await devClientScheme(session, isAndroid);
    const link = scheme ? `${scheme}://expo-development-client/?url=${encodeURIComponent(url)}` : undefined;
    const dev = session.device ?? '<device>';
    const cmd = link
      ? isAndroid
        ? `adb -s ${dev} shell am start -a android.intent.action.VIEW -d "${link}"`
        : `xcrun simctl openurl ${dev} "${link}"`
      : undefined;
    const how =
      `This project's Metro is already serving at ${url}, but the Expo dev client is showing its launcher (it is not connected). ` +
      `Connect it: ${cmd ? `run \`${cmd}\`, or ` : ''}tap the server in the launcher's list / "Enter URL manually" with ${url}. Then re-run.`;
    return { code: 'METRO_REQUIRED', summary: `❌ ${how}`, howToFix: how };
  }
  return {
    code: 'METRO_REQUIRED',
    summary:
      '❌ The app launched without its JS bundle (RN RedBox "No script URL provided" / "Unable to load script", or the Expo dev-client launcher). Start Metro for this project (qa_metro { action:"start" }), wait until it is serving, then re-run.',
  };
}

/** The Expo dev-client deep-link scheme (`exp+<slug>`, registered by expo-dev-client): from a static
 *  app.json, else a literal `slug:` in app.config.ts/js, else (iOS) the installed app's own
 *  `exp+*` URL scheme (so a dynamic app.config.ts project still gets a deep link). */
async function devClientScheme(session: Session, isAndroid: boolean): Promise<string | undefined> {
  const valid = (slug: unknown) => (typeof slug === 'string' && /^[\w.-]+$/.test(slug) ? `exp+${slug}` : undefined);
  try {
    const cfg = JSON.parse(readFileSync(join(session.root, 'app.json'), 'utf8')) as { expo?: { slug?: unknown } };
    const fromJson = valid(cfg.expo?.slug);
    if (fromJson) return fromJson;
  } catch {
    /* no / unreadable app.json */
  }
  for (const f of ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs']) {
    try {
      const m = readFileSync(join(session.root, f), 'utf8').match(/\bslug\s*:\s*["'`]([\w.-]+)["'`]/);
      if (m) return valid(m[1]);
    } catch {
      /* not this file */
    }
  }
  if (isAndroid || !session.device || !session.appId) return undefined;
  const app = await sim.appContainer(session.device, session.appId).catch(() => null);
  if (!app) return undefined;
  return (await sim.appUrlSchemes(app)).find((s) => /^exp\+[\w.-]+$/.test(s));
}

export async function runExecutePipeline(sessions: SessionStore, session: Session, job: JobRecord, a: ExecuteArgs): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const attempted: string[] = [];
  const artifacts: string[] = [];
  const firstRunPatches: AppMapPatch[] = []; // first-run classifications folded into the durable map (section D)
  // Suite outputs (set in the terminal section) are embedded in the report, not just the job result.
  let suiteForReport: SuiteGenerationResult | undefined;
  // Every terminal state (completed OR blocked) generates a report artifact.
  const finish = createFinisher({ sessions, session, job, a, attempted, artifacts, getSuiteForReport: () => suiteForReport, upd });

  try {
    // ---- A. obtain an installable artifact ----
    let apkPath = a.isAndroid ? a.effectiveApk : undefined;
    let appPath = !a.isAndroid ? a.art.best?.path : undefined;
    let appId = a.art.best?.appId ?? a.scan.appId ?? undefined;

    // An Android build that needs an AVD booted boots it FIRST, in Swipium's own tracked
    // headless boot (the consented one), so `expo run:android --device <AVD>` finds it running
    // instead of booting it itself. Prepare (B) then installs on that serial.
    let bootedSerial: string | undefined;
    if (a.isAndroid && a.needBuild && a.target.willBoot && a.target.bootTarget) {
      const prog = startProgress(sessions, session, job, 'booting_emulator', {
        statusText: `Booting ${a.target.bootTarget} before the build.`,
        nextExpected: 'Build the app from source.',
      });
      attempted.push(`boot ${a.target.bootTarget} before the build`);
      const driver = session.driver instanceof DirectDriver ? session.driver : new DirectDriver();
      const res = await prepareAndroid(
        sessions,
        session,
        driver,
        {
          needBoot: true,
          bootTarget: a.target.bootTarget,
          resolvedAppId: appId ?? '',
          bindOnly: true,
          mutationConsent: a.mutationConsent,
        },
        { signal, onProgress: (p) => prog.event(p) },
      );
      if (res.aborted || signal?.aborted) return;
      if (!res.ok)
        return await finish('blocked', res.failureCode ?? 'EMULATOR_BOOT_FAILED', `❌ Boot failed: ${res.error}`, { appLaunched: false });
      bootedSerial = res.device;
      prog.done(`${a.target.bootTarget} booted as ${bootedSerial}.`);
    }

    if (a.needBuild) {
      const prog = startProgress(sessions, session, job, a.isAndroid ? 'building_android' : 'building_ios', {
        statusText: 'Building the app from source.',
        nextExpected: 'Resolve the produced artifact, then install.',
      });
      attempted.push('build from source');
      const targetPlatform: BuildPlatform = (a.platform ?? (a.scan.framework === 'native-ios' ? 'ios' : 'android')) as BuildPlatform;
      // Same pinned device as the consented build command (execute.ts): expo run:android --device <AVD>.
      const plan = await buildPlan({
        projectRoot: session.root,
        platform: targetPlatform,
        device: a.isAndroid ? await androidTargetAvd(a.target) : undefined,
      });
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
      const prog = startProgress(sessions, session, job, 'converting_aab', { statusText: 'Converting .aab > universal APK (bundletool).' });
      attempted.push('aab > apk conversion');
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
      sessions.addWorkaround(session, 'converted .aab > universal .apk for install');
    }

    // ---- B. prepare (boot/install/launch) ----
    let wdaHungAtPrepare: string | undefined; // WDA hung creating its session
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
      // The job's signal is scoped by execute.ts (runWithSignal), so adb calls inherit it.
      const res = await prepareAndroid(
        sessions,
        session,
        driver,
        {
          needBoot: a.target.willBoot && !bootedSerial,
          bootTarget: a.target.bootTarget,
          serial: bootedSerial ?? a.target.device,
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
        return await finish('blocked', res.failureCode ?? 'APP_LAUNCH_FAILED', `❌ Prepare failed: ${res.error}`, { appLaunched: false });
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
        {
          app: appPath,
          bundleId: appId,
          // The consented target: the online simulator, or the one the plan boots (never "any booted").
          simulator: a.target.device ?? a.target.bootTarget,
          attachWda: 'auto',
          mutationConsent: a.mutationConsent,
        },
        // The job's signal stops prepare between install / launch / WDA steps (and kills the install).
        { signal, onProgress: (p) => prog.event(p) },
      );
      if (signal?.aborted) return; // cancelled: the job already says so, never a prepare blocker
      if (!res.ok) {
        if (res.failureCode === 'METRO_REQUIRED' || res.failureCode === 'METRO_WRONG_PROJECT')
          prog.needsUser('Metro must be serving for this debug build.');
        // The app never launched (not a PASS), and the blocker carries the launch step's own
        // concrete recovery (re-boot / install / logs) so nextRecommendedAction is a real call.
        return await finish('blocked', res.failureCode ?? 'APP_LAUNCH_FAILED', `❌ iOS prepare failed: ${res.error}`, {
          appLaunched: false,
          ...(res.nextSteps?.length ? { blockerHowToFix: res.nextSteps.join(' ') } : {}),
        });
      }
      prog.done(res.resultText ?? 'iOS app launched.');
      wdaHungAtPrepare = res.wdaHung;
    }

    if (signal?.aborted) return;
    // ---- C. smoke ----
    const smokeProg = startProgress(sessions, session, job, 'smoke', { statusText: 'Running the smoke pass + saved flows.' });
    attempted.push('smoke');
    const driver = session.driver;
    if (!driver) return await finish('blocked', 'NO_DEVICE', '❌ No driver bound after prepare.');
    // A WDA that hung at prepare is not worked around with a visual-only "launch pass": the smoke
    // records WDA_UNREACHABLE and blocks the saved flows (the block below then stops the run).
    const smoke = await runSmoke(sessions, session, driver, {
      variables: sessions.inputVariables(session),
      ...(wdaHungAtPrepare ? { wdaUnreachable: wdaHungAtPrepare } : {}),
    });
    if (smoke.cancelled || signal?.aborted) return; // cancelled smoke: not completed, nothing more to run
    sessions.milestone(session, 'smoke_completed'); // persisted flag: qa_status must not re-recommend qa_smoke
    for (const art of session.artifacts) if (!artifacts.includes(art.uri)) artifacts.push(art.uri);
    smokeProg.done(`smoke done: flows ${smoke.flowsPassed}/${smoke.flowsTotal}.`);
    // The launched debug RN/Expo build shows a bundle-load RedBox / the Expo dev launcher (both
    // platforms; iOS has no pre-launch Metro gate): stop with METRO_REQUIRED, never judge further.
    if ((smoke.baseline.launch as { metroRequired?: boolean } | undefined)?.metroRequired) {
      smokeProg.needsUser('Metro must be serving for this debug build.');
      const mb = await metroBlocker(session, a.isAndroid);
      return await finish('blocked', mb.code, mb.summary, mb.howToFix ? { blockerHowToFix: mb.howToFix } : {});
    }
    // The launch only ever showed a blank / splash tree (e.g. a cold Metro bundle): not judged.
    if ((smoke.baseline.launch as { failureCode?: string } | undefined)?.failureCode === 'BLANK_SCREEN') {
      return await finish(
        'blocked',
        'BLANK_SCREEN',
        '❌ The app showed only a blank / splash / loading screen after launch, so it was not judged. If Metro was still bundling, wait for it (qa_wait { for:"metro_ready" }) and re-run; if the app never leaves its splash / loading screen, that is the bug.',
      );
    }
    // WebDriverAgent stopped returning a UI source after the launch (e.g. hung on the
    // splash after a cold simulator boot): a tool / environment blocker, not an app verdict, and
    // nothing after this (first-run, exploration, suite) could run on it.
    if ((smoke.baseline.launch as { failureCode?: string } | undefined)?.failureCode === 'WDA_UNREACHABLE') {
      return await finish(
        'blocked',
        'WDA_UNREACHABLE',
        '❌ WebDriverAgent stopped responding after the launch (no UI source, or no session), so the app was not judged and the saved flows were not run (a tool / environment problem, not an app bug). Restart WDA (qa_wda { action:"stop" }, then qa_wda { action:"setup" } and qa_wda attach) or relaunch the app, then re-run.',
      );
    }

    let pendingQuestion: NeedsInputPayload | undefined;
    let firstRunState: string | undefined; // drives the explicit test_login outcome
    // ---- C1.5 first-run autonomy: when the app appears gated AND the environment
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
          firstRunPatches.push(...fr.mapUpdates); // folded into the durable app map in section D
          sessions.addWorkaround(session, `first-run: ${fr.pathTaken} path > ${fr.accountOutcome} (${fr.environment.environment} env)`);
          frProg.done(`first-run ${fr.state}, account ${fr.accountOutcome}`);
          firstRunState = fr.state;
          if (fr.needsInput && !isLoginDeclined(session)) pendingQuestion = firstRunQuestion(fr.needsInput, session.id, attempted);
        }
      } catch (e) {
        log('warn', 'test_this first-run autonomy failed', { jobId: job.jobId, err: String(e) });
      }
    }

    // A first-run question the caller asked to stop on (stopOnNeedsInput / goal:test_login) ends the
    // job in needs_input. The ONE question + resume call ride on the result (report still generated).
    if (pendingQuestion && a.stopOnNeedsInput) {
      return await finish(
        'needs_input',
        undefined,
        `❓ test-this ${a.mode} paused after smoke: ${pendingQuestion.question}\nsmoke: launch=${(smoke.baseline.launch as { outcome?: string } | undefined)?.outcome ?? 'unknown'}, flows ${smoke.flowsPassed}/${smoke.flowsTotal}.`,
        { needsInput: pendingQuestion },
      );
    }
    // Goal test_login always ends with an explicit login outcome, never a silent pass.
    if (a.goal === 'test_login') {
      const auth = session.auth;
      const loggedIn = auth.loginPerformed === true && firstRunState === 'completed';
      sessions.addNote(
        session,
        loggedIn
          ? {
              at: Date.now(),
              workflow: 'login',
              outcome: 'pass',
              reason: 'logged in with the provided credentials; first-run gates cleared',
            }
          : auth.loginPerformed
            ? {
                at: Date.now(),
                workflow: 'login',
                // Not proven an app bug (wrong credentials, OTP, onboarding): blocked, with evidence to check.
                outcome: 'blocked',
                reason: `credentials were submitted but the run did not get past the login/first-run gates (first-run: ${firstRunState ?? 'not run'}); check the screenshots`,
              }
            : {
                at: Date.now(),
                workflow: 'login',
                outcome: 'blocked',
                ...(auth.loginScreenSeen
                  ? {
                      category: hasUsableCredentials(session) ? undefined : ('missing_test_data' as const),
                      reason: 'a login screen was seen but the login was not performed',
                      recommendedSetup:
                        'Set SWIPIUM_TEST_EMAIL / SWIPIUM_TEST_PASSWORD in the server env (or answer the credentials question).',
                    }
                  : {
                      reason:
                        auth.authedAtStart === true
                          ? 'no login screen reachable: the app started already logged in (persisted session); log out or clear app data to test login'
                          : 'no login screen reachable: no login UI was observed in this run',
                      missingPrecondition: 'a reachable login screen',
                    }),
              },
      );
    }

    // Otherwise the question is OPTIONAL: pre-login coverage stands, and the question is surfaced on
    // the completed result instead of being dropped. The static question comes from a login
    // dependency in the code; when first-run reached home without any login screen, say exactly
    // that instead of "this app appears to require login".
    const loginNotSeen = firstRunState === 'completed' && !session.auth.loginScreenSeen;
    const optionalQuestion: NeedsInputPayload | undefined =
      pendingQuestion ??
      (a.optionalQuestion && !hasUsableCredentials(session) && !isLoginDeclined(session)
        ? {
            ...a.optionalQuestion,
            ...(loginNotSeen
              ? {
                  question: a.optionalQuestion.question.replace(
                    /^[^]*?This app appears to require login\./,
                    'A login dependency was found in the code, but no login screen was seen in this run (it reached home). If parts of the app need an account:',
                  ),
                }
              : {}),
            resume: { tool: a.optionalQuestion.resume.tool, args: { sessionId: session.id, ...a.optionalQuestion.resume.args } },
          }
        : undefined);

    // ---- C2. optional guided exploration ----
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
        linkExploreStep(sessions, session, ex.stepIndex, graphUri);
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

    // ---- D. optional suite generation (really writes + compiles, or honest skip) ----
    let suite: SuiteGenerationResult | undefined;
    if (a.generateSuite) {
      const suiteProg = startProgress(sessions, session, job, 'suite_generating', {
        statusText: 'Generating + compiling a POM suite from the run.',
      });
      attempted.push('generate suite');
      suite = generateAndCompileSuite(sessions, session, { save: true, compile: true });
      if (suite.skipped) {
        suiteProg.done(`suite skipped: ${suite.skippedReason}`);
      } else {
        registerSuiteArtifacts(sessions, session, suite.written, artifacts);
        sessions.addWorkaround(session, `generated a POM suite (${suite.compiledFlows.filter((c) => c.ok).length} runnable flow(s))`);
        suiteProg.done(`suite ready: runnable=${suite.suiteRunnable}`);
      }
      suiteForReport = suite; // embed suite outputs in the report artifact
    }

    // ---- D2. App Knowledge Map: update the durable map after runtime execution.
    // Best-effort: a map failure must never turn a passing run into a blocked one.
    let appMap: { appMapUri?: string; appMapSummary?: Record<string, unknown>; mapCoverageDelta?: Record<string, number> } | undefined;
    try {
      const { buildAppMap, summarizeMap, quickCoverage } = await import('../../appMap/build.js');
      const at = new Date().toISOString();
      const before = quickCoverage(session.root, at);
      // If guided exploration ran, merge its screen graph too (links runtime > static screens).
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
      // Static topology was already built/refreshed pre-launch (Fix 1), so merge runtime on top. With no
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

    // reproduce_bug names the bug in the report. Swipium explored toward goalText but can't
    // judge reproduction itself, so the outcome is an explicit "not verified" for the agent to settle.
    if (a.goal === 'reproduce_bug') {
      const bug = (a.goalText ?? '').trim();
      sessions.addNote(session, {
        at: Date.now(),
        workflow: `reproduce_bug: ${bug ? bug.slice(0, 120) : '(no goalText given)'}`,
        outcome: 'blocked',
        reason: bug
          ? `not verified: exploration was focused on "${bug.slice(0, 200)}" (${session.exploration ? `${session.exploration.summary.screensVisited} screen(s) visited` : 'no exploration'}), but reproduction is not judged automatically`
          : 'not verified: no goalText describing the bug was given',
        missingPrecondition: 'a manual check of the bug on the device',
        recommendedSetup: bug
          ? 'Follow the bug steps with qa_act / qa_screenshot, then record reproduced (fail) or not reproduced (pass) with qa_note and re-run qa_report.'
          : 'Re-run with goalText describing the bug.',
      });
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
      (optionalQuestion
        ? `\noptional question (${loginNotSeen && !pendingQuestion ? 'no login screen seen' : 'pre-login coverage only so far'}): ${optionalQuestion.question}`
        : '');
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
