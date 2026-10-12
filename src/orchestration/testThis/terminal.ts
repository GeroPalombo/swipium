// qa_test_this terminal-state assembly: every terminal state (completed OR blocked) generates a
// report artifact (Milestone B) and lands the uniform TerminalEnvelope on the job result, so the
// outcome is summarizable from structured output without log parsing.

import {
  buildTerminalEnvelope,
  typedBlockerFromCode,
  type NextRecommendedAction,
  type TerminalEnvelope,
  type TypedBlocker,
} from '../envelope.js';
import { generateSessionReport } from '../../services/report.js';
import type { SuiteGenerationResult } from '../../services/suiteGenerate.js';
import { startProgress } from '../../session/progress.js';
import { log } from '../../lib/logger.js';
import type { Session, SessionStore, JobRecord } from '../../session/store.js';
import type { ExecuteArgs, ExecState } from './types.js';

export interface FinishContext {
  sessions: SessionStore;
  session: Session;
  job: JobRecord;
  a: ExecuteArgs;
  /** Concrete steps attempted so far (shared with the pipeline; read at finish time). */
  attempted: string[];
  /** Artifact URIs collected so far (shared with the pipeline; the report URI is appended). */
  artifacts: string[];
  /** Suite outputs (set in the terminal section) are embedded in the report, not just the job result. */
  getSuiteForReport: () => SuiteGenerationResult | undefined;
  upd: (patch: Partial<JobRecord>) => void;
}

export type Finish = (state: ExecState, failureCode: string | undefined, summary: string, extra?: Record<string, unknown>) => Promise<void>;

