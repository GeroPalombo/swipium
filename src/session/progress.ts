// Progress model helper (hardening P1.1). Long-running jobs report a consistent progress shape
// (phase / elapsed / statusText / lastEvent / nextExpected / logUri / userActionRequired) so an
// agent can relay status compactly. `startProgress` returns a small controller a worker uses to
// emit events; it writes both the legacy `progress` string and the structured `progressDetail`.

import type { Session, SessionStore, JobRecord, ProgressModel } from './store.js';

export interface ProgressController {
  event(lastEvent: string, opts?: { statusText?: string; nextExpected?: string }): void;
  setLog(logUri: string): void;
  needsUser(statusText: string): void;
  done(statusText?: string): void;
  /** Current elapsed seconds since the phase started. */
  elapsedSec(): number;
}

export function startProgress(
  sessions: SessionStore,
  session: Session,
  job: JobRecord,
  phase: string,
  init: { statusText: string; nextExpected?: string; logUri?: string } = { statusText: phase },
): ProgressController {
  const now = Date.now();
  const model: ProgressModel = {
    phase,
    startedAt: now,
    updatedAt: now,
    statusText: init.statusText,
    nextExpected: init.nextExpected,
    logUri: init.logUri,
    userActionRequired: false,
  };
  const write = () => {
    model.updatedAt = Date.now();
    sessions.updateJobIfRunning(session, job, { progress: model.statusText, progressDetail: { ...model } });
  };
  write();
  return {
    elapsedSec: () => Math.round((Date.now() - model.startedAt) / 1000),
    event(lastEvent, opts) {
      model.lastEvent = lastEvent;
      if (opts?.statusText) model.statusText = opts.statusText;
      if (opts?.nextExpected) model.nextExpected = opts.nextExpected;
      write();
    },
    setLog(logUri) {
      model.logUri = logUri;
      write();
    },
    needsUser(statusText) {
      model.userActionRequired = true;
      model.statusText = statusText;
      write();
    },
    done(statusText) {
      model.userActionRequired = false;
      if (statusText) model.statusText = statusText;
      model.nextExpected = undefined;
      write();
    },
  };
}

/** Compact one-line progress summary for qa_status / qa_job_status. */
export function progressLine(p: ProgressModel | undefined): string | undefined {
  if (!p) return undefined;
  const sec = Math.round((p.updatedAt - p.startedAt) / 1000);
  return (
    `${p.phase} (${sec}s)${p.userActionRequired ? ' ⚠ needs you' : ''}: ${p.statusText}` + (p.nextExpected ? ` → ${p.nextExpected}` : '')
  );
}
