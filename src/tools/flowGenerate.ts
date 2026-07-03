// qa_generate target:"flow" core (PHASE3-PLAN §4.1 / DESIGN §8) — turn the actions recorded during
// this session (via qa_act) into a durable flow YAML, with a durability grade and the brittle
// steps that need testIDs. Optionally saves it to .swipium/flows/<name>.yaml so it shows up
// in qa_plan and can be replayed with qa_flow_run. Registered through src/tools/generate.ts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaOk, qaError } from '../lib/result.js';
import { generateFlow } from '../flows/generate.js';
import { loadProjectConfig } from '../cli/scan.js';
import type { SessionStore } from '../session/store.js';

export interface FlowGenerateArgs {
  sessionId: string;
  name?: string;
  budgetProfile?: 'guardrail' | 'login_smoke' | 'full_smoke' | 'install_smoke';
  save?: boolean;
}

/** Core handler for qa_generate target:"flow" — draft a repeatable flow YAML from recorded actions. */
export async function runFlowGenerate(
  sessions: SessionStore,
  { sessionId, name, budgetProfile, save }: FlowGenerateArgs,
): Promise<CallToolResult> {
  const session = sessions.get(sessionId);
  if (!session) {
    return qaError({
      what: `Unknown sessionId ${sessionId}`,
      changedState: false,
      retrySafe: true,
      nextSteps: ['Call qa_start_session first.'],
    });
  }
  if (!session.recordedActions.length) {
    return qaError({
      what: 'No actions recorded in this session yet',
      changedState: false,
      retrySafe: true,
      nextSteps: ['Drive the app with qa_act first (each action is recorded), then qa_generate target:"flow".'],
    });
  }

  const appId = session.appId ?? (loadProjectConfig(session.root)?.appId as string | undefined) ?? undefined;
  const flowName = (name ?? `${(appId ?? 'app').split('.').pop()}-smoke`).replace(/[^\w.-]+/g, '-');
  const gen = generateFlow(session.recordedActions, { name: flowName, appId, budgetProfile });

  // Always keep a copy as an artifact; optionally write into the project's flows dir.
  const artifactUri = sessions.saveArtifact(
    session,
    'flow',
    `${flowName}.yaml`,
    gen.yaml,
    'text/yaml',
    `generated flow (durability ${gen.durability.grade})`,
  );
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
    {
      name: flowName,
      appId: appId ?? null,
      durability: gen.durability,
      brittleSteps: gen.brittleSteps,
      variables: gen.variables,
      stepCount: gen.stepCount,
      artifactUri,
      savedTo: savedTo ?? null,
      yaml: gen.yaml,
    },
    summary,
  );
}
