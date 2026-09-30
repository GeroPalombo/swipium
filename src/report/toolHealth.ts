// Tool health for qa_report (real-device smoke finding: a run with WDA 404s and UNKNOWN tool errors
// reported "Tool status: PASS"). Two pure pieces:
//   - toolErrorFromResult: classify a tool call result > a ToolErrorRecord to store on the session
//     (consent refusals / missing test data are user decisions, not tool errors);
//   - toolVerdictFor: the report's TOOL verdict from mcp_limitation notes + recorded tool errors.
// Tool health never changes the APP verdict. A Swipium/driver error is not an app defect.

import { FAILURES } from '../oracle/failures.js';
import type { SessionStore, TestNote, ToolErrorRecord } from '../session/store.js';

/** Buckets that are deliberate outcomes, not tool malfunctions. */
const NOT_TOOL_ERRORS = new Set(['unsafe_refused', 'missing_data']);

/** Codes an agent hits while PROBING the UI (a selector that does not match yet, a stale @eN ref, an
 *  ambiguous match, a bad argument it then corrects). Recorded for visibility, but they never flip the
 *  TOOL status to DEGRADED on their own; they are not Swipium/driver malfunctions. */
export const AGENT_PROBING_CODES = new Set(['ELEMENT_NOT_FOUND', 'STALE_REF', 'AMBIGUOUS_SELECTOR', 'INVALID_ARGUMENT']);

/** An error result without a typed failureCode (qaError defaults it to UNKNOWN). Most are deliberate
 *  refusals / guard messages. Counted in a separate `uncoded` bucket that does NOT degrade by itself. */
export const UNCODED_CODES = new Set(['UNKNOWN', 'UNCODED']);

/** Does this recorded tool error, by itself, make the TOOL status DEGRADED? */
export function isDegradingToolError(failureCode: string): boolean {
  if (failureCode === 'CANCELLED') return false;
  if (UNCODED_CODES.has(failureCode) || AGENT_PROBING_CODES.has(failureCode)) return false;
  const info = (FAILURES as Record<string, { bucket: string } | undefined>)[failureCode];
  return !(info && NOT_TOOL_ERRORS.has(info.bucket));
}

export function toolErrorFromResult(tool: string, result: unknown): Omit<ToolErrorRecord, 'at'> | undefined {
  const r = result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ type?: string; text?: string }> };
  if (!r || r.isError !== true) return undefined;
  const sc = r.structuredContent ?? {};
  const failureCode = typeof sc.failureCode === 'string' ? sc.failureCode : 'UNKNOWN';
  if (failureCode === 'CANCELLED') return undefined; // cancelled work is not a tool error
  const info = (FAILURES as Record<string, { bucket: string } | undefined>)[failureCode];
  if (info && NOT_TOOL_ERRORS.has(info.bucket)) return undefined;
  const what = typeof sc.what === 'string' ? sc.what : (r.content?.find((c) => c.type === 'text')?.text ?? '').split('\n')[0];
  return { tool, failureCode, message: what.replace(/^❌\s*/, '') };
}

/** Record an error result against the calling session (best-effort, never throws). */
export function recordToolErrorFromResult(
  sessions: SessionStore,
  tool: string,
  args: unknown,
  result: unknown,
  signal?: AbortSignal,
): void {
  try {
    // A call whose request was aborted produced cancelled work, whatever error it surfaced
    // (e.g. "uiautomator dump failed … AbortError" / "WDA … aborted"), never a tool error.
    if (signal?.aborted) return;
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
  /** Tool errors grouped by failure code (code > count), most frequent first. */
  toolErrorsByCode: Record<string, number>;
  /** Errors that DO degrade the tool status (typed Swipium/driver failures). */
  degradingCount?: number;
  /** Errors without a typed failureCode (UNKNOWN): mostly deliberate refusals, never degrade alone. */
  uncodedCount?: number;
  /** Agent-probing errors (ELEMENT_NOT_FOUND, STALE_REF, AMBIGUOUS_SELECTOR, INVALID_ARGUMENT). */
  probingCount?: number;
}

/**
 * TOOL verdict (never the app verdict):
 *  - BLOCKED: a workflow was blocked/failed by a Swipium/MCP limitation (qa_note mcp_limitation);
 *  - DEGRADED: tool calls returned TYPED tool-side errors (WDA 404, driver failures…). The run's
 *    coverage may be incomplete, but these are tool-side, not app defects. Uncoded errors (no
 *    failureCode, mostly deliberate refusals) and agent-probing codes (ELEMENT_NOT_FOUND, STALE_REF,
 *    AMBIGUOUS_SELECTOR, INVALID_ARGUMENT) are counted and reported but never degrade on their own;
 *  - PASS: neither.
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
  const degradingCount = errors.filter((e) => isDegradingToolError(e.failureCode)).length;
  const uncodedCount = errors.filter((e) => UNCODED_CODES.has(e.failureCode)).length;
  const probingCount = errors.filter((e) => AGENT_PROBING_CODES.has(e.failureCode)).length;
  const breakdown = { degradingCount, uncodedCount, probingCount };
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
      ...breakdown,
    };
  }
  if (degradingCount) {
    return {
      status: 'DEGRADED',
      summary: `${errorText}. Tool-side errors, not app defects. Coverage may be incomplete; see toolErrors.`,
      toolErrorCount: errors.length,
      toolErrorsByCode: byCode,
      ...breakdown,
    };
  }
  if (errors.length) {
    return {
      status: 'PASS',
      summary:
        `No Swipium/MCP limitations or tool-side failures recorded. ${errors.length} non-degrading error result(s) ` +
        `(${codeText}: ${uncodedCount} uncoded refusal/guard message(s), ${probingCount} agent-probing miss(es)). See toolErrors.`,
      toolErrorCount: errors.length,
      toolErrorsByCode: byCode,
      ...breakdown,
    };
  }
  return {
    status: 'PASS',
    summary: 'No Swipium/MCP limitations or tool errors recorded in this run.',
    toolErrorCount: 0,
    toolErrorsByCode: {},
    ...breakdown,
  };
}
