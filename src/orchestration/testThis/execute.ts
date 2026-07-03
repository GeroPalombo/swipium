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
import { existsSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Session, SessionStore } from '../../session/store.js';
import type { ExecuteArgs } from './types.js';
import { runExecutePipeline } from './pipeline.js';

/** Whether the secure store already has login credentials (so we don't re-ask). */
function hasCredentials(session: Session): boolean {
  return session.inputs.some((i) => /EMAIL|PASSWORD/.test(i.varName));
}

/** Execute / interactive orchestration: handle questions + consent synchronously, then run the
 *  build/convert → prepare → smoke → report pipeline as a job. */
export async function runExecuteMode(server: McpServer, sessions: SessionStore, session: Session, a: ExecuteArgs): Promise<CallToolResult> {
  // 1. Auth question — interactive (or stopOnNeedsInput / goal:test_login) asks; execute proceeds pre-login.
  if (a.scan.likelyAuth && !hasCredentials(session) && (a.mode === 'interactive' || a.stopOnNeedsInput)) {
    const attempted = [
      `scanned project (framework=${a.scan.framework}; detected likely auth: ${a.scan.authSignals.slice(0, 3).join(', ') || 'login UI'})`,
      `resolved artifact + target (${a.target.selected ?? 'unknown'})`,
      ...session.workarounds,
    ];
    return qaNeedsInput(NeedsInput.credentials('Authenticated workflows need a test account.'), {
      sessionId: session.id,
      state: 'needs_input',
      attempted,
      appMapUri: a.appMapUri,
      resumeWith: 'qa_continue_from_blocker',
    });
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
  if (a.isAndroid && !a.needBuild && a.effectiveApk && existsSync(a.effectiveApk) && !a.effectiveApk.startsWith(session.root + sep)) {
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
    iosAppOutsideRoot: iosApp ? !iosApp.startsWith(session.root + sep) : undefined,
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
      // The static app map was already built pre-launch — keep its URI on the consent result (Fix 1).
      if (a.appMapUri && consentResult.structuredContent) {
        consentResult.structuredContent = { ...(consentResult.structuredContent as Record<string, unknown>), appMapUri: a.appMapUri };
      }
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
  const run = runExecutePipeline(sessions, session, job, execArgs);

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
    `🚀 test-this ${a.mode} started as job ${job.jobId} (${a.isAndroid ? 'Android' : 'iOS'} · ${a.target.selected}). Poll qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}" } for the terminal result (state: completed | blocked | unsafe).`,
  );
}
