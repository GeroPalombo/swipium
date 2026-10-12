// qa_job_status / qa_job_cancel: poll (or long-poll with waitMs) or cancel a background job.
// Lets a client reconnect after a tool-call timeout instead of restarting the work.

import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { cancelledResult, qaAnnotate, qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { currentSignal, isAbortError, sleepOrCancel } from '../lib/abortScope.js';
import { progressLine } from '../session/progress.js';
import { jobProgressReporter } from '../lib/progressNotify.js';
import type { SessionStore } from '../session/store.js';

/** Default upper bound for qa_job_status waitMs (and the qa_test_this waitForCompletion window).
 *  One long-poll must end before the client's tool timeout (Codex defaults to 60 s, others are
 *  similar), so the default is 50 s for every client rather than a per-client clamp keyed on
 *  clientInfo.name. Larger values are clamped, not rejected, so callers still sending the old
 *  recommended 60000 keep working. SWIPIUM_MAX_WAIT_MS overrides it (maxWaitMs). */
export const MAX_JOB_WAIT_MS = 50_000;
/** SWIPIUM_MAX_WAIT_MS is clamped to this range. */
export const MAX_WAIT_FLOOR_MS = 1_000;
export const MAX_WAIT_CEILING_MS = 230_000;

/** The effective wait cap: SWIPIUM_MAX_WAIT_MS (clamped to 1000..230000) when it is a number, else
 *  MAX_JOB_WAIT_MS. Set it to just under the client's tool timeout (`swipium init` writes it for
 *  clients with longer timeouts). Read per call. */
export function maxWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SWIPIUM_MAX_WAIT_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return MAX_JOB_WAIT_MS;
  return Math.min(MAX_WAIT_CEILING_MS, Math.max(MAX_WAIT_FLOOR_MS, Math.round(n)));
}
/** Startup warning for an unusable SWIPIUM_MAX_WAIT_MS (not a number, or outside 1000..230000),
 *  else undefined. A bad value is never silent: server.ts logs it once on stderr. */
export function maxWaitSettingWarning(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.SWIPIUM_MAX_WAIT_MS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return `SWIPIUM_MAX_WAIT_MS=${JSON.stringify(raw)} is not a number; using the default ${MAX_JOB_WAIT_MS} ms`;
  const used = maxWaitMs(env);
  return used !== Math.round(n)
    ? `SWIPIUM_MAX_WAIT_MS=${raw} is outside ${MAX_WAIT_FLOOR_MS}..${MAX_WAIT_CEILING_MS}; using ${used} ms`
    : undefined;
}
/** When the current tool call started, for waits that must count the call's earlier work
 *  (resolution, scan, planning) against the SWIPIUM_MAX_WAIT_MS cap (qa_test_this waitForCompletion). */
const waitBudgetStart = new AsyncLocalStorage<number>();
export function runWithWaitBudget<T>(fn: () => T, startedAt: number = Date.now()): T {
  return waitBudgetStart.run(startedAt, fn);
}
/** Milliseconds this call has already spent (0 outside runWithWaitBudget). */
export function waitBudgetUsedMs(): number {
  const s = waitBudgetStart.getStore();
  return s === undefined ? 0 : Math.max(0, Date.now() - s);
}
/** The waitMs the instructions and nextSteps recommend: under MAX_JOB_WAIT_MS with headroom. */
export const RECOMMENDED_JOB_WAIT_MS = 45_000;
/** The effective cap minus the same 5 s headroom (45000 by default): the default qa_test_this
 *  waitForCompletion window. */
export function defaultWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(MAX_WAIT_FLOOR_MS, maxWaitMs(env) - 5_000);
}
const JOB_POLL_INTERVAL_MS = 500;

