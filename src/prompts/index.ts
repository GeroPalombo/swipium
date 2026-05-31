// MCP prompts (PHASE3-PLAN §2.4 / §3.3) — the spec's third server capability (after tools +
// resources). Prompts are reusable workflow templates a prompt-capable client (e.g. Claude)
// can invoke by name, so common QA runs don't need a hand-written prompt each time.
//
// Design rules:
//  - Prompts are THIN: they only orchestrate tools that already exist. No privileged logic
//    lives here — consent stays server-side (security best-practices doc).
//  - Clients that don't support prompts lose nothing: every step is "call <tool>", which the
//    agent can do directly. Nothing is prompt-only.
//
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function userText(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'swipium_setup_check',
    {
      title: 'Check Swipium setup',
      description: 'Verify Swipium can test a project and report what (if anything) is blocking.',
      argsSchema: { projectRoot: z.string().optional().describe('Absolute path to the app project.') },
    },
    ({ projectRoot }) =>
      userText(
        `Check whether Swipium can test ${projectRoot ? `the project at ${projectRoot}` : 'this project'}.\n\n` +
          `1. Call qa_doctor to confirm the toolchain (adb/emulator/java) and that the client is not stale.\n` +
          `2. Call qa_start_session${projectRoot ? ` { projectRoot: "${projectRoot}" }` : ''}.\n` +
          `3. Call qa_detect_context, then qa_plan with the sessionId.\n` +
          `4. Summarize: is it READY, PARTIAL, or BLOCKED? List the exact missing items (APK, device, credentials) and the recommended budget profile. Do not start testing yet.`,
      ),
  );

  server.registerPrompt(
    'swipium_full_smoke',
    {
      title: 'Run a full smoke test',
      description: 'Plan, prepare, run the top ready workflows, and produce a report.',
      argsSchema: {
        projectRoot: z.string().optional(),
        appId: z.string().optional().describe('Override the auto-detected app id.'),
      },
    },
    ({ projectRoot, appId }) =>
      userText(
        `Run a full smoke test and produce a report a developer can act on.\n\n` +
          `1. qa_start_session${projectRoot ? ` { projectRoot: "${projectRoot}", ` : ' { '}profile: "full_smoke", responseMode: "compact" }.\n` +
          `2. qa_plan — pick the READY workflows; respect anything listed as UNSAFE.\n` +
          `3. qa_prepare_target${appId ? ` { appId: "${appId}" }` : ''} (approve consent for boot/install if prompted).\n` +
          `4. For each ready workflow: drive it with qa_snapshot/qa_act, checking qa_check_health after key steps. Use qa_clear_overlay if a keyboard/dialog/banner blocks a target.\n` +
          `5. Record each result with qa_note (pass/fail/blocked + category). For visual-only screens use qa_assert_visual.\n` +
          `6. qa_report at the end. Summarize release risk and the single most important next action.`,
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
          `1. qa_start_session${projectRoot ? ` { projectRoot: "${projectRoot}", ` : ' { '}profile: "login_smoke" }, then qa_plan.\n` +
          `2. qa_prepare_target, then navigate toward the reported bug with qa_snapshot/qa_act.\n` +
          `3. At the failure, call qa_check_health (capture native vs app classification) and qa_screenshot for evidence.\n` +
          `4. Record qa_note { outcome: "fail", category: "app_bug", reason, artifactUris } — or "blocked"/"not_applicable" if you could not reach it, with the precondition.\n` +
          `5. qa_report. Include exact reproduction steps and the evidence artifact URIs so the report stands alone without the transcript.`,
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
          `1. Write a flow YAML named "${name ?? 'my-flow'}" with: name, appId, budgetProfile, fixtures, and a steps list.\n` +
          `2. Use durable selectors: prefer text/id (e.g. tap: "Sign In") over @ref. Replace credentials with \${TEST_EMAIL}/\${TEST_PASSWORD} variables — never inline secrets.\n` +
          `   Available steps: prepareTarget, tap, tapAt, inputText, assertVisible, assertNotVisible, swipe, scrollTo, press, openUrl, wait.\n` +
          `3. Validate it with qa_flow_check { flowYaml: "<your yaml>" } and fix any reported errors.\n` +
          `4. Save it under .swipium/flows/${name ?? 'my-flow'}.yaml so qa_plan lists it and qa_flow_run can replay it.`,
      ),
  );
}
