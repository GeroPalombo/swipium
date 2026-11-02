// qa_note: record a structured test outcome. Lets the agent state explicitly
// that a workflow passed / failed / was blocked / skipped / not-applicable, with the reason,
// missing precondition, required state, and recommended setup. This is how a report
// distinguishes a real app bug from "no saved flight existed to delete", so missing test
// data and intentional skips stop being mislabeled as failures.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { capEchoed, qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { makeRedactor } from '../lib/redact.js';
import { TRANSPORT_FAILURE_CODES, type Session, type SessionStore, type TestOutcome, type TestCategory } from '../session/store.js';
import { canCaptureScreenshot } from '../lib/captureGuard.js';
import { TIMED_OUT, withTimeout } from '../lib/steps.js';

const OUTCOMES = ['pass', 'fail', 'blocked', 'skipped', 'not_applicable'] as const;
const CATEGORIES = ['app_bug', 'mcp_limitation', 'missing_test_data', 'intentionally_skipped', 'destructive_refused', 'other'] as const;

/** Default category for an uncategorized note: a failure is an app bug (app-owned, medium in the
 *  issue ledger); other outcomes stay uncategorized. */
export function defaultNoteCategory(outcome: string): TestCategory | undefined {
  return outcome === 'fail' ? 'app_bug' : undefined;
}

/** Checkpoint capture budget: qa_note has no device dependency, so a slow device only costs this. */
export const CHECKPOINT_TIMEOUT_MS = 3000;

/** Best-effort checkpoint screenshot for a pass/fail note. Never throws, never binds a device and
 *  never counts toward the screenshot budget. Saved as kind 'checkpoint' without appForeground, so
 *  it is never "reached the app" evidence. */
async function captureCheckpoint(
  sessions: SessionStore,
  session: Session,
  stepI: number,
  lastStepBefore: { result: string; failureCode?: string } | undefined,
): Promise<{ uri?: string; skipped?: string }> {
  if (session.sensitive) return { skipped: 'screenshot withheld (sensitive session)' };
  // Only a driver this session already has: a note never attaches a device.
  const d = session.driver;
  if (!d) return { skipped: 'no device attached' };
  if (lastStepBefore?.result === 'failed' && lastStepBefore.failureCode && TRANSPORT_FAILURE_CODES.has(lastStepBefore.failureCode))
    return { skipped: 'not captured (device unreachable)' };
  try {
    const shot = await withTimeout(
      (async () => {
        const g = await canCaptureScreenshot(session, d);
        if (!g.ok) return { skipped: g.note };
        // capture-guard: checked just above (canCaptureScreenshot)
        return { png: await d.screenshot() };
      })(),
      CHECKPOINT_TIMEOUT_MS,
    );
    if (shot === TIMED_OUT) return { skipped: 'checkpoint timed out' };
    if ('skipped' in shot) return { skipped: shot.skipped };
    const uri = sessions.saveArtifact(
      session,
      'checkpoint',
      `checkpoint-${stepI}-${Date.now()}.png`,
      shot.png,
      'image/png',
      'qa_note checkpoint',
    );
    return { uri };
  } catch {
    return { skipped: 'checkpoint capture failed' };
  }
}

