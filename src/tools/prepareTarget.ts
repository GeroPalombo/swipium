// qa_prepare_target — get the app running on a device.
//
// Fast path (device online + app installed + !force): run synchronously, return the result.
// Long-op path (needs emulator boot or an install): create a JOB, run async, return a
// `jobId` immediately (poll with qa_job_status) — so client tool-call timeouts don't hit
// the slow paths (review #2). Interactive consent (boot, external-APK) is resolved
// synchronously BEFORE the job is kicked off.

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { listAvds, resolveApk, apkPackageId } from '../lib/android.js';
import { DirectDriver } from '../drivers/DirectDriver.js';
import { detectFramework } from '../context/detect.js';
import { metroReadiness, reverseSet } from '../lib/metroState.js';
import { resolveDevice, bindDevice } from '../session/attach.js';
import { prepareAndroid } from '../services/prepareAndroid.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';

/** RN/Expo debug builds load JS from Metro; launching before Metro is SERVING → RedBox. */
function needsMetro(root: string): boolean {
  const fw = detectFramework(root);
  return fw === 'expo' || fw === 'bare-react-native';
}

function isAndroidEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+/.test(serial);
}

export function registerPrepareTarget(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_prepare_target',
    {
      title: 'Prepare a target device + app',
      description:
        'Orchestrate device→Metro→install→launch in the correct order, with a SINGLE combined consent for any privileged steps (boot, external-APK). Resolves/boots a device (binds the single online one automatically; asks if >1), sets adb reverse for RN/Expo, gates launch on Metro SERVING, installs the APK if needed, launches, verifies. Long ops return a jobId. Flags: bindOnly (bind/boot + reverse, no install/launch — use to break a setup deadlock); allowLaunchWithoutMetro (risky override); headless.',
      inputSchema: {
        sessionId: z.string(),
        apk: z.string().optional(),
        appId: z.string().optional(),
        avd: z.string().optional(),
        device: z.string().optional().describe('Target serial; required when >1 device is online.'),
        force: z.boolean().optional(),
        headless: z.boolean().optional().describe('If Swipium boots an AVD: headless (default true) or visible window (false).'),
        bindOnly: z
          .boolean()
          .optional()
          .describe(
            'Bind/boot the device + set adb reverse, but do NOT install or launch. Safe way to break a device/Metro setup deadlock.',
          ),
        allowLaunchWithoutMetro: z
          .boolean()
          .optional()
          .describe('Risky: launch a debug RN/Expo build even if Metro is not serving (may RedBox).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, apk, appId, avd, device, force, headless, bindOnly, allowLaunchWithoutMetro, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return qaError({
          what: `Unknown sessionId "${sessionId}"`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session first.'],
        });
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
      if (res.effective && !isAndroidEmulatorSerial(res.effective)) {
        return qaError({
          what: `Android target "${res.effective}" appears to be a real device. Swipium 1.0.0 supports Android Emulator only.`,
          changedState: false,
          retrySafe: true,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['Start or create an Android Emulator, then retry with its emulator serial.'],
        });
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
      let externalApk: { path: string; sha256: string } | undefined;
      if (!bindOnly && apkPath && !apkPath.startsWith(session.root + sep)) {
        externalApk = { path: apkPath, sha256: createHash('sha256').update(readFileSync(apkPath)).digest('hex') };
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
          nextSteps: ['Create an AVD (see qa_doctor), or start a device, then retry.'],
        });
      }
      const plan = [
        needBoot ? `boot_emulator(${bootTarget}${hl ? ',headless' : ',windowed'})` : null,
        rnDebug ? 'set_metro_reverse' : null,
        externalApk ? `install_external_apk(${externalApk.sha256.slice(0, 12)}…)` : !bindOnly ? 'install_if_needed' : null,
        bindOnly ? 'bind_only' : 'launch_app',
      ].filter(Boolean) as string[];
      const privileged = needBoot || !!externalApk;
      const planAffects = {
        plan,
        boot: needBoot ? { avd: bootTarget, headless: hl } : null,
        externalApkSha256: externalApk?.sha256 ?? null,
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
  void runHeavy(sessions, session, driver, job, a);
  return qaOk(
    { jobId: job.jobId, status: 'running', kind: job.kind },
    `Started ${job.kind} as job ${job.jobId}. Poll with qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" }.`,
  );
}

async function runHeavy(sessions: SessionStore, session: Session, driver: DirectDriver, job: JobRecord, a: HeavyArgs): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  driver.setSignal(signal); // cancel kills in-flight adb children (install/dump/etc.)
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
