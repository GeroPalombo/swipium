// qa_plan (PHASE3-PLAN §3.2) — propose a safe test plan instead of making the agent guess.
// Synthesizes detectContext() + the session's declared fixtures / observed auth / prepared
// appId into READY / BLOCKED / UNSAFE workflows. Pure planning logic lives in src/plan/plan.ts.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { detectContext } from '../context/detect.js';
import { buildPlan } from '../plan/plan.js';
import { listFlowFiles } from '../flows/discover.js';
import type { SessionStore } from '../session/store.js';

export function registerPlan(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_plan',
    {
      title: 'Plan what to test',
      description:
        'Propose a safe test plan for the current session instead of guessing. Returns READY workflows (with budget profile + satisfied preconditions), BLOCKED workflows (with a category — missing_device/missing_artifact/missing_test_data/missing_toolchain — required state, and how to unblock), and UNSAFE workflows (with a reason, e.g. bundle_cache_loss for fresh_start on a debug RN/Expo build). Call this first to decide what to run. Reads detected context + declared fixtures + observed auth; does not touch the device.',
      inputSchema: {
        sessionId: z.string().describe('A session from qa_start_session (its fixtures/auth/root inform the plan).'),
      },
    },
    async ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return qaError({
          what: 'No such session',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session first, then qa_plan with its sessionId.'],
        });
      }

      const ctx = await detectContext(session.root);
      const plan = buildPlan({
        framework: ctx.framework,
        hasDevice: ctx.devices.androidOnline.length > 0 || ctx.devices.avds.length > 0,
        hasApk: ctx.artifacts.apks.length > 0 || ctx.artifacts.ipas.length > 0 || ctx.artifacts.appBundles.length > 0,
        appPrepared: !!session.appId,
        fixtures: session.fixtures,
        auth: session.auth,
        blockers: ctx.blockers,
        flows: listFlowFiles(session.root).map((f) => f.name),
      });

      const line = (s: string) => ` - ${s}`;
      const summary =
        `Plan for session ${session.id} (framework=${ctx.framework})\n` +
        `READY (${plan.ready.length}):\n` +
        (plan.ready
          .map((w) => line(`${w.workflow} [${w.budgetProfile}]${w.requires.length ? ` needs ${w.requires.join(', ')}` : ''}`))
          .join('\n') || ' (none)') +
        `\nBLOCKED (${plan.blocked.length}):\n` +
        (plan.blocked.map((w) => line(`${w.workflow}: ${w.category} — ${w.requiredState} → ${w.recommendedSetup}`)).join('\n') ||
          ' (none)') +
        `\nUNSAFE (${plan.unsafe.length}):\n` +
        (plan.unsafe.map((w) => line(`${w.workflow}: ${w.reason} — ${w.detail}`)).join('\n') || ' (none)') +
        (plan.notes.length ? `\nnotes:\n` + plan.notes.map(line).join('\n') : '');

      return qaOk({ ...plan, framework: ctx.framework }, summary);
    },
  );
}
