// qa_bundletool (hardening P0.2) — convert an .aab to an installable universal .apk via bundletool,
// cached under .swipium/artifacts/. Runs as a job (conversion can take a minute). Returns a typed
// AAB_NEEDS_BUNDLETOOL / AAB_BUILD_APKS_FAILED blocker when it cannot, never a generic error.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { qaFail } from '../oracle/failures.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { resolveArtifact } from '../artifacts/resolve.js';
import { convertAabToApk, findBundletool, buildAndInstallApkSet } from '../artifacts/bundletool.js';
import { startProgress } from '../session/progress.js';
import { log } from '../lib/logger.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';

export function registerBundletool(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_bundletool',
    {
      title: 'Convert .aab → installable .apk',
      description:
        'Convert an Android App Bundle (.aab) into an installable APK set using bundletool, cached under .swipium/artifacts/. An .aab is NOT directly installable — this is the conversion step before qa_prepare_target. Default mode builds a UNIVERSAL .apk (works on any device). Pass connectedDevice:true to build a DEVICE-SPECIFIC APK set (--connected-device) and install:true to push it via bundletool install-apks. Uses the debug keystore by default (emulator/dev OK). Returns typed blockers (BUNDLETOOL_MISSING/AAB_NEEDS_BUNDLETOOL, AAB_BUILD_APKS_FAILED, AAB_DEVICE_SPEC_FAILED, AAB_INSTALL_FAILED, ANDROID_SIGNING_FAILED). Runs as a job; poll qa_job_status.',
      inputSchema: {
        sessionId: z.string(),
        aab: z.string().optional().describe('Path to the .aab (default: the best .aab resolved under the project).'),
        force: z.boolean().optional().describe('Rebuild even if a cached APK/APK set exists.'),
        connectedDevice: z.boolean().optional().describe('Build a device-specific APK set for a connected device (bundletool --connected-device) instead of a universal APK.'),
        install: z.boolean().optional().describe('With connectedDevice, also install the APK set on the device (bundletool install-apks). Requires an online adb device. Consent-gated (installs app code on a real device/emulator).'),
        deviceId: z.string().optional().describe('adb serial to target for connectedDevice build/install (defaults to the only connected device).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, aab, force, connectedDevice, install, deviceId, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return qaError({ what: `Unknown sessionId "${sessionId}"`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });

      // Resolve the .aab if not given.
      let aabPath = aab;
      if (!aabPath) {
        const r = await resolveArtifact({ projectRoot: session.root, platform: 'android' }, false);
        const found = [r.best, ...r.candidates].find((c) => c?.type === 'aab');
        if (!found) return qaFail('NO_BUILD_ARTIFACT', { what: 'No .aab found to convert', nextSteps: ['Pass aab=, or build an APK directly with qa_build.'] });
        aabPath = found.path;
      }

      // Installing an APK set runs app code on a real device/emulator → consent-gated (build-only
      // is safe and ungated). Confirm intent BEFORE any work, regardless of whether bundletool is
      // installed. Mirrors qa_prepare_target / qa_prepare_ios_real_target.
      let mutationConsent: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string } | undefined;
      if (connectedDevice && install) {
        const affects = { aab: aabPath, device: deviceId ?? '(only connected device)' };
        const gate = consumeConsent(consentId, approve, { action: 'install_app', affects });
        if (!gate.approved) {
          sessions.recordMutation(session, { tool: 'qa_bundletool', action: 'install_app', risk: 'medium', target: affects, consent: { required: true, approved: false }, status: 'requested' });
          return requireConsent({
            action: 'install_app', risk: 'medium',
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
          what: `bundletool is not installed — cannot convert ${aabPath}`,
          nextSteps: [
            'Install bundletool (brew install bundletool) or set $BUNDLETOOL_JAR to bundletool.jar.',
            'Or build an APK directly: qa_build { platform: "android", variant: "debug" }  (./gradlew assembleDebug).',
          ],
          extra: { aab: aabPath },
        });
      }

      const job = sessions.createJob(session, 'bundletool:convert');
      if (connectedDevice) {
        void runDeviceApkSet(sessions, session, job, aabPath, { install: !!install, deviceId, force: !!force, mutationConsent });
        return qaOk({ jobId: job.jobId, status: 'running', kind: job.kind, aab: aabPath, mode: 'connected-device', install: !!install, bundletool: launcher.describe }, `Building${install ? ' + installing' : ''} a device-specific APK set from ${aabPath} as job ${job.jobId} (${launcher.describe}). Poll qa_job_status.`);
      }
      void runConvert(sessions, session, job, aabPath, !!force);
      return qaOk({ jobId: job.jobId, status: 'running', kind: job.kind, aab: aabPath, mode: 'universal', bundletool: launcher.describe }, `Converting ${aabPath} → universal APK as job ${job.jobId} (${launcher.describe}). Poll qa_job_status.`);
    },
  );
}

async function runDeviceApkSet(sessions: SessionStore, session: Session, job: JobRecord, aabPath: string, opts: { install: boolean; deviceId?: string; force: boolean; mutationConsent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string } }): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const prog = startProgress(sessions, session, job, 'building_apk_set', { statusText: 'Building a device-specific APK set with bundletool --connected-device.', nextExpected: opts.install ? 'Install the APK set on the device.' : 'Cache the APK set.' });
  try {
    const result = await buildAndInstallApkSet(aabPath, session.root, { deviceId: opts.deviceId, install: opts.install, signal, force: opts.force });
    if (signal?.aborted) return;
    const logUri = result.logText ? sessions.saveArtifact(session, 'logs', `bundletool-apks-${job.jobId}.log`, result.logText, 'text/plain', 'bundletool device APK set log') : undefined;
    if (!result.ok) {
      if (opts.install) {
        sessions.recordMutation(session, { tool: 'qa_bundletool', action: 'install_app', risk: 'medium', target: { aab: aabPath, device: opts.deviceId ?? null, apksPath: result.apksPath ?? null }, consent: opts.mutationConsent ?? { required: true, approved: true }, status: 'blocked', detail: `${result.failureCode}: ${result.error}` });
      }
      upd({ status: 'failed', error: `${result.failureCode}: ${result.error}`, result: { failureCode: result.failureCode, apksPath: result.apksPath ?? null, command: result.buildCommand ?? null, logUri, aab: aabPath }, resultText: `❌ ${result.failureCode}: ${result.error}`, endedAt: Date.now() });
      return;
    }
    if (result.installed) {
      sessions.addEnvChange(session, `installed APK set from ${aabPath} on ${opts.deviceId ?? 'connected device'}`);
      sessions.recordMutation(session, { tool: 'qa_bundletool', action: 'install_app', risk: 'medium', target: { aab: aabPath, device: opts.deviceId ?? null, apksPath: result.apksPath ?? null }, consent: opts.mutationConsent ?? { required: true, approved: true }, status: 'executed' });
    }
    prog.done(result.installed ? 'Device APK set built + installed.' : 'Device APK set built.');
    sessions.addWorkaround(session, `built device-specific APK set via bundletool${result.installed ? ' + installed' : ''}`);
    upd({
      status: 'done', progress: 'done',
      result: { converted: true, mode: 'connected-device', installed: !!result.installed, originalArtifact: aabPath, apksPath: result.apksPath ?? null, buildCommand: result.buildCommand ?? null, installCommand: result.installCommand ?? null, logUri },
      resultText: result.installed
        ? `✅ Device-specific APK set installed from ${aabPath}. The app is on the device; continue with qa_prepare_target { bindOnly: true } or qa_smoke.`
        : `✅ Device-specific APK set: ${result.apksPath}. Install it with qa_bundletool { connectedDevice: true, install: true } or bundletool install-apks.`,
      endedAt: Date.now(),
    });
  } catch (e) {
    if (signal?.aborted) return;
    log('error', 'bundletool device APK set job failed', { jobId: job.jobId, err: String(e) });
    upd({ status: 'failed', error: String(e), result: { failureCode: 'AAB_DEVICE_SPEC_FAILED' }, resultText: `❌ bundletool error: ${String(e)}`, endedAt: Date.now() });
  }
}

