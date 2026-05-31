// qa_explore (Phase 3.3) — bounded, safe-by-default guided exploration as a background job. Drives
// the runExplore service: observe → rank safe candidates → act → health → graph, writing a screen
// graph artifact (JSON + Markdown) and recording qa_note outcomes. Returns a running jobId; the
// terminal state + graphUri land in the job result (poll qa_job_status). Thin wrapper — all logic
// is in src/explore/*.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { getDriver } from '../session/attach.js';
import { runExplore } from '../explore/runner.js';
import { appendExploreMemory } from '../explore/memory.js';
import { buildAppMap } from '../appMap/build.js';
import { mergeFromExploration } from '../services/testSuiteKnowledge.js';
import { hasDisposableState } from '../fixtures/catalog.js';
import { generateAndCompileSuite, type SuiteGenerationResult } from '../services/suiteGenerate.js';
import { startProgress } from '../session/progress.js';
import { log } from '../lib/logger.js';
import type { Session, SessionStore, JobRecord, ExplorationRecord, RecordedAction } from '../session/store.js';
import type { ExploreGraph } from '../explore/graph.js';
import type { SuitePromotionCandidate } from '../explore/suite.js';

const HIGH_IMPACT_CONFIRMATION_CLASSES = new Set([
  'payment',
  'message_send',
  'external_invite',
  'account_delete',
  'bulk_delete',
  'permission_change',
  'data_export',
  'generic_destructive',
]);

function needsHighImpactConfirmation(riskClass: string | undefined): boolean {
  return !!riskClass && HIGH_IMPACT_CONFIRMATION_CLASSES.has(riskClass);
}

function promotedActionsFor(session: Session, graph: ExploreGraph, promotions: SuitePromotionCandidate[]): RecordedAction[] {
  const promoted = promotions.find((p) => p.status === 'promote');
  if (!promoted) return [];
  const edges = graph.allEdges();
  const used = new Set<number>();
  const actions: RecordedAction[] = [];
  for (let i = 0; i < promoted.path.length - 1; i++) {
    const from = promoted.path[i];
    const to = promoted.path[i + 1];
    const edge = edges.find((e) => e.from === from && e.to === to && e.outcome === 'changed_screen');
    const locatorValue = edge?.action.locator?.value;
    if (!edge || typeof locatorValue !== 'string') continue;
    const idx = session.recordedActions.findIndex((a, actionIdx) => (
      !used.has(actionIdx) &&
      a.action === edge.action.type &&
      a.selector === locatorValue &&
      a.provenance?.originalScreenSignature === edge.preActionState
    ));
    if (idx >= 0) {
      used.add(idx);
      actions.push(session.recordedActions[idx]);
    }
  }
  return actions;
}

