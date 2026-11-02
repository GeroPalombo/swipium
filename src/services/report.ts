// Report service: the session-report assembly, extracted from the
// qa_report tool so qa_test_this execute can produce a real report artifact in EVERY terminal
// state (completed or blocked), not just tell the agent to call qa_report. qa_report is now a thin
// wrapper around generateSessionReport().

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRedactor, redactDeep } from '../lib/redact.js';
import { inputBindings } from '../suite/secretGuard.js';
import { dedupeFindings } from '../report/findingsDedupe.js';
import { toolVerdictFor } from '../report/toolHealth.js';
import { getDriver } from '../session/attach.js';
import { restoreNetwork } from '../tools/network.js';
import { buildAgentSummary, releaseAssessment } from '../report/summary.js';
import { renderReportHtml } from '../report/html.js';
import { log } from '../lib/logger.js';
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
  annotateAttempts,
  computeAttemptKey,
  isNotTested,
  workflowKey,
  latestAttempts,
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
import { applyMerge, loadSuiteChecked, suiteDelta, runIdFromNow } from '../testSuite/store.js';
import type { ReplayStatus } from '../testSuite/schema.js';
import {
  encodeUriSegment,
  PRIVATE_FILE_MODE,
  safeArtifactName,
  type Session,
  type SessionStore,
  type StepRecord,
  type TestNote,
} from '../session/store.js';

export type ReportFormat = 'summary' | 'markdown' | 'json' | 'junit' | 'sarif' | 'github-summary' | 'flow' | 'playwright';

