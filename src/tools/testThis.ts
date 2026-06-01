// qa_test_this (roadmap §3.1) — the "just test this" entry point. A DETERMINISTIC orchestration
// state machine so a first run does not depend on the agent's skill or token budget. It resolves
// the project, finds (or plans a build for) an artifact, picks a target, and returns an ordered
// plan with the EXACT next tool call to make — or a typed blocker / one concise NeedsInput
// question. It performs the cheap, side-effect-free resolution itself; the heavy device steps
// (build, boot/install, smoke) are dispatched to the existing one-shot tools via `nextAction`,
// so an agent reaches real work in one or two calls instead of ten.
//
// Honesty (§2.2): the result state is exactly one of ready | needs_input | blocked | unsafe, and
// every safe fallback Swipium chose is recorded in `workaroundsAttempted` (§11).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { qaFail } from '../oracle/failures.js';
import { qaNeedsInput, NeedsInput } from '../lib/needsInput.js';
import { scanProject, type ProjectScan } from '../context/scan.js';
import { findMobileApps, classifyDiscovery } from '../context/findApps.js';
import { resolveGoalFlags, TEST_GOALS, type TestGoal } from '../orchestration/goal.js';
import { buildTerminalEnvelope, typedBlockerFromCode, type TerminalEnvelope } from '../orchestration/envelope.js';
import { resolveArtifact, type ArtifactPlatform, type ResolveResult } from '../artifacts/resolve.js';
import { buildPlan, type BuildPlatform } from '../build/plan.js';
import { adbDevices, listAvds, which, apkPackageId } from '../lib/android.js';
import { simctlAvailable, listSimulators } from '../lib/simctl.js';
import { checkWda } from '../lib/wda.js';
import { loadWdaConfig } from '../lib/wdaConfig.js';
import { planTarget, type TargetInputs, type TargetSelection, type TargetPlan } from '../core/targetPlan.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { executeBuild } from '../services/build.js';
import { convertAabToApk, universalApkCachePath } from '../artifacts/bundletool.js';
import { prepareAndroid } from '../services/prepareAndroid.js';
import { prepareIos } from '../services/prepareIos.js';
import { runSmoke } from '../services/smoke.js';
import { runExplore } from '../explore/runner.js';
import { runFirstRun, resolveFirstRunPolicy, observeScreen } from '../firstRun/firstRunRunner.js';
import { planFirstRun } from '../firstRun/firstRunPlanner.js';
import type { AppMapPatch, ScreenPurpose } from '../firstRun/types.js';
import { generateSessionReport } from '../services/report.js';
import { generateAndCompileSuite, type SuiteGenerationResult } from '../services/suiteGenerate.js';
import { buildTestThisPreflight } from '../services/preflight.js';
import { startProgress } from '../session/progress.js';
import { ensurePrelaunchAppMap } from '../appMap/prelaunch.js';
import { staticCandidatesForObservation } from '../appMap/screenMatch.js';
import type { AppKnowledgeMap } from '../appMap/schema.js';
import { DirectDriver } from '../drivers/DirectDriver.js';
import { log } from '../lib/logger.js';
import { existsSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';

type State = 'ready' | 'needs_input' | 'blocked' | 'unsafe';

// Runtime screen purposes that should trigger first-run autonomy even when static auth detection
// missed them (SWIPIUM-REQ-02 Fix Group 5).
const FIRST_RUN_TRIGGER_PURPOSES: ReadonlySet<ScreenPurpose> = new Set<ScreenPurpose>([
  'login', 'create_account', 'login_or_create_account', 'otp_or_email_verification', 'onboarding', 'permissions_prompt', 'paywall',
]);

interface PlanStep {
  tool: string;
  why: string;
  args?: Record<string, unknown>;
  status: 'pending' | 'satisfied';
  /** Symbolic outputs this step produces (e.g. artifact.path) — Milestone E. */
  produces?: string[];
  /** Symbolic inputs a later step needs before it can run. */
  requires?: string[];
}

const selToPlatform: Record<TargetSelection, BuildPlatform> = {
  'android-emulator': 'android',
  'android-real': 'android',
  'ios-simulator': 'ios',
  'ios-real': 'ios',
};

function isAndroidEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+/.test(serial);
}