/** Every terminal state (completed OR blocked) generates a report artifact (Milestone B). */
export function createFinisher(ctx: FinishContext): Finish {
  const { sessions, session, job, a, attempted, artifacts, upd } = ctx;
  return async (state: ExecState, failureCode: string | undefined, summary: string, extraIn: Record<string, unknown> = {}) => {
    // Finisher-only keys (not copied onto the job result): `appLaunched:false` = the run stopped before
    // the app launched; `blockerHowToFix` = the failing step's own concrete recovery (GOAL-7).
    const { appLaunched, blockerHowToFix, ...extra } = extraIn;
    if (a.testThisPlanMutation) {
      sessions.recordMutation(session, {
        tool: 'qa_test_this',
        action: 'test_this_plan',
        risk: a.testThisPlanMutation.risk,
        target: a.testThisPlanMutation.affects,
        consent: a.mutationConsent,
        status: state === 'blocked' || state === 'unsafe' ? 'blocked' : 'executed',
        detail: failureCode,
      });
    }
    const reportProg = startProgress(sessions, session, job, 'reporting', { statusText: 'Generating the session report.' });
    let reportUri: string | undefined;
    let reportMdUri: string | undefined;
    let reportHead: string | undefined;
    let manifestUri: string | undefined;
    let appVerdict: { status: string; summary: string } | undefined;
    let coverageVerdict: { status: string; summary: string } | undefined;
    let toolVerdict: { status: string; summary: string } | undefined;
    let releaseRisk: string | undefined;
    let reportJson: Record<string, unknown> | undefined;
    const suiteForReport = ctx.getSuiteForReport();
    const suiteOpt = suiteForReport
      ? {
          generated: !suiteForReport.skipped,
          skippedReason: suiteForReport.skippedReason,
          name: suiteForReport.name,
          written: suiteForReport.written,
          compiledFlows: suiteForReport.compiledFlows,
          suiteRunnable: suiteForReport.suiteRunnable,
          readinessLabels: suiteForReport.readinessLabels,
        }
      : undefined;
    try {
      const r = await generateSessionReport(sessions, session, {
        format: 'summary',
        // GOAL NEW-R3-2: no triage dump from a WDA that just hung (one more /source would wait out
        // its 30 s timeout after the run was already decided).
        includeCurrentDump: failureCode !== 'WDA_UNREACHABLE',
        suite: suiteOpt,
        // A blocked/unsafe run stopped before testing what it set out to: never a SHIP (AND-4).
        ...((state === 'blocked' || state === 'unsafe') && failureCode
          ? {
              notTested: {
                reason:
                  appLaunched === false
                    ? `the app never launched (${failureCode})`
                    : `the run stopped (${failureCode}) before the app was tested`,
                failureCode,
                ...(appLaunched === false ? { reachedApp: false } : {}),
              },
            }
          : {}),
      });
      reportUri = r.reportUri;
      reportJson = r.report;
      reportMdUri = r.reportMdUri;
      reportHead = r.reportHead;
      manifestUri = r.manifestUri;
      sessions.milestone(session, 'report_generated'); // persisted flag for qa_status's ladder
      for (const u of [reportUri, reportMdUri]) if (!artifacts.includes(u)) artifacts.push(u);
      appVerdict = (r.report as { appVerdict?: { status: string; summary: string } }).appVerdict;
      coverageVerdict = (r.report as { coverageVerdict?: { status: string; summary: string } }).coverageVerdict;
      toolVerdict = (r.report as { toolVerdict?: { status: string; summary: string } }).toolVerdict;
      releaseRisk = (r.report as { executiveSummary?: { risk?: string } }).executiveSummary?.risk;
    } catch (e) {
      log('warn', 'test_this report generation failed', { err: String(e) });
    }
    reportProg.done('Report ready.');
    // Health as the report judged it ('not checked' when the app was never reached, 'unverified' on
    // a visual-only smoke: AND-4 / E2E-2); the local derivation is only the report-failed fallback.
    const reportHealth = reportJson as { nativeHealth?: string; appHealth?: string } | undefined;
    const native =
      reportHealth?.nativeHealth ?? (session.findings.some((f) => f.layer === 'native' && f.severity === 'high') ? 'error' : 'OK');
    const app =
      reportHealth?.appHealth ??
      (session.findings.some((f) => f.layer === 'app' && f.severity === 'high')
        ? 'error'
        : session.findings.some((f) => f.layer === 'app' && f.severity === 'medium')
          ? 'degraded'
          : 'OK');
    // The report already exists, so point the agent AT it (report.md, the agent-readable copy), not
    // back at qa_report. A blocked run points at the blocker's concrete fix (or nothing).
    const question = extra.needsInput as
      { kind?: string; question?: string; resume?: { tool: string; args: Record<string, unknown> } } | undefined;
    const blockers =
      state === 'completed' || state === 'needs_input' || !failureCode
        ? []
        : [
            typedBlockerFromCode(
              failureCode,
              typeof blockerHowToFix === 'string' && blockerHowToFix ? { howToFix: blockerHowToFix } : undefined,
            ),
          ];
    const readUri = reportMdUri ?? reportUri;
    const nextRecommendedAction =
      state === 'needs_input' && question?.resume
        ? {
            tool: question.resume.tool,
            args: question.resume.args,
            why: `Ask the user exactly this one question, then resume with their answer: ${question.question ?? question.kind ?? 'input needed'}`,
          }
        : state === 'completed'
          ? readUri
            ? {
                tool: 'qa_get_artifact',
                args: { uri: readUri },
                why: `Read the report (report.md: ${readUri})`,
              }
            : { tool: 'qa_report', args: { sessionId: session.id }, why: 'Generate the report' }
          : blockers[0]
            ? blockerFixAction(blockers[0], session.id)
            : null;
    // Uniform terminal envelope (Milestone B): summarizable from structured output, no log parsing.
    const envelope: TerminalEnvelope = buildTerminalEnvelope({
      state,
      sessionId: session.id,
      jobId: job.jobId,
      summary,
      attempted,
      workaroundsAttempted: session.workarounds,
      artifactChoice: a.artifactChoice,
      targetChoice: a.targetChoice,
      verdicts: {
        ...(appVerdict ? { app: appVerdict } : {}),
        ...(coverageVerdict ? { coverage: coverageVerdict } : {}),
        ...(toolVerdict ? { tool: toolVerdict } : {}),
      },
      blockers,
      reportUri: reportUri ?? null,
      nextRecommendedAction,
    });
    upd({
      // needs_input is a clean pause (the run did what it could and asks ONE question), not a failure.
      status: state === 'completed' || state === 'needs_input' ? 'done' : 'failed',
      progress: state,
      result: {
        ...envelope,
        // Pre-launch static app map URI is present in EVERY terminal state, including blocked (Fix 1).
        appMapUri: a.appMapUri,
        goal: a.goal,
        ...(a.goalText ? { goalText: a.goalText } : {}),
        requiredOutputs: a.requiredOutputs,
        releaseGateRequested: a.releaseGate,
        // The report's release verdict (ship | caution | block), so a release_gate run states it outright.
        releaseRisk: releaseRisk ?? null,
        failureCode,
        artifacts,
        reportMdUri: reportMdUri ?? null,
        manifestUri,
        health: { native, app },
        inputsProvided: session.inputs.map((i) => i.varName),
        // Compact report pointer: verdict one-liner + URI; the full report lives at report.md.
        reportSummary: readUri
          ? `${appVerdict?.status ?? 'n/a'} app · ${coverageVerdict?.status ?? 'n/a'} coverage · ${toolVerdict?.status ?? 'n/a'} tool. Read ${readUri}`
          : null,
        // Completed: the report head inline (verdicts, top findings with evidence URIs), so relaying
        // the outcome needs no further call.
        ...(state === 'completed' && reportHead ? { reportHead } : {}),
        notes: session.notes.length,
        findings: session.findings.length,
        ...extra,
      },
      resultText:
        summary +
        (state === 'completed' && reportHead ? `\n\n${reportHead}` : readUri ? `\nreport: ${readUri}` : '') +
        (blockers[0] ? `\nfix (${blockers[0].failureCode}): ${blockers[0].howToFix}` : ''),
      endedAt: Date.now(),
    });
  };
}

