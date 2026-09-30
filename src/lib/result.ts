// Tool result envelopes: every tool is self-diagnosing.
//
// Recoverable failures are returned as isError:true with a structured, actionable
// payload — NOT thrown. Thrown/JSON-RPC errors are reserved for malformed calls or a
// broken server (the model can't act on those).
//
// Response modes: a session can ask for `compact | normal | verbose`
// output. The human-readable text is rendered per mode; `structuredContent` is ALWAYS the
// full payload, so a client that reads structured data loses nothing in compact mode. The
// active mode is carried in AsyncLocalStorage so EVERY tool inherits it without touching a
// single call site, and concurrent JSON-RPC requests can't clobber each other's mode.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ResponseMode = 'compact' | 'normal' | 'verbose';
export const DEFAULT_RESPONSE_MODE: ResponseMode = 'normal';

const modeStore = new AsyncLocalStorage<ResponseMode>();

/** Run `fn` with `mode` as the active response mode for everything it (asynchronously) calls. */
export function runWithResponseMode<T>(mode: ResponseMode, fn: () => T): T {
  return modeStore.run(mode, fn);
}

/** The response mode in effect for the current tool call (default normal). */
export function currentResponseMode(): ResponseMode {
  return modeStore.getStore() ?? DEFAULT_RESPONSE_MODE;
}

// NOTE: `type` alias, not `interface` — interfaces lack an implicit index signature and
// are not assignable to the SDK's structuredContent ({ [x: string]: unknown }).
export type QaErrorPayload = {
  ok: false;
  what: string;
  commandAttempted?: string;
  changedState: boolean; // did we mutate device/app/fs? feeds retry-safety
  retrySafe: boolean;
  nextSteps: string[];
  artifactUri?: string;
  clientHint?: string;
  failureCode: string; // typed failure class; UNKNOWN is the fallback
};

type QaErrorInput = Omit<QaErrorPayload, 'ok' | 'failureCode'> & { failureCode?: string };

/** Compact (unindented) JSON fence — the text-channel copy of the payload. Indentation roughly
 * doubled its size for no reader benefit (structuredContent carries the full payload anyway). */
function fence(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

/** Default recovery steps for an unknown/expired sessionId. */
export const UNKNOWN_SESSION_NEXT_STEPS: readonly string[] = [
  'Call qa_status without sessionId for orientation, or qa_start_session / qa_test_this to create a session.',
];

/**
 * The one typed envelope for "that sessionId does not exist" — an invalid argument, so
 * failureCode INVALID_ARGUMENT (never the UNKNOWN fallback) and retrySafe (nothing changed).
 * Sites with a genuinely different recovery (e.g. "omit sessionId to bootstrap") pass nextSteps.
 */
export function unknownSessionError(sessionId: string | undefined, nextSteps?: readonly string[]): CallToolResult {
  return qaError({
    what: `Unknown sessionId "${sessionId ?? ''}"`,
    changedState: false,
    retrySafe: true,
    failureCode: 'INVALID_ARGUMENT',
    nextSteps: [...(nextSteps ?? UNKNOWN_SESSION_NEXT_STEPS)],
  });
}

/** True for an argument-validation error thrown by a driver/helper (e.g. a malformed app id
 * from assertAndroidAppId): `code === 'INVALID_ARGUMENT'` or a message prefixed `INVALID_ARGUMENT`. */
export function isInvalidArgumentError(e: unknown): e is Error {
  if (!(e instanceof Error)) return false;
  return (e as Error & { code?: unknown }).code === 'INVALID_ARGUMENT' || /^INVALID_ARGUMENT\b/.test(e.message);
}

/** Typed envelope for a thrown INVALID_ARGUMENT error — rejected before touching the device. */
export function invalidArgumentError(e: Error, nextSteps: string[], extra?: Record<string, unknown>): CallToolResult {
  return qaError(
    {
      what: e.message.replace(/^INVALID_ARGUMENT:\s*/, ''),
      changedState: false,
      retrySafe: true,
      failureCode: 'INVALID_ARGUMENT',
      nextSteps,
    },
    extra,
  );
}

/** Options for the text rendering of a result (structuredContent is never affected). */
export interface QaTextOptions {
  /** Top-level payload keys already rendered in the human text (e.g. `elements`, as @eN lines) —
   * left out of the fenced JSON so the text channel doesn't carry them twice. */
  textOmit?: readonly string[];
}

function withoutKeys(payload: Record<string, unknown>, keys?: readonly string[]): Record<string, unknown> {
  if (!keys?.length) return payload;
  const out: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (keys.includes(k)) omitted.push(k);
    else out[k] = v;
  }
  // Say what was left out so a text-only reader knows where to find it.
  if (omitted.length) out.renderedAbove = omitted;
  return out;
}

