// qa_bundletool (hardening P0.2): convert an .aab to an installable universal .apk via bundletool,
// cached under .swipium/artifacts/. Runs as a job (conversion can take a minute). Returns a typed
// AAB_NEEDS_BUNDLETOOL / AAB_BUILD_APKS_FAILED blocker when it cannot, never a generic error.

import { z } from 'zod';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { qaError, qaOk, unknownSessionError } from '../lib/result.js';
import { qaFail } from '../oracle/failures.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { resolveArtifact } from '../artifacts/resolve.js';
import { convertAabToApk, findBundletool, buildAndInstallApkSet } from '../artifacts/bundletool.js';
import { startProgress } from '../session/progress.js';
import { log } from '../lib/logger.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';
import { runWithSignal } from '../lib/abortScope.js';
import { adbDevices } from '../lib/android.js';
import {
  DEVICE_PIN_ENV,
  devicePinConflict,
  isSimulatorUdid,
  onlineSerialForAvd,
  operatorDevicePin,
  pinFixStep,
  pinMatches,
} from '../session/attach.js';

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function registerBundletool(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_bundletool',
    {
      title: 'Convert .aab > installable .apk',
      description:
        'Convert an .aab into an installable APK with bundletool (cached in .swipium/artifacts/) before qa_prepare_target. ' +
        'Default: a universal APK; connectedDevice:true builds a device APK set, install:true installs it (consent-gated). ' +
        'Runs as a job.',
      inputSchema: {
        sessionId: z.string(),
        aab: z.string().optional().describe('Default: the best .aab in the project.'),
        force: z.boolean().optional().describe('Rebuild even if cached.'),
        connectedDevice: z.boolean().optional().describe('Device-specific APK set (--connected-device).'),
        install: z.boolean().optional().describe('With connectedDevice: install-apks on the device (consent-gated).'),
        device: z.string().optional().describe('adb serial (default: session device, else SWIPIUM_DEVICE, else the only one).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, aab, force, connectedDevice, install, device, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);

      // Resolve the .aab if not given.
      let aabPath = aab;
      if (!aabPath) {
        const r = await resolveArtifact({ projectRoot: session.root, platform: 'android' }, false);
        const found = [r.best, ...r.candidates].find((c) => c?.type === 'aab');
        if (!found)
          return qaFail('NO_BUILD_ARTIFACT', {
            what: 'No .aab found to convert',
            nextSteps: ['Pass aab=, or build an APK directly with qa_build.'],
          });
        aabPath = found.path;
      } else {
        // TOOL NEW-6: refuse a missing path up front instead of starting a job that can only fail.
        aabPath = isAbsolute(aabPath) ? aabPath : join(session.root, aabPath);
        if (!isFile(aabPath))
          return qaFail('NO_BUILD_ARTIFACT', {
            what: `.aab not found: ${aabPath}`,
            nextSteps: [
              'Pass an existing .aab path (absolute, or relative to the project root), or omit aab to use the best .aab in the project.',
            ],
          });
        if (!/\.aab$/i.test(aabPath))
          return qaError({
            what: `Not an Android App Bundle: ${aabPath} (expected a .aab file)`,
            changedState: false,
            retrySafe: true,
            failureCode: 'INVALID_ARGUMENT',
            nextSteps: ['Pass the .aab Gradle built (bundleRelease / bundleDebug), or omit aab to use the best .aab in the project.'],
          });
      }

      // Installing an APK set runs app code on a real device/emulator, so it's consent-gated (build-only
      // is safe and ungated). Confirm intent BEFORE any work, regardless of whether bundletool is
      // installed. Mirrors qa_prepare_target / qa_prepare_ios_target.
      // CR P6: the device the APK set is built for / installed on follows the same rule as
      // qa_prepare_target: SWIPIUM_DEVICE refuses any other device before consent, and with no
      // device the session's own emulator (else the pinned one) is used, never "any connected device".
      let deviceId = device;
      if (connectedDevice) {
        const online = await adbDevices();
        const pinConflict = await devicePinConflict(device, online);
        if (pinConflict)
          return qaError({
            what: pinConflict,
            changedState: false,
            retrySafe: false,
            failureCode: 'DEVICE_PINNED',
            nextSteps: ['Re-call without device: the pinned device is used.'],
          });
        const pin = operatorDevicePin();
        if (!deviceId && session.device && !isSimulatorUdid(session.device)) deviceId = session.device;
        if (!deviceId && pin) {
          deviceId = online.find((s) => pinMatches(pin, s)) ?? (await onlineSerialForAvd(pin, online));
          if (!deviceId)
            return qaError({
              what: `${DEVICE_PIN_ENV}=${pin} (server env) matches no online Android device, so no other device was used.`,
              changedState: false,
              retrySafe: true,
              failureCode: 'NO_DEVICE',
              nextSteps: ['Boot the pinned emulator (qa_prepare_target { bindOnly:true }), then retry.', pinFixStep()],
            });
        }
      }
      let mutationConsent: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string } | undefined;
      if (connectedDevice && install) {
        const affects = { aab: aabPath, device: deviceId ?? '(only connected device)' };
        const gate = consumeConsent(consentId, approve, { action: 'install_app', affects });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_bundletool',
            action: 'install_app',
            risk: 'medium',
            target: affects,
            consent: { required: true, approved: false },
            status: 'requested',
          });
          return requireConsent({
            action: 'install_app',
            risk: 'medium',
            exactCommand: `bundletool build-apks --connected-device${deviceId ? ` --device-id ${deviceId}` : ''} --bundle ${aabPath} && bundletool install-apks --apks <set>`,
            affects,
            explain: `Build a device-specific APK set from ${aabPath} and INSTALL it on ${deviceId ?? 'the connected device'}? It pushes app code to the device.`,
          });
        }
        mutationConsent = { required: true, consentId, approved: true };
      }

      // Fail fast + honestly when bundletool is unavailable (no job needed).
      const launcher = await findBundletool();
      if (!launcher) {
        return qaFail('AAB_NEEDS_BUNDLETOOL', {
          what: `bundletool is not installed, cannot convert ${aabPath}`,
          nextSteps: [
            'Install bundletool (brew install bundletool) or set $BUNDLETOOL_JAR to bundletool.jar.',
            'Or build an APK directly: qa_build { platform: "android", variant: "debug" }  (./gradlew assembleDebug).',
          ],
          extra: { aab: aabPath },
        });
      }

      const job = sessions.createJob(session, 'bundletool:convert');
      if (connectedDevice) {
        // Jobs run in their own cancellation scope (abortScope), not the starting call's.
        void runWithSignal(sessions.abortSignal(session, job.jobId), () =>
          runDeviceApkSet(sessions, session, job, aabPath, { install: !!install, deviceId, force: !!force, mutationConsent }),
        );
        return qaOk(
          {
            jobId: job.jobId,
            status: 'running',
            kind: job.kind,
            aab: aabPath,
            mode: 'connected-device',
            install: !!install,
            bundletool: launcher.describe,
          },
          `Building${install ? ' + installing' : ''} a device-specific APK set from ${aabPath} as job ${job.jobId} (${launcher.describe}). Poll qa_job_status.`,
        );
      }
      void runWithSignal(sessions.abortSignal(session, job.jobId), () => runConvert(sessions, session, job, aabPath, !!force));
      return qaOk(
        { jobId: job.jobId, status: 'running', kind: job.kind, aab: aabPath, mode: 'universal', bundletool: launcher.describe },
        `Converting ${aabPath} > universal APK as job ${job.jobId} (${launcher.describe}). Poll qa_job_status.`,
      );
    },
  );
}

