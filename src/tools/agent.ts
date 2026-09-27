// Agent-efficiency layer. Compact, deterministic helpers so an MCP client spends fewer turns:
// the server instructions, a one-glance status (orientation without a session; state + next best
// action with one), a blocker explainer, and a resume-from-blocker entry that consumes
// user-provided input safely.

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { FAILURES, failureOwner, isSelfFixable, type FailureCode } from '../oracle/failures.js';
import { progressLine } from '../session/progress.js';
import { readinessForSession } from '../report/readiness.js';
import { SWIPIUM_VERSION, TOOL_COUNT, PROMPT_COUNT } from '../version.js';
import { TEST_GOALS, type TestGoal } from '../orchestration/goal.js';
import { CAPABILITY_GROUPS } from '../core/capabilityGroups.js';
import type { Session, SessionStore } from '../session/store.js';

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
export function effectiveMode(s: Pick<Session, 'mode' | 'driver'>): Session['mode'] | 'visual-only' {
  return s.driver?.kind === 'simulator' ? 'visual-only' : s.mode;
}

const SIMULATOR_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** Which platform the session's bound device is on. The live driver kind is authoritative
 *  (simctl/WDA ⇒ iOS); a rehydrated session has no driver, so fall back to the device id shape —
 *  iOS simulators are UUIDs, adb serials never are. */
export function sessionPlatform(s: Pick<Session, 'device' | 'driver'>): 'android' | 'ios' | undefined {
  const kind = s.driver?.kind;
  if (kind === 'simulator' || kind === 'wda') return 'ios';
  if (kind === 'direct') return 'android';
  if (!s.device) return undefined;
  return SIMULATOR_UDID_RE.test(s.device) ? 'ios' : 'android';
}

/** Deterministic "what next" given the session's observed state (optionally goal-aware).
 *  An explicit state ladder — evaluated top-down, the first matching state wins:
 *    1. a job is running          → qa_job_status (poll it)
 *    2. no device bound           → qa_test_this  (orchestrate setup)
 *    3. device but no app         → qa_prepare_target (Android) / qa_prepare_ios_target (iOS sim)
 *    4. nothing exercised yet     → qa_smoke
 *    5. findings recorded         → qa_report (summarize with evidence)
 *    6. clean run, no assets yet  → qa_generate (make the run durable)
 *    7. clean run + assets exist  → qa_report (terminal: wrap up)
 *  Exported for unit tests (test/nextBestAction.test.ts). */