async function runConvert(sessions: SessionStore, session: Session, job: JobRecord, aabPath: string, force: boolean): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const prog = startProgress(sessions, session, job, 'converting_aab', { statusText: 'Building a universal APK from the .aab with bundletool.', nextExpected: 'Extract universal.apk and cache it.' });
  try {
    const result = await convertAabToApk(aabPath, session.root, { signal, force });
    if (signal?.aborted) return;
    if (!result.ok) {
      const logUri = result.error ? sessions.saveArtifact(session, 'logs', `bundletool-${Date.now()}.log`, `${result.command ?? ''}\n${result.error}`, 'text/plain', 'bundletool conversion log') : undefined;
      upd({ status: 'failed', error: `${result.failureCode}: ${result.error}`, result: { failureCode: result.failureCode, command: result.command, logUri, aab: aabPath }, resultText: `❌ ${result.failureCode}: ${result.error}`, endedAt: Date.now() });
      return;
    }
    prog.done('Universal APK ready.');
    sessions.addWorkaround(session, `converted .aab → universal .apk via bundletool (${result.fromCache ? 'cached' : 'built'})`);
    upd({
      status: 'done', progress: 'done',
      result: { converted: true, fromCache: !!result.fromCache, originalArtifact: aabPath, generatedApk: result.apkPath, apksPath: result.apksPath ?? null, command: result.command ?? null },
      resultText: `✅ ${result.fromCache ? 'Using cached' : 'Built'} universal APK: ${result.apkPath}. Next: qa_prepare_target { apk: "${result.apkPath}" }.`,
      endedAt: Date.now(),
    });
  } catch (e) {
    if (signal?.aborted) return;
    log('error', 'bundletool job failed', { jobId: job.jobId, err: String(e) });
    upd({ status: 'failed', error: String(e), result: { failureCode: 'AAB_BUILD_APKS_FAILED' }, resultText: `❌ bundletool error: ${String(e)}`, endedAt: Date.now() });
  }
}