export function registerNote(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_note',
    {
      title: 'Record a test outcome',
      description:
        'Record the outcome of one workflow for the report. Use outcome:"blocked" + missingPrecondition rather than a false ' +
        'failure; category says why. A pass/fail note captures a checkpoint screenshot and links the steps since the last ' +
        "note; extra evidence goes in artifactUris (this session's URIs only, others are dropped).",
      inputSchema: {
        sessionId: z.string(),
        workflow: z.string().describe('e.g. "Delete saved flight"'),
        outcome: z.enum(OUTCOMES),
        category: z.enum(CATEGORIES).optional().describe('Default for outcome:"fail" is app_bug; use mcp_limitation for tool problems.'),
        reason: z.string().optional(),
        missingPrecondition: z.string().optional().describe('e.g. "no saved flight exists"'),
        requiredState: z.string().optional(),
        recommendedSetup: z.string().optional(),
        artifactUris: z.array(z.string()).optional(),
        verifiedVisually: z.boolean().optional().describe('The pass was confirmed from an attached screenshot.'),
      },
    },
    async (args) => {
      const started = Date.now();
      const { sessionId, outcome, category, verifiedVisually } = args;
      // Stored note strings are length-capped (they land in state.json, reports and every echo).
      const workflow = capEchoed(args.workflow);
      const reason = capEchoed(args.reason);
      const missingPrecondition = capEchoed(args.missingPrecondition);
      const requiredState = capEchoed(args.requiredState);
      const recommendedSetup = capEchoed(args.recommendedSetup);
      const session = sessions.get(sessionId);
      if (!session) {
        return unknownSessionError(sessionId);
      }
      // Evidence must be this session's own artifacts. Unknown URIs are dropped with a warning, not
      // rejected: a rejection would make agents retry in a loop and lose the bug report. Dropped
      // before the visual check, so a visual pass backed only by unknown URIs is refused below.
      const warnings: string[] = [];
      const knownUris = (args.artifactUris ?? []).filter((u) => sessions.findArtifact(u)?.session === session);
      const dropped = (args.artifactUris ?? []).filter((u) => !knownUris.includes(u));
      if (dropped.length)
        warnings.push(
          `dropped ${dropped.length} artifactUri(s) that are not artifacts of this session: ${dropped.map((u) => capEchoed(u)).join(', ')}`,
        );
      const artifactUris = knownUris.length ? knownUris : undefined;
      // A visual-only pass should carry its evidence so the report isn't taking it on faith.
      if (verifiedVisually && outcome === 'pass' && !(artifactUris && artifactUris.length)) {
        return qaError({
          what: 'A visually-verified pass needs a screenshot in artifactUris as evidence.',
          failureCode: 'INVALID_ARGUMENT',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_screenshot (with a reason), then re-call qa_note with its URI in artifactUris.'],
        });
      }
      // A "blocked" outcome with no explanation is exactly the unhelpful case this tool exists
      // to prevent. Nudge for the precondition.
      if (outcome === 'blocked' && !missingPrecondition && !reason) {
        return qaError({
          what: 'A "blocked" outcome needs a missingPrecondition or reason so the report is actionable.',
          failureCode: 'INVALID_ARGUMENT',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Re-call qa_note with missingPrecondition (e.g. "no saved flight exists") and/or reason.'],
        });
      }
      // If a declared fixture matches this workflow/precondition, borrow its recommendedSetup
      // so a blocked outcome carries the setup guidance the agent already declared.
      const fx = session.fixtures.find(
        (f) =>
          f.name.toLowerCase() === workflow.toLowerCase() ||
          (missingPrecondition && f.name.toLowerCase() === missingPrecondition.toLowerCase()),
      );
      // A failing note with no category is an app finding by default: left uncategorized, the
      // issue-ledger bridge would triage it as a low-severity Swipium `mcp_limitation`. Agents
      // mark tool problems explicitly with category:"mcp_limitation".
      const effectiveCategory: TestCategory | undefined = (category as TestCategory | undefined) ?? defaultNoteCategory(outcome);
      // One 'note' step per recorded note. It covers the steps since the previous note.
      const before = session.steps ?? [];
      const lastStepBefore = before.at(-1);
      const prevNote = [...before].reverse().find((st) => st.source === 'note');
      const firstAfterPrev = prevNote ? before.find((st) => st.i > prevNote.i) : before[0];
      const step = sessions.addStep(session, {
        source: 'note',
        action: 'note',
        target: `${outcome} "${workflow}"`,
        group: workflow,
        result: outcome === 'fail' ? 'failed' : 'ok',
        durationMs: 0,
      });
      const stepRange: [number, number] = [firstAfterPrev?.i ?? step.i, step.i];
      // Pass/fail notes get a checkpoint screenshot. It is linked to the note but never counts as
      // the explicit evidence a verifiedVisually pass needs (that check already ran above).
      const checkpoint = outcome === 'pass' || outcome === 'fail' ? await captureCheckpoint(sessions, session, step.i, lastStepBefore) : {};
      const st = session.steps.find((x) => x.i === step.i);
      if (st) st.durationMs = Date.now() - started;
      sessions.updateStep(
        session,
        step.i,
        checkpoint.uri ? { screenshotUri: checkpoint.uri } : checkpoint.skipped ? { screenshotSkipped: checkpoint.skipped } : {},
      );
      sessions.addNote(session, {
        at: Date.now(),
        workflow,
        outcome: outcome as TestOutcome,
        category: effectiveCategory,
        reason,
        missingPrecondition: missingPrecondition ?? fx?.requiredState,
        requiredState: requiredState ?? fx?.requiredState,
        recommendedSetup: recommendedSetup ?? fx?.recommendedSetup,
        artifactUris,
        verifiedVisually,
        source: 'qa_note',
        origin: 'agent',
        stepRange,
        ...(checkpoint.uri ? { checkpointUri: checkpoint.uri } : {}),
        ...(checkpoint.skipped ? { checkpointSkipped: checkpoint.skipped } : {}),
      });
      const tally = session.notes.reduce<Record<string, number>>((a, n) => ((a[n.outcome] = (a[n.outcome] ?? 0) + 1), a), {});
      // The response is scrubbed like everything persisted: registered secrets never echo back.
      const redact = makeRedactor(session.secrets);
      const shownWorkflow = redact(workflow) ?? workflow;
      const shownMissing = redact(missingPrecondition) ?? missingPrecondition;
      return qaOk(
        {
          recorded: { workflow: shownWorkflow, outcome, category: effectiveCategory },
          tally,
          stepRange,
          ...(checkpoint.uri ? { checkpointUri: checkpoint.uri } : {}),
          ...(checkpoint.skipped ? { checkpointSkipped: checkpoint.skipped } : {}),
          ...(warnings.length ? { warnings } : {}),
        },
        `noted: "${shownWorkflow}" > ${outcome}${effectiveCategory ? ` (${effectiveCategory}${category ? '' : ', default for a failing note'})` : ''}${shownMissing ? `, missing: ${shownMissing}` : ''}\ntally: ${Object.entries(
          tally,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}${warnings.map((w) => `\n⚠ ${w}`).join('')}`,
      );
    },
  );
}