export function nextBestAction(s: Session, goal?: string): { tool: string; why: string; args: Record<string, unknown> } {
  const sid = s.id;
  // 1. A job is still running — poll it before anything else.
  const lastJob = [...s.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (lastJob?.status === 'running')
    return {
      tool: 'qa_job_status',
      why: `job ${lastJob.jobId} (${lastJob.kind}) is still running`,
      args: { sessionId: sid, jobId: lastJob.jobId },
    };
  // 2. No device bound — orchestrate setup end-to-end.
  if (!s.device)
    return {
      tool: 'qa_test_this',
      why: goal ? `no device/app prepared yet — run the autopilot for goal "${goal}"` : 'no device/app prepared yet — orchestrate setup',
      args: { sessionId: sid, mode: 'execute', ...(goal ? { goal } : {}) },
    };
  // 3. Device bound but no app launched — route to the platform's prepare tool (H9: after
  //    `qa_ios boot` the bound device is a simulator; the Android-only qa_prepare_target would fail).
  if (!s.appId)
    return sessionPlatform(s) === 'ios'
      ? {
          tool: 'qa_prepare_ios_target',
          why: 'iOS simulator bound but no app launched',
          args: { sessionId: sid, device: s.device },
        }
      : { tool: 'qa_prepare_target', why: 'device bound but no app launched', args: { sessionId: sid } };
  // 4. App is up but nothing has been exercised.
  if (s.recordedActions.length === 0)
    return { tool: 'qa_smoke', why: 'app is up but nothing exercised yet — run a smoke pass', args: { sessionId: sid } };
  // 5. Findings recorded — reporting them beats generating more assets.
  if (s.findings.length > 0)
    return { tool: 'qa_report', why: `${s.findings.length} finding(s) recorded — summarize with evidence`, args: { sessionId: sid } };
  // 6. Clean run with recorded actions but no durable asset yet — make the run reusable.
  if (!hasGeneratedAssets(s))
    return {
      tool: 'qa_generate',
      why: 'actions recorded — turn the run into a durable POM suite',
      args: { sessionId: sid, target: 'suite' },
    };
  // 7. Terminal: clean run and the suite already generated — wrap up.
  return { tool: 'qa_report', why: 'clean run and test assets already generated — wrap up and report', args: { sessionId: sid } };
}

/** Server `instructions` (MCP InitializeResult.instructions): the operating manual clients may put
 *  in the model's system prompt. Kept short on purpose — per-tool detail lives in tool descriptions
 *  and docs/tools.md; qa_status (no sessionId) returns the same rules plus capability groups. */
export const SERVER_INSTRUCTIONS = [
  'Swipium runs mobile QA on local Android Emulators and iOS Simulators (physical devices are out of scope).',
  '',
  'First call: qa_test_this {mode:"execute"} (add goal, e.g. "explore" or "release_gate"). It resolves the project, finds or builds an app, prepares a simulator, tests, and reports as a background job.',
  'Polling: qa_job_status {sessionId, jobId, waitMs:60000} until status is no longer "running". The job result carries state: completed | blocked | unsafe | needs_input, plus reportUri. Then read the report with qa_get_artifact {uri: reportUri}; make no further Swipium calls unless nextRecommendedAction asks for one.',
  'Orientation: qa_status without sessionId returns these rules and the tool groups; with sessionId it returns session state and nextBestAction (pass goal to bias it).',
  '',
  'needs_input: relay exactly the one returned question (fields, secret flags) to the user, then make the returned `resume` call (qa_continue_from_blocker) with their answer and follow its nextAction. Never invent extra questions.',
  'blocked / unsafe: relay failureCode, owner, what Swipium tried, and the fix (qa_explain_blocker {failureCode}). A build failure is not a test failure.',
  'Stop and ask the user only on needs_input (credentials, monorepo target, destructive approval, signing, external service) or a consent request; otherwise keep going.',
  'Consent: a result with requiresConsent must be shown to the user; re-call with consentId + approve:true only after they agree. CONSENT_DECLINED / CONSENT_CANCELLED / CONSENT_REFUSED mean nothing ran - do not retry without asking.',
  '',
  'Project root: projectRoot arg, else MCP roots, else SWIPIUM_PROJECT_ROOT, else CLAUDE_PROJECT_DIR, else the server cwd (never / or $HOME). On PROJECT_ROOT_UNRESOLVED pass an absolute projectRoot.',
  'Feature work: read the app map first (qa_app_map_read / qa_app_map_query / qa_app_map_feature_scope); qa_test_feature tests one feature.',
  'Low-level tools (qa_start_session, qa_prepare_target / qa_prepare_ios_target, qa_snapshot, qa_act, qa_visual, qa_flow_run) are escape hatches when the autopilot is not enough.',
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
      note: 'Pass projectRoot="/abs/path" if the client exposes no workspace root. Runs as a background job.',
    },
    polling: {
      tool: 'qa_job_status',
      args: { sessionId: '<from firstCall>', jobId: '<from firstCall>', waitMs: 60000 },
      terminalStates: ['completed', 'blocked', 'unsafe', 'needs_input'],
    },
    report: { tool: 'qa_get_artifact', args: { uri: '<reportUri from the terminal result>' } },
    goals: TEST_GOALS,
    rules: {
      needsInput:
        'Relay exactly the one returned question; make its `resume` call (qa_continue_from_blocker) with the answer, then follow nextAction.',
      blocker: 'Relay failureCode, owner, what was tried, and the fix (qa_explain_blocker). A build failure is not a test failure.',
      stop: 'Ask the user only on needs_input or a consent request; otherwise continue.',
      appMap: 'Before feature testing, read the app map (qa_app_map_read / qa_app_map_query / qa_app_map_feature_scope).',
    },
    capabilityGroups: CAPABILITY_GROUPS.map((g) => ({ group: g.group, purpose: g.purpose, tools: [...g.tools] })),
    nextBestAction: {
      tool: 'qa_test_this',
      why: goal ? `no session yet — run the autopilot for goal "${goal}"` : 'no session yet — start the autopilot',
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
        'Without sessionId: first-call orientation — how to drive Swipium (first call, polling, stop rules) plus the tool groups. ' +
        'With sessionId: compact session state (device, app, budget left, counters, findings, last job, workarounds, readiness) and ' +
        'nextBestAction — the single next tool to call, with args and why. Pass goal to bias the recommendation. Cheap; call between steps.',
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
          `2. ${o.polling.tool} {sessionId, jobId, waitMs} until state ∈ {${o.polling.terminalStates.join(', ')}}\n` +
          `3. ${o.report.tool} { uri: reportUri }\n` +
          'needs_input → ask the one returned question; otherwise continue.\n' +
          o.capabilityGroups.map((g) => `[${g.group}] ${g.tools.join(', ')}`).join('\n');
        return qaOk(o, summary);
      }
      const s = sessions.get(sessionId);
      if (!s)
        return qaError({
          what: `Unknown sessionId ${sessionId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_status without sessionId for orientation, or qa_start_session / qa_test_this to create a session.'],
        });
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
        `session ${s.id} — ${s.device ?? 'no device'}${s.appId ? ` / ${s.appId}` : ''} (mode=${status.mode})\n` +
        `budget left: ${remaining.minutes}m / ${remaining.actions} actions / ${remaining.screenshots} shots\n` +
        `recorded=${s.recordedActions.length} findings=${s.findings.length} notes=${s.notes.length}` +
        (lastJob
          ? `\nlast job: ${lastJob.kind} [${lastJob.status}]${progLine ? `\n  ${progLine}` : lastJob.progress ? ` ${lastJob.progress}` : ''}`
          : '') +
        (s.workarounds.length ? `\nworkarounds: ${s.workarounds.length}` : '') +
        `\n→ next: ${next.tool} ${JSON.stringify(next.args)} — ${next.why}`;
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
      },
    },
    async ({ failureCode, context }) => {
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
      description:
        'Answer a needs_input question and get the next call. Secret values (passwords/OTP/tokens) join the redaction set at ' +
        'once and are never echoed or logged (flows reference them as ${VAR}); non-secret choices (platform, device, target, allowOutsideRoot) map onto ' +
        'the re-invocation args. Returns accepted, ignored[] (with how to apply), projectRoot for monorepo_target, and ' +
        'nextAction.',
      inputSchema: {
        sessionId: z.string(),
        kind: z.string().describe('The needs_input kind (e.g. credentials, monorepo_target).'),
        values: z
          .record(z.union([z.string(), z.boolean()]))
          .optional()
          .describe('Field name → value. Secret fields are redacted on receipt.'),
        secretFields: z.array(z.string()).optional().describe('Secret keys (default: password/otp/token-like names).'),
      },
    },
    async ({ sessionId, kind, values, secretFields }) => {
      const s = sessions.get(sessionId);
      if (!s)
        return qaError({
          what: `Unknown sessionId ${sessionId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session first.'],
        });
      const vals = values ?? {};
      const secretRe = /pass|secret|token|otp|pin|cvv|key/i;
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
          accepted.push(`${k} → \${${varName}}${secret ? ' (redacted)' : ''}`);
        } else {
          choices[k] = v;
        }
      }
      // H1: map non-secret choices onto args the re-invoked tool ACTUALLY accepts; anything it
      // doesn't consume is reported back as `ignored` (with how to apply it) — never silently dropped.
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
        // read when creating one), so adopt the chosen app directory as the effective root — the
        // same thing the single-candidate discovery path does.
        s.root = mapped.projectRoot;
        s.chosenTarget = mapped.projectRoot; // qa_test_this skips the monorepo question for this root
      }
      sessions.persist(s);
      sessions.addWorkaround(s, `resumed from "${kind}" blocker with: ${accepted.join(', ') || '(no values)'}`);
      const reInvokeArgs: Record<string, unknown> = { sessionId: s.id, ...mapped.args };

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
      // tool resolves the already-prepared session/device and continues) — no bare qa_act guess.
      const resume =
        kind === 'credentials' || kind === 'otp_or_manual_verification'
          ? {
              tool: 'qa_test_this',
              why: 'credentials registered (redacted) — re-run the autopilot to drive authenticated flows with them',
              args: { sessionId: s.id, mode: 'execute', stopOnNeedsInput: false },
            }
          : kind === 'destructive_exploration_approval' && mapped.approveDestructive
            ? {
                // qa_test_this has no destructive switch; the supported path is qa_explore's
                // candidate-bound approval: discover candidates first, then approve one exactly.
                tool: 'qa_explore',
                why: 'destructive exploration approved — discover exact destructive candidates first (dry run), then approve one with safeMode:"approved_destructive_candidate"',
                args: { sessionId: s.id, safeMode: 'dry_run_destructive' },
              }
            : reInvokeKinds.has(kind)
              ? { tool: 'qa_test_this', why: 're-run orchestration with your choice applied', args: { mode: 'execute', ...reInvokeArgs } }
              : { tool: 'qa_test_this', why: 'resume orchestration', args: { mode: 'execute', ...reInvokeArgs } };

      return qaOk(
        {
          kind,
          accepted,
          storedVariables: storedVars,
          ignored: mapped.ignored,
          ...(mapped.projectRoot ? { projectRoot: mapped.projectRoot } : {}),
          nextAction: resume,
          secretsRegistered: accepted.filter((a) => a.includes('redacted')).length,
        },
        `Accepted ${accepted.length} field(s)${accepted.some((a) => a.includes('redacted')) ? ' (secrets redacted)' : ''}.` +
          (storedVars.length ? `\nstored for replay: ${storedVars.join(', ')}` : '') +
          (mapped.ignored.length ? `\nnot applied: ${mapped.ignored.map((i) => `${i.field} (${i.howToApply})`).join('; ')}` : '') +
          `\n→ next: ${resume.tool} ${JSON.stringify(resume.args)} — ${resume.why}`,
      );
    },
  );
}

