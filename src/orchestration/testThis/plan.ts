// qa_test_this plan-phase resolution: the cheap, side-effect-free half of the
// orchestration state machine. Resolves the session/project, finds (or plans a build for) an
// artifact, picks a target, and returns an ordered plan with the EXACT next tool call to make,
// or a typed blocker / one concise NeedsInput question. Execute/interactive modes are dispatched
// to runExecuteMode (./execute.js).

import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { qaOk, unknownSessionError } from '../../lib/result.js';
import { qaFail } from '../../oracle/failures.js';
import { qaNeedsInput, NeedsInput } from '../../lib/needsInput.js';
import { prebuiltArtifactsNearRoot, scanProject } from '../../context/scan.js';
import { findMobileApps, classifyDiscovery } from '../../context/findApps.js';
import { resolveGoalFlags, type TestGoal } from '../goal.js';
import { resolveArtifact, type ArtifactPlatform } from '../../artifacts/resolve.js';
import { buildPlan, type BuildPlatform } from '../../build/plan.js';
import { adbDevices, listAvds, which } from '../../lib/android.js';
import { simctlAvailable, listSimulators } from '../../lib/simctl.js';
import { checkWda } from '../../lib/wda.js';
import { resolveSimulatorWda } from '../../lib/wdaDevice.js';
import { loadWdaConfig } from '../../lib/wdaConfig.js';
import { planTarget, type TargetInputs } from '../../core/targetPlan.js';
import {
  DEVICE_PIN_ENV,
  devicePinConflict,
  isSimulatorUdid,
  onlineSerialForAvd,
  operatorDevicePin,
  pinAmbiguousMessage,
  pinFixStep,
  pinnedTarget,
  sessionAvdFor,
  verifiedEmulatorSerials,
} from '../../session/attach.js';
import { universalApkCachePath } from '../../artifacts/bundletool.js';
import { ensurePrelaunchAppMap } from '../../appMap/prelaunch.js';
import { appMapPath } from '../../appMap/store.js';
import { existsSync } from 'node:fs';
import type { AppKnowledgeMap } from '../../appMap/schema.js';
import { log } from '../../lib/logger.js';
import type { Session, SessionStore } from '../../session/store.js';
import { type State, type PlanStep, type TestThisInput, selToPlatform } from './types.js';
import { runExecuteMode } from './execute.js';
import { envCredentialsAvailable, hasUsableCredentials, rememberTestThisIntent } from './sessionIntent.js';

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
    responseMode,
  } = input;
  // Goal routing: the goal sets orchestration FLAGS only; explicit booleans win.
  // Default policy = "leave behind automation when possible" (fastSmoke opts out).
  const goalFlags = resolveGoalFlags(goal as TestGoal | undefined, { explore, generateSuite, stopOnNeedsInput }, { fastSmoke });
  // ---- resolve / create session ----
  let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;
  if (sessionId && !session) {
    return unknownSessionError(sessionId, ['Omit sessionId to create one, or pass a valid session.']);
  }
  if (!session) {
    const { resolveProjectRoot, unresolvedProjectRootError } = await import('../../context/projectRoot.js');
    const resolved = await resolveProjectRoot(server, projectRoot);
    if (!resolved.root) return unresolvedProjectRootError(resolved);
    session = sessions.create(resolved.root, undefined, responseMode ? { responseMode } : {});
    // An explicit projectRoot IS the user's target choice. Never re-ask the monorepo question for it.
    if (projectRoot) session.chosenTarget = resolved.root;
  } else if (responseMode && session.responseMode !== responseMode) {
    session.responseMode = responseMode;
    sessions.persist(session);
  }
  // Remember the user's intent (goal/goalText/flags) so a blocker resume replays it.
  rememberTestThisIntent(sessions, session, input);
  // The EXACT re-invocation for plan steps that route back through qa_test_this: execute mode plus
  // the caller's original goal/flags. A bare {sessionId} would just re-plan forever.
  const reinvokeArgs: Record<string, unknown> = { sessionId: session.id, mode: 'execute' };
  for (const [k, v] of Object.entries({
    goal,
    goalText,
    fastSmoke,
    platform,
    device,
    explore,
    generateSuite,
    stopOnNeedsInput,
    buildIfNeeded,
    allowOutsideRoot,
  }))
    if (v !== undefined) reinvokeArgs[k] = v;
  let root = session.root;
  const wa = (note: string) => sessions.addWorkaround(session!, note);

  // ---- 1. project scan ----
  // Install probe only on this session's device (or the requested / pinned one), never a bystander.
  const probeDevice = device ?? session.device ?? operatorDevicePin();
  let scan = await scanProject(root, { device: probeDevice });
  // What Swipium has actually tried before any pre-execute question/blocker:
  // concrete steps, not just the workaround log. Grows as resolution proceeds.
  const preAttempted: string[] = [`scanned project root (framework=${scan.framework})`];
  /** Set for a prebuilt-only root: the near-root artifacts the plan may install. */
  let prebuiltPaths: string[] = [];

  // ---- 1b. low-context app discovery: the root may be a monorepo or a parent
  //      directory rather than the app itself. Discover candidates and either adopt the one
  //      strong candidate (recording a workaround) or ask ONE disambiguation question. ----
  if (scan.framework === 'unknown') {
    const disc = findMobileApps(root);
    preAttempted.push(
      `ran low-context app discovery (searched ${disc.searchedLocations.length} location(s), found ${disc.candidates.length} candidate(s))`,
    );
    const cls = classifyDiscovery(disc);
    if (cls.decision === 'adopt' && cls.chosen) {
      wa(`root is not itself a mobile app; discovered one candidate (${cls.chosen.framework}) at ${cls.chosen.rel}; proceeding with it`);
      root = cls.chosen.path;
      session.root = root; // adopt the app subdir as the effective project root
      sessions.persist(session);
      scan = await scanProject(root, { device: probeDevice });
    } else if (cls.decision === 'disambiguate') {
      return qaNeedsInput(NeedsInput.monorepoTarget(cls.choices.map((c) => c.path)), {
        sessionId: session.id,
        state: 'needs_input' as State,
        attempted: [...preAttempted, `identified ${cls.choices.length} plausible app targets, cannot pick safely`],
        candidates: cls.choices
          .slice(0, 6)
          .map((c) => ({ path: c.path, rel: c.rel, framework: c.framework, score: c.score, reasons: c.reasons })),
      });
    } else if (scan.appId && (prebuiltPaths = prebuiltArtifactsNearRoot(root, [...scan.appBundles, ...scan.apks])).length > 0) {
      // No source project, but a prebuilt simulator .app / .apk whose app id resolves:
      // test that build as-is (the artifact step below picks it up; nothing can be rebuilt).
      preAttempted.push(`no source project; found prebuilt artifact(s) for ${scan.appId}`);
      wa(`no source project at the root; testing the prebuilt artifact for ${scan.appId} as-is (cannot rebuild)`);
    } else {
      const empty = scan.readiness === 'blocked' && scan.missing.some((m) => /empty/i.test(m));
      return qaFail(empty ? 'PROJECT_ROOT_EMPTY' : 'NOT_MOBILE_PROJECT', {
        what: `No supported mobile project at ${root}`,
        nextSteps: [
          `Searched: ${disc.searchedLocations.slice(0, 8).join('; ') || '(root only)'}`,
          'Pass projectRoot="/abs/path/to/app" pointing at the app directory.',
          'To test a prebuilt build without source, put the simulator .app or the .apk in that directory (Swipium reads its app id from Info.plist / the APK), or install it directly (qa_prepare_target apk= on Android, qa_ios install on iOS).',
        ],
        extra: { sessionId: session.id, scan, searchedLocations: disc.searchedLocations, state: 'blocked' as State },
      });
    }
  } else if (scan.monorepo && session.chosenTarget === root) {
    // The user already chose this root (monorepo_target resume / explicit projectRoot): asking again
    // would loop forever when the chosen app IS the monorepo root.
    preAttempted.push('monorepo detected, using the explicitly chosen target');
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
    wa('monorepo detected, proceeding with the resolved root; pass projectRoot/target to disambiguate if the wrong app is chosen');
  }

  // ---- 1c. pre-launch app map (Vision Gap Fix 1): load or build the durable STATIC app map
  //      BEFORE prepare/smoke so first-run decisions, exploration seeding, automation readiness,
  //      and the report are informed by the map at the time they are made, and so the map still
  //      exists when no device/artifact is available (every blocker below carries appMapUri). ----
  let prelaunchMap: AppKnowledgeMap | undefined;
  let appMapUri: string | undefined;
  try {
    const at = new Date().toISOString();
    // mode:"plan" is a side-effect-free preview, so the map is built in memory only (no
    // .swipium/app-map*, history snapshot, .gitignore edit or projects.json entry).
    const planOnly = mode !== 'execute' && mode !== 'interactive';
    const pre = ensurePrelaunchAppMap(root, {
      at,
      persist: !planOnly,
      appIdentityHints: {
        androidPackage:
          scan.framework === 'native-android' || scan.framework === 'expo' || scan.framework === 'bare-react-native' ? scan.appId : null,
        iosBundleId: scan.framework === 'native-ios' ? scan.appId : null,
      },
    });
    prelaunchMap = pre.map;
    // A plan-only pass on a project with no saved map has no resource to point at yet.
    appMapUri = planOnly && !existsSync(appMapPath(root)) ? undefined : pre.appMapUri;
    preAttempted.push(
      `${pre.rescanned ? 'built' : 'loaded'} static app map (${pre.reason}; ${pre.map.staticTopology.screens.length} static screen(s)) > ${pre.appMapUri}`,
    );
    if (pre.rescanned)
      wa(
        `built static app map before launch (${pre.map.staticTopology.screens.length} screen(s)); durable map drives first-run/exploration/report`,
      );
  } catch (e) {
    log('warn', 'test_this pre-launch app map failed', { err: String(e) });
  }

  const buildPref = buildIfNeeded !== false;
  const steps: PlanStep[] = [];

  // ---- 2. artifact ----
  const art = await resolveArtifact({
    projectRoot: root,
    platform: platform ?? 'any',
    allowOutsideRoot,
    ...(prebuiltPaths.length ? { onlyPaths: prebuiltPaths } : {}),
  });
  let artifactPlatform: ArtifactPlatform | undefined = art.best?.platform;
  let needBuild = false;

  if (art.failureCode === 'ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL') {
    const outside = art.candidates.find((c) => c.outsideRoot);
    return qaNeedsInput(NeedsInput.artifactOutsideRoot(outside?.path ?? '(outside root)'), {
      sessionId: session.id,
      state: 'needs_input' as State,
      attempted: [...preAttempted, 'resolved candidate artifacts, but the best one is outside the project root'],
      candidates: art.candidates.slice(0, 3),
    });
  }
  const isAab = art.best?.type === 'aab';
  if (art.best) {
    steps.push({ tool: '(resolved)', why: `Using ${art.best.type.toUpperCase()} ${art.best.path}`, status: 'satisfied' });
    if (isAab) {
      // Honest (P0.2): an .aab is not installable; it must be converted first.
      wa('only a .aab is present; qa_test_this will convert it to an installable universal APK with bundletool');
      steps.push({
        tool: 'qa_test_this',
        why: 'Convert the .aab to an installable universal APK before install (execute mode runs the conversion)',
        args: { ...reinvokeArgs },
        status: 'pending',
      });
    }
  } else {
    // No artifact. Build from source if possible (effective before exhaustive).
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
          args: { ...reinvokeArgs },
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
    return qaFail('PHYSICAL_DEVICE_UNSUPPORTED', {
      what: 'Swipium supports Android Emulator and iOS Simulator targets only (see docs/physical-devices.md).',
      nextSteps: [
        'Use an Android emulator build or an iOS Simulator .app.',
        'Real-device workflows are out of scope until their threat model lands.',
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
  // H6: pattern OR property-verified emulators (localhost:5555, Genymotion), same as getDriver.
  // ALL online serials go to the planner (it refuses physical ones with PHYSICAL_DEVICE_UNSUPPORTED
  // when nothing else is viable). Pre-filtering to emulators hid that and reported NO_DEVICE.
  const emulators = await verifiedEmulatorSerials(onlineAll);
  // Device choice: explicit `device` > the device this session is already bound to (a session is
  // only re-bound to its own device; an offline emulator is re-booted as its own AVD, never replaced
  // by another one) > the operator pin (SWIPIUM_DEVICE). Nothing else is ever substituted.
  const pinConflict = await devicePinConflict(device, onlineAll, sims);
  if (pinConflict)
    return qaFail('DEVICE_PINNED', {
      what: pinConflict,
      nextSteps: [
        `Re-run without device (the pinned device is used): qa_test_this ${JSON.stringify({ ...reinvokeArgs, device: undefined })}`,
      ],
      extra: { sessionId: session.id, appMapUri, state: 'blocked' as State },
    });
  let requestedDevice = device;
  let sessionBound: string | undefined;
  if (!requestedDevice && session.device) {
    const boundIos = isSimulatorUdid(session.device);
    const wanted = platform ?? artifactPlatform;
    if (!wanted || wanted === (boundIos ? 'ios' : 'android')) {
      sessionBound = session.device;
      requestedDevice =
        boundIos || onlineAll.includes(session.device) ? session.device : (sessionAvdFor(session, session.device) ?? session.device);
    }
  }
  const pinUsed = requestedDevice ? undefined : operatorDevicePin();
  if (pinUsed) {
    // The pin resolves the way qa_prepare_ios_target resolves it (pinMatches: exact,
    // ignoring case), and a simulator name several simulators share is refused as ambiguous.
    const pinned = pinnedTarget(pinUsed, onlineAll, avds, sims);
    if (pinned.ambiguous)
      return qaFail('MULTIPLE_DEVICES', {
        what: pinAmbiguousMessage(pinUsed, pinned.ambiguous),
        nextSteps: [pinFixStep()],
        extra: { sessionId: session.id, appMapUri, state: 'blocked' as State },
      });
    requestedDevice = pinned.device ?? pinUsed;
  }
  // A requested AVD that is already running is bound as its serial, not booted a second time.
  if (requestedDevice && !onlineAll.includes(requestedDevice) && avds.includes(requestedDevice))
    requestedDevice = (await onlineSerialForAvd(requestedDevice, onlineAll)) ?? requestedDevice;
  if (requestedDevice && onlineAll.includes(requestedDevice) && !emulators.includes(requestedDevice)) {
    return qaFail('PHYSICAL_DEVICE_UNSUPPORTED', {
      what: `Android target "${requestedDevice}" appears to be a physical device. Swipium supports the Android Emulator only.`,
      nextSteps: ['Start or create an Android Emulator, then retry without a real-device serial.'],
      extra: { sessionId: session.id, appMapUri, state: 'blocked' as State },
    });
  }
  const tInputs: TargetInputs = {
    requestedPlatform: platform,
    requestedDevice,
    preferRealDevice: false,
    artifactPlatform,
    artifactInstallTargets: art.best?.installableOn,
    android: { online: onlineAll, avds, emulators },
    ios: {
      bootedSimulators: sims.filter((s) => s.state === 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
      availableSimulators: sims.filter((s) => s.state !== 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
      realDevices: [],
    },
  };
  const target = planTarget(tInputs);
  if (target.blocked && sessionBound && target.blocked.failureCode === 'NO_DEVICE') {
    return qaFail('NO_DEVICE', {
      what: `This session's device ${sessionBound} is not available${isSimulatorUdid(sessionBound) ? '' : ' (offline, and the AVD it ran is unknown)'}; it is NOT replaced by another device.`,
      nextSteps: [
        `Pick the target explicitly: qa_test_this ${JSON.stringify({ ...reinvokeArgs, device: '<serial | AVD name | simulator UDID>' })}, or start a new session.`,
      ],
      extra: { sessionId: session.id, targetPlan: target, appMapUri, state: 'blocked' as State },
    });
  }
  // Say WHY this device: the session's own device / the operator pin, not a caller request.
  if (!device && requestedDevice && !target.blocked)
    target.reason = target.reason.replace(
      /^Honoring requested (device|simulator)/,
      sessionBound ? "Honoring this session's bound $1" : `Honoring operator pin ${DEVICE_PIN_ENV}: $1`,
    );
  // An explicit platform the pin overrides is said out loud, never silently dropped.
  if (!device && !sessionBound && platform && requestedDevice && !target.blocked && target.selected) {
    const pinned = selToPlatform[target.selected];
    if (pinned !== platform) {
      const note = `platform:"${platform}" was overridden: ${DEVICE_PIN_ENV}=${pinUsed ?? requestedDevice} pins this server to a ${pinned} device`;
      wa(note);
      target.reason = `${target.reason} (${note})`;
    }
  }
  if (target.blocked) {
    const androidWanted = platform === 'android' || artifactPlatform === 'android' || /android/i.test(target.blocked.detail);
    const blockedExtra = {
      sessionId: session.id,
      targetPlan: target,
      workaroundsAttempted: session.workarounds,
      appMapUri,
      state: 'blocked' as State,
    };
    const avdSteps = [
      'Create an Android Virtual Device: Android Studio > Device Manager > Create device, or ' +
        '`avdmanager create avd -n Pixel_7 -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_7` (install the image with sdkmanager first).',
      `Then re-run qa_test_this ${JSON.stringify(reinvokeArgs)}. Swipium boots the AVD itself (one consent).`,
    ];
    if (target.blocked.failureCode === 'NO_DEVICE' && androidWanted && !adbPresent) {
      return qaFail('ADB_NOT_FOUND', {
        what: 'adb (Android platform-tools) is not on PATH, so Swipium cannot see or boot any Android emulator.',
        nextSteps: [
          'Install Android platform-tools (Android Studio > SDK Manager, or `sdkmanager "platform-tools" "emulator"`) and put $ANDROID_HOME/platform-tools and $ANDROID_HOME/emulator on PATH (or set ANDROID_HOME).',
          ...avdSteps,
          ...(simPresent ? ['Or test on iOS: qa_test_this {"mode":"execute","platform":"ios"}.'] : []),
        ],
        extra: blockedExtra,
      });
    }
    const pin = operatorDevicePin();
    if (target.blocked.failureCode === 'NO_DEVICE' && !device && !sessionBound && pin)
      return qaFail('NO_DEVICE', {
        what: `${DEVICE_PIN_ENV}=${pin} (server env) matches no online device, simulator or AVD, so nothing else was picked.`,
        nextSteps: [
          `Fix or unset ${DEVICE_PIN_ENV} in the MCP server's env (an adb serial, AVD name, or simulator UDID / exact name), then restart the server.`,
        ],
        extra: blockedExtra,
      });
    return qaFail(target.blocked.failureCode, {
      ...(target.blocked.failureCode === 'NO_DEVICE' && androidWanted
        ? { what: 'No Android emulator is online and no AVD exists to boot.', nextSteps: avdSteps }
        : target.blocked.failureCode === 'PHYSICAL_DEVICE_UNSUPPORTED'
          ? {
              what: target.blocked.detail,
              nextSteps: ['Physical devices are out of scope (docs/physical-devices.md). Use an emulator instead.', ...avdSteps],
            }
          : { what: target.blocked.detail }),
      extra: blockedExtra,
    });
  }
  if (target.willBoot)
    wa(
      requestedDevice
        ? `${target.bootTarget} is not running, will boot it`
        : `no online ${selToPlatform[target.selected!]} target, will boot ${target.bootTarget}`,
    );

  const isAndroid = selToPlatform[target.selected!] === 'android';
  const isIosReal = false;
  // Effective flags: iOS without WebDriverAgent can still launch + smoke visually, so the DEFAULT
  // suite generation / goal-implied exploration degrade (recorded as a workaround) instead of
  // blocking. Only work the caller explicitly asked for that truly needs WDA blocks.
  let effExplore = goalFlags.explore;
  let effGenerateSuite = goalFlags.generateSuite;
  let effRequiredOutputs = goalFlags.requiredOutputs;
  const structuredNeeds: string[] = [];
  if (!isAndroid && !isIosReal) {
    if (effGenerateSuite) structuredNeeds.push('suite generation');
    if (effExplore) structuredNeeds.push('guided exploration');
    if (goalFlags.goal === 'test_login') structuredNeeds.push('driving the login form');
  }
  if (structuredNeeds.length) {
    const wdaConfig = loadWdaConfig(root);
    // A WDA that answers may be ANOTHER simulator's (all default to the same port). A WDA
    // proven to drive a different simulator than the target (or one whose owner could not be
    // inspected) is not ready for this run.
    const targetUdid = [target.device, target.bootTarget].find(
      (d): d is string => typeof d === 'string' && /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(d),
    );
    // Resolve the WDA the way qa_prepare_ios_target does (this session's own WDA for
    // the simulator, else ios.wda.url, then the simulator's own per-UDID managed port): a managed
    // WDA runs on its own port, not on the configured / default 8100.
    const ownWdaUrl = targetUdid
      ? [...(session.mutations ?? [])]
          .reverse()
          .find(
            (r) =>
              (r.tool === 'qa_wda' || r.tool === 'qa_prepare_ios_target') &&
              ['wda_start', 'wda_reuse', 'wda_attach'].includes(r.action) &&
              r.status === 'executed' &&
              typeof r.target?.webDriverAgentUrl === 'string' &&
              String(r.target?.udid ?? '').toUpperCase() === targetUdid.toUpperCase(),
          )?.target?.webDriverAgentUrl
      : undefined;
    const resolvedWda = targetUdid
      ? await resolveSimulatorWda(typeof ownWdaUrl === 'string' ? ownWdaUrl : wdaConfig.url, targetUdid)
      : { url: wdaConfig.url, status: await checkWda(wdaConfig.url, 1500), owner: undefined };
    const wdaUrl = resolvedWda.url;
    const wda = resolvedWda.status;
    const wdaOwner = resolvedWda.owner;
    // One rule with prepare / attach: `unverified` is usable only as this session's own
    // recorded WDA for the simulator.
    const sameUrl = (x: unknown, y: string) => typeof x === 'string' && x.replace(/\/+$/, '') === y.replace(/\/+$/, '');
    const wdaForeign = wdaOwner?.owner === 'other' || (wdaOwner?.owner === 'unverified' && !sameUrl(ownWdaUrl, wdaUrl));
    // This simulator's own WDA listens but did not answer /status (hung).
    const hungOwnWda = (resolvedWda as { ownUnresponsive?: string }).ownUnresponsive;
    if (!wda.reachable || !wda.ready || wdaForeign) {
      // Hard requirement = something the caller explicitly asked for (flag or a WDA-only goal).
      const hard: string[] = [];
      if (generateSuite === true || goalFlags.goal === 'create_automation_suite') hard.push('suite generation');
      if (explore === true || goalFlags.goal === 'explore' || goalFlags.goal === 'reproduce_bug') hard.push('guided exploration');
      if (goalFlags.goal === 'test_login') hard.push('driving the login form');
      if (hard.length) {
        const visualSmoke = { ...reinvokeArgs, platform: 'ios', goal: 'smoke' } as Record<string, unknown>;
        delete visualSmoke.explore;
        delete visualSmoke.generateSuite;
        delete visualSmoke.goalText;
        return qaFail('WDA_UNREACHABLE', {
          what:
            `iOS ${hard.join(' + ')} (requested via ${goal ? `goal "${goalFlags.goal}"` : 'explicit flags'}) needs the structured ` +
            (hungOwnWda
              ? `WebDriverAgent backend, and this simulator's own WDA at ${hungOwnWda} is listening but did not answer /status within 1.5 s (hung)${sameUrl(hungOwnWda, wdaUrl) ? '' : `; the WDA at ${wdaUrl} is not usable for it${wdaForeign ? ` (${wdaOwner!.reason})` : ''}`}.`
              : `WebDriverAgent backend, and WDA is not ready at ${wdaUrl}${wdaForeign ? ` (${wdaOwner!.reason})` : ''}.`) +
            ' A visual-only smoke (launch + screenshots + health) does not need WDA.',
          nextSteps: [
            ...(hungOwnWda
              ? [
                  `Restart the hung WDA: qa_wda { action:"stop"${targetUdid ? `, device:"${targetUdid}"` : ''} }, then qa_wda { action:"setup" } and qa_wda { action:"attach" } with the same device, then re-run the same qa_test_this call.`,
                ]
              : []),
            `Visual-only alternative now: qa_test_this ${JSON.stringify(visualSmoke)}`,
            // The blocked plan never bound the simulator to the session: name it, or setup / attach
            // fail with NO_DEVICE / MULTIPLE_DEVICES.
            `Or set up WDA in one step: qa_wda { action:"setup"${targetUdid ? `, device:"${targetUdid}"` : ''} } (builds if needed and starts it on this simulator's own port; poll qa_job_status), then qa_wda { action:"attach"${targetUdid ? `, device:"${targetUdid}"` : ''} }, then re-run the same qa_test_this call.`,
            ...(appMapUri ? [`Static app map is still available: qa_app_map_read { projectRoot:"${root}" }`] : []),
          ],
          extra: {
            sessionId: session.id,
            state: 'blocked' as State,
            goal: goalFlags.goal,
            requiresWdaFor: hard,
            target,
            wda: {
              config: { url: wdaConfig.url, mode: wdaConfig.mode, derivedDataPath: wdaConfig.derivedDataPath },
              url: wdaUrl,
              status: wda,
              ...(wdaOwner ? { ownership: wdaOwner } : {}),
            },
            appMapUri,
          },
        });
      }
      effExplore = false;
      effGenerateSuite = false;
      effRequiredOutputs = effRequiredOutputs.filter((o) => o !== 'suite' && o !== 'exploration');
      wa(
        `WebDriverAgent not ready at ${wdaUrl}${wdaForeign ? ` (not usable for this simulator: ${wdaOwner!.reason})` : ''}${hungOwnWda && !sameUrl(hungOwnWda, wdaUrl) ? ` and this simulator's own WDA at ${hungOwnWda} did not answer /status (hung: qa_wda stop, then setup)` : ''}, skipping ${structuredNeeds.join(' + ')}; running the iOS smoke only (set up WDA via qa_wda${targetUdid ? ` { action:"setup", device:"${targetUdid}" }` : ''} to enable them)`,
      );
      preAttempted.push(
        `checked WebDriverAgent at ${wdaUrl}: ${wdaForeign ? 'not usable for this simulator' : 'not ready'}; skipped ${structuredNeeds.join(' + ')}`,
      );
    }
  }

  // ---- 4. auth (be effective: proceed pre-login; surface the question as optional) ----
  let optionalQuestion: ReturnType<typeof NeedsInput.credentials> | undefined;
  if (scan.likelyAuth && (envCredentialsAvailable() || hasUsableCredentials(session))) {
    // Env (or already provided) credentials answer the login question: execute seeds and uses them
    // without asking (seedEnvCredentials), so the plan must not say it will stop and ask.
    wa(
      'app likely has a login: test credentials are available (SWIPIUM_TEST_EMAIL / SWIPIUM_TEST_PASSWORD or provided inputs); ' +
        'no login question',
    );
  } else if (scan.likelyAuth) {
    wa('app likely has a login: will test pre-login coverage; authenticated flows are blocked until credentials are provided');
    optionalQuestion = NeedsInput.credentials('Authenticated workflows need a test account.');
  }

  // ---- 5. assemble the ordered plan ----
  // Effective installable artifact path: a converted universal APK for an .aab, else the artifact.
  const effectiveApk = art.best ? (isAab ? universalApkCachePath(root, art.best.path) : art.best.path) : undefined;
  // When a build is pending, the artifact does not exist yet, so use SYMBOLIC refs
  // (${artifact.path}/${artifact.appId}) and mark the dependency, never `undefined` args.
  const prepArgs: Record<string, unknown> = { sessionId: session.id };
  if (isAndroid) {
    prepArgs.apk = needBuild ? '${artifact.path}' : effectiveApk;
    if (target.device) prepArgs.device = target.device;
    if (target.willBoot && target.bootTarget) prepArgs.avd = target.bootTarget;
  } else {
    prepArgs.app = needBuild ? '${artifact.path}' : art.best?.path;
    prepArgs.bundleId = needBuild ? '${artifact.appId}' : (art.best?.appId ?? undefined);
    // The device the plan targets, or the one it boots (never left empty: prepare would then pick any
    // booted simulator). `device` is qa_prepare_ios_target's public name.
    const sim = target.device ?? target.bootTarget;
    if (sim) prepArgs.device = sim;
    prepArgs.attachWda = 'auto';
  }

  // A debug RN/Expo build needs Metro on iOS too (the plan must list the Metro precondition).
  if (scan.metroNeed === 'likely') wa('debug RN/Expo build likely needs Metro/dev server serving before launch');
  steps.push({
    tool: isAndroid ? 'qa_prepare_target' : 'qa_prepare_ios_target',
    why: `Install + launch on ${target.selected}`,
    args: prepArgs,
    status: 'pending',
    ...(needBuild ? { requires: ['artifact.path', 'artifact.appId'] } : {}),
  });
  steps.push({
    tool: 'qa_smoke',
    why: `Run a guardrail/smoke pass and capture evidence (profile: ${scan.recommendedProfile})`,
    // Only qa_smoke's own parameters: the printed call must work as-is.
    args: { sessionId: session.id },
    status: 'pending',
  });
  // The remaining steps follow the goal's effective flags (the same ones execute runs).
  if (effExplore) {
    steps.push({
      tool: 'qa_explore',
      why: goalText ? `Guided exploration focused on: ${goalText.slice(0, 120)}` : 'Guided exploration of reachable screens',
      args: { sessionId: session.id, ...(goalText ? { goal: goalText } : {}) },
      status: 'pending',
    });
  }
  steps.push({
    tool: 'qa_report',
    why: goalFlags.releaseGate
      ? 'Summarize with the release-gate verdict (ship / caution / block) and readiness'
      : 'Summarize what was tested/blocked with evidence',
    args: { sessionId: session.id },
    status: 'pending',
  });
  if (effGenerateSuite) {
    steps.push({
      tool: 'qa_generate',
      why: 'Turn this run into a durable POM suite',
      args: { sessionId: session.id, target: 'suite' },
      status: 'pending',
    });
  }

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
      ? { why: 'No prebuilt artifact, building from source', alternatives: [] }
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
      requiredOutputs: effRequiredOutputs,
      generateSuite: effGenerateSuite,
      explore: effExplore,
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
    `target: ${target.selected}${target.device ? ` (${target.device})` : ''}: ${target.reason}\n` +
    (art.best
      ? `artifact: ${art.best.type.toUpperCase()} ${art.best.path}`
      : `artifact: none (${needBuild ? 'will build from source' : 'blocked'})`) +
    '\n' +
    `plan:\n${steps.map((s, i) => `  ${i + 1}. [${s.status === 'satisfied' ? '✓' : ' '}] ${s.tool}: ${s.why}`).join('\n')}\n` +
    (nextAction ? `next: call ${nextAction.tool} ${JSON.stringify(nextAction.args ?? {})}\n` : '') +
    (session.workarounds.length ? `workarounds: ${session.workarounds.length} (see workaroundsAttempted)\n` : '') +
    (optionalQuestion ? `${goalFlags.stopOnNeedsInput ? 'execute will stop and ask first' : 'note'}: ${optionalQuestion.question}` : '');

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
