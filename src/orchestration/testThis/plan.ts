// qa_test_this plan-phase resolution (roadmap §3.1) — the cheap, side-effect-free half of the
// orchestration state machine. Resolves the session/project, finds (or plans a build for) an
// artifact, picks a target, and returns an ordered plan with the EXACT next tool call to make —
// or a typed blocker / one concise NeedsInput question. Execute/interactive modes are dispatched
// to runExecuteMode (./execute.js).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaOk, qaError } from '../../lib/result.js';
import { qaFail } from '../../oracle/failures.js';
import { qaNeedsInput, NeedsInput } from '../../lib/needsInput.js';
import { scanProject } from '../../context/scan.js';
import { findMobileApps, classifyDiscovery } from '../../context/findApps.js';
import { resolveGoalFlags, type TestGoal } from '../goal.js';
import { resolveArtifact, type ArtifactPlatform } from '../../artifacts/resolve.js';
import { buildPlan, type BuildPlatform } from '../../build/plan.js';
import { adbDevices, listAvds, which } from '../../lib/android.js';
import { simctlAvailable, listSimulators } from '../../lib/simctl.js';
import { checkWda } from '../../lib/wda.js';
import { loadWdaConfig } from '../../lib/wdaConfig.js';
import { planTarget, type TargetInputs } from '../../core/targetPlan.js';
import { universalApkCachePath } from '../../artifacts/bundletool.js';
import { ensurePrelaunchAppMap } from '../../appMap/prelaunch.js';
import type { AppKnowledgeMap } from '../../appMap/schema.js';
import { log } from '../../lib/logger.js';
import type { Session, SessionStore } from '../../session/store.js';
import { type State, type PlanStep, type TestThisInput, selToPlatform, isAndroidEmulatorSerial } from './types.js';
import { runExecuteMode } from './execute.js';

