// Report head: the 2-4 KB slice of a session report an agent needs to relay the outcome without
// opening the full report (release risk, the three verdicts, top findings and failed/blocked
// workflows with their evidence URIs, then where the full report lives). Inlined in qa_test_this's
// terminal result (both channels). Built from the already-redacted report object.

/** Hard cap on the head; the full report is one qa_get_artifact away. */
export const REPORT_HEAD_MAX_CHARS = 4000;
const TOP_N = 5;
const LINE_MAX = 300;

interface Verdict {
  status: string;
  summary: string;
}
interface HeadFinding {
  severity?: string;
  layer?: string;
  kind?: string;
  detail?: string;
  screenshotUri?: string;
  count?: number;
}
interface HeadOutcome {
  workflow?: string;
  outcome?: string;
  reason?: string;
  artifactUris?: string[];
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function clip(s: string): string {
  return s.length > LINE_MAX ? `${s.slice(0, LINE_MAX)}...` : s;
}

export function buildReportHead(report: Record<string, unknown>, uris: { reportMdUri?: string; reportUri?: string }): string {
  const exec = report.executiveSummary as { risk?: string; nextAction?: string } | undefined;
  const v = (k: string) => report[k] as Verdict | undefined;
  const findings = ((report.findings as HeadFinding[] | undefined) ?? [])
    .slice()
    .sort((a, b) => (SEVERITY_ORDER[a.severity ?? ''] ?? 3) - (SEVERITY_ORDER[b.severity ?? ''] ?? 3));
  const problems = ((report.testOutcomes as HeadOutcome[] | undefined) ?? []).filter(
    (n) => n.outcome === 'fail' || n.outcome === 'blocked',
  );
  const tally = (report.outcomeTally as Record<string, number> | undefined) ?? {};
  const lines = [
    exec?.risk ? `RELEASE RISK: ${exec.risk.toUpperCase()}: ${exec.nextAction ?? ''}` : '',
    ...(['app', 'coverage', 'tool'] as const).map((k) => {
      const x = v(`${k}Verdict`);
      return x ? clip(`${k}: ${x.status} - ${x.summary}`) : '';
    }),
    `findings: ${findings.length} unique (high: ${Number(report.highSeverityCount ?? 0)})`,
    ...findings
      .slice(0, TOP_N)
      .map(
        (f) =>
          `  [${f.severity ?? '?'}] ${f.layer ?? '?'}/${f.kind ?? '?'}: ${clip(f.detail ?? '')}${f.count && f.count > 1 ? ` (x${f.count})` : ''}${f.screenshotUri ? ` evidence: ${f.screenshotUri}` : ''}`,
      ),
    findings.length > TOP_N ? `  ... ${findings.length - TOP_N} more in the full report` : '',
    Object.keys(tally).length
      ? `test outcomes: ${Object.entries(tally)
          .map(([k, n]) => `${k}=${n}`)
          .join(' ')}`
      : 'test outcomes: none recorded',
    ...problems
      .slice(0, TOP_N)
      .map(
        (n) =>
          `  ${n.outcome} ${n.workflow ?? '?'}${n.reason ? `: ${clip(n.reason)}` : ''}${n.artifactUris?.length ? ` evidence: ${n.artifactUris.slice(0, 3).join(' ')}` : ''}`,
      ),
    problems.length > TOP_N ? `  ... ${problems.length - TOP_N} more in the full report` : '',
    uris.reportMdUri ? `full report: ${uris.reportMdUri}${uris.reportUri ? ` (JSON for CI: ${uris.reportUri})` : ''}` : '',
  ].filter(Boolean);
  const head = lines.join('\n');
  if (head.length <= REPORT_HEAD_MAX_CHARS) return head;
  // Keep the pointer to the full report when cutting.
  const tail = lines[lines.length - 1];
  return `${head.slice(0, REPORT_HEAD_MAX_CHARS - tail.length - 40)}\n... (head truncated)\n${tail}`;
}