export function registerJobs(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_job_status',
    {
      title: 'Job status (optionally wait)',
      description:
        'Poll or wait on a background job (qa_test_this, qa_prepare_target, qa_explore, qa_build run, ...): status, progressDetail, ' +
        'and result/error when finished (qa_test_this: state completed/blocked/unsafe/needs_input, reportUri, suite, smoke, health). ' +
        'waitMs long-polls until the job leaves "running" (else waited.timedOut:true).',
      inputSchema: {
        sessionId: z.string(),
        jobId: z.string(),
        waitMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            `Block up to this many ms for the job to finish (use ${RECOMMENDED_JOB_WAIT_MS}; capped at SWIPIUM_MAX_WAIT_MS, default ${MAX_JOB_WAIT_MS}). Default 0 = return immediately.`,
          ),
      },
    },
    async ({ sessionId, jobId, waitMs }, ctx) => {
      const session = sessions.get(sessionId);
      let job = session?.jobs.get(jobId);
      if (!session) return unknownSessionError(sessionId);
      if (!job) {
        return qaError({
          what: `Unknown job ${jobId}`,
          failureCode: 'INVALID_ARGUMENT',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Use the sessionId + jobId returned by the tool that started the job (qa_status lists the last job).'],
        });
      }
      const cap = maxWaitMs();
      const budget = Math.min(Math.max(0, waitMs ?? 0), cap);
      // Over-large waitMs is clamped, never rejected, and the result says so (README troubleshooting).
      const clampNotes =
        (waitMs ?? 0) > cap
          ? [
              `waitMs ${waitMs} clamped to ${cap} (SWIPIUM_MAX_WAIT_MS): one call stays under client tool timeouts. Call again to keep waiting.`,
            ]
          : [];
      const started = Date.now();
      // Cancelling THIS poll (notifications/cancelled) ends the wait at once; the job keeps running.
      const signal = ctx?.mcpReq.signal ?? currentSignal();
      // notifications/progress while waiting, when the request sent a progressToken.
      const report = budget > 0 ? jobProgressReporter() : undefined;
      try {
        while (budget > 0 && job.status === 'running' && Date.now() - started < budget) {
          report?.(job);
          await sleepOrCancel(Math.min(JOB_POLL_INTERVAL_MS, budget - (Date.now() - started)), signal);
          job = session.jobs.get(jobId) ?? job;
        }
      } catch (e) {
        if (isAbortError(e, signal))
          return cancelledResult(`qa_job_status wait cancelled; job ${jobId} was not cancelled (qa_job_cancel does that)`);
        throw e;
      }
      const waited = budget > 0 ? { waitedMs: Date.now() - started, timedOut: job.status === 'running' } : undefined;
      const progLine = progressLine(job.progressDetail);
      const ok = qaOk(
        {
          jobId: job.jobId,
          kind: job.kind,
          status: job.status,
          progress: job.progress,
          progressDetail: job.progressDetail ?? null,
          error: job.error,
          result: job.result,
          artifactUris: job.artifactUris,
          ...(waited ? { waited } : {}),
        },
        `job ${job.jobId} [${job.kind}] = ${job.status}${progLine ? `\n  ${progLine}` : job.progress ? ` (${job.progress})` : ''}${job.resultText ? `\n${job.resultText}` : ''}${job.error ? `\nerror: ${job.error}` : ''}` +
          (waited?.timedOut ? `\nstill running after ${waited.waitedMs}ms, call again (waitMs) or qa_job_cancel.` : ''),
        // The job's resultText and the still-running hint are not payload fields: keep them all,
        // unless the result carries the inline report head (already a payload field): headline only.
        { structuredSummary: (job.result as { reportHead?: unknown } | undefined)?.reportHead ? 'headline' : 'full' },
      );
      return qaAnnotate(ok, clampNotes);
    },
  );

  server.registerTool(
    'qa_job_cancel',
    {
      title: 'Cancel a job',
      description:
        'Cancel a running background job and abort its child processes (build/boot/install/record). Returns {jobId, cancelled}; ' +
        'cancelled:false means it already finished or is unknown. Side effects already applied are not rolled back.',
      inputSchema: { sessionId: z.string(), jobId: z.string() },
    },
    async ({ sessionId, jobId }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const ok = sessions.cancelJob(session, jobId);
      return qaOk({ jobId, cancelled: ok }, ok ? `cancelled ${jobId}` : `job ${jobId} not running (already finished or unknown)`);
    },
  );
}
