// qa_check_health: run the Tier-1 deterministic oracle on demand.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { checkHealth } from '../oracle/health.js';
import { recordHealthFindings } from '../oracle/record.js';
import { blockedDeviceResult, getDriver, prepareFirstStep } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';
import { deviceGoneNextSteps } from '../lib/deviceGone.js';

export function registerCheckHealth(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_check_health',
    {
      title: 'Check app health',
      description:
        'Health check of the current screen: crash, ANR, error boundary, error surface, app still in the foreground. ' +
        'High-severity findings are real bugs. qa_act runs it automatically.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver, blocked } = await getDriver(session);
      if (!session || !driver) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            failureCode: 'NO_DEVICE',
            changedState: false,
            retrySafe: true,
            nextSteps: [prepareFirstStep(session)],
          })
        );
      }
      const health = await checkHealth(driver, session.appId);
      // A dead device is "unknown", never OK (AND-12). Nothing is recorded against the app.
      if (health.deviceGone)
        return qaError({
          what: `Health unknown: the session's device${session.device ? ` (${session.device})` : ''} is offline.`,
          changedState: false,
          retrySafe: false,
          failureCode: 'NO_DEVICE',
          nextSteps: deviceGoneNextSteps(session.device),
        });
      await recordHealthFindings(sessions, session, health.findings, driver, health.foreground); // feeds qa_report
      const summary =
        `native health: ${health.nativeHealthy ? '✅ OK' : `❌ ${health.nativeStatus}`} · ` +
        `app health: ${health.appStatus === 'ok' ? '✅ OK' : health.appStatus === 'degraded' ? '⚠ degraded' : '❌ error'}, foreground=${health.foreground}\n` +
        (health.findings.length
          ? health.findings
              .map((f) => `[${f.severity}] ${f.layer ?? '?'}/${f.kind}: ${f.detail}${f.evidence ? `: "${f.evidence}"` : ''}`)
              .join('\n')
          : 'no findings');
      return qaOk(
        {
          healthy: health.healthy,
          nativeHealthy: health.nativeHealthy,
          appHealthy: health.appHealthy,
          nativeStatus: health.nativeStatus,
          appStatus: health.appStatus,
          foreground: health.foreground,
          findings: health.findings,
        },
        summary,
      );
    },
  );
}
