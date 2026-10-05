// Agent-efficiency layer. Compact, deterministic helpers so an MCP client spends fewer turns:
// the server instructions, a one-glance status (orientation without a session; state + next best
// action with one), a blocker explainer, and a resume-from-blocker entry that consumes
// user-provided input safely.

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { FAILURES, failureOwner, isSelfFixable, type FailureCode } from '../oracle/failures.js';
import { progressLine } from '../session/progress.js';
import { readinessForSession } from '../report/readiness.js';
import { SWIPIUM_VERSION, TOOL_COUNT, PROMPT_COUNT } from '../version.js';
import { TEST_GOALS, type TestGoal } from '../orchestration/goal.js';
import { CAPABILITY_GROUPS } from '../core/capabilityGroups.js';
import type { Session, SessionStore } from '../session/store.js';
import { recallTestThisIntent, markLoginDeclined } from '../orchestration/testThis/sessionIntent.js';
import { SECRET_VAR_NAME } from '../flows/schema.js';
import { RECOMMENDED_JOB_WAIT_MS } from './jobs.js';

function budgetRemaining(s: Session): { minutes: number; actions: number; screenshots: number } {
  const elapsedMin = (Date.now() - s.createdAt) / 60000;
  return {
    minutes: Math.max(0, Math.round((s.budget.maxMinutes - elapsedMin) * 10) / 10),
    actions: Math.max(0, s.budget.maxActions - s.counters.actions),
    screenshots: Math.max(0, s.budget.maxScreenshots - s.counters.screenshots),
  };
}

/** Has this session already produced a durable generated asset (suite/flow/POM/test cases)?
 *  Both generation paths leave a workaround-trail entry on success: the qa_test_this pipeline
 *  records "generated a POM suite (…)" and qa_generate records "generated <target> test asset(s)
 *  from recorded actions (qa_generate)". */
function hasGeneratedAssets(s: Session): boolean {
  return s.workarounds.some((w) => /^generated .*(suite|flow|pom|test)/i.test(w));
}

/** The mode qa_status reports (JSON and text alike). A WDA-less iOS simulator (SimctlDriver, kind
 * 'simulator') is visual-only regardless of the stored mode, which only flips on a failed UI dump. */
export function effectiveMode(
  s: Pick<Session, 'mode' | 'driver'> & { driverKind?: Session['driverKind'] },
): Session['mode'] | 'visual-only' {
  // After a restart there is no live driver, but the persisted driverKind still tells the transport.
  return (s.driver?.kind ?? s.driverKind) === 'simulator' ? 'visual-only' : s.mode;
}

const SIMULATOR_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** Which platform the session's bound device is on. The live driver kind is authoritative
 *  (simctl/WDA ⇒ iOS); a rehydrated session has no driver, so fall back to the device id shape:
 *  iOS simulators are UUIDs, adb serials never are. */
export function sessionPlatform(
  s: Pick<Session, 'device' | 'driver'> & { driverKind?: Session['driverKind'] },
): 'android' | 'ios' | undefined {
  const kind = s.driver?.kind ?? s.driverKind;
  if (kind === 'simulator' || kind === 'wda') return 'ios';
  if (kind === 'direct') return 'android';
  if (!s.device) return undefined;
  return SIMULATOR_UDID_RE.test(s.device) ? 'ios' : 'android';
}

/** Has a smoke pass run in this session? Persisted signals only: the qa_test_this pipeline's
 *  `smoke_completed` milestone, or the launch_smoke note every smoke run records (qa_smoke too). */
function smokeRan(s: Session): boolean {
  return s.milestones?.smoke_completed != null || s.notes.some((n) => n.workflow === 'launch_smoke');
}

/** Latest time anything was exercised/observed (notes, findings, recorded actions). */
function lastActivityAt(s: Session): number {
  let t = 0;
  for (const n of s.notes) t = Math.max(t, n.at ?? 0);
  for (const f of s.findings) t = Math.max(t, f.at ?? 0);
  for (const a of s.recordedActions) t = Math.max(t, a.at ?? 0);
  return t;
}

/** Milestone keys stamped by the agent-layer tools so qa_status can tell a terminal job's
 *  recommended action was carried out (each overwritten with the latest time). */
export const BLOCKER_ANSWERED_MILESTONE = 'blocker_answered';
export const BLOCKER_EXPLAINED_MILESTONE = 'blocker_explained';

/** Latest time the user answered a needs_input question: a stored input or a
 *  qa_continue_from_blocker call (choices-only answers store no input). */
