// qa_wait: non-shell synchronization for setup conditions, so agents don't shell out to
// `sleep`/poll. Waits for: device_online, metro_ready (serving) or wda_ready (WDA /status ready).
// Jobs are waited on with qa_job_status waitMs. Returns timeout + current state + next steps.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { cancelledResult, qaAnnotate, qaError, qaOk, unknownSessionError } from '../lib/result.js';
import { isAbortError, sleepOrCancel, throwIfCancelled } from '../lib/abortScope.js';
import { resolveDevice } from '../session/attach.js';
import { metroReadiness } from '../lib/metroState.js';
import { checkWda, isLoopbackWdaUrl, remoteWdaAllowedByUser, REMOTE_WDA_ENV, type WdaStatus } from '../lib/wda.js';
import { wdaUrlForSession } from './wda.js';
import type { SessionStore } from '../session/store.js';

/** Default wait. Kept under common client tool timeouts (Codex: 60 s); the model can call again. */
export const DEFAULT_WAIT_TIMEOUT_MS = 45_000;
/** Effective upper bound for timeoutMs, same reasoning: one call must not outlive the client's
 *  timeout. Larger values (older docs said 60000/180000) are accepted and CLAMPED, with a note. */
export const MAX_WAIT_TIMEOUT_MS = 50_000;
const POLL_INTERVAL_MS = 1500;

export function registerWait(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_wait',
    {
      title: 'Wait for a setup condition',
      description:
        'Bounded wait for a setup condition instead of shell sleep: device_online, metro_ready, or wda_ready (WDA /status ready, ' +
        'e.g. after qa_wda start returned status:"starting"). Returns satisfied, or timedOut:true (call again). For jobs use ' +
        'qa_job_status waitMs.',
      inputSchema: {
        sessionId: z.string(),
        for: z.enum(['device_online', 'metro_ready', 'wda_ready']),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            `default ${DEFAULT_WAIT_TIMEOUT_MS}; values above ${MAX_WAIT_TIMEOUT_MS} are clamped. On timedOut, call again to keep waiting.`,
          ),
      },
    },
    async ({ sessionId, for: cond, timeoutMs }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const requested = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const effectiveMs = Math.min(requested, MAX_WAIT_TIMEOUT_MS);
      const notes =
        requested > MAX_WAIT_TIMEOUT_MS
          ? [
              `timeoutMs ${requested} clamped to ${MAX_WAIT_TIMEOUT_MS}: one call stays under client tool timeouts (Codex: 60 s). Call qa_wait again to keep waiting.`,
            ]
          : [];
      const done = (r: Parameters<typeof qaAnnotate>[0]) => qaAnnotate(r, notes);
      const deadline = Date.now() + effectiveMs;

      // wda_ready: the URL already used by this session (attached driver / last qa_wda start), else
      // the configured one, which must pass the same non-loopback gate as qa_wda.
      let wdaUrl: string | undefined;
      if (cond === 'wda_ready') {
        const resolved = wdaUrlForSession(session);
        if (resolved.source === 'config' && !isLoopbackWdaUrl(resolved.url) && !remoteWdaAllowedByUser(resolved.url))
          return qaError({
            what: `Refused to poll non-loopback WDA URL ${resolved.url} from the repository config`,
            changedState: false,
            retrySafe: false,
            failureCode: 'DESTRUCTIVE_REFUSED',
            nextSteps: [
              `Attach it first with qa_wda { action:"attach", webDriverAgentUrl, allowNonLoopback:true } (consent-gated), or set ${REMOTE_WDA_ENV}=<exact url> in the MCP server environment.`,
            ],
          });
        wdaUrl = resolved.url;
      }
      let lastWda: WdaStatus | undefined;

      // Cancellation (notifications/cancelled): the call's signal is scoped by the tool wrapper
      // (abortScope), so every poll checks it and the pause between polls wakes on abort.
      try {
        while (Date.now() < deadline) {
          throwIfCancelled();
          if (cond === 'wda_ready') {
            lastWda = await checkWda(wdaUrl!, Math.max(250, Math.min(1500, deadline - Date.now())));
            throwIfCancelled();
            if (lastWda.ready)
              return done(
                qaOk(
                  { satisfied: true, condition: cond, webDriverAgentUrl: wdaUrl, wda: lastWda },
                  `WDA ready at ${wdaUrl}\nNext: qa_wda attach (if the session is not attached yet).`,
                ),
              );
            await sleepOrCancel(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
            continue;
          }
          const dev = await resolveDevice(session);
          throwIfCancelled();
          if (cond === 'device_online') {
            if (dev.available.length > 0)
              return done(
                qaOk({ satisfied: true, condition: cond, availableDevices: dev.available }, `device online: ${dev.available.join(', ')}`),
              );
          } else if (dev.effective) {
            const rd = await metroReadiness(dev.effective);
            if (rd.serving)
              return done(
                qaOk(
                  { satisfied: true, condition: cond, metro: rd },
                  `Metro serving=${rd.serving} reverse=${rd.reverseSet} ready=${rd.ready}`,
                ),
              );
          }
          await sleepOrCancel(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
        }
      } catch (e) {
        if (isAbortError(e)) return cancelledResult(`qa_wait ${cond} cancelled: the call was aborted before the condition held`);
        throw e;
      }
      const hint =
        cond === 'device_online'
          ? 'boot one with qa_prepare_target { bindOnly:true }.'
          : cond === 'metro_ready'
            ? 'start Metro with qa_metro action="start", or qa_metro diagnose.'
            : 'check qa_wda { action:"logs" } / { action:"diagnose" } (a managed WDA may have failed to launch).';
      return done(
        qaOk(
          {
            satisfied: false,
            timedOut: true,
            condition: cond,
            ...(cond === 'wda_ready' ? { webDriverAgentUrl: wdaUrl, wda: lastWda ?? null } : {}),
          },
          `Timed out waiting for ${cond}. Call qa_wait again to keep waiting, or ${hint}`,
        ),
      );
    },
  );
}
