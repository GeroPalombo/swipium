// qa_smoke (PHASE3-PLAN §7.2) — server-side smoke orchestration. Runs the whole loop WITHOUT
// the model mediating each step (the context-efficiency + determinism win): launch the app,
// run the deterministic baseline (snapshot quality + Tier-1 health + an evidence screenshot),
// then run every saved flow (.swipium/flows/*.yaml). Records a structured qa_note per workflow
// and points the agent at qa_report. One call replaces a long hand-driven chain.
//
// Scope note: a single honest orchestrator. Generic credential-login / per-screen-visual smokes
// are app-specific and fragile to synthesize, so login is handled by authoring a login *flow*
// (run here automatically) rather than a separate qa_login_smoke that guesses.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { getDriver } from '../session/attach.js';
import { runSmoke } from '../services/smoke.js';
import type { SessionStore } from '../session/store.js';

export function registerSmoke(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_smoke',
    {
      title: 'Run a smoke test',
      description:
        'Run a full smoke server-side (no per-step model round-trips): optionally launch the app, run the deterministic baseline (snapshot quality + Tier-1 health + an evidence screenshot), then run every saved flow under .swipium/flows. Records a qa_note per workflow and tells you to call qa_report. Use `variables` for flow ${VARS} (e.g. TEST_EMAIL). Requires a session with a prepared device.',
      inputSchema: {
        sessionId: z.string(),
        launch: z.boolean().optional().describe('Launch the app first (default true if the session has an appId).'),
        runFlows: z.boolean().optional().describe('Run saved .swipium/flows (default true).'),
        variables: z.record(z.string()).optional().describe('Values for ${VAR} placeholders in flows (merged over process.env).'),
      },
    },
    async ({ sessionId, launch, runFlows, variables }) => {
      const session = sessions.get(sessionId);
      const { driver: d } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !d) {
        return qaError({
          what: 'No device attached to this session',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_prepare_target first, then qa_smoke.'],
        });
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
