// Tool result envelopes: every tool is self-diagnosing.
//
// Recoverable failures are returned as isError:true with a structured, actionable
// payload, NOT thrown. Thrown/JSON-RPC errors are reserved for malformed calls or a
// broken server (the model can't act on those).
//
// Response modes: a session can ask for `compact | normal | verbose`
// output. The human-readable text is rendered per mode; `structuredContent` ALWAYS carries every
// field, so a client that reads structured data loses nothing in compact mode. One exception to
// "the mode only changes the text": element lists (qa_snapshot / qa_act `elements`) are one-line
// @eN strings outside verbose and full objects in verbose (snapshot/present.ts presentElements). The
// active mode is carried in AsyncLocalStorage so EVERY tool inherits it without touching a
// single call site, and concurrent JSON-RPC requests can't clobber each other's mode.
//
// Channel note: Claude Code and Codex hand the MODEL the structuredContent JSON (not the text
// block) for successful results whenever structuredContent is set. So anything the model must
// see (the human summary, "Next: ..." / "Call qa_..." guidance) also has to live in
// structuredContent: qaOk/qaStop put the summary first under `summary` and the extracted
// next-step guidance under `next` (see withSummary). The text block stays as the spec's
// backwards-compatible copy.

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

// NOTE: `type` alias, not `interface`: interfaces lack an implicit index signature and
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

/** Compact (unindented) JSON fence: the text-channel copy of the payload. Indentation roughly
 * doubled its size for no reader benefit (structuredContent carries the full payload anyway). */
function fence(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

/** Default recovery steps for an unknown/expired sessionId. */
export const UNKNOWN_SESSION_NEXT_STEPS: readonly string[] = [
  'Call qa_status without sessionId for orientation, or qa_start_session / qa_test_this to create a session.',
];

/**
 * The one typed envelope for "that sessionId does not exist". It's an invalid argument, so
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

/** Typed envelope for a thrown INVALID_ARGUMENT error, rejected before touching the device. */
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

/** Options for the text rendering of a result (the structured payload keeps every key; only the
 * structured `summary` copy drops rendered @eN element lines). */
export interface QaTextOptions {
  /** Top-level payload keys already rendered in the human text (e.g. `elements`, as @eN lines),
   * left out of the fenced JSON so the text channel doesn't carry them twice. */
  textOmit?: readonly string[];
  /** How much of the summary is copied into structuredContent.summary (what Claude Code / Codex
   * show the model). `headline` (default): the first line, capped at STRUCTURED_HEADLINE_MAX_CHARS;
   * most summaries only re-render payload fields, so the rest is duplicate tokens. `full`: the whole
   * summary (capped at STRUCTURED_SUMMARY_MAX_CHARS), for call sites whose later lines carry
   * information or guidance that is NOT in the payload. `none`: no summary key. `next` is always
   * extracted from the FULL summary, whatever this is. */
  structuredSummary?: 'full' | 'headline' | 'none';
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
 * out keys the summary already rendered, via opts.textOmit; verbose keeps them).
 */
function renderText(summary: string, payload: Record<string, unknown>, mode: ResponseMode, opts?: QaTextOptions): string {
  if (mode === 'compact') {
    const uris = uriLines(payload);
    return uris.length ? `${summary}\n${uris.join('\n')}` : summary;
  }
  // verbose keeps every key in the fence; normal drops the ones the summary already rendered.
  return `${summary}\n\n${fence(mode === 'verbose' ? payload : withoutKeys(payload, opts?.textOmit))}`;
}

/** Longest `what` an error carries. It often echoes caller input (a URI, a query), and the error
 * repeats it in the text head, the JSON fence and structuredContent, so a multi-MB argument used to
 * produce a response bigger than a client's read buffer (SDK 1.32 clients drop the connection at 10 MB). */
export const MAX_ERROR_WHAT_CHARS = 2000;
/** Most nextSteps entries an error carries. */
const MAX_ERROR_STEPS = 20;
/** Longest single nextSteps entry / clientHint / commandAttempted. */
export const MAX_ERROR_STEP_CHARS = 2000;
/** Longest string value anywhere inside an error's `extra` fields (nested objects and arrays too). */
export const MAX_ERROR_EXTRA_STRING_CHARS = 8000;
/** Nesting depth below which `extra` values are walked; deeper values are replaced by a marker. */
const MAX_ERROR_EXTRA_DEPTH = 8;
/** Safety net: an error whose serialized structuredContent is still bigger than this drops its
 * `extra` fields (listed under `extraDropped`). */
export const MAX_ERROR_PAYLOAD_CHARS = 64 * 1024;

/**
 * Keep the head and the tail of an over-long string around a marker. Command errors put the
 * deciding line (exit code, INSTALL_FAILED_*, the last stack frame) at the END, so a head-only
 * cut dropped exactly the part that explains the failure. Exported for tests.
 */
export function capMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = Math.floor(max * 0.35);
  const head = max - tail;
  return `${s.slice(0, head)} ... [${s.length - head - tail} chars cut] ... ${s.slice(s.length - tail)}`;
}

