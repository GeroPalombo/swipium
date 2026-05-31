// Report service (Phase 3.2 Milestone B) — the session-report assembly, extracted from the
// qa_report tool so qa_test_this execute can produce a real report artifact in EVERY terminal
// state (completed or blocked), not just tell the agent to call qa_report. qa_report is now a thin
// wrapper around generateSessionReport().

import { existsSync, writeFileSync } from 'node:fs';
import { makeRedactor } from '../lib/redact.js';
import { getDriver } from '../session/attach.js';
import { restoreNetwork } from '../tools/network.js';
import { releaseAssessment } from '../report/summary.js';
import { FAILURES, failureForFindingKind, bucketForNoteCategory, ALL_BUCKETS, type FailureBucket } from '../oracle/failures.js';
import { inlinePrSummary, toMarkdown, toJUnit, toPlaywrightJson, type ReportData } from '../report/export.js';
import { generateFlow } from '../flows/generate.js';
import { loadProjectConfig } from '../cli/scan.js';
import { activeRecording } from '../tools/screenRecord.js';
import { phaseTimingsForSession } from '../report/timing.js';
import { automationBackendForSession, coverageForSession } from '../report/coverage.js';
import { buildSessionArtifactManifest } from '../report/artifactManifest.js';
import { buildPrSummary } from '../report/history.js';
import { WdaDriver } from '../drivers/WdaDriver.js';
import { checkWda } from '../lib/wda.js';
import { loadWdaConfig } from '../lib/wdaConfig.js';
import { wdaRecommendations, wdaTimingSummary } from '../lib/wdaTune.js';
import { automationReadinessForSession, orderReadinessLabels, readinessForSession } from '../report/readiness.js';
import type { ReadinessLabel } from '../report/readiness.js';
import { deriveQaLevel } from '../report/qaLevel.js';
import { buildRunTestCatalog } from '../report/testCatalog.js';
import { evidenceTaxonomyForNotes } from '../report/evidence.js';
import { buildAppMap } from '../appMap/build.js';
import { appMapPath } from '../appMap/store.js';
import { foldRunIntoLedger, type BridgeFinding, type BridgeNote } from '../issues/reportBridge.js';
import { buildReportIssuesSection, issuesSectionToMarkdown } from '../issues/report.js';
import { resolveSourceRevision } from '../issues/sourceRevision.js';
import { loadPolicy as loadIssuePolicy, getIndex as getIssueIndex, readEvents as readIssueEvents } from '../issues/store.js';
import { computeIssueMetrics } from '../issues/metrics.js';
import { verifyFixed } from '../issues/index.js';
import { linkIssueToCase, linkRunIssue, relationshipForCase, runRelationshipFor, verifiedFixedIssuesForRun } from '../testSuite/issueLinks.js';
import { saveSuite } from '../testSuite/store.js';
import type { IssueEnvironment, IssuePlatform } from '../issues/schema.js';
import { pomForSession } from './suiteGenerate.js';
import { generateCanonicalCases } from '../testSuite/generator.js';
import { applyMerge, loadSuite, suiteDelta, runIdFromNow } from '../testSuite/store.js';
import type { ReplayStatus } from '../testSuite/schema.js';
import type { Session, SessionStore } from '../session/store.js';

export type ReportFormat = 'summary' | 'markdown' | 'json' | 'junit' | 'flow' | 'playwright';

export interface ReportOptions {
  format?: ReportFormat;
  baseline?: string;
  trendRoot?: string;
  includeCurrentDump?: boolean;
  /** Suite outputs to embed in the report (Phase 3.2.1) — paths, compiled flows, runnable status. */
  suite?: {
    generated: boolean;
    skippedReason?: string;
    name?: string;
    written?: string[];
    compiledFlows?: Array<{ name: string; ok: boolean; flowPath?: string; errors: string[] }>;
    suiteRunnable?: boolean;
    readinessLabels?: ReadinessLabel[];
  };
}

export interface ReportResult {
  report: Record<string, unknown>;
  reportUri: string;
  manifestUri: string;
  manifest: unknown;
  dumpUri?: string;
  reportLinks?: Record<string, unknown>;
  exportUri?: string;
  exportFormat?: ReportFormat;
  summaryText: string;
  /** Present when format:"flow" was requested but no actions were recorded. */
  flowExportSkipped?: boolean;
}

