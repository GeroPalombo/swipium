// qa_prepare_target: get the app running on a device.
//
// Fast path (device online + app installed + !force): run synchronously, return the result.
// Long-op path (needs emulator boot or an install): create a JOB, run async, return a
// `jobId` immediately (poll with qa_job_status), so client tool-call timeouts don't hit
// the slow paths (review #2). Interactive consent (boot, external-APK) is resolved
// synchronously BEFORE the job is kicked off.

import { z } from 'zod';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { qaOk, qaError, invalidArgumentError, isInvalidArgumentError, unknownSessionError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { listAvds, resolveApk, apkPackageId, adbDevices, emulatorBootArgs } from '../lib/android.js';
import { resolveArtifact } from '../artifacts/resolve.js';
import { run } from '../lib/spawn.js';
import { DirectDriver, assertAndroidAppId } from '../drivers/DirectDriver.js';
import { detectFramework } from '../context/detect.js';
import { METRO_PORT, isProjectAndroidApp, metroReadiness, reverseSet, wrongProjectMetroMessage } from '../lib/metroState.js';
import {
  resolveDevice,
  bindDevice,
  verifiedEmulatorSerials,
  onlineSerialForAvd,
  sessionAvdFor,
  devicePinConflict,
  rememberBoundAvd,
  DEVICE_PIN_ENV,
  operatorDevicePin,
  pinFixStep,
  pinMatches,
} from '../session/attach.js';
import { launchFailureCode, prepareAndroid } from '../services/prepareAndroid.js';
import { planTarget } from '../core/targetPlan.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';
import { isAbortError, runWithSignal } from '../lib/abortScope.js';
import { waitForLaunch } from '../lib/launchWait.js';
import { noteScreenMutation } from '../snapshot/fresh.js';
import { isMetroRequiredFinding } from '../oracle/health.js';
import { qaFail } from '../oracle/failures.js';
import { checkLaunchErrorSurface, launchErrorText } from '../oracle/record.js';

/** RN/Expo debug builds load JS from Metro; launching before Metro is SERVING > RedBox. */
function needsMetro(root: string, appId?: string, apk?: string): boolean {
  const fw = detectFramework(root);
  if (fw !== 'expo' && fw !== 'bare-react-native') return false;
  // AND-15: the gate is for THIS project's debug build. An explicit appId with no APK that is not
  // the project's package (e.g. a system app) never loads this project's bundle: no gate, no reverse.
  if (appId && !apk) return isProjectAndroidApp(root, appId);
  return true;
}

export function registerPrepareTarget(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_prepare_target',
    {
      title: 'Prepare a target device + app',
      description:
        'Prepare an Android Emulator and the app under test: bind or boot the device, Metro + adb reverse for RN/Expo, install, ' +
        'launch, verify. One combined consent covers boot/install; long steps return a jobId. bindOnly stops after bind/boot.',
      inputSchema: {
        sessionId: z.string(),
        apk: z.string().optional(),
        appId: z.string().optional(),
        avd: z.string().optional(),
        device: z.string().optional().describe('Target serial; required when >1 device is online.'),
        force: z.boolean().optional(),
        headless: z.boolean().optional().describe('Boot the AVD headless (default true).'),
        bindOnly: z.boolean().optional().describe('Bind/boot + adb reverse only.'),
        allowLaunchWithoutMetro: z.boolean().optional().describe('Launch a debug RN/Expo build without Metro (may RedBox).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, apk, appId, avd, device, force, headless, bindOnly, allowLaunchWithoutMetro, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return unknownSessionError(sessionId);
      }

      // The operator pin first: naming another device is refused before any artifact lookup.
      const pinConflict = await devicePinConflict(device ?? avd, await adbDevices());
      if (pinConflict)
        return qaError({
          what: pinConflict,
          changedState: false,
          retrySafe: false,
          failureCode: 'DEVICE_PINNED',
          nextSteps: ['Re-call without device/avd: the pinned device is used.'],
        });

      // ---- appId (+apk if needed for detection); not needed for bindOnly ----
      let resolvedAppId = appId;
      let apkPath: string | undefined = apk;
      if (!bindOnly && !resolvedAppId) {
        const r = await findProjectApk(session.root, apk);
        if (!r.apk)
          return qaError({
            what: r.error ?? 'No APK to detect appId',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_ARTIFACT',
            nextSteps: [
              'Pass appId= or apk=, or drop a build under apps/android/, or use bindOnly:true to just bind a device.',
              'qa_prepare_target is the Android path; for an iOS app use qa_prepare_ios_target.',
            ],
          });
        apkPath = r.apk;
        resolvedAppId = (await apkPackageId(apkPath)) ?? undefined;
        if (!resolvedAppId)
          return qaError({
            what: 'Could not determine applicationId from the APK',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_ARTIFACT',
            nextSteps: ['Pass appId explicitly.'],
          });
      }
      // Single entry-point validation: a malformed app id (explicit or APK-derived) is a typed
      // caller error here, not a raw driver throw later (app ids reach `adb shell`).
      if (resolvedAppId !== undefined) {
        try {
          assertAndroidAppId(resolvedAppId);
        } catch (e) {
          if (isInvalidArgumentError(e))
            return invalidArgumentError(e, ['Pass a valid Android application id, e.g. appId="com.example.app".']);
          throw e;
        }
      }
      const rnDebug = needsMetro(session.root, appId, apk);
      // An explicit appId without apk: only an APK whose package IS that appId may be installed for it
      // (never offer to install the project's unrelated APK under another app's name).
      if (!bindOnly && appId && !apkPath) {
        const cand = await findProjectApk(session.root);
        if (cand.apk && (await apkPackageId(cand.apk).catch(() => null)) === appId) apkPath = cand.apk;
      }

      // ---- device resolution (centralized; binds single online, asks on >1) ----
      // An explicit `avd` means "use/boot THIS AVD": bind its running instance, else boot it. It never
      // falls back to an unrelated online device (or the session's other device).
      const avdRequested = !!avd && !device;
      const avdSerial = avdRequested ? await onlineSerialForAvd(avd!, await adbDevices()) : undefined;
      const resolved = await resolveDevice(session, device ?? avdSerial);
      const res = avdRequested && !avdSerial ? { ...resolved, effective: undefined, needSelection: false } : resolved;
      // With the pin set and nothing named, the pin is the only candidate: its online emulator, else
      // its AVD (booted). A pin that names no Android device (an iOS simulator) is refused, never
      // replaced by whatever emulator is online or the first AVD.
      const pin = operatorDevicePin();
      let pinnedAvd: string | undefined;
      if (pin && !device && !avd && !session.device && !res.effective) {
        pinnedAvd = (await listAvds()).find((a) => pinMatches(pin, a));
        if (!pinnedAvd)
          return qaError({
            what: `${DEVICE_PIN_ENV}=${pin} pins this server to a device that is not an online Android device or AVD, so no other device was used.`,
            changedState: false,
            retrySafe: false,
            failureCode: 'DEVICE_PINNED',
            nextSteps: ['qa_prepare_target is the Android path; for a pinned iOS simulator use qa_prepare_ios_target.', pinFixStep()],
          });
      }
      if (device && !res.effective) {
        return qaError({
          what: `Device "${device}" is not online`,
          changedState: false,
          retrySafe: true,
          nextSteps: [`Online: ${res.available.join(', ') || '(none)'}`],
        });
      }
      if (res.effective) {
        // Same policy + wording as qa_test_this's target planner (src/core/targetPlan.ts): a physical
        // device is refused with PHYSICAL_DEVICE_UNSUPPORTED, not a generic backend error.
        const refusal = await physicalDeviceRefusalFor(res.effective);
        if (refusal) {
          return qaError({
            what: refusal.what,
            changedState: false,
            retrySafe: false,
            failureCode: 'PHYSICAL_DEVICE_UNSUPPORTED',
            nextSteps: [
              'Start or create an Android Emulator, then retry with its emulator serial (see docs/physical-devices.md).',
              'For iOS, use qa_prepare_ios_target with a simulator.',
            ],
          });
        }
      }
      if (res.needSelection) {
        return qaError({
          what: 'Multiple devices online, choose one',
          changedState: false,
          retrySafe: true,
          failureCode: 'MULTIPLE_DEVICES',
          nextSteps: [`Re-call with device="<serial>". Online: ${res.available.join(', ')}`],
        });
      }
      const needBoot = !res.effective;

      // ---- external-APK detection (needs the file hash for the plan consent) ----
      // Containment is checked on REAL paths: `<root>/../../x.apk` or a symlink out of the root is external.
      let externalApk: { path: string; sha256: string } | undefined;
      if (!bindOnly && apkPath && !apkWithinRoot(apkPath, session.root)) {
        externalApk = { path: apkPath, sha256: createHash('sha256').update(readFileSync(apkPath)).digest('hex') };
      }
      // ---- install detection: EVERY install is consent-gated (like iOS), in-root APKs included
      //      (risk low). Only an already-installed app on a live emulator skips the prompt. ----
      let installNeeded = false;
      if (!bindOnly) {
        // After a boot an app that is already present is just launched: only an APK we actually have
        // is an install step (no "install from (resolved APK)" for a preinstalled system app).
        if (needBoot) installNeeded = !!apkPath;
        else if (res.effective) {
          const probe = new DirectDriver();
          probe.useDevice(res.effective);
          installNeeded = !!force || !(await probe.isInstalled(resolvedAppId!).catch(() => false));
        }
      }
      // Fail fast BEFORE consent: an install is needed but there is no APK for this appId.
      if (installNeeded && !apkPath) {
        const near = res.effective ? await nearestInstalledPackage(res.effective, resolvedAppId!) : undefined;
        return qaError({
          what: `${resolvedAppId} is ${force ? 'to be reinstalled' : `not installed on ${res.effective}`}, and no APK for it was found (any APK under the project root is a different app).`,
          changedState: false,
          retrySafe: true,
          failureCode: 'NO_ARTIFACT',
          nextSteps: [
            ...(near ? [`Did you mean appId="${near}"? It is installed on ${res.effective}.`] : []),
            'Pass apk="<path to the APK for this app>", or check the package name.',
          ],
        });
      }

      // ---- COMBINED plan consent (Phase 2.1): all privileged steps approved at once,
      //      so boot + external-APK don't ping-pong across calls. ----
      const hl = headless ?? true;
      const avds = needBoot ? await listAvds() : [];
      // Boot the requested AVD, else the AVD of this session's own (offline) emulator. A session bound
      // to a device is never moved to some other AVD implicitly.
      const sessionAvd = sessionAvdFor(session, session.device);
      const bootTarget = avd ?? sessionAvd ?? pinnedAvd ?? (session.device ? undefined : avds[0]);
      if (needBoot && avd && avds.length && !avds.includes(avd)) {
        return qaError({
          what: `AVD "${avd}" not found`,
          changedState: false,
          retrySafe: true,
          failureCode: 'NO_DEVICE',
          nextSteps: [`Available AVDs: ${avds.join(', ')}`],
        });
      }
      if (needBoot && avds.length && !bootTarget) {
        return qaError({
          what: `This session's device ${session.device} is not online, and Swipium does not know its AVD; it is NOT replaced by another device.`,
          changedState: false,
          retrySafe: true,
          failureCode: 'DEVICE_NOT_READY',
          nextSteps: [
            `Bring ${session.device} back online, or choose deliberately: qa_prepare_target avd="<AVD>" (available: ${avds.join(', ')}) or device="<serial>".`,
          ],
        });
      }
      if (needBoot && avds.length === 0) {
        return qaError({
          what: 'No device online and no AVD to boot',
          changedState: false,
          retrySafe: true,
          nextSteps: [
            'Create an AVD: Android Studio > Device Manager > Create device, or `avdmanager create avd -n Pixel_7 -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_7`.',
            'Or start an Android emulator yourself, then retry (physical devices are out of scope).',
          ],
        });
      }
      const plan = [
        needBoot ? `boot_emulator(${bootTarget}${hl ? ',headless' : ',windowed'})` : null,
        rnDebug ? 'set_metro_reverse' : null,
        externalApk
          ? `install_external_apk(${externalApk.sha256.slice(0, 12)}…)`
          : installNeeded
            ? 'install_apk'
            : !bindOnly
              ? 'install_if_needed'
              : null,
        bindOnly ? 'bind_only' : 'launch_app',
      ].filter(Boolean) as string[];
      const privileged = needBoot || !!externalApk || installNeeded;
      const planAffects = {
        plan,
        device: res.effective ?? null,
        boot: needBoot ? { avd: bootTarget, headless: hl } : null,
        externalApkSha256: externalApk?.sha256 ?? null,
        install: installNeeded ? { appId: resolvedAppId ?? null, apk: apkPath ?? null } : null,
      };
      let mutationConsent: HeavyArgs['mutationConsent'];
      let preparePlanMutation: HeavyArgs['preparePlanMutation'];
      if (privileged) {
        const gate = consumeConsent(consentId, approve, { action: 'prepare_plan', affects: planAffects });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_prepare_target',
            action: 'prepare_plan',
            risk: externalApk ? 'medium' : 'low',
            target: planAffects,
            consent: { required: true, approved: false, payloadHash: externalApk?.sha256 },
            status: 'requested',
          });
          // Name the device every command runs against (the bound serial, or the AVD this plan boots).
          const adbS = res.effective ? `adb -s ${res.effective}` : `adb -s <${bootTarget} once booted>`;
          const lines = [
            needBoot
              ? `• boot emulator "${bootTarget}" (${hl ? 'headless' : 'visible'}): emulator ${emulatorBootArgs(bootTarget!, hl).join(' ')}`
              : '',
            externalApk
              ? `• install EXTERNAL apk (outside project root), sha256 ${externalApk.sha256.slice(0, 16)}…: ${adbS} install -r -g ${externalApk.path}`
              : installNeeded
                ? `• install ${resolvedAppId ?? 'the app'} from ${apkPath ?? '(resolved APK)'}: ${adbS} install -r -g ${apkPath ?? '<apk>'}`
                : '',
          ]
            .filter(Boolean)
            .join('\n');
          return requireConsent({
            action: 'prepare_plan',
            risk: externalApk ? 'medium' : 'low',
            exactCommand: lines,
            affects: planAffects,
            explain: `This prepare needs ${privileged ? 'these privileged steps' : 'no consent'} (approved together so they don't re-prompt):\n${lines}\nPlan: ${plan.join(' > ')}`,
          });
        }
        mutationConsent = { required: true, consentId, approved: true, payloadHash: externalApk?.sha256 };
        preparePlanMutation = { affects: planAffects, risk: externalApk ? 'medium' : 'low', consentId };
        sessions.recordMutation(session, {
          tool: 'qa_prepare_target',
          action: 'prepare_plan',
          risk: preparePlanMutation.risk,
          target: planAffects,
          consent: mutationConsent,
          status: 'approved',
        });
        if (externalApk) sessions.addEnvChange(session, `consented external-APK install (sha256 ${externalApk.sha256.slice(0, 12)}…)`);
      }

      // ---- FAST PATHS (synchronous) when no long op (no boot, no install) ----
      if (!needBoot && res.effective) {
        const serial = res.effective;
        const driver = bindDevice(session, serial); // bind now (also fixes device:null across tools)
        if (avdSerial)
          sessions.recordMutation(session, {
            tool: 'qa_prepare_target',
            action: 'bind_emulator',
            risk: 'low',
            target: { avd, device: serial },
            consent: { required: false, approved: true },
            status: 'executed',
          });
        else await rememberBoundAvd(sessions, session, serial, 'qa_prepare_target'); // bound by serial: remember its AVD too
        await driver.disableAnimations().catch(() => {});
        // Set reverse for RN/Expo (cheap, non-destructive) so the bundle path is wired.
        if (rnDebug && !(await reverseSet(serial))) {
          try {
            await driver.adbReverseMetro();
            sessions.addEnvChange(session, 'set adb reverse tcp:8081');
          } catch {
            /* best-effort */
          }
        }
        if (bindOnly) {
          const rd = await metroReadiness(serial, METRO_PORT, session.root);
          sessions.persist(session);
          return qaOk(
            { device: serial, bound: true, metro: rd },
            `Bound ${serial}.${rnDebug ? ` Metro: serving=${rd.serving} reverse=${rd.reverseSet} ready=${rd.ready}.` : ''} (bindOnly, no install/launch)`,
          );
        }
        const installed = await driver.isInstalled(resolvedAppId!);
        if (installed && !force) {
          // Launch gate (Phase 2.1, P1.5): refuse only if Metro is NOT SERVING. A missing
          // reverse is not fatal (emulators reach the host via 10.0.2.2), so serving is the
          // real signal. allowLaunchWithoutMetro overrides.
          if (rnDebug && !allowLaunchWithoutMetro) {
            const rd = await metroReadiness(serial, METRO_PORT, session.root);
            if (rd.wrongProject) {
              return qaError({
                what: wrongProjectMetroMessage(rd, session.root),
                changedState: false,
                retrySafe: true,
                failureCode: 'METRO_WRONG_PROJECT',
                nextSteps: [
                  `Stop the Metro serving ${rd.metroProjectRoot ?? 'the other project'}, then qa_metro action="start" and retry.`,
                ],
              });
            }
            if (!rd.serving) {
              return qaError({
                what: `Debug RN/Expo build; Metro is not SERVING the bundle yet (listening=${rd.listening} reverse=${rd.reverseSet} serving=${rd.serving}). Launching now risks the "Unable to load script" RedBox.`,
                changedState: false,
                retrySafe: true,
                failureCode: 'METRO_REQUIRED',
                nextSteps: [
                  'Start Metro: qa_metro action="start" (consent-gated), then qa_wait {for:"metro_ready"}, then re-run qa_prepare_target.',
                  'If this is a release build with an embedded bundle, OR you accept the risk, pass allowLaunchWithoutMetro:true.',
                ],
              });
            }
          }
          if (rnDebug && allowLaunchWithoutMetro)
            sessions.addEnvChange(session, 'OVERRIDE allowLaunchWithoutMetro: launched without confirmed Metro readiness');
          sessions.milestone(session, 'app_launch_start');
          let foreground: string;
          try {
            await driver.launchApp(resolvedAppId!);
            noteScreenMutation(session); // a snapshot taken before the launch is stale
            foreground = await waitForLaunch(driver, resolvedAppId!);
          } catch (e) {
            // A launch that throws (adb timed out under load) gets a coded failure, not a raw error.
            if (isAbortError(e)) throw e;
            if (isInvalidArgumentError(e))
              return invalidArgumentError(e, ['Pass a valid Android application id, e.g. appId="com.example.app".']);
            const code = launchFailureCode(e);
            return qaError({
              what: `Could not launch ${resolvedAppId} on ${serial}: ${String(e).replace(/^Error:\s*/, '')}`,
              changedState: true,
              retrySafe: true,
              failureCode: code,
              nextSteps:
                code === 'DEVICE_UNRESPONSIVE'
                  ? [
                      `The device answered adb too slowly (still booting or the host is overloaded). Run qa_wait {for:"device_online"}, then retry qa_prepare_target.`,
                    ]
                  : ['Check the app starts by hand (adb logcat for a crash on start), then retry qa_prepare_target.'],
            });
          }
          session.appId = resolvedAppId;
          const launchedOk = foreground.startsWith(resolvedAppId!);
          // CR P3: app_launch_end is the report's "reached the app" evidence: only when the app under
          // test is confirmed in front (a launch that never reached the foreground proves nothing).
          if (launchedOk) sessions.milestone(session, 'app_launch_end');
          sessions.persist(session);
          sessions.recordMutation(session, {
            tool: 'qa_prepare_target',
            action: 'launch_app',
            risk: 'low',
            target: { device: serial, appId: resolvedAppId, foreground },
            consent: { required: false, approved: true },
            status: 'executed',
          });
          if (preparePlanMutation) {
            sessions.recordMutation(session, {
              tool: 'qa_prepare_target',
              action: 'prepare_plan',
              risk: preparePlanMutation.risk,
              target: preparePlanMutation.affects,
              consent: mutationConsent,
              status: 'executed',
            });
          }
          // E2E NEW-17: a debug RN/Expo build is checked once (one dump) for a RedBox / the Expo dev
          // launcher, so a launch onto one never reads as a plain success.
          const { appError } = rnDebug && launchedOk ? await checkLaunchErrorSurface(sessions, session, driver) : {};
          if (appError && isMetroRequiredFinding(appError))
            return qaFail('METRO_REQUIRED', {
              what: `${resolvedAppId} launched on ${serial}, but ${launchErrorText(appError)}: the debug build has no JS bundle, so it is not ready to test.`,
              changedState: true,
              nextSteps: [
                'Start Metro for this project (qa_metro { action:"start" }), wait until it is serving (qa_wait { for:"metro_ready" }), then re-run qa_prepare_target.',
              ],
              extra: { device: serial, appId: resolvedAppId, launchedOk, appError },
            });
          return qaOk(
            {
              device: serial,
              appId: resolvedAppId,
              installed: 'already-present',
              foreground,
              launchedOk,
              launchedWithoutMetro: !!(rnDebug && allowLaunchWithoutMetro) || undefined,
              ...(appError ? { ready: false, appError } : {}),
            },
            appError
              ? `⚠️ ${resolvedAppId} on ${serial} launched, but ${launchErrorText(appError)}: recorded as an app finding, not ready to test.`
              : `${launchedOk ? '✅' : '⚠️'} ${resolvedAppId} on ${serial} (already present); foreground=${foreground}.`,
          );
        }
        // install needed > JOB
        return startJob(sessions, session, driver, {
          needBoot: false,
          serial,
          resolvedAppId: resolvedAppId!,
          apkPath,
          apk,
          force,
          rnDebug,
          allowLaunchWithoutMetro: !!allowLaunchWithoutMetro,
          mutationConsent,
          preparePlanMutation,
        });
      }

      // ---- BOOT path > JOB (consent already granted via the plan) ----
      const driver = new DirectDriver();
      return startJob(sessions, session, driver, {
        needBoot: true,
        bootTarget,
        resolvedAppId: resolvedAppId!,
        apkPath,
        apk,
        force,
        headless: hl,
        rnDebug,
        allowLaunchWithoutMetro: !!allowLaunchWithoutMetro,
        bindOnly: !!bindOnly,
        mutationConsent,
        preparePlanMutation,
      });
    },
  );
}

