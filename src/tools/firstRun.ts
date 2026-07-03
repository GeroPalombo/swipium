// SWIPIUM-REQ-02 — first-run MCP tool (1.5.0 consolidation: the former plan/continue
// twins are one qa_first_run with a mode enum).
//   mode:"plan"      read-only: classify the current screen + return the safe plan (no acting).
//   mode:"continue"  execute one bounded step or a bounded first-run sequence (until-driven).
//
// These drive the pure planning layer (src/firstRun/*) and the bounded driver loop (firstRunRunner).
// Secrets (generated passwords) are added to the session redaction set and never appear in output;
// generated emails are recorded as evidence so a developer can reproduce the throwaway account.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, qaAnnotate } from '../lib/result.js';
import { qaNeedsInput, NeedsInput, type NeedsInputPayload } from '../lib/needsInput.js';
import { getDriver } from '../session/attach.js';
import { planFirstRun } from '../firstRun/firstRunPlanner.js';
import { observeScreen, resolveFirstRunPolicy, runFirstRun, type FirstRunMode } from '../firstRun/firstRunRunner.js';
import type { SessionStore } from '../session/store.js';

function needsInputPayload(kind: string, reason: string): NeedsInputPayload {
  if (kind === 'otp_or_manual_verification') return NeedsInput.otp(reason);
  if (kind === 'create_test_data') return NeedsInput.createTestData(reason);
  return NeedsInput.credentials(reason);
}

