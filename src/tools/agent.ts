// Agent-efficiency layer. Compact, deterministic helpers so an MCP client spends fewer turns:
// a one-glance session status, a blocker explainer, and a resume-from-blocker entry that consumes
// user-provided input safely.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { FAILURES, failureOwner, isSelfFixable, type FailureCode } from '../oracle/failures.js';
import { progressLine } from '../session/progress.js';
import { readinessForSession } from '../report/readiness.js';
import { SWIPIUM_VERSION, TOOL_COUNT, PROMPT_COUNT } from '../version.js';
import { TEST_GOALS } from '../orchestration/goal.js';
import type { Session, SessionStore } from '../session/store.js';

function budgetRemaining(s: Session): { minutes: number; actions: number; screenshots: number } {
  const elapsedMin = (Date.now() - s.createdAt) / 60000;
  return {
    minutes: Math.max(0, Math.round((s.budget.maxMinutes - elapsedMin) * 10) / 10),
    actions: Math.max(0, s.budget.maxActions - s.counters.actions),
    screenshots: Math.max(0, s.budget.maxScreenshots - s.counters.screenshots),
  };
}

/** Deterministic "what next" given the session's observed state (optionally goal-aware). */
function nextBestAction(s: Session, goal?: string): { tool: string; why: string; args: Record<string, unknown> } {
  const sid = s.id;
  const lastJob = [...s.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (lastJob?.status === 'running') return { tool: 'qa_job_status', why: `job ${lastJob.jobId} (${lastJob.kind}) is still running`, args: { sessionId: sid, jobId: lastJob.jobId } };
  if (!s.device) return { tool: 'qa_test_this', why: goal ? `no device/app prepared yet — run the autopilot for goal "${goal}"` : 'no device/app prepared yet — orchestrate setup', args: { sessionId: sid, mode: 'execute', ...(goal ? { goal } : {}) } };
  if (!s.appId) return { tool: 'qa_prepare_target', why: 'device bound but no app launched', args: { sessionId: sid } };
  if (s.recordedActions.length === 0) return { tool: 'qa_smoke', why: 'app is up but nothing exercised yet — run a smoke pass', args: { sessionId: sid } };
  if (s.findings.length > 0) return { tool: 'qa_report', why: `${s.findings.length} finding(s) recorded — summarize with evidence`, args: { sessionId: sid } };
  if (s.recordedActions.length > 0) return { tool: 'qa_suite_generate', why: 'actions recorded — turn the run into a durable POM suite', args: { sessionId: sid } };
  return { tool: 'qa_report', why: 'wrap up and report', args: { sessionId: sid } };
}

/** The compact, current-version instruction set for coding agents (Milestone A). Pure + deterministic
 *  so it is snapshot-testable; it references the live SWIPIUM_VERSION / tool / prompt counts. */
export function agentBrief() {
  return {
    version: SWIPIUM_VERSION,
    tools: TOOL_COUNT,
    prompts: PROMPT_COUNT,
    purpose: 'Turn a coding agent into a mobile QA tester. For a zero-context "test this" request, call the macro tool first.',
    firstCall: {
      tool: 'qa_test_this',
      args: { mode: 'execute' },
      note: 'Pass projectRoot if the client did not expose a workspace root. mode:"execute" runs the whole path as a background job.',
    },
    polling: {
      tool: 'qa_job_status',
      args: { sessionId: '<from firstCall>', jobId: '<from firstCall>' },
      terminalStates: ['completed', 'blocked', 'unsafe', 'needs_input'],
    },
    report: {
      tool: 'qa_get_artifact',
      args: { uri: '<reportUri from the terminal result>' },
      rule: 'Fetch reportUri instead of calling more tools, unless nextRecommendedAction says otherwise.',
    },
    goals: TEST_GOALS,
    needsInputRule: 'Relay exactly the one returned question (with its fields/secret flags). Do not invent extra questions. Resume with the response\'s `resume` call.',
    blockerRule: 'Relay failureCode, owner, what Swipium tried (attempted/workaroundsAttempted), and how to fix it. A build failure is not a test failure.',
    stopRule: 'Stop and ask the user only on a needs_input state (credentials, monorepo target, destructive approval, signing, external service). Otherwise continue without user input.',
    continueRule: 'For completed/blocked/unsafe states, summarize from the structured envelope and the report — no extra Swipium calls are required.',
    mapRule: 'Before feature-focused testing, consult the durable App Knowledge Map: qa_app_map_read, qa_app_map_query, or qa_app_map_feature_scope to reuse what Swipium already learned instead of rediscovering the app. qa_test_this and qa_explore update the map automatically.',
    macroTools: ['qa_test_this', 'qa_smoke', 'qa_explore', 'qa_report', 'qa_app_map_read'],
    escapeHatches: ['qa_doctor', 'qa_start_session', 'qa_detect_context', 'qa_plan', 'qa_prepare_target', 'qa_prepare_ios_target', 'qa_ios', 'qa_wda', 'qa_act', 'qa_snapshot'],
  };
}

export function registerAgentTools(server: McpServer, sessions: SessionStore): void {
  // ---- qa_agent_brief ----
  server.registerTool(
    'qa_agent_brief',
    {
      title: 'Agent brief (how to drive Swipium)',
      description:
        'Read-only, cheap, deterministic. Returns the current-version instruction set for coding agents: the first call for low-context QA (qa_test_this), the polling + report-fetch flow, the NeedsInput/blocker rules, when to stop vs. continue, and which tools are macros vs. low-level escape hatches. Call this once at the start instead of inspecting the source tree.',
      inputSchema: {},
    },
    async () => {
      const b = agentBrief();
      const summary =
        `Swipium v${b.version} (${b.tools} tools, ${b.prompts} prompts) — agent brief\n` +
        `1. ${b.firstCall.tool} ${JSON.stringify(b.firstCall.args)}\n` +
        `2. ${b.polling.tool} until state ∈ {${b.polling.terminalStates.join(', ')}}\n` +
        `3. ${b.report.tool} { uri: reportUri }\n` +
        'needs_input -> ask the one returned question; otherwise continue.';
      return qaOk(b, summary);
    },
  );

  // ---- qa_status ----
  server.registerTool(
    'qa_status',
    {
      title: 'Session status (compact)',
      description: 'A concise snapshot of a session for an agent: project root/framework, bound device + app, budget remaining, counters, recorded actions, findings/notes, last job, and the safe fallbacks taken (workarounds). Read-only, cheap — call between steps instead of re-deriving state.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const s = sessions.get(sessionId);
      if (!s) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
      const remaining = budgetRemaining(s);
      const lastJob = [...s.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
      const next = nextBestAction(s);
      const status = {
        sessionId: s.id, root: s.root, device: s.device ?? null, appId: s.appId ?? null, mode: s.mode,
        budgetRemaining: remaining, counters: s.counters,
        recordedActions: s.recordedActions.length, findings: s.findings.length, notes: s.notes.length,
        workarounds: s.workarounds, inputsProvided: s.inputs.map((i) => i.varName),
        readiness: readinessForSession(s),
        lastJob: lastJob ? { jobId: lastJob.jobId, kind: lastJob.kind, status: lastJob.status, progress: lastJob.progress, progressDetail: lastJob.progressDetail ?? null } : null,
        nextBestAction: next,
      };
      const progLine = progressLine(lastJob?.progressDetail);
      const summary =
        `session ${s.id} — ${s.device ?? 'no device'}${s.appId ? ` / ${s.appId}` : ''} (mode=${s.mode})\n` +
        `budget left: ${remaining.minutes}m / ${remaining.actions} actions / ${remaining.screenshots} shots\n` +
        `recorded=${s.recordedActions.length} findings=${s.findings.length} notes=${s.notes.length}` +
        (lastJob ? `\nlast job: ${lastJob.kind} [${lastJob.status}]${progLine ? `\n  ${progLine}` : lastJob.progress ? ` ${lastJob.progress}` : ''}` : '') +
        (s.workarounds.length ? `\nworkarounds: ${s.workarounds.length}` : '') +
        `\n→ next: ${next.tool} — ${next.why}`;
      return qaOk(status, summary);
    },
  );

  // ---- qa_explain_blocker ----
  server.registerTool(
    'qa_explain_blocker',
    {
      title: 'Explain a blocker',
      description: 'Turn a typed failure code (e.g. AAB_NEEDS_BUNDLETOOL, WDA_SIGNING_FAILED, NO_BUILD_ARTIFACT) into a user-friendly explanation: what it means, who owns the fix (app / environment / Swipium / user), whether it is retry-safe, whether Swipium can fix it itself, and the exact recovery step. Use to relay a blocker to the user in plain language.',
      inputSchema: {
        failureCode: z.string().describe('A Swipium failure code (from a tool that returned isError with failureCode).'),
        context: z.string().optional(),
      },
    },
    async ({ failureCode, context }) => {
      const code = failureCode as FailureCode;
      const info = FAILURES[code];
      if (!info) {
        return qaError({ what: `Unknown failure code "${failureCode}"`, changedState: false, retrySafe: true, nextSteps: ['Pass a code surfaced by a Swipium tool (the `failureCode` field of an error).'] });
      }
      const owner = failureOwner(code);
      const ownerText: Record<string, string> = {
        app: 'the app developer (fix the app)',
        environment: 'the dev environment (toolchain/device/build setup)',
        swipium: 'Swipium (it can often handle this automatically)',
        user: 'you (provide input/approval/test data)',
      };
      const explanation = {
        failureCode: code, bucket: info.bucket, owner, severity: info.severity,
        retrySafe: info.retrySafe, canSwipiumFix: isSelfFixable(code),
        whatItMeans: info.summary, whoFixesIt: ownerText[owner], howToFix: info.recovery,
        context: context ?? null,
      };
      const summary =
        `${code} — ${info.summary}\n` +
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
      description: 'Consume user-provided input for a NeedsInput question and return the next action. Secret values (passwords/OTP/tokens) are added to the session redaction set immediately (never stored in plaintext, never logged). Non-secret choices (platform, allowOutsideRoot, target) are echoed back as the args to re-invoke qa_test_this / qa_prepare_target with.',
      inputSchema: {
        sessionId: z.string(),
        kind: z.string().describe('The NeedsInput kind being answered (e.g. credentials, preferred_platform, artifact_outside_root).'),
        values: z.record(z.union([z.string(), z.boolean()])).optional().describe('Field name → value. Secret fields are redacted on receipt.'),
        secretFields: z.array(z.string()).optional().describe('Which value keys are secret (default: password/otp/token-like names).'),
      },
    },
    async ({ sessionId, kind, values, secretFields }) => {
      const s = sessions.get(sessionId);
      if (!s) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
      const vals = values ?? {};
      const secretRe = /pass|secret|token|otp|pin|cvv|key/i;
      const isSecret = (k: string) => (secretFields?.includes(k)) || secretRe.test(k);

      // Register inputs into the SECURE STORE (P0.5): each maps to a flow variable; secret values
      // join the redaction set and are NEVER echoed back. Generated flows reference the var name.
      const accepted: string[] = [];
      const storedVars: string[] = [];
      const reInvokeArgs: Record<string, unknown> = { sessionId: s.id };
      for (const [k, v] of Object.entries(vals)) {
        const secret = isSecret(k);
        if (typeof v === 'string' && (secret || /email|user|account|otp|code|token|pin/i.test(k))) {
          const varName = inputVarName(k);
          sessions.setInput(s, varName, v, secret, `needs_input:${kind}`);
          storedVars.push(varName);
          accepted.push(`${k} → \${${varName}}${secret ? ' (redacted)' : ''}`);
        } else {
          accepted.push(`${k}=${v}`);
          if (k === 'platform') reInvokeArgs.platform = v;
          if (k === 'allowOutsideRoot') reInvokeArgs.allowOutsideRoot = v;
          if (k === 'target' || k === 'device') reInvokeArgs.device = v;
          if (k === 'developmentTeam' || k === 'provisioningProfile' || k === 'serviceEndpoint') reInvokeArgs[k] = v;
        }
      }
      sessions.persist(s);
      sessions.addWorkaround(s, `resumed from "${kind}" blocker with: ${accepted.join(', ') || '(no values)'}`);

      // Decide the resume action by kind.
      const reInvokeKinds = new Set([
        'artifact_outside_root', 'preferred_platform', 'monorepo_target',
        'signing_team',
        'destructive_exploration_approval', 'external_service_required',
      ]);
      // Every resume is a DIRECTLY executable call. Credentials/OTP are now registered as secure
      // inputs, so re-invoking the autopilot drives the authenticated flows with them (the macro
      // tool resolves the already-prepared session/device and continues) — no bare qa_act guess.
      const resume =
        kind === 'credentials' || kind === 'otp_or_manual_verification'
          ? { tool: 'qa_test_this', why: 'credentials registered (redacted) — re-run the autopilot to drive authenticated flows with them', args: { sessionId: s.id, mode: 'execute', stopOnNeedsInput: false } }
          : reInvokeKinds.has(kind)
            ? { tool: 'qa_test_this', why: 're-run orchestration with your choice applied', args: { mode: 'execute', ...reInvokeArgs } }
            : { tool: 'qa_test_this', why: 'resume orchestration', args: { mode: 'execute', ...reInvokeArgs } };

      return qaOk(
        { kind, accepted, storedVariables: storedVars, nextAction: resume, secretsRegistered: accepted.filter((a) => a.includes('redacted')).length },
        `Accepted ${accepted.length} field(s)${accepted.some((a) => a.includes('redacted')) ? ' (secrets redacted)' : ''}.` +
          (storedVars.length ? `\nstored for replay: ${storedVars.join(', ')}` : '') +
          `\n→ next: ${resume.tool} ${JSON.stringify(resume.args)} — ${resume.why}`,
      );
    },
  );
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
