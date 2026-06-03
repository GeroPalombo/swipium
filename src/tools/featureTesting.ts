// qa_feature_scope / qa_feature_test_plan / qa_test_feature (SWIPIUM-REQ-03 "MCP Tool Requirements").
// Feature-focused testing from the durable app map: map a natural-language feature request to code +
// runtime + existing tests, model its objective, generate scoped cases, optionally execute a focused
// run, and update the feature map. Thin wrappers — all logic lives in src/featureTesting/* + src/appMap.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { qaNeedsInput } from '../lib/needsInput.js';
import { getDriver } from '../session/attach.js';
import { startProgress } from '../session/progress.js';
import { log } from '../lib/logger.js';
import { runExplore } from '../explore/runner.js';
import { generateSessionReport } from '../services/report.js';
import { buildFeatureIndex, type FeatureIndex } from '../appMap/featureIndex.js';
import { buildFeatureScope, type FeatureScopeResult } from '../featureTesting/featureScope.js';
import { buildMapFeatureScope, type MapFeatureScopeResult } from '../featureTesting/mapFeatureScope.js';
import { buildObjective, type FeatureObjective } from '../featureTesting/objectiveModel.js';
import { buildFeatureTestPlan } from '../featureTesting/testPlan.js';
import { generateFeatureTestCases, type CreativityLevel } from '../featureTesting/testCaseFactory.js';
import { mergeFeatureRun, type MergeNote } from '../featureTesting/resultMerge.js';
import { upsertFeatureCoverage, findFeatureCoverage } from '../featureTesting/featureMap.js';
import { featureCasesToCanonical } from '../featureTesting/suiteBridge.js';
import { bootstrapFeatureExecution } from '../featureTesting/executionBootstrap.js';
import { runtimeScreensFromGraph, loadGraphFromFile, gatherExistingTests } from '../featureTesting/sources.js';
import { buildAppMap } from '../appMap/build.js';
import { applyMerge } from '../testSuite/store.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';

const EMPTY_INDEX: FeatureIndex = { root: '', symbols: [], routes: [], files: [], scannedFiles: 0, truncated: false };

interface ResolvedContext {
  session?: Session;
  root: string;
  appId?: string;
  scopeResult: MapFeatureScopeResult;
  objective: FeatureObjective;
  index: FeatureIndex;
  appMapUri: string;
}