export async function handleTestThis(server: McpServer, sessions: SessionStore, input: TestThisInput): Promise<CallToolResult> {
  const {
    sessionId,
    projectRoot,
    mode,
    goal,
    goalText,
    fastSmoke,
    platform,
    device,
    preferRealDevice,
    allowOutsideRoot,
    buildIfNeeded,
    generateSuite,
    explore,
    stopOnNeedsInput,
    waitForCompletion,
    timeoutMs,
    consentId,
    approve,
  } = input;
  // Goal routing (Milestone C): the goal sets orchestration FLAGS only; explicit booleans win.
  // Default policy = "leave behind automation when possible" (fastSmoke opts out).
  const goalFlags = resolveGoalFlags(goal as TestGoal | undefined, { explore, generateSuite, stopOnNeedsInput }, { fastSmoke });
  // ---- resolve / create session ----
  let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;
  if (sessionId && !session) {
    return qaError({
      what: `Unknown sessionId "${sessionId}"`,
      changedState: false,
      retrySafe: true,
      nextSteps: ['Omit sessionId to create one, or pass a valid session.'],
    });
  }
  if (!session) {
    const { resolveProjectRoot } = await import('../../context/projectRoot.js');
    const resolved = await resolveProjectRoot(server, projectRoot);
    if (!resolved.root)
      return qaError({
        what: 'Could not resolve a project root',
        changedState: false,
        retrySafe: true,
        nextSteps: ['Pass projectRoot="/abs/path".'],
        clientHint: resolved.hint,
      });
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
    preAttempted.push(
      `ran low-context app discovery (searched ${disc.searchedLocations.length} location(s), found ${disc.candidates.length} candidate(s))`,
    );
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
        candidates: cls.choices
          .slice(0, 6)
          .map((c) => ({ path: c.path, rel: c.rel, framework: c.framework, score: c.score, reasons: c.reasons })),
      });
    } else {
      const empty = scan.readiness === 'blocked' && scan.missing.some((m) => /empty/i.test(m));
      return qaFail(empty ? 'PROJECT_ROOT_EMPTY' : 'NOT_MOBILE_PROJECT', {
        what: `No supported mobile project at ${root}`,
        nextSteps: [
          `Searched: ${disc.searchedLocations.slice(0, 8).join('; ') || '(root only)'}`,
          'Pass projectRoot="/abs/path/to/app" pointing at the app directory.',
        ],
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
        candidates: disc.candidates
          .slice(0, 6)
          .map((c) => ({ path: c.path, rel: c.rel, framework: c.framework, score: c.score, reasons: c.reasons })),
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
        androidPackage:
          scan.framework === 'native-android' || scan.framework === 'expo' || scan.framework === 'bare-react-native' ? scan.appId : null,
        iosBundleId: scan.framework === 'native-ios' ? scan.appId : null,
      },
    });
    prelaunchMap = pre.map;
    appMapUri = pre.appMapUri;
    preAttempted.push(
      `${pre.rescanned ? 'built' : 'loaded'} static app map (${pre.reason}; ${pre.map.staticTopology.screens.length} static screen(s)) → ${pre.appMapUri}`,
    );
    if (pre.rescanned)
      wa(
        `built static app map before launch (${pre.map.staticTopology.screens.length} screen(s)) — durable map drives first-run/exploration/report`,
      );
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
      steps.push({
        tool: 'qa_test_this',
        why: 'Convert the .aab to an installable universal APK before install',
        args: { sessionId: session.id },
        status: 'pending',
      });
    }
  } else {
    // No artifact. Build from source if possible (effective-before-exhaustive, §2.1).
    const targetPlatform: BuildPlatform = (platform ??
      artifactPlatform ??
      (scan.framework === 'native-ios' ? 'ios' : 'android')) as BuildPlatform;
    if (buildPref) {
      const bp = await buildPlan({ projectRoot: root, platform: targetPlatform });
      if (!bp.failureCode && bp.build && bp.toolchainOk) {
        needBuild = true;
        artifactPlatform = targetPlatform as ArtifactPlatform;
        const expoAndroidLocalRun = scan.framework === 'expo' && targetPlatform === 'android';
        wa(
          expoAndroidLocalRun
            ? `no prebuilt APK - Expo Android local run selected (${bp.build.command}); first run can take several minutes, later JS/TS-only work should reuse Metro/dev-build caches`
            : `no prebuilt artifact - will build ${targetPlatform} from source (${bp.build.command})`,
        );
        steps.push({
          tool: 'qa_test_this',
          why: expoAndroidLocalRun
            ? 'No reusable APK/dev build found; run Expo Android local build/install/Metro path'
            : `No artifact found; build ${targetPlatform} from source before install`,
          args: { sessionId: session.id },
          status: 'pending',
          produces: ['artifact.path', 'artifact.appId'],
        });
      } else {
        return qaFail(bp.failureCode ?? 'NO_BUILD_ARTIFACT', {
          what: `No artifact found under ${root}, and a build is not currently possible`,
          nextSteps: [
            ...(bp.missingToolchain.length ? [`Install: ${bp.missingToolchain.join(', ')}`] : []),
            ...bp.notes,
            `Searched: ${art.searchedLocations.slice(0, 6).join('; ')}`,
            ...(appMapUri ? [`Static app map is still available: qa_app_map_read { projectRoot:"${root}" }`] : []),
          ],
          extra: { sessionId: session.id, buildPlan: bp, searchedLocations: art.searchedLocations, appMapUri, state: 'blocked' as State },
        });
      }
    } else {
      return qaFail('NO_BUILD_ARTIFACT', {
        what: `No artifact found under ${root}`,
        nextSteps: [
          'Build the app with your normal build command, or pass an explicit artifact path.',
          `Searched: ${art.searchedLocations.slice(0, 6).join('; ')}`,
          ...(appMapUri ? [`Static app map is still available: qa_app_map_read { projectRoot:"${root}" }`] : []),
        ],
        extra: { sessionId: session.id, searchedLocations: art.searchedLocations, appMapUri, state: 'blocked' as State },
      });
    }
  }

  // ---- 3. target ----
  // Public v1 is simulator-only. Real-device-only artifacts and explicit real-device requests
  // are blocked instead of silently routing to non-v1 behavior.
  const iosArtifactRealOnly =
    !!art.best &&
    art.best.platform === 'ios' &&
    Array.isArray(art.best.installableOn) &&
    art.best.installableOn.length > 0 &&
    art.best.installableOn.every((t) => t === 'ios-real');
  if (preferRealDevice || iosArtifactRealOnly) {
    return qaFail('BACKEND_UNSUPPORTED', {
      what: 'Swipium 1.0.0 supports Android Emulator and iOS Simulator targets only.',
      nextSteps: [
        'Use an Android emulator build or an iOS Simulator .app for v1.',
        'Real-device workflows are outside the public v1 scope.',
      ],
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
    return qaFail(target.blocked.failureCode, {
      what: target.blocked.detail,
      extra: { sessionId: session.id, targetPlan: target, workaroundsAttempted: session.workarounds, appMapUri, state: 'blocked' as State },
    });
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
    prepArgs.bundleId = needBuild ? '${artifact.appId}' : (art.best?.appId ?? undefined);
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
  steps.push({
    tool: 'qa_smoke',
    why: 'Run a guardrail/smoke pass and capture evidence',
    args: { sessionId: session.id, profile: scan.recommendedProfile },
    status: 'pending',
  });
  steps.push({
    tool: 'qa_report',
    why: 'Summarize what was tested/blocked with evidence',
    args: { sessionId: session.id },
    status: 'pending',
  });
  steps.push({
    tool: 'qa_generate',
    why: 'Optional: turn this run into a durable POM suite',
    args: { sessionId: session.id, target: 'suite' },
    status: 'pending',
  });

  const nextAction = steps.find((s) => s.status === 'pending') ?? null;
  const state: State = 'ready';

  // Choice explanations for the uniform envelope (Dev 2 owns the source data; Dev 1 the shape).
  const artifactChoice = art.best
    ? {
        path: art.best.path,
        why: `${art.best.type.toUpperCase()} selected${art.best.buildType ? ` (${art.best.buildType})` : ''}`,
        alternatives: art.candidates
          .filter((c) => c.path !== art.best!.path)
          .slice(0, 4)
          .map((c) => c.path),
      }
    : needBuild
      ? { why: 'No prebuilt artifact — building from source', alternatives: [] }
      : null;
  const targetChoice = target.selected
    ? { target: `${target.selected}${target.device ? ` (${target.device})` : ''}`, why: target.reason, alternatives: [] }
    : null;

  // ---- EXECUTE / INTERACTIVE modes (P0.1): actually run the path as a job ----
  if (mode === 'execute' || mode === 'interactive') {
    return runExecuteMode(server, sessions, session, {
      mode,
      scan,
      art,
      target,
      isAndroid,
      isIosReal,
      isAab,
      needBuild,
      effectiveApk,
      platform,
      goal: goalFlags.goal,
      goalText,
      releaseGate: goalFlags.releaseGate,
      requiredOutputs: goalFlags.requiredOutputs,
      generateSuite: goalFlags.generateSuite,
      explore: goalFlags.explore,
      stopOnNeedsInput: goalFlags.stopOnNeedsInput,
      artifactChoice,
      targetChoice,
      waitForCompletion: !!waitForCompletion,
      timeoutMs,
      consentId,
      approve,
      optionalQuestion,
      workaroundLog: () => session!.workarounds,
      prelaunchMap,
      appMapUri,
    });
  }

  const summary =
    `🚀 test-this plan for ${root} (framework=${scan.framework}, session ${session.id})\n` +
    `target: ${target.selected}${target.device ? ` (${target.device})` : ''} — ${target.reason}\n` +
    (art.best
      ? `artifact: ${art.best.type.toUpperCase()} ${art.best.path}`
      : `artifact: none — ${needBuild ? 'will build from source' : 'blocked'}`) +
    '\n' +
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
}