/** Pull any artifact/resource URIs out of a payload so compact mode can still surface them. */
function uriLines(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (label: string, v: unknown) => {
    if (typeof v === 'string' && v.startsWith('swipium://')) out.push(`${label}: ${v}`);
  };
  push('artifact', payload.artifactUri);
  if (Array.isArray(payload.artifactUris)) {
    for (const u of payload.artifactUris) push('artifact', u);
  }
  push('screenshot', (payload as { screenshotUri?: unknown }).screenshotUri);
  push('report', (payload as { reportUri?: unknown }).reportUri);
  return out;
}

/**
 * Compose the human text block for a result. compact = summary (+ any artifact URIs) only,
 * dropping the fenced-JSON duplicate that structuredContent already carries; normal/verbose
 * keep a compact fence for clients/humans reading the text channel (normal additionally leaves
 * out keys the summary already rendered — opts.textOmit; verbose keeps them).
 */
function renderText(summary: string, payload: Record<string, unknown>, mode: ResponseMode, opts?: QaTextOptions): string {
  if (mode === 'compact') {
    const uris = uriLines(payload);
    return uris.length ? `${summary}\n${uris.join('\n')}` : summary;
  }
  // verbose keeps every key in the fence; normal drops the ones the summary already rendered.
  return `${summary}\n\n${fence(mode === 'verbose' ? payload : withoutKeys(payload, opts?.textOmit))}`;
}

export function qaError(p: QaErrorInput, extra?: Record<string, unknown>): CallToolResult {
  const payload = { ok: false, failureCode: p.failureCode ?? 'UNKNOWN', ...p, ...(extra ?? {}) };
  const mode = currentResponseMode();
  const head = [
    `❌ ${p.what}`,
    p.commandAttempted ? `command: ${p.commandAttempted}` : '',
    `changedState=${p.changedState} retrySafe=${p.retrySafe}`,
    p.nextSteps.length ? `next: ${p.nextSteps.join(' | ')}` : '',
    p.clientHint ? `hint: ${p.clientHint}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  // Errors keep their actionable head in every mode; only the fenced JSON duplicate is
  // dropped in compact (structuredContent still carries the full payload).
  const text = mode === 'compact' ? head : `${head}\n${fence(payload)}`;
  return { isError: true, content: [{ type: 'text', text }], structuredContent: payload };
}

export function qaOk(payload: Record<string, unknown>, summary: string, opts?: QaTextOptions): CallToolResult {
  const structured = { ok: true, ...payload };
  return {
    content: [{ type: 'text', text: renderText(summary, structured, currentResponseMode(), opts) }],
    structuredContent: structured,
  };
}

/** Append advisory notes (e.g. params ignored in the active mode) to a result without touching
 * its verdict — the pattern qa_generate established for mode/target-scoped parameters. */
export function qaAnnotate(result: CallToolResult, notes: string[]): CallToolResult {
  if (!notes.length) return result;
  const content = [...(result.content ?? [])];
  const noteText = `\n\n${notes.map((n) => `Note: ${n}`).join('\n')}`;
  const first = content[0];
  if (first && first.type === 'text') content[0] = { ...first, text: `${String(first.text)}${noteText}` };
  else content.unshift({ type: 'text', text: noteText.trim() });
  const sc = { ...((result.structuredContent ?? {}) as Record<string, unknown>), notes };
  return { ...result, content, structuredContent: sc };
}

/** A deliberate, budgeted stop (not an error). The agent should call qa_report next. */
export function qaStop(reason: string, payload: Record<string, unknown>): CallToolResult {
  const structured = { ok: true, stopped: true, reason, ...payload };
  const summary = `⏹ Stopped: ${reason}\nCall qa_report to summarize what was verified.`;
  return {
    content: [{ type: 'text', text: renderText(summary, structured, currentResponseMode()) }],
    structuredContent: structured,
  };
}

/**
 * Typed envelope for work that was CANCELLED (the MCP request was aborted, or the job was
 * cancelled) — failureCode CANCELLED. Not a failure: it is never recorded as a tool error, a
 * snapshot failure, a finding or a health verdict, and it never switches the session mode.
 */
export function cancelledResult(what = 'Cancelled — the call was aborted before it finished', changedState = false): CallToolResult {
  return qaError({
    what,
    changedState,
    retrySafe: true,
    failureCode: 'CANCELLED',
    nextSteps: ['Nothing was recorded as a failure. Re-run the call if you still need its result.'],
  });
}