export function registerExplore(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_explore',
    {
      title: 'Guided exploration',
      description:
        'Explore a launched app like a practical QA engineer: bounded, safe-by-default crawl that observes screens, ranks safe actions, taps them, checks health after each, and builds a SCREEN GRAPH (JSON + Markdown artifacts). Skips destructive actions (delete/pay/send/logout) in strict mode; verifies map/canvas screens visually with qa_assert_visual; stops with NeedsInput on an auth wall when credentials are missing. Records durable taps so qa_suite_generate can promote paths. Runs as a JOB — the terminal state (completed/blocked) + graphUri are in the job result (poll qa_job_status). Requires a prepared device (qa_test_this / qa_prepare_target first).',
      inputSchema: {
        sessionId: z.string(),
        goal: z.string().optional().describe('Optional natural-language focus (e.g. "exercise the main tabs").'),
        depth: z.number().optional().describe('Max navigation depth (default 3).'),
        maxActions: z.number().optional().describe('Max actions to try (default 20).'),
        maxScreens: z.number().optional().describe('Max distinct screens to visit (default 12).'),
        maxDurationMs: z.number().optional(),
        strategy: z.enum(['crawl', 'task_planner', 'hybrid']).optional().describe('crawl (default): deterministic screen crawl; task_planner: infer semantic QA tasks before acting; hybrid: task planning plus crawl.'),
        safeMode: z.enum(['strict', 'balanced', 'dry_run_destructive', 'approved_destructive_candidate', 'approved_destructive']).optional().describe('strict (default): safe actions only; balanced: unknown-risk allowed; dry_run_destructive: discover/list destructive candidates without tapping; approved_destructive_candidate: allow exactly one candidate-bound destructive action. approved_destructive is deprecated and refused.'),
        destructiveCandidate: z
          .object({
            screenSignature: z.string(),
            candidateSignature: z.string(),
            label: z.string().optional(),
            locator: z.object({ strategy: z.string().optional(), value: z.string().optional() }).optional(),
            riskClass: z.string().optional(),
          })
          .optional()
          .describe('Exact candidate returned by a dry_run_destructive exploration. Required with safeMode approved_destructive_candidate.'),
        confirmHighImpact: z.boolean().optional().describe('Required true for high-impact destructive candidates such as payment, send/share, permission change, account delete, or bulk delete.'),
        generateSuite: z.boolean().optional().describe('After exploration, score promotable paths and include suite-promotion guidance.'),
        includeTextEntry: z.boolean().optional().describe('Allow typing into fields (only with a value source — default false).'),
        stopOnAuth: z.boolean().optional().describe('Return NeedsInput when an auth wall blocks exploration and credentials are missing (default true).'),
        accountCycle: z
          .boolean()
          .optional()
          .describe('SWIPIUM-REQ-07 controlled account-cycle workflow: on a DISPOSABLE generated account, permit LOGOUT (and only logout) as an expected step; delete/pay/send stay refused. Requires allowGeneratedData. Off by default.'),
        allowGeneratedData: z.boolean().optional().describe('Allow safe generated disposable-account data (test/staging) — required to use accountCycle.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, goal, depth, maxActions, maxScreens, maxDurationMs, strategy, safeMode, destructiveCandidate, confirmHighImpact, generateSuite, includeTextEntry, stopOnAuth, accountCycle, allowGeneratedData, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
      const { driver } = await getDriver(session);
      if (!driver) {
        return qaError({ what: 'No device attached to this session', changedState: false, retrySafe: true, nextSteps: ['Prepare a device first: qa_test_this { mode:"execute" } or qa_prepare_target, then qa_explore.'] });
      }

      if (safeMode === 'approved_destructive') {
        return qaError({
          what: 'Blanket destructive exploration approval has been removed',
          changedState: false,
          retrySafe: false,
          failureCode: 'DESTRUCTIVE_REFUSED',
          nextSteps: ['Run qa_explore with safeMode:"dry_run_destructive" to discover candidates, then approve one exact candidate with safeMode:"approved_destructive_candidate" and disposable test state.'],
        });
      }

      let destructiveApproval: Parameters<typeof runExplore>[3]['destructiveApproval'];
      if (safeMode === 'approved_destructive_candidate') {
        if (!destructiveCandidate) {
          return qaError({
            what: 'approved_destructive_candidate requires an exact destructiveCandidate',
            changedState: false,
            retrySafe: false,
            failureCode: 'DESTRUCTIVE_REFUSED',
            nextSteps: ['Run safeMode:"dry_run_destructive" first and copy one candidate signature/screen/locator into destructiveCandidate.'],
          });
        }
        if (!hasDisposableState(session)) {
          return qaError({
            what: 'Destructive exploration requires disposable test state',
            changedState: false,
            retrySafe: false,
            failureCode: 'MISSING_FIXTURE',
            nextSteps: ['Declare a fixture with disposable:true or environment:"test" before approving delete/pay/send/logout workflows.'],
          });
        }
        if (needsHighImpactConfirmation(destructiveCandidate.riskClass) && confirmHighImpact !== true) {
          return qaError({
            what: `High-impact destructive candidate "${destructiveCandidate.label ?? destructiveCandidate.candidateSignature}" requires confirmHighImpact:true`,
            changedState: false,
            retrySafe: false,
            failureCode: 'DESTRUCTIVE_REFUSED',
            nextSteps: ['Re-run with confirmHighImpact:true only if this is disposable test state and the action can be safely verified or rolled back.'],
          });
        }
        const approval = {
          sessionId: session.id,
          ...destructiveCandidate,
          consentId,
          confirmHighImpact: confirmHighImpact === true,
          expiresAt: Date.now() + 5 * 60_000,
          singleUse: true,
          requiresDisposableState: true,
        };
        const affects = {
          sessionId: session.id,
          screenSignature: destructiveCandidate.screenSignature,
          candidateSignature: destructiveCandidate.candidateSignature,
          label: destructiveCandidate.label ?? null,
          locator: destructiveCandidate.locator ?? null,
          riskClass: destructiveCandidate.riskClass ?? null,
          confirmHighImpact: confirmHighImpact === true,
          requiresDisposableState: true,
        };
        const gate = consumeConsent(consentId, approve, { action: 'destructive_ui_candidate', affects });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_explore',
            action: 'destructive_ui_candidate',
            risk: 'high',
            target: affects,
            consent: { required: true, approved: false },
            status: 'requested',
          });
          return requireConsent({
            action: 'destructive_ui_candidate',
            risk: 'high',
            affects,
            explain:
              `Approve exactly one destructive exploration candidate (${destructiveCandidate.label ?? destructiveCandidate.candidateSignature}) on the current screen signature? ` +
              'This approval is single-use, expires quickly, and requires disposable test state.',
          });
        }
        sessions.addEnvChange(session, `CONSENT destructive candidate ${destructiveCandidate.candidateSignature} on ${destructiveCandidate.screenSignature}`);
        sessions.recordMutation(session, {
          tool: 'qa_explore',
          action: 'destructive_ui_candidate',
          risk: 'high',
          target: affects,
          consent: { required: true, consentId, approved: true },
          status: 'approved',
        });
        destructiveApproval = approval;
      }

      const accountCycleCtx = accountCycle ? { enabled: true, disposableAccount: allowGeneratedData === true } : undefined;
      const job = sessions.createJob(session, 'explore');
      void runExploreJob(sessions, session, job, { goal, depth, maxActions, maxScreens, maxDurationMs, strategy, safeMode, destructiveApproval, generateSuite, includeTextEntry, stopOnAuth, accountCycle: accountCycleCtx, allowGeneratedData });
      return qaOk(
        { sessionId: session.id, state: 'running', jobId: job.jobId, kind: job.kind },
        `🧭 guided exploration started as job ${job.jobId}. Poll qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" } for the screen graph + terminal state.`,
      );
    },
  );
}

