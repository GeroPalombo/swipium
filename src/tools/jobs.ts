// qa_job_status — poll a long-running job (boot/install).
// Lets a client reconnect after a tool-call timeout instead of restarting the work.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { progressLine } from '../session/progress.js';
import type { SessionStore } from '../session/store.js';

export function registerJobs(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_job_status',
    {
      title: 'Job status',
      description: 'Status of a long-running job (e.g. from qa_prepare_target / qa_test_this execute): running/done/failed/cancelled, the structured progressDetail (phase/elapsed/statusText/nextExpected/logUri/userActionRequired), and the result/error when finished. For a qa_test_this execute job the result carries the terminal state (completed/blocked/unsafe), reportUri, suite, smoke, and health.',
      inputSchema: { sessionId: z.string(), jobId: z.string() },
    },
    async ({ sessionId, jobId }) => {
      const job = sessions.get(sessionId)?.jobs.get(jobId);
      if (!job) {
        return qaError({ what: `Unknown job ${jobId}`, changedState: false, retrySafe: true, nextSteps: ['Check the jobId returned by qa_prepare_target.'] });
      }
      const progLine = progressLine(job.progressDetail);
      return qaOk(
        { jobId: job.jobId, kind: job.kind, status: job.status, progress: job.progress, progressDetail: job.progressDetail ?? null, error: job.error, result: job.result, artifactUris: job.artifactUris },
        `job ${job.jobId} [${job.kind}] = ${job.status}${progLine ? `\n  ${progLine}` : job.progress ? ` (${job.progress})` : ''}${job.resultText ? `\n${job.resultText}` : ''}${job.error ? `\nerror: ${job.error}` : ''}`,
      );
    },
  );

}
