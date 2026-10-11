// MCP progress notifications (notifications/progress) for the calls that wait on a background job
// (qa_job_status waitMs, qa_test_this waitForCompletion). The tool wrapper (src/server.ts) puts the
// calling request's progressToken + notify into an AsyncLocalStorage scope; a wait loop asks for a
// reporter and feeds it the job on every poll. Nothing is sent when the request carried no
// progressToken.

import { AsyncLocalStorage } from 'node:async_hooks';
import { progressLine } from '../session/progress.js';
import type { ProgressModel } from '../session/store.js';

export interface ProgressSink {
  token: string | number;
  notify: (n: { method: 'notifications/progress'; params: Record<string, unknown> }) => Promise<void>;
}

const scope = new AsyncLocalStorage<ProgressSink | undefined>();

/** Run `fn` with `sink` as the current request's progress channel. */
export function runWithProgressSink<T>(sink: ProgressSink | undefined, fn: () => T): T {
  return scope.run(sink, fn);
}

/** The progress channel of an SDK request context: present only when the request sent a
 *  progressToken (in its `_meta`) and the context can send notifications. */
export function progressSinkFromContext(ctx: unknown): ProgressSink | undefined {
  const req = (ctx as { mcpReq?: { _meta?: { progressToken?: unknown }; notify?: unknown } } | undefined)?.mcpReq;
  if (!req) return undefined;
  const { _meta: meta, notify } = req;
  const token = meta?.progressToken;
  if ((typeof token !== 'string' && typeof token !== 'number') || typeof notify !== 'function') return undefined;
  return { token, notify: notify as ProgressSink['notify'] };
}

/** Minimum gap between two progress notifications of one wait. */
export const PROGRESS_MIN_INTERVAL_MS = 1_000;

/**
 * A reporter for one wait loop, or undefined when the current request has no progressToken. Call
 * it with the job on every poll: it sends a notification when the job's progress line changed,
 * at most once per PROGRESS_MIN_INTERVAL_MS, with a monotonically increasing `progress` counter.
 * Stop calling it once the job finished (no notification may follow the response).
 */
export function jobProgressReporter(
  minIntervalMs = PROGRESS_MIN_INTERVAL_MS,
): ((job: { progress?: string; progressDetail?: ProgressModel }) => void) | undefined {
  const sink = scope.getStore();
  if (!sink) return undefined;
  let count = 0;
  let last: string | undefined;
  let lastAt = 0;
  return (job) => {
    const message = progressLine(job.progressDetail) ?? job.progress ?? '';
    const now = Date.now();
    if (message === last || now - lastAt < minIntervalMs) return;
    last = message;
    lastAt = now;
    count += 1;
    sink
      .notify({ method: 'notifications/progress', params: { progressToken: sink.token, progress: count, ...(message ? { message } : {}) } })
      .catch(() => {});
  };
}
