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
import { resolveProjectRoot } from '../context/projectRoot.js';
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
      error: qaError({
        what: 'Could not resolve a project root',
        changedState: false,
        retrySafe: true,
        nextSteps: ['Pass projectRoot or call qa_start_session.'],
        clientHint: resolved.hint,
      }),
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
        'Build the app from source — or just propose how. mode:"plan" (default) is side-effect free: it returns the exact prerequisite + build commands (deps install, Expo prebuild, pod install), the main build command + cwd, the expected artifact globs, and toolchain status, per framework (Expo/RN/native/Flutter); typed blockers: UNSUPPORTED_FRAMEWORK, BUILD_COMMAND_UNAVAILABLE. mode:"run" executes that plan (consent-gated) as a background job: it captures a combined build log artifact and, on success, re-resolves the produced artifact (path/appId/installability); on failure it returns a typed blocker (GRADLE_FAILED/XCODEBUILD_FAILED/FLUTTER_BUILD_FAILED/BUILD_TIMED_OUT/DEPENDENCY_INSTALL_REQUIRED) with the log — a build failure is NOT a test failure. mode:"run" returns a jobId (poll qa_job_status) and requires a session (for artifacts/log storage).',
      inputSchema: {
        mode: z
          .enum(['plan', 'run'])
          .optional()
          .describe(
            'plan (default): side-effect-free — return the exact commands, expected artifacts, and toolchain status without building. run: execute the planned prerequisites + build as a consent-gated background job.',
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            'Session from qa_start_session. Optional in mode:"plan" (projectRoot works too); REQUIRED in mode:"run" — the build log is stored as a session artifact.',
          ),
        projectRoot: z.string().optional().describe('(mode:"plan" only) Resolve the project without a session.'),
        platform: z.enum(['android', 'ios']),
        variant: z.enum(['debug', 'release']).optional(),
        timeoutMs: z.number().optional().describe(`(mode:"run" only) Per-step timeout (default ${DEFAULT_BUILD_TIMEOUT_MS}).`),
        consentId: z.string().optional().describe('(mode:"run" only) Consent token from the previous refusal.'),
        approve: z.boolean().optional().describe('(mode:"run" only) Set true with consentId to execute the exact reviewed commands.'),
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

      // Consent: building from source spends minutes + writes into the project tree.
      const steps = [...plan.prerequisites, plan.build];
      const affects = { commands: steps.map((s) => s.command), cwd: plan.build.cwd };
      const gate = consumeConsent(consentId, approve, { action: 'build_from_source', affects });
      if (!gate.approved) {
        sessions.recordMutation(session, {
          tool: 'qa_build',
          action: 'build_from_source',
          risk: 'medium',
          target: affects,
          consent: { required: true, approved: false },
          status: 'requested',
        });
        return qaAnnotate(
          requireConsent({
            action: 'build_from_source',
            risk: 'medium',
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
        risk: 'medium',
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
        risk: 'medium',
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
        risk: 'medium',
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
      risk: 'medium',
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