function lastAnsweredAt(s: Session): number {
  let t = s.milestones?.[BLOCKER_ANSWERED_MILESTONE] ?? 0;
  for (const i of s.inputs ?? []) t = Math.max(t, i.at ?? 0);
  return t;
}

/** The newest report artifact, if one exists. */
function latestReport(s: Session): { uri: string; createdAt: number } | undefined {
  return s.artifacts.filter((a) => a.kind === 'report' && /\/report\/report-/.test(a.uri)).sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** Deterministic "what next" given the session's observed state (optionally goal-aware).
 *  An explicit state ladder, evaluated top-down, the first matching state wins. Every rung keys
 *  on state its recommended tool CHANGES, so following the advice always advances the ladder:
 *    1. a job is running                   > qa_job_status (poll it)
 *    2. the last qa_test_this job ended    > its nextRecommendedAction (report / explain blocker /
 *       and nothing happened since            answer the needs_input question), but only until that
 *                                             action is observably done: a report newer than the job,
 *                                             an answer (stored input / resume call) newer than the job
 *                                             (> re-run the autopilot with it), or a qa_explain_blocker
 *                                             {sessionId} call newer than the job. Replaying a done
 *                                             action would loop, so the ladder moves on.
 *    3. no device bound                    > qa_test_this  (orchestrate setup)
 *    4. device but no app                  > qa_prepare_target (Android) / qa_prepare_ios_target (iOS sim)
 *    5. no smoke yet and nothing recorded  > qa_smoke (records the smoke milestone)
 *    6. findings, no report since          > qa_report
 *    7. clean run, actions, no assets yet  > qa_generate (make the run durable)
 *    8. no report since the last activity  > qa_report (wrap up)
 *    9. a fresh report exists              > qa_get_artifact (read it, done; TERMINAL: the only
 *                                             rung whose advice changes nothing, by design)
 *  Exported for unit tests (test/nextBestAction.test.ts, test/orchStatusLadder.test.ts). */
export function nextBestAction(s: Session, goal?: string): { tool: string; why: string; args: Record<string, unknown> } {
  const sid = s.id;
  // 1. A job is still running: poll it before anything else.
  const lastJob = [...s.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (lastJob?.status === 'running')
    return {
      tool: 'qa_job_status',
      why: `job ${lastJob.jobId} (${lastJob.kind}) is still running`,
      args: { sessionId: sid, jobId: lastJob.jobId },
    };
  // 2. The last autopilot job is terminal and nothing was exercised after it: its own
  //    nextRecommendedAction is authoritative (a finished run must not be re-smoked).
  const result = lastJob?.result as
    | { state?: string; failureCode?: string; nextRecommendedAction?: { tool: string; args?: Record<string, unknown>; why?: string } }
    | undefined;
  const jobEnd = lastJob ? (lastJob.endedAt ?? lastJob.startedAt) : 0;
  if (lastJob && result?.state && jobEnd >= lastActivityAt(s)) {
    const nra = result.nextRecommendedAction;
    const blocked = result.state === 'blocked' || result.state === 'unsafe';
    const explained = (s.milestones?.[BLOCKER_EXPLAINED_MILESTONE] ?? 0) > jobEnd;
    const answered = result.state === 'needs_input' && lastAnsweredAt(s) > jobEnd;
    const reportedSince = (latestReport(s)?.createdAt ?? 0) > jobEnd;
    if (blocked && !explained)
      return {
        tool: 'qa_explain_blocker',
        why: `last job ${lastJob.jobId} ended ${result.state} (${result.failureCode ?? 'UNKNOWN'}): explain the blocker and relay the fix`,
        args: { failureCode: result.failureCode ?? 'UNKNOWN', sessionId: sid },
      };
    // The question was answered (qa_continue_from_blocker stored the input): resume the autopilot
    // with it. Starting that job is the state change; replaying the resume call would loop.
    if (answered)
      return {
        tool: 'qa_test_this',
        why: `the needs_input question of job ${lastJob.jobId} was answered; re-run the autopilot with the answer`,
        args: { mode: 'execute', ...(recallTestThisIntent(s) as Record<string, unknown>), sessionId: sid, stopOnNeedsInput: false },
      };
    // A qa_report recommendation is satisfied by any report newer than the job.
    const satisfied = blocked || (nra?.tool === 'qa_report' && reportedSince);
    if (nra?.tool && !satisfied)
      return {
        tool: nra.tool,
        why:
          result.state === 'needs_input'
            ? `last job ${lastJob.jobId} is waiting on one question: ${nra.why ?? 'answer it and resume'}`
            : `last job ${lastJob.jobId} ${result.state}: ${nra.why ?? 'follow its recommendation'}; no further calls needed after that`,
        args: { ...(nra.args ?? {}) },
      };
  }
  // 3. No device bound: orchestrate setup end-to-end.
  if (!s.device)
    return {
      tool: 'qa_test_this',
      why: goal ? `no device/app prepared yet, run the autopilot for goal "${goal}"` : 'no device/app prepared yet, orchestrate setup',
      args: { sessionId: sid, mode: 'execute', ...(goal ? { goal } : {}) },
    };
  // 4. Device bound but no app launched: route to the platform's prepare tool (H9: after
  //    `qa_ios boot` the bound device is a simulator; the Android-only qa_prepare_target would fail).
  if (!s.appId)
    return sessionPlatform(s) === 'ios'
      ? {
          tool: 'qa_prepare_ios_target',
          why: 'iOS simulator bound but no app launched',
          args: { sessionId: sid, device: s.device },
        }
      : { tool: 'qa_prepare_target', why: 'device bound but no app launched', args: { sessionId: sid } };
  // 5. App is up but nothing has been exercised (a smoke pass is a milestone, not an action count).
  if (!smokeRan(s) && s.recordedActions.length === 0)
    return { tool: 'qa_smoke', why: 'app is up but nothing exercised yet, run a smoke pass', args: { sessionId: sid } };
  const report = latestReport(s);
  const reportFresh = !!report && report.createdAt >= lastActivityAt(s);
  // 6. Findings recorded: reporting them beats generating more assets.
  if (s.findings.length > 0 && !reportFresh)
    return { tool: 'qa_report', why: `${s.findings.length} finding(s) recorded, summarize with evidence`, args: { sessionId: sid } };
  // 7. Clean run with recorded actions but no durable asset yet: make the run reusable.
  if (s.findings.length === 0 && s.recordedActions.length > 0 && !hasGeneratedAssets(s))
    return {
      tool: 'qa_generate',
      why: 'actions recorded, turn the run into a durable POM suite',
      args: { sessionId: sid, target: 'suite' },
    };
  // 8. Wrap up with a report covering everything done so far.
  if (!reportFresh)
    return {
      tool: 'qa_report',
      why: hasGeneratedAssets(s)
        ? 'clean run and test assets already generated, wrap up and report'
        : 'smoke done, wrap up and report what was covered',
      args: { sessionId: sid },
    };
  // 9. Terminal: a report newer than any activity exists. Read it; nothing else to do.
  return {
    tool: 'qa_get_artifact',
    why: 'the run is reported. Read the report; no further Swipium calls are needed',
    args: { uri: report!.uri },
  };
}

/** Server `instructions` (MCP InitializeResult.instructions): the operating manual clients may put
 *  in the model's system prompt. Kept short on purpose; per-tool detail lives in tool descriptions
 *  and docs/tools.md; qa_status (no sessionId) returns the same rules plus capability groups. */
export const SERVER_INSTRUCTIONS = [
  'Swipium runs mobile QA on local Android Emulators and iOS Simulators (no physical devices).',
  'First call: qa_test_this {mode:"execute"} (optional goal like "release_gate"): it builds/finds the app, prepares a device, tests and reports as a background job, returning {sessionId, jobId} (often after requiresConsent).',
  `Then poll qa_job_status {sessionId, jobId, waitMs:${RECOMMENDED_JOB_WAIT_MS}} until status is not "running". result.state: completed | blocked | unsafe | needs_input, plus reportUri.`,
  '',
  'completed: read the report (qa_get_artifact {uri: reportUri}) and stop unless the user wants more.',
  'needs_input: relay exactly the one returned question to the user, then make the returned `resume` call (qa_continue_from_blocker) and follow its nextAction. Never invent questions.',
  'blocked / unsafe: relay failureCode, owner, what was tried and the fix (qa_explain_blocker). A build failure is not a test failure.',
  'Consent: with MCP elicitation the user is prompted directly. Otherwise show requiresConsent to the user and re-call with consentId + approve:true only after they agree. CONSENT_DECLINED / _CANCELLED / _REFUSED: nothing ran, do not retry without asking.',
  'Ask the user only on needs_input or consent; otherwise keep going.',
  '',
  'Project root: projectRoot arg > MCP roots > SWIPIUM_PROJECT_ROOT > CLAUDE_PROJECT_DIR > server cwd (if it has a project marker, not / or $HOME). On PROJECT_ROOT_UNRESOLVED pass an absolute projectRoot.',
  'iOS Simulator without WebDriverAgent is visual-only (BACKEND_UNSUPPORTED from qa_snapshot/qa_act): use qa_screenshot + qa_visual, or attach WDA via qa_wda.',
  'INVALID_ARGUMENT: unknown/bad args, nothing ran. STALE_CLIENT: outdated client, restart it.',
  'More: qa_status (no sessionId: these rules + tool groups; with sessionId: state + nextBestAction). Features: qa_app_map_read, then qa_test_feature. Low level: qa_start_session, qa_prepare_target, qa_snapshot, qa_act, qa_visual, qa_flow_run.',
].join('\n');

/** qa_status without a sessionId: first-call orientation (the operating rules + capability groups
 *  by name). Pure + deterministic so it is snapshot-testable. */
export function orientation(goal?: TestGoal) {
  return {
    orientation: true,
    swipiumVersion: SWIPIUM_VERSION,
    tools: TOOL_COUNT,
    prompts: PROMPT_COUNT,
    firstCall: {
      tool: 'qa_test_this',
      args: { mode: 'execute', ...(goal ? { goal } : {}) },
      note: 'Pass projectRoot="/abs/path" if the client exposes no workspace root. Usually returns requiresConsent first (boot/install/build); after approval it runs as a background job.',
    },
    polling: {
      tool: 'qa_job_status',
      args: { sessionId: '<from firstCall>', jobId: '<from firstCall>', waitMs: RECOMMENDED_JOB_WAIT_MS },
      until: 'status is no longer "running" (done | failed | cancelled; a cancelled job has no result)',
      terminalStates: ['completed', 'blocked', 'unsafe', 'needs_input'],
    },
    report: { tool: 'qa_get_artifact', args: { uri: '<reportUri from the terminal result>' } },
    goals: TEST_GOALS,
    rules: {
      needsInput:
        'Relay exactly the one returned question; make its `resume` call (qa_continue_from_blocker) with the answer, then follow nextAction.',
      blocker:
        'Relay failureCode, owner, what was tried, and the fix (qa_explain_blocker {failureCode, sessionId}). A build failure is not a test failure.',
      consent:
        'Clients with MCP elicitation prompt the user directly. Otherwise show requiresConsent to the user; re-call with consentId + approve:true only after they agree. CONSENT_DECLINED / CANCELLED / REFUSED: nothing ran, do not retry without asking.',
      stop: 'Ask the user only on needs_input or a consent request; otherwise continue. After a completed job, read the report and stop.',
      iosVisualOnly:
        'An iOS Simulator without WebDriverAgent is visual-only: use qa_screenshot + qa_visual, or attach WebDriverAgent via qa_wda.',
      appMap: 'Before feature testing, read the app map (qa_app_map_read / qa_app_map_query / qa_app_map_feature_scope).',
    },
    capabilityGroups: CAPABILITY_GROUPS.map((g) => ({ group: g.group, purpose: g.purpose, tools: [...g.tools] })),
    nextBestAction: {
      tool: 'qa_test_this',
      why: goal ? `no session yet, run the autopilot for goal "${goal}"` : 'no session yet, start the autopilot',
      args: { mode: 'execute', ...(goal ? { goal } : {}) },
    },
  };
}

export function registerAgentTools(server: McpServer, sessions: SessionStore): void {
  // ---- qa_status ----
  server.registerTool(
    'qa_status',
    {
      title: 'Status, orientation, and next step',
      description:
        'Without sessionId: first-call orientation: how to drive Swipium (first call, polling, stop rules) plus the tool groups. ' +
        'With sessionId: compact session state (device, app, budget left, counters, findings, last job, workarounds, readiness) and ' +
        'nextBestAction: the single next tool to call, with args and why. Pass goal to bias the recommendation. Cheap; call between steps.',
      inputSchema: {
        sessionId: z.string().optional().describe('Omit for orientation; pass to get that session state.'),
        goal: z
          .enum(TEST_GOALS as [TestGoal, ...TestGoal[]])
          .optional()
          .describe('Bias nextBestAction toward this autopilot goal.'),
      },
    },
    async ({ sessionId, goal }) => {
      if (!sessionId) {
        const o = orientation(goal);
        const summary =
          `Swipium v${o.swipiumVersion} (${o.tools} tools, ${o.prompts} prompts)\n` +
          `1. ${o.firstCall.tool} ${JSON.stringify(o.firstCall.args)}\n` +
          `2. ${o.polling.tool} {sessionId, jobId, waitMs} until status ≠ running; result.state ∈ {${o.polling.terminalStates.join(', ')}}\n` +
          `3. ${o.report.tool} { uri: reportUri }, then stop\n` +
          'requiresConsent > show it to the user; needs_input > ask the one returned question; otherwise continue.\n' +
          o.capabilityGroups.map((g) => `[${g.group}] ${g.tools.join(', ')}`).join('\n');
        return qaOk(o, summary);
      }
      const s = sessions.get(sessionId);
      if (!s)
        return unknownSessionError(sessionId, [
          'Call qa_status without sessionId for orientation, or qa_start_session / qa_test_this to create a session.',
        ]);
      const remaining = budgetRemaining(s);
      const lastJob = [...s.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
      const next = nextBestAction(s, goal);
      const status = {
        sessionId: s.id,
        root: s.root,
        device: s.device ?? null,
        appId: s.appId ?? null,
        mode: effectiveMode(s),
        budgetRemaining: remaining,
        counters: s.counters,
        recordedActions: s.recordedActions.length,
        findings: s.findings.length,
        notes: s.notes.length,
        workarounds: s.workarounds,
        inputsProvided: s.inputs.map((i) => i.varName),
        readiness: readinessForSession(s),
        lastJob: lastJob
          ? {
              jobId: lastJob.jobId,
              kind: lastJob.kind,
              status: lastJob.status,
              progress: lastJob.progress,
              progressDetail: lastJob.progressDetail ?? null,
            }
          : null,
        nextBestAction: next,
      };
      const progLine = progressLine(lastJob?.progressDetail);
      const summary =
        `session ${s.id}: ${s.device ?? 'no device'}${s.appId ? ` / ${s.appId}` : ''} (mode=${status.mode})\n` +
        `budget left: ${remaining.minutes}m / ${remaining.actions} actions / ${remaining.screenshots} shots\n` +
        `recorded=${s.recordedActions.length} findings=${s.findings.length} notes=${s.notes.length}` +
        (lastJob
          ? `\nlast job: ${lastJob.kind} [${lastJob.status}]${progLine ? `\n  ${progLine}` : lastJob.progress ? ` ${lastJob.progress}` : ''}`
          : '') +
        (s.workarounds.length ? `\nworkarounds: ${s.workarounds.length}` : '') +
        `\nnext: ${next.tool} ${JSON.stringify(next.args)} (${next.why})`;
      return qaOk(status, summary);
    },
  );

  // ---- qa_explain_blocker ----
  server.registerTool(
    'qa_explain_blocker',
    {
      title: 'Explain a blocker',
      description:
        'Explain a failureCode in plain language: what it means, who owns the fix (app / environment / Swipium / user), whether ' +
        'it is retry-safe or Swipium can fix it, and the recovery step.',
      inputSchema: {
        failureCode: z.string().describe('failureCode from a Swipium error.'),
        context: z.string().optional(),
        sessionId: z.string().optional().describe('The blocked session (qa_status then moves past the blocker).'),
      },
    },
    async ({ failureCode, context, sessionId }) => {
      const sess = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !sess) return unknownSessionError(sessionId);
      const code = failureCode as FailureCode;
      const info = FAILURES[code];
      if (!info) {
        return qaError({
          what: `Unknown failure code "${failureCode}"`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Pass a code surfaced by a Swipium tool (the `failureCode` field of an error).'],
        });
      }
      // Mark the blocker explained so qa_status's ladder stops recommending this call.
      if (sess) {
        sess.milestones[BLOCKER_EXPLAINED_MILESTONE] = Date.now();
        sessions.persist(sess);
      }
      const owner = failureOwner(code);
      const ownerText: Record<string, string> = {
        app: 'the app developer (fix the app)',
        environment: 'the dev environment (toolchain/device/build setup)',
        swipium: 'Swipium (it can often handle this automatically)',
        user: 'you (provide input/approval/test data)',
      };
      const explanation = {
        failureCode: code,
        bucket: info.bucket,
        owner,
        severity: info.severity,
        retrySafe: info.retrySafe,
        canSwipiumFix: isSelfFixable(code),
        whatItMeans: info.summary,
        whoFixesIt: ownerText[owner],
        howToFix: info.recovery,
        context: context ?? null,
      };
      const summary =
        `${code}: ${info.summary}\n` +
        `owner: ${ownerText[owner]}; retry-safe: ${info.retrySafe}; Swipium can fix: ${isSelfFixable(code)}\n` +
        `fix: ${info.recovery}`;
      return qaOk(explanation, summary);
    },
  );

  // ---- qa_continue_from_blocker ----
  server.registerTool(
    'qa_continue_from_blocker',
    {
      title: 'Resume after providing input',
      description:
        'Answer a needs_input question and get the next call. Secret values (passwords/OTP/tokens) join the redaction set at ' +
        'once and are never echoed or logged (flows reference them as ${VAR}); non-secret choices (platform, device, target, allowOutsideRoot) map onto ' +
        'the re-invocation args. Returns accepted, ignored[] (with how to apply), projectRoot for monorepo_target, and ' +
        'nextAction.',
      inputSchema: {
        sessionId: z.string(),
        kind: z.string().describe('The needs_input kind (e.g. credentials, monorepo_target).'),
        values: z
          .record(z.string(), z.union([z.string(), z.boolean()]))
          .optional()
          .describe('Field name > value. Secret fields are redacted on receipt.'),
        secretFields: z.array(z.string()).optional().describe('Secret keys (default: password/otp/token-like names).'),
      },
    },
    async ({ sessionId, kind, values, secretFields }) => {
      const s = sessions.get(sessionId);
      if (!s) return unknownSessionError(sessionId);
      const vals: Record<string, string | boolean> = { ...(values ?? {}) };
      // Shared secret-name rule (flows/schema.ts); `code` covers OTP fields named code / verificationCode.
      const secretRe = SECRET_VAR_NAME;
      // "test pre-login only" (the credentials question's own fallback) is a DECISION, not an input:
      // mark login out of scope for the session instead of reporting it as an unknown field.
      const declined = (kind === 'credentials' || kind === 'otp_or_manual_verification') && extractDecline(vals);
      if (declined) markLoginDeclined(sessions, s);
      const isSecret = (k: string) => secretFields?.includes(k) || secretRe.test(k);

      // Register inputs into the SECURE STORE (P0.5): each maps to a flow variable; secret values
      // join the redaction set and are NEVER echoed back. Generated flows reference the var name.
      const accepted: string[] = [];
      const storedVars: string[] = [];
      const choices: Record<string, string | boolean> = {};
      for (const [k, v] of Object.entries(vals)) {
        const secret = isSecret(k);
        if (typeof v === 'string' && (secret || /email|user|account|otp|code|token|pin/i.test(k))) {
          const varName = inputVarName(k);
          sessions.setInput(s, varName, v, secret, `needs_input:${kind}`);
          storedVars.push(varName);
          accepted.push(`${k} > \${${varName}}${secret ? ' (redacted)' : ''}`);
        } else {
          choices[k] = v;
        }
      }
      // H1: map non-secret choices onto args the re-invoked tool ACTUALLY accepts; anything it
      // doesn't consume is reported back as `ignored` (with how to apply it), never silently dropped.
      const mapped = mapBlockerChoices(kind, choices, s.root);
      if (mapped.error) {
        sessions.persist(s);
        return qaError({
          failureCode: 'INVALID_ARGUMENT',
          what: mapped.error,
          changedState: storedVars.length > 0,
          retrySafe: true,
          nextSteps: [
            'Re-call qa_continue_from_blocker with target set to one of the offered candidate paths (absolute, or relative to the project root).',
          ],
        });
      }
      for (const [k, v] of Object.entries(choices)) if (!mapped.ignored.some((i) => i.field === k)) accepted.push(`${k}=${v}`);
      if (mapped.projectRoot) {
        // qa_test_this resolves an existing session's root from the SESSION (projectRoot is only
        // read when creating one), so adopt the chosen app directory as the effective root; the
        // same thing the single-candidate discovery path does.
        s.root = mapped.projectRoot;
        s.chosenTarget = mapped.projectRoot; // qa_test_this skips the monorepo question for this root
      }
      // Persisted answer marker: qa_status stops replaying the resume call once answered.
      s.milestones[BLOCKER_ANSWERED_MILESTONE] = Date.now();
      sessions.persist(s);
      sessions.addWorkaround(s, `resumed from "${kind}" blocker with: ${accepted.join(', ') || '(no values)'}`);
      const reInvokeArgs: Record<string, unknown> = { sessionId: s.id, ...mapped.args };
      // Replay the ORIGINAL qa_test_this intent (goal/goalText/flags). A resume that drops it
      // silently downgrades e.g. release_gate to the default smoke.
      const intent = recallTestThisIntent(s) as Record<string, unknown>;

      // Decide the resume action by kind.
      const reInvokeKinds = new Set([
        'artifact_outside_root',
        'preferred_platform',
        'monorepo_target',
        'signing_team',
        'destructive_exploration_approval',
        'external_service_required',
      ]);
      // Every resume is a DIRECTLY executable call. Credentials/OTP are now registered as secure
      // inputs, so re-invoking the autopilot drives the authenticated flows with them (the macro
      // tool resolves the already-prepared session/device and continues), not a bare qa_act guess.
      const resume = declined
        ? {
            tool: 'qa_test_this',
            why:
              kind === 'credentials'
                ? 'login marked out of scope for this session. Continue with pre-login coverage only (authenticated flows are reported as blocked, not failed)'
                : 'verification marked out of scope; flows behind it are skipped and reported as blocked',
            args: { mode: 'execute', ...intent, sessionId: s.id, stopOnNeedsInput: false },
          }
        : kind === 'credentials' || kind === 'otp_or_manual_verification'
          ? {
              tool: 'qa_test_this',
              why: storedVars.length
                ? 'credentials registered (redacted). Re-run the autopilot to drive authenticated flows with them'
                : 'no credentials were provided. Re-run the autopilot (pre-login coverage)',
              args: { mode: 'execute', ...intent, sessionId: s.id, stopOnNeedsInput: false },
            }
          : kind === 'destructive_exploration_approval' && mapped.approveDestructive
            ? {
                // qa_test_this has no destructive switch; the supported path is qa_explore's
                // candidate-bound approval: discover candidates first, then approve one exactly.
                tool: 'qa_explore',
                why: 'destructive exploration approved. Discover exact destructive candidates first (dry run), then approve one with safeMode:"approved_destructive_candidate"',
                args: { sessionId: s.id, safeMode: 'dry_run_destructive' },
              }
            : reInvokeKinds.has(kind)
              ? {
                  tool: 'qa_test_this',
                  why: 're-run orchestration with your choice applied',
                  args: { mode: 'execute', ...intent, ...reInvokeArgs },
                }
              : { tool: 'qa_test_this', why: 'resume orchestration', args: { mode: 'execute', ...intent, ...reInvokeArgs } };

      return qaOk(
        {
          kind,
          accepted,
          ...(declined ? { loginOutOfScope: true } : {}),
          storedVariables: storedVars,
          ignored: mapped.ignored,
          ...(mapped.projectRoot ? { projectRoot: mapped.projectRoot } : {}),
          nextAction: resume,
          secretsRegistered: accepted.filter((a) => a.includes('redacted')).length,
        },
        (declined ? 'Login marked out of scope for this session. Testing continues pre-login only.\n' : '') +
          `Accepted ${accepted.length} field(s)${accepted.some((a) => a.includes('redacted')) ? ' (secrets redacted)' : ''}.` +
          (storedVars.length ? `\nstored for replay: ${storedVars.join(', ')}` : '') +
          (mapped.ignored.length ? `\nnot applied: ${mapped.ignored.map((i) => `${i.field} (${i.howToApply})`).join('; ')}` : '') +
          `\nnext: ${resume.tool} ${JSON.stringify(resume.args)} (${resume.why})`,
      );
    },
  );
}

/** The qa_test_this input keys a blocker resume may set (mirrors its zod schema in
 *  src/tools/testThis.ts; test/blockerResume.test.ts asserts they stay in lockstep). */
export const TEST_THIS_RESUME_KEYS = ['projectRoot', 'platform', 'device', 'allowOutsideRoot'] as const;

export interface BlockerChoiceMapping {
  /** Args for the re-invoked tool (only keys in TEST_THIS_RESUME_KEYS). */
  args: Record<string, unknown>;
  /** Choices the re-invoked tool does not consume, with how the user can apply them instead. */
  ignored: Array<{ field: string; value: string | boolean; howToApply: string }>;
  /** Resolved absolute app directory for a monorepo_target answer. */
  projectRoot?: string;
  approveDestructive?: boolean;
  /** Set when a choice is invalid (e.g. a monorepo target that does not exist). */
  error?: string;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

function truthy(v: string | boolean): boolean {
  return v === true || (typeof v === 'string' && /^(true|yes|1)$/i.test(v.trim()));
}

/** Map a NeedsInput answer's non-secret choices onto re-invocation args (H1). Pure except for the
 *  existence check on a monorepo target. Exported for tests. */
export function mapBlockerChoices(kind: string, choices: Record<string, string | boolean>, sessionRoot: string): BlockerChoiceMapping {
  const out: BlockerChoiceMapping = { args: {}, ignored: [] };
  const ignore = (field: string, value: string | boolean, howToApply: string) => out.ignored.push({ field, value, howToApply });
  for (const [k, v] of Object.entries(choices)) {
    switch (k) {
      case 'platform':
        if (v === 'android' || v === 'ios') out.args.platform = v;
        else ignore(k, v, 'platform must be "android" or "ios"');
        break;
      case 'allowOutsideRoot':
        out.args.allowOutsideRoot = truthy(v);
        break;
      case 'device':
        if (typeof v === 'string' && v.trim()) out.args.device = v.trim();
        else ignore(k, v, 'device must be a serial/UDID string');
        break;
      case 'target': {
        if (kind === 'monorepo_target') {
          // The monorepo question offers app DIRECTORIES. This is the project root, not a device.
          if (typeof v !== 'string' || !v.trim()) {
            out.error = 'monorepo target must be an app directory path';
            break;
          }
          const raw = v.trim();
          if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~' + sep)) {
            out.error = `monorepo target "${v}" must be one of the offered app directories inside the project root (no ~ paths)`;
            break;
          }
          const abs = isAbsolute(raw) ? resolvePath(raw) : resolvePath(sessionRoot, raw);
          let isDir = false;
          try {
            isDir = statSync(abs).isDirectory();
          } catch {
            isDir = false;
          }
          if (!isDir) {
            out.error = `monorepo target "${v}" is not an existing directory (resolved to ${abs})`;
            break;
          }
          // The offered candidates are always app directories discovered UNDER the project root
          // (findMobileApps), so containment in the (real) root is the constraint: an answer can
          // never re-point the session at `/`, the home dir, or an unrelated tree.
          const realRoot = realOrSelf(sessionRoot);
          const realTarget = realOrSelf(abs);
          if (realTarget !== realRoot && !realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
            out.error = `monorepo target "${v}" (${realTarget}) is outside the project root ${realRoot}; pick one of the offered app directories`;
            break;
          }
          out.projectRoot = abs;
          out.args.projectRoot = abs;
        } else if (typeof v === 'string' && v.trim()) {
          out.args.device = v.trim();
        } else {
          ignore(k, v, 'target must be a device serial/UDID string');
        }
        break;
      }
      case 'approveDestructive':
        out.approveDestructive = truthy(v);
        if (!out.approveDestructive) ignore(k, v, 'exploration stays non-destructive (the default)');
        break;
      case 'developmentTeam':
        ignore(
          k,
          v,
          'qa_test_this does not take a signing team. Set ios.wda.developmentTeam in .swipium/config.json (or DEVELOPMENT_TEAM in the server environment), then resume',
        );
        break;
      case 'provisioningProfile':
        ignore(
          k,
          v,
          'Swipium builds for the simulator and does not consume a provisioning profile. Configure it in Xcode if your scheme needs one',
        );
        break;
      case 'serviceEndpoint':
        ignore(
          k,
          v,
          'Swipium cannot route the app to a service endpoint. Configure it in the app build/env (e.g. a staging config), then resume',
        );
        break;
      default:
        ignore(k, v, `not an input qa_test_this accepts (accepted: ${TEST_THIS_RESUME_KEYS.join(', ')})`);
    }
  }
  return out;
}

const DECLINE_KEYS = /^(choice|fallback|fallbackOption|option|answer|decision|selected|preLoginOnly|decline|declined|skip)$/i;
const DECLINE_TEXT = /pre-?login only|stay pre-?login|decline|no credentials|skip (login|flows requiring verification)|^skip$/i;

/** Detect (and remove from `vals`) a "decline the input" answer: a fallback-option string such as
 *  "test pre-login only", or a boolean preLoginOnly/decline flag. Exported for tests. */
export function extractDecline(vals: Record<string, string | boolean>): boolean {
  let declined = false;
  for (const [k, v] of Object.entries(vals)) {
    if (!DECLINE_KEYS.test(k)) continue;
    if ((typeof v === 'boolean' && v && /preLoginOnly|decline|skip/i.test(k)) || (typeof v === 'string' && DECLINE_TEXT.test(v.trim()))) {
      declined = true;
      delete vals[k];
    }
  }
  return declined;
}

/** Map a NeedsInput field name to its canonical Swipium flow variable (P0.5). */
function inputVarName(field: string): string {
  const f = field.toLowerCase();
  if (/pass/.test(f)) return 'SWIPIUM_TEST_PASSWORD';
  if (/email|user|account/.test(f)) return 'SWIPIUM_TEST_EMAIL';
  if (/otp|code|2fa|mfa/.test(f)) return 'SWIPIUM_TEST_OTP';
  if (/token|api[_-]?key/.test(f)) return 'SWIPIUM_TEST_TOKEN';
  if (/pin/.test(f)) return 'SWIPIUM_TEST_PIN';
  return `SWIPIUM_${field.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}
