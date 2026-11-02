// Release assessment (Report 2.0): turn the accumulated health + outcomes
// into a single verdict a non-QA developer can act on: ship | caution | block, with reasons
// and the one most important next action. Pure + deterministic so it's unit-testable.
// Also builds the agent summary (summary.md / the report head): a <= 2 KB, failure-first text.

import { FAILURES } from '../oracle/failures.js';
import { latestAttempts, type ReportFinding, type ReportNote, type ReportStep } from './export.js';
import { pickNotTestedLog, type LogPickInput } from './logTail.js';

export type ReleaseRisk = 'ship' | 'caution' | 'block';

export interface RiskInput {
  /** 'not checked': the app was never reached, so health was never probed (not a pass). */
  nativeHealth: 'OK' | 'error' | 'not checked';
  /** 'unverified': visual-only run, no UI tree was read, so an error screen could have been missed. */
  appHealth: 'OK' | 'degraded' | 'error' | 'unverified' | 'not checked';
  highSeverityCount: number;
  failCount: number;
  blockedCount: number;
  /** Failed workflows that are not app failures (missing_test_data, destructive_refused, intentionally_skipped). The
   *  release gate blocks on them by default, so the headline is never SHIP: a CAUTION. */
  otherFailCount?: number;
  overrideCount: number;
  topHighFinding?: string; // detail of the first high-severity finding
  topFail?: { workflow: string; reason?: string };
  topBlocked?: { workflow: string; recommendedSetup?: string };
  topOtherFail?: { workflow: string; category?: string; reason?: string };
  /**
   * The run did not test what it set out to. `reachedApp:false` (stopped before the app was
   * launched/exercised, or nothing at all was captured) is a BLOCK; `reachedApp:true` (the app was
   * reached but no workflow/case was executed) is a CAUTION. Either way, never SHIP without evidence.
   */
  notTested?: { reachedApp: boolean; reason: string };
  /** Coverage the run planned but did not get (blocked exploration, flows skipped by the session
   *  budget): a CAUTION, never SHIP. `next` is the action that closes the gap. */
  coverageGaps?: Array<{ reason: string; next: string }>;
  /** Why app health is unverified, when it isn't "visual-only" (a tool failure, a smoke that could
   *  not judge the screen). Replaces the default visual-only caution text. */
  appHealthUnverifiedReason?: string;
}

export interface ReleaseAssessment {
  risk: ReleaseRisk;
  reasons: string[];
  nextAction: string;
}

export function releaseAssessment(i: RiskInput): ReleaseAssessment {
  const reasons: string[] = [];

  const blocking = i.nativeHealth === 'error' || i.appHealth === 'error' || i.highSeverityCount > 0 || i.failCount > 0;
  if (i.nativeHealth === 'error') reasons.push('native crash/ANR detected');
  if (i.appHealth === 'error') reasons.push('app-level error surface (ErrorBoundary/RedBox)');
  if (i.highSeverityCount > 0) reasons.push(`${i.highSeverityCount} high-severity finding(s)`);
  if (i.failCount > 0) reasons.push(`${i.failCount} workflow(s) failed`);

  if (!blocking && i.notTested && !i.notTested.reachedApp) {
    return {
      risk: 'block',
      reasons: [`not tested: ${i.notTested.reason}`],
      nextAction: `Not tested: ${i.notTested.reason}. This run is not a pass; fix the blocker and re-run.`,
    };
  }

  if (blocking) {
    const next = i.topFail
      ? `Fix "${i.topFail.workflow}"${i.topFail.reason ? `: ${i.topFail.reason}` : ''} before shipping.`
      : i.topHighFinding
        ? `Investigate: ${i.topHighFinding}`
        : 'Resolve the blocking health issue before shipping.';
    return { risk: 'block', reasons, nextAction: next };
  }

  const cautions: string[] = [];
  if (i.notTested) cautions.push(`not tested: ${i.notTested.reason}`);
  if (i.appHealth === 'degraded') cautions.push('app health degraded (non-fatal warnings/LogBox)');
  if (i.appHealth === 'unverified')
    cautions.push(
      `app health unverified (${i.appHealthUnverifiedReason ?? 'visual-only: no UI tree was read'}, so an error screen could be missed; check the screenshot)`,
    );
  if (i.blockedCount > 0) cautions.push(`${i.blockedCount} workflow(s) blocked by missing preconditions`);
  if ((i.otherFailCount ?? 0) > 0)
    cautions.push(`${i.otherFailCount} workflow(s) failed for a non-app reason (the release gate fails on them unless the policy warns)`);
  if (i.overrideCount > 0) cautions.push(`${i.overrideCount} guardrail override(s) used`);
  for (const g of i.coverageGaps ?? []) cautions.push(g.reason);
  if (cautions.length) {
    const next = i.notTested
      ? `Not tested: ${i.notTested.reason}. Exercise it (or provide the missing setup), then re-run.`
      : i.topBlocked
        ? `Provide setup for "${i.topBlocked.workflow}"${i.topBlocked.recommendedSetup ? `: ${i.topBlocked.recommendedSetup}` : ''}, then re-run.`
        : i.topOtherFail
          ? `Resolve "${i.topOtherFail.workflow}"${i.topOtherFail.category ? ` (${i.topOtherFail.category})` : ''}${i.topOtherFail.reason ? `: ${i.topOtherFail.reason}` : ''}, then re-run.`
          : (i.coverageGaps?.[0]?.next ?? 'Review the cautions below before shipping.');
    return { risk: 'caution', reasons: cautions, nextAction: next };
  }

  return {
    risk: 'ship',
    reasons: ['no blocking findings; native + app healthy'],
    nextAction: 'No blocking issues found in simulator/emulator evidence.',
  };
}