async function runDeviceApkSet(
  sessions: SessionStore,
  session: Session,
  job: JobRecord,
  aabPath: string,
  opts: {
    install: boolean;
    deviceId?: string;
    force: boolean;
    mutationConsent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string };
  },
): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const prog = startProgress(sessions, session, job, 'building_apk_set', {
    statusText: 'Building a device-specific APK set with bundletool --connected-device.',
    nextExpected: opts.install ? 'Install the APK set on the device.' : 'Cache the APK set.',
  });
  try {
    const result = await buildAndInstallApkSet(aabPath, session.root, {
      deviceId: opts.deviceId,
      install: opts.install,
      signal,
      force: opts.force,
    });
    if (signal?.aborted) return;
    const logUri = result.logText
      ? sessions.saveArtifact(
          session,
          'logs',
          `bundletool-apks-${job.jobId}.log`,
          result.logText,
          'text/plain',
          'bundletool device APK set log',
        )
      : undefined;
    if (!result.ok) {
      if (opts.install) {
        sessions.recordMutation(session, {
          tool: 'qa_bundletool',
          action: 'install_app',
          risk: 'medium',
          target: { aab: aabPath, device: opts.deviceId ?? null, apksPath: result.apksPath ?? null },
          consent: opts.mutationConsent ?? { required: true, approved: true },
          status: 'blocked',
          detail: `${result.failureCode}: ${result.error}`,
        });
      }
      upd({
        status: 'failed',
        error: `${result.failureCode}: ${result.error}`,
        result: {
          failureCode: result.failureCode,
          apksPath: result.apksPath ?? null,
          command: result.buildCommand ?? null,
          logUri,
          aab: aabPath,
        },
        resultText: `❌ ${result.failureCode}: ${result.error}`,
        endedAt: Date.now(),
      });
      return;
    }
    if (result.installed) {
      sessions.addEnvChange(session, `installed APK set from ${aabPath} on ${opts.deviceId ?? 'connected device'}`);
      sessions.recordMutation(session, {
        tool: 'qa_bundletool',
        action: 'install_app',
        risk: 'medium',
        target: { aab: aabPath, device: opts.deviceId ?? null, apksPath: result.apksPath ?? null },
        consent: opts.mutationConsent ?? { required: true, approved: true },
        status: 'executed',
      });
    }
    prog.done(result.installed ? 'Device APK set built + installed.' : 'Device APK set built.');
    sessions.addWorkaround(session, `built device-specific APK set via bundletool${result.installed ? ' + installed' : ''}`);
    upd({
      status: 'done',
      progress: 'done',
      result: {
        converted: true,
        mode: 'connected-device',
        installed: !!result.installed,
        originalArtifact: aabPath,
        apksPath: result.apksPath ?? null,
        buildCommand: result.buildCommand ?? null,
        installCommand: result.installCommand ?? null,
        logUri,
      },
      resultText: result.installed
        ? `✅ Device-specific APK set installed from ${aabPath}. The app is on the device; continue with qa_prepare_target { bindOnly: true } or qa_smoke.`
        : `✅ Device-specific APK set: ${result.apksPath}. Install it with qa_bundletool { connectedDevice: true, install: true } or bundletool install-apks.`,
      endedAt: Date.now(),
    });
  } catch (e) {
    if (signal?.aborted) return;
    log('error', 'bundletool device APK set job failed', { jobId: job.jobId, err: String(e) });
    upd({
      status: 'failed',
      error: String(e),
      result: { failureCode: 'AAB_DEVICE_SPEC_FAILED' },
      resultText: `❌ bundletool error: ${String(e)}`,
      endedAt: Date.now(),
    });
  }
}

