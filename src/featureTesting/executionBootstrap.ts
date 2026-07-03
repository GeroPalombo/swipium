// SWIPIUM-REQ-03 Fix Group 4 — bootstrap a prepared device session for qa_test_feature execute/
// interactive when no prepared session exists. Reuses the SAME resolver/planner/prepare path as
// qa_test_this (resolveArtifact → planTarget → prepareAndroid/prepareIos), with the SAME consent
// gate so the high-level feature tool is never less safe than the lower-level prepare tools. When a
// device/artifact is not available it returns a typed, actionable target-preparation blocker that
// routes to qa_test_this; the complex lanes (build-from-source, .aab convert, real iOS) are routed
// to qa_test_this rather than duplicated here.

import { existsSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { scanProject } from '../context/scan.js';
import { resolveArtifact } from '../artifacts/resolve.js';
import { planTarget, type TargetInputs, type TargetSelection } from '../core/targetPlan.js';
import { adbDevices, listAvds, which, apkPackageId } from '../lib/android.js';
import { simctlAvailable, listSimulators } from '../lib/simctl.js';
import { buildTestThisPreflight } from '../services/preflight.js';
import { prepareAndroid } from '../services/prepareAndroid.js';
import { prepareIos } from '../services/prepareIos.js';
import { DirectDriver } from '../drivers/DirectDriver.js';
import { getDriver } from '../session/attach.js';
import type { Session, SessionStore } from '../session/store.js';
import type { Driver } from '../drivers/Driver.js';

const SEL_TO_PLATFORM: Record<TargetSelection, 'android' | 'ios'> = {
  'android-emulator': 'android',
  'android-real': 'android',
  'ios-simulator': 'ios',
  'ios-real': 'ios',
};

export interface BootstrapArgs {
  server: McpServer;
  sessions: SessionStore;
  projectRoot?: string;
  feature: string;
  platform?: 'android' | 'ios';
  device?: string;
  consentId?: string;
  approve?: boolean;
  signal?: AbortSignal;
}

export type BootstrapResult = { ok: true; session: Session; driver: Driver } | { ok: false; result: CallToolResult };

/** Resolve project → create session → resolve artifact/target → (consent) prepare the device. */
export async function bootstrapFeatureExecution(a: BootstrapArgs): Promise<BootstrapResult> {
  const { resolveProjectRoot } = await import('../context/projectRoot.js');
  const resolved = await resolveProjectRoot(a.server, a.projectRoot);
  if (!resolved.root) {
    return {
      ok: false,
      result: qaError({
        what: 'Could not resolve a project root for feature execution',
        changedState: false,
        retrySafe: true,
        nextSteps: ['Pass projectRoot="/abs/path" or a sessionId from qa_test_this.'],
        clientHint: resolved.hint,
      }),
    };
  }
  const session = a.sessions.create(resolved.root, undefined, {});
  const root = session.root;
  const scan = await scanProject(root);

  const routeToTestThis = (failureCode: string, what: string, extraSteps: string[] = []): BootstrapResult => ({
    ok: false,
    result: qaError(
      {
        what,
        changedState: false,
        retrySafe: true,
        failureCode,
        nextSteps: [
          ...extraSteps,
          `Or run qa_test_this { projectRoot:"${root}", mode:"execute" } to prepare a device with consent, then qa_test_feature { sessionId:"${session.id}", feature:"${a.feature}", mode:"execute" }.`,
        ],
      },
      { sessionId: session.id },
    ),
  });

  // ---- artifact (same resolver as qa_test_this) ----
  const art = await resolveArtifact({ projectRoot: root, platform: a.platform ?? 'any' });
  if (!art.best) {
    return routeToTestThis('NO_BUILD_ARTIFACT', `No installable artifact under ${root} to test "${a.feature}".`, [
      'Build it: qa_build { mode:"plan" } → qa_build { mode:"run" }.',
      `Searched: ${art.searchedLocations.slice(0, 5).join('; ') || '(root only)'}.`,
    ]);
  }
  if (art.best.type === 'aab') {
    return routeToTestThis('AAB_NEEDS_BUNDLETOOL', 'Only a .aab is present — convert it to an installable APK first.', [
      `Convert: qa_bundletool { aab:"${art.best.path}" }.`,
    ]);
  }

  // ---- target (same planner as qa_test_this) ----
  const [adbPresent, simPresent] = await Promise.all([which('adb'), simctlAvailable()]);
  const [online, avds, sims] = await Promise.all([
    adbPresent ? adbDevices() : Promise.resolve<string[]>([]),
    adbPresent ? listAvds() : Promise.resolve<string[]>([]),
    simPresent ? listSimulators() : Promise.resolve([]),
  ]);
  const tInputs: TargetInputs = {
    requestedPlatform: a.platform,
    requestedDevice: a.device,
    artifactPlatform: art.best.platform,
    artifactInstallTargets: art.best.installableOn,
    android: { online, avds },
    ios: {
      bootedSimulators: sims.filter((s) => s.state === 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
      availableSimulators: sims.filter((s) => s.state !== 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
      realDevices: [],
    },
  };
  const target = planTarget(tInputs);
  if (target.blocked) {
    return {
      ok: false,
      result: qaError(
        {
          what: target.blocked.detail,
          changedState: false,
          retrySafe: true,
          failureCode: target.blocked.failureCode,
          nextSteps: [
            'Bring a device online or create one (qa_doctor), then retry.',
            `Or run qa_test_this { projectRoot:"${root}", mode:"execute" }.`,
          ],
        },
        { sessionId: session.id },
      ),
    };
  }
  if (target.selected === 'ios-real') {
    return routeToTestThis('IPA_INSTALL_UNSUPPORTED', 'This artifact installs only on a real iOS device (signing/provisioning required).', [
      'Use qa_prepare_ios_real_target.',
    ]);
  }

  const isAndroid = SEL_TO_PLATFORM[target.selected!] === 'android';
  const effectiveApk = isAndroid ? art.best.path : undefined;
  const iosApp = !isAndroid ? art.best.path : undefined;

  // ---- consent: never less safe than qa_test_this ----
  let externalApk: { path: string; sha256: string } | undefined;
  if (isAndroid && effectiveApk && existsSync(effectiveApk) && !effectiveApk.startsWith(root + sep)) {
    try {
      externalApk = { path: effectiveApk, sha256: createHash('sha256').update(readFileSync(effectiveApk)).digest('hex') };
    } catch {
      /* unreadable — treated as in-root install */
    }
  }
  const preflight = buildTestThisPreflight({
    isAndroid,
    needBuild: false,
    willBoot: target.willBoot,
    bootTarget: target.bootTarget,
    isAab: false,
    apkPath: effectiveApk,
    externalApk,
    iosApp,
    iosAppOutsideRoot: iosApp ? !iosApp.startsWith(root + sep) : undefined,
    iosReal: false,
  });
  let mutationConsent: { required: boolean; consentId?: string; approved: boolean } | undefined;
  if (preflight.consentRequired) {
    const gate = consumeConsent(a.consentId, a.approve, { action: 'test_this_plan', affects: preflight.consentAffects });
    if (!gate.approved) {
      a.sessions.recordMutation(session, {
        tool: 'qa_test_feature',
        action: 'test_this_plan',
        risk: preflight.risk,
        target: preflight.consentAffects,
        consent: { required: true, approved: false },
        status: 'requested',
      });
      return {
        ok: false,
        result: requireConsent({
          action: 'test_this_plan',
          risk: preflight.risk,
          exactCommand: preflight.exactCommand,
          affects: preflight.consentAffects,
          explain: `Preparing a device to test "${a.feature}" needs these privileged steps (approved together):\n${preflight.exactCommand}\nApprove to boot/install/launch, then Swipium runs the focused feature test.`,
        }),
      };
    }
    mutationConsent = { required: true, consentId: a.consentId, approved: true };
    a.sessions.recordMutation(session, {
      tool: 'qa_test_feature',
      action: 'test_this_plan',
      risk: preflight.risk,
      target: preflight.consentAffects,
      consent: mutationConsent,
      status: 'approved',
    });
  }

  // ---- prepare (boot/install/launch) ----
  try {
    if (isAndroid) {
      let appId = art.best.appId ?? scan.appId ?? undefined;
      if (!appId && effectiveApk) appId = (await apkPackageId(effectiveApk)) ?? undefined;
      if (!appId)
        return {
          ok: false,
          result: qaError(
            {
              what: 'Could not determine the app id from the APK.',
              changedState: false,
              retrySafe: false,
              failureCode: 'BUNDLE_ID_NOT_FOUND',
              nextSteps: ['Provide an APK with a readable manifest, or pass an explicit bundleId via qa_test_this.'],
            },
            { sessionId: session.id },
          ),
        };
      const driver = (session.driver as DirectDriver | undefined) ?? new DirectDriver();
      driver.setSignal?.(a.signal);
      const res = await prepareAndroid(
        a.sessions,
        session,
        driver,
        {
          needBoot: target.willBoot,
          bootTarget: target.bootTarget,
          serial: target.device,
          resolvedAppId: appId,
          apk: effectiveApk,
          rnDebug: scan.metroNeed === 'likely',
          allowLaunchWithoutMetro: false,
          mutationConsent,
        },
        { signal: a.signal },
      );
      if (!res.ok)
        return {
          ok: false,
          result: qaError(
            {
              what: `Device preparation failed: ${res.error ?? res.failureCode}`,
              changedState: true,
              retrySafe: true,
              failureCode: res.failureCode ?? 'APP_LAUNCH_FAILED',
              nextSteps: ['Resolve the blocker and retry, or run qa_test_this { mode:"execute" }.'],
            },
            { sessionId: session.id },
          ),
        };
    } else {
      const res = await prepareIos(
        a.sessions,
        session,
        { app: iosApp, bundleId: art.best.appId ?? undefined, simulator: target.device, attachWda: 'auto', mutationConsent },
        {},
      );
      if (!res.ok)
        return {
          ok: false,
          result: qaError(
            {
              what: `iOS preparation failed: ${res.error ?? res.failureCode}`,
              changedState: true,
              retrySafe: true,
              failureCode: res.failureCode ?? 'APP_LAUNCH_FAILED',
              nextSteps: ['Resolve the blocker and retry, or run qa_test_this { mode:"execute" }.'],
            },
            { sessionId: session.id },
          ),
        };
    }
  } catch (e) {
    return {
      ok: false,
      result: qaError(
        {
          what: `Device preparation error: ${String(e)}`,
          changedState: true,
          retrySafe: true,
          nextSteps: ['Retry, or run qa_test_this { mode:"execute" } to prepare a device.'],
        },
        { sessionId: session.id },
      ),
    };
  }

  const { driver } = await getDriver(session);
  if (!driver)
    return {
      ok: false,
      result: qaError(
        {
          what: 'No driver bound after device preparation.',
          changedState: true,
          retrySafe: true,
          failureCode: 'NO_DEVICE',
          nextSteps: ['Run qa_test_this { mode:"execute" } to prepare a device, then qa_test_feature with that sessionId.'],
        },
        { sessionId: session.id },
      ),
    };
  return { ok: true, session, driver };
}
