// The swipium-qa agent skill: one source for the shipped skills/swipium-qa/SKILL.md (and its
// copy in plugin/skills), the MCP resource skill://swipium-qa/SKILL.md, the MCP prompts
// (src/prompts/index.ts) and `swipium init claude|codex`, which installs it.
// test/guidanceSkill.test.ts fails when a SKILL.md file drifts from SKILL_MD
// (SWIPIUM_UPDATE_SKILL=1 npx vitest run test/guidanceSkill.test.ts rewrites them).

import { RECOMMENDED_JOB_WAIT_MS } from '../tools/jobs.js';

export const SKILL_NAME = 'swipium-qa';

export const SKILL_DESCRIPTION =
  'Test a mobile app (React Native, Expo, Flutter, native Android or iOS) on a local Android Emulator or iOS Simulator ' +
  'with the Swipium MCP server, for smoke tests, bug reproduction, feature checks, release gates and generated test suites. ' +
  'Use when the user asks to test, QA, smoke test, verify or reproduce a bug in a mobile app.';

/** The canonical autopilot loop (prompts splice it in after their own first call). */
export const LOOP_STEPS = [
  `If the result says state:"running", poll qa_job_status {sessionId, jobId, waitMs:${RECOMMENDED_JOB_WAIT_MS}} until status is not "running".`,
  'completed: read report.md (qa_get_artifact on the report URI in nextRecommendedAction), then stop unless the user wants more.',
  'needs_input: relay exactly the one returned question, then make the returned `resume` call (qa_continue_from_blocker). It starts the resumed job itself when no new consent is needed; poll that jobId.',
  'blocked / unsafe: relay failureCode, owner and the fix the result carries (nextRecommendedAction). A build failure is not a test failure.',
  'requiresConsent: with MCP elicitation the user is asked directly. Otherwise show it to the user and re-call with consentId + approve:true only after they agree. CONSENT_DECLINED / _CANCELLED / _REFUSED: nothing ran, do not retry without asking.',
];

export const BATCHING =
  'Batch known steps: when you already know 3 or more steps (tap, type, assert), run them in one qa_flow_run ' +
  '{sessionId, flowYaml} call instead of one qa_act per step. Example flowYaml:\n\n' +
  '```yaml\n' +
  'name: add_item\n' +
  'steps:\n' +
  '  - tap: "Add"\n' +
  '  - inputText: { into: "Title", text: "Milk" }\n' +
  '  - tap: "Save"\n' +
  '  - assertVisible: "Milk"\n' +
  '```\n\n' +
  'Use qa_snapshot + qa_act only to explore an unknown screen. Validate a flow you want to keep with qa_flow_check.';

export const CREDENTIALS =
  'Credentials: the best path is SWIPIUM_TEST_EMAIL and SWIPIUM_TEST_PASSWORD (plus SWIPIUM_TEST_OTP when needed) in ' +
  'the MCP server environment, so no secret passes through the chat. Flows reference them as ${SWIPIUM_TEST_EMAIL}. ' +
  'If the user types them in answer to a needs_input question, pass them to qa_continue_from_blocker (redacted at ' +
  'once, never echoed). Never write secrets into flow files.';

export const APP_CONTROL =
  'Setup and verification shortcuts (prefer these over raw adb or simctl): qa_app_control {action: "restart"} for ' +
  'persistence checks, "clear_data" / "fresh_start" for a clean state (consent-gated; RN/Expo also need ' +
  'acknowledgeBundleRisk), "background" / "foreground"; qa_act {action:"open_url", url} (or a flow `openUrl` step) to ' +
  'jump straight to a screen via a deep link; qa_network for offline checks; qa_clear_overlay for a keyboard, dialog ' +
  'or banner in the way.';

export const CI_CLI =
  'CI and terminal (no MCP session needed): `npx swipium scan` (inspect the project, scaffold .swipium/), ' +
  '`npx swipium suite lint|compile` (audit or compile the generated suite into flows), `npx swipium verify` (server ' +
  'self-check), `npx swipium report --latest --format junit|sarif|github-summary|markdown [--fail-on-gate]` (export ' +
  'the last report).';

export const SKILL_MD = `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

# Swipium QA

Swipium is an MCP server that tests mobile apps on local Android Emulators and iOS Simulators (no physical devices). It finds or builds the app, prepares a device, drives it, and writes a report with evidence.

## The loop

1. Call \`qa_test_this {waitForCompletion:true}\` (mode defaults to "execute"). Add \`goal\` when the user asks for something specific: \`smoke\` (fastest), \`release_gate\`, \`test_login\`, \`explore\`, \`create_automation_suite\`, or \`reproduce_bug\` with \`goalText\`. Pass \`projectRoot:"/abs/path"\` when the client exposes no workspace root.
${LOOP_STEPS.map((s, i) => `${i + 2}. ${s}`).join('\n')}

Ask the user only on needs_input or consent; otherwise keep going. \`qa_status {sessionId}\` returns the single next call when you are unsure.

## One feature or one bug

- One feature: \`qa_test_feature {feature:"<name>", mode:"execute"}\`, then the same loop.
- One bug: \`qa_test_this {goal:"reproduce_bug", goalText:"<steps and symptom>", waitForCompletion:true}\`. Record what you find with \`qa_note\` and attach evidence (\`qa_screenshot\`).

## Batching

${BATCHING}

## Credentials

${CREDENTIALS}

## App control

${APP_CONTROL}

## iOS without WebDriverAgent

An iOS Simulator without WebDriverAgent is visual-only (BACKEND_UNSUPPORTED from qa_snapshot/qa_act): use qa_screenshot + qa_visual, or attach WebDriverAgent with qa_wda.

## Making the run durable

After a clean run, \`qa_generate {sessionId, target:"flow"}\` drafts a replayable .swipium/flows/*.yaml and \`qa_suite_generate {sessionId}\` merges test cases into .swipium/test-suite.json.

With \`SWIPIUM_TOOLS=core\`, qa_flow_check, qa_network, qa_suite_generate and qa_suite_lint are hidden; they need \`SWIPIUM_TOOLS=all\` (the default).

## CI

${CI_CLI}
`;
