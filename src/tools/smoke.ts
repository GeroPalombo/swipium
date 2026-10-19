// qa_smoke: server-side smoke orchestration. Runs the whole loop WITHOUT
// the model mediating each step (the context-efficiency + determinism win): launch the app,
// run the deterministic baseline (snapshot quality + Tier-1 health + an evidence screenshot),
// then run every saved flow (.swipium/flows/*.yaml). Records a structured qa_note per workflow
// and points the agent at qa_report. One call replaces a long hand-driven chain.
//
// Scope note: a single honest orchestrator. Generic credential-login / per-screen-visual smokes
// are app-specific and fragile to synthesize, so login is handled by authoring a login *flow*
// (run here automatically) rather than a separate login-smoke tool that guesses.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { cancelledResult, qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { blockedDeviceResult, getDriver, isSimulatorUdid, prepareFirstStep } from '../session/attach.js';
import { runSmoke } from '../services/smoke.js';
import type { Session, SessionStore } from '../session/store.js';
import { checkWda } from '../lib/wda.js';

/** What hung, when the latest WDA record for this session's simulator is prepare's `blocked`
 *  wda_attach (its WDA hung) and that WDA still does not answer. Exported for tests. */
export async function hungWdaAtPrepare(session: Session): Promise<string | undefined> {
  const udid = session.device;
  if (!udid || !isSimulatorUdid(udid)) return undefined;
  const last = [...(session.mutations ?? [])]
    .reverse()
    .find(
      (m) =>
        ['wda_attach', 'wda_start', 'wda_reuse'].includes(m.action) &&
        (m.status === 'executed' || m.status === 'blocked') &&
        String(m.target?.udid ?? '').toUpperCase() === udid.toUpperCase(),
    );
  // Only prepare's hang verdict (qa_wda attach failures are ledgered as blocked too, for other reasons).
  if (last?.action !== 'wda_attach' || last.status !== 'blocked' || last.tool !== 'qa_prepare_ios_target') return undefined;
  const url = typeof last.target?.webDriverAgentUrl === 'string' ? last.target.webDriverAgentUrl : undefined;
  if (url && (await checkWda(url, 1500).catch(() => undefined))?.reachable) return undefined; // answers again
  return last.detail ?? `WebDriverAgent${url ? ` at ${url}` : ''} hung during prepare`;
}

export function registerSmoke(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_smoke',
    {
      title: 'Run a smoke test',
      description:
        'Run a smoke test server-side: optionally launch, run the baseline (snapshot quality + health + evidence screenshot), then ' +
        'every saved flow in .swipium/flows. Records a qa_note per workflow; call qa_report after. Needs a prepared device.',
      inputSchema: {
        sessionId: z.string(),
        launch: z.boolean().optional().describe('Launch first (default true with an appId).'),
        runFlows: z.boolean().optional().describe('Run saved .swipium/flows (default true).'),
        variables: z.record(z.string(), z.string()).optional().describe('${VAR} values for flows (over stored inputs, SWIPIUM_* env).'),
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
            failureCode: 'NO_DEVICE',
            changedState: false,
            retrySafe: true,
            nextSteps: [prepareFirstStep(session, 'qa_smoke')],
          })
        );
      }

      // Prepare found this simulator's WDA hung (a blocked wda_attach is the latest WDA record): the
      // same WDA_UNREACHABLE verdict qa_test_this gives, never a visual-only "launch pass".
      const wdaUnreachable = d.kind === 'wda' ? undefined : await hungWdaAtPrepare(session);
      const result = await runSmoke(sessions, session, d, { launch, runFlows, variables, ...(wdaUnreachable ? { wdaUnreachable } : {}) });
      if (result.cancelled) return cancelledResult('qa_smoke cancelled: the remaining baseline/flows were skipped, not failed', true);
      const launchOutcome = (result.baseline.launch as { outcome?: string } | undefined)?.outcome ?? 'unknown';
      const summary =
        `qa_smoke done: launch=${launchOutcome}, flows ${result.flowsPassed}/${result.flowsTotal} passed` +
        `${result.flowsSkipped ? `, ${result.flowsSkipped} skipped (need consent)` : ''}.\n` +
        `baseline: ${JSON.stringify(result.baseline.launch)}\n` +
        (result.flows.length
          ? result.flows.map((f) => `${f.passed ? '✓' : f.skipped ? '-' : '✗'} ${f.name}${f.passed ? '' : `: ${f.reason}`}`).join('\n')
          : 'no saved flows (.swipium/flows is empty)') +
        `\nCall qa_report to summarize.`;

      return qaOk(
        {
          baseline: result.baseline.launch,
          flows: result.flows,
          flowsPassed: result.flowsPassed,
          flowsTotal: result.flowsTotal,
          ...(result.flowsSkipped ? { flowsSkipped: result.flowsSkipped } : {}),
          counters: session.counters,
        },
        summary,
      );
    },
  );
}
