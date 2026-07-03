// Tool result envelopes (DESIGN §3 "Every tool is self-diagnosing", §2.1 contract).
//
// Recoverable failures are returned as isError:true with a structured, actionable
// payload — NOT thrown. Thrown/JSON-RPC errors are reserved for malformed calls or a
// broken server (the model can't act on those).
//
// Response modes (PHASE3-PLAN §2.1): a session can ask for `compact | normal | verbose`
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
  changedState: boolean; // did we mutate device/app/fs? feeds retry-safety (DESIGN §6)
  retrySafe: boolean;
  nextSteps: string[];
  artifactUri?: string;
  clientHint?: string;
  failureCode: string; // typed failure class (PHASE3-PLAN §4.3); UNKNOWN is the fallback
};

type QaErrorInput = Omit<QaErrorPayload, 'ok' | 'failureCode'> & { failureCode?: string };

function fence(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
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
 * keep the fence for clients/humans reading the text channel.
 */
function renderText(summary: string, payload: Record<string, unknown>, mode: ResponseMode): string {
  if (mode === 'compact') {
    const uris = uriLines(payload);
    return uris.length ? `${summary}\n${uris.join('\n')}` : summary;
  }
  return `${summary}\n\n${fence(payload)}`;
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

export function qaOk(payload: Record<string, unknown>, summary: string): CallToolResult {
  const structured = { ok: true, ...payload };
  return {
    content: [{ type: 'text', text: renderText(summary, structured, currentResponseMode()) }],
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
