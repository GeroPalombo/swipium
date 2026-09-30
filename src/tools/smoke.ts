// qa_smoke — server-side smoke orchestration. Runs the whole loop WITHOUT
// the model mediating each step (the context-efficiency + determinism win): launch the app,
// run the deterministic baseline (snapshot quality + Tier-1 health + an evidence screenshot),
// then run every saved flow (.swipium/flows/*.yaml). Records a structured qa_note per workflow
// and points the agent at qa_report. One call replaces a long hand-driven chain.
//
// Scope note: a single honest orchestrator. Generic credential-login / per-screen-visual smokes
// are app-specific and fragile to synthesize, so login is handled by authoring a login *flow*
// (run here automatically) rather than a separate login-smoke tool that guesses.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import { runSmoke } from '../services/smoke.js';
import type { SessionStore } from '../session/store.js';

export function registerSmoke(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_smoke',
    {
      title: 'Run a smoke test',
      description:
        'Server-side smoke: optionally launch, run the baseline (snapshot quality + health + evidence screenshot), then every ' +
        'saved flow in .swipium/flows. Records a qa_note per workflow; call qa_report after. Needs a prepared device.',
      inputSchema: {
        sessionId: z.string(),
        launch: z.boolean().optional().describe('Launch first (default true with an appId).'),
        runFlows: z.boolean().optional().describe('Run saved .swipium/flows (default true).'),
        variables: z.record(z.string()).optional().describe('${VAR} values for flows (over stored inputs, SWIPIUM_* env).'),
      },
    },
    async ({ sessionId, launch, runFlows, variables }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver: d, blocked } = await getDriver(session);
      if (!session || !d) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_prepare_target first, then qa_smoke.'],
          })
        );
      }

      const result = await runSmoke(sessions, session, d, { launch, runFlows, variables });
      const launchOutcome = (result.baseline.launch as { outcome?: string } | undefined)?.outcome ?? 'unknown';
      const summary =
        `qa_smoke done — launch=${launchOutcome}, flows ${result.flowsPassed}/${result.flowsTotal} passed.\n` +
        `baseline: ${JSON.stringify(result.baseline.launch)}\n` +
        (result.flows.length
          ? result.flows.map((f) => `${f.passed ? '✓' : '✗'} ${f.name}${f.passed ? '' : ` — ${f.reason}`}`).join('\n')
          : 'no saved flows (.swipium/flows is empty)') +
        `\nCall qa_report to summarize.`;

      return qaOk(
        {
          baseline: result.baseline.launch,
          flows: result.flows,
          flowsPassed: result.flowsPassed,
          flowsTotal: result.flowsTotal,
          counters: session.counters,
        },
        summary,
      );
    },
  );
}