// ---- Agent summary (summary.md and the report head) ----

/** summary.md budget: the agent reads it on every run, so it stays small. */
export const AGENT_SUMMARY_MAX_BYTES = 2048;
const MAX_FAILURE_LINES = 8;
const MAX_FINDING_LINES = 5;

type SummaryOutcome = ReportNote & { checkpointUri?: string; checkpointSkipped?: string; failureCode?: string };

/** What the agent summary reads from the (already redacted) report. */
export interface AgentSummaryReport extends LogPickInput {
  executiveSummary?: { risk?: string; reasons?: string[]; nextAction?: string };
  notTested?: { reason: string; failureCode?: string; reachedApp?: boolean } | null;
  nativeHealth?: string;
  appHealth?: string;
  testOutcomes?: SummaryOutcome[];
  findings?: Array<Partial<ReportFinding> & { severity?: string; kind?: string; detail?: string }>;
  steps?: ReportStep[];
  partial?: { jobId: string; kind: string } | null;
}

export interface AgentSummaryOptions {
  /** Absolute path of report.html (what the human opens). */
  reportHtmlPath?: string;
  /** Set when report.html could not be rendered; said instead of the open line. */
  reportHtmlError?: string;
  /** Path (or URI) of report.json. */
  reportJsonPath?: string;
  maxBytes?: number;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, Math.max(0, n - 3))}...` : one;
}

function failureCodeOf(n: ReportNote & { failureCode?: string }, step?: ReportStep): string {
  if (step?.failureCode) return step.failureCode;
  if (n.failureCode) return n.failureCode;
  const fromSteps = n.steps?.find((st) => st.failureCode)?.failureCode;
  if (fromSteps) return fromSteps;
  const fromReason = n.reason?.match(/\b([A-Z][A-Z0-9_]{3,})\b/)?.[1];
  if (fromReason && fromReason in FAILURES) return fromReason;
  return n.outcome === 'blocked' ? 'BLOCKED' : 'FAILED';
}

function actionFor(n: ReportNote, code: string): string {
  if (n.recommendedSetup) return n.recommendedSetup;
  const info = (FAILURES as Record<string, { recovery: string } | undefined>)[code];
  if (info) return info.recovery;
  if (n.category === 'app_bug') return 'fix the app and re-run';
  return 'see report.html';
}

function failureLine(n: SummaryOutcome, steps: ReportStep[], clipAt: number): string {
  const range = n.stepRange;
  const inRange = range ? steps.filter((st) => st.i >= range[0] && st.i <= range[1]) : [];
  const failed = [...inRange].reverse().find((st) => st.result === 'failed');
  const step = failed ?? inRange[inRange.length - 1];
  const code = failureCodeOf(n, failed);
  const shot =
    failed?.screenshotUri ??
    step?.screenshotUri ??
    n.checkpointUri ??
    [...(n.evidence ?? []), ...(n.artifactUris ?? [])].find((u) => IMAGE_RE.test(u));
  const why = failed?.screenshotSkipped ?? n.checkpointSkipped ?? (step ? 'none captured' : 'no step recorded');
  const verb = n.outcome === 'blocked' ? 'BLOCKED' : 'FAIL';
  const reason = n.reason ? ` "${clip(n.reason, Math.min(clipAt, 80))}"` : '';
  return `- ${verb} ${clip(n.workflow, 60)}${step ? ` step #${step.i}` : ''} ${code}${reason}: ${shot ?? `(no screenshot: ${clip(why, 60)})`}; do: ${clip(actionFor(n, code), clipAt)}`;
}

function findingLine(f: NonNullable<AgentSummaryReport['findings']>[number], clipAt: number): string {
  const count = f.count && f.count > 1 ? ` (x${f.count})` : '';
  return `- [${f.severity ?? '?'}] ${f.layer ?? '?'}/${f.kind ?? '?'}: ${clip(f.detail ?? '', clipAt)}${count}${f.screenshotUri ? ` ${f.screenshotUri}` : ''}`;
}

function healthWord(v?: string): string {
  return v ?? 'unknown';
}

/**
 * The agent-facing summary, failure first, in this order: verdict and reason; health; the
 * not-tested reason once, with the fix and the log to read; up to 8 failed/blocked outcomes; up to 5
 * findings; the pass count; where report.html and report.json are. Everything else (readiness, QA
 * level, taxonomy, ledger, WDA, timing, artifacts) lives in report.json / report.html only.
 * Always <= maxBytes: lists shrink first, then long text is clipped harder.
 */
export function buildAgentSummary(report: AgentSummaryReport, opts: AgentSummaryOptions = {}): string {
  const maxBytes = opts.maxBytes ?? AGENT_SUMMARY_MAX_BYTES;
  const outcomes = latestAttempts(report.testOutcomes ?? []);
  const problems = outcomes.filter((n) => n.outcome === 'fail' || n.outcome === 'blocked');
  const findings = (report.findings ?? [])
    .slice()
    .sort((a, b) => (SEVERITY_ORDER[a.severity ?? ''] ?? 3) - (SEVERITY_ORDER[b.severity ?? ''] ?? 3));
  const steps = report.steps ?? [];
  const nt = report.notTested ?? undefined;
  const risk = (report.executiveSummary?.risk ?? 'unknown').toUpperCase();
  const passes = outcomes.filter((n) => n.outcome === 'pass');
  const flaky = outcomes.filter((n) => n.flaky).length;
  const contradicted = passes.filter((n) => n.contradicted).length;
  const unverified = passes.filter((n) => n.unverified).length;

  const render = (nFail: number, nFind: number, clipAt: number): string => {
    // The not-tested reason is said once, on its own line; the verdict line names only the code.
    const reason = nt
      ? `blocked by ${nt.failureCode ?? 'NOT_TESTED'}`
      : clip(report.executiveSummary?.reasons?.[0] ?? report.executiveSummary?.nextAction ?? '', clipAt);
    const lines: string[] = [`RELEASE RISK: ${risk}${reason ? `: ${reason}` : ''}`];
    if (report.partial)
      lines.push(`Partial: job ${report.partial.jobId} (${report.partial.kind}) was still running; report again when it ends.`);
    lines.push(`Health: native ${healthWord(report.nativeHealth)}, app ${healthWord(report.appHealth)}`);
    if (nt) {
      const code = nt.failureCode ?? 'NOT_TESTED';
      const info = (FAILURES as Record<string, { recovery: string } | undefined>)[code];
      const log = pickNotTestedLog(report);
      lines.push(
        `Not tested (${code}): ${clip(nt.reason, clipAt)}. Next: ${clip(info?.recovery ?? 'fix the blocker, then re-run', clipAt)} Log: ${log ? (log.path ?? log.uri) : 'no log captured'}`,
      );
    } else if (!problems.length && risk !== 'SHIP' && report.executiveSummary?.nextAction) {
      lines.push(`Do: ${clip(report.executiveSummary.nextAction, clipAt)}`);
    }
    if (problems.length) {
      lines.push(`Failures (${problems.length}):`);
      for (const n of problems.slice(0, nFail)) lines.push(failureLine(n, steps, clipAt));
      if (problems.length > nFail) lines.push(`+${problems.length - nFail} more in report.html`);
    }
    if (findings.length) {
      const high = findings.filter((f) => f.severity === 'high').length;
      lines.push(`Findings (${findings.length}, high: ${high}):`);
      for (const f of findings.slice(0, nFind)) lines.push(findingLine(f, clipAt));
      if (findings.length > nFind) lines.push(`+${findings.length - nFind} more`);
    }
    const flags = [
      flaky ? `${flaky} flaky` : '',
      contradicted ? `${contradicted} contradicted` : '',
      unverified ? `${unverified} unverified` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`Passed: ${passes.length} of ${outcomes.length} outcome(s)${flags ? ` (${flags})` : ''}`);
    if (opts.reportHtmlError) lines.push(`report.html was not written (${clip(opts.reportHtmlError, 80)}); report.json has everything.`);
    else if (opts.reportHtmlPath) lines.push(`Open the report: ${opts.reportHtmlPath}`);
    if (opts.reportJsonPath) lines.push(`report.json: ${opts.reportJsonPath}`);
    return lines.join('\n');
  };

  const size = (t: string) => Buffer.byteLength(t, 'utf8');
  let nFail = Math.min(MAX_FAILURE_LINES, problems.length);
  let nFind = Math.min(MAX_FINDING_LINES, findings.length);
  let clipAt = 140;
  let text = render(nFail, nFind, clipAt);
  while (size(text) > maxBytes) {
    if (clipAt > 60) clipAt -= 40;
    else if (nFind > 1) nFind--;
    else if (nFail > 1) nFail--;
    else if (nFind > 0) nFind--;
    else if (nFail > 0) nFail--;
    else break;
    text = render(nFail, nFind, clipAt);
  }
  if (size(text) <= maxBytes) return text;
  // Last resort (pathological paths/names): keep the head and the report pointers.
  const tail = text.split('\n').filter((l) => /^(Open the report|report\.json|report\.html)/.test(l));
  const budget = maxBytes - size(tail.join('\n')) - 20;
  return `${Buffer.from(text)
    .subarray(0, Math.max(0, budget))
    .toString('utf8')
    .replace(/\uFFFD+$/, '')}\n...\n${tail.join('\n')}`;
}
