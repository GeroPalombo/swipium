// MCP prompts: the spec's third server capability (after tools +
// resources). Prompts are reusable workflow templates a prompt-capable client (e.g. Claude)
// can invoke by name, so common QA runs don't need a hand-written prompt each time.
//
// Design rules:
//  - Prompts are THIN: they only orchestrate tools that already exist. No privileged logic
//    lives here. Consent stays server-side (security best-practices doc).
//  - Clients that don't support prompts lose nothing: every step is "call <tool>", which the
//    agent can do directly. Nothing is prompt-only.
//  - The shared guidance (loop, batching, credentials, app control) comes from the swipium-qa
//    skill (src/skills/content.ts), so prompts and the skill never disagree.
//
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { LOOP_STEPS, BATCHING, CREDENTIALS, APP_CONTROL } from '../skills/content.js';
import { isToolListed } from '../core/capabilityGroups.js';

/** The shared skill snippets name qa_flow_check and qa_network; under SWIPIUM_TOOLS=core those are
 *  hidden, so point at a listed tool instead. Read at prompt time (env can change in tests). */
function batching(): string {
  return isToolListed('qa_flow_check')
    ? BATCHING
    : BATCHING.replace(
        'with qa_flow_check.',
        'with qa_flow_run { mode: "plan", flowYaml } (qa_flow_check is hidden because SWIPIUM_TOOLS=core).',
      );
}
function appControl(): string {
  return isToolListed('qa_network') ? APP_CONTROL : APP_CONTROL.replace(' qa_network for offline checks;', '');
}