export async function generateSessionReport(sessions: SessionStore, session: Session, options: ReportOptions = {}): Promise<ReportResult> {
  const { format, baseline, trendRoot } = options;
  const includeCurrentDump = options.includeCurrentDump ?? true;
  const redact = makeRedactor(session.secrets);
  const { driver } = await getDriver(session);

  // Auto-restore network if Swipium changed it, else warn.
  let networkRestore: string | undefined;
  if (session.network?.changed) {
    if (driver) networkRestore = (await restoreNetwork(sessions, session, driver)) ?? undefined;
    else networkRestore = 'PENDING — Swipium changed the network but no device is attached to restore it';
  }

  // Attach a redacted current dump (best-effort) for triage.
  let dumpUri: string | undefined;
  if (driver && includeCurrentDump) {
    try {
      const xml = await driver.dumpXml();
      dumpUri = sessions.saveArtifact(session, 'dump', `dump-${Date.now()}.xml`, redact(xml) ?? '', 'application/xml');
    } catch {
      /* best-effort (animated/idle-fail) */
    }
  }

  const finalNetwork = driver ? ((await driver.airplaneOn().catch(() => false)) ? 'offline' : 'online') : 'unknown';
  const high = session.findings.filter((f) => f.severity === 'high');

  const nativeFindings = session.findings.filter((f) => f.layer === 'native');
  const appFindings = session.findings.filter((f) => f.layer === 'app');
  const nativeHealth = nativeFindings.some((f) => f.severity === 'high') ? 'error' : 'OK';
  const appHealth = appFindings.some((f) => f.severity === 'high')
    ? 'error'
    : appFindings.some((f) => f.severity === 'medium')
      ? 'degraded'
      : 'OK';

  const notes = session.notes;
  const outcomeTally = notes.reduce<Record<string, number>>((a, n) => ((a[n.outcome] = (a[n.outcome] ?? 0) + 1), a), {});
  const categoryTally = notes.reduce<Record<string, number>>((a, n) => (n.category ? ((a[n.category] = (a[n.category] ?? 0) + 1), a) : a), {});
  const outcomeByCategory = notes.reduce<Record<string, Record<string, number>>>((a, n) => {
    const cat = n.category ?? 'uncategorized';
    (a[n.outcome] ??= {})[cat] = (a[n.outcome][cat] ?? 0) + 1;
    return a;
  }, {});
  const visualVerifications = notes.filter((n) => n.verifiedVisually).map((n) => ({
    workflow: n.workflow,
    outcome: n.outcome,
    evidenceKind: n.evidenceKind,
    confidence: n.confidence,
    minConfidence: n.minConfidence,
    artifactUris: n.artifactUris ?? [],
  }));
  const evidenceTaxonomy = evidenceTaxonomyForNotes(notes);
  const evidenceByWorkflow = new Map(evidenceTaxonomy.assessments.map((a) => [a.workflow, a]));

  const a = session.auth;
  const authState = a.loginPerformed
    ? 'login_performed'
    : a.authedAtStart === true && !a.loginScreenSeen
      ? 'logged_in_at_start (persisted session — login skipped)'
      : a.loginScreenSeen
        ? 'auth_required_not_completed (login screen seen, no login performed — credentials may be missing)'
        : 'unknown (no auth signal observed)';

  const phaseTimings = phaseTimingsForSession(session);

  const ec = session.envChanges;
  const bundleRiskRefusals = ec.filter((c) => /GUARDRAIL bundle-risk.*REFUSED/i.test(c));
  const bundleRiskOverrides = ec.filter((c) => /OVERRIDE acknowledgeBundleRisk/i.test(c));
  const destructiveExecuted = ec.filter((c) => /^(clear_data|fresh_start) /i.test(c));
  const destructiveGuardrail = {
    bundleRiskRefused: bundleRiskRefusals.length,
    bundleRiskOverrideApproved: bundleRiskOverrides.length,
    destructiveExecuted: destructiveExecuted.length,
    status:
      bundleRiskRefusals.length && !destructiveExecuted.length
        ? 'PASS (bundle-risk action refused, not executed)'
        : destructiveExecuted.length && bundleRiskOverrides.length
          ? 'EXECUTED with bundle-risk override'
          : destructiveExecuted.length
            ? 'EXECUTED (non-RN or generic destructive consent only)'
            : 'no destructive action attempted',
  };

  const bucketCounts = Object.fromEntries(ALL_BUCKETS.map((b) => [b, 0])) as Record<FailureBucket, number>;
  let classified = 0;
  let totalFailures = 0;
  const bucketExamples: Partial<Record<FailureBucket, string>> = {};
  for (const f of session.findings) {
    const code = (f.failureCode as keyof typeof FAILURES) ?? failureForFindingKind(f.kind);
    const info = FAILURES[code] ?? FAILURES.UNKNOWN;
    totalFailures++;
    if (code !== 'UNKNOWN') classified++;
    bucketCounts[info.bucket]++;
    bucketExamples[info.bucket] ??= `${code}: ${redact(f.detail)}`;
  }
  for (const n of notes) {
    if (n.outcome !== 'fail' && n.outcome !== 'blocked') continue;
    totalFailures++;
    classified++;
    const bucket = bucketForNoteCategory(n.category);
    bucketCounts[bucket]++;
    bucketExamples[bucket] ??= `${n.workflow}: ${n.reason ? redact(n.reason) : n.outcome}`;
  }
  const dominantBucket = ALL_BUCKETS.filter((b) => bucketCounts[b] > 0).sort((x, y) => bucketCounts[y] - bucketCounts[x])[0] ?? null;
  const failureBuckets = { counts: bucketCounts, total: totalFailures, classifiedPct: totalFailures ? Math.round((classified / totalFailures) * 100) : 100, dominant: dominantBucket, examples: bucketExamples };

  const failCount = outcomeTally.fail ?? 0;
  const blockedCount = outcomeTally.blocked ?? 0;
  const topHigh = high[0];
  const topFailNote = notes.find((n) => n.outcome === 'fail');
  const topBlockedNote = notes.find((n) => n.outcome === 'blocked');
  const executiveSummary = releaseAssessment({
    nativeHealth,
    appHealth,
    highSeverityCount: high.length,
    failCount,
    blockedCount,
    overrideCount: session.envChanges.filter((c) => /OVERRIDE|GUARDRAIL|acknowledgeBundleRisk|allowLaunchWithoutMetro/i.test(c)).length,
    topHighFinding: topHigh ? redact(topHigh.detail) : undefined,
    topFail: topFailNote ? { workflow: topFailNote.workflow, reason: topFailNote.reason ? redact(topFailNote.reason) : undefined } : undefined,
    topBlocked: topBlockedNote ? { workflow: topBlockedNote.workflow, recommendedSetup: topBlockedNote.recommendedSetup } : undefined,
  });

  const outcomesByWorkflow = notes.reduce<Record<string, { outcome: string; category?: string; reason?: string; artifactUris: string[] }>>((acc, n) => {
    acc[n.workflow] = { outcome: n.outcome, category: n.category, reason: n.reason ? redact(n.reason) : undefined, artifactUris: n.artifactUris ?? [] };
    return acc;
  }, {});

  const appId = session.appId ?? ((loadProjectConfig(session.root)?.appId as string | undefined) ?? null);
  const wdaConfig = driver instanceof WdaDriver ? loadWdaConfig(session.root) : null;
  const wdaReport = driver instanceof WdaDriver && wdaConfig
    ? {
        webDriverAgentUrl: driver.baseUrl,
        device: driver.currentDevice() ?? null,
        wdaSessionId: driver.currentSession() ?? null,
        config: wdaConfig,
        status: await checkWda(driver.baseUrl, 1500),
        tuning: { timings: wdaTimingSummary(session), recommendations: wdaRecommendations(wdaConfig, session) },
      }
    : null;
  const readiness = orderReadinessLabels([...readinessForSession(session, {
    suiteRunnable: options.suite?.suiteRunnable,
    suiteReplayed: false,
    ciReady: false,
  }), ...(options.suite?.readinessLabels ?? [])]);
  const automationReadiness = automationReadinessForSession(session, {
    suiteRunnable: options.suite?.suiteRunnable,
    suiteReplayed: false,
    ciReady: false,
  });

  const coverage = coverageForSession(session);
  const automationBackend = automationBackendForSession(session);
  const passNotes = notes.filter((n) => n.outcome === 'pass').length;

  // Single product-facing QA level (Deliverable 6 / §3.11). Derived from the same evidence the
  // report already trusts: readiness labels and health. Honest by construction.
  const qaLevel = deriveQaLevel({
    observed: readiness.includes('observed'),
    smokePassed:
      nativeHealth === 'OK' &&
      appHealth !== 'error' &&
      high.length === 0 &&
      (passNotes > 0 || !!session.exploration || session.recordedActions.length > 0),
    suiteGenerated: readiness.includes('generated'),
    suiteRunnable: readiness.includes('compiled'),
    ciReplayed: readiness.includes('ci_ready'),
  });

  // Universal run test catalog (Deliverable 4 / review #6): documents executed, skipped, blocked,
  // and exploration-promoted workflows for EVERY run — even when no suite was generated.
  const suiteReplayStatus = readiness.includes('ci_ready')
    ? 'fresh_state'
    : readiness.includes('replayed')
      ? 'same_session'
      : readiness.includes('compiled')
        ? 'dry_run'
        : 'not_replayed';
  const runTestCatalog = buildRunTestCatalog({
    notes: notes.map((n) => ({
      workflow: n.workflow,
      outcome: n.outcome,
      category: n.category,
      reason: n.reason ? redact(n.reason) : undefined,
      missingPrecondition: n.missingPrecondition,
      recommendedSetup: n.recommendedSetup,
      artifactUris: n.artifactUris ?? [],
      method: n.method,
      verifiedVisually: n.verifiedVisually,
    })),
    findings: session.findings.map((f) => ({ kind: f.kind, severity: f.severity, detail: redact(f.detail) ?? f.detail })),
    exploration: session.exploration
      ? {
          screensVisited: session.exploration.summary.screensVisited,
          workflowsFound: session.exploration.summary.workflowsFound,
          visualOnlyScreens: session.exploration.summary.visualOnlyScreens,
          unsafeActionsSkipped: session.exploration.summary.unsafeActionsSkipped,
          appErrors: session.exploration.summary.appErrors,
          blockers: [],
        }
      : null,
    fixtures: session.fixtures.map((f) => f.name),
    suiteGenerated: readiness.includes('generated'),
    suiteReplayStatus,
    observed: readiness.includes('observed'),
  });

  // Persistent QA test suite (SWIPIUM-REQ-06): a report run observes QA knowledge, so update the
  // canonical suite under .swipium/test-suite.json and embed the per-run delta + canonical case ids.
  // Best-effort — a suite-merge failure must never break report generation.
  let persistentSuite: Record<string, unknown> | null = null;
  let mergedSuite: import('../testSuite/schema.js').TestSuiteFile | undefined;
  try {
    const now = new Date().toISOString();
    const hasKnowledge = session.recordedActions.length > 0 || notes.length > 0 || !!session.exploration;
    if (hasKnowledge) {
      const { pom } = session.recordedActions.length ? pomForSession(session) : { pom: undefined };
      const incoming = generateCanonicalCases({
        pom,
        appId: appId ?? undefined,
        fixtures: session.fixtures,
        notes: session.notes,
        exploration: session.exploration,
        source: 'report',
        now,
        replayStatus: suiteReplayStatus as ReplayStatus,
      });
      const applied = applyMerge(session.root, incoming, { source: 'report', mode: 'update', now, runId: runIdFromNow(now) }, appId ?? undefined);
      mergedSuite = applied.result.suite;
      const delta = suiteDelta(applied.result.suite, applied.result);
      persistentSuite = {
        ...delta,
        caseIds: applied.result.suite.cases.map((c) => c.id),
        runLedgerPath: applied.runPath,
        validationErrors: applied.validationErrors,
      };
    } else {
      const suite = loadSuite(session.root, appId ?? undefined);
      mergedSuite = suite;
      persistentSuite = { totalCases: suite.cases.length, created: [], updated: [], deprecated: [], failed: [], blocked: [], newlyAutomated: [], caseIds: suite.cases.map((c) => c.id) };
    }
  } catch {
    persistentSuite = null;
  }

  const screenshots = session.artifacts.filter((art) => art.kind === 'screenshot');
  const report = {
    sessionId: session.id,
    executiveSummary,
    appId,
    device: session.device ?? null,
    coverage,
    automationBackend,
    readiness,
    automationReadiness,
    qaLevel,
    runTestCatalog,
    persistentSuite,
    mode: session.mode,
    emulatorDisplay: session.headless === undefined ? 'pre-existing device' : session.headless ? 'headless' : 'visible window',
    environmentChanges: session.envChanges,
    ciMutations: session.envChanges,
    mutationLedger: session.mutations.map((m) => ({
      ...m,
      detail: m.detail ? redact(m.detail) : undefined,
    })),
    workaroundsAttempted: session.workarounds,
    inputsProvided: session.inputs.map((i) => ({ varName: i.varName, secret: i.secret, source: i.source })),
    generatedValues: session.generatedValues.map((g) => ({
      ...g,
      value: g.secret ? '<redacted>' : redact(g.value),
    })),
    guardrailOverrides: session.envChanges.filter((c) => /OVERRIDE|GUARDRAIL|external-APK|clear_data|fresh_start|allowLaunchWithoutMetro|acknowledgeBundleRisk/i.test(c)),
    launchedWithoutMetroReady: session.envChanges.some((c) => /allowLaunchWithoutMetro/i.test(c)),
    destructiveGuardrail,
    finalNetwork,
    networkRestore: networkRestore ?? (session.network ? 'no change pending' : 'unchanged'),
    activeRecording: activeRecording(session.id) ?? null,
    findings: session.findings.map((f) => {
      const code = (f.failureCode as keyof typeof FAILURES) ?? failureForFindingKind(f.kind);
      const info = FAILURES[code] ?? FAILURES.UNKNOWN;
      return { ...f, failureCode: code, bucket: info.bucket, retrySafe: info.retrySafe, nextStep: info.recovery, detail: redact(f.detail), evidence: f.evidence ? redact(f.evidence) : undefined };
    }),
    highSeverityCount: high.length,
    nativeHealth,
    appHealth,
    appHealthFindings: appFindings.map((f) => ({ kind: f.kind, severity: f.severity, evidence: f.evidence ? redact(f.evidence) : undefined, screen: f.screen, screenshotUri: f.screenshotUri })),
    testOutcomes: notes.map((n) => ({ ...n, reason: n.reason ? redact(n.reason) : undefined })),
    outcomeTally,
    categoryTally,
    outcomeByCategory,
    outcomesByWorkflow,
    failureBuckets,
    visualVerifications,
    evidenceTaxonomy,
    declaredPreconditions: session.fixtures,
    authState,
    budgetProfile: session.budgetProfile ?? null,
    phaseTimings,
    wda: wdaReport,
    ci: { env: !!process.env.CI },
    visualOnly: session.mode === 'visual-fallback',
    // Generated suite (Phase 3.2.1): paths, compiled flows, runnable status — so the report (not
    // just the job result) records whether a runnable automation suite was produced.
    generatedSuite: options.suite ?? null,
    // Guided exploration (Phase 3.3 §9.2): screen graph + coverage counts.
    exploration: session.exploration
      ? {
          graphUri: session.exploration.graphUri,
          graphMdUri: session.exploration.graphMdUri,
          state: session.exploration.state,
          screensVisited: session.exploration.summary.screensVisited,
          actionsTried: session.exploration.summary.actionsTried,
          workflowsFound: session.exploration.summary.workflowsFound,
          unsafeActionsSkipped: session.exploration.summary.unsafeActionsSkipped,
          visualOnlyScreens: session.exploration.summary.visualOnlyScreens,
          appErrorsFound: session.exploration.summary.appErrors,
          blockers: session.exploration.summary.blockers,
        }
      : null,
    artifacts: session.artifacts.map((art) => ({ uri: art.uri, kind: art.kind, mime: art.mime, label: art.label })),
    counters: session.counters,
  };
  // Issue memory (SWIPIUM-REQ-07): fold this run's findings + app-bug outcomes into the durable
  // `.swipium/issues-log.jsonl`, reopen previously-fixed fingerprints, and attach the issue-memory
  // section (+ recurrence markdown) to the report. Best-effort — the ledger never breaks a report.
  try {
    const platform: IssuePlatform = driver instanceof WdaDriver ? 'ios' : driver ? 'android' : 'unknown';
    const environment: IssueEnvironment =
      session.headless !== undefined ? (platform === 'ios' ? 'simulator' : 'emulator') : process.env.CI ? 'ci' : 'unknown';
    const issuePolicy = loadIssuePolicy(session.root);
    const sourceRevision = resolveSourceRevision({ env: process.env, allowGitMetadataRead: issuePolicy.allowGitMetadataRead, root: session.root });
    const bridgeFindings: BridgeFinding[] = session.findings.map((f) => ({ severity: f.severity, kind: f.kind, detail: redact(f.detail) ?? f.detail, layer: f.layer, evidence: f.evidence ? redact(f.evidence) : undefined, screen: f.screen, screenshotUri: f.screenshotUri, failureCode: f.failureCode }));
    const bridgeNotes: BridgeNote[] = notes.map((n) => ({ workflow: n.workflow, outcome: n.outcome, category: n.category, reason: n.reason ? redact(n.reason) : undefined, failureCode: (n as { failureCode?: string }).failureCode, artifactUris: n.artifactUris }));
    const issuesNow = new Date().toISOString();
    const bridge = foldRunIntoLedger(session.root, bridgeFindings, bridgeNotes, issuesNow, {
      appId: appId ?? undefined,
      platform,
      environment,
      sessionId: session.id,
      sourceRevision,
    });

    // Link recorded issues to persistent test cases, and verify fixed issues that a PASSING case
    // covers this run (REQ-08). The case→workflow key is the workflow string the suite generator
    // folds into actualResult.summary.
    let verifiedFixedIds = new Set<string>();
    if (mergedSuite) {
      const idx = getIssueIndex(session.root, issuesNow, appId ?? undefined);
      const recordById = new Map(idx.records.map((r) => [r.issueId, r]));
      const matchCase = (workflow?: string) =>
        workflow
          ? mergedSuite!.cases.filter((c) => c.actualResult.summary?.toLowerCase().includes(workflow.toLowerCase()) || c.functionality.toLowerCase() === workflow.toLowerCase() || c.title.toLowerCase().includes(workflow.toLowerCase()))
          : [];
      for (const rec of bridge.recorded) {
        const record = recordById.get(rec.issueId);
        if (!record) continue;
        for (const c of matchCase(rec.workflow)) {
          linkIssueToCase(c, record, relationshipForCase(rec.category), issuesNow);
          const lastRun = c.history[c.history.length - 1];
          if (lastRun) linkRunIssue(lastRun, record, runRelationshipFor(record, rec.reopened));
        }
      }
      const passingCaseIds = new Set(mergedSuite.cases.filter((c) => c.actualResult.status === 'pass').map((c) => c.id));
      const stateById = new Map(idx.records.map((r) => [r.issueId, r.state as string]));
      const verified = verifiedFixedIssuesForRun(mergedSuite.cases, passingCaseIds, stateById);
      for (const issueId of verified) {
        verifyFixed(session.root, { issueId }, { testCaseId: 'persistent-suite', evidenceUris: [] }, issuesNow);
        const rec = recordById.get(issueId);
        for (const c of mergedSuite.cases) {
          if (passingCaseIds.has(c.id) && c.issueRefs?.some((r) => r.issueId === issueId) && rec) linkIssueToCase(c, rec, 'verified_fixed', issuesNow);
        }
      }
      verifiedFixedIds = new Set(verified);
      saveSuite(session.root, mergedSuite);
    }

    // Rebuild the section honoring verified-fixed evidence (REQ-08 honest fix verification).
    const finalIdx = getIssueIndex(session.root, issuesNow, appId ?? undefined);
    const finalSection = buildReportIssuesSection(finalIdx.records, new Set(bridge.recordedIssueIds), verifiedFixedIds);
    (report as Record<string, unknown>).issues = finalSection;
    (report as Record<string, unknown>).issuesMarkdown = issuesSectionToMarkdown(finalSection);
    if (bridge.recurrences.length) (report as Record<string, unknown>).issueRecurrences = bridge.recurrences;

    // Compact quality metrics when enough history exists (REQ-08): this run's new/reopened/verified
    // counts + open blocker/high totals + reopen/fix-verification rates.
    const allEvents = readIssueEvents(session.root);
    if (allEvents.length >= 2) {
      const metrics = computeIssueMetrics(allEvents, {});
      (report as Record<string, unknown>).issueMetrics = {
        newThisRun: finalSection.newIssues.length,
        reopenedThisRun: finalSection.recurringIssues.length,
        fixedVerifiedThisRun: verifiedFixedIds.size,
        openBlocker: metrics.blockerOpenCount,
        openHigh: metrics.highOpenCount,
        reopenRatePct: metrics.reopenRatePct,
        fixVerificationRatePct: metrics.fixVerificationRatePct,
        avgAgeDays: metrics.avgAgeDays,
      };
    }

    // Refresh app-map issue summaries from the freshly-updated ledger (REQ-08) — only when a map
    // already exists, and WITHOUT a static rescan (runtime_merge load → apply summaries → save).
    if (existsSync(appMapPath(session.root))) {
      buildAppMap(session.root, { mode: 'runtime_merge', at: issuesNow, includeCodeIndex: false, persist: true });
    }
  } catch {
    /* best-effort — issue ledger is additive, never blocks the report */
  }

  const prSummary = { text: inlinePrSummary(report as unknown as ReportData) };
  (report as Record<string, unknown>).prSummary = prSummary;
  const reportUri = sessions.saveArtifact(session, 'report', `report-${Date.now()}.json`, JSON.stringify(report, null, 2), 'application/json');
  const reportRec = sessions.findArtifact(reportUri)?.rec;

  let reportLinks: Record<string, unknown> | undefined;
  if ((baseline || trendRoot) && reportRec) {
    try {
      const pr = buildPrSummary(reportRec.path, { baselinePath: baseline, trendRoot: trendRoot ?? session.root });
      reportLinks = { current: reportUri, currentPath: reportRec.path, baseline: baseline ?? null, trendRoot: trendRoot ?? session.root, comparison: pr.comparison ?? null, knownFlaky: pr.knownFlaky, prSummary: pr };
      (report as Record<string, unknown>).reportLinks = reportLinks;
      writeFileSync(reportRec.path, JSON.stringify(report, null, 2));
    } catch (e) {
      reportLinks = { current: reportUri, currentPath: reportRec.path, baseline: baseline ?? null, trendRoot: trendRoot ?? session.root, error: String((e as Error).message ?? e) };
      (report as Record<string, unknown>).reportLinks = reportLinks;
      writeFileSync(reportRec.path, JSON.stringify(report, null, 2));
    }
  }

  let exportUri: string | undefined;
  let flowExportSkipped = false;
  if (format && format !== 'summary') {
    if (format === 'json') {
      exportUri = reportUri;
    } else if (format === 'flow') {
      if (!session.recordedActions.length) {
        flowExportSkipped = true;
      } else {
        const gen = generateFlow(session.recordedActions, { name: `${(appId ?? 'app').split('.').pop()}-recorded`, appId: appId ?? undefined });
        exportUri = sessions.saveArtifact(session, 'flow', `recorded-${Date.now()}.yaml`, gen.yaml, 'text/yaml', `flow drafted from the run (durability ${gen.durability.grade})`);
      }
    } else {
      const data = report as unknown as ReportData;
      const body = format === 'markdown' ? toMarkdown(data) : format === 'playwright' ? toPlaywrightJson(data) : toJUnit(data);
      const ext = format === 'markdown' ? 'md' : format === 'playwright' ? 'playwright.json' : 'xml';
      const mime = format === 'markdown' ? 'text/markdown' : format === 'playwright' ? 'application/json' : 'application/xml';
      exportUri = sessions.saveArtifact(session, 'report', `report-${Date.now()}.${ext}`, body, mime);
    }
  }

  const manifest = buildSessionArtifactManifest(session);
  const manifestUri = sessions.saveArtifact(session, 'manifest', `manifest-${Date.now()}.json`, JSON.stringify(manifest, null, 2), 'application/json', 'artifact manifest with SHA-256 hashes');
  const noteSummaryLines = notes.map((n) => {
    const ev = evidenceByWorkflow.get(n.workflow);
    return `  • ${n.workflow}: ${n.outcome}${ev ? ` (evidence=${ev.kind}/${ev.authority})` : ''}${n.category ? ` [${n.category}]` : ''}${n.missingPrecondition ? ` — missing: ${n.missingPrecondition}` : n.reason ? ` — ${redact(n.reason)}` : ''}${n.recommendedSetup ? ` · setup: ${n.recommendedSetup}` : ''}`;
  });

  const lines = [
    `Report for ${session.id} — app=${report.appId} device=${report.device}`,
    `RELEASE RISK: ${executiveSummary.risk.toUpperCase()} — ${executiveSummary.nextAction}`,
    `PR summary:\n${prSummary.text}`,
    `backend: ${report.automationBackend.description} (${report.automationBackend.mode})`,
    `QA level: ${qaLevel.level.toUpperCase()} — ${qaLevel.rationale}${qaLevel.next ? ` · next: ${qaLevel.next} (${qaLevel.nextRequirement})` : ''}`,
    qaLevel.notes.length ? `QA level notes:\n  ${qaLevel.notes.join('\n  ')}` : '',
    `automation readiness: ${automationReadiness.grade} (${automationReadiness.score}/100, durable locators ${automationReadiness.locatorCoverage.durablePct}%)`,
    `test catalog: ${runTestCatalog.total} case(s) — ${Object.entries(runTestCatalog.counts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`,
    automationReadiness.topFixes.length ? `top readiness fixes:\n  ${automationReadiness.topFixes.join('\n  ')}` : 'top readiness fixes: none',
    `${report.coverage}${report.visualOnly ? ' · VISUAL-ONLY (structured snapshots were poor — see screenshots)' : ''}`,
    `emulator display: ${report.emulatorDisplay}`,
    `network: ${finalNetwork}${networkRestore ? ` (${networkRestore})` : session.network?.changed ? ' ⚠ Swipium changed it and did NOT restore' : ''}`,
    report.activeRecording ? `A screen recording is still active (${report.activeRecording.backend}, ~${report.activeRecording.seconds}s). It will be stopped on shutdown.` : '',
    session.envChanges.length ? `environment changes:\n  ${session.envChanges.join('\n  ')}` : 'environment changes: none',
    session.mutations.length ? `mutation ledger: ${session.mutations.length} record(s), ${session.mutations.filter((m) => m.status === 'executed').length} executed, ${session.mutations.filter((m) => m.status === 'refused' || m.status === 'blocked').length} refused/blocked` : 'mutation ledger: none',
    report.guardrailOverrides.length ? `⚠ guardrail overrides used:\n  ${report.guardrailOverrides.join('\n  ')}` : 'guardrail overrides: none',
    session.workarounds.length ? `workarounds attempted:\n  ${session.workarounds.join('\n  ')}` : '',
    session.inputs.length ? `inputs provided (redacted): ${session.inputs.map((i) => `${i.varName}${i.secret ? '🔒' : ''}`).join(', ')}` : '',
    session.generatedValues.length ? `generated test data: ${session.generatedValues.map((g) => `${g.fixture}.${g.field}=${g.secret ? '<redacted>' : redact(g.value)} (${g.generator})`).join(', ')}` : '',
    options.suite
      ? options.suite.generated
        ? `generated suite "${options.suite.name}": ${(options.suite.compiledFlows ?? []).filter((c) => c.ok).length}/${(options.suite.compiledFlows ?? []).length} runnable flow(s), runnable=${options.suite.suiteRunnable}, readiness=${(options.suite.readinessLabels ?? []).join(' → ') || 'unknown'} (${(options.suite.written ?? []).length} files)`
        : `suite generation skipped: ${options.suite.skippedReason}`
      : '',
    session.exploration
      ? `exploration: ${session.exploration.summary.screensVisited} screens, ${session.exploration.summary.workflowsFound} transitions, ${session.exploration.summary.visualOnlyScreens} visual-only, ${session.exploration.summary.unsafeActionsSkipped} unsafe skipped, ${session.exploration.summary.appErrors} app errors (graph: ${session.exploration.graphUri})`
      : '',
    `destructive/bundle-risk guardrail: ${destructiveGuardrail.status}`,
    `health — native: ${nativeHealth === 'OK' ? '✅ OK' : '❌ error'} · app: ${appHealth === 'OK' ? '✅ OK' : appHealth === 'degraded' ? '⚠ degraded' : '❌ error'}`,
    wdaReport ? `wda: ${wdaReport.status.reachable ? 'reachable' : 'unreachable'} ${wdaReport.webDriverAgentUrl} device=${wdaReport.device ?? 'unknown'}` : '',
    `findings: ${session.findings.length} (high: ${high.length})`,
    totalFailures ? `failures by bucket: ${ALL_BUCKETS.filter((b) => bucketCounts[b]).map((b) => `${b}=${bucketCounts[b]}`).join(' ')} (${failureBuckets.classifiedPct}% classified${dominantBucket ? `, mostly ${dominantBucket}` : ''})` : '',
    notes.length ? `evidence taxonomy: structured=${evidenceTaxonomy.counts.structured_locator} ocr=${evidenceTaxonomy.counts.ocr_locator} visual=${evidenceTaxonomy.counts.visual_match} ai_visual=${evidenceTaxonomy.counts.ai_visual_evidence} manual=${evidenceTaxonomy.counts.manual_review} calibration=${evidenceTaxonomy.calibration.status}` : '',
    ...session.findings.map((f) => `  [${f.severity}] ${f.layer ?? '?'}/${f.kind}: ${redact(f.detail)}${f.evidence ? ` — "${redact(f.evidence)}"` : ''}${f.screenshotUri ? ` (${f.screenshotUri})` : ''}`),
    notes.length ? `test outcomes: ${Object.entries(outcomeTally).map(([k, v]) => `${k}=${v}`).join(' ')}` : 'test outcomes: none recorded (qa_note)',
    ...noteSummaryLines,
    persistentSuite
      ? `persistent suite: ${persistentSuite.totalCases} case(s) — +${(persistentSuite.created as string[]).length} created, ~${(persistentSuite.updated as string[]).length} updated, -${(persistentSuite.deprecated as string[]).length} deprecated, ${(persistentSuite.failed as string[]).length} failed, ${(persistentSuite.blocked as string[]).length} blocked, ${(persistentSuite.newlyAutomated as string[]).length} newly automated`
      : '',
    `auth: ${authState}`,
    session.fixtures.length ? `declared preconditions: ${session.fixtures.map((f) => f.name).join(', ')}` : '',
    `timing: total=${phaseTimings.totalSec}s setup=${phaseTimings.setupSec}s active=${phaseTimings.activeSec}s${phaseTimings.timeToLoginSec != null ? ` toLogin=${phaseTimings.timeToLoginSec}s` : ''}${phaseTimings.diagnostics.waitSec != null ? ` wait=${phaseTimings.diagnostics.waitSec}s` : ''}${phaseTimings.diagnostics.flowRuntimeSec != null ? ` flows=${phaseTimings.diagnostics.flowRuntimeSec}s` : ''}${session.budgetProfile ? ` (profile=${session.budgetProfile})` : ''}`,
    reportLinks ? `report links: baseline=${baseline ?? 'none'} trend=${trendRoot ?? session.root}${typeof reportLinks.comparison === 'string' ? ` comparison=${reportLinks.comparison}` : ''}` : '',
    `artifacts: ${session.artifacts.length} (${screenshots.length} screenshots)`,
    ...session.artifacts.map((art) => `  ${art.uri} (${art.kind}${art.label ? `: ${art.label}` : ''})`),
    dumpUri ? `current dump: ${dumpUri}` : '',
    `report: ${reportUri}`,
    `manifest: ${manifestUri}`,
    exportUri && exportUri !== reportUri ? `${format} export: ${exportUri}` : '',
  ].filter(Boolean);

  return { report, reportUri, manifestUri, manifest, dumpUri, reportLinks, exportUri, exportFormat: exportUri ? format : undefined, summaryText: lines.join('\n'), flowExportSkipped };
}
