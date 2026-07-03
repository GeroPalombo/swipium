// qa_wait — non-shell synchronization for setup conditions (Phase 2.1 P1.6), so agents
// don't shell out to `sleep`/poll. Waits for: device_online, metro_ready (serving), or
// a job_done. Returns timeout + current state + next steps.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { resolveDevice } from '../session/attach.js';
import { metroReadiness } from '../lib/metroState.js';
import type { SessionStore } from '../session/store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerWait(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_wait',
    {
      title: 'Wait for a setup condition',
      description:
        'Block (bounded) until a non-UI condition holds, instead of shelling out to sleep/poll: for="device_online" (a device appears), "metro_ready" (Metro serving the bundle), or "job_done" (a qa_prepare_target jobId finishes). Returns satisfied/timedOut + the current state + next steps.',
      inputSchema: {
        sessionId: z.string(),
        for: z.enum(['device_online', 'metro_ready', 'job_done']),
        jobId: z.string().optional().describe('Required for for="job_done".'),
        timeoutMs: z.number().optional().describe('default 60000 (180000 for device_online).'),
      },
    },
    async ({ sessionId, for: cond, jobId, timeoutMs }) => {
      const session = sessions.get(sessionId);
      if (!session)
        return qaError({
          what: `Unknown sessionId ${sessionId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session first.'],
        });
      const deadline = Date.now() + (timeoutMs ?? (cond === 'device_online' ? 180000 : 60000));
      const intervalMs = 1500;

      if (cond === 'job_done') {
        if (!jobId)
          return qaError({
            what: 'for="job_done" needs jobId',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Pass the jobId from qa_prepare_target.'],
          });
        while (Date.now() < deadline) {
          const job = session.jobs.get(jobId);
          if (!job) return qaError({ what: `Unknown job ${jobId}`, changedState: false, retrySafe: true, nextSteps: ['Check the jobId.'] });
          if (job.status !== 'running') {
            return qaOk(
              { satisfied: true, condition: cond, jobStatus: job.status, result: job.result, error: job.error },
              `job ${jobId} = ${job.status}${job.error ? `: ${job.error}` : ''}`,
            );
          }
          await sleep(intervalMs);
        }
        return qaError({
          what: `Timed out waiting for job ${jobId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Poll qa_job_status, or qa_job_cancel.'],
        });
      }

      while (Date.now() < deadline) {
        if (cond === 'device_online') {
          const dev = await resolveDevice(session);
          if (dev.available.length > 0)
            return qaOk(
              { satisfied: true, condition: cond, availableDevices: dev.available },
              `device online: ${dev.available.join(', ')}`,
            );
        } else {
          const dev = await resolveDevice(session);
          if (dev.effective) {
            const rd = await metroReadiness(dev.effective);
            if (rd.serving)
              return qaOk(
                { satisfied: true, condition: cond, metro: rd },
                `Metro serving=${rd.serving} reverse=${rd.reverseSet} ready=${rd.ready}`,
              );
          }
        }
        await sleep(intervalMs);
      }
      return qaOk(
        { satisfied: false, timedOut: true, condition: cond },
        `Timed out waiting for ${cond}. ${cond === 'device_online' ? 'Boot one with qa_prepare_target { bindOnly:true }.' : 'Start Metro with qa_metro action="start", or qa_metro diagnose.'}`,
      );
    },
  );
}
