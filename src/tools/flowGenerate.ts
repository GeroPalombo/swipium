// qa_flow_generate (PHASE3-PLAN §4.1 / DESIGN §8) — turn the actions recorded during this
// session (via qa_act) into a durable flow YAML, with a durability grade and the brittle
// steps that need testIDs. Optionally saves it to .swipium/flows/<name>.yaml so it shows up
// in qa_plan and can be replayed with qa_flow_run.

import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { generateFlow } from '../flows/generate.js';
import { loadProjectConfig } from '../cli/scan.js';
import type { SessionStore } from '../session/store.js';

export function registerFlowGenerate(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_flow_generate',
    {
      title: 'Generate a flow from this run',
      description:
        'Draft a repeatable flow YAML from the actions recorded during this session (every qa_act is recorded). Translates @ref taps into durable text selectors where possible, turns typed credentials into ${VARS}, and reports a durability grade (A/B/C) + the steps that need a testID/accessibilityLabel. Pass save:true to write it to .swipium/flows/<name>.yaml (so qa_plan lists it and qa_flow_run can replay it).',
      inputSchema: {
        sessionId: z.string(),
        name: z.string().optional().describe('Flow name (default derived from the app/session).'),
        budgetProfile: z.enum(['guardrail', 'login_smoke', 'full_smoke', 'install_smoke']).optional(),
        save: z.boolean().optional().describe('Write to .swipium/flows/<name>.yaml (default false → returned + saved as an artifact only).'),
      },
    },
    async ({ sessionId, name, budgetProfile, save }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
      }
      if (!session.recordedActions.length) {
        return qaError({
          what: 'No actions recorded in this session yet',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Drive the app with qa_act first (each action is recorded), then qa_flow_generate.'],
        });
      }

      const appId = session.appId ?? ((loadProjectConfig(session.root)?.appId as string | undefined) ?? undefined);
      const flowName = (name ?? `${(appId ?? 'app').split('.').pop()}-smoke`).replace(/[^\w.-]+/g, '-');
      const gen = generateFlow(session.recordedActions, { name: flowName, appId, budgetProfile });

      // Always keep a copy as an artifact; optionally write into the project's flows dir.
      const artifactUri = sessions.saveArtifact(session, 'flow', `${flowName}.yaml`, gen.yaml, 'text/yaml', `generated flow (durability ${gen.durability.grade})`);
      let savedTo: string | undefined;
      if (save) {
        const dir = join(session.root, '.swipium', 'flows');
        mkdirSync(dir, { recursive: true });
        savedTo = join(dir, `${flowName}.yaml`);
        writeFileSync(savedTo, gen.yaml);
      }

      const summary =
        `Generated flow "${flowName}" — durability ${gen.durability.grade} (${gen.durability.semanticPct}% semantic; ` +
        `${gen.durability.coordinate} coordinate, ${gen.durability.needsHumanData} needs-human-data), ${gen.stepCount} steps.` +
        (gen.variables.length ? `\nvariables: ${gen.variables.join(', ')} (provide via qa_flow_run { variables }).` : '') +
        (gen.brittleSteps.length ? `\n⚠ brittle steps:\n - ${gen.brittleSteps.map((b) => `step ${b.index}: ${b.reason}`).join('\n - ')}` : '') +
        (savedTo ? `\nsaved: ${savedTo}` : `\n(not saved to disk — pass save:true to write it under .swipium/flows)`) +
        `\n\n${gen.yaml}`;

      return qaOk(
        { name: flowName, appId: appId ?? null, durability: gen.durability, brittleSteps: gen.brittleSteps, variables: gen.variables, stepCount: gen.stepCount, artifactUri, savedTo: savedTo ?? null, yaml: gen.yaml },
        summary,
      );
    },
  );
}
