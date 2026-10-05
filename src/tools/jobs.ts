// qa_job_status / qa_job_cancel: poll (or long-poll with waitMs) or cancel a background job.
// Lets a client reconnect after a tool-call timeout instead of restarting the work.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { cancelledResult, qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { currentSignal, isAbortError, sleepOrCancel } from '../lib/abortScope.js';
import { progressLine } from '../session/progress.js';
import type { SessionStore } from '../session/store.js';

/** Upper bound for qa_job_status waitMs. One long-poll must end before the client's tool timeout
 *  (Codex defaults to 60 s, others are similar), so this is a hard 50 s for every client rather
 *  than a per-client clamp keyed on clientInfo.name. Larger values are clamped, not rejected, so
 *  callers still sending the old recommended 60000 keep working. */
export const MAX_JOB_WAIT_MS = 50_000;
/** The waitMs the instructions and nextSteps recommend: under MAX_JOB_WAIT_MS with headroom. */
export const RECOMMENDED_JOB_WAIT_MS = 45_000;
const JOB_POLL_INTERVAL_MS = 500;

export function registerJobs(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_job_status',
    {
      title: 'Job status (optionally wait)',
      description:
        'Status of a background job (qa_test_this, qa_prepare_target, qa_explore, qa_build run, …): status ' +
        '(running/done/failed/cancelled), progressDetail, and result/error when finished (for qa_test_this: state completed/blocked/unsafe/needs_input, ' +
        'reportUri, suite, smoke, health). waitMs long-polls: returns once the job leaves "running", or with ' +
        'waited.timedOut:true.',
      inputSchema: {
        sessionId: z.string(),
        jobId: z.string(),
        waitMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            `Block up to this many ms for the job to finish (use ${RECOMMENDED_JOB_WAIT_MS}; capped at ${MAX_JOB_WAIT_MS}). Default 0 = return immediately.`,
          ),
      },
    },
    async ({ sessionId, jobId, waitMs }, extra) => {
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
      const budget = Math.min(Math.max(0, waitMs ?? 0), MAX_JOB_WAIT_MS);
      const started = Date.now();
      // Cancelling THIS poll (notifications/cancelled) ends the wait at once; the job keeps running.
      const signal = extra?.signal ?? currentSignal();
      try {
        while (budget > 0 && job.status === 'running' && Date.now() - started < budget) {
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
      return qaOk(
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
        // The job's resultText and the still-running hint are not payload fields: keep them all.
        { structuredSummary: 'full' },
      );
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