/** Tools a blocker's recovery text may name, with the args Swipium can fill in for them. Re-running
 *  qa_test_this is the step AFTER the fix, so it is never the recommended action itself. */
const FIX_TOOL_ARGS: Record<string, (sessionId: string, howToFix: string) => Record<string, unknown>> = {
  qa_doctor: () => ({}),
  qa_prepare_target: (sessionId) => ({ sessionId }),
  qa_prepare_ios_target: (sessionId) => ({ sessionId }),
  // iOS launch failures (GOAL-7) name the qa_ios action to take ("boot", "install", "logs").
  qa_ios: (sessionId, howToFix) => ({ sessionId, action: howToFix.match(/qa_ios \{\s*action:\s*"(\w+)"/)?.[1] ?? 'logs' }),
  qa_metro: (sessionId) => ({ sessionId, action: 'start' }), // METRO_REQUIRED (AND-6)
  // WDA_UNREACHABLE (a hung WDA): "restart WDA" starts with stop (device defaults to the session's);
  // WDA_BUILD_FAILED's "retry qa_wda build" is a build.
  qa_wda: (sessionId, howToFix) => ({
    sessionId,
    action:
      howToFix.match(/qa_wda \{\s*action:\s*"(\w+)"/)?.[1] ??
      (/restart WDA/i.test(howToFix) ? 'stop' : (howToFix.match(/qa_wda (build|setup|attach|status|logs)\b/)?.[1] ?? 'status')),
  }),
  qa_snapshot: (sessionId) => ({ sessionId }),
  qa_screenshot: (sessionId) => ({ sessionId }),
  qa_clear_overlay: (sessionId) => ({ sessionId }),
  qa_smoke: (sessionId) => ({ sessionId }),
  qa_explore: (sessionId) => ({ sessionId }),
  qa_app_map_build: (sessionId) => ({ sessionId }),
};

/** The blocker's concrete fix as a call: the first fill-able Swipium tool its recovery names, or
 *  null when the fix is outside Swipium (install a tool, provide data, fix the app). Exported for tests. */
export function blockerFixAction(b: TypedBlocker, sessionId: string): NextRecommendedAction | null {
  const tool = (b.howToFix.match(/\bqa_[a-z_]+/g) ?? []).find((t) => t in FIX_TOOL_ARGS);
  return tool ? { tool, args: FIX_TOOL_ARGS[tool](sessionId, b.howToFix), why: `Fix ${b.failureCode}: ${b.howToFix}` } : null;
}
