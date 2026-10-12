// Report service (Phase 3.2 Milestone B): the session-report assembly, extracted from the
// qa_report tool so qa_test_this execute can produce a real report artifact in EVERY terminal
// state (completed or blocked), not just tell the agent to call qa_report. qa_report is now a thin
// wrapper around generateSessionReport().

import { existsSync, writeFileSync } from 'node:fs';
import { makeRedactor, redactDeep } from '../lib/redact.js';
import { inputBindings } from '../suite/secretGuard.js';
import { dedupeFindings, repeatSuffix } from '../report/findingsDedupe.js';
import { toolVerdictFor } from '../report/toolHealth.js';
import { getDriver } from '../session/attach.js';
import { restoreNetwork } from '../tools/network.js';
import { releaseAssessment } from '../report/summary.js';
import {
  FAILURES,
  failureForFindingKind,
  bucketForNoteCategory,
  isAutomationDriftNote,
  ALL_BUCKETS,
  type FailureBucket,
} from '../oracle/failures.js';
import {
  inlinePrSummary,
  redactReportData,
  reportPolicyVerdicts,
  toGithubSummary,
  toJUnit,
  toMarkdown,
  toPlaywrightJson,
  toSarif,
  stripControls,
  type ReportData,
} from '../report/export.js';
import { applyPolicy, loadPolicy as loadReleasePolicy, policyNotice, type PolicyDecision } from '../report/policy.js';
import { resolveSarifSources } from '../report/sarifSources.js';
import { generateFlow } from '../flows/generate.js';
import { loadProjectConfig } from '../cli/scan.js';
import { activeRecording } from '../tools/screenRecord.js';
import { phaseTimingsForSession } from '../report/timing.js';
import { automationBackendForSession, coverageForSession } from '../report/coverage.js';
import { buildSessionArtifactManifest } from '../report/artifactManifest.js';
import { buildReportHead } from '../report/head.js';
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
import {
  linkIssueToCase,
  linkRunIssue,
  relationshipForCase,
  runRelationshipFor,
  verifiedFixedIssuesForRun,
} from '../testSuite/issueLinks.js';
import { saveSuite } from '../testSuite/store.js';
import type { IssueEnvironment, IssuePlatform } from '../issues/schema.js';
import { pomForSession } from './suiteGenerate.js';
import { casePlatformsFor, generateCanonicalCases } from '../testSuite/generator.js';
import { applyMerge, loadSuite, suiteDelta, runIdFromNow } from '../testSuite/store.js';
import type { ReplayStatus } from '../testSuite/schema.js';
import type { Session, SessionStore, TestNote } from '../session/store.js';

export type ReportFormat = 'summary' | 'markdown' | 'json' | 'junit' | 'sarif' | 'github-summary' | 'flow' | 'playwright';

/** Render an *Ms structured value as human-readable seconds for text summaries. */
function secText(ms: number | null | undefined): string {
  return `${Math.round((ms ?? 0) / 1000)}s`;
}

export interface ReportOptions {
  format?: ReportFormat;
  baseline?: string;
  trendRoot?: string;
  includeCurrentDump?: boolean;
  /** Suite outputs to embed in the report (Phase 3.2.1): paths, compiled flows, runnable status. */
  suite?: {
    generated: boolean;
    skippedReason?: string;
    name?: string;
    written?: string[];
    compiledFlows?: Array<{ name: string; ok: boolean; flowPath?: string; errors: string[] }>;
    suiteRunnable?: boolean;
    readinessLabels?: ReadinessLabel[];
  };
  /**
   * The run this report closes did not test what it set out to: qa_test_this stopped by a blocker
   * (BUILD_FAILED, METRO_REQUIRED, …) or a focused feature run that executed 0 of its cases. Keeps
   * the release risk off SHIP: BLOCK when nothing in the session exercised the app, else CAUTION.
   */
  notTested?: { reason: string; failureCode?: string; reachedApp?: boolean };
}

export interface ReportResult {
  report: Record<string, unknown>;
  reportUri: string;
  /** report.md: the agent-readable summary (summaryText). Read this; report.json is for CI. */
  reportMdUri: string;
  /** 2-4 KB head (verdicts, top findings/failures with evidence URIs, report.md pointer). */
  reportHead: string;
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
  // A report never adopts a device: a session with none (fresh, report-only, or a run that failed
  // before prepare) must not bind and capture whatever emulator happens to be online.
  const { driver } = await getDriver(session, { autoBind: false });

