// qa_prepare_ios_target (hardening P0.3): one high-level iOS prepare: boot simulator > install
// .app > launch bundle > verify > report WDA/visual mode. The cross-platform counterpart to
// qa_prepare_target's Android path, so qa_test_this can complete iOS first-runs end-to-end.

import { z } from 'zod';
import { isAbsolute, join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { cancelledResult, qaOk, unknownSessionError } from '../lib/result.js';
import { isAbortError, runWithSignal } from '../lib/abortScope.js';
import { qaFail, type FailureCode } from '../oracle/failures.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { prepareIos, type PrepareIosArgs, type PrepareIosResult } from '../services/prepareIos.js';
import type { JobRecord, Session, SessionStore } from '../session/store.js';
import {
  devicePinConflict,
  isSimulatorUdid,
  operatorDevicePin,
  pinAmbiguousMessage,
  pinFixStep,
  pinNoSimulatorMessage,
  simulatorsForPin,
} from '../session/attach.js';
import { listSimulators } from '../lib/simctl.js';
import { appBuildDestination } from '../ios/signing.js';
import { isOutsideRoot, resolveArtifact } from '../artifacts/resolve.js';
import { waitForAppRender } from '../snapshot/renderWait.js';
import { isMetroRequiredFinding, type Finding } from '../oracle/health.js';
import { checkLaunchErrorSurface, launchErrorText } from '../oracle/record.js';

/** How long one qa_prepare_ios_target call waits for a simulator boot. Lower than qa_ios boot's
 *  wait because install/launch/WDA still run in the same call after a boot that made it in time.
 *  A boot still running after this hands the rest to a background job (status:"booting"). */
export const PREPARE_IOS_BOOT_CALL_WAIT_MS = 30_000;

/** A .app is a directory, so hash a stable signature (Info.plist) for consent binding. */
function appSignature(appPath: string): string {
  try {
    const plist = join(appPath, 'Info.plist');
    if (existsSync(plist)) return createHash('sha256').update(readFileSync(plist)).digest('hex').slice(0, 16);
    return createHash('sha256')
      .update(`${appPath}:${statSync(appPath).mtimeMs}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return 'unknown';
  }
}

function externalToRoot(session: Session, appPath: string): boolean {
  const abs = isAbsolute(appPath) ? appPath : join(session.root, appPath);
  // CR P7: a sibling folder (`/work/app-other` next to root `/work/app`) is outside the root.
  return isOutsideRoot(abs, session.root);
}

export function registerPrepareIosTarget(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_prepare_ios_target',
    {
      title: 'Prepare an iOS simulator target',
      description:
        'Prepare an iOS Simulator: boot, install a simulator .app (consent-gated), launch, verify, and report whether WDA ' +
        'structured automation or visual-only mode is available. .ipa files are refused.',
      inputSchema: {
        sessionId: z.string(),
        app: z.string().optional().describe('Simulator .app path (absolute or project-relative).'),
        bundleId: z.string().optional(),
        device: z.string().optional().describe('Simulator UDID or name substring.'),
        launch: z.boolean().optional(),
        attachWda: z
          .enum(['auto', 'required', 'skip'])
          .optional()
          .describe('auto (default): attach WDA if reachable, else visual-only; required: fail if it cannot attach; skip: visual-only.'),
        allowLaunchWithoutMetro: z
          .boolean()
          .optional()
          .describe('Launch a debug RN/Expo .app (no embedded main.jsbundle) without a serving Metro (it will RedBox).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, app, bundleId, device, launch, attachWda, allowLaunchWithoutMetro, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      // No app / bundleId (none on the session either): use the project's own simulator .app, as
      // qa_prepare_target does with the project's APK (GOAL-27). The install below is still consent-gated.
      if (!app && !bundleId && !session.appId) {
        const art = await resolveArtifact(
          { projectRoot: session.root, platform: 'ios', requireInstallableOn: 'ios-simulator' },
          false,
        ).catch(() => null);
        const best = art?.best;
        if (best && !best.outsideRoot && best.installableOn.includes('ios-simulator')) app = best.path;
      }

      // Installing app code is privileged, so consent (mirrors qa_ios install).
      let mutationConsent: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string } | undefined;
      let installAffects: { appPath: string; sig: string; external: boolean } | undefined;
      if (app) {
        const abs = isAbsolute(app) ? app : join(session.root, app);
        // Validate the artifact BEFORE asking for consent: never ask to approve an install that cannot run.
        if (/\.ipa$/i.test(abs))
          return qaFail('IPA_NEEDS_REAL_DEVICE', {
            what: `${abs} is an .ipa; the simulator needs a simulator-SDK .app.`,
            nextSteps: ['Build for the simulator (xcodebuild -sdk iphonesimulator) and pass that .app.'],
          });
        // An explicit path that does not exist is the caller's input error, not something Swipium fixes.
        if (!existsSync(abs))
          return qaFail('IOS_SIMULATOR_APP_MISSING', {
            what: `.app not found: ${abs}`,
            nextSteps: ['Check the app path, or omit app to use the installed bundle (bundleId).'],
            extra: { owner: 'user', canSwipiumFix: false },
          });
        if (appBuildDestination(abs) === 'device')
          return qaFail('IOS_APP_WRONG_ARCH', {
            what: `${abs} is a device build (iphoneos). The simulator needs a simulator-SDK .app (iphonesimulator).`,
            nextSteps: ['Build for the simulator (xcodebuild -sdk iphonesimulator) and pass that .app.'],
          });
        // Name the simulator the install will target (explicit device > the session's simulator > operator pin).
        const sessionSim = isSimulatorUdid(session.device) ? session.device : undefined;
        const targetSim = device ?? sessionSim ?? operatorDevicePin();
        // E2E NEW-5: check the pin BEFORE asking consent: never ask to install on a device that the
        // pin can't reach, or that isn't the pinned one.
        const pin = operatorDevicePin();
        if (pin && !sessionSim) {
          const sims = await listSimulators().catch(() => undefined);
          if (sims) {
            const conflict = device ? await devicePinConflict(device, [], sims) : undefined;
            if (conflict)
              return qaFail('DEVICE_PINNED', { what: conflict, nextSteps: ['Omit device to use the pinned simulator.', pinFixStep()] });
            // Same resolver as prepare and qa_test_this: none > NO_DEVICE, several > MULTIPLE_DEVICES.
            const pinned = device ? [] : simulatorsForPin(pin, sims);
            if (!device && !pinned.length) return qaFail('NO_DEVICE', { what: pinNoSimulatorMessage(pin), nextSteps: [pinFixStep()] });
            if (pinned.length > 1) return qaFail('MULTIPLE_DEVICES', { what: pinAmbiguousMessage(pin, pinned), nextSteps: [pinFixStep()] });
          }
        }
        const sig = appSignature(abs);
        const affects = { appPath: abs, sig, external: externalToRoot(session, app) };
        installAffects = affects;
        const gate = consumeConsent(consentId, approve, { action: 'install_app', affects });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_prepare_ios_target',
            action: 'install_app',
            risk: affects.external ? 'medium' : 'low',
            target: affects,
            consent: { required: true, approved: false, payloadHash: sig },
            status: 'requested',
          });
          return requireConsent({
            action: 'install_app',
            risk: affects.external ? 'medium' : 'low',
            exactCommand: `xcrun simctl install ${targetSim ?? '<booted simulator>'} ${abs}`,
            affects,
            explain: `Install ${abs}${affects.external ? ' (outside the project root)' : ''} on ${targetSim ? `simulator ${targetSim}` : 'the booted (or first available) simulator'}, booting it if needed? It runs third-party app code.`,
          });
        }
        mutationConsent = { required: true, consentId, approved: true, payloadHash: sig };
        sessions.recordMutation(session, {
          tool: 'qa_prepare_ios_target',
          action: 'install_app',
          risk: affects.external ? 'medium' : 'low',
          target: affects,
          consent: mutationConsent,
          status: 'approved',
        });
      }

      const prepArgs: PrepareIosArgs = { app, bundleId, simulator: device, launch, attachWda, mutationConsent, allowLaunchWithoutMetro };
      let res: PrepareIosResult;
      try {
        // Bounded boot wait: a cold boot that is still running hands the rest to a background job.
        res = await prepareIos(sessions, session, { ...prepArgs, bootWaitMs: PREPARE_IOS_BOOT_CALL_WAIT_MS }, { onProgress: () => {} });
      } catch (e) {
        if (isAbortError(e))
          return cancelledResult('qa_prepare_ios_target cancelled while the simulator was booting; it keeps booting', true);
        throw e;
      }
      if (res.ok && res.booting) {
        const job = sessions.createJob(session, 'prepare_ios');
        const rest: PrepareIosArgs = { ...prepArgs, simulator: res.udid };
        void runWithSignal(sessions.abortSignal(session, job.jobId), () => runPrepareIosJob(sessions, session, job, rest, installAffects));
        return qaOk(
          {
            status: 'booting',
            udid: res.udid,
            name: res.name,
            bound: true,
            elapsedMs: res.bootElapsedMs ?? null,
            jobId: job.jobId,
            kind: job.kind,
            next: `qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}", waitMs:45000 }`,
          },
          `${res.name} is still booting after ${Math.round((res.bootElapsedMs ?? 0) / 1000)} s (cold boot); bound to the session. ` +
            `Boot > install > launch > WDA check continue as job ${job.jobId}.\n` +
            `Next: qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}", waitMs:45000 } (repeat while running).`,
        );
      }
      await settleVisualOnlyLaunch(session, res);
      const screen = await launchErrorCheck(sessions, session, res);
      return prepareResultToTool(sessions, session, res, installAffects, mutationConsent, screen);
    },
  );
}

