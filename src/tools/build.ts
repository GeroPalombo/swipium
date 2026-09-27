// qa_build (roadmap §4.5; 1.5.0 consolidation: the former plan/build twins are one tool with a mode enum).
//
// mode:"plan" (default): side-effect-free. Proposes the exact prerequisite + build commands and the
// artifact globs the build will produce. An agent shows this and asks before compiling.
//
// mode:"run": consent-gated. Runs the planned prerequisites + build as a JOB (returns a jobId;
// poll with qa_job_status), captures a combined build log artifact, and classifies a failure
// (GRADLE_FAILED / XCODEBUILD_FAILED / FLUTTER_BUILD_FAILED / BUILD_TIMED_OUT). On success it
// re-resolves the produced artifact so the next step (qa_prepare_target / qa_test_this) has it.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, qaAnnotate } from '../lib/result.js';
import { qaFail } from '../oracle/failures.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { resolveProjectRoot, unresolvedProjectRootError } from '../context/projectRoot.js';
import { buildPlan, type BuildPlan, type BuildPlatform } from '../build/plan.js';
import { executeBuild } from '../services/build.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';

const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60_000; // 20 min — native builds are slow

async function rootFrom(
  server: McpServer,
  sessions: SessionStore,
  sessionId?: string,
  projectRoot?: string,
): Promise<string | { error: ReturnType<typeof qaError> }> {
  if (sessionId) {
    const r = sessions.get(sessionId)?.root;
    if (r) return r;
  }
  const resolved = await resolveProjectRoot(server, projectRoot);
  if (!resolved.root)
    return {
      error: unresolvedProjectRootError(resolved),
    };
  return resolved.root;
}

function planSummary(plan: BuildPlan): string {
  const pre = plan.prerequisites.map((s) => `  - ${s.label}: ${s.command}`).join('\n');
  return (
    `Build plan: ${plan.framework} / ${plan.platform} / ${plan.variant}\n` +
    (plan.prerequisites.length ? `prerequisites:\n${pre}\n` : '') +
    `build: ${plan.build ? plan.build.command + ` (cwd: ${plan.build.cwd})` : '(none)'}\n` +
    `expects: ${plan.expectedArtifactGlobs.join(', ')}\n` +
    `toolchain: ${plan.toolchainOk ? 'ok' : 'MISSING ' + plan.missingToolchain.join(', ')}` +
    (plan.notes.length ? `\nnotes:\n  - ${plan.notes.join('\n  - ')}` : '')
  );
}

export function registerBuild(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_build',
    {
      title: 'Plan or run a build from source',
      description:
        'Build the app from source, or just propose how. mode:"plan" (default, side-effect free): exact prerequisite + build commands, ' +
        'cwd, expected artifact globs, toolchain status per framework (Expo/RN/native/Flutter). mode:"run" (consent-gated job, needs ' +
        'sessionId): runs them, stores a build log artifact, and re-resolves the produced artifact; failures are typed ' +
        '(GRADLE_FAILED, XCODEBUILD_FAILED, FLUTTER_BUILD_FAILED, BUILD_TIMED_OUT, DEPENDENCY_INSTALL_REQUIRED, …) — a build failure is ' +
        'not a test failure.',
      inputSchema: {
        mode: z.enum(['plan', 'run']).optional(),
        sessionId: z.string().optional().describe('Required for run (stores the build log).'),
        projectRoot: z.string().optional().describe('plan: resolve the project without a session.'),
        platform: z.enum(['android', 'ios']),
        variant: z.enum(['debug', 'release']).optional(),
        timeoutMs: z.number().optional().describe(`run: per-step timeout (default ${DEFAULT_BUILD_TIMEOUT_MS}).`),
        consentId: z.string().optional().describe('run'),
        approve: z.boolean().optional().describe('run'),
      },
    },
    async ({ mode, sessionId, projectRoot, platform, variant, timeoutMs, consentId, approve }) => {
      const effectiveMode = mode ?? 'plan';
      const notes: string[] = [];

      // ---- mode:"plan" — read-only proposal (merged twin, 1.5.0). ----
      if (effectiveMode === 'plan') {
        const ignored = [
          timeoutMs !== undefined && 'timeoutMs',
          consentId !== undefined && 'consentId',
          approve !== undefined && 'approve',
        ].filter((x): x is string => !!x);
        if (ignored.length)
          notes.push(`ignored parameter(s) not applicable to mode:"plan": ${ignored.join(', ')} — re-run with mode:"run" to build`);
        const root = await rootFrom(server, sessions, sessionId, projectRoot);
        if (typeof root !== 'string') return qaAnnotate(root.error, notes);
        const plan = await buildPlan({ projectRoot: root, platform: platform as BuildPlatform, variant });
        if (plan.failureCode) {
          return qaAnnotate(
            qaFail(plan.failureCode, { what: plan.notes[0] ?? `Cannot plan a ${platform} build for ${plan.framework}`, extra: { plan } }),
            notes,
          );
        }
        return qaAnnotate(qaOk({ plan }, `${planSummary(plan)}\nExecute with qa_build { mode:"run" }.`), notes);
      }

      // ---- mode:"run" — consent-gated build job (formerly the bare qa_build). ----
      if (projectRoot !== undefined)
        notes.push('ignored parameter not applicable to mode:"run": projectRoot — mode:"run" builds the session\'s project root');
      if (!sessionId) {
        return qaAnnotate(
          qaError({
            what: 'qa_build mode:"run" needs a sessionId (the build log is stored as a session artifact)',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_start_session first, then qa_build { mode:"run" }.'],
          }),
          notes,
        );
      }
      const session = sessions.get(sessionId);
      if (!session)
        return qaAnnotate(
          qaError({
            what: `Unknown sessionId "${sessionId}"`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_start_session first.'],
          }),
          notes,
        );

      const plan = await buildPlan({ projectRoot: session.root, platform: platform as BuildPlatform, variant });
      if (plan.failureCode) return qaAnnotate(qaFail(plan.failureCode, { what: plan.notes[0] ?? 'Cannot build', extra: { plan } }), notes);
      if (!plan.toolchainOk)
        return qaAnnotate(
          qaFail('BUILD_COMMAND_UNAVAILABLE', { what: `Missing toolchain: ${plan.missingToolchain.join(', ')}`, extra: { plan } }),
          notes,
        );
      if (!plan.build) return qaAnnotate(qaFail('BUILD_COMMAND_UNAVAILABLE', { extra: { plan } }), notes);

      // Consent (risk high): building from source runs arbitrary repo scripts (gradle/xcodebuild/
      // npm lifecycle hooks), spends minutes, and writes into the project tree.
      const steps = [...plan.prerequisites, plan.build];
      const affects = { commands: steps.map((s) => s.command), cwd: plan.build.cwd };
      const gate = consumeConsent(consentId, approve, { action: 'build_from_source', affects });
      if (!gate.approved) {
        sessions.recordMutation(session, {
          tool: 'qa_build',
          action: 'build_from_source',
          risk: 'high',
          target: affects,
          consent: { required: true, approved: false },
          status: 'requested',
        });
        return qaAnnotate(
          requireConsent({
            action: 'build_from_source',
            risk: 'high',
            exactCommand: steps.map((s) => `(${s.cwd}) ${s.command}`).join('\n'),
            affects,
            explain: `Build ${plan.framework}/${platform}/${plan.variant} from source. This runs:\n${steps.map((s) => `• ${s.label}: ${s.command}`).join('\n')}`,
          }),
          notes,
        );
      }
      sessions.recordMutation(session, {
        tool: 'qa_build',
        action: 'build_from_source',
        risk: 'high',
        target: affects,
        consent: { required: true, consentId, approved: true },
        status: 'approved',
      });

      const job = sessions.createJob(session, `build:${platform}`);
      void runBuild(sessions, session, job, plan, timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS, { affects, consentId });
      return qaAnnotate(
        qaOk(
          { jobId: job.jobId, status: 'running', kind: job.kind, plan },
          `Started ${plan.framework}/${platform} build as job ${job.jobId}. Poll qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" }.`,
        ),
        notes,
      );
    },
  );
}