async function runConvert(sessions: SessionStore, session: Session, job: JobRecord, aabPath: string, force: boolean): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const prog = startProgress(sessions, session, job, 'converting_aab', {
    statusText: 'Building a universal APK from the .aab with bundletool.',
    nextExpected: 'Extract universal.apk and cache it.',
  });
  try {
    const result = await convertAabToApk(aabPath, session.root, { signal, force });
    if (signal?.aborted) return;
    if (!result.ok) {
      const logUri = result.error
        ? sessions.saveArtifact(
            session,
            'logs',
            `bundletool-${Date.now()}.log`,
            `${result.command ?? ''}\n${result.error}`,
            'text/plain',
            'bundletool conversion log',
          )
        : undefined;
      upd({
        status: 'failed',
        error: `${result.failureCode}: ${result.error}`,
        result: { failureCode: result.failureCode, command: result.command, logUri, aab: aabPath },
        resultText: `❌ ${result.failureCode}: ${result.error}`,
        endedAt: Date.now(),
      });
      return;
    }
    prog.done('Universal APK ready.');
    sessions.addWorkaround(session, `converted .aab > universal .apk via bundletool (${result.fromCache ? 'cached' : 'built'})`);
    upd({
      status: 'done',
      progress: 'done',
      result: {
        converted: true,
        fromCache: !!result.fromCache,
        originalArtifact: aabPath,
        generatedApk: result.apkPath,
        apksPath: result.apksPath ?? null,
        command: result.command ?? null,
      },
      resultText: `✅ ${result.fromCache ? 'Using cached' : 'Built'} universal APK: ${result.apkPath}. Next: qa_prepare_target { apk: "${result.apkPath}" }.`,
      endedAt: Date.now(),
    });
  } catch (e) {
    if (signal?.aborted) return;
    log('error', 'bundletool job failed', { jobId: job.jobId, err: String(e) });
    upd({
      status: 'failed',
      error: String(e),
      result: { failureCode: 'AAB_BUILD_APKS_FAILED' },
      resultText: `❌ bundletool error: ${String(e)}`,
      endedAt: Date.now(),
    });
  }
}
