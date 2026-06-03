// qa_build_plan + qa_build (roadmap §4.5).
//
// qa_build_plan: side-effect-free. Proposes the exact prerequisite + build commands and the
// artifact globs the build will produce. An agent shows this and asks before compiling.
//
// qa_build: consent-gated. Runs the planned prerequisites + build as a JOB (returns a jobId;
// poll with qa_job_status), captures a combined build log artifact, and classifies a failure
// (GRADLE_FAILED / XCODEBUILD_FAILED / FLUTTER_BUILD_FAILED / BUILD_TIMED_OUT). On success it
// re-resolves the produced artifact so the next step (qa_prepare_target / qa_test_this) has it.

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { qaFail, type FailureCode } from '../oracle/failures.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import { buildPlan, type BuildPlan, type BuildPlatform } from '../build/plan.js';
import { executeBuild } from '../services/build.js';
import type { Session, SessionStore, JobRecord } from '../session/store.js';

const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60_000; // 20 min — native builds are slow

async function rootFrom(server: McpServer, sessions: SessionStore, sessionId?: string, projectRoot?: string): Promise<string | { error: ReturnType<typeof qaError> }> {
  if (sessionId) {
    const r = sessions.get(sessionId)?.root;
    if (r) return r;
  }
  const resolved = await resolveProjectRoot(server, projectRoot);
  if (!resolved.root) return { error: qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or call qa_start_session.'], clientHint: resolved.hint }) };
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
    'qa_build_plan',
    {
      title: 'Plan a build from source',
      description:
        'Propose the exact prerequisite + build commands to produce an installable artifact for a platform, per framework (Expo/RN/native/Flutter). Side-effect free. Returns prerequisites (deps install, Expo prebuild, pod install), the main build command + cwd, expected artifact globs, and toolchain status. Typed blockers: UNSUPPORTED_FRAMEWORK, BUILD_COMMAND_UNAVAILABLE. Run qa_build to actually execute.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        platform: z.enum(['android', 'ios']),
        variant: z.enum(['debug', 'release']).optional(),
      },
    },
    async ({ sessionId, projectRoot, platform, variant }) => {
      const root = await rootFrom(server, sessions, sessionId, projectRoot);
      if (typeof root !== 'string') return root.error;
      const plan = await buildPlan({ projectRoot: root, platform: platform as BuildPlatform, variant });
      if (plan.failureCode) {
        return qaFail(plan.failureCode, { what: plan.notes[0] ?? `Cannot plan a ${platform} build for ${plan.framework}`, extra: { plan } });
      }
      return qaOk({ plan }, planSummary(plan));
    },
  );

  server.registerTool(
    'qa_build',
    {
      title: 'Build the app from source',
      description:
        'Run the planned prerequisites + build (consent-gated) as a background job. Captures a combined build log artifact and, on success, re-resolves the produced artifact (path/appId/installability). On failure returns a typed blocker (GRADLE_FAILED/XCODEBUILD_FAILED/FLUTTER_BUILD_FAILED/BUILD_TIMED_OUT/DEPENDENCY_INSTALL_REQUIRED) with the log — a build failure is NOT a test failure. Returns a jobId; poll qa_job_status. Requires a session (for artifacts/log storage).',
      inputSchema: {
        sessionId: z.string().describe('A session from qa_start_session (build log is stored as a session artifact).'),
        platform: z.enum(['android', 'ios']),
        variant: z.enum(['debug', 'release']).optional(),
        timeoutMs: z.number().optional().describe(`Per-step timeout (default ${DEFAULT_BUILD_TIMEOUT_MS}).`),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, platform, variant, timeoutMs, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return qaError({ what: `Unknown sessionId "${sessionId}"`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });

      const plan = await buildPlan({ projectRoot: session.root, platform: platform as BuildPlatform, variant });
      if (plan.failureCode) return qaFail(plan.failureCode, { what: plan.notes[0] ?? 'Cannot build', extra: { plan } });
      if (!plan.toolchainOk) return qaFail('BUILD_COMMAND_UNAVAILABLE', { what: `Missing toolchain: ${plan.missingToolchain.join(', ')}`, extra: { plan } });
      if (!plan.build) return qaFail('BUILD_COMMAND_UNAVAILABLE', { extra: { plan } });

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
        return requireConsent({
          action: 'build_from_source',
          risk: 'medium',
          exactCommand: steps.map((s) => `(${s.cwd}) ${s.command}`).join('\n'),
          affects,
          explain: `Build ${plan.framework}/${platform}/${plan.variant} from source. This runs:\n${steps.map((s) => `• ${s.label}: ${s.command}`).join('\n')}`,
        });
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
      return qaOk(
        { jobId: job.jobId, status: 'running', kind: job.kind, plan },
        `Started ${plan.framework}/${platform} build as job ${job.jobId}. Poll qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" }.`,
      );
    },
  );
}

async function runBuild(sessions: SessionStore, session: Session, job: JobRecord, plan: BuildPlan, timeoutMs: number, mutation?: { affects: Record<string, unknown>; consentId?: string }): Promise<void> {
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
      result: { failureCode: res.failureCode, step: res.step, logUri: res.logUri, tail: res.tail, nextSteps: info?.structuredContent.nextSteps },
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
    upd({ status: 'done', progress: 'done', result: { built: true, artifact: null, logUri: res.logUri, warning: res.warning, searchedLocations: res.searchedLocations }, resultText: `⚠️ Build finished but Swipium could not locate the artifact. Log: ${res.logUri}`, endedAt: Date.now() });
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
  upd({ status: 'done', progress: 'done', result: { built: true, artifact: res.artifact, logUri: res.logUri }, resultText: `✅ Built ${res.artifact.type.toUpperCase()} at ${res.artifact.path}${res.artifact.appId ? ` (appId ${res.artifact.appId})` : ''}. Next: qa_prepare_target.`, endedAt: Date.now() });
}
