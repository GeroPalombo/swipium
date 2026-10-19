// Top-level guard for background jobs started with `void`: a worker that throws past its own
// try/catch (or whose catch throws) must not leave the job "running" forever with an unhandled
// rejection. The job is marked failed, unless it already reached a terminal state (a cancelled
// job stays cancelled).

import { log } from '../lib/logger.js';
import type { JobRecord, Session, SessionStore } from '../session/store.js';

export function failCrashedJob(sessions: SessionStore, session: Session, job: JobRecord, what: string, e: unknown): void {
  log('error', `${what} job crashed`, { jobId: job.jobId, err: String(e) });
  sessions.updateJobIfRunning(session, job, {
    status: 'failed',
    error: String(e),
    resultText: `❌ ${what} failed: ${String(e)}`,
    endedAt: Date.now(),
  });
}