type LaunchScreen = { appError?: Finding; alert?: string };
type InstallAffects = { appPath: string; sig: string; external: boolean } | undefined;

/** E2E NEW-19: a visual-only launch used to answer "ready" during the iOS app-open animation, so a
 *  qa_screenshot right after it showed a blank card. Wait (bounded, ~1-4 s) for two identical frames,
 *  as qa_smoke's render wait does. No verdict either way; cancellation still propagates. */
async function settleVisualOnlyLaunch(session: Session, res: PrepareIosResult): Promise<void> {
  if (!res.ok || res.booting || !res.launched || res.mode !== 'visual-fallback' || !session.driver) return;
  try {
    await waitForAppRender(session.driver, { visualOnly: true, timeoutMs: 4000 });
  } catch (e) {
    if (isAbortError(e)) throw e;
  }
}

/** E2E NEW-17: a structured launch is checked once (one WDA source, ~0.3 s) for a RedBox / the
 *  Expo dev launcher, so prepare never answers plain "ready" on one. Visual-only: no tree, skipped. */
async function launchErrorCheck(sessions: SessionStore, session: Session, res: PrepareIosResult): Promise<LaunchScreen> {
  if (!res.ok || res.booting || !res.launched || res.mode !== 'structured' || !session.driver) return {};
  return checkLaunchErrorSurface(sessions, session, session.driver);
}

