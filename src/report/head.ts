// Report head: the slice of a session report an agent needs to relay the outcome without opening
// anything else. Inlined in qa_test_this's terminal result (both channels). Same order and builder
// as summary.md (report/summary.ts): verdict, health, not-tested reason, failures, findings, passes,
// where the report lives. Built from the already-redacted report object.

import { AGENT_SUMMARY_MAX_BYTES, buildAgentSummary, type AgentSummaryReport } from './summary.js';

/** Hard cap on the head (characters; the head is ASCII apart from user text). */
export const REPORT_HEAD_MAX_CHARS = 4000;

export function buildReportHead(
  report: Record<string, unknown>,
  uris: { reportMdUri?: string; reportUri?: string; reportHtmlPath?: string; reportHtmlError?: string },
): string {
  const pointer = uris.reportMdUri ? `report.md: ${uris.reportMdUri}` : '';
  const budget = Math.min(REPORT_HEAD_MAX_CHARS, AGENT_SUMMARY_MAX_BYTES) - (pointer ? Buffer.byteLength(pointer) + 1 : 0);
  const body = buildAgentSummary(report as AgentSummaryReport, {
    reportHtmlPath: uris.reportHtmlPath,
    reportHtmlError: uris.reportHtmlError,
    reportJsonPath: uris.reportUri,
    maxBytes: budget,
  });
  return pointer ? `${body}\n${pointer}` : body;
}
