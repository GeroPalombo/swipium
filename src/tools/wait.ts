// qa_wait — non-shell synchronization for setup conditions, so agents don't shell out to
// `sleep`/poll. Waits for: device_online or metro_ready (serving). Jobs are waited on with
// qa_job_status waitMs. Returns timeout + current state + next steps.

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
        'Block (bounded) until a setup condition holds instead of shelling out to sleep: for="device_online" (a device appears) or ' +
        '"metro_ready" (Metro serving the bundle). Returns satisfied/timedOut + current state. To wait for a job, use qa_job_status waitMs.',
      inputSchema: {
        sessionId: z.string(),
        for: z.enum(['device_online', 'metro_ready']),
        timeoutMs: z.number().optional().describe('default 60000 (180000 for device_online).'),
      },
    },
    async ({ sessionId, for: cond, timeoutMs }) => {
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