/** Map a finished prepareIos result to the tool result (also the job's result payload). */
function prepareResultToTool(
  sessions: SessionStore,
  session: Session,
  res: PrepareIosResult,
  installAffects: InstallAffects,
  mutationConsent: PrepareIosArgs['mutationConsent'],
  screen: LaunchScreen = {},
): CallToolResult {
  const { appError, alert } = screen;
  if (!res.ok) {
    if (installAffects) {
      sessions.recordMutation(session, {
        tool: 'qa_prepare_ios_target',
        action: 'install_app',
        risk: installAffects.external ? 'medium' : 'low',
        target: installAffects,
        consent: mutationConsent,
        status: 'blocked',
        detail: res.error ?? res.failureCode ?? 'prepare failed',
      });
    }
    return qaFail((res.failureCode as FailureCode) ?? 'APP_LAUNCH_FAILED', {
      what: res.error ?? 'iOS prepare failed',
      ...(res.nextSteps?.length ? { nextSteps: res.nextSteps } : {}),
      extra: { udid: res.udid ?? null, name: res.name ?? null },
    });
  }
  const target = `iOS ${res.name}${res.bundleId ? ` / ${res.bundleId}` : ''}`;
  if (appError && isMetroRequiredFinding(appError))
    return qaFail('METRO_REQUIRED', {
      what: `${target} launched, but ${launchErrorText(appError)}: the debug build has no JS bundle, so it is not ready to test.`,
      changedState: true,
      nextSteps: [
        'Start Metro for this project (qa_metro { action:"start" }), wait until it is serving (qa_wait { for:"metro_ready" }), then re-run qa_prepare_ios_target.',
      ],
      extra: { udid: res.udid ?? null, name: res.name ?? null, launched: true, mode: res.mode, appError },
    });
  const errorLine = appError ? `launched, but ${launchErrorText(appError)}: recorded as an app finding, not ready to test.` : undefined;
  return qaOk(
    {
      udid: res.udid,
      name: res.name,
      bundleId: res.bundleId ?? null,
      installed: res.installed,
      launched: res.launched,
      mode: res.mode,
      wda: res.wda ?? null,
      ...(appError ? { ready: false, appError } : {}),
      ...(alert ? { alert } : {}),
    },
    (errorLine ? `${target}: ${errorLine}` : (res.resultText ?? 'iOS target prepared.')) +
      (alert ? `\n⚠ An iOS alert is on top of the app: "${alert}". Close it (qa_clear_overlay) before testing.` : ''),
  );
}

