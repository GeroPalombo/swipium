// qa_job_status / qa_job_cancel: poll (or long-poll with waitMs) or cancel a background job.
// Lets a client reconnect after a tool-call timeout instead of restarting the work.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { progressLine } from '../session/progress.js';
import type { SessionStore } from '../session/store.js';

/** Upper bound for qa_job_status waitMs. Keeps one call well under typical client tool timeouts. */
export const MAX_JOB_WAIT_MS = 120_000;
const JOB_POLL_INTERVAL_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

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
          .describe(`Block up to this many ms for the job to finish (capped at ${MAX_JOB_WAIT_MS}). Default 0 = return immediately.`),
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
      while (budget > 0 && job.status === 'running' && Date.now() - started < budget && !extra?.signal?.aborted) {
        await sleep(Math.min(JOB_POLL_INTERVAL_MS, budget - (Date.now() - started)));
        job = session.jobs.get(jobId) ?? job;
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