export function registerTestThis(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_test_this',
    {
      title: 'Test this app (autopilot)',
      description:
        'One-shot QA orchestration for "test this". Resolves the project, finds the best installable artifact (or builds one), picks the best device/simulator, then — depending on mode — returns a plan or EXECUTES the whole path. mode: "plan" (default) returns an ordered plan + exact nextAction; "interactive" runs until the first question (login/consent) and returns it; "execute" runs build/convert→prepare→smoke→report→(suite) as a background JOB. IMPORTANT: the execute call returns immediately with state:"running" + a jobId — the TERMINAL state (completed/blocked/unsafe) and the reportUri are in the JOB RESULT, retrieved via qa_job_status (or pass waitForCompletion:true to block for short paths). Execute requests one combined consent for any privileged steps (boot, external-APK install, iOS .app install, build) BEFORE starting. Honest: typed blockers (NO_BUILD_ARTIFACT, NO_DEVICE, AAB_NEEDS_BUNDLETOOL, …), one NeedsInput at a time, a recorded workaroundsAttempted trail, and an auto-generated report in every terminal state. Creates a session if none is given.',
      inputSchema: {
        sessionId: z.string().optional().describe('Reuse an existing session; otherwise one is created.'),
        projectRoot: z.string().optional(),
        mode: z.enum(['plan', 'execute', 'interactive']).optional().describe('plan (default) | execute (run the full safe path as a job) | interactive (run until the first question).'),
        goal: z.enum(['smoke', 'explore', 'create_automation_suite', 'release_gate', 'test_login', 'reproduce_bug']).optional().describe('Autopilot intent (default smoke). Adjusts orchestration flags + required outputs only: smoke=fast launch; explore=guided exploration; create_automation_suite=explore+generate POM suite; release_gate=stricter report+readiness; test_login=drive login (stop for credentials if none); reproduce_bug=focused exploration from goalText. Explicit explore/generateSuite/stopOnNeedsInput flags override the goal default.'),
        goalText: z.string().optional().describe('For goal="reproduce_bug": a short description of the bug/flow to focus on.'),
        fastSmoke: z.boolean().optional().describe('Opt out of the default "leave behind automation" behavior: just launch + smoke, skip POM suite generation. Ignored when an explicit goal/generateSuite is given.'),
        platform: z.enum(['android', 'ios']).optional().describe('Force a platform; otherwise inferred from the artifact/devices.'),
        device: z.string().optional(),
        preferRealDevice: z.boolean().optional(),
        allowOutsideRoot: z.boolean().optional(),
        buildIfNeeded: z.boolean().optional().describe('If no artifact exists but the project is buildable, build it (default true).'),
        generateSuite: z.boolean().optional().describe('In execute mode, also generate a POM suite from the run (default false).'),
        explore: z.boolean().optional().describe('In execute mode, run guided exploration (qa_explore) after the launch smoke to discover reachable workflows + build a screen graph (default false → fast smoke only).'),
        stopOnNeedsInput: z.boolean().optional().describe('In execute mode, stop and ask when login/test-data is needed instead of testing pre-login (default false → effective pre-login coverage).'),
        waitForCompletion: z.boolean().optional().describe('In execute mode, block until the job finishes (or timeoutMs) and return the terminal result instead of a running jobId. Use for short paths.'),
        timeoutMs: z.number().optional().describe('With waitForCompletion: max ms to wait (default 120000).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, projectRoot, mode, goal, goalText, fastSmoke, platform, device, preferRealDevice, allowOutsideRoot, buildIfNeeded, generateSuite, explore, stopOnNeedsInput, waitForCompletion, timeoutMs, consentId, approve }) => {
      // Goal routing (Milestone C): the goal sets orchestration FLAGS only; explicit booleans win.
      // Default policy = "leave behind automation when possible" (fastSmoke opts out).
      const goalFlags = resolveGoalFlags(goal as TestGoal | undefined, { explore, generateSuite, stopOnNeedsInput }, { fastSmoke });
      // ---- resolve / create session ----
      let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) {
        return qaError({ what: `Unknown sessionId "${sessionId}"`, changedState: false, retrySafe: true, nextSteps: ['Omit sessionId to create one, or pass a valid session.'] });
      }
      if (!session) {
        const { resolveProjectRoot } = await import('../context/projectRoot.js');
        const resolved = await resolveProjectRoot(server, projectRoot);
        if (!resolved.root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot="/abs/path".'], clientHint: resolved.hint });
        session = sessions.create(resolved.root, undefined, {});
      }
      let root = session.root;
      const wa = (note: string) => sessions.addWorkaround(session!, note);

      // ---- 1. project scan ----
      let scan = await scanProject(root);
      // What Swipium has actually tried before any pre-execute question/blocker (review item 5):
      // concrete steps, not just the workaround log. Grows as resolution proceeds.
      const preAttempted: string[] = [`scanned project root (framework=${scan.framework})`];

      // ---- 1b. low-context app discovery (§3.1/§3.7): the root may be a monorepo or a parent
      //      directory rather than the app itself. Discover candidates and either adopt the one
      //      strong candidate (recording a workaround) or ask ONE disambiguation question. ----
      if (scan.framework === 'unknown') {
        const disc = findMobileApps(root);
        preAttempted.push(`ran low-context app discovery (searched ${disc.searchedLocations.length} location(s), found ${disc.candidates.length} candidate(s))`);
        const cls = classifyDiscovery(disc);
        if (cls.decision === 'adopt' && cls.chosen) {
          wa(`root is not itself a mobile app — discovered one candidate (${cls.chosen.framework}) at ${cls.chosen.rel}; proceeding with it`);
          root = cls.chosen.path;
          session.root = root; // adopt the app subdir as the effective project root
          sessions.persist(session);
          scan = await scanProject(root);
        } else if (cls.decision === 'disambiguate') {
          return qaNeedsInput(NeedsInput.monorepoTarget(cls.choices.map((c) => c.path)), {
            sessionId: session.id,
            state: 'needs_input' as State,
            attempted: [...preAttempted, `identified ${cls.choices.length} plausible app targets — cannot pick safely`],
            candidates: cls.choices.slice(0, 6).map((c) => ({ path: c.path, rel: c.rel, framework: c.framework, score: c.score, reasons: c.reasons })),
          });
        } else {
          const empty = scan.readiness === 'blocked' && scan.missing.some((m) => /empty/i.test(m));
          return qaFail(empty ? 'PROJECT_ROOT_EMPTY' : 'NOT_MOBILE_PROJECT', {
            what: `No supported mobile project at ${root}`,
            nextSteps: [`Searched: ${disc.searchedLocations.slice(0, 8).join('; ') || '(root only)'}`, 'Pass projectRoot="/abs/path/to/app" pointing at the app directory.'],
            extra: { sessionId: session.id, scan, searchedLocations: disc.searchedLocations, state: 'blocked' as State },
          });
        }
      } else if (scan.monorepo) {
        // The root is itself an app but also a monorepo: surface other sibling apps for disambiguation
        // only when there are genuinely multiple recognized targets to choose between.
        const disc = findMobileApps(root);
        preAttempted.push(`detected a monorepo at the root; ran app discovery (${disc.candidates.length} candidate(s))`);
        const others = disc.candidates.filter((c) => c.path !== root);
        if (others.length >= 1) {
          return qaNeedsInput(NeedsInput.monorepoTarget([root, ...others.map((c) => c.path)]), {
            sessionId: session.id,
            state: 'needs_input' as State,
            attempted: [...preAttempted, `the root app plus ${others.length} sibling app(s) are all plausible targets`],
            candidates: disc.candidates.slice(0, 6).map((c) => ({ path: c.path, rel: c.rel, framework: c.framework, score: c.score, reasons: c.reasons })),
          });
        }
        wa('monorepo detected — proceeding with the resolved root; pass projectRoot/target to disambiguate if the wrong app is chosen');
      }

      // ---- 1c. pre-launch app map (Vision Gap Fix 1): load or build the durable STATIC app map
      //      BEFORE prepare/smoke so first-run decisions, exploration seeding, automation readiness,
      //      and the report are informed by the map at the time they are made — and so the map still
      //      exists when no device/artifact is available (every blocker below carries appMapUri). ----
      let prelaunchMap: AppKnowledgeMap | undefined;
      let appMapUri: string | undefined;
      try {
        const at = new Date().toISOString();
        const pre = ensurePrelaunchAppMap(root, {
          at,
          appIdentityHints: {
            androidPackage: scan.framework === 'native-android' || scan.framework === 'expo' || scan.framework === 'bare-react-native' ? scan.appId : null,
            iosBundleId: scan.framework === 'native-ios' ? scan.appId : null,
          },
        });
        prelaunchMap = pre.map;
        appMapUri = pre.appMapUri;
        preAttempted.push(`${pre.rescanned ? 'built' : 'loaded'} static app map (${pre.reason}; ${pre.map.staticTopology.screens.length} static screen(s)) → ${pre.appMapUri}`);
        if (pre.rescanned) wa(`built static app map before launch (${pre.map.staticTopology.screens.length} screen(s)) — durable map drives first-run/exploration/report`);
      } catch (e) {
        log('warn', 'test_this pre-launch app map failed', { err: String(e) });
      }

      const buildPref = buildIfNeeded !== false;
      const steps: PlanStep[] = [];

      // ---- 2. artifact ----
      const art = await resolveArtifact({ projectRoot: root, platform: platform ?? 'any', allowOutsideRoot });
      let artifactPlatform: ArtifactPlatform | undefined = art.best?.platform;
      let needBuild = false;

      if (art.failureCode === 'ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL') {
        const outside = art.candidates.find((c) => c.outsideRoot);
        return qaNeedsInput(NeedsInput.artifactOutsideRoot(outside?.path ?? '(outside root)'), {
          sessionId: session.id,
          state: 'needs_input' as State,
          attempted: [...preAttempted, 'resolved candidate artifacts — the best one is outside the project root'],
          candidates: art.candidates.slice(0, 3),
        });
      }
      const isAab = art.best?.type === 'aab';
      if (art.best) {
        steps.push({ tool: '(resolved)', why: `Using ${art.best.type.toUpperCase()} ${art.best.path}`, status: 'satisfied' });
        if (isAab) {
          // Honest (P0.2): an .aab is not installable — it must be converted first.
          wa('only a .aab is present; qa_test_this will convert it to an installable universal APK with bundletool');
          steps.push({ tool: 'qa_test_this', why: 'Convert the .aab to an installable universal APK before install', args: { sessionId: session.id }, status: 'pending' });
        }
      } else {
        // No artifact. Build from source if possible (effective-before-exhaustive, §2.1).
        const targetPlatform: BuildPlatform = (platform ?? artifactPlatform ?? (scan.framework === 'native-ios' ? 'ios' : 'android')) as BuildPlatform;
        if (buildPref) {
          const bp = await buildPlan({ projectRoot: root, platform: targetPlatform });
          if (!bp.failureCode && bp.build && bp.toolchainOk) {
            needBuild = true;
            artifactPlatform = targetPlatform as ArtifactPlatform;
            const expoAndroidLocalRun = scan.framework === 'expo' && targetPlatform === 'android';
            wa(expoAndroidLocalRun
              ? `no prebuilt APK - Expo Android local run selected (${bp.build.command}); first run can take several minutes, later JS/TS-only work should reuse Metro/dev-build caches`
              : `no prebuilt artifact - will build ${targetPlatform} from source (${bp.build.command})`);
            steps.push({
              tool: 'qa_test_this',
              why: expoAndroidLocalRun ? 'No reusable APK/dev build found; run Expo Android local build/install/Metro path' : `No artifact found; build ${targetPlatform} from source before install`,
              args: { sessionId: session.id },
              status: 'pending',
              produces: ['artifact.path', 'artifact.appId'],
            });
          } else {
            return qaFail(bp.failureCode ?? 'NO_BUILD_ARTIFACT', {
              what: `No artifact found under ${root}, and a build is not currently possible`,
              nextSteps: [...(bp.missingToolchain.length ? [`Install: ${bp.missingToolchain.join(', ')}`] : []), ...bp.notes, `Searched: ${art.searchedLocations.slice(0, 6).join('; ')}`, ...(appMapUri ? [`Static app map is still available: qa_app_map_read { projectRoot:"${root}" }`] : [])],
              extra: { sessionId: session.id, buildPlan: bp, searchedLocations: art.searchedLocations, appMapUri, state: 'blocked' as State },
            });
          }
        } else {
          return qaFail('NO_BUILD_ARTIFACT', { what: `No artifact found under ${root}`, nextSteps: ['Build the app with your normal build command, or pass an explicit artifact path.', `Searched: ${art.searchedLocations.slice(0, 6).join('; ')}`, ...(appMapUri ? [`Static app map is still available: qa_app_map_read { projectRoot:"${root}" }`] : [])], extra: { sessionId: session.id, searchedLocations: art.searchedLocations, appMapUri, state: 'blocked' as State } });
        }
      }

      // ---- 3. target ----
      // Public v1 is simulator-only. Real-device-only artifacts and explicit real-device requests
      // are blocked instead of silently routing to non-v1 behavior.
      const iosArtifactRealOnly =
        !!art.best && art.best.platform === 'ios' && Array.isArray(art.best.installableOn) &&
        art.best.installableOn.length > 0 && art.best.installableOn.every((t) => t === 'ios-real');
      if (preferRealDevice || iosArtifactRealOnly) {
        return qaFail('BACKEND_UNSUPPORTED', {
          what: 'Swipium 1.0.0 supports Android Emulator and iOS Simulator targets only.',
          nextSteps: ['Use an Android emulator build or an iOS Simulator .app for v1.', 'Real-device workflows are outside the public v1 scope.'],
          extra: { sessionId: session.id, appMapUri, state: 'blocked' as State },
        });
      }
      const [adbPresent, simPresent] = await Promise.all([which('adb'), simctlAvailable()]);
      const [onlineAll, avds, sims] = await Promise.all([
        adbPresent ? adbDevices() : Promise.resolve<string[]>([]),
        adbPresent ? listAvds() : Promise.resolve<string[]>([]),
        simPresent ? listSimulators() : Promise.resolve([]),
      ]);
      const online = onlineAll.filter(isAndroidEmulatorSerial);
      if (device && onlineAll.includes(device) && !isAndroidEmulatorSerial(device)) {
        return qaFail('BACKEND_UNSUPPORTED', {
          what: `Android target "${device}" appears to be a real device. Swipium 1.0.0 supports Android Emulator only.`,
          nextSteps: ['Start or create an Android Emulator, then retry without a real-device serial.'],
          extra: { sessionId: session.id, appMapUri, state: 'blocked' as State },
        });
      }
      const tInputs: TargetInputs = {
        requestedPlatform: platform,
        requestedDevice: device,
        preferRealDevice: false,
        artifactPlatform,
        artifactInstallTargets: art.best?.installableOn,
        android: { online, avds },
        ios: {
          bootedSimulators: sims.filter((s) => s.state === 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
          availableSimulators: sims.filter((s) => s.state !== 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
          realDevices: [],
        },
      };
      const target = planTarget(tInputs);
      if (target.blocked) {
        return qaFail(target.blocked.failureCode, { what: target.blocked.detail, extra: { sessionId: session.id, targetPlan: target, workaroundsAttempted: session.workarounds, appMapUri, state: 'blocked' as State } });
      }
      if (target.willBoot) wa(`no online ${selToPlatform[target.selected!]} target — will boot ${target.bootTarget}`);

      const isAndroid = selToPlatform[target.selected!] === 'android';
      const isIosReal = false;
      const requiresStructuredIos =
        !isAndroid &&
        !isIosReal &&
        (goalFlags.explore || goalFlags.generateSuite || goalFlags.goal === 'test_login' || goalFlags.goal === 'create_automation_suite');
      if (requiresStructuredIos) {
        const wdaConfig = loadWdaConfig(root);
        const wda = await checkWda(wdaConfig.url, 1500);
        if (!wda.reachable || !wda.ready) {
          return qaFail('WDA_UNREACHABLE', {
            what: `iOS ${goalFlags.goal} requires a structured WebDriverAgent backend, but WDA is not ready at ${wdaConfig.url}`,
            nextSteps: [
              'Run qa_wda { action:"doctor" } to inspect WDA setup.',
              'Run qa_wda { action:"build" } and qa_wda { action:"start" }, or attach an external WDA URL.',
              ...(appMapUri ? [`Static app map is still available: qa_app_map_read { projectRoot:"${root}" }`] : []),
            ],
            extra: {
              sessionId: session.id,
              state: 'blocked' as State,
              goal: goalFlags.goal,
              target,
              wda: { config: { url: wdaConfig.url, mode: wdaConfig.mode, derivedDataPath: wdaConfig.derivedDataPath }, status: wda },
              appMapUri,
            },
          });
        }
      }

      // ---- 4. auth (be effective: proceed pre-login; surface the question as optional) ----
      let optionalQuestion: ReturnType<typeof NeedsInput.credentials> | undefined;
      if (scan.likelyAuth) {
        wa('app likely has a login — will test pre-login coverage; authenticated flows are blocked until credentials are provided');
        optionalQuestion = NeedsInput.credentials('Authenticated workflows need a test account.');
      }

      // ---- 5. assemble the ordered plan ----
      // Effective installable artifact path: a converted universal APK for an .aab, else the artifact.
      const effectiveApk = art.best ? (isAab ? universalApkCachePath(root, art.best.path) : art.best.path) : undefined;
      // Milestone E: when a build is pending, the artifact does not exist yet — use SYMBOLIC refs
      // (${artifact.path}/${artifact.appId}) and mark the dependency, never `undefined` args.
      const prepArgs: Record<string, unknown> = { sessionId: session.id };
      if (isAndroid) {
        prepArgs.apk = needBuild ? '${artifact.path}' : effectiveApk;
        if (target.device) prepArgs.device = target.device;
        if (target.willBoot && target.bootTarget) prepArgs.avd = target.bootTarget;
      } else {
        prepArgs.app = needBuild ? '${artifact.path}' : art.best?.path;
        prepArgs.bundleId = needBuild ? '${artifact.appId}' : art.best?.appId ?? undefined;
        prepArgs.simulator = target.device;
        prepArgs.attachWda = 'auto';
        if (target.device) prepArgs.device = target.device;
      }

      if (isAndroid && scan.metroNeed === 'likely') wa('debug RN/Expo build likely needs Metro/dev server serving before launch');
      steps.push({
        tool: isAndroid ? 'qa_prepare_target' : 'qa_prepare_ios_target',
        why: `Install + launch on ${target.selected}`,
        args: prepArgs,
        status: 'pending',
        ...(needBuild ? { requires: ['artifact.path', 'artifact.appId'] } : {}),
      });
      steps.push({ tool: 'qa_smoke', why: 'Run a guardrail/smoke pass and capture evidence', args: { sessionId: session.id, profile: scan.recommendedProfile }, status: 'pending' });
      steps.push({ tool: 'qa_report', why: 'Summarize what was tested/blocked with evidence', args: { sessionId: session.id }, status: 'pending' });
      steps.push({ tool: 'qa_suite_generate', why: 'Optional: turn this run into a durable POM suite', args: { sessionId: session.id }, status: 'pending' });

      const nextAction = steps.find((s) => s.status === 'pending') ?? null;
      const state: State = 'ready';

      // Choice explanations for the uniform envelope (Dev 2 owns the source data; Dev 1 the shape).
      const artifactChoice = art.best
        ? { path: art.best.path, why: `${art.best.type.toUpperCase()} selected${art.best.buildType ? ` (${art.best.buildType})` : ''}`, alternatives: art.candidates.filter((c) => c.path !== art.best!.path).slice(0, 4).map((c) => c.path) }
        : needBuild
          ? { why: 'No prebuilt artifact — building from source', alternatives: [] }
          : null;
      const targetChoice = target.selected
        ? { target: `${target.selected}${target.device ? ` (${target.device})` : ''}`, why: target.reason, alternatives: [] }
        : null;

      // ---- EXECUTE / INTERACTIVE modes (P0.1): actually run the path as a job ----
      if (mode === 'execute' || mode === 'interactive') {
        return runExecuteMode(server, sessions, session, {
          mode, scan, art, target, isAndroid, isIosReal, isAab, needBuild, effectiveApk,
          platform, goal: goalFlags.goal, goalText, releaseGate: goalFlags.releaseGate, requiredOutputs: goalFlags.requiredOutputs,
          generateSuite: goalFlags.generateSuite, explore: goalFlags.explore, stopOnNeedsInput: goalFlags.stopOnNeedsInput,
          artifactChoice, targetChoice,
          waitForCompletion: !!waitForCompletion, timeoutMs,
          consentId, approve, optionalQuestion, workaroundLog: () => session!.workarounds,
          prelaunchMap, appMapUri,
        });
      }

      const summary =
        `🚀 test-this plan for ${root} (framework=${scan.framework}, session ${session.id})\n` +
        `target: ${target.selected}${target.device ? ` (${target.device})` : ''} — ${target.reason}\n` +
        (art.best ? `artifact: ${art.best.type.toUpperCase()} ${art.best.path}` : `artifact: none — ${needBuild ? 'will build from source' : 'blocked'}`) + '\n' +
        `plan:\n${steps.map((s, i) => `  ${i + 1}. [${s.status === 'satisfied' ? '✓' : ' '}] ${s.tool} — ${s.why}`).join('\n')}\n` +
        (nextAction ? `→ next: call ${nextAction.tool} ${JSON.stringify(nextAction.args ?? {})}\n` : '') +
        (session.workarounds.length ? `workarounds: ${session.workarounds.length} (see workaroundsAttempted)\n` : '') +
        (optionalQuestion ? `note: ${optionalQuestion.question}` : '');

      return qaOk(
        {
          sessionId: session.id,
          state,
          goal: goalFlags.goal,
          framework: scan.framework,
          appMapUri,
          appIdentity: prelaunchMap?.appIdentity,
          target,
          targetChoice,
          artifact: art.best ?? null,
          artifactChoice,
          needBuild,
          recommendedProfile: scan.recommendedProfile,
          plan: steps,
          nextAction,
          workaroundsAttempted: session.workarounds,
          optionalQuestion: optionalQuestion ?? null,
          searchedLocations: art.best ? undefined : art.searchedLocations,
        },
        summary,
      );
    },
  );
}

interface ExecuteArgs {
  mode: 'execute' | 'interactive';
  scan: ProjectScan;
  art: ResolveResult;
  target: TargetPlan;
  isAndroid: boolean;
  isIosReal: boolean;
  isAab: boolean;
  needBuild: boolean;
  effectiveApk?: string;
  platform?: 'android' | 'ios';
  goal: TestGoal;
  goalText?: string;
  releaseGate: boolean;
  requiredOutputs: string[];
  artifactChoice: { path?: string; why: string; alternatives: string[] } | null;
  targetChoice: { target?: string; why: string; alternatives: string[] } | null;
  generateSuite: boolean;
  explore: boolean;
  stopOnNeedsInput: boolean;
  waitForCompletion?: boolean;
  timeoutMs?: number;
  consentId?: string;
  approve?: boolean;
  mutationConsent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string };
  testThisPlanMutation?: { affects: Record<string, unknown>; risk: 'low' | 'medium' | 'high' };
  optionalQuestion?: ReturnType<typeof NeedsInput.credentials>;
  workaroundLog: () => string[];
  /** Pre-launch static app map (Vision Gap Fix 1) — feeds first-run static candidates + report context. */
  prelaunchMap?: AppKnowledgeMap;
  appMapUri?: string;
}

/** Whether the secure store already has login credentials (so we don't re-ask). */
function hasCredentials(session: Session): boolean {
  return session.inputs.some((i) => /EMAIL|PASSWORD/.test(i.varName));
}

/** Execute / interactive orchestration: handle questions + consent synchronously, then run the
 *  build/convert → prepare → smoke → report pipeline as a job. */
async function runExecuteMode(server: McpServer, sessions: SessionStore, session: Session, a: ExecuteArgs): Promise<CallToolResult> {
  // 1. Auth question — interactive (or stopOnNeedsInput / goal:test_login) asks; execute proceeds pre-login.
  if (a.scan.likelyAuth && !hasCredentials(session) && (a.mode === 'interactive' || a.stopOnNeedsInput)) {
    const attempted = [
      `scanned project (framework=${a.scan.framework}; detected likely auth: ${a.scan.authSignals.slice(0, 3).join(', ') || 'login UI'})`,
      `resolved artifact + target (${a.target.selected ?? 'unknown'})`,
      ...session.workarounds,
    ];
    return qaNeedsInput(NeedsInput.credentials('Authenticated workflows need a test account.'), { sessionId: session.id, state: 'needs_input', attempted, appMapUri: a.appMapUri, resumeWith: 'qa_continue_from_blocker' });
  }

  // 2. Unified execution preflight (Milestone A): execute mode must request the SAME consent the
  //    lower-level tools would for boot / external-APK / iOS .app install / build-from-source.
  const buildPlatform: BuildPlatform = (a.platform ?? (a.scan.framework === 'native-ios' ? 'ios' : 'android')) as BuildPlatform;
  // Resolve the EXACT build command so the consent shows what will run (not just "build_from_source").
  let buildCommand: string | undefined;
  if (a.needBuild) {
    const bp = await buildPlan({ projectRoot: session.root, platform: buildPlatform });
    buildCommand = bp.build?.command;
  }
  // Hash an external (outside-root) APK so the consent shows what is being installed.
  let externalApk: { path: string; sha256: string } | undefined;
  if (a.isAndroid && !a.needBuild && a.effectiveApk && existsSync(a.effectiveApk) && !a.effectiveApk.startsWith(session.root + sep)) {
    try {
      externalApk = { path: a.effectiveApk, sha256: createHash('sha256').update(readFileSync(a.effectiveApk)).digest('hex') };
    } catch {
      /* unreadable — treated as in-root install */
    }
  }
  const iosApp = !a.isAndroid && !a.isIosReal ? a.art.best?.path : undefined;
  const preflight = buildTestThisPreflight({
    isAndroid: a.isAndroid,
    needBuild: a.needBuild,
    buildPlatform,
    buildCommand,
    willBoot: a.target.willBoot,
    bootTarget: a.target.bootTarget,
    isAab: a.isAab,
    apkPath: a.isAndroid ? a.effectiveApk : undefined,
    externalApk,
    iosApp,
    iosAppOutsideRoot: iosApp ? !iosApp.startsWith(session.root + sep) : undefined,
    iosReal: a.isIosReal,
    iosRealUdid: a.isIosReal ? a.target.device : undefined,
    iosRealApp: a.isIosReal ? a.art.best?.path : undefined,
  });
  let mutationConsent: ExecuteArgs['mutationConsent'];
  let testThisPlanMutation: ExecuteArgs['testThisPlanMutation'];
  if (preflight.consentRequired) {
    const gate = consumeConsent(a.consentId, a.approve, { action: 'test_this_plan', affects: preflight.consentAffects });
    if (!gate.approved) {
      sessions.recordMutation(session, {
        tool: 'qa_test_this',
        action: 'test_this_plan',
        risk: preflight.risk,
        target: preflight.consentAffects,
        consent: { required: true, approved: false },
        status: 'requested',
      });
      const consentResult = requireConsent({
        action: 'test_this_plan',
        risk: preflight.risk,
        exactCommand: preflight.exactCommand,
        affects: preflight.consentAffects,
        explain: `Running "test this" needs these privileged steps (approved together so they don't re-prompt):\n${preflight.exactCommand}\nApprove to start; Swipium then installs, smokes, reports${a.generateSuite ? ', and generates a suite' : ''}.`,
      });
      // The static app map was already built pre-launch — keep its URI on the consent result (Fix 1).
      if (a.appMapUri && consentResult.structuredContent) {
        consentResult.structuredContent = { ...(consentResult.structuredContent as Record<string, unknown>), appMapUri: a.appMapUri };
      }
      return consentResult;
    }
    mutationConsent = { required: true, consentId: a.consentId, approved: true };
    testThisPlanMutation = { affects: preflight.consentAffects, risk: preflight.risk };
    sessions.recordMutation(session, {
      tool: 'qa_test_this',
      action: 'test_this_plan',
      risk: preflight.risk,
      target: preflight.consentAffects,
      consent: mutationConsent,
      status: 'approved',
    });
  }

  const job = sessions.createJob(session, `test_this:${a.mode}`);
  const execArgs = { ...a, mutationConsent, testThisPlanMutation };
  const run = runExecutePipeline(sessions, session, job, execArgs);

  // Optional blocking mode for short paths (Milestone D). Default = return the running job.
  if (a.waitForCompletion) {
    const deadline = Date.now() + (a.timeoutMs ?? 120_000);
    await Promise.race([run, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    const cur = session.jobs.get(job.jobId);
    if (cur && cur.status !== 'running') {
      const res = (cur.result ?? {}) as Record<string, unknown>;
      return qaOk({ sessionId: session.id, mode: a.mode, jobId: job.jobId, appMapUri: a.appMapUri, ...res }, cur.resultText ?? `test-this ${a.mode} ${res.state ?? cur.status}.`);
    }
    // Timed out — leave the job running and tell the agent to poll.
    return qaOk(
      { sessionId: session.id, state: 'running', mode: a.mode, jobId: job.jobId, appMapUri: a.appMapUri, timedOutWaiting: true },
      `⏳ test-this ${a.mode} still running after the wait window — poll qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" }.`,
    );
  }

  void run;
  return qaOk(
    { sessionId: session.id, state: 'running', mode: a.mode, jobId: job.jobId, kind: job.kind, appMapUri: a.appMapUri, target: a.target },
    `🚀 test-this ${a.mode} started as job ${job.jobId} (${a.isAndroid ? 'Android' : 'iOS'} · ${a.target.selected}). Poll qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" } for the terminal result (state: completed | blocked | unsafe).`,
  );
}

type ExecState = 'completed' | 'blocked' | 'unsafe';

async function runExecutePipeline(sessions: SessionStore, session: Session, job: JobRecord, a: ExecuteArgs): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const attempted: string[] = [];
  const artifacts: string[] = [];
  const firstRunPatches: AppMapPatch[] = []; // first-run classifications folded into the durable map (§D)
  // Suite outputs (set in the terminal section) are embedded in the report, not just the job result.
  let suiteForReport: SuiteGenerationResult | undefined;
  // Every terminal state — completed OR blocked — generates a report artifact (Milestone B).
  const finish = async (state: ExecState, failureCode: string | undefined, summary: string, extra: Record<string, unknown> = {}) => {
    if (a.testThisPlanMutation) {
      sessions.recordMutation(session, {
        tool: 'qa_test_this',
        action: 'test_this_plan',
        risk: a.testThisPlanMutation.risk,
        target: a.testThisPlanMutation.affects,
        consent: a.mutationConsent,
        status: state === 'completed' ? 'executed' : 'blocked',
        detail: failureCode,
      });
    }
    const reportProg = startProgress(sessions, session, job, 'reporting', { statusText: 'Generating the session report.' });
    let reportUri: string | undefined;
    let manifestUri: string | undefined;
    let appVerdict: { status: string; summary: string } | undefined;
    let coverageVerdict: { status: string; summary: string } | undefined;
    const suiteOpt = suiteForReport
      ? { generated: !suiteForReport.skipped, skippedReason: suiteForReport.skippedReason, name: suiteForReport.name, written: suiteForReport.written, compiledFlows: suiteForReport.compiledFlows, suiteRunnable: suiteForReport.suiteRunnable, readinessLabels: suiteForReport.readinessLabels }
      : undefined;
    try {
      const r = await generateSessionReport(sessions, session, {
        format: 'summary', includeCurrentDump: true, suite: suiteOpt,
      });
      reportUri = r.reportUri;
      manifestUri = r.manifestUri;
      if (!artifacts.includes(reportUri)) artifacts.push(reportUri);
      appVerdict = (r.report as { appVerdict?: { status: string; summary: string } }).appVerdict;
      coverageVerdict = (r.report as { coverageVerdict?: { status: string; summary: string } }).coverageVerdict;
    } catch (e) {
      log('warn', 'test_this report generation failed', { err: String(e) });
    }
    reportProg.done('Report ready.');
    const native = session.findings.some((f) => f.layer === 'native' && f.severity === 'high') ? 'error' : 'OK';
    const app = session.findings.some((f) => f.layer === 'app' && f.severity === 'high') ? 'error' : session.findings.some((f) => f.layer === 'app' && f.severity === 'medium') ? 'degraded' : 'OK';
    // The report already exists — point the agent AT it (fetch/open), not back at qa_report.
    const nextRecommendedAction =
      state === 'completed'
        ? reportUri
          ? {
              tool: 'qa_get_artifact',
              args: { uri: reportUri },
              why: `Open the generated report (${reportUri})`,
            }
          : { tool: 'qa_report', args: { sessionId: session.id }, why: 'Generate the report' }
        : { tool: 'qa_explain_blocker', args: { failureCode: failureCode ?? 'UNKNOWN' }, why: 'Understand the blocker and how to fix it' };
    // Uniform terminal envelope (Milestone B): summarizable from structured output, no log parsing.
    const envelope: TerminalEnvelope = buildTerminalEnvelope({
      state,
      sessionId: session.id,
      jobId: job.jobId,
      summary,
      attempted,
      workaroundsAttempted: session.workarounds,
      artifactChoice: a.artifactChoice,
      targetChoice: a.targetChoice,
      verdicts: { ...(appVerdict ? { app: appVerdict } : {}), ...(coverageVerdict ? { coverage: coverageVerdict } : {}) },
      blockers: state === 'completed' || !failureCode ? [] : [typedBlockerFromCode(failureCode)],
      reportUri: reportUri ?? null,
      nextRecommendedAction,
    });
    upd({
      status: state === 'completed' ? 'done' : 'failed',
      progress: state,
      result: {
        ...envelope,
        // Pre-launch static app map URI is present in EVERY terminal state — including blocked (Fix 1).
        appMapUri: a.appMapUri,
        goal: a.goal, requiredOutputs: a.requiredOutputs, releaseGateRequested: a.releaseGate,
        failureCode, artifacts, manifestUri,
        health: { native, app },
        inputsProvided: session.inputs.map((i) => i.varName),
        notes: session.notes.length, findings: session.findings.length, ...extra,
      },
      resultText: summary + (reportUri ? `\nreport: ${reportUri}` : ''),
      endedAt: Date.now(),
    });
  };

  try {
    // ---- A. obtain an installable artifact ----
    let apkPath = a.isAndroid ? a.effectiveApk : undefined;
    let appPath = !a.isAndroid ? a.art.best?.path : undefined;
    let appId = a.art.best?.appId ?? a.scan.appId ?? undefined;

    if (a.needBuild) {
      const prog = startProgress(sessions, session, job, a.isAndroid ? 'building_android' : 'building_ios', { statusText: 'Building the app from source.', nextExpected: 'Resolve the produced artifact, then install.' });
      attempted.push('build from source');
      const targetPlatform: BuildPlatform = (a.platform ?? (a.scan.framework === 'native-ios' ? 'ios' : 'android')) as BuildPlatform;
      const plan = await buildPlan({ projectRoot: session.root, platform: targetPlatform });
      const res = await executeBuild(sessions, session, plan, { signal, onProgress: (p) => prog.event(p, { statusText: `Building: ${p}` }) });
      if (res.logUri) artifacts.push(res.logUri);
      if (signal?.aborted) return;
      if (!res.ok || !res.artifact) {
        return await finish('blocked', res.failureCode ?? 'BUILD_FAILED', `❌ Build failed (${res.failureCode}). A build failure is NOT a test failure. Log: ${res.logUri ?? 'n/a'}`, { buildLog: res.logUri });
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
        return await finish('blocked', conv.failureCode ?? 'AAB_NEEDS_BUNDLETOOL', `❌ Could not convert the .aab (${conv.failureCode}): ${conv.error}. Install bundletool or build an APK directly.`);
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
      const prog = startProgress(sessions, session, job, 'preparing_android', { statusText: `Installing + launching ${appId}.`, nextExpected: 'Run smoke.' });
      attempted.push('prepare android (boot/install/launch)');
      const driver = (session.driver as DirectDriver | undefined) ?? new DirectDriver();
      driver.setSignal?.(signal);
      const res = await prepareAndroid(sessions, session, driver, {
        needBoot: a.target.willBoot, bootTarget: a.target.bootTarget, serial: a.target.device,
        resolvedAppId: appId, apkPath, rnDebug, allowLaunchWithoutMetro: false, mutationConsent: a.mutationConsent,
      }, { signal, onProgress: (p) => prog.event(p) });
      if (res.aborted) return;
      if (!res.ok) {
        if (res.failureCode === 'METRO_REQUIRED') prog.needsUser('Metro must be serving for this debug build.');
        return await finish('blocked', res.failureCode ?? 'APP_LAUNCH_FAILED', `❌ Prepare failed: ${res.error}`);
      }
      prog.done(res.resultText ?? 'App launched.');
    } else {
      const prog = startProgress(sessions, session, job, 'preparing_ios', { statusText: 'Booting simulator + installing/launching .app.', nextExpected: 'Run smoke.' });
      attempted.push('prepare ios (boot/install/launch)');
      const res = await prepareIos(sessions, session, { app: appPath, bundleId: appId, simulator: a.target.device, attachWda: 'auto', mutationConsent: a.mutationConsent }, { onProgress: (p) => prog.event(p) });
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
    for (const art of session.artifacts) if (!artifacts.includes(art.uri)) artifacts.push(art.uri);
    smokeProg.done(`smoke done — flows ${smoke.flowsPassed}/${smoke.flowsTotal}.`);

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
          const staticCandidates = a.prelaunchMap ? staticCandidatesForObservation(a.prelaunchMap, { foreground: obs.foreground, visibleText: obs.visibleText }) : undefined;
          runtimePurpose = planFirstRun({ ...obs, screenSignature: obs.screenSignature, appError: obs.appError, staticCandidates }, session, { policy, decision }).classification.purpose;
        } catch {
          /* classification best-effort; fall back to the static signal */
        }
        const shouldFirstRun = a.scan.likelyAuth || (runtimePurpose != null && FIRST_RUN_TRIGGER_PURPOSES.has(runtimePurpose));
        if (shouldFirstRun) {
          const frProg = startProgress(sessions, session, job, 'first_run', { statusText: 'First-run autonomy: auth/onboarding with safe test data.' });
          attempted.push(`first-run autonomy (trigger: ${a.scan.likelyAuth ? 'static_auth' : `runtime_${runtimePurpose}`})`);
          const fr = await runFirstRun(sessions, session, driver, { mode: 'until_home', appMap: a.prelaunchMap }, { signal, onProgress: (p) => frProg.event(p) });
          for (const u of fr.evidenceUris) if (!artifacts.includes(u)) artifacts.push(u);
          firstRunPatches.push(...fr.mapUpdates); // folded into the durable app map in §D
          sessions.addWorkaround(session, `first-run: ${fr.pathTaken} path → ${fr.accountOutcome} (${fr.environment.environment} env)`);
          frProg.done(`first-run ${fr.state} — account ${fr.accountOutcome}`);
        }
      } catch (e) {
        log('warn', 'test_this first-run autonomy failed', { jobId: job.jobId, err: String(e) });
      }
    }

    // ---- C2. optional guided exploration (§9.1) ----
    if (a.explore && (smoke.baseline.launch as { outcome?: string } | undefined)?.outcome !== 'fail') {
      const exProg = startProgress(sessions, session, job, 'exploring', { statusText: 'Guided exploration of reachable screens.' });
      attempted.push('guided exploration');
      try {
        const ex = await runExplore(sessions, session, driver, { stopOnAuth: a.stopOnNeedsInput, goal: a.goalText }, { signal, onProgress: (p) => exProg.event(p) });
        const at = Date.now();
        const graphUri = sessions.saveArtifact(session, 'explore', `graph-${at}.json`, JSON.stringify(ex.graph.serialize(new Date(at).toISOString()), null, 2), 'application/json', 'exploration screen graph');
        const graphMdUri = sessions.saveArtifact(session, 'explore', `graph-${at}.md`, ex.graph.toMarkdown(new Date(at).toISOString()), 'text/markdown', 'exploration screen graph (readable)');
        sessions.setExploration(session, { at, graphUri, graphMdUri, state: ex.state, stoppedReason: ex.stoppedReason, summary: ex.summary });
        if (!artifacts.includes(graphUri)) artifacts.push(graphUri);
        exProg.done(`explored ${ex.summary.screensVisited} screens`);
      } catch (e) {
        exProg.done(`exploration error: ${String(e)}`);
      }
    }

    // ---- D. optional suite generation (Milestone C — really writes + compiles, or honest skip) ----
    let suite: SuiteGenerationResult | undefined;
    if (a.generateSuite) {
      const suiteProg = startProgress(sessions, session, job, 'suite_generating', { statusText: 'Generating + compiling a POM suite from the run.' });
      attempted.push('generate suite');
      suite = generateAndCompileSuite(sessions, session, { save: true, compile: true });
      if (suite.skipped) {
        suiteProg.done(`suite skipped — ${suite.skippedReason}`);
      } else {
        for (const w of suite.written) {
          const uri = `file://${w}`;
          if (!artifacts.includes(uri)) artifacts.push(uri);
        }
        sessions.addWorkaround(session, `generated a POM suite (${suite.compiledFlows.filter((c) => c.ok).length} runnable flow(s))`);
        suiteProg.done(`suite ready — runnable=${suite.suiteRunnable}`);
      }
      suiteForReport = suite; // embed suite outputs in the report artifact (item 3)
    }

    // ---- D2. App Knowledge Map (SWIPIUM-REQ-01) — update the durable map after runtime execution.
    // Best-effort: a map failure must never turn a passing run into a blocked one.
    let appMap: { appMapUri?: string; appMapSummary?: Record<string, unknown>; mapCoverageDelta?: Record<string, number> } | undefined;
    try {
      const { buildAppMap, summarizeMap, quickCoverage } = await import('../appMap/build.js');
      const at = new Date().toISOString();
      const before = quickCoverage(session.root, at);
      // If guided exploration ran, merge its screen graph too (links runtime → static screens).
      let exploreGraph: import('../explore/graph.js').SerializedGraph | null = null;
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
      const built = buildAppMap(session.root, { mode: 'runtime_merge', at, sessionId: session.id, exploreGraph, firstRunPatches, persist: true });
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
    const suiteResult = suite
      ? { generated: !suite.skipped, skippedReason: suite.skippedReason, written: suite.written, compiledFlows: suite.compiledFlows, suiteRunnable: suite.suiteRunnable, readinessLabels: suite.readinessLabels, manifestPath: suite.manifestPath ?? null }
      : undefined;
    const summary =
      `${hardFail ? '⚠️' : '✅'} test-this ${a.mode} ${hardFail ? 'finished with findings' : 'completed'} on ${a.target.selected}.\n` +
      `smoke: launch=${launchOutcome ?? 'unknown'}, flows ${smoke.flowsPassed}/${smoke.flowsTotal}; findings=${session.findings.length}.` +
      (suite ? `\nsuite: ${suite.skipped ? `skipped (${suite.skippedReason})` : `${suite.compiledFlows.filter((c) => c.ok).length}/${suite.compiledFlows.length} runnable flow(s)`}` : '');
    await finish('completed', undefined, summary + (appMap?.appMapUri ? `\nappMap: ${appMap.appMapUri}` : ''), {
      smoke: { launch: launchOutcome ?? 'unknown', flowsPassed: smoke.flowsPassed, flowsTotal: smoke.flowsTotal },
      highFindings: session.findings.filter((f) => f.severity === 'high').length,
      ...(suiteResult ? { suite: suiteResult } : {}),
      ...(appMap ? { appMapUri: appMap.appMapUri, appMapSummary: appMap.appMapSummary, mapCoverageDelta: appMap.mapCoverageDelta } : {}),
    });
  } catch (e) {
    if (signal?.aborted) return;
    log('error', 'test_this execute pipeline failed', { jobId: job.jobId, err: String(e) });
    await finish('blocked', 'UNKNOWN', `❌ Execution error: ${String(e)}`);
  }
}