/** Background rest of qa_prepare_ios_target after the in-call boot wait ran out: full boot wait
 *  (joins the running boot) > install > launch > WDA check. Consent was consumed by the call.
 *  Exported for tests. */
export async function runPrepareIosJob(
  sessions: SessionStore,
  session: Session,
  job: JobRecord,
  args: PrepareIosArgs,
  installAffects?: InstallAffects,
): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  let res: PrepareIosResult;
  try {
    res = await prepareIos(sessions, session, args, { signal, onProgress: (p) => upd({ progress: p }) });
  } catch (e) {
    if (isAbortError(e, signal)) return; // cancelled: the job already says so
    upd({ status: 'failed', error: String(e), resultText: `iOS prepare failed: ${String(e)}`, endedAt: Date.now() });
    return;
  }
  if (signal?.aborted) return;
  await settleVisualOnlyLaunch(session, res);
  if (signal?.aborted) return;
  const screen = await launchErrorCheck(sessions, session, res).catch(() => ({})); // cancelled: checked below
  if (signal?.aborted) return;
  const out = prepareResultToTool(sessions, session, res, installAffects, args.mutationConsent, screen);
  const result = (out.structuredContent ?? {}) as Record<string, unknown>;
  const resultText = (out.content?.[0] as { text?: string } | undefined)?.text ?? res.resultText;
  if (out.isError) {
    upd({
      status: 'failed',
      error: res.ok
        ? `${String(result.failureCode)}: ${String(result.what)}`
        : `${res.failureCode ?? 'APP_LAUNCH_FAILED'}: ${res.error ?? 'iOS prepare failed'}`,
      result,
      resultText,
      endedAt: Date.now(),
    });
    return;
  }
  upd({ status: 'done', progress: 'done', result, resultText, endedAt: Date.now() });
}
