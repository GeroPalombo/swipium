// qa_prepare_target — get the app running on a device.
//
// Fast path (device online + app installed + !force): run synchronously, return the result.
// Long-op path (needs emulator boot or an install): create a JOB, run async, return a
// `jobId` immediately (poll with qa_job_status) — so client tool-call timeouts don't hit
// the slow paths (review #2). Interactive consent (boot, external-APK) is resolved
// synchronously BEFORE the job is kicked off.

import { z } from 'zod';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, invalidArgumentError, isInvalidArgumentError, unknownSessionError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { listAvds, resolveApk, apkPackageId } from '../lib/android.js';
import { DirectDriver, assertAndroidAppId } from '../drivers/DirectDriver.js';
import { detectFramework } from '../context/detect.js';
import { metroReadiness, reverseSet } from '../lib/metroState.js';
import { resolveDevice, bindDevice } from '../session/attach.js';
import { prepareAndroid } from '../services/prepareAndroid.js';
import { planTarget } from '../core/targetPlan.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';
import { runWithSignal } from '../lib/abortScope.js';

/** RN/Expo debug builds load JS from Metro; launching before Metro is SERVING → RedBox. */
function needsMetro(root: string): boolean {
  const fw = detectFramework(root);
  return fw === 'expo' || fw === 'bare-react-native';
}

