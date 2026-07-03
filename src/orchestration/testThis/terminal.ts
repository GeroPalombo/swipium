// qa_test_this terminal-state assembly — every terminal state (completed OR blocked) generates a
// report artifact (Milestone B) and lands the uniform TerminalEnvelope on the job result, so the
// outcome is summarizable from structured output without log parsing.

import { buildTerminalEnvelope, typedBlockerFromCode, type TerminalEnvelope } from '../envelope.js';
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

/** Every terminal state — completed OR blocked — generates a report artifact (Milestone B). */
export function createFinisher(ctx: FinishContext): Finish {
  const { sessions, session, job, a, attempted, artifacts, upd } = ctx;
  return async (state: ExecState, failureCode: string | undefined, summary: string, extra: Record<string, unknown> = {}) => {
    if (a.testThisPlanMutation) {
      sessions.recordMutation(session, {
        tool: 'qa_test_this',
        action: 'test_this_plan',
        risk: a.testThisPlanMutation.risk,
        target: a.testThisPlanMutation.affects,
        consent: a.mutationConsent,
        status: state === 'completed' ? 'executed' : 'blocked',
        detail: failureCode,
      });
    }
    const reportProg = startProgress(sessions, session, job, 'reporting', { statusText: 'Generating the session report.' });
    let reportUri: string | undefined;
    let manifestUri: string | undefined;
    let appVerdict: { status: string; summary: string } | undefined;
    let coverageVerdict: { status: string; summary: string } | undefined;
    let toolVerdict: { status: string; summary: string } | undefined;
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
        includeCurrentDump: true,
        suite: suiteOpt,
      });
      reportUri = r.reportUri;
      manifestUri = r.manifestUri;
      if (!artifacts.includes(reportUri)) artifacts.push(reportUri);
      appVerdict = (r.report as { appVerdict?: { status: string; summary: string } }).appVerdict;
      coverageVerdict = (r.report as { coverageVerdict?: { status: string; summary: string } }).coverageVerdict;
      toolVerdict = (r.report as { toolVerdict?: { status: string; summary: string } }).toolVerdict;
    } catch (e) {
      log('warn', 'test_this report generation failed', { err: String(e) });
    }
    reportProg.done('Report ready.');
    const native = session.findings.some((f) => f.layer === 'native' && f.severity === 'high') ? 'error' : 'OK';
    const app = session.findings.some((f) => f.layer === 'app' && f.severity === 'high')
      ? 'error'
      : session.findings.some((f) => f.layer === 'app' && f.severity === 'medium')
        ? 'degraded'
        : 'OK';
    // The report already exists — point the agent AT it (fetch/open), not back at qa_report.
    const nextRecommendedAction =
      state === 'completed'
        ? reportUri
          ? {
              tool: 'qa_get_artifact',
              args: { uri: reportUri },
              why: `Open the generated report (${reportUri})`,
            }
          : { tool: 'qa_report', args: { sessionId: session.id }, why: 'Generate the report' }
        : { tool: 'qa_explain_blocker', args: { failureCode: failureCode ?? 'UNKNOWN' }, why: 'Understand the blocker and how to fix it' };
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
      blockers: state === 'completed' || !failureCode ? [] : [typedBlockerFromCode(failureCode)],
      reportUri: reportUri ?? null,
      nextRecommendedAction,
    });
    upd({
      status: state === 'completed' ? 'done' : 'failed',
      progress: state,
      result: {
        ...envelope,
        // Pre-launch static app map URI is present in EVERY terminal state — including blocked (Fix 1).
        appMapUri: a.appMapUri,
        goal: a.goal,
        requiredOutputs: a.requiredOutputs,
        releaseGateRequested: a.releaseGate,
        failureCode,
        artifacts,
        manifestUri,
        health: { native, app },
        inputsProvided: session.inputs.map((i) => i.varName),
        notes: session.notes.length,
        findings: session.findings.length,
        ...extra,
      },
      resultText: summary + (reportUri ? `\nreport: ${reportUri}` : ''),
      endedAt: Date.now(),
    });
  };
}