function userText(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** `{ a: "x", b: true }` for a prompt's exact first call (undefined values dropped). */
function args(o: Record<string, unknown>): string {
  const parts = Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

/** Step 1 (the exact first call) followed by the canonical autopilot loop. */
function loop(first: string): string {
  return [first, ...LOOP_STEPS].map((s, i) => `${i + 1}. ${s}`).join('\n');
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'swipium_setup_check',
    {
      title: 'Check Swipium setup',
      description: 'Verify Swipium can test a project and report what (if anything) is blocking. No side effects.',
      argsSchema: { projectRoot: z.string().optional().describe('Absolute path to the app project.') },
    },
    ({ projectRoot }) =>
      userText(
        `Check whether Swipium can test ${projectRoot ? `the project at ${projectRoot}` : 'this project'}. Do not start testing.\n\n` +
          `1. Call qa_test_this ${args({ mode: 'plan', projectRoot })}. It has no side effects: it finds or plans the app build, picks a device and returns the ordered plan or a typed blocker.\n` +
          `2. If it reports a toolchain problem, call qa_doctor for the details.\n` +
          `3. Summarize: will an execute run work as is? List the exact missing items (artifact or build, device, credentials) and the consent the run will ask for.\n\n` +
          CREDENTIALS,
      ),
  );

  server.registerPrompt(
    'swipium_guardrail_validation',
    {
      title: 'Validate safety guardrails',
      description: 'Confirm Swipium refuses an unsafe destructive action (bundle-loss) on a debug RN/Expo build (Android or iOS).',
      argsSchema: { projectRoot: z.string().optional() },
    },
    ({ projectRoot }) =>
      userText(
        `Validate Swipium's destructive-action guardrails (do NOT override them).\n\n` +
          `1. qa_start_session${projectRoot ? ` { projectRoot: "${projectRoot}", ` : ' { '}profile: "guardrail" }.\n` +
          `2. qa_resolve_target { sessionId, include: ["plan"] } and confirm fresh_start appears under UNSAFE with reason bundle_cache_loss for a debug RN/Expo build.\n` +
          `3. Get the app running (approve consent for boot/install if prompted): qa_prepare_target { sessionId } on an Android Emulator, ` +
          `or qa_prepare_ios_target { sessionId } on an iOS Simulator (it uses the project's simulator .app; pass app: "<path to .app>" if it reports launched:false). If it does not end with the app launched, stop and report the guardrail as NOT TESTED (not PASS).\n` +
          `4. Attempt qa_app_control { sessionId, action: "fresh_start" } WITHOUT acknowledgeBundleRisk. Expect a refusal (failureCode BUNDLE_LOSS_REFUSED), not execution.\n` +
          `5. qa_report { sessionId } and confirm destructiveGuardrail shows the action was refused, not executed. Report PASS only if it was refused on a launched app.`,
      ),
  );

  server.registerPrompt(
    'swipium_full_smoke',
    {
      title: 'Run a full smoke test',
      description: 'Run the autopilot smoke (build or find the app, prepare a device, test, report) and summarize it.',
      argsSchema: {
        projectRoot: z.string().optional(),
        platform: z.enum(['android', 'ios']).optional().describe('Force a platform (default inferred).'),
      },
    },
    ({ projectRoot, platform }) =>
      userText(
        `Run a smoke test of this app and produce a report a developer can act on.\n\n` +
          loop(`Call qa_test_this ${args({ mode: 'execute', goal: 'smoke', projectRoot, platform, waitForCompletion: true })}.`) +
          `\n\nThen summarize release risk and the single most important next action.\n\n` +
          CREDENTIALS,
      ),
  );

  server.registerPrompt(
    'swipium_bug_repro',
    {
      title: 'Reproduce and document a bug',
      description: 'Drive to a described bug, capture deterministic evidence, and file it as a structured outcome.',
      argsSchema: {
        bug: z.string().describe('What the bug is / how to reach it.'),
        projectRoot: z.string().optional(),
      },
    },
    ({ bug, projectRoot }) =>
      userText(
        `Reproduce and document this bug with evidence:\n"${bug}"\n\n` +
          loop(
            `Call qa_test_this ${args({ mode: 'execute', goal: 'reproduce_bug', goalText: bug, projectRoot, waitForCompletion: true })}.`,
          ) +
          `\n\nIf the report does not reach the bug, drive there yourself on the same sessionId: qa_snapshot to see the screen, then qa_act, ` +
          `or one qa_flow_run {sessionId, flowYaml} for the known steps. At the failure call qa_check_health {sessionId} and qa_screenshot {sessionId, reason}, ` +
          `record qa_note {sessionId, workflow, outcome:"fail", category:"app_bug", reason, artifactUris}, then qa_report {sessionId}. ` +
          `Include exact reproduction steps and the evidence URIs so the report stands alone.\n\n` +
          batching() +
          '\n\n' +
          appControl(),
      ),
  );

  server.registerPrompt(
    'swipium_test_feature',
    {
      title: 'Test one feature',
      description: 'Test a named feature end to end: scope, cases, a focused run, and a pass/fail/blocked report per case.',
      argsSchema: {
        feature: z.string().describe('The feature to test, in natural language (e.g. "checkout with a saved card").'),
        projectRoot: z.string().optional(),
      },
    },
    ({ feature, projectRoot }) =>
      userText(
        `Test this feature and report pass/fail/blocked per case with evidence:\n"${feature}"\n\n` +
          loop(`Call qa_test_feature ${args({ feature, mode: 'execute', projectRoot })} and note its sessionId and jobId.`) +
          `\n\nAuth, paywall or missing test data report blocked, not failed: say what the user must provide.\n\n` +
          batching() +
          '\n\n' +
          appControl() +
          '\n\n' +
          CREDENTIALS,
      ),
  );

  server.registerPrompt(
    'swipium_generate_suite',
    {
      title: 'Generate a test suite',
      description: 'Run the app, then turn the run into a durable test suite (.swipium/test-suite.json + POM suite) and lint it.',
      argsSchema: { projectRoot: z.string().optional() },
    },
    ({ projectRoot }) =>
      userText(
        `Create a durable automated test suite for this app.\n\n` +
          loop(`Call qa_test_this ${args({ mode: 'execute', goal: 'create_automation_suite', projectRoot, waitForCompletion: true })}.`) +
          (isToolListed('qa_suite_generate')
            ? `\n\nThen call qa_suite_generate {sessionId} to merge the cases into .swipium/test-suite.json and qa_suite_lint {sessionId} for brittle locators. `
            : // SWIPIUM_TOOLS=core hides the test-suite tools: never point at a tool the client cannot call.
              `\n\nThen call qa_generate {sessionId, target: "suite", save: true} to write the suite (qa_suite_generate / qa_suite_lint are hidden because SWIPIUM_TOOLS=core; SWIPIUM_TOOLS=all enables them). `) +
          `Summarize what the suite covers, the coverage gaps it reports, and how to re-run it (qa_flow_run on the generated flows; \`npx swipium suite lint\` in CI).`,
      ),
  );

  server.registerPrompt(
    'swipium_convert_run_to_flow',
    {
      title: 'Convert a run into a reusable flow',
      description: 'Draft a repeatable .swipium/flows/*.yaml from the steps you just performed, then validate it.',
      argsSchema: { name: z.string().optional().describe('Flow name, e.g. login-smoke.') },
    },
    ({ name }) =>
      userText(
        `Turn the workflow you just ran into a repeatable Swipium flow.\n\n` +
          `1. Call qa_generate { sessionId, target: "flow", name: "${name ?? 'my-flow'}" } to draft the flow YAML from the recorded actions (or write it by hand with: name, appId, budgetProfile, fixtures, and a steps list).\n` +
          `2. Use durable selectors: prefer text/id (e.g. tap: "Sign In") over @ref. Replace credentials with \${SWIPIUM_TEST_EMAIL}/\${SWIPIUM_TEST_PASSWORD} variables. Never inline secrets.\n` +
          `   Common steps: prepareTarget, tap, tapAt, inputText, assertVisible, assertNotVisible, swipe, scrollTo, press, openUrl, wait, clearOverlay (full list: docs/flows.md#step-reference).\n` +
          `3. Validate it with ${isToolListed('qa_flow_check') ? 'qa_flow_check { flowYaml: "<your yaml>" }' : 'qa_flow_run { mode: "plan", flowYaml: "<your yaml>" }'} and fix any reported errors (qa_generate also reports a durability grade + brittle steps).\n` +
          `4. Save it under .swipium/flows/${name ?? 'my-flow'}.yaml (qa_generate save:true does this) so the workflow plan lists it and qa_flow_run can replay it.`,
      ),
  );
}
