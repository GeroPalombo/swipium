// Build execution service (hardening P0.1) — runs a build plan's prerequisite + build steps,
// captures a combined log artifact, and re-resolves the produced artifact. Extracted from the
// Build worker used by qa_test_this execute mode. Returns a structured
// result (build failures are typed environment/build blockers, never app QA failures).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../lib/spawn.js';
import { log } from '../lib/logger.js';
import { resolveArtifact, type ArtifactCandidate } from '../artifacts/resolve.js';
import type { BuildPlan, BuildStep } from '../build/plan.js';
import { analyzeBuildFailure } from '../build/parseBuildLog.js';
import type { FailureCode, FailureOwner } from '../oracle/failures.js';
import type { Session, SessionStore } from '../session/store.js';

export interface BuildExecResult {
  ok: boolean;
  aborted?: boolean;
  failureCode?: FailureCode;
  step?: string;
  logUri?: string;
  tail?: string;
  error?: string;
  artifact?: ArtifactCandidate | null;
  warning?: string;
  searchedLocations?: string[];
  /** Likely owner of a build failure (app dev / environment / user / swipium). */
  owner?: FailureOwner;
  /** Concrete fix derived from the build log signatures. */
  fix?: string;
  /** Which log signature matched (null when only the tool default applied). */
  signal?: string | null;
}

/** Most specific build-failure code for a failed step (log-aware classification). */
export function failureForStep(step: BuildStep, timedOut: boolean, log = ''): FailureCode {
  return analyzeBuildFailure({ step, log, timedOut }).failureCode;
}

export interface BuildExecCtx {
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  timeoutMs?: number;
}

export async function executeBuild(
  sessions: SessionStore,
  session: Session,
  plan: BuildPlan,
  ctx: BuildExecCtx = {},
): Promise<BuildExecResult> {
  const { signal } = ctx;
  const aborted = () => signal?.aborted ?? false;
  const progress = (t: string) => ctx.onProgress?.(t);
  const timeoutMs = ctx.timeoutMs ?? 20 * 60_000;
  const logName = `build-${plan.platform}.log`;
  let logBuf = '';
  const steps = [...plan.prerequisites, plan.build!];

  try {
    sessions.milestone(session, 'build_start');
    for (const step of steps) {
      if (aborted()) return { ok: false, aborted: true };
      if (step.optionalIfPresent && existsSync(join(step.cwd, step.optionalIfPresent))) {
        logBuf += `\n=== SKIP ${step.label} (${step.optionalIfPresent} present) ===\n`;
        continue;
      }
      progress(step.label);
      logBuf += `\n=== ${step.label}: ${step.command} (cwd ${step.cwd}) ===\n`;
      const r = await run(step.argv[0], step.argv.slice(1), { cwd: step.cwd, timeoutMs, signal });
      logBuf += r.stdout + r.stderr;
      if (r.code !== 0 || r.timedOut) {
        if (aborted()) return { ok: false, aborted: true };
        const a = analyzeBuildFailure({ step, log: r.stdout + r.stderr, timedOut: r.timedOut });
        const logUri = sessions.saveArtifact(session, 'logs', logName, logBuf, 'text/plain', `failed build log (${a.failureCode})`);
        return {
          ok: false,
          failureCode: a.failureCode,
          step: step.label,
          logUri,
          tail: a.relevantTail,
          owner: a.owner,
          fix: a.fix,
          signal: a.signal,
          error: `${a.reason} — ${step.label} exited ${r.code}${r.timedOut ? ' (timed out)' : ''}`,
        };
      }
    }
    sessions.milestone(session, 'build_end');

    const logUri = sessions.saveArtifact(session, 'logs', logName, logBuf, 'text/plain', 'build log (success)');
    const resolved = await resolveArtifact({
      projectRoot: session.root,
      platform: plan.platform,
      requireInstallableOn: plan.platform === 'android' ? 'android-emulator' : 'ios-simulator',
      allowOutsideRoot: true,
    });
    if (aborted()) return { ok: false, aborted: true };
    if (!resolved.best) {
      return {
        ok: true,
        artifact: null,
        logUri,
        failureCode: 'BUILD_ARTIFACT_UNRESOLVED_AFTER_SUCCESS',
        owner: 'swipium',
        warning: 'Build succeeded but no installable artifact was resolved.',
        searchedLocations: resolved.searchedLocations,
      };
    }
    return { ok: true, artifact: resolved.best, logUri };
  } catch (e) {
    if (aborted()) return { ok: false, aborted: true };
    log('error', 'executeBuild failed', { err: String(e) });
    const logUri = sessions.saveArtifact(session, 'logs', logName, logBuf + '\n' + String(e), 'text/plain', 'build log (error)');
    return { ok: false, failureCode: 'BUILD_FAILED', logUri, error: String(e) };
  }
}
