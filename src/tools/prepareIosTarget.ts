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
  return !abs.startsWith(session.root);
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
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, app, bundleId, device, launch, attachWda, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);

      // Installing app code is privileged, so consent (mirrors qa_ios install).
      let mutationConsent: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string } | undefined;
      let installAffects: { appPath: string; sig: string; external: boolean } | undefined;
      if (app) {
        const abs = isAbsolute(app) ? app : join(session.root, app);
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
            exactCommand: `xcrun simctl install <booted> ${abs}`,
            affects,
            explain: `Boot a simulator and install ${abs}${affects.external ? ' (outside the project root)' : ''}? It runs third-party app code.`,
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

      const prepArgs: PrepareIosArgs = { app, bundleId, simulator: device, launch, attachWda, mutationConsent };
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
      return prepareResultToTool(sessions, session, res, installAffects, mutationConsent);
    },
  );
}

type InstallAffects = { appPath: string; sig: string; external: boolean } | undefined;

/** Map a finished prepareIos result to the tool result (also the job's result payload). */
function prepareResultToTool(
  sessions: SessionStore,
  session: Session,
  res: PrepareIosResult,
  installAffects: InstallAffects,
  mutationConsent: PrepareIosArgs['mutationConsent'],
): CallToolResult {
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
      extra: { udid: res.udid ?? null, name: res.name ?? null },
    });
  }
  return qaOk(
    {
      udid: res.udid,
      name: res.name,
      bundleId: res.bundleId ?? null,
      installed: res.installed,
      launched: res.launched,
      mode: res.mode,
      wda: res.wda ?? null,
    },
    res.resultText ?? 'iOS target prepared.',
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
  const out = prepareResultToTool(sessions, session, res, installAffects, args.mutationConsent);
  const result = (out.structuredContent ?? {}) as Record<string, unknown>;
  const resultText = (out.content?.[0] as { text?: string } | undefined)?.text ?? res.resultText;
  if (!res.ok) {
    upd({
      status: 'failed',
      error: `${res.failureCode ?? 'APP_LAUNCH_FAILED'}: ${res.error ?? 'iOS prepare failed'}`,
      result,
      resultText,
      endedAt: Date.now(),
    });
    return;
  }
  upd({ status: 'done', progress: 'done', result, resultText, endedAt: Date.now() });
}