async function runExploreJob(
  sessions: SessionStore,
  session: Session,
  job: JobRecord,
  opts: Parameters<typeof runExplore>[3],
): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const prog = startProgress(sessions, session, job, 'exploring', { statusText: 'Exploring the app safely.', nextExpected: 'Build a screen graph.' });
  try {
    const { driver } = await getDriver(session);
    if (!driver) {
      upd({ status: 'failed', error: 'no driver', endedAt: Date.now() });
      return;
    }
    const res = await runExplore(sessions, session, driver, opts, { signal, onProgress: (p) => prog.event(p) });
    if (signal?.aborted) return;

    // Persist the screen graph as JSON + Markdown artifacts.
    const at = Date.now();
    const generatedAt = new Date(at).toISOString();
    const serializedGraph = res.graph.serialize(generatedAt);
    const graphUri = sessions.saveArtifact(session, 'explore', `graph-${at}.json`, JSON.stringify(serializedGraph, null, 2), 'application/json', 'exploration screen graph');
    const graphMdUri = sessions.saveArtifact(session, 'explore', `graph-${at}.md`, res.graph.toMarkdown(new Date(at).toISOString()), 'text/markdown', 'exploration screen graph (readable)');
    const historyPath = appendExploreMemory(session.root, session.appId, {
      appId: session.appId ?? 'unknown-app',
      sessionId: session.id,
      at: generatedAt,
      graphUri,
      graphMdUri,
      stoppedReason: res.stoppedReason,
      state: res.state,
      summary: res.summary,
      tasks: serializedGraph.tasks,
      hypotheses: serializedGraph.hypotheses,
      coverageClaims: serializedGraph.coverageClaims,
      blockedPreconditions: serializedGraph.blockedPreconditions,
      reflection: serializedGraph.reflection,
    });
    const promotedActions = opts.generateSuite ? promotedActionsFor(session, res.graph, res.suitePromotion) : [];
    const generatedSuite: SuiteGenerationResult | undefined = opts.generateSuite
      ? promotedActions.length
        ? generateAndCompileSuite(sessions, session, { name: 'explore-promoted', actions: promotedActions, save: true, compile: true })
        : {
            skipped: true,
            skippedReason: res.suitePromotion.some((p) => p.status === 'promote') ? 'promoted path did not map to recorded replay actions' : 'no promoted exploration path met the replay threshold',
            recommendation: 'Review suitePromotion reasons, improve locator readiness, then run qa_suite_generate after replayable actions are recorded.',
            written: [],
            compiledFlows: [],
            suiteRunnable: false,
            readinessLabels: [],
          }
      : undefined;
    const record: ExplorationRecord = { at, graphUri, graphMdUri, state: res.state, stoppedReason: res.stoppedReason, summary: res.summary };
    sessions.setExploration(session, record);
    // SWIPIUM-REQ-01: merge this exploration into the durable App Knowledge Map by default. Best-effort
    // — a map failure must never fail the exploration job.
    try {
      buildAppMap(session.root, { mode: 'runtime_merge', at: generatedAt, sessionId: session.id, exploreGraph: serializedGraph, persist: true });
    } catch (e) {
      log('warn', 'app map merge after explore failed', { jobId: job.jobId, err: String(e) });
    }
    // Fix 9: keep the persistent suite current directly after exploration — don't wait for a later
    // qa_report. Best-effort: a suite-merge failure is a warning, never an exploration failure.
    const suiteMerge = mergeFromExploration(session.root, record, { source: 'exploration', now: generatedAt, runId: `explore-${at}`, sourceUri: graphUri, appId: session.appId, sessionId: session.id });
    prog.done(`explored ${res.summary.screensVisited} screens`);

    const nextRecommendedAction = res.needsInput
      ? { tool: 'qa_continue_from_blocker', args: { sessionId: session.id, kind: 'credentials' }, why: 'Provide credentials to explore authenticated screens' }
      : { tool: 'qa_report', args: { sessionId: session.id }, why: 'Summarize the exploration with the screen graph' };

    upd({
      status: 'done',
      progress: res.state,
      result: {
        state: res.state,
        stoppedReason: res.stoppedReason,
        summary: res.summary,
        destructiveCandidates: res.destructiveCandidates,
        graphUri,
        graphMdUri,
        historyPath,
        needsInput: res.needsInput ?? null,
        suitePromotion: res.suitePromotion,
        generatedSuite: generatedSuite ?? null,
        suiteDelta: suiteMerge.delta ?? null,
        suiteUri: suiteMerge.suiteUri ?? null,
        suiteWarning: suiteMerge.warning ?? null,
        nextRecommendedAction,
      },
      resultText:
        `🧭 exploration ${res.state} — ${res.summary.screensVisited} screens, ${res.summary.actionsTried} actions, ${res.summary.workflowsFound} transitions, ${res.summary.visualOnlyScreens} visual-only, ${res.summary.unsafeActionsSkipped} unsafe skipped, ${res.summary.appErrors} app errors.\n` +
        `reason: ${res.stoppedReason}\ngraph: ${graphUri}` +
        (generatedSuite && !generatedSuite.skipped ? `\npromoted suite: ${generatedSuite.name}` : '') +
        (res.needsInput ? `\n❓ ${res.needsInput.question}` : ''),
      endedAt: Date.now(),
    });
  } catch (e) {
    if (signal?.aborted) return;
    log('error', 'explore job failed', { jobId: job.jobId, err: String(e) });
    upd({ status: 'failed', error: String(e), resultText: `❌ exploration error: ${String(e)}`, endedAt: Date.now() });
  }
}