export interface ReportOptions {
  format?: ReportFormat;
  baseline?: string;
  trendRoot?: string;
  includeCurrentDump?: boolean;
  /** Suite outputs to embed in the report: paths, compiled flows, runnable status. */
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
  /** The job generating this report (qa_test_this, qa_test_feature): it is running by definition,
   *  so it never marks its own report partial. */
  excludeJobId?: string;
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
  /** report.html (absolute path) and its file:// URL: what the human opens. Overwritten per call. */
  reportHtmlPath: string;
  reportHtmlUrl: string;
  /** Set when report.html could not be rendered (the JSON report and summary still exist). */
  reportHtmlError?: string;
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
      // A backend that can't toggle the network (iOS) must not make report generation
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
      // Raw XML on purpose: saveArtifact redacts XML structurally (attribute values / text nodes),
      // while a plain-text pass first could rewrite markup a short secret happens to match.
      const xml = await driver.dumpXml();
      dumpUri = sessions.saveArtifact(session, 'dump', `dump-${Date.now()}.xml`, xml ?? '', 'application/xml');
    } catch {
      /* best-effort (animated/idle-fail) */
    }
  }

  const finalNetwork = driver ? ((await driver.airplaneOn().catch(() => false)) ? 'offline' : 'online') : 'unknown';
  const high = session.findings.filter((f) => f.severity === 'high');
  const uniqueFindings = dedupeFindings(session.findings);

  // WDA returning no UI source (a native/high wda_unreachable finding) is
  // a tool / environment failure (WDA_UNREACHABLE). It still fails the gate as a high finding, but it
  // is not native/app health, not an app failure and not evidence that the app was exercised.
  const isToolFinding = (f: { kind: string; failureCode?: string }) => f.kind === 'wda_unreachable' || f.failureCode === 'WDA_UNREACHABLE';
  // The one high-severity count every consumer uses: unique (deduplicated) app/native findings, tool
  // failures excluded (they still gate, as findings, but are not an app verdict).
  const highSeverityCount = uniqueFindings.filter((f) => f.severity === 'high' && !isToolFinding(f)).length;
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

  // Verdicts (risk banner, fail counts, app/coverage status) count the latest attempt per workflow,
  // the same collapse the release gate and JUnit use (report/export.ts latestAttempts), so a flow that
  // failed and then passed on a separate run never blocks the banner while the gate passes.
  const gated = latestAttempts(notes);
  const blockedCount = gated.filter((n) => n.outcome === 'blocked').length;
  const APP_OWNED_FAIL_CATEGORIES = new Set(['app_bug', 'other']);
  // A Swipium-generated flow failing on a locator step is automation drift (category
  // 'other' + AUTOMATION_DRIFT_NOTE): a caution to repair the flow, never an app FAIL / BLOCK.
  const driftFailCount = gated.filter(isAutomationDriftNote).length;
  const appFailNotes = gated.filter(
    (n) => n.outcome === 'fail' && (n.category == null || APP_OWNED_FAIL_CATEGORIES.has(n.category)) && !isAutomationDriftNote(n),
  );
  const appFailCount = appFailNotes.length;
  const toolLimitationNotes = gated.filter((n) => (n.outcome === 'fail' || n.outcome === 'blocked') && n.category === 'mcp_limitation');
  const toolLimitationFailCount = toolLimitationNotes.filter((n) => n.outcome === 'fail').length;
  // A failure that is neither the app's, a tool limitation nor drift (missing_test_data,
  // destructive_refused, intentionally_skipped) still fails the gate by default: never SHIP on it.
  const otherFailNotes = gated.filter(
    (n) => n.outcome === 'fail' && !appFailNotes.includes(n) && n.category !== 'mcp_limitation' && !isAutomationDriftNote(n),
  );
  const topHigh = high.find((f) => !isToolFinding(f)) ?? high[0];
  const topAppFailNote = appFailNotes[0];
  const topBlockedNote = gated.find((n) => n.outcome === 'blocked');
  // No evidence => never SHIP. Only a Swipium-run check that
  // looked at the app's UI and found it healthy counts as exercising the app: a smoke or flow pass
  // whose oracle read the UI (a launch smoke with app=ok, so RedBox / blank were ruled out), or an
  // exploration that reached at least one structured (non visual-only) app screen. Agent verdicts
  // (qa_note, qa_visual assert), launches, screenshots, raw actions and findings never count, and
  // never clear a persisted not-tested marker. An agent's failure claim never makes a run "tested"
  // either: it still reaches the gate through testOutcomes, so it can block but never pass a run.
  const isOutcome = (n: TestNote) => n.outcome === 'pass' || (n.outcome === 'fail' && n.category !== 'mcp_limitation');
  // Swipium ran the check and judged it itself: not an agent note, not a qa_visual assert verdict
  // (manual_review) and not a screenshot-only pass (method visual: nothing ruled out a RedBox).
  const swipiumJudged = (n: TestNote) => n.source !== 'qa_note' && n.evidenceKind !== 'manual_review' && n.method !== 'visual';
  const healthyPass = (n: TestNote) => n.outcome === 'pass' && (n.workflow !== 'launch_smoke' || /\bapp=ok\b/.test(n.reason ?? ''));
  const ex = session.exploration;
  const exploredRealScreenAt = ex && ex.summary.screensVisited - ex.summary.visualOnlyScreens > ex.summary.appErrors ? ex.at : 0;
  // Swipium's own healthy pass (or failure) or a real-screen exploration recorded after `t`.
  // Counts the collapsed list only, so an attempt a later verdict replaced never makes a run tested.
  const swipiumOutcomeSince = (t: number) =>
    gated.some((n) => n.at > t && swipiumJudged(n) && isOutcome(n) && (n.outcome === 'fail' || healthyPass(n))) || exploredRealScreenAt > t;
  // An action with the app under test in front (qa_act's post-action check): proves the app was
  // reached, never that it was tested.
  const appActionSince = (t: number) => session.recordedActions.some((ra) => ra.at > t && ra.appForeground);
  const appShotSince = (t: number) =>
    session.artifacts.some((art) => (art.kind === 'screenshot' || art.kind === 'recording') && art.appForeground && art.createdAt > t);
  // Reaching the app takes real evidence: a launch of the app under test, a
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
  // Only Swipium-judged outcomes exercise the app. An agent's pass or fail claim does not.
  const exercised = swipiumOutcomeSince(0);
  const agentFailClaim = !exercised && gated.some((n) => !swipiumJudged(n) && n.outcome === 'fail' && n.category !== 'mcp_limitation');
  const unverifiedPassClaim =
    !exercised && gated.some((n) => (n.source === 'qa_note' || n.evidenceKind === 'manual_review') && n.outcome === 'pass');
  const unbackedPassClaim = unverifiedPassClaim && !appSeen;
  const reachedApp = exercised || appSeen;
  // A not-tested run stays not tested for every later qa_report (same verdict, same
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
  // A refused consent (CONSENT_CANCELLED / _DECLINED / _REFUSED) is ledgered on the
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
        // reachedApp:false from the caller = THIS run never launched the app (a launch failure);
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
              : agentFailClaim
                ? 'only an agent qa_note failure claim (no Swipium smoke, flow or exploration ran, and no device evidence): nothing was launched or exercised'
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
              : agentFailClaim
                ? 'only an agent qa_note failure claim on a launched app (no Swipium smoke, flow or exploration ran): run qa_smoke or a flow'
                : topBlockedNote
                  ? `the app was reached but no workflow was exercised (recorded "${topBlockedNote.workflow}" as blocked${topBlockedNote.reason ? `: ${redact(topBlockedNote.reason)}` : ''})`
                  : 'the app was reached but no workflow was exercised',
            failureCode: blockerCodeOf(topBlockedNote),
          };
  // Same rule as the gate (isNotTested): a reached and exercised app is informational, not "not tested".
  const countsAsNotTested = !!notTested && isNotTested({ notTested });
  // Health was never checked when the app was never reached; "OK" would be a claim.
  // A visual-only smoke (no UI tree read) left app-layer health "unverified", never OK.
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
  // "Visual-only" is only true when no UI tree was read at all this session. A tool failure (WDA
  // returning no source) or a smoke that could not judge the screen is unverified for another reason.
  const treeRead =
    !!session.lastSnapshot ||
    !!dumpUri ||
    session.artifacts.some((art) => art.kind === 'dump') ||
    (session.steps ?? []).some((st) => !!st.dumpUri) ||
    notes.some((n) => n.method === 'structured' || (n.workflow === 'launch_smoke' && /\bapp=ok\b/.test(n.reason ?? ''))) ||
    (ex ? ex.summary.screensVisited - ex.summary.visualOnlyScreens > 0 : false);
  const appHealthUnverifiedReason =
    appHealth !== 'unverified' || !treeRead
      ? undefined
      : session.findings.some(isToolFinding)
        ? 'the automation backend returned no UI tree (tool failure)'
        : 'the launch smoke could not judge the app screen';
  // Coverage the run planned but did not get must not leave the risk at SHIP.
  // Flows whose latest outcome is a session-budget skip were not run; a blocked exploration
  // (unsafe actions skipped, blockers, budget stop) explored less than it set out to.
  // Same collapse as the gate: a pass followed by a budget skip still counts as the pass. Notes
  // with no attempt kind (older notes) never collapse, so a later pass/fail by name also covers them.
  const isBudgetSkip = (n: TestNote) => n.outcome === 'skipped' && /^budget:|BUDGET_EXHAUSTED/.test(n.reason ?? '');
  const annotatedNotes = annotateAttempts(notes);
  const budgetSkipped = [
    ...new Set(
      annotatedNotes.flatMap((n, idx) =>
        !(n as { superseded?: boolean }).superseded &&
        isBudgetSkip(n) &&
        !annotatedNotes
          .slice(idx + 1)
          .some((l) => workflowKey(l.workflow) === workflowKey(n.workflow) && (l.outcome === 'pass' || l.outcome === 'fail'))
          ? [n.workflow]
          : [],
      ),
    ),
  ];
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
    ...(countsAsNotTested ? { notTested } : {}),
    nativeHealth,
    appHealth,
    ...(appHealthUnverifiedReason ? { appHealthUnverifiedReason } : {}),
    // A WDA_UNREACHABLE finding is a tool / environment failure, not an app verdict: it keeps the risk
    // off SHIP (tool status, app health unverified) and still fails the gate, but is no app BLOCK.
    highSeverityCount,
    failCount: appFailCount,
    blockedCount: blockedCount + toolLimitationFailCount + driftFailCount,
    otherFailCount: otherFailNotes.length,
    topOtherFail: otherFailNotes[0]
      ? {
          workflow: otherFailNotes[0].workflow,
          category: otherFailNotes[0].category,
          reason: otherFailNotes[0].reason ? redact(otherFailNotes[0].reason) : undefined,
        }
      : undefined,
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
  const passNotes = gated.filter((n) => n.outcome === 'pass').length;
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
    // Launched, but the only pass is the agent's claim: nothing Swipium ran judged the app.
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
        summary: `App launched, but app-layer health was not verified (${appHealthUnverifiedReason ?? 'visual-only: no UI tree was read'}). Check the screenshot.`,
      };
    return { status: 'PASS', summary: 'No high-severity app/native finding observed in this run.' };
  })();
  const coverageVerdict = (() => {
    if (notTested && !notTested.reachedApp) return { status: 'NONE', summary: `Nothing was tested: ${notTested.reason}.` };
    if (
      blockedCount > 0 ||
      toolLimitationNotes.length > 0 ||
      driftFailCount > 0 ||
      otherFailNotes.length > 0 ||
      session.exploration?.state === 'blocked'
    ) {
      const summary =
        topBlockedNote?.recommendedSetup ??
        (toolLimitationNotes.length
          ? `A Swipium/tool limitation blocked ${toolLimitationNotes.length} workflow(s); see toolVerdict.`
          : driftFailCount
            ? `${driftFailCount} generated flow(s) failed on a locator step (automation drift, not an app defect); repair with qa_flow_repair.`
            : otherFailNotes.length
              ? `${otherFailNotes.length} workflow(s) failed for a non-app reason (${[...new Set(otherFailNotes.map((n) => n.category ?? 'uncategorized'))].join(', ')}); provide the missing data or setup and re-run.`
              : explorationBlocked
                ? `Exploration was blocked: ${session.exploration!.stoppedReason} (${session.exploration!.summary.blockers} blocker(s), ${session.exploration!.summary.unsafeActionsSkipped} unsafe action(s) skipped).`
                : 'A setup or precondition blocker limited coverage.');
      return { status: 'BLOCKED', summary };
    }
    if (notTested && countsAsNotTested) return { status: 'NOT_COVERED', summary: `Not covered: ${notTested.reason}.` };
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

  // Single product-facing QA level. Derived from the same evidence the
  // report already trusts: readiness labels and health. Honest by construction.
  const qaLevel = deriveQaLevel({
    observed: readiness.includes('observed'),
    smokePassed:
      nativeHealth === 'OK' &&
      (appHealth === 'OK' || appHealth === 'degraded') &&
      highSeverityCount === 0 &&
      (passNotes > 0 || !!session.exploration || session.recordedActions.length > 0),
    suiteGenerated: readiness.includes('generated'),
    suiteRunnable: readiness.includes('compiled'),
    ciReplayed: readiness.includes('ci_ready'),
  });

  // Universal run test catalog: documents executed, skipped, blocked,
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
  // Why the persistent suite was not updated (a corrupt test-suite.json is refused, never
  // overwritten). Said in the report instead of failing silently.
  let suiteWarning: string | null = null;
  const suiteFailure = (e: unknown) => {
    const msg = String((e as Error)?.message ?? e);
    suiteWarning ??= /does not parse/.test(msg)
      ? `.swipium/test-suite.json is corrupt; the persistent suite was not updated (${redact(msg) ?? msg})`
      : `the persistent suite was not updated: ${redact(msg) ?? msg}`;
  };
  // Idempotent fold: a qa_report re-call with no new activity must not merge the suite, the issue
  // ledger or the app map again (duplicate run history, duplicate issue events). The key is computed
  // from the run's content, not a counter: the report's own artifact saves persist the session too.
  const foldKey = runFoldKey(session);
  const previousFold = session.lastFoldKey === foldKey ? lastFoldedReport(session) : undefined;
  if (previousFold) {
    persistentSuite = (previousFold.persistentSuite as Record<string, unknown> | null | undefined) ?? null;
    if (typeof previousFold.persistentSuiteWarning === 'string') suiteWarning = previousFold.persistentSuiteWarning;
  } else
    try {
      const now = new Date().toISOString();
      const hasKnowledge = session.recordedActions.length > 0 || notes.length > 0 || !!session.exploration;
      // Actions/exploration recorded on a fatal error surface (RedBox, crash) are not app
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
          platforms: casePlatformsFor(session), // the observed platform, not a default "android"
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
        const checked = loadSuiteChecked(session.root, appId ?? undefined);
        const suite = checked.suite;
        // An unparseable file reads as an empty suite; never save that view over it.
        if (checked.corrupt) suiteFailure(new Error(`test-suite.json does not parse (${checked.corrupt})`));
        else mergedSuite = suite;
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
    } catch (e) {
      persistentSuite = null;
      mergedSuite = undefined;
      suiteFailure(e);
    }

  const toolErrors = session.toolErrors ?? [];
  // Another job of this session still running (an explore, a suite replay, a second qa_test_this):
  // this report is a snapshot of an unfinished run. The reporting job itself is excluded.
  const runningJob = [...session.jobs.values()].find((j) => j.status === 'running' && j.jobId !== options.excludeJobId);
  const partial = runningJob ? { jobId: runningJob.jobId, kind: runningJob.kind } : null;
  // An invalid policy (ignored: every failure blocks) or unknown keys are said in the report.
  let releasePolicyNotice: string | null = null;
  try {
    releasePolicyNotice = policyNotice(session.root);
  } catch {
    /* best-effort */
  }
  const report = {
    schemaVersion: 2,
    sessionId: session.id,
    partial,
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
    releasePolicyNotice,
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
    highSeverityCount,
    nativeHealth,
    appHealth,
    appHealthFindings: appFindings.map((f) => ({
      kind: f.kind,
      severity: f.severity,
      evidence: f.evidence ? redact(f.evidence) : undefined,
      screen: f.screen,
      screenshotUri: f.screenshotUri,
    })),
    // An agent's pass claim nothing backs is marked `unverified` (exports render it as a
    // skipped / "pass (unverified)" case, never a passing test).
    // Every entry is kept; the one that counts per workflow also carries `attempts` / `flaky`
    // (latestAttempts over this list gives the same verdicts, so saved reports re-gate the same).
    testOutcomes: annotateAttempts(
      outcomeEvidence(session, notes, isToolFinding).map(({ note: n, stepRange, evidence, contradicted }) => {
        const attemptKey = computeAttemptKey(n);
        return {
          ...n,
          ...(attemptKey ? { attemptKey } : {}),
          reason: n.reason ? redact(n.reason) : undefined,
          ...(unverifiedPassClaim && n.source === 'qa_note' && n.outcome === 'pass' ? { unverified: true } : {}),
          ...(stepRange ? { stepRange } : {}),
          evidence,
          ...(contradicted ? { contradicted: true } : {}),
        };
      }),
    ),
    // The step timeline (already secret-safe in the store; the whole report is redacted again below).
    steps: (session.steps ?? []).map((st) => ({ ...st })),
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
    // Generated suite: paths, compiled flows, runnable status, so the report (not
    // just the job result) records whether a runnable automation suite was produced.
    generatedSuite: options.suite ?? null,
    // Guided exploration: screen graph + coverage counts.
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
    // `path` is relative to the session folder, never absolute: report.json gets uploaded from CI and
    // must not carry $HOME or the username.
    artifacts: session.artifacts.map((art) => {
      const rel = relativeArtifactPath(session.dir, art.path);
      return {
        uri: art.uri,
        kind: art.kind,
        mime: art.mime,
        label: art.label,
        ...(rel ? { path: rel } : {}),
        createdAt: art.createdAt,
        ...(art.redaction ? { redaction: art.redaction } : {}),
      };
    }),
    counters: session.counters,
  };
  // Issue memory: fold this run's findings + app-bug outcomes into the durable
  // `.swipium/issues-log.jsonl`, reopen previously-fixed fingerprints, and attach the issue-memory
  // section (+ recurrence markdown) to the report. Best-effort: the ledger never breaks a report.
  if (previousFold) {
    for (const k of ['issues', 'issuesMarkdown', 'issueRecurrences', 'issueMetrics'] as const)
      if (previousFold[k] !== undefined) (report as Record<string, unknown>)[k] = previousFold[k];
  } else
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
        // Isolated: a refused save must not skip the issue section and app-map refresh below.
        try {
          saveSuite(session.root, mergedSuite);
        } catch (e) {
          suiteFailure(e);
        }
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
  if (session.lastFoldKey !== foldKey) {
    session.lastFoldKey = foldKey;
    sessions.persist(session);
  }
  if (suiteWarning) (report as Record<string, unknown>).persistentSuiteWarning = suiteWarning;

  // Deep-redact the WHOLE report (steps, nextStep, missingPrecondition, workflow names, issue
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

  // report.html: one stable file per session, overwritten on every call, rendered from the already
  // redacted report. Written directly (not through saveArtifact's text redactor, which could rewrite
  // base64 image data), with the private file mode, and ONE artifact record upserted.
  const reportHtmlPath = join(session.dir, 'report', 'report.html');
  const reportHtmlUrl = pathToFileURL(reportHtmlPath).href;
  let reportHtmlError: string | undefined;
  try {
    const html = await renderReportHtml(report as unknown as ReportData, {
      sessionDir: session.dir,
      root: session.root,
      redact: (s) => redact(s) ?? s,
    });
    mkdirSync(join(session.dir, 'report'), { recursive: true, mode: 0o700 });
    writeFileSync(reportHtmlPath, html, { mode: PRIVATE_FILE_MODE });
    upsertReportHtmlArtifact(sessions, session, reportHtmlPath);
  } catch (e) {
    reportHtmlError = String((e as Error)?.message ?? e);
    log('warn', 'report.html could not be rendered; the JSON report and summary are still written', { err: reportHtmlError });
  }

  // summary.md: the agent-readable report (<= 2 KB, failure first). report.json and report.html hold
  // everything else. Run text (note reasons, logcat, Metro output) can carry ANSI escapes / NULs;
  // neither the qa_report text nor summary.md keeps them.
  const summaryText = stripControls(
    redact(
      buildAgentSummary(report as unknown as Parameters<typeof buildAgentSummary>[0], {
        reportHtmlPath,
        reportHtmlError,
        reportJsonPath: reportRec?.path ?? reportUri,
      }),
    ) ?? '',
  );
  const reportMdUri = sessions.saveArtifact(
    session,
    'report',
    `report-${Date.now()}-summary.md`,
    `${summaryText}\n`,
    'text/markdown',
    'report.md (agent-readable summary)',
  );
  // Written last so it lists (and hashes) report.md and report.html too.
  const manifestName = safeArtifactName(`manifest-${Date.now()}.json`);
  const manifest = buildSessionArtifactManifest(session);
  const manifestUri = sessions.saveArtifact(
    session,
    'manifest',
    manifestName,
    JSON.stringify(manifest, null, 2),
    'application/json',
    'artifact manifest with SHA-256 hashes',
  );

  return {
    report,
    reportUri,
    reportMdUri,
    reportHead: buildReportHead(report as Record<string, unknown>, { reportMdUri, reportUri, reportHtmlPath, reportHtmlError }),
    manifestUri,
    manifest,
    dumpUri,
    reportLinks,
    exportUri,
    exportFormat: exportUri ? format : undefined,
    summaryText: `${summaryText}\nreport.md: ${reportMdUri}`,
    flowExportSkipped,
    reportHtmlPath,
    reportHtmlUrl,
    ...(reportHtmlError ? { reportHtmlError } : {}),
  };
}

/** An artifact path relative to the session folder, or undefined when it lives outside it. */
function relativeArtifactPath(sessionDir: string, path: string): string | undefined {
  if (!path) return undefined;
  const rel = relative(sessionDir, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split('\\').join('/');
}

/** High findings that contradict a pass inside its step range: crashes, ANRs, app error surfaces. */
function contradictsPass(f: { severity: string; kind: string; layer?: string; failureCode?: string }): boolean {
  return f.severity === 'high' && (f.layer === 'native' || f.layer === 'app' || /crash|anr|error/i.test(f.kind));
}

/**
 * Per outcome: the steps it covers, the evidence Swipium holds for it, and whether a pass is
 * contradicted. The step range is the note's own, else the steps since the previous note. Evidence
 * is the checkpoint, failed steps' screenshot/dump inside the range, and explicit artifactUris, kept
 * only when they resolve to this session's artifacts. A pass is contradicted by a high crash / ANR /
 * app-error finding inside its range (by time) or a failed flow or smoke step in it. Failed qa_act
 * steps never count: agents routinely miss an element and retry. Display only; the gate is unchanged.
 */
export function outcomeEvidence(
  session: Pick<Session, 'artifacts' | 'findings'> & { steps?: StepRecord[] },
  notes: TestNote[],
  isToolFinding: (f: { kind: string; failureCode?: string }) => boolean = () => false,
): Array<{ note: TestNote; stepRange?: [number, number]; evidence: string[]; contradicted: boolean }> {
  const known = new Set(session.artifacts.map((a) => a.uri));
  const steps = session.steps ?? [];
  const against = session.findings.filter((f) => contradictsPass(f) && !isToolFinding(f));
  return notes.map((n, idx) => {
    const prevAt = idx > 0 ? notes[idx - 1].at : Number.NEGATIVE_INFINITY;
    let stepRange = n.stepRange;
    if (!stepRange) {
      const since = steps.filter((st) => st.at > prevAt && st.at <= n.at);
      if (since.length) stepRange = [since[0].i, since[since.length - 1].i];
    }
    const range = stepRange;
    const inRange = range ? steps.filter((st) => st.i >= range[0] && st.i <= range[1]) : [];
    const candidates = [
      n.checkpointUri,
      ...inRange.filter((st) => st.result === 'failed').flatMap((st) => [st.screenshotUri, st.dumpUri]),
      ...(n.artifactUris ?? []),
    ];
    const evidence = [...new Set(candidates.filter((u): u is string => !!u && known.has(u)))];
    let contradicted = false;
    if (n.outcome === 'pass' && inRange.length) {
      const from = Math.min(...inRange.map((st) => st.at));
      contradicted =
        inRange.some((st) => st.result === 'failed' && (st.source === 'flow' || st.source === 'smoke')) ||
        against.some((f) => f.at >= from && f.at <= n.at);
    }
    return { note: n, ...(stepRange ? { stepRange } : {}), evidence, contradicted };
  });
}

/** Content key of what a report folds into the suite / issue ledger / app map: activity counts plus
 *  the newest note and exploration times. Report, dump, manifest and summary artifacts are not part
 *  of it, so a report re-call with nothing new gives the same key. stepSeq and the last recorded
 *  action's time stand in for the list lengths once those lists hit their caps. */
export function runFoldKey(
  session: Pick<Session, 'notes' | 'findings' | 'recordedActions' | 'exploration'> & { steps?: StepRecord[]; stepSeq?: number },
): string {
  const parts = [
    session.notes.length,
    session.findings.length,
    session.steps?.length ?? 0,
    session.stepSeq ?? 0,
    session.recordedActions.length,
    session.recordedActions[session.recordedActions.length - 1]?.at ?? 0,
    session.notes[session.notes.length - 1]?.at ?? 0,
    session.exploration?.at ?? 0,
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** The newest report.json this session saved (the fold it already made), or undefined. */
function lastFoldedReport(session: Session): Record<string, unknown> | undefined {
  const rec = [...session.artifacts]
    .reverse()
    .find((a) => a.kind === 'report' && /^report-\d+\.json$/.test(a.path.split(/[\\/]/).pop() ?? ''));
  if (!rec) return undefined;
  try {
    return JSON.parse(readFileSync(rec.path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** One artifact record for report.html, refreshed in place on every report (no pile-up). */
function upsertReportHtmlArtifact(sessions: SessionStore, session: Session, path: string): void {
  const uri = `swipium://session/${encodeUriSegment(session.id)}/report/report.html`;
  const existing = session.artifacts.find((a) => a.uri === uri);
  if (existing) {
    existing.createdAt = Date.now();
    existing.path = path;
  } else {
    session.artifacts.push({
      uri,
      path,
      mime: 'text/html',
      kind: 'report',
      createdAt: Date.now(),
      label: 'report.html (open in a browser)',
      // Text is the redacted report; embedded screenshots are pixels, which redaction can't touch.
      redaction: 'not-applied',
      redactionNote: 'text is redacted; embedded screenshots may show sensitive on-screen content',
    });
  }
  sessions.persist(session);
}
