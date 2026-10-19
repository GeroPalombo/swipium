// qa_generate target:"flow" core: turn the actions recorded during
// this session (via qa_act) into a durable flow YAML, with a durability grade and the brittle
// steps that need testIDs. Optionally saves it to .swipium/flows/<name>.yaml so it shows up
// in the workflow plan (qa_resolve_target include:["plan"]) and can be replayed with qa_flow_run. Registered through src/tools/generate.ts.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { generateFlow } from '../flows/generate.js';
import { capSlug } from '../lib/stableHash.js';
import { writeFileNoFollow } from '../lib/noFollowFs.js';
import { loadProjectConfig } from '../cli/scan.js';
import type { Session, SessionStore } from '../session/store.js';
import { actionsWithRelaunches } from './suiteGenerate.js';
import { findSecretLeaks, inputBindings, secretSafeNotes, structuralLiterals } from '../suite/secretGuard.js';

export interface FlowGenerateArgs {
  sessionId: string;
  name?: string;
  budgetProfile?: 'guardrail' | 'login_smoke' | 'full_smoke' | 'install_smoke';
  save?: boolean;
}

/** The app was restarted (qa_app_control restart / fresh_start) before the first recorded
 *  action, so the recording began from a clean launch state; the flow should reset the same way. */
function recordingStartedFromRestart(session: Session): boolean {
  const first = session.recordedActions[0]?.at;
  if (first == null) return false;
  return session.mutations.some(
    (m) =>
      m.tool === 'qa_app_control' &&
      (m.action === 'app_restart' || m.action === 'app_fresh_start') &&
      m.status === 'executed' &&
      m.at <= first,
  );
}

/** Stable, human-readable text on the screen the recording ended on (the last snapshot),
 *  used as the flow's final assertion. Skips typed values (trivially visible in the field), clocks /
 *  numbers (dynamic) and clickable controls; prefers the top-of-screen title. */
function finalScreenAssertions(session: Session): string[] {
  const nodes = session.lastSnapshot?.allNodes;
  if (!nodes?.length) return [];
  const typed = new Set(session.recordedActions.filter((a) => a.action === 'type' && a.text).map((a) => a.text!.trim().toLowerCase()));
  const height = nodes[0].bounds[3] || 0;
  const candidates = nodes
    .filter((n) => {
      const t = n.text?.trim();
      if (!t || t.length < 3 || t.length > 40 || n.clickable) return false;
      if (typed.has(t.toLowerCase()) || /\$\{/.test(t)) return false;
      if (/\d/.test(t) && !/[a-z]{3,}/i.test(t)) return false; // times, counters, dates
      if (session.secrets.has(t)) return false;
      return true;
    })
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
  const title = candidates.find((n) => !height || n.bounds[1] <= height * 0.28) ?? candidates[0];
  return title?.text ? [title.text.trim()] : [];
}

/** Core handler for qa_generate target:"flow": draft a repeatable flow YAML from recorded actions. */
export async function runFlowGenerate(
  sessions: SessionStore,
  { sessionId, name, budgetProfile, save }: FlowGenerateArgs,
): Promise<CallToolResult> {
  const session = sessions.get(sessionId);
  if (!session) {
    return unknownSessionError(sessionId);
  }
  if (!session.recordedActions.length) {
    return qaError({
      what: 'No actions recorded in this session yet',
      changedState: false,
      retrySafe: true,
      failureCode: 'NO_RECORDED_ACTIONS',
      nextSteps: ['Drive the app with qa_act first (each action is recorded), then qa_generate target:"flow".'],
    });
  }

  const appId = session.appId ?? (loadProjectConfig(session.root)?.appId as string | undefined) ?? undefined;
  const flowName = capSlug((name ?? `${(appId ?? 'app').split('.').pop()}-smoke`).replace(/[^\w.-]+/g, '-'));
  const gen = generateFlow(actionsWithRelaunches(session), {
    name: flowName,
    appId,
    budgetProfile,
    secrets: session.secrets,
    inputs: inputBindings(session), // typed text equal to a stored input maps to its ${SWIPIUM_TEST_*} placeholder
    resetAtStart: recordingStartedFromRestart(session),
    finalAssertions: finalScreenAssertions(session),
    recordedOutcomes: secretSafeNotes(session.notes, session.secrets)
      .filter((n) => n.outcome === 'pass' && n.reason)
      .map((n) => `${n.workflow}: ${n.reason}`),
  });
  // Backstop: never write (artifact or project file) a flow that still carries a registered secret.
  const leaks = findSecretLeaks([{ path: `${flowName}.yaml`, content: gen.yaml }], session.secrets, {
    structural: structuralLiterals(session.recordedActions),
  });
  if (leaks.length) {
    return qaError({
      what: `Flow not generated: a registered secret value would be written in plaintext (${leaks.map((l) => `${l.path}:${l.line}`).join(', ')})`,
      changedState: false,
      retrySafe: false,
      failureCode: 'SECRET_IN_GENERATED_OUTPUT',
      nextSteps: ['Nothing was written. Re-record the credential step so it is captured as a ${VAR}, then regenerate.'],
    });
  }

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
  let overwrote = false;
  if (save) {
    const dir = join(session.root, '.swipium', 'flows');
    savedTo = join(dir, `${flowName}.yaml`);
    // Say so when a same-named flow with different content is replaced.
    if (existsSync(savedTo) && readFileSync(savedTo, 'utf8') !== gen.yaml) overwrote = true;
    writeFileNoFollow(session.root, savedTo, gen.yaml); // never through a committed symlink
  }

  const summary =
    `Generated flow "${flowName}": durability ${gen.durability.grade} (${gen.durability.semanticPct}% semantic; ` +
    `${gen.durability.coordinate} coordinate, ${gen.durability.needsHumanData} needs-human-data), ${gen.stepCount} steps.` +
    (gen.variables.length ? `\nvariables: ${gen.variables.join(', ')} (provide via qa_flow_run { variables }).` : '') +
    (gen.brittleSteps.length ? `\n⚠ brittle steps:\n - ${gen.brittleSteps.map((b) => `step ${b.index}: ${b.reason}`).join('\n - ')}` : '') +
    (savedTo
      ? `\nsaved: ${savedTo}${overwrote ? ' (replaced an existing flow with different content; pass another name to keep both)' : ''}`
      : `\n(not saved to disk. Pass save:true to write it under .swipium/flows)`) +
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
      ...(overwrote ? { overwroteExisting: true } : {}),
      yaml: gen.yaml,
    },
    summary,
  );
}
