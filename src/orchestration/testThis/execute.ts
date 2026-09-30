// qa_test_this execute/interactive mode gate — handles the synchronous half of execution:
// the auth question, the unified consent preflight (Milestone A), job creation, and the
// optional waitForCompletion window. The heavy pipeline itself runs in ./pipeline.js.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaOk } from '../../lib/result.js';
import { qaNeedsInput, NeedsInput } from '../../lib/needsInput.js';
import { buildPlan, type BuildPlatform } from '../../build/plan.js';
import { requireConsent, consumeConsent } from '../../consent/consent.js';
import { buildTestThisPreflight } from '../../services/preflight.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { SessionStore } from '../../session/store.js';
import type { Session } from '../../session/store.js';
import type { ExecuteArgs } from './types.js';
import { runExecutePipeline } from './pipeline.js';
import { hasUsableCredentials, credentialsLostOnRestart, isLoginDeclined } from './sessionIntent.js';
import { runWithSignal } from '../../lib/abortScope.js';

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Whether `p` is inside `root` after resolving `..` segments and symlinks (a plain string prefix
 *  check lets `<root>/../../x.apk` count as in-root). */
export function isWithinRoot(p: string, root: string): boolean {
  const rel = relative(realOrResolved(root), realOrResolved(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Execute / interactive orchestration: handle questions + consent synchronously, then run the
 *  build/convert → prepare → smoke → report pipeline as a job. */
export async function runExecuteMode(server: McpServer, sessions: SessionStore, session: Session, a: ExecuteArgs): Promise<CallToolResult> {
  // 1. Auth question — interactive (or stopOnNeedsInput / goal:test_login) asks; execute proceeds pre-login.
  if (
    a.scan.likelyAuth &&
    !isLoginDeclined(session) &&
    !hasUsableCredentials(session) &&
    (a.mode === 'interactive' || a.stopOnNeedsInput)
  ) {
    // Stored credential METADATA survives a restart but the values do not — re-ask, and say why.
    const lost = credentialsLostOnRestart(session);
    const attempted = [
      `scanned project (framework=${a.scan.framework}; detected likely auth: ${a.scan.authSignals.slice(0, 3).join(', ') || 'login UI'})`,
      `resolved artifact + target (${a.target.selected ?? 'unknown'})`,
      ...session.workarounds,
      ...(lost ? ['found stored credential metadata, but the values were not kept across the server restart (secrets never persist)'] : []),
    ];
    return qaNeedsInput(
      NeedsInput.credentials(
        lost
          ? 'Credentials were provided earlier, but their values are gone after a server restart (secrets are never persisted).'
          : 'Authenticated workflows need a test account.',
      ),
      {
        sessionId: session.id,
        state: 'needs_input',
        attempted,
        appMapUri: a.appMapUri,
        resumeWith: 'qa_continue_from_blocker',
      },
    );
  }

  // 2. Unified execution preflight (Milestone A): execute mode must request the SAME consent the
  //    lower-level tools would for boot / external-APK / iOS .app install / build-from-source.
  const buildPlatform: BuildPlatform = (a.platform ?? (a.scan.framework === 'native-ios' ? 'ios' : 'android')) as BuildPlatform;
  // Resolve the EXACT build command so the consent shows what will run (not just "build_from_source").
  let buildCommand: string | undefined;
  if (a.needBuild) {
    const bp = await buildPlan({ projectRoot: session.root, platform: buildPlatform });
    buildCommand = bp.build?.command;
  }
  // Hash an external (outside-root) APK so the consent shows what is being installed.
  let externalApk: { path: string; sha256: string } | undefined;
  if (a.isAndroid && !a.needBuild && a.effectiveApk && existsSync(a.effectiveApk) && !isWithinRoot(a.effectiveApk, session.root)) {
    try {
      externalApk = { path: a.effectiveApk, sha256: createHash('sha256').update(readFileSync(a.effectiveApk)).digest('hex') };
    } catch {
      /* unreadable — treated as in-root install */
    }
  }
  const iosApp = !a.isAndroid && !a.isIosReal ? a.art.best?.path : undefined;
  const preflight = buildTestThisPreflight({
    isAndroid: a.isAndroid,
    needBuild: a.needBuild,
    buildPlatform,
    buildCommand,
    willBoot: a.target.willBoot,
    bootTarget: a.target.bootTarget,
    isAab: a.isAab,
    apkPath: a.isAndroid ? a.effectiveApk : undefined,
    externalApk,
    iosApp,
    iosAppOutsideRoot: iosApp ? !isWithinRoot(iosApp, session.root) : undefined,
    iosReal: a.isIosReal,
    iosRealUdid: a.isIosReal ? a.target.device : undefined,
    iosRealApp: a.isIosReal ? a.art.best?.path : undefined,
  });
  let mutationConsent: ExecuteArgs['mutationConsent'];
  let testThisPlanMutation: ExecuteArgs['testThisPlanMutation'];
  if (preflight.consentRequired) {
    const gate = consumeConsent(a.consentId, a.approve, { action: 'test_this_plan', affects: preflight.consentAffects });
    if (!gate.approved) {
      sessions.recordMutation(session, {
        tool: 'qa_test_this',
        action: 'test_this_plan',
        risk: preflight.risk,
        target: preflight.consentAffects,
        consent: { required: true, approved: false },
        status: 'requested',
      });
      const consentResult = requireConsent({
        action: 'test_this_plan',
        risk: preflight.risk,
        exactCommand: preflight.exactCommand,
        affects: preflight.consentAffects,
        explain: `Running "test this" needs these privileged steps (approved together so they don't re-prompt):\n${preflight.exactCommand}\nApprove to start; Swipium then installs, smokes, reports${a.generateSuite ? ', and generates a suite' : ''}.`,
      });
      // A supplied consentId that could not be used must be explained — never a silent re-challenge.
      const staleNote = a.consentId
        ? `consent ${a.consentId} ${/unknown|expired|already-used/i.test(gate.reason ?? '') ? 'unknown or expired' : `not applied (${gate.reason ?? 'not usable'})`} — new challenge issued`
        : undefined;
      // sessionId rides on the consent result so the approving re-call reuses THIS session (no
      // projectRoot needed); the static app map URI stays visible too (Fix 1).
      const sc = (consentResult.structuredContent ?? {}) as Record<string, unknown>;
      consentResult.structuredContent = {
        ...sc,
        sessionId: session.id,
        ...(a.appMapUri ? { appMapUri: a.appMapUri } : {}),
        ...(staleNote ? { consentNote: staleNote, previousConsentId: a.consentId } : {}),
      };
      const approveCall = { sessionId: session.id, mode: a.mode, consentId: sc.consentId, approve: true };
      consentResult.content = [
        ...(staleNote ? [{ type: 'text' as const, text: `⚠️ ${staleNote}.` }] : []),
        ...(consentResult.content ?? []),
        {
          type: 'text' as const,
          text: `After the user agrees: qa_test_this ${JSON.stringify(approveCall)} (plus your original goal/flags).`,
        },
      ];
      return consentResult;
    }
    mutationConsent = { required: true, consentId: a.consentId, approved: true };
    testThisPlanMutation = { affects: preflight.consentAffects, risk: preflight.risk };
    sessions.recordMutation(session, {
      tool: 'qa_test_this',
      action: 'test_this_plan',
      risk: preflight.risk,
      target: preflight.consentAffects,
      consent: mutationConsent,
      status: 'approved',
    });
  }

  const job = sessions.createJob(session, `test_this:${a.mode}`);
  const execArgs = { ...a, mutationConsent, testThisPlanMutation };
  // The job's cancellation signal is scoped to its own async context (abortScope): driver calls
  // made by the pipeline are cancelled with the job, and interactive calls made concurrently on
  // the shared driver keep their own signal.
  const run = runWithSignal(sessions.abortSignal(session, job.jobId), () => runExecutePipeline(sessions, session, job, execArgs));

  // Optional blocking mode for short paths (Milestone D). Default = return the running job.
  if (a.waitForCompletion) {
    const deadline = Date.now() + (a.timeoutMs ?? 120_000);
    await Promise.race([run, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    const cur = session.jobs.get(job.jobId);
    if (cur && cur.status !== 'running') {
      const res = (cur.result ?? {}) as Record<string, unknown>;
      return qaOk(
        { sessionId: session.id, mode: a.mode, jobId: job.jobId, appMapUri: a.appMapUri, ...res },
        cur.resultText ?? `test-this ${a.mode} ${res.state ?? cur.status}.`,
      );
    }
    // Timed out — leave the job running and tell the agent to poll.
    return qaOk(
      { sessionId: session.id, state: 'running', mode: a.mode, jobId: job.jobId, appMapUri: a.appMapUri, timedOutWaiting: true },
      `⏳ test-this ${a.mode} still running after the wait window — poll qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" }.`,
    );
  }

  void run;
  return qaOk(
    { sessionId: session.id, state: 'running', mode: a.mode, jobId: job.jobId, kind: job.kind, appMapUri: a.appMapUri, target: a.target },
    `🚀 test-this ${a.mode} started as job ${job.jobId} (${a.isAndroid ? 'Android' : 'iOS'} · ${a.target.selected}). Poll qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" } for the terminal result (state: completed | blocked | unsafe | needs_input).`,
  );
}