/** The qa_test_this input keys a blocker resume may set (mirrors its zod schema in
 *  src/tools/testThis.ts — test/blockerResume.test.ts asserts they stay in lockstep). */
export const TEST_THIS_RESUME_KEYS = ['projectRoot', 'platform', 'device', 'allowOutsideRoot'] as const;

export interface BlockerChoiceMapping {
  /** Args for the re-invoked tool — only keys in TEST_THIS_RESUME_KEYS. */
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
          // The monorepo question offers app DIRECTORIES — this is the project root, not a device.
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
            out.error = `monorepo target "${v}" (${realTarget}) is outside the project root ${realRoot} — pick one of the offered app directories`;
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
          'qa_test_this does not take a signing team — set ios.wda.developmentTeam in .swipium/config.json (or DEVELOPMENT_TEAM in the server environment), then resume',
        );
        break;
      case 'provisioningProfile':
        ignore(
          k,
          v,
          'Swipium builds for the simulator and does not consume a provisioning profile — configure it in Xcode if your scheme needs one',
        );
        break;
      case 'serviceEndpoint':
        ignore(
          k,
          v,
          'Swipium cannot route the app to a service endpoint — configure it in the app build/env (e.g. a staging config), then resume',
        );
        break;
      default:
        ignore(k, v, `not an input qa_test_this accepts (accepted: ${TEST_THIS_RESUME_KEYS.join(', ')})`);
    }
  }
  return out;
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