  // Auto-restore network if Swipium changed it, else warn.
  let networkRestore: string | undefined;
  if (session.network?.changed) {
    if (driver) {
      // GOAL-25: a backend that can't toggle the network (iOS) must not make report generation
      // fail forever. Report the failed restore instead of throwing; on a backend that can't change
      // the network nothing was changed, so clear the stale flag.
      try {
        networkRestore = (await restoreNetwork(sessions, session, driver)) ?? undefined;
      } catch (e) {
        networkRestore = `FAILED: could not restore the network: ${String((e as Error).message ?? e)}`;
        if (driver.kind === 'wda' || driver.kind === 'simulator') {
          session.network = { changed: false, originalAirplane: session.network.originalAirplane };
          sessions.persist(session);
          networkRestore = 'not applicable: this backend cannot change the network, so nothing was changed';
        }
      }
    } else networkRestore = 'PENDING: Swipium changed the network but no device is attached to restore it';
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
  const uniqueFindings = dedupeFindings(session.findings);

  // GOAL NEW-R3-2 / E2E NEW-15: WDA returning no UI source (a native/high wda_unreachable finding) is
  // a tool / environment failure (WDA_UNREACHABLE). It still fails the gate as a high finding, but it
  // is not native/app health, not an app failure and not evidence that the app was exercised.
  const isToolFinding = (f: { kind: string; failureCode?: string }) => f.kind === 'wda_unreachable' || f.failureCode === 'WDA_UNREACHABLE';
  const healthFindings = session.findings.filter((f) => !isToolFinding(f));
  const nativeFindings = healthFindings.filter((f) => f.layer === 'native');
  const appFindings = healthFindings.filter((f) => f.layer === 'app');
  // Narrowed below to 'not checked' / 'unverified' once it is known whether the app was reached.
  let nativeHealth: 'OK' | 'error' | 'not checked' = nativeFindings.some((f) => f.severity === 'high') ? 'error' : 'OK';
  let appHealth: 'OK' | 'degraded' | 'error' | 'unverified' | 'not checked' = appFindings.some((f) => f.severity === 'high')
    ? 'error'
    : appFindings.some((f) => f.severity === 'medium')
      ? 'degraded'
      : 'OK';

  const notes = session.notes;
  const outcomeTally = notes.reduce<Record<string, number>>((a, n) => ((a[n.outcome] = (a[n.outcome] ?? 0) + 1), a), {});
  const categoryTally = notes.reduce<Record<string, number>>(
    (a, n) => (n.category ? ((a[n.category] = (a[n.category] ?? 0) + 1), a) : a),
    {},
  );
  const outcomeByCategory = notes.reduce<Record<string, Record<string, number>>>((a, n) => {
    const cat = n.category ?? 'uncategorized';
    (a[n.outcome] ??= {})[cat] = (a[n.outcome][cat] ?? 0) + 1;
    return a;
  }, {});
  const visualVerifications = notes
    .filter((n) => n.verifiedVisually)
    .map((n) => ({
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
      ? 'logged_in_at_start (persisted session, login skipped)'
      : a.loginScreenSeen
        ? 'auth_required_not_completed (login screen seen, no login performed, credentials may be missing)'
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
    const bucket = bucketForNoteCategory(n.category, n.outcome);
    bucketCounts[bucket]++;
    bucketExamples[bucket] ??= `${n.workflow}: ${n.reason ? redact(n.reason) : n.outcome}`;
  }
  const dominantBucket = ALL_BUCKETS.filter((b) => bucketCounts[b] > 0).sort((x, y) => bucketCounts[y] - bucketCounts[x])[0] ?? null;
  const failureBuckets = {
    counts: bucketCounts,
    total: totalFailures,
    classifiedPct: totalFailures ? Math.round((classified / totalFailures) * 100) : 100,
    dominant: dominantBucket,
    examples: bucketExamples,
  };

  const blockedCount = outcomeTally.blocked ?? 0;
  const APP_OWNED_FAIL_CATEGORIES = new Set(['app_bug', 'other']);
  // GOAL-24: a Swipium-generated flow failing on a locator step is automation drift (category
  // 'other' + AUTOMATION_DRIFT_NOTE): a caution to repair the flow, never an app FAIL / BLOCK.
  const driftFailCount = notes.filter(isAutomationDriftNote).length;
  const appFailNotes = notes.filter(
    (n) => n.outcome === 'fail' && (n.category == null || APP_OWNED_FAIL_CATEGORIES.has(n.category)) && !isAutomationDriftNote(n),
  );
  const appFailCount = appFailNotes.length;
  const toolLimitationNotes = notes.filter((n) => (n.outcome === 'fail' || n.outcome === 'blocked') && n.category === 'mcp_limitation');
  const toolLimitationFailCount = toolLimitationNotes.filter((n) => n.outcome === 'fail').length;
  const topHigh = high.find((f) => !isToolFinding(f)) ?? high[0];
  const topAppFailNote = appFailNotes[0];
  const topBlockedNote = notes.find((n) => n.outcome === 'blocked');
  // No evidence => never SHIP. R5 must-fix 1: the rule is inverted. Only a Swipium-run check that
  // looked at the app's UI and found it healthy counts as exercising the app: a smoke or flow pass
  // whose oracle read the UI (a launch smoke with app=ok, so RedBox / blank were ruled out), or an
  // exploration that reached at least one structured (non visual-only) app screen. Agent verdicts
  // (qa_note, qa_visual assert), launches, screenshots, raw actions and findings never count, and
  // never clear a persisted not-tested marker. A failure still counts (it can only block).
  const isOutcome = (n: TestNote) => n.outcome === 'pass' || (n.outcome === 'fail' && n.category !== 'mcp_limitation');
  // Swipium ran the check and judged it itself: not an agent note, not a qa_visual assert verdict
  // (manual_review) and not a screenshot-only pass (method visual: nothing ruled out a RedBox).
  const swipiumJudged = (n: TestNote) => n.source !== 'qa_note' && n.evidenceKind !== 'manual_review' && n.method !== 'visual';
  const healthyPass = (n: TestNote) => n.outcome === 'pass' && (n.workflow !== 'launch_smoke' || /\bapp=ok\b/.test(n.reason ?? ''));
  const ex = session.exploration;
  const exploredRealScreenAt = ex && ex.summary.screensVisited - ex.summary.visualOnlyScreens > ex.summary.appErrors ? ex.at : 0;
  // Swipium's own healthy pass (or failure) or a real-screen exploration recorded after `t`.
  const swipiumOutcomeSince = (t: number) =>
    notes.some((n) => n.at > t && swipiumJudged(n) && isOutcome(n) && (n.outcome === 'fail' || healthyPass(n))) || exploredRealScreenAt > t;
  // An action with the app under test in front (qa_act's post-action check): proves the app was
  // reached, never that it was tested.
  const appActionSince = (t: number) => session.recordedActions.some((ra) => ra.at > t && ra.appForeground);
  const appShotSince = (t: number) =>
    session.artifacts.some((art) => (art.kind === 'screenshot' || art.kind === 'recording') && art.appForeground && art.createdAt > t);
  // E2E NEW-1 / NEW-10: reaching the app takes real evidence: a launch of the app under test, a
  // screenshot taken while it was in front, an action with it in front, a health finding, or the above.
  // A home-screen qa_screenshot of a blocked run, a blocked/skipped qa_note and Swipium's own report
  // exports are NOT evidence.
  const appSeen =
    !!session.milestones?.app_launch_end ||
    !!session.milestones?.smoke_launch ||
    appShotSince(0) ||
    appActionSince(0) ||
    healthFindings.length > 0 ||
    (ex?.summary.screensVisited ?? 0) > 0;
  // An agent's pass claim never counts; a claimed failure always counts (it can only block).
  const exercised =
    swipiumOutcomeSince(0) || notes.some((n) => !swipiumJudged(n) && n.outcome === 'fail' && n.category !== 'mcp_limitation');
  const unverifiedPassClaim =
    !exercised && notes.some((n) => (n.source === 'qa_note' || n.evidenceKind === 'manual_review') && n.outcome === 'pass');
  const unbackedPassClaim = unverifiedPassClaim && !appSeen;
  const reachedApp = exercised || appSeen;
  // E2E NEW-10/13: a not-tested run stays not tested for every later qa_report (same verdict, same
  // blocker code) until a Swipium-run healthy check (above) is recorded after it.
  if (options.notTested) {
    session.notTested = {
      reason: options.notTested.reason,
      failureCode: options.notTested.failureCode ?? 'NOT_TESTED',
      ...(options.notTested.reachedApp === false ? { reachedApp: false } : {}),
      at: Date.now(),
    };
    sessions.persist(session);
  } else if (session.notTested) {
    if (swipiumOutcomeSince(session.notTested.at)) {
      session.notTested = undefined;
      sessions.persist(session);
    }
  }
  const marker = options.notTested ?? session.notTested;
  // E2E NEW-13: a refused consent (CONSENT_CANCELLED / _DECLINED / _REFUSED) is ledgered on the
  // session with its code; a run that tested nothing gates with that code, not NOT_TESTED.
  const consentRefusal = [...(session.mutations ?? [])]
    .reverse()
    .find((m) => m.status === 'refused' && typeof m.failureCode === 'string' && m.failureCode.startsWith('CONSENT_'));
  // The blocker a blocked note names: "METRO_REQUIRED: …" (smoke, or an agent's note), or a blank launch.
  const blockerCodeOf = (n: TestNote | undefined): string => {
    const code = n?.reason?.match(/^([A-Z][A-Z0-9_]{3,})\b/)?.[1];
    if (code && code in FAILURES) return code;
    if (n?.workflow === 'launch_smoke' && n.missingPrecondition === 'the app rendering its first screen') return 'BLANK_SCREEN';
    return consentRefusal?.failureCode ?? 'NOT_TESTED';
  };
  // `exercised:false` = no workflow was tested: the CI gate fails even when the app was reached.
  const notTested: { reachedApp: boolean; exercised: boolean; reason: string; failureCode: string } | undefined = marker
    ? {
        // reachedApp:false from the caller = THIS run never launched the app (GOAL-7: a launch failure);
        // earlier evidence in the session does not make it a tested run.
        reachedApp: marker.reachedApp === false ? false : exercised,
        exercised,
        reason: marker.reason,
        failureCode: marker.failureCode ?? 'NOT_TESTED',
      }
    : exercised
      ? undefined
      : !reachedApp
        ? {
            reachedApp: false,
            exercised: false,
            reason: unbackedPassClaim
              ? 'only an unverified qa_note pass claim (manual claim, no device evidence): nothing was launched or exercised'
              : topBlockedNote
                ? `the app was never launched or exercised (recorded "${topBlockedNote.workflow}" as blocked${topBlockedNote.reason ? `: ${redact(topBlockedNote.reason)}` : ''})`
                : consentRefusal
                  ? `nothing ran: consent for "${consentRefusal.action}" was refused (${consentRefusal.failureCode})`
                  : 'no app was launched or exercised and no evidence was captured',
            failureCode: blockerCodeOf(topBlockedNote),
          }
        : {
            // CR: a reached app that was then blocked (BLANK_SCREEN, a refused consent) tested nothing:
            // CAUTION, and the gate fails with the blocker's code.
            reachedApp: true,
            exercised: false,
            reason: unverifiedPassClaim
              ? 'only an unverified qa_note pass claim on a launched app (no Swipium smoke, flow or exploration, and no action with the app in front, backs it; the screen may show an error): run qa_smoke or a flow'
              : topBlockedNote
                ? `the app was reached but no workflow was exercised (recorded "${topBlockedNote.workflow}" as blocked${topBlockedNote.reason ? `: ${redact(topBlockedNote.reason)}` : ''})`
                : 'the app was reached but no workflow was exercised',
            failureCode: blockerCodeOf(topBlockedNote),
          };
  // AND-4 / E2E NEW-4: health was never checked when the app was never reached; "OK" would be a claim.
  // E2E-2: a visual-only smoke (no UI tree read) left app-layer health "unverified", never OK.
  const healthUnchecked = !!notTested && !notTested.reachedApp && healthFindings.length === 0;
  const lastLaunchSmoke = [...notes].reverse().find((n) => n.workflow === 'launch_smoke');
  if (healthUnchecked) {
    nativeHealth = 'not checked';
    appHealth = 'not checked';
  } else if (
    appHealth === 'OK' &&
    ((lastLaunchSmoke?.reason && /\bapp=unverified\b/.test(lastLaunchSmoke.reason)) || session.findings.some(isToolFinding))
  ) {
    appHealth = 'unverified';
  }
  // Round-3 notes: coverage the run planned but did not get must not leave the risk at SHIP.
  // Flows whose latest outcome is a session-budget skip were not run; a blocked exploration
  // (unsafe actions skipped, blockers, budget stop) explored less than it set out to.
  const latestByWorkflow = new Map(notes.map((n) => [n.workflow, n]));
  const budgetSkipped = [...latestByWorkflow.values()]
    .filter((n) => n.outcome === 'skipped' && /^budget:|BUDGET_EXHAUSTED/.test(n.reason ?? ''))
    .map((n) => n.workflow);
  const explorationBlocked = session.exploration?.state === 'blocked';
  const coverageGaps = [
    ...(budgetSkipped.length
      ? [
          {
            reason: `${budgetSkipped.length} workflow(s) not run, the session budget ran out: ${budgetSkipped.join(', ')}`,
            next: `Re-run with a larger budget (qa_start_session { budget }) so ${budgetSkipped.join(', ')} run.`,
          },
        ]
      : []),
    ...(explorationBlocked
      ? [
          {
            reason: `exploration blocked (${session.exploration!.stoppedReason}; ${session.exploration!.summary.blockers} blocker(s), ${session.exploration!.summary.unsafeActionsSkipped} unsafe action(s) skipped)`,
            next: 'Review the exploration blockers (graph in the report), provide the missing setup, then re-run.',
          },
        ]
      : []),
  ];
  const executiveSummary = releaseAssessment({
    coverageGaps,
    notTested,
    nativeHealth,
    appHealth,
    // A WDA_UNREACHABLE finding is a tool / environment failure, not an app verdict: it keeps the risk
    // off SHIP (tool status, app health unverified) and still fails the gate, but is no app BLOCK.
    highSeverityCount: high.filter((f) => !isToolFinding(f)).length,
    failCount: appFailCount,
    blockedCount: blockedCount + toolLimitationFailCount + driftFailCount,
    overrideCount: session.envChanges.filter((c) => /OVERRIDE|GUARDRAIL|acknowledgeBundleRisk|allowLaunchWithoutMetro/i.test(c)).length,
    topHighFinding: topHigh ? redact(topHigh.detail) : undefined,
    topFail: topAppFailNote
      ? { workflow: topAppFailNote.workflow, reason: topAppFailNote.reason ? redact(topAppFailNote.reason) : undefined }
      : undefined,
    topBlocked: topBlockedNote ? { workflow: topBlockedNote.workflow, recommendedSetup: topBlockedNote.recommendedSetup } : undefined,
  });

  const outcomesByWorkflow = notes.reduce<Record<string, { outcome: string; category?: string; reason?: string; artifactUris: string[] }>>(
    (acc, n) => {
      acc[n.workflow] = {
        outcome: n.outcome,
        category: n.category,
        reason: n.reason ? redact(n.reason) : undefined,
        artifactUris: n.artifactUris ?? [],
      };
      return acc;
    },
    {},
  );

  const appId = session.appId ?? (loadProjectConfig(session.root)?.appId as string | undefined) ?? null;
  const wdaConfig = driver instanceof WdaDriver ? loadWdaConfig(session.root) : null;
  const wdaReport =
    driver instanceof WdaDriver && wdaConfig
      ? {
          webDriverAgentUrl: driver.baseUrl,
          device: driver.currentDevice() ?? null,
          wdaSessionId: driver.currentSession() ?? null,
          config: wdaConfig,
          status: await checkWda(driver.baseUrl, 1500),
          tuning: { timings: wdaTimingSummary(session), recommendations: wdaRecommendations(wdaConfig, session) },
        }
      : null;
  const readiness = orderReadinessLabels([
    ...readinessForSession(session, {
      suiteRunnable: options.suite?.suiteRunnable,
      suiteReplayed: false,
      ciReady: false,
    }),
    ...(options.suite?.readinessLabels ?? []),
  ]).filter((label) => label !== 'observed' || !notTested || notTested.reachedApp); // never "observed" when the app wasn't reached
  const automationReadiness = automationReadinessForSession(session, {
    suiteRunnable: options.suite?.suiteRunnable,
    suiteReplayed: false,
    ciReady: false,
  });

  const coverage = coverageForSession(session);
  const automationBackend = automationBackendForSession(session);
  const passNotes = notes.filter((n) => n.outcome === 'pass').length;
  const appVerdict = (() => {
    if (
      nativeHealth === 'error' ||
      appHealth === 'error' ||
      high.some((f) => (f.layer === 'app' || f.layer === 'native') && !isToolFinding(f)) ||
      appFailCount > 0
    ) {
      const summary = topHigh
        ? (redact(topHigh.detail) ?? topHigh.detail)
        : topAppFailNote?.reason
          ? (redact(topAppFailNote.reason) ?? topAppFailNote.reason)
          : 'High severity app/native finding or failed app workflow observed.';
      return { status: 'BLOCKED', summary };
    }
    if (notTested && !notTested.reachedApp) return { status: 'NOT_RUN', summary: `Not tested: ${notTested.reason}.` };
    // E2E NEW-17: launched, but the only pass is the agent's claim: nothing Swipium ran judged the app.
    if (unverifiedPassClaim)
      return {
        status: 'UNVERIFIED',
        summary: 'App launched, but the only pass is an unverified qa_note claim: no Swipium check judged the app. Run qa_smoke or a flow.',
      };
    if (appHealth === 'degraded')
      return { status: 'PASS_WITH_WARNING', summary: 'App launched, but medium-severity app findings were observed.' };
    if (appHealth === 'unverified')
      return {
        status: 'UNVERIFIED',
        summary: 'App launched, but app-layer health was not verified (visual-only: no UI tree was read). Check the screenshot.',
      };
    return { status: 'PASS', summary: 'No high-severity app/native finding observed in this run.' };
  })();
  const coverageVerdict = (() => {
    if (notTested && !notTested.reachedApp) return { status: 'NONE', summary: `Nothing was tested: ${notTested.reason}.` };
    if (blockedCount > 0 || toolLimitationNotes.length > 0 || driftFailCount > 0 || session.exploration?.state === 'blocked') {
      const summary =
        topBlockedNote?.recommendedSetup ??
        (toolLimitationNotes.length
          ? `A Swipium/tool limitation blocked ${toolLimitationNotes.length} workflow(s); see toolVerdict.`
          : driftFailCount
            ? `${driftFailCount} generated flow(s) failed on a locator step (automation drift, not an app defect); repair with qa_flow_repair.`
            : explorationBlocked
              ? `Exploration was blocked: ${session.exploration!.stoppedReason} (${session.exploration!.summary.blockers} blocker(s), ${session.exploration!.summary.unsafeActionsSkipped} unsafe action(s) skipped).`
              : 'A setup or precondition blocker limited coverage.');
      return { status: 'BLOCKED', summary };
    }
    if (notTested) return { status: 'NOT_COVERED', summary: `Not covered: ${notTested.reason}.` };
    if (budgetSkipped.length)
      return {
        status: 'PARTIAL',
        summary: `${budgetSkipped.length} workflow(s) not run because the session budget ran out: ${budgetSkipped.join(', ')}.`,
      };
    if (!automationBackend.structured) {
      return {
        status: 'PARTIAL',
        summary: 'Coverage was limited because the active backend is visual-only or lacks structured UI automation.',
      };
    }
    if (passNotes === 0 && !session.exploration && session.recordedActions.length === 0) {
      return { status: 'SMOKE_ONLY', summary: 'Only launch/setup evidence was collected.' };
    }
    return { status: 'COVERED', summary: 'Structured smoke/workflow evidence was collected.' };
  })();
  // Tool status reflects recorded tool errors (WDA 404, UNKNOWN…) as well as mcp_limitation notes,
  // never "PASS" after tool errors. Tool health only: it does not change the app verdict.
  const toolVerdict = toolVerdictFor(toolLimitationNotes, session.toolErrors, redact);

  // Single product-facing QA level (Deliverable 6 / §3.11). Derived from the same evidence the
  // report already trusts: readiness labels and health. Honest by construction.
  const qaLevel = deriveQaLevel({
    observed: readiness.includes('observed'),
    smokePassed:
      nativeHealth === 'OK' &&
      (appHealth === 'OK' || appHealth === 'degraded') &&
      high.length === 0 &&
      (passNotes > 0 || !!session.exploration || session.recordedActions.length > 0),
    suiteGenerated: readiness.includes('generated'),
    suiteRunnable: readiness.includes('compiled'),
    ciReplayed: readiness.includes('ci_ready'),
  });

  // Universal run test catalog (Deliverable 4 / review #6): documents executed, skipped, blocked,
  // and exploration-promoted workflows for EVERY run, even when no suite was generated.
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
    findings: uniqueFindings.map((f) => ({ kind: f.kind, severity: f.severity, detail: redact(f.detail) ?? f.detail })),
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

  // Persistent QA test suite: a report run observes QA knowledge, so update the
  // canonical suite under .swipium/test-suite.json and embed the per-run delta + canonical case ids.
  // Best-effort: a suite-merge failure must never break report generation.
  let persistentSuite: Record<string, unknown> | null = null;
  let mergedSuite: import('../testSuite/schema.js').TestSuiteFile | undefined;
  try {
    const now = new Date().toISOString();
    const hasKnowledge = session.recordedActions.length > 0 || notes.length > 0 || !!session.exploration;
    // GOAL-10: actions/exploration recorded on a fatal error surface (RedBox, crash) are not app
    // knowledge; only the recorded outcomes are folded into the canonical suite then.
    const fatalSurface = nativeHealth === 'error' || appHealth === 'error';
    if (hasKnowledge) {
      const { pom } = session.recordedActions.length && !fatalSurface ? pomForSession(session) : { pom: undefined };
      const incoming = generateCanonicalCases({
        pom,
        appId: appId ?? undefined,
        fixtures: session.fixtures,
        notes: session.notes,
        exploration: fatalSurface ? undefined : session.exploration,
        platforms: casePlatformsFor(session), // GOAL-22: the observed platform, not a default "android"
        source: 'report',
        now,
        replayStatus: suiteReplayStatus as ReplayStatus,
      });
      const applied = applyMerge(
        session.root,
        redactDeep(incoming, redact), // defense in depth: no registered secret reaches test-suite.json / TC-*.yaml
        { source: 'report', mode: 'update', now, runId: runIdFromNow(now) },
        appId ?? undefined,
      );
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
      persistentSuite = {
        totalCases: suite.cases.length,
        created: [],
        updated: [],
        deprecated: [],
        failed: [],
        blocked: [],
        newlyAutomated: [],
        caseIds: suite.cases.map((c) => c.id),
      };
    }
  } catch {
    persistentSuite = null;
  }

  const screenshots = session.artifacts.filter((art) => art.kind === 'screenshot');
  const toolErrors = session.toolErrors ?? [];
  const report = {
    sessionId: session.id,
    executiveSummary,
    ...(notTested ? { notTested } : {}),
    appId,
    device: session.device ?? null,
    coverage,
    appVerdict,
    coverageVerdict,
    toolVerdict,
    automationBackend,
    readiness,
    automationReadiness,
    qaLevel,
    runTestCatalog,
    persistentSuite,
    mode: session.mode,
    emulatorDisplay: !session.device
      ? null
      : session.headless === undefined
        ? 'pre-existing device'
        : session.headless
          ? 'headless'
          : 'visible window',
    environmentChanges: session.envChanges,
    ciMutations: session.envChanges,
    mutationLedger: session.mutations.map((m) => ({
      ...m,
      detail: m.detail ? redact(m.detail) : undefined,
    })),
    workaroundsAttempted: session.workarounds,
    inputsProvided: session.inputs.map((i) => ({ varName: i.varName, secret: i.secret, source: i.source })),
    // Disclose degraded redaction after a server restart (secrets are never persisted).
    redactionDegraded: session.redactionDegraded === true,
    generatedValues: session.generatedValues.map((g) => ({
      ...g,
      value: g.secret ? '<redacted>' : redact(g.value),
    })),
    guardrailOverrides: session.envChanges.filter((c) =>
      /OVERRIDE|GUARDRAIL|external-APK|clear_data|fresh_start|allowLaunchWithoutMetro|acknowledgeBundleRisk/i.test(c),
    ),
    launchedWithoutMetroReady: session.envChanges.some((c) => /allowLaunchWithoutMetro/i.test(c)),
    destructiveGuardrail,
    finalNetwork,
    networkRestore: networkRestore ?? (session.network ? 'no change pending' : 'unchanged'),
    activeRecording: activeRecording(session.id) ?? null,
    // Identical findings (same code/kind + screen + message) collapse into one entry with a count.
    findings: dedupeFindings(session.findings).map((f) => {
      const code = (f.failureCode as keyof typeof FAILURES) ?? failureForFindingKind(f.kind);
      const info = FAILURES[code] ?? FAILURES.UNKNOWN;
      return {
        ...f,
        failureCode: code,
        bucket: info.bucket,
        retrySafe: info.retrySafe,
        nextStep: info.recovery,
        detail: redact(f.detail),
        evidence: f.evidence ? redact(f.evidence) : undefined,
      };
    }),
    findingOccurrences: session.findings.length,
    toolErrors: toolErrors.slice(-50).map((t) => ({ ...t, message: redact(t.message) ?? t.message })),
    highSeverityCount: high.length,
    nativeHealth,
    appHealth,
    appHealthFindings: appFindings.map((f) => ({
      kind: f.kind,
      severity: f.severity,
      evidence: f.evidence ? redact(f.evidence) : undefined,
      screen: f.screen,
      screenshotUri: f.screenshotUri,
    })),
    // E2E NEW-18: an agent's pass claim nothing backs is marked `unverified` (exports render it as a
    // skipped / "pass (unverified)" case, never a passing test).
    testOutcomes: notes.map((n) => ({
      ...n,
      reason: n.reason ? redact(n.reason) : undefined,
      ...(unverifiedPassClaim && n.source === 'qa_note' && n.outcome === 'pass' ? { unverified: true } : {}),
    })),
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
    // Generated suite (Phase 3.2.1): paths, compiled flows, runnable status, so the report (not
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
  // Issue memory: fold this run's findings + app-bug outcomes into the durable
  // `.swipium/issues-log.jsonl`, reopen previously-fixed fingerprints, and attach the issue-memory
  // section (+ recurrence markdown) to the report. Best-effort: the ledger never breaks a report.
  try {
    const platform: IssuePlatform = driver instanceof WdaDriver ? 'ios' : driver ? 'android' : 'unknown';
    const environment: IssueEnvironment =
      session.headless !== undefined ? (platform === 'ios' ? 'simulator' : 'emulator') : process.env.CI ? 'ci' : 'unknown';
    const issuePolicy = loadIssuePolicy(session.root);
    const sourceRevision = resolveSourceRevision({
      env: process.env,
      allowGitMetadataRead: issuePolicy.allowGitMetadataRead,
      root: session.root,
    });
    const bridgeFindings: BridgeFinding[] = session.findings.map((f) => ({
      severity: f.severity,
      kind: f.kind,
      detail: redact(f.detail) ?? f.detail,
      layer: f.layer,
      evidence: f.evidence ? redact(f.evidence) : undefined,
      screen: f.screen,
      screenshotUri: f.screenshotUri,
      logUri: f.logUri,
      failureCode: f.failureCode,
    }));
    const bridgeNotes: BridgeNote[] = notes.map((n) => ({
      workflow: n.workflow,
      outcome: n.outcome,
      category: n.category,
      reason: n.reason ? redact(n.reason) : undefined,
      failureCode: (n as { failureCode?: string }).failureCode,
      artifactUris: n.artifactUris,
    }));
    const issuesNow = new Date().toISOString();
    const bridge = foldRunIntoLedger(session.root, bridgeFindings, bridgeNotes, issuesNow, {
      appId: appId ?? undefined,
      platform,
      environment,
      sessionId: session.id,
      sourceRevision,
    });

    // Link recorded issues to persistent test cases, and verify fixed issues that a PASSING case
    // covers this run. The case > workflow key is the workflow string the suite generator
    // folds into actualResult.summary.
    let verifiedFixedIds = new Set<string>();
    if (mergedSuite) {
      const idx = getIssueIndex(session.root, issuesNow, appId ?? undefined);
      const recordById = new Map(idx.records.map((r) => [r.issueId, r]));
      const matchCase = (workflow?: string) =>
        workflow
          ? mergedSuite!.cases.filter(
              (c) =>
                c.actualResult.summary?.toLowerCase().includes(workflow.toLowerCase()) ||
                c.functionality.toLowerCase() === workflow.toLowerCase() ||
                c.title.toLowerCase().includes(workflow.toLowerCase()),
            )
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
          if (passingCaseIds.has(c.id) && c.issueRefs?.some((r) => r.issueId === issueId) && rec)
            linkIssueToCase(c, rec, 'verified_fixed', issuesNow);
        }
      }
      verifiedFixedIds = new Set(verified);
      saveSuite(session.root, mergedSuite);
    }

    // Rebuild the section honoring verified-fixed evidence (honest fix verification).
    const finalIdx = getIssueIndex(session.root, issuesNow, appId ?? undefined);
    const finalSection = buildReportIssuesSection(finalIdx.records, new Set(bridge.recordedIssueIds), verifiedFixedIds);
    (report as Record<string, unknown>).issues = finalSection;
    (report as Record<string, unknown>).issuesMarkdown = issuesSectionToMarkdown(finalSection);
    if (bridge.recurrences.length) (report as Record<string, unknown>).issueRecurrences = bridge.recurrences;

    // Compact quality metrics when enough history exists: this run's new/reopened/verified
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

    // Refresh app-map issue summaries from the freshly-updated ledger, only when a map
    // already exists, and WITHOUT a static rescan (runtime_merge load > apply summaries > save).
    if (existsSync(appMapPath(session.root))) {
      buildAppMap(session.root, { mode: 'runtime_merge', at: issuesNow, includeCodeIndex: false, persist: true });
    }
  } catch {
    /* best-effort: issue ledger is additive, never blocks the report */
  }

  // B9: deep-redact the WHOLE report (steps, nextStep, missingPrecondition, workflow names, issue
  // markdown, …) with the session redactor before it is persisted or rendered into any export.
  // Escaping in JUnit/SARIF/Markdown would otherwise turn a secret into text redaction can't match.
  // Replace the fields rather than merge: a top-level key that itself redacts to a different
  // spelling must not survive in its raw form next to the redacted copy.
  const redactedReport = redactReportData(report as Record<string, unknown>, redact);
  for (const k of Object.keys(report)) delete (report as Record<string, unknown>)[k];
  Object.assign(report, redactedReport);
  const prSummary = { text: inlinePrSummary(report as unknown as ReportData) };
  (report as Record<string, unknown>).prSummary = prSummary;
  const reportUri = sessions.saveArtifact(
    session,
    'report',
    `report-${Date.now()}.json`,
    JSON.stringify(report, null, 2),
    'application/json',
  );
  const reportRec = sessions.findArtifact(reportUri)?.rec;

  let reportLinks: Record<string, unknown> | undefined;
  if ((baseline || trendRoot) && reportRec) {
    try {
      const pr = buildPrSummary(reportRec.path, { baselinePath: baseline, trendRoot: trendRoot ?? session.root });
      reportLinks = {
        current: reportUri,
        currentPath: reportRec.path,
        baseline: baseline ?? null,
        trendRoot: trendRoot ?? session.root,
        comparison: pr.comparison ?? null,
        knownFlaky: pr.knownFlaky,
        prSummary: pr,
      };
      (report as Record<string, unknown>).reportLinks = reportLinks;
      writeFileSync(reportRec.path, JSON.stringify(report, null, 2));
    } catch (e) {
      reportLinks = {
        current: reportUri,
        currentPath: reportRec.path,
        baseline: baseline ?? null,
        trendRoot: trendRoot ?? session.root,
        error: String((e as Error).message ?? e),
      };
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
        const gen = generateFlow(session.recordedActions, {
          name: `${(appId ?? 'app').split('.').pop()}-recorded`,
          appId: appId ?? undefined,
          secrets: session.secrets,
          inputs: inputBindings(session),
        });
        exportUri = sessions.saveArtifact(
          session,
          'flow',
          `recorded-${Date.now()}.yaml`,
          gen.yaml,
          'text/yaml',
          `flow drafted from the run (durability ${gen.durability.grade})`,
        );
      }
    } else {
      const data = report as unknown as ReportData;
      // CI formats (junit/sarif/github-summary) carry a release-gate verdict: map the report's
      // failures onto policy FlowVerdicts, then let .swipium/policy.json (blockOn/warnOn/
      // ignoreKnown) decide pass/fail. With no policy file, ANY failure blocks (applyPolicy).
      const ciFormat = format === 'junit' || format === 'sarif' || format === 'github-summary';
      const policy: PolicyDecision | undefined = ciFormat
        ? applyPolicy(reportPolicyVerdicts(data), loadReleasePolicy(session.root))
        : undefined;
      const body =
        format === 'markdown'
          ? toMarkdown(data)
          : format === 'playwright'
            ? toPlaywrightJson(data)
            : format === 'sarif'
              ? toSarif(data, policy, { sources: resolveSarifSources(session.root, data) })
              : format === 'github-summary'
                ? toGithubSummary(data, policy)
                : toJUnit(data, policy);
      const ext =
        format === 'markdown'
          ? 'md'
          : format === 'playwright'
            ? 'playwright.json'
            : format === 'sarif'
              ? 'sarif.json'
              : format === 'github-summary'
                ? 'summary.md'
                : 'xml';
      const mime =
        format === 'markdown' || format === 'github-summary'
          ? 'text/markdown'
          : format === 'playwright'
            ? 'application/json'
            : format === 'sarif'
              ? 'application/sarif+json'
              : 'application/xml';
      exportUri = sessions.saveArtifact(session, 'report', `report-${Date.now()}.${ext}`, body, mime);
    }
  }

  const manifest = buildSessionArtifactManifest(session);
  const manifestUri = sessions.saveArtifact(
    session,
    'manifest',
    `manifest-${Date.now()}.json`,
    JSON.stringify(manifest, null, 2),
    'application/json',
    'artifact manifest with SHA-256 hashes',
  );
  // E2E NEW-9: an invalid policy (ignored: every failure blocks) or unknown keys are said out loud.
  let releasePolicyNotice: string | null = null;
  try {
    releasePolicyNotice = policyNotice(session.root);
  } catch {
    /* best-effort */
  }
  const noteSummaryLines = notes.map((n) => {
    const ev = evidenceByWorkflow.get(n.workflow);
    return `  • ${n.workflow}: ${n.outcome}${ev ? ` (evidence=${ev.kind}/${ev.authority})` : ''}${n.category ? ` [${n.category}]` : ''}${n.missingPrecondition ? ` (missing: ${n.missingPrecondition})` : n.reason ? `: ${redact(n.reason)}` : ''}${n.recommendedSetup ? ` · setup: ${n.recommendedSetup}` : ''}`;
  });

  const lines = [
    `Report for ${session.id}: app=${report.appId} device=${report.device}`,
    `RELEASE RISK: ${executiveSummary.risk.toUpperCase()}: ${executiveSummary.nextAction}`,
    `App status: ${appVerdict.status} - ${appVerdict.summary}`,
    `Coverage status: ${coverageVerdict.status} - ${coverageVerdict.summary}`,
    `Tool status: ${toolVerdict.status} - ${toolVerdict.summary}`,
    releasePolicyNotice ? `⚠ release-gate policy: ${releasePolicyNotice}` : '',
    `PR summary:\n${prSummary.text}`,
    `backend: ${report.automationBackend.description} (${report.automationBackend.mode})`,
    `QA level: ${qaLevel.level.toUpperCase()}: ${qaLevel.rationale}${qaLevel.next ? ` · next: ${qaLevel.next} (${qaLevel.nextRequirement})` : ''}`,
    qaLevel.notes.length ? `QA level notes:\n  ${qaLevel.notes.join('\n  ')}` : '',
    `automation readiness: ${automationReadiness.grade} (${automationReadiness.score}/100, durable locators ${automationReadiness.locatorCoverage.durablePct}%)`,
    `test catalog: ${runTestCatalog.total} case(s): ${
      Object.entries(runTestCatalog.counts)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') || 'none'
    }`,
    automationReadiness.topFixes.length
      ? `top readiness fixes:\n  ${automationReadiness.topFixes.join('\n  ')}`
      : 'top readiness fixes: none',
    `${report.coverage}${report.visualOnly ? ' · VISUAL-ONLY (structured snapshots were poor, see screenshots)' : ''}`,
    report.device ? `emulator display: ${report.emulatorDisplay}` : '', // AND-4: no device, no display line
    `network: ${finalNetwork}${networkRestore ? ` (${networkRestore})` : session.network?.changed ? ' ⚠ Swipium changed it and did NOT restore' : ''}`,
    report.activeRecording
      ? `A screen recording is still active (${report.activeRecording.backend}, ~${report.activeRecording.seconds}s). It will be stopped on shutdown.`
      : '',
    session.envChanges.length ? `environment changes:\n  ${session.envChanges.join('\n  ')}` : 'environment changes: none',
    session.mutations.length
      ? `mutation ledger: ${session.mutations.length} record(s), ${session.mutations.filter((m) => m.status === 'executed').length} executed, ${session.mutations.filter((m) => m.status === 'refused' || m.status === 'blocked').length} refused/blocked`
      : 'mutation ledger: none',
    report.guardrailOverrides.length
      ? `⚠ guardrail overrides used:\n  ${report.guardrailOverrides.join('\n  ')}`
      : 'guardrail overrides: none',
    session.workarounds.length ? `workarounds attempted:\n  ${session.workarounds.join('\n  ')}` : '',
    session.inputs.length
      ? `inputs provided (redacted): ${session.inputs.map((i) => `${i.varName}${i.secret ? '🔒' : ''}`).join(', ')}`
      : '',
    session.redactionDegraded
      ? '⚠ redaction degraded: this session was restored after a server restart. Secrets registered before the restart are no longer in the redaction set, so artifacts written since may contain those values unredacted'
      : '',
    session.generatedValues.length
      ? `generated test data: ${session.generatedValues.map((g) => `${g.fixture}.${g.field}=${g.secret ? '<redacted>' : redact(g.value)} (${g.generator})`).join(', ')}`
      : '',
    options.suite
      ? options.suite.generated
        ? `generated suite "${options.suite.name}": ${(options.suite.compiledFlows ?? []).filter((c) => c.ok).length}/${(options.suite.compiledFlows ?? []).length} runnable flow(s), runnable=${options.suite.suiteRunnable}, readiness=${(options.suite.readinessLabels ?? []).join(' > ') || 'unknown'} (${(options.suite.written ?? []).length} files)`
        : `suite generation skipped: ${options.suite.skippedReason}`
      : '',
    session.exploration
      ? `exploration: ${session.exploration.summary.screensVisited} screens, ${session.exploration.summary.workflowsFound} transitions, ${session.exploration.summary.visualOnlyScreens} visual-only, ${session.exploration.summary.unsafeActionsSkipped} unsafe skipped, ${session.exploration.summary.appErrors} app errors (graph: ${session.exploration.graphUri})`
      : '',
    `destructive/bundle-risk guardrail: ${destructiveGuardrail.status}`,
    `health: native: ${nativeHealth === 'OK' ? '✅ OK' : nativeHealth === 'error' ? '❌ error' : nativeHealth} · app: ${appHealth === 'OK' ? '✅ OK' : appHealth === 'degraded' ? '⚠ degraded' : appHealth === 'error' ? '❌ error' : appHealth === 'unverified' ? '⚠ unverified (visual-only)' : appHealth}`,
    wdaReport
      ? `wda: ${wdaReport.status.reachable ? 'reachable' : 'unreachable'} ${wdaReport.webDriverAgentUrl} device=${wdaReport.device ?? 'unknown'}`
      : '',
    `findings: ${uniqueFindings.length} unique (${session.findings.length} occurrence(s), high: ${high.length})`,
    toolErrors.length
      ? `tool errors: ${toolVerdict.toolErrorCount}: ${Object.entries(toolVerdict.toolErrorsByCode)
          .map(([c, n]) => `${c}×${n}`)
          .join(', ')}`
      : '',
    totalFailures
      ? `failures by bucket: ${ALL_BUCKETS.filter((b) => bucketCounts[b])
          .map((b) => `${b}=${bucketCounts[b]}`)
          .join(' ')} (${failureBuckets.classifiedPct}% classified${dominantBucket ? `, mostly ${dominantBucket}` : ''})`
      : '',
    notes.length
      ? `evidence taxonomy: structured=${evidenceTaxonomy.counts.structured_locator} ocr=${evidenceTaxonomy.counts.ocr_locator} visual=${evidenceTaxonomy.counts.visual_match} ai_visual=${evidenceTaxonomy.counts.ai_visual_evidence} manual=${evidenceTaxonomy.counts.manual_review} calibration=${evidenceTaxonomy.calibration.status}`
      : '',
    ...uniqueFindings.map(
      (f) =>
        `  [${f.severity}] ${f.layer ?? '?'}/${f.kind}: ${redact(f.detail)}${f.evidence ? `: "${redact(f.evidence)}"` : ''}${f.screenshotUri ? ` (${f.screenshotUri})` : ''}${repeatSuffix(f)}`,
    ),
    notes.length
      ? `test outcomes: ${Object.entries(outcomeTally)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}`
      : 'test outcomes: none recorded (qa_note)',
    ...noteSummaryLines,
    persistentSuite
      ? `persistent suite: ${persistentSuite.totalCases} case(s): +${(persistentSuite.created as string[]).length} created, ~${(persistentSuite.updated as string[]).length} updated, -${(persistentSuite.deprecated as string[]).length} deprecated, ${(persistentSuite.failed as string[]).length} failed, ${(persistentSuite.blocked as string[]).length} blocked, ${(persistentSuite.newlyAutomated as string[]).length} newly automated`
      : '',
    `auth: ${authState}`,
    session.fixtures.length ? `declared preconditions: ${session.fixtures.map((f) => f.name).join(', ')}` : '',
    `timing: total=${secText(phaseTimings.totalMs)} setup=${secText(phaseTimings.setupMs)} active=${secText(phaseTimings.activeMs)}${phaseTimings.timeToLoginMs != null ? ` toLogin=${secText(phaseTimings.timeToLoginMs)}` : ''}${phaseTimings.diagnostics.waitMs != null ? ` wait=${secText(phaseTimings.diagnostics.waitMs)}` : ''}${phaseTimings.diagnostics.flowRuntimeMs != null ? ` flows=${secText(phaseTimings.diagnostics.flowRuntimeMs)}` : ''}${session.budgetProfile ? ` (profile=${session.budgetProfile})` : ''}`,
    reportLinks
      ? `report links: baseline=${baseline ?? 'none'} trend=${trendRoot ?? session.root}${typeof reportLinks.comparison === 'string' ? ` comparison=${reportLinks.comparison}` : ''}`
      : '',
    `artifacts: ${session.artifacts.length} (${screenshots.length} screenshots)`,
    ...session.artifacts.map((art) => `  ${art.uri} (${art.kind}${art.label ? `: ${art.label}` : ''})`),
    dumpUri ? `current dump: ${dumpUri}` : '',
    `report: ${reportUri}`,
    `manifest: ${manifestUri}`,
    exportUri && exportUri !== reportUri ? `${format} export: ${exportUri}` : '',
  ].filter(Boolean);

  // report.md: the agent-readable report (this summary), what terminal results and the server
  // instructions point at. report.json stays the machine/CI copy.
  // E2E NEW-12: run text (note reasons, logcat, Metro output) can carry ANSI escapes / NULs; neither the
  // qa_report text nor report.md keeps them.
  const summaryText = stripControls(redact(lines.join('\n')) ?? '');
  const reportMdUri = sessions.saveArtifact(
    session,
    'report',
    `report-${Date.now()}-summary.md`,
    `# Swipium report ${session.id}\n\n${summaryText}\n`,
    'text/markdown',
    'report.md (agent-readable summary)',
  );

  return {
    report,
    reportUri,
    reportMdUri,
    reportHead: buildReportHead(report as Record<string, unknown>, { reportMdUri, reportUri }),
    manifestUri,
    manifest,
    dumpUri,
    reportLinks,
    exportUri,
    exportFormat: exportUri ? format : undefined,
    summaryText: `${summaryText}\nreport.md: ${reportMdUri}`,
    flowExportSkipped,
  };
}
