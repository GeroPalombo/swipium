// qa_bundletool: convert an .aab to an installable universal .apk via bundletool,
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
import { failCrashedJob } from '../orchestration/jobCrash.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';
import { runWithSignal } from '../lib/abortScope.js';
import { adbDevices, deviceAbis } from '../lib/android.js';
import {
  DEVICE_PIN_ENV,
  devicePinConflict,
  isSimulatorUdid,
  operatorDevicePin,
  pinFixStep,
  resolveDevice,
  verifiedEmulatorSerials,
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
        // Refuse a missing path up front instead of starting a job that can only fail.
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
      // The device the APK set is built for / installed on follows the same rule as
      // qa_prepare_target: SWIPIUM_DEVICE refuses any other device before consent, and with no
      // device the session's own emulator (else the pinned one, else the only one online) is used.
      // bundletool always gets --device-id, never "whatever adb device is attached", and a
      // physical phone is refused before consent (Swipium never targets physical devices).
      let deviceId: string | undefined;
      if (connectedDevice) {
        const resolved = await resolveApkSetDevice(session, device);
        if ('error' in resolved) return resolved.error;
        deviceId = resolved.deviceId;
      }
      let mutationConsent: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string } | undefined;
      if (connectedDevice && install) {
        const affects = { aab: aabPath, device: deviceId ?? null };
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
            exactCommand: `bundletool build-apks --connected-device --device-id ${deviceId} --bundle ${aabPath} && bundletool install-apks --apks <set> --device-id ${deviceId}`,
            affects,
            explain: `Build a device-specific APK set from ${aabPath} and INSTALL it on ${deviceId}? It pushes app code to the device.`,
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
        ).catch((e: unknown) => failCrashedJob(sessions, session, job, 'bundletool device APK set', e));
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
      void runWithSignal(sessions.abortSignal(session, job.jobId), () => runConvert(sessions, session, job, aabPath, !!force)).catch(
        (e: unknown) => failCrashedJob(sessions, session, job, 'bundletool conversion', e),
      );
      return qaOk(
        { jobId: job.jobId, status: 'running', kind: job.kind, aab: aabPath, mode: 'universal', bundletool: launcher.describe },
        `Converting ${aabPath} > universal APK as job ${job.jobId} (${launcher.describe}). Poll qa_job_status.`,
      );
    },
  );
}

/** The one device a connected-device APK set targets (shared resolver: explicit serial, else the
 *  session's device, else the SWIPIUM_DEVICE pin, else the only online device), or the typed
 *  refusal. Physical devices are refused. Exported for tests. */
export async function resolveApkSetDevice(
  session: Session,
  device: string | undefined,
): Promise<{ deviceId: string } | { error: ReturnType<typeof qaError> }> {
  const online = await adbDevices();
  const pinConflict = await devicePinConflict(device, online);
  if (pinConflict)
    return {
      error: qaError({
        what: pinConflict,
        changedState: false,
        retrySafe: false,
        failureCode: 'DEVICE_PINNED',
        nextSteps: ['Re-call without device: the pinned device is used.'],
      }),
    };
  // An iOS simulator bound to the session is not a bundletool target: only an explicit serial is.
  const iosSession = !!session.device && isSimulatorUdid(session.device);
  const res = iosSession && !device ? undefined : await resolveDevice(session, device);
  const deviceId = res?.effective;
  if (!deviceId) {
    const pin = operatorDevicePin();
    const why =
      iosSession && !device
        ? `This session is bound to iOS simulator ${session.device}; an APK set needs an Android emulator.`
        : device
          ? `Android device ${device} is not online.`
          : res?.needSelection
            ? `Several Android devices are online (${res.available.join(', ')}) and this session has none, so none was picked.`
            : session.device
              ? `This session's device ${session.device} is not online; no other device was used.`
              : pin
                ? `${DEVICE_PIN_ENV}=${pin} (server env) matches no online Android device, so no other device was used.`
                : 'No Android emulator is online.';
    return {
      error: qaError({
        what: why,
        changedState: false,
        retrySafe: true,
        failureCode: res?.needSelection ? 'MULTIPLE_DEVICES' : 'NO_DEVICE',
        nextSteps: [
          res?.needSelection
            ? 'Pass device="<emulator serial>" to choose one.'
            : 'Boot an emulator (qa_prepare_target { bindOnly:true }) or pass device="<emulator serial>", then retry.',
          ...(pin ? [pinFixStep()] : []),
        ],
      }),
    };
  }
  if (!(await verifiedEmulatorSerials([deviceId])).includes(deviceId))
    return {
      error: qaFail('PHYSICAL_DEVICE_UNSUPPORTED', {
        what: `${deviceId} is not an Android emulator. Swipium never builds for or installs on physical devices (docs/physical-devices.md).`,
        nextSteps: [
          'Boot an emulator (qa_prepare_target { bindOnly:true }) and pass its serial as device=, or omit connectedDevice for a universal APK.',
        ],
      }),
    };
  return { deviceId };
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
    const abi = opts.deviceId ? (await deviceAbis(opts.deviceId))[0] : undefined;
    const result = await buildAndInstallApkSet(aabPath, session.root, {
      deviceId: opts.deviceId,
      abi,
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