interface HeavyArgs {
  needBoot: boolean;
  bootTarget?: string;
  serial?: string;
  resolvedAppId: string;
  apkPath?: string;
  apk?: string;
  force?: boolean;
  headless?: boolean;
  rnDebug?: boolean; // RN/Expo: set reverse + gate launch on Metro serving
  allowLaunchWithoutMetro?: boolean;
  bindOnly?: boolean;
  mutationConsent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string };
  preparePlanMutation?: { affects: Record<string, unknown>; risk: 'low' | 'medium'; consentId?: string };
}

function startJob(sessions: SessionStore, session: Session, driver: DirectDriver, a: HeavyArgs) {
  const job = sessions.createJob(session, a.needBoot ? 'boot+install' : 'install');
  // Driver calls inside the job inherit the job's cancellation signal (abortScope), never a
  // mutable slot on the shared driver that a concurrent qa_snapshot/qa_act could swap.
  void runWithSignal(sessions.abortSignal(session, job.jobId), () => runHeavy(sessions, session, driver, job, a));
  return qaOk(
    { jobId: job.jobId, status: 'running', kind: job.kind },
    `Started ${job.kind} as job ${job.jobId}. Poll with qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" }.`,
  );
}

async function runHeavy(sessions: SessionStore, session: Session, driver: DirectDriver, job: JobRecord, a: HeavyArgs): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>): void => {
    sessions.updateJobIfRunning(session, job, patch);
  };
  // Delegate to the shared service so qa_test_this execute mode runs the identical path.
  const res = await prepareAndroid(sessions, session, driver, a, { signal, onProgress: (p) => upd({ progress: p }) });
  if (res.aborted) return; // cancelJob already set the terminal status; do not overwrite
  if (!res.ok) {
    if (a.preparePlanMutation) {
      sessions.recordMutation(session, {
        tool: 'qa_prepare_target',
        action: 'prepare_plan',
        risk: a.preparePlanMutation.risk,
        target: a.preparePlanMutation.affects,
        consent: a.mutationConsent,
        status: 'blocked',
        detail: res.error ?? res.failureCode ?? 'prepare failed',
      });
    }
    // Coded error (like other jobs: "<CODE>: detail") and no stale in-flight progress text.
    upd({
      status: 'failed',
      error: `${res.failureCode ? `${res.failureCode}: ` : ''}${res.error ?? 'prepare failed'}`,
      progress: 'failed',
      ...(res.failureCode ? { result: { failureCode: res.failureCode } } : {}),
      endedAt: Date.now(),
    });
    return;
  }
  if (a.preparePlanMutation) {
    sessions.recordMutation(session, {
      tool: 'qa_prepare_target',
      action: 'prepare_plan',
      risk: a.preparePlanMutation.risk,
      target: a.preparePlanMutation.affects,
      consent: a.mutationConsent,
      status: 'executed',
    });
  }
  // E2E NEW-17: same one-dump RedBox / Expo dev launcher check as the in-call launch path.
  const { appError } =
    a.rnDebug && res.launchedOk
      ? await checkLaunchErrorSurface(sessions, session, driver).catch(() => ({}) as { appError?: undefined })
      : {};
  if (signal?.aborted) return;
  if (appError && isMetroRequiredFinding(appError)) {
    upd({
      status: 'failed',
      error: `METRO_REQUIRED: ${a.resolvedAppId} launched, but ${launchErrorText(appError)}: the debug build has no JS bundle. Start Metro (qa_metro { action:"start" }), then re-run qa_prepare_target.`,
      progress: 'failed',
      result: { ...res.result, failureCode: 'METRO_REQUIRED', appError },
      endedAt: Date.now(),
    });
    return;
  }
  upd({
    status: 'done',
    progress: 'done',
    result: appError ? { ...res.result, ready: false, appError } : res.result,
    resultText: appError
      ? `⚠️ ${a.resolvedAppId} launched, but ${launchErrorText(appError)}: recorded as an app finding, not ready to test.`
      : res.resultText,
    endedAt: Date.now(),
  });
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Whether an APK path lies inside the project root, compared on normalized real paths. */
export function apkWithinRoot(apkPath: string, root: string): boolean {
  const rel = relative(realOr(root), realOr(resolve(root, apkPath)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Physical-device refusal for an online adb serial, delegated to the shared target planner so
 *  qa_prepare_target and qa_test_this classify serials identically. Null when it is an emulator
 *  (by serial pattern or by device properties). */
export async function physicalDeviceRefusalFor(serial: string): Promise<{ what: string } | null> {
  // Property-verified emulators (localhost:5555, Genymotion) are accepted like `emulator-N`
  // serials: the same getprop probe qa_test_this / qa_resolve_target / auto-attach use.
  const emulators = await verifiedEmulatorSerials([serial]);
  const plan = planTarget({
    requestedDevice: serial,
    android: { online: [serial], avds: [], emulators },
    ios: { bootedSimulators: [], availableSimulators: [] },
  });
  if (plan.blocked?.failureCode !== 'PHYSICAL_DEVICE_UNSUPPORTED') return null;
  return { what: plan.reason };
}

/** The project's installable APK: an explicit path, else the shallow resolveApk scan, else the same
 *  artifact resolver qa_test_this uses (standard Gradle outputs such as android/app/build/outputs/apk/debug). */
async function findProjectApk(root: string, explicit?: string): Promise<{ apk?: string; error?: string }> {
  const r = resolveApk(root, explicit);
  if (r.apk || explicit) return r;
  const art = await resolveArtifact({ projectRoot: root, platform: 'android' }).catch(() => undefined);
  return art?.best?.type === 'apk' ? { apk: art.best.path } : r;
}

/** An installed package within a small edit distance of a mistyped appId (cheap: one `pm list packages`). */
async function nearestInstalledPackage(serial: string, appId: string): Promise<string | undefined> {
  try {
    const r = await run('adb', ['-s', serial, 'shell', 'pm', 'list', 'packages'], { timeoutMs: 8000 });
    const pkgs = r.stdout
      .split(/\r?\n/)
      .map((l) => l.replace(/^package:/, '').trim())
      .filter(Boolean);
    let best: { p: string; d: number } | undefined;
    for (const p of pkgs) {
      const d = editDistance(p, appId);
      if (!best || d < best.d) best = { p, d };
    }
    return best && best.d > 0 && best.d <= 3 ? best.p : undefined;
  } catch {
    return undefined;
  }
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
