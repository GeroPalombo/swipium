// Tool health for qa_report (real-device smoke finding: a run with WDA 404s and UNKNOWN tool errors
// reported "Tool status: PASS"). Two pure pieces:
//   - toolErrorFromResult: classify a tool call result → a ToolErrorRecord to store on the session
//     (consent refusals / missing test data are user decisions, not tool errors);
//   - toolVerdictFor: the report's TOOL verdict from mcp_limitation notes + recorded tool errors.
// Tool health never changes the APP verdict — a Swipium/driver error is not an app defect.

import { FAILURES } from '../oracle/failures.js';
import type { SessionStore, TestNote, ToolErrorRecord } from '../session/store.js';

/** Buckets that are deliberate outcomes, not tool malfunctions. */
const NOT_TOOL_ERRORS = new Set(['unsafe_refused', 'missing_data']);

export function toolErrorFromResult(tool: string, result: unknown): Omit<ToolErrorRecord, 'at'> | undefined {
  const r = result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ type?: string; text?: string }> };
  if (!r || r.isError !== true) return undefined;
  const sc = r.structuredContent ?? {};
  const failureCode = typeof sc.failureCode === 'string' ? sc.failureCode : 'UNKNOWN';
  const info = (FAILURES as Record<string, { bucket: string } | undefined>)[failureCode];
  if (info && NOT_TOOL_ERRORS.has(info.bucket)) return undefined;
  const what = typeof sc.what === 'string' ? sc.what : (r.content?.find((c) => c.type === 'text')?.text ?? '').split('\n')[0];
  return { tool, failureCode, message: what.replace(/^❌\s*/, '') };
}

/** Record an error result against the calling session (best-effort, never throws). */
export function recordToolErrorFromResult(sessions: SessionStore, tool: string, args: unknown, result: unknown): void {
  try {
    const sessionId = (args as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId !== 'string') return;
    const rec = toolErrorFromResult(tool, result);
    if (!rec) return;
    const session = sessions.get(sessionId);
    if (session) sessions.recordToolError(session, rec);
  } catch {
    /* tool-health bookkeeping must never break a tool call */
  }
}

export interface ToolVerdict {
  status: 'PASS' | 'DEGRADED' | 'BLOCKED';
  summary: string;
  /** Recorded tool errors in this session. */
  toolErrorCount: number;
  /** Tool errors grouped by failure code (code → count), most frequent first. */
  toolErrorsByCode: Record<string, number>;
}

/**
 * TOOL verdict (never the app verdict):
 *  - BLOCKED  — a workflow was blocked/failed by a Swipium/MCP limitation (qa_note mcp_limitation);
 *  - DEGRADED — tool calls returned errors (WDA 404, UNKNOWN, driver failures…) — the run's coverage
 *    may be incomplete, but these are tool-side, not app defects;
 *  - PASS     — neither.
 */
export function toolVerdictFor(
  toolLimitationNotes: Array<Pick<TestNote, 'workflow' | 'reason'>>,
  toolErrors: ToolErrorRecord[] | undefined,
  redact: (s?: string) => string | undefined = (s) => s,
): ToolVerdict {
  const errors = toolErrors ?? [];
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e.failureCode, (counts.get(e.failureCode) ?? 0) + 1);
  const byCode = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
  const codeText = Object.entries(byCode)
    .map(([c, n]) => `${c}×${n}`)
    .join(', ');
  const errorText = errors.length
    ? `${errors.length} tool error(s) recorded (${codeText}; e.g. ${errors[0].tool}: ${redact(errors[0].message) ?? errors[0].message})`
    : '';
  if (toolLimitationNotes.length) {
    const first = toolLimitationNotes[0];
    return {
      status: 'BLOCKED',
      summary:
        `${toolLimitationNotes.length} workflow(s) limited by Swipium/MCP capabilities (for example ${first.workflow}${first.reason ? `: ${redact(first.reason) ?? first.reason}` : ''}). These are tool limitations, not app defects.` +
        (errorText ? ` Also ${errorText}.` : ''),
      toolErrorCount: errors.length,
      toolErrorsByCode: byCode,
    };
  }
  if (errors.length) {
    return {
      status: 'DEGRADED',
      summary: `${errorText}. Tool-side errors, not app defects — coverage may be incomplete; see toolErrors.`,
      toolErrorCount: errors.length,
      toolErrorsByCode: byCode,
    };
  }
  return {
    status: 'PASS',
    summary: 'No Swipium/MCP limitations or tool errors recorded in this run.',
    toolErrorCount: 0,
    toolErrorsByCode: {},
  };
}
