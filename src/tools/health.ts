// qa_check_health — run the Tier-1 deterministic oracle on demand.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { checkHealth } from '../oracle/health.js';
import { recordHealthFindings } from '../oracle/record.js';
import { getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

export function registerCheckHealth(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_check_health',
    {
      title: 'Check app health',
      description:
        'Deterministic Tier-1 health check of the current screen: crash / ANR / framework error-boundary / error-surface, plus whether the app is still in the foreground. High-severity findings are real bugs (not flake). Runs automatically after qa_act too.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const session = sessions.get(sessionId);
      const { driver } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !driver) {
        return qaError({
          what: 'No device attached to this session',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_prepare_target first.'],
        });
      }
      const health = await checkHealth(driver, session.appId);
      await recordHealthFindings(sessions, session, health.findings, driver, health.foreground); // feeds qa_report
      const summary =
        `native health: ${health.nativeHealthy ? '✅ OK' : `❌ ${health.nativeStatus}`} · ` +
        `app health: ${health.appStatus === 'ok' ? '✅ OK' : health.appStatus === 'degraded' ? '⚠ degraded' : '❌ error'} — foreground=${health.foreground}\n` +
        (health.findings.length
          ? health.findings
              .map((f) => `[${f.severity}] ${f.layer ?? '?'}/${f.kind}: ${f.detail}${f.evidence ? ` — "${f.evidence}"` : ''}`)
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
