// qa_note — record a structured test outcome (Phase 2.2). Lets the agent state explicitly
// that a workflow passed / failed / was blocked / skipped / not-applicable, with the reason,
// missing precondition, required state, and recommended setup. This is how a report
// distinguishes a real app bug from "no saved flight existed to delete" — so missing test
// data and intentional skips stop being mislabeled as failures.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import type { SessionStore, TestOutcome, TestCategory } from '../session/store.js';

const OUTCOMES = ['pass', 'fail', 'blocked', 'skipped', 'not_applicable'] as const;
const CATEGORIES = ['app_bug', 'mcp_limitation', 'missing_test_data', 'intentionally_skipped', 'destructive_refused', 'other'] as const;

export function registerNote(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_note',
    {
      title: 'Record a test outcome',
      description:
        'Record a STRUCTURED test outcome for one workflow so the report is honest about what was and was not verified. Use outcome="blocked" with a missingPrecondition (e.g. "no saved flight exists") instead of reporting a false failure; "not_applicable" when the workflow does not apply; "skipped" when intentionally not run. Set category to classify (app_bug | mcp_limitation | missing_test_data | intentionally_skipped | destructive_refused | other). Attach artifactUris (screenshots/dumps) as evidence.',
      inputSchema: {
        sessionId: z.string(),
        workflow: z.string().describe('the workflow/test this outcome is about, e.g. "Delete saved flight"'),
        outcome: z.enum(OUTCOMES).describe('WHAT happened (independent of category).'),
        category: z.enum(CATEGORIES).optional().describe('WHY / classification — an INDEPENDENT axis from outcome (e.g. a not_applicable outcome may be category=intentionally_skipped). The report cross-tabs the two; they are not folded together.'),
        reason: z.string().optional(),
        missingPrecondition: z.string().optional().describe('what state was required but absent, e.g. "no saved flight exists"'),
        requiredState: z.string().optional().describe('the state the test needs, e.g. "at least one saved flight"'),
        recommendedSetup: z.string().optional().describe('how to satisfy the precondition next time'),
        artifactUris: z.array(z.string()).optional(),
        verifiedVisually: z.boolean().optional().describe('pass was confirmed from a screenshot (animated/map/canvas screen with no structured tree) — counts as a real pass, not a weak one. Attach the screenshot in artifactUris.'),
      },
    },
    async ({ sessionId, workflow, outcome, category, reason, missingPrecondition, requiredState, recommendedSetup, artifactUris, verifiedVisually }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
      }
      // A visual-only pass should carry its evidence so the report isn't taking it on faith.
      if (verifiedVisually && outcome === 'pass' && !(artifactUris && artifactUris.length)) {
        return qaError({
          what: 'A visually-verified pass needs a screenshot in artifactUris as evidence.',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_screenshot (with a reason), then re-call qa_note with its URI in artifactUris.'],
        });
      }
      // A "blocked" outcome with no explanation is exactly the unhelpful case this tool exists
      // to prevent — nudge for the precondition.
      if (outcome === 'blocked' && !missingPrecondition && !reason) {
        return qaError({
          what: 'A "blocked" outcome needs a missingPrecondition or reason so the report is actionable.',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Re-call qa_note with missingPrecondition (e.g. "no saved flight exists") and/or reason.'],
        });
      }
      // If a declared fixture matches this workflow/precondition, borrow its recommendedSetup
      // so a blocked outcome carries the setup guidance the agent already declared (P1.4).
      const fx = session.fixtures.find(
        (f) => f.name.toLowerCase() === workflow.toLowerCase() || (missingPrecondition && f.name.toLowerCase() === missingPrecondition.toLowerCase()),
      );
      sessions.addNote(session, {
        at: Date.now(),
        workflow,
        outcome: outcome as TestOutcome,
        category: category as TestCategory | undefined,
        reason,
        missingPrecondition: missingPrecondition ?? fx?.requiredState,
        requiredState: requiredState ?? fx?.requiredState,
        recommendedSetup: recommendedSetup ?? fx?.recommendedSetup,
        artifactUris,
        verifiedVisually,
      });
      const tally = session.notes.reduce<Record<string, number>>((a, n) => ((a[n.outcome] = (a[n.outcome] ?? 0) + 1), a), {});
      return qaOk(
        { recorded: { workflow, outcome, category }, tally },
        `noted: "${workflow}" → ${outcome}${category ? ` (${category})` : ''}${missingPrecondition ? ` — missing: ${missingPrecondition}` : ''}\ntally: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}`,
      );
    },
  );
}