export function registerPrepareTarget(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_prepare_target',
    {
      title: 'Prepare a target device + app',
      description:
        'Prepare an Android Emulator target in order: device → Metro → install → launch, with one combined consent for ' +
        'privileged steps (boot, external APK). Binds the single online device (asks if several), sets adb reverse for RN/Expo, ' +
        'waits for Metro to serve, installs if needed, launches, verifies. Long operations return a jobId. bindOnly binds/boots ' +
        'without install/launch.',
      inputSchema: {
        sessionId: z.string(),
        apk: z.string().optional(),
        appId: z.string().optional(),
        avd: z.string().optional(),
        device: z.string().optional().describe('Target serial; required when >1 device is online.'),
        force: z.boolean().optional(),
        headless: z.boolean().optional().describe('Boot the AVD headless (default true).'),
        bindOnly: z.boolean().optional().describe('Bind/boot + adb reverse only (breaks a device/Metro deadlock).'),
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
      const rnDebug = needsMetro(session.root);

      // ---- appId (+apk if needed for detection) — not needed for bindOnly ----
      let resolvedAppId = appId;
      let apkPath: string | undefined = apk;
      if (!bindOnly && !resolvedAppId) {
        const r = resolveApk(session.root, apk);
        if (!r.apk)
          return qaError({
            what: r.error ?? 'No APK to detect appId',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Pass appId= or apk=, or drop a build under apps/android/, or use bindOnly:true to just bind a device.'],
          });
        apkPath = r.apk;
        resolvedAppId = (await apkPackageId(apkPath)) ?? undefined;
        if (!resolvedAppId)
          return qaError({
            what: 'Could not determine applicationId from the APK',
            changedState: false,
            retrySafe: true,
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

      // ---- device resolution (centralized; binds single online, asks on >1) ----
      const res = await resolveDevice(session, device);
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
        const refusal = physicalDeviceRefusalFor(res.effective);
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
          what: 'Multiple devices online — choose one',
          changedState: false,
          retrySafe: true,
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
        if (needBoot) installNeeded = true;
        else if (res.effective) {
          const probe = new DirectDriver();
          probe.useDevice(res.effective);
          installNeeded = !!force || !(await probe.isInstalled(resolvedAppId!).catch(() => false));
        }
      }

      // ---- COMBINED plan consent (Phase 2.1): all privileged steps approved at once,
      //      so boot + external-APK don't ping-pong across calls. ----
      const hl = headless ?? true;
      const avds = needBoot ? await listAvds() : [];
      const bootTarget = avd ?? avds[0];
      if (needBoot && avds.length === 0) {
        return qaError({
          what: 'No device online and no AVD to boot',
          changedState: false,
          retrySafe: true,
          nextSteps: [
            'Create an AVD: Android Studio → Device Manager → Create device, or `avdmanager create avd -n Pixel_7 -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_7`.',
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
          const lines = [
            needBoot
              ? `• boot emulator "${bootTarget}" (${hl ? 'headless' : 'visible'}): emulator -avd ${bootTarget}${hl ? ' -no-window' : ''}`
              : '',
            externalApk
              ? `• install EXTERNAL apk (outside project root), sha256 ${externalApk.sha256.slice(0, 16)}…: adb install -r -g ${externalApk.path}`
              : installNeeded
                ? `• install ${resolvedAppId ?? 'the app'} from ${apkPath ?? '(resolved APK)'}: adb install -r -g ${apkPath ?? '<apk>'}`
                : '',
          ]
            .filter(Boolean)
            .join('\n');
          return requireConsent({
            action: 'prepare_plan',
            risk: externalApk ? 'medium' : 'low',
            exactCommand: lines,
            affects: planAffects,
            explain: `This prepare needs ${privileged ? 'these privileged steps' : 'no consent'} (approved together so they don't re-prompt):\n${lines}\nPlan: ${plan.join(' → ')}`,
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
          const rd = await metroReadiness(serial);
          sessions.persist(session);
          return qaOk(
            { device: serial, bound: true, metro: rd },
            `Bound ${serial}.${rnDebug ? ` Metro: serving=${rd.serving} reverse=${rd.reverseSet} ready=${rd.ready}.` : ''} (bindOnly — no install/launch)`,
          );
        }
        const installed = await driver.isInstalled(resolvedAppId!);
        if (installed && !force) {
          // Launch gate (Phase 2.1, P1.5): refuse only if Metro is NOT SERVING. A missing
          // reverse is not fatal — emulators reach the host via 10.0.2.2 — so serving is the
          // real signal. allowLaunchWithoutMetro overrides.
          if (rnDebug && !allowLaunchWithoutMetro) {
            const rd = await metroReadiness(serial);
            if (!rd.serving) {
              return qaError({
                what: `Debug RN/Expo build; Metro is not SERVING the bundle yet (listening=${rd.listening} reverse=${rd.reverseSet} serving=${rd.serving}). Launching now risks the "Unable to load script" RedBox.`,
                changedState: false,
                retrySafe: true,
                nextSteps: [
                  'Start Metro/dev server manually, wait for serving=true, then re-run qa_prepare_target.',
                  'If this is a release build with an embedded bundle, OR you accept the risk, pass allowLaunchWithoutMetro:true.',
                ],
              });
            }
          }
          if (rnDebug && allowLaunchWithoutMetro)
            sessions.addEnvChange(session, 'OVERRIDE allowLaunchWithoutMetro — launched without confirmed Metro readiness');
          sessions.milestone(session, 'app_launch_start');
          await driver.launchApp(resolvedAppId!);
          await new Promise((r) => setTimeout(r, 2500));
          const foreground = await driver.foregroundOwner();
          sessions.milestone(session, 'app_launch_end');
          session.appId = resolvedAppId;
          sessions.persist(session);
          const launchedOk = foreground.startsWith(resolvedAppId!);
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
          return qaOk(
            {
              device: serial,
              appId: resolvedAppId,
              installed: 'already-present',
              foreground,
              launchedOk,
              launchedWithoutMetro: !!(rnDebug && allowLaunchWithoutMetro) || undefined,
            },
            `${launchedOk ? '✅' : '⚠️'} ${resolvedAppId} on ${serial} (already present); foreground=${foreground}.`,
          );
        }
        // install needed → JOB
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

      // ---- BOOT path → JOB (consent already granted via the plan) ----
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
  rnDebug?: boolean; // RN/Expo → set reverse + gate launch on Metro serving
  allowLaunchWithoutMetro?: boolean;
  bindOnly?: boolean;
  mutationConsent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string };
  preparePlanMutation?: { affects: Record<string, unknown>; risk: 'low' | 'medium'; consentId?: string };
}

function startJob(sessions: SessionStore, session: Session, driver: DirectDriver, a: HeavyArgs) {
  const job = sessions.createJob(session, a.needBoot ? 'boot+install' : 'install');
  // Driver calls inside the job inherit the job's cancellation signal (abortScope) — never a
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
    upd({ status: 'failed', error: res.error ?? 'prepare failed', endedAt: Date.now() });
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
  upd({ status: 'done', progress: 'done', result: res.result, resultText: res.resultText, endedAt: Date.now() });
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
 *  qa_prepare_target and qa_test_this classify serials identically. Null when it is an emulator. */
export function physicalDeviceRefusalFor(serial: string): { what: string } | null {
  const plan = planTarget({
    requestedDevice: serial,
    android: { online: [serial], avds: [] },
    ios: { bootedSimulators: [], availableSimulators: [] },
  });
  if (plan.blocked?.failureCode !== 'PHYSICAL_DEVICE_UNSUPPORTED') return null;
  return { what: plan.reason };
}