function capWhat(what: string): string {
  return capMiddle(what, MAX_ERROR_WHAT_CHARS);
}

/** Cap every string inside an `extra` value (bounded depth, arrays and nested objects too). */
function capExtraValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return capMiddle(v, MAX_ERROR_EXTRA_STRING_CHARS);
  if (v === null || typeof v !== 'object') return v;
  const j = (v as { toJSON?: unknown }).toJSON;
  if (typeof j === 'function') return capExtraValue((j as () => unknown).call(v), depth);
  if (depth >= MAX_ERROR_EXTRA_DEPTH) return '[swipium: nested value omitted (too deep)]';
  if (Array.isArray(v)) return v.map((x) => capExtraValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[capMiddle(k, 200)] = capExtraValue(x, depth + 1);
  return out;
}

/**
 * The typed error envelope. Every string that can echo caller input is capped (what, nextSteps,
 * clientHint, commandAttempted, and every string inside `extra`), and an envelope still over
 * MAX_ERROR_PAYLOAD_CHARS drops its `extra` fields, so no argument can blow the response past a
 * client's read buffer.
 */
export function qaError(input: QaErrorInput, extra?: Record<string, unknown>): CallToolResult {
  const p: QaErrorInput = {
    ...input,
    what: capWhat(String(input.what ?? '')),
    nextSteps: (input.nextSteps ?? []).slice(0, MAX_ERROR_STEPS).map((n) => capMiddle(String(n), MAX_ERROR_STEP_CHARS)),
    ...(input.clientHint !== undefined ? { clientHint: capMiddle(String(input.clientHint), MAX_ERROR_STEP_CHARS) } : {}),
    ...(input.commandAttempted !== undefined ? { commandAttempted: capMiddle(String(input.commandAttempted), MAX_ERROR_STEP_CHARS) } : {}),
  };
  const cappedExtra = extra ? (capExtraValue(extra, 0) as Record<string, unknown>) : {};
  let payload: Record<string, unknown> & QaErrorInput = { ok: false, failureCode: p.failureCode ?? 'UNKNOWN', ...p, ...cappedExtra };
  if (extra && JSON.stringify(payload).length > MAX_ERROR_PAYLOAD_CHARS) {
    payload = {
      ok: false,
      failureCode: p.failureCode ?? 'UNKNOWN',
      ...p,
      extraDropped: Object.keys(cappedExtra)
        .slice(0, 50)
        .map((k) => capMiddle(k, 100)),
      extraDroppedNote: `extra error fields were dropped: the envelope exceeded ${MAX_ERROR_PAYLOAD_CHARS} chars`,
    };
  }
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

/** Cap for the summary copy in structuredContent: it duplicates data that is already structured,
 * so a very long rendering (many flow steps, smoke flows) is cut with a marker. */
export const STRUCTURED_SUMMARY_MAX_CHARS = 4000;

/** Rendered element lines ("@e12 [button] ...") are dropped from the structured summary copy:
 * the elements themselves are in the payload (that is what textOmit says). */
const ELEMENT_LINE = /^@e\d+\s/;

/** Cap for the `headline` structured summary (the default): the first line only. */
export const STRUCTURED_HEADLINE_MAX_CHARS = 300;

function structuredSummary(summary: string, opts?: QaTextOptions): string {
  let s = summary;
  if (opts?.textOmit?.length) {
    s = s
      .split('\n')
      .filter((l) => !ELEMENT_LINE.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if ((opts?.structuredSummary ?? 'headline') === 'headline') {
    const first = s.split('\n').find((l) => l.trim()) ?? '';
    const line = first.trim();
    return line.length > STRUCTURED_HEADLINE_MAX_CHARS ? `${line.slice(0, STRUCTURED_HEADLINE_MAX_CHARS)}...` : line;
  }
  if (s.length > STRUCTURED_SUMMARY_MAX_CHARS) {
    s = `${s.slice(0, STRUCTURED_SUMMARY_MAX_CHARS)}\n... (summary truncated; the structured fields carry the full data)`;
  }
  return s;
}

/** Normalize one guidance snippet: drop a leading "call " (any case), trailing punctuation and spaces. */
function cleanNext(s: string): string {
  return s
    .trim()
    .replace(/^call\s+/i, '')
    .replace(/[.\s]+$/, '');
}

/** A kept entry must START with the tool to call (after an optional "call "). */
const NEXT_ENTRY = /^qa_[a-z_]+/;

/**
 * Next-step guidance embedded in a human summary, as a string array (each entry starts with the
 * tool to call, e.g. `qa_report to summarize`). Candidates are recognized only at a line start or a
 * sentence boundary (". "), so quoted UI labels like "Next: Payment" are not picked up:
 *  - `Next: X` / `next: X` (or `next:` followed by " - X" bullet lines)
 *  - `Call qa_xxx ...` up to the end of the line
 * A candidate is split at ". Call qa_" sentence boundaries, a leading "call " is dropped, and only
 * entries that then start with a qa_ tool name are kept (so "next: smoke_tested (...)" or
 * "Next: Payment screen loaded" yield nothing). Duplicates are dropped. Exported for tests.
 */
export function extractNextSteps(summary: string): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    for (const part of v.split(/\.\s+(?=call\s+qa_)/i)) {
      const c = cleanNext(part);
      if (NEXT_ENTRY.test(c) && !out.includes(c)) out.push(c);
    }
  };
  const lines = summary.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nm = line.match(/(?:^|\.\s+)[^\w\s"'`]*\s*[Nn]ext:\s*(.*)$/u);
    if (nm) {
      if (nm[1].trim()) add(nm[1]);
      else {
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) add(lines[++i].replace(/^\s*-\s+/, ''));
      }
      continue;
    }
    const cm = line.match(/(?:^|\.\s+)[^\w\s"'`]*\s*([Cc]all qa_\w+.*)$/u);
    if (cm) add(cm[1]);
  }
  return out;
}

/** Payload keys that already carry next-step guidance; `next` is not added on top of them. */
const PAYLOAD_NEXT_KEYS = ['next', 'nextSteps', 'nextBestAction', 'nextAction', 'nextRecommendedAction'] as const;

/** structuredContent for a success: `summary` first (unless the payload has its own, or
 * opts.structuredSummary is 'none'), then the payload, then `next` (extracted guidance, unless the
 * payload already carries next-step guidance of its own). */
function withSummary(base: Record<string, unknown>, summary: string, opts?: QaTextOptions, next?: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!('summary' in base) && opts?.structuredSummary !== 'none') {
    const s = structuredSummary(summary, opts);
    if (s) out.summary = s;
  }
  Object.assign(out, base);
  if (!PAYLOAD_NEXT_KEYS.some((k) => k in base)) {
    const n = next ?? extractNextSteps(summary);
    if (n.length) out.next = n;
  }
  return out;
}

export function qaOk(payload: Record<string, unknown>, summary: string, opts?: QaTextOptions): CallToolResult {
  const base = { ok: true, ...payload };
  return {
    // The fence renders `base`, not the summary/next copies: the text block already IS the summary.
    content: [{ type: 'text', text: renderText(summary, base, currentResponseMode(), opts) }],
    structuredContent: withSummary(base, summary, opts),
  };
}

/** Append advisory notes (e.g. params ignored in the active mode) to a result without touching
 * its verdict. Same pattern qa_generate established for mode/target-scoped parameters. */
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
  const base = { ok: true, stopped: true, reason, ...payload };
  const summary = `⏹ Stopped: ${reason}\nCall qa_report to summarize what was verified.`;
  return {
    content: [{ type: 'text', text: renderText(summary, base, currentResponseMode()) }],
    structuredContent: withSummary(base, summary, undefined, ['qa_report to summarize what was verified']),
  };
}

/**
 * Typed envelope for work that was CANCELLED (the MCP request was aborted, or the job was
 * cancelled). failureCode CANCELLED. Not a failure: it is never recorded as a tool error, a
 * snapshot failure, a finding or a health verdict, and it never switches the session mode.
 */
export function cancelledResult(what = 'Cancelled: the call was aborted before it finished', changedState = false): CallToolResult {
  return qaError({
    what,
    changedState,
    retrySafe: true,
    failureCode: 'CANCELLED',
    nextSteps: ['Nothing was recorded as a failure. Re-run the call if you still need its result.'],
  });
}