export function registerFirstRun(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_first_run',
    {
      title: 'First run: plan or continue through login/onboarding',
      description:
        'USE WHEN the app opens on a first-run gate (login / create-account / OTP / onboarding / permissions / paywall) and you need to get past it safely. mode:"plan" (default) is READ-ONLY: classify the current screen and return the safe plan without acting; mode:"continue" executes bounded first-run steps with safe generated test data where policy allows, and returns ONE NeedsInput question when it will not act (production-like environment, OTP/verification). Requires a prepared device (qa_test_this / qa_prepare_target first). Returns classification + confidence + evidence, actions taken (secrets redacted), resulting state, appMapPatch, evidence URIs, and the next recommended tool.',
      inputSchema: {
        sessionId: z.string(),
        mode: z
          .enum(['plan', 'continue'])
          .optional()
          .describe(
            'plan (default): READ-ONLY — classify the CURRENT screen (login/create-account/login-or-create/OTP/onboarding/permissions/paywall/home/feature/error) from the UI snapshot + visible text + app-map/code context, and return the safe plan: required inputs, planned actions, environment classification, and whether generated-account creation is allowed here; no taps, no typing, no secrets. continue: EXECUTE the plan like a practical QA engineer — in a TEST/STAGING environment it fills login/create-account forms with generated data (email swipium_<timestamp>@yopmail.com + a strong password stored as a secret), moves through onboarding via safe Next/Continue/Skip, records paywall coverage WITHOUT purchasing, and hands permission prompts to the guardrails; it refuses automatic account creation in unknown/production-like environments and stops with NeedsInput on OTP/verification. Bounded by `until`.',
          ),
        until: z
          .enum(['one_step', 'until_gate', 'until_home'])
          .optional()
          .describe(
            '(mode:"continue" only) How far to run: one_step (default) handles one screen; until_gate runs until a paywall/OTP/permission gate; until_home runs until home/feature.',
          ),
        allowGeneratedAccount: z
          .boolean()
          .optional()
          .describe('Override the policy decision on creating a throwaway account (true to allow, false to forbid).'),
        testDataPolicyPath: z.string().optional().describe('Path to a test-data policy JSON (default .swipium/test-data-policy.json).'),
        maxSteps: z.number().optional().describe('(mode:"continue" only) Hard cap on executed steps.'),
        maxDurationMs: z.number().optional().describe('(mode:"continue" only) Hard cap on execution time.'),
      },
    },
    async ({ sessionId, mode, until, allowGeneratedAccount, testDataPolicyPath, maxSteps, maxDurationMs }) => {
      const effectiveMode = mode ?? 'plan';
      const notes: string[] = [];

      const session = sessions.get(sessionId);
      if (!session)
        return qaError({
          what: `Unknown sessionId ${sessionId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session first.'],
        });
      const { driver } = await getDriver(session);
      if (!driver)
        return qaError({
          what: 'No device attached to this session',
          changedState: false,
          retrySafe: true,
          nextSteps: [
            `Prepare a device first: qa_test_this { mode:"execute" } or qa_prepare_target, then qa_first_run { mode:"${effectiveMode}" }.`,
          ],
        });

      // ---- mode:"plan" — read-only (merged twin, 1.5.0). ----
      if (effectiveMode === 'plan') {
        const ignored = [
          until !== undefined && 'until',
          maxSteps !== undefined && 'maxSteps',
          maxDurationMs !== undefined && 'maxDurationMs',
        ].filter((x): x is string => !!x);
        if (ignored.length)
          notes.push(`ignored parameter(s) not applicable to mode:"plan": ${ignored.join(', ')} — re-run with mode:"continue" to execute`);

        const { policy, policySource, environment, decision } = resolveFirstRunPolicy(session, {
          testDataPolicyPath,
          allowGeneratedAccount,
        });
        const obs = await observeScreen(sessions, session, driver);
        const plan = planFirstRun({ ...obs, screenSignature: obs.screenSignature, appError: obs.appError }, session, { policy, decision });

        const summary =
          `🔎 first-run plan — screen: ${plan.classification.purpose} (confidence ${plan.classification.confidence})\n` +
          `environment: ${environment.environment} (prodRisk=${environment.productionRisk}); generated account ${decision.allowed ? 'ALLOWED' : 'NOT allowed'} — ${decision.reason}\n` +
          `state: ${plan.state}${plan.pathTaken ? ` [${plan.pathTaken}]` : ''}; planned actions: ${plan.actions.length}` +
          (plan.needsInput ? `\n❓ ${plan.needsInput.reason}` : '') +
          `\n→ execute with qa_first_run { sessionId:"${session.id}", mode:"continue", until:"one_step" }`;

        return qaAnnotate(
          qaOk(
            {
              sessionId: session.id,
              classification: plan.classification,
              state: plan.state,
              pathTaken: plan.pathTaken,
              actions: plan.actions, // no raw values — secrets stay in the secure store
              expectedNextPurposes: plan.expectedNextPurposes,
              stopConditions: plan.stopConditions,
              appMapPatch: plan.mapUpdates,
              environment,
              generatedAccountDecision: decision,
              policySource,
              needsInput: plan.needsInput ?? null,
              nextRecommendedTool: plan.nextRecommendedTool ?? 'qa_first_run',
              evidence: obs.screenshotUri ? [obs.screenshotUri] : [],
            },
            summary,
          ),
          notes,
        );
      }

      // ---- mode:"continue" — execute (merged twin, 1.5.0). ----
      const res = await runFirstRun(sessions, session, driver, {
        mode: (until ?? 'one_step') as FirstRunMode,
        allowGeneratedAccount,
        testDataPolicyPath,
        maxSteps,
        maxDurationMs,
      });

      // Fix Group 5: fold first-run classifications into the durable app map (not just a detached
      // artifact) so a runtime login/onboarding/paywall screen updates .swipium/app-map.json.
      let appMapUri: string | undefined;
      if (res.mapUpdates.length) {
        try {
          const { buildAppMap } = await import('../appMap/build.js');
          const built = buildAppMap(session.root, {
            mode: 'runtime_merge',
            at: new Date().toISOString(),
            sessionId: session.id,
            firstRunPatches: res.mapUpdates,
            persist: true,
          });
          appMapUri = built.save?.resourceUri;
        } catch {
          /* best-effort: the forward-compatible artifact still carries the patches */
        }
      }

      const payload = {
        sessionId: session.id,
        state: res.state,
        stoppedReason: res.stoppedReason,
        steps: res.steps,
        classifications: res.steps.map((s) => ({
          purpose: s.purpose,
          confidence: s.confidence,
          state: s.state,
          screenSignature: s.screenSignature,
        })),
        environment: res.environment,
        generatedAccountDecision: res.decision,
        policySource: res.policySource,
        generatedVariables: res.generatedVariables, // secrets already redacted
        appMapPatch: res.mapUpdates,
        appMapArtifactUri: res.mapArtifactUri ?? null,
        appMapUri: appMapUri ?? null,
        evidence: res.evidenceUris,
        pathTaken: res.pathTaken,
        accountOutcome: res.accountOutcome,
        nextRecommendedTool: res.nextRecommendedTool ?? null,
        needsInput: res.needsInput ?? null,
      };

      const summary =
        `🚦 first-run ${res.state} — ${res.steps.length} screen(s); path: ${res.pathTaken}; account: ${res.accountOutcome}\n` +
        `environment: ${res.environment.environment} (prodRisk=${res.environment.productionRisk}); generated account ${res.decision.allowed ? 'allowed' : 'refused'}\n` +
        `reason: ${res.stoppedReason}` +
        (res.generatedVariables.length ? `\ngenerated: ${res.generatedVariables.map((g) => `${g.varName}=${g.value}`).join(', ')}` : '') +
        (res.mapArtifactUri ? `\napp-map: ${res.mapArtifactUri}` : '') +
        (res.nextRecommendedTool ? `\n→ next: ${res.nextRecommendedTool}` : '');

      // A genuine pause → surface the single NeedsInput question (not an error).
      if ((res.state === 'needs_input' || res.state === 'unsafe') && res.needsInput) {
        return qaNeedsInput(needsInputPayload(res.needsInput.kind, res.needsInput.reason), {
          sessionId: session.id,
          state: res.state,
          attempted: res.steps.map((s) => `classified "${s.purpose}" (confidence ${s.confidence})`),
          firstRun: payload,
        });
      }

      return qaOk(payload, summary);
    },
  );
}