/** Resolve a feature scope + objective from a session or a project root (read-only, no device). */
async function resolveContext(
  server: McpServer,
  sessions: SessionStore,
  args: { sessionId?: string; projectRoot?: string; feature: string; platform?: string; includeCode?: boolean; limit?: number },
): Promise<{ ok: true; ctx: ResolvedContext } | { ok: false; result: ReturnType<typeof qaError> }> {
  let session = args.sessionId ? sessions.get(args.sessionId) : undefined;
  if (args.sessionId && !session) {
    return { ok: false, result: qaError({ what: `Unknown sessionId ${args.sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session / qa_test_this first, or pass projectRoot.'] }) };
  }
  let root = session?.root;
  if (!root) {
    const { resolveProjectRoot } = await import('../context/projectRoot.js');
    const resolved = await resolveProjectRoot(server, args.projectRoot);
    if (!resolved.root) {
      return { ok: false, result: qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot="/abs/path" or a sessionId.'], clientHint: resolved.hint }) };
    }
    root = resolved.root;
  }
  const appId = session?.appId;
  const includeCode = args.includeCode !== false;
  const index = includeCode ? buildFeatureIndex(root) : { ...EMPTY_INDEX, root };

  // Runtime screens from the session's latest exploration graph (if any). When there is no live graph
  // the app-map-first scope service falls back to the durable map's historical runtime screens.
  let runtimeScreens: ReturnType<typeof runtimeScreensFromGraph> = [];
  if (session?.exploration?.graphUri) {
    const found = sessions.findArtifact(session.exploration.graphUri);
    runtimeScreens = runtimeScreensFromGraph(loadGraphFromFile(found?.rec.path));
  }
  const existingTests = gatherExistingTests(root);

  // App-map FIRST (Vision Gap Fix 3): scope from .swipium/app-map.json (features, topology, tickets,
  // persistent suite), falling back to the fresh code index only to fill gaps.
  const scopeResult = buildMapFeatureScope({ root, query: args.feature, index, runtimeScreens, existingTests, platform: args.platform, limit: args.limit });
  const objective = buildObjective(scopeResult.primary);
  return { ok: true, ctx: { session, root, appId, scopeResult, objective, index, appMapUri: scopeResult.appMapUri } };
}

export function registerFeatureTesting(server: McpServer, sessions: SessionStore): void {
  // ---- qa_feature_scope (read-only) ----------------------------------------------------------
  server.registerTool(
    'qa_feature_scope',
    {
      title: 'Feature scope (read-only)',
      description:
        'Map a natural-language feature request (e.g. "weather analysis feature") to the app: ranked code symbols, screens/routes, runtime screens, existing tests, an inferred objective model, risks, coverage gaps, and a recommended test strategy. READ-ONLY — no device, no mutation. Queries the static code index + the latest exploration screen graph + authored flows/test cases. Returns ALL plausible feature candidates with confidence, and asks ONE disambiguation question only when genuinely-different features tie. Pass a sessionId (preferred — adds runtime evidence) or a projectRoot.',
      inputSchema: {
        sessionId: z.string().optional().describe('Session to scope against (adds runtime screen-graph evidence).'),
        projectRoot: z.string().optional().describe('Project root when no session exists (static code scope only).'),
        feature: z.string().describe('The feature to scope, in natural language (e.g. "weather analysis").'),
        platform: z.enum(['android', 'ios']).optional(),
        includeCode: z.boolean().optional().describe('Scan source for code-aware matches (default true).'),
        limit: z.number().optional().describe('Max items per list in the scope (default 8).'),
      },
    },
    async ({ sessionId, projectRoot, feature, platform, includeCode, limit }) => {
      const r = await resolveContext(server, sessions, { sessionId, projectRoot, feature, platform, includeCode, limit });
      if (!r.ok) return r.result;
      const { scopeResult, objective, index } = r.ctx;
      const scope = scopeResult.primary;

      if (!scopeResult.found) {
        return qaOk(
          {
            sessionId: sessionId ?? null,
            feature,
            found: false,
            scope,
            searched: scopeResult.searched,
            nextRecommendedAction: { tool: 'qa_test_this', args: { ...(sessionId ? { sessionId } : { projectRoot: r.ctx.root }), goal: 'explore' }, why: 'Grow the map with an initial run, then re-scope the feature' },
          },
          `🔎 No feature matched "${feature}". Searched ${scopeResult.searched.symbols} symbols, ${scopeResult.searched.routes} routes, ${scopeResult.searched.files} files, ${scopeResult.searched.runtimeScreens} runtime screens with terms: ${scopeResult.searched.terms.slice(0, 12).join(', ')}. Run qa_test_this/qa_explore to grow coverage, or refine the feature name.`,
        );
      }

      if (scopeResult.needsInput) {
        return qaNeedsInput(
          {
            needsInput: true,
            kind: 'monorepo_target',
            question: scopeResult.needsInput.question,
            fields: [{ name: 'feature', description: 'The exact feature to test', example: scopeResult.candidates[0]?.title }],
            fallbackOptions: scopeResult.needsInput.options,
            resume: { tool: 'qa_feature_scope', args: {} },
            attempted: [`scoped "${feature}" — matched ${scopeResult.candidates.length} distinct candidates that tie`],
            ifDeclined: 'Swipium scopes the highest-confidence candidate and records the others as alternatives.',
          },
          { sessionId: sessionId ?? undefined, candidates: scopeResult.candidates },
        );
      }

      const nextRecommendedAction =
        scope.recommendedStrategy === 'manual_blocked'
          ? { tool: 'qa_feature_test_plan', args: { ...(sessionId ? { sessionId } : { projectRoot: r.ctx.root }), feature }, why: 'Review the plan + setup needed before any automated execution' }
          : { tool: 'qa_test_feature', args: { sessionId: sessionId ?? '${sessionId}', feature, mode: 'execute' }, why: 'Run a focused test of this feature' };

      return qaOk(
        {
          sessionId: sessionId ?? null,
          feature,
          found: true,
          scope,
          objective,
          appMapUri: r.ctx.appMapUri,
          mapFeatureId: scopeResult.mapFeatureId ?? null,
          ticketRefs: scopeResult.ticketRefs,
          runtimeSource: scopeResult.runtimeSource,
          candidates: scopeResult.candidates,
          searched: scopeResult.searched,
          codeIndex: { scannedFiles: index.scannedFiles, truncated: index.truncated },
          nextRecommendedAction,
        },
        `🔎 ${scope.title} (confidence ${Math.round(scope.confidence * 100)}%, strategy ${scope.recommendedStrategy}) — ` +
          `${scope.staticScreens.length} static screen(s), ${scope.runtimeScreens.length} runtime screen(s), ${scope.functions.length} symbol(s), ${scope.existingTests.length} existing test(s).` +
          (scopeResult.candidates.length > 1 ? ` ${scopeResult.candidates.length} candidate(s).` : ''),
      );
    },
  );

  // ---- qa_feature_test_plan (read-only) ------------------------------------------------------
  server.registerTool(
    'qa_feature_test_plan',
    {
      title: 'Feature test plan (read-only)',
      description:
        'Generate a read-only test plan for a feature: the resolved scope + objective, generated test cases (linked to featureId + map screens), required fixtures, risks, automation readiness, and the EXACT ordered execution plan. Useful before execution and for PR review. No device, no mutation.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        feature: z.string().describe('The feature to plan, in natural language.'),
        platform: z.enum(['android', 'ios']).optional(),
        creativity: z.enum(['conservative', 'standard', 'creative', 'adversarial']).optional().describe('Case ambition: conservative=happy path; standard(default)=+validation/empty/error; creative=+boundary/offline/interruption; adversarial=+destructive (consent-gated).'),
        allowAdversarial: z.boolean().optional().describe('Include destructive/high-impact cases (requires consent + disposable state at run time). Default false.'),
        includeCode: z.boolean().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ sessionId, projectRoot, feature, platform, creativity, allowAdversarial, includeCode, limit }) => {
      const r = await resolveContext(server, sessions, { sessionId, projectRoot, feature, platform, includeCode, limit });
      if (!r.ok) return r.result;
      const { scopeResult, objective } = r.ctx;
      if (!scopeResult.found) {
        return qaOk({ sessionId: sessionId ?? null, feature, found: false, searched: scopeResult.searched }, `No feature matched "${feature}" — nothing to plan. Searched terms: ${scopeResult.searched.terms.slice(0, 12).join(', ')}.`);
      }
      const plan = buildFeatureTestPlan(scopeResult.primary, objective, { creativity: creativity as CreativityLevel | undefined, platform, allowAdversarial, sessionId });
      return qaOk(
        { sessionId: sessionId ?? null, feature, found: true, plan, candidates: scopeResult.candidates },
        `📋 ${plan.title} plan: ${plan.cases.length} case(s), readiness ${plan.automationReadiness}, ${plan.requiredFixtures.length} fixture(s)${plan.blockers.length ? `, ${plan.blockers.length} blocker(s)` : ''}.`,
      );
    },
  );

  // ---- qa_test_feature (plan | execute | interactive) ----------------------------------------
  server.registerTool(
    'qa_test_feature',
    {
      title: 'Test a feature (focused)',
      description:
        'Run a focused test of a named feature. mode:"plan" (default) returns the scope + objective + generated cases + execution plan (read-only). mode:"execute" runs a focused exploration toward the feature\'s best entry point as a background JOB — it generates cases, records pass/fail/blocked per case, updates the durable feature map, and generates a report (poll qa_job_status for the terminal result: reportUri, map delta, cases, blockers). Execute requires a prepared device session (run qa_test_this { mode:"execute" } first). Honest: a feature gated by auth/paywall/permission/missing-fixture returns blocked with setup guidance, not a false failure.',
      inputSchema: {
        sessionId: z.string().optional().describe('Prepared session. If omitted in execute/interactive, Swipium bootstraps a device from projectRoot (same path as qa_test_this).'),
        projectRoot: z.string().optional().describe('Project root — used for plan mode and to bootstrap a device in execute/interactive when no sessionId is given.'),
        feature: z.string().describe('The feature to test, in natural language.'),
        mode: z.enum(['plan', 'execute', 'interactive']).optional().describe('plan (default) | execute (focused run as a job) | interactive (run until the first question).'),
        platform: z.enum(['android', 'ios']).optional(),
        device: z.string().optional().describe('Specific device/simulator serial or udid to prepare when bootstrapping from projectRoot.'),
        consentId: z.string().optional().describe('Consent id for the privileged boot/install/launch steps when bootstrapping a device.'),
        approve: z.boolean().optional().describe('Approve the bootstrap consent request (paired with consentId).'),
        creativity: z.enum(['conservative', 'standard', 'creative', 'adversarial']).optional(),
        allowAdversarial: z.boolean().optional(),
        maxScreens: z.number().optional().describe('Max distinct screens for the focused exploration (default 8).'),
        maxActions: z.number().optional().describe('Max actions for the focused exploration (default 20).'),
        timeoutMs: z.number().optional(),
        generateCases: z.boolean().optional().describe('Generate test cases (default true).'),
        includeCode: z.boolean().optional(),
        limit: z.number().optional(),
      },
    },
    async (args) => {
      const { sessionId, projectRoot, feature, mode, platform, creativity, allowAdversarial, maxScreens, maxActions, generateCases, includeCode, limit } = args;
      const effectiveMode = mode ?? 'plan';

      // PLAN mode: pure, read-only — same as qa_feature_test_plan but under the action tool name.
      if (effectiveMode === 'plan') {
        const r = await resolveContext(server, sessions, { sessionId, projectRoot, feature, platform, includeCode, limit });
        if (!r.ok) return r.result;
        const { scopeResult, objective } = r.ctx;
        if (!scopeResult.found) return qaOk({ sessionId: sessionId ?? null, feature, found: false, searched: scopeResult.searched }, `No feature matched "${feature}".`);
        if (scopeResult.needsInput) {
          return qaNeedsInput(
            { needsInput: true, kind: 'monorepo_target', question: scopeResult.needsInput.question, fields: [{ name: 'feature', example: scopeResult.candidates[0]?.title }], fallbackOptions: scopeResult.needsInput.options, resume: { tool: 'qa_test_feature', args: { mode: 'plan' } }, attempted: [`scoped "${feature}" — multiple candidates tie`], ifDeclined: 'Swipium plans the highest-confidence candidate.' },
            { sessionId: sessionId ?? undefined, candidates: scopeResult.candidates },
          );
        }
        const plan = buildFeatureTestPlan(scopeResult.primary, objective, { creativity: creativity as CreativityLevel | undefined, platform, allowAdversarial, sessionId, maxScreens, maxActions });
        return qaOk({ sessionId: sessionId ?? null, feature, mode: 'plan', found: true, plan }, `📋 ${plan.title}: ${plan.cases.length} case(s), readiness ${plan.automationReadiness}. To run it: qa_test_feature { mode:"execute" }.`);
      }

      // EXECUTE / INTERACTIVE: reuse a prepared session, else BOOTSTRAP one from projectRoot using
      // the same resolver/planner/prepare path as qa_test_this (Fix Group 4) — so "test the weather
      // feature" works even when the first instruction is feature-focused.
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) {
        return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Omit sessionId to bootstrap from projectRoot, or pass a valid session.'] });
      }
      let driver = session ? (await getDriver(session)).driver : undefined;
      if (!session || !driver) {
        const boot = await bootstrapFeatureExecution({ server, sessions, projectRoot, feature, platform, device: args.device as string | undefined, consentId: args.consentId as string | undefined, approve: args.approve as boolean | undefined });
        if (!boot.ok) return boot.result;
        session = boot.session;
        driver = boot.driver;
      }
      const r = await resolveContext(server, sessions, { sessionId: session.id, feature, platform, includeCode, limit });
      if (!r.ok) return r.result;
      const { scopeResult } = r.ctx;
      if (!scopeResult.found) {
        return qaOk({ sessionId: session.id, feature, mode: effectiveMode, found: false, searched: scopeResult.searched }, `No feature matched "${feature}" — nothing to execute. Searched: ${scopeResult.searched.terms.slice(0, 10).join(', ')}.`);
      }
      if (scopeResult.needsInput) {
        return qaNeedsInput(
          { needsInput: true, kind: 'monorepo_target', question: scopeResult.needsInput.question, fields: [{ name: 'feature', example: scopeResult.candidates[0]?.title }], fallbackOptions: scopeResult.needsInput.options, resume: { tool: 'qa_test_feature', args: { sessionId: session.id, mode: effectiveMode } }, attempted: [`scoped "${feature}" — multiple candidates tie`], ifDeclined: 'Swipium tests the highest-confidence candidate.' },
          { sessionId: session.id, candidates: scopeResult.candidates },
        );
      }

      const job = sessions.createJob(session, `test_feature:${effectiveMode}`);
      void runFeatureTestJob(sessions, session, job, {
        feature,
        scopeResult,
        objective: r.ctx.objective,
        mode: effectiveMode,
        platform,
        creativity: creativity as CreativityLevel | undefined,
        allowAdversarial: !!allowAdversarial,
        maxScreens,
        maxActions,
        generateCases: generateCases !== false,
        stopOnAuth: effectiveMode === 'interactive',
      });
      return qaOk(
        { sessionId: session.id, state: 'running', mode: effectiveMode, jobId: job.jobId, kind: job.kind, feature, featureId: scopeResult.primary.featureId, appMapUri: r.ctx.appMapUri, mapFeatureId: scopeResult.mapFeatureId ?? null },
        `🎯 focused test of "${scopeResult.primary.title}" started as job ${job.jobId}. Poll qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" } for the report, map delta, cases, and blockers.`,
      );
    },
  );
}

interface FeatureTestJobArgs {
  feature: string;
  scopeResult: FeatureScopeResult;
  objective: FeatureObjective;
  mode: 'execute' | 'interactive';
  platform?: 'android' | 'ios';
  creativity?: CreativityLevel;
  allowAdversarial: boolean;
  maxScreens?: number;
  maxActions?: number;
  generateCases: boolean;
  stopOnAuth: boolean;
}

/** Focused feature run: targeted exploration → record cases → merge into the feature map → report. */
async function runFeatureTestJob(sessions: SessionStore, session: Session, job: JobRecord, a: FeatureTestJobArgs): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const prog = startProgress(sessions, session, job, 'exploring', { statusText: `Focusing tests on "${a.scopeResult.primary.title}".`, nextExpected: 'Navigate to the feature and exercise it.' });
  const scope = a.scopeResult.primary;
  const notesBefore = session.notes.length;
  try {
    const { driver } = await getDriver(session);
    if (!driver) {
      upd({ status: 'failed', error: 'no driver', resultText: '❌ no driver bound', endedAt: Date.now() });
      return;
    }

    // 1. Targeted exploration toward the feature objective (prioritizes feature-named screens).
    const ex = await runExplore(
      sessions,
      session,
      driver,
      { goal: scope.title, strategy: 'hybrid', stopOnAuth: a.stopOnAuth, maxScreens: a.maxScreens ?? 8, maxActions: a.maxActions ?? 20 },
      { signal, onProgress: (p) => prog.event(p) },
    );
    if (signal?.aborted) return;

    // 2. Persist the screen graph artifact + harvest runtime screens visited.
    const at = Date.now();
    const generatedAt = new Date(at).toISOString();
    const serialized = ex.graph.serialize(generatedAt);
    const graphUri = sessions.saveArtifact(session, 'explore', `feature-graph-${at}.json`, JSON.stringify(serialized, null, 2), 'application/json', `feature graph: ${scope.title}`);
    sessions.setExploration(session, { at, graphUri, state: ex.state, stoppedReason: ex.stoppedReason, summary: ex.summary });
    prog.done(`explored ${ex.summary.screensVisited} screens for ${scope.title}`);

    // Re-scope against the fresh runtime graph so cases link to the newly-observed screens.
    const runtimeScreens = runtimeScreensFromGraph(serialized);
    const rescoped = buildFeatureScope({ query: a.feature, index: { root: session.root, symbols: [], routes: [], files: [], scannedFiles: 0, truncated: false }, runtimeScreens, existingTests: scope.existingTests, platform: a.platform });
    const liveScope = rescoped.found ? { ...scope, runtimeScreens: rescoped.primary.runtimeScreens } : scope;

    // 3. Generate cases + merge the run's notes/blockers into them and the feature map.
    const cases = a.generateCases ? generateFeatureTestCases(liveScope, a.objective, { creativity: a.creativity, platform: a.platform, allowAdversarial: a.allowAdversarial }) : [];
    const newNotes = session.notes.slice(notesBefore);
    const mergeNotes: MergeNote[] = newNotes.map((n) => ({ workflow: n.workflow, outcome: n.outcome, reason: n.reason, recommendedSetup: n.recommendedSetup, artifactUris: n.artifactUris }));
    const visited = serialized.nodes.map((n) => n.id);
    const blocked = ex.state === 'blocked' || !!ex.needsInput;
    const blockReason = ex.needsInput?.question ?? (blocked ? ex.stoppedReason : undefined);
    const prior = findFeatureCoverage(session.root, session.appId, liveScope.featureId);
    const merge = mergeFeatureRun(
      liveScope,
      cases,
      { notes: mergeNotes, visitedRuntimeScreens: visited, evidence: [graphUri], exploration: { state: ex.state, stoppedReason: ex.stoppedReason, screensVisited: ex.summary.screensVisited }, blocked, blockReason, blockGuidance: ex.needsInput?.ifDeclined },
      prior,
    );

    // 4. Refresh the DERIVED feature-coverage cache (Fix 11 — disposable; the durable truth is the app
    //    map + persistent suite written below) + a readable cases artifact.
    const mapPath = upsertFeatureCoverage(session.root, session.appId, merge.coverage);
    const casesUri = sessions.saveArtifact(session, 'feature', `cases-${liveScope.featureId}-${at}.json`, JSON.stringify({ featureId: liveScope.featureId, title: liveScope.title, objective: a.objective, cases: merge.cases }, null, 2), 'application/json', `feature cases: ${liveScope.title}`);

    // 4a. SOURCE-OF-TRUTH UPDATES (Fix Group 3): fold the focused run into the durable App Knowledge
    //     Map (runtime↔static links + feature coverage) and the persistent test suite, so canonical
    //     facts never live only under .swipium/feature-map.
    let appMapUri: string | undefined;
    try {
      const built = buildAppMap(session.root, { mode: 'runtime_merge', at: generatedAt, sessionId: session.id, exploreGraph: serialized, persist: true });
      appMapUri = built.save?.resourceUri;
    } catch (e) {
      log('warn', 'feature test app-map update failed', { jobId: job.jobId, err: String(e) });
    }
    let suiteWritten: string[] = [];
    try {
      const canonical = featureCasesToCanonical(merge.cases, liveScope, generatedAt, a.platform);
      if (canonical.length) {
        const applied = applyMerge(session.root, canonical, { source: 'feature', mode: 'update', now: generatedAt, runId: `feature-${at}`, sourceUri: casesUri }, session.appId);
        suiteWritten = applied.written;
      }
    } catch (e) {
      log('warn', 'feature test suite merge failed', { jobId: job.jobId, err: String(e) });
    }

    // 5. Report.
    let reportUri: string | undefined;
    try {
      const rep = await generateSessionReport(sessions, session, { format: 'summary', includeCurrentDump: true });
      reportUri = rep.reportUri;
    } catch (e) {
      log('warn', 'feature test report generation failed', { err: String(e) });
    }

    const state = blocked ? 'blocked' : merge.delta.casesFailed > 0 ? 'completed_with_findings' : 'completed';
    const nextRecommendedAction = blocked
      ? { tool: 'qa_continue_from_blocker', args: { sessionId: session.id, kind: 'credentials' }, why: 'Provide setup to unblock the feature, then re-run qa_test_feature' }
      : reportUri
        ? { tool: 'qa_get_artifact', args: { uri: reportUri }, why: 'Open the focused feature report' }
        : { tool: 'qa_report', args: { sessionId: session.id }, why: 'Summarize the focused run' };

    upd({
      status: blocked ? 'failed' : 'done',
      progress: state,
      result: {
        state,
        feature: a.feature,
        featureId: liveScope.featureId,
        title: liveScope.title,
        scope: liveScope,
        objective: a.objective,
        cases: merge.cases,
        mapDelta: merge.delta,
        coverage: merge.coverage,
        blockers: merge.coverage.blockers,
        graphUri,
        casesUri,
        reportUri: reportUri ?? null,
        appMapUri: appMapUri ?? null,
        suiteWritten,
        featureCoverageCachePath: mapPath,
        needsInput: ex.needsInput ?? null,
        nextRecommendedAction,
      },
      resultText:
        `🎯 feature test ${state} — ${liveScope.title}: ${merge.delta.summary}\n` +
        `cases: ${merge.cases.length} (${merge.delta.casesPassed} pass / ${merge.delta.casesFailed} fail / ${merge.delta.casesBlocked} blocked); map: ${merge.delta.statusBefore ?? 'new'} → ${merge.delta.statusAfter}\n` +
        (reportUri ? `report: ${reportUri}\n` : '') +
        (appMapUri ? `appMap: ${appMapUri}\n` : '') +
        `featureCoverageCache: ${mapPath}` +
        (ex.needsInput ? `\n❓ ${ex.needsInput.question}` : ''),
      endedAt: Date.now(),
    });
  } catch (e) {
    if (signal?.aborted) return;
    log('error', 'feature test job failed', { jobId: job.jobId, err: String(e) });
    upd({ status: 'failed', error: String(e), resultText: `❌ feature test error: ${String(e)}`, endedAt: Date.now() });
  }
}