async function runBuild(
  sessions: SessionStore,
  session: Session,
  job: JobRecord,
  plan: BuildPlan,
  timeoutMs: number,
  mutation?: { affects: Record<string, unknown>; consentId?: string },
): Promise<void> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const res = await executeBuild(sessions, session, plan, { signal, timeoutMs, onProgress: (p) => upd({ progress: p }) });
  if (res.aborted) return;
  if (!res.ok) {
    const info = res.failureCode ? (qaFail(res.failureCode) as unknown as { structuredContent: { nextSteps: string[] } }) : undefined;
    if (mutation) {
      sessions.recordMutation(session, {
        tool: 'qa_build',
        action: 'build_from_source',
        risk: 'high',
        target: mutation.affects,
        consent: { required: true, consentId: mutation.consentId, approved: true },
        status: 'blocked',
        ledgerUri: res.logUri,
        detail: `${res.failureCode}: ${res.error}`,
      });
    }
    upd({
      status: 'failed',
      error: `${res.failureCode}: ${res.error}`,
      result: {
        failureCode: res.failureCode,
        step: res.step,
        logUri: res.logUri,
        tail: res.tail,
        nextSteps: info?.structuredContent.nextSteps,
      },
      resultText: `❌ ${res.failureCode} during "${res.step}". Build failure ≠ test failure. Log: ${res.logUri}`,
      endedAt: Date.now(),
    });
    return;
  }
  if (!res.artifact) {
    if (mutation) {
      sessions.recordMutation(session, {
        tool: 'qa_build',
        action: 'build_from_source',
        risk: 'high',
        target: mutation.affects,
        consent: { required: true, consentId: mutation.consentId, approved: true },
        status: 'blocked',
        ledgerUri: res.logUri,
        detail: res.warning ?? 'build finished but no artifact was located',
      });
    }
    upd({
      status: 'done',
      progress: 'done',
      result: { built: true, artifact: null, logUri: res.logUri, warning: res.warning, searchedLocations: res.searchedLocations },
      resultText: `⚠️ Build finished but Swipium could not locate the artifact. Log: ${res.logUri}`,
      endedAt: Date.now(),
    });
    return;
  }
  if (mutation) {
    sessions.recordMutation(session, {
      tool: 'qa_build',
      action: 'build_from_source',
      risk: 'high',
      target: { ...mutation.affects, artifact: res.artifact.path },
      consent: { required: true, consentId: mutation.consentId, approved: true },
      status: 'executed',
      ledgerUri: res.logUri,
    });
  }
  upd({
    status: 'done',
    progress: 'done',
    result: { built: true, artifact: res.artifact, logUri: res.logUri },
    resultText: `✅ Built ${res.artifact.type.toUpperCase()} at ${res.artifact.path}${res.artifact.appId ? ` (appId ${res.artifact.appId})` : ''}. Next: qa_prepare_target.`,
    endedAt: Date.now(),
  });
}
