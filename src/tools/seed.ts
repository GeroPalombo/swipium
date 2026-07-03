// qa_seed (PHASE3-PLAN §4.4 / roadmap §9) — turn a declared precondition into one Swipium can
// actually create, OPT-IN and consent-gated. A fixture may carry a `seed` spec: a deep link, a
// project-root script, or an API call. Every seed is a mutation → explicit consent, exact action
// shown. The raw execution lives in src/flows/seedExec.ts (shared with the flow `seed` step). If
// seeding fails it is reported as a SETUP failure (environment bucket), never an app bug.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { qaFail } from '../oracle/failures.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { executeSeed, seedExactCommand, seedGitScopeViolation } from '../flows/seedExec.js';
import { getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

export function registerSeed(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_seed',
    {
      title: 'Seed a precondition',
      description:
        'Create a declared precondition (opt-in, consent-gated) so a blocked workflow can run. The named fixture must declare a `seed`: deeplink (open a setup deep link), script (argv array run under the project root), or api (HTTP call). Every seed is a mutation and requires consent showing the exact action. If seeding fails it is reported as a SETUP failure, not an app bug.',
      inputSchema: {
        sessionId: z.string(),
        fixture: z.string().describe('Name of a declared fixture that has a `seed` spec.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, fixture: fixtureName, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return qaError({
          what: `Unknown sessionId ${sessionId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session first.'],
        });
      }
      const fixture = session.fixtures.find((f) => f.name === fixtureName);
      if (!fixture) {
        return qaError({
          what: `No declared fixture "${fixtureName}"`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Declare it in .swipium/fixtures.json or qa_start_session { fixtures }.'],
        });
      }
      const seed = fixture.seed;
      if (!seed) {
        return qaError({
          what: `Fixture "${fixtureName}" has no seed spec`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Add a seed: { type: "deeplink"|"script"|"api", … } to the fixture to make it creatable.'],
        });
      }
      const git = seedGitScopeViolation(seed);
      if (git) {
        return qaFail('GIT_SCOPE_FORBIDDEN', {
          what: `Fixture "${fixtureName}" seed command is refused because Git is outside Swipium's QA scope: ${git}`,
          changedState: false,
          extra: { fixture: fixtureName, command: git },
        });
      }

      // Consent — exact action shown, scoped to this fixture + seed type.
      const affects = { fixture: fixtureName, type: seed.type };
      const risk = seed.type === 'script' ? 'high' : seed.type === 'api' ? 'medium' : 'low';
      const gate = consumeConsent(consentId, approve, { action: 'seed_state', affects });
      if (!gate.approved) {
        sessions.recordMutation(session, {
          tool: 'qa_seed',
          action: 'seed_state',
          risk,
          target: affects,
          consent: { required: true, approved: false },
          status: 'requested',
        });
        return requireConsent({
          action: 'seed_state',
          risk,
          exactCommand: seedExactCommand(seed),
          affects,
          explain: `Seed precondition "${fixtureName}" via ${seed.type}? This mutates state${seed.type === 'script' ? ' by running a command under the project root' : seed.type === 'api' ? ' by calling an external API' : ' by opening a deep link'}.`,
        });
      }
      sessions.recordMutation(session, {
        tool: 'qa_seed',
        action: 'seed_state',
        risk,
        target: affects,
        consent: { required: true, consentId, approved: true },
        status: 'approved',
      });

      const { driver } = await getDriver(session);
      const result = await executeSeed(sessions, session, driver, fixtureName, seed);
      if (!result.ok) {
        // Record as a SETUP failure (not an app bug) so the report can't mislabel it.
        sessions.addNote(session, {
          at: Date.now(),
          workflow: `seed:${fixtureName}`,
          outcome: 'blocked',
          category: 'missing_test_data',
          reason: `seed failed: ${result.detail}`,
          requiredState: fixture.requiredState,
          recommendedSetup: fixture.recommendedSetup,
        });
        sessions.recordMutation(session, {
          tool: 'qa_seed',
          action: 'seed_state',
          risk,
          target: affects,
          consent: { required: true, consentId, approved: true },
          status: 'blocked',
          detail: result.detail,
        });
        return qaFail('SEED_FAILED', {
          what: `Seeding "${fixtureName}" failed: ${result.detail}`,
          changedState: true,
          extra: { fixture: fixtureName, type: seed.type },
        });
      }
      sessions.addNote(session, {
        at: Date.now(),
        workflow: `seed:${fixtureName}`,
        outcome: 'pass',
        reason: `precondition created via ${seed.type}`,
      });
      sessions.recordMutation(session, {
        tool: 'qa_seed',
        action: 'seed_state',
        risk,
        target: affects,
        consent: { required: true, consentId, approved: true },
        status: 'executed',
        detail: result.warnings.join(' ') || undefined,
      });
      return qaOk(
        { fixture: fixtureName, type: seed.type, seeded: true, warnings: result.warnings },
        `✅ seeded "${fixtureName}" via ${seed.type} — the precondition should now be met. Re-run the workflow.${result.warnings.length ? `\n⚠ ${result.warnings.join(' ')}` : ''}`,
      );
    },
  );
}
