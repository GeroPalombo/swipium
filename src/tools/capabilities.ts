import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk } from '../lib/result.js';
import { SWIPIUM_VERSION, TOOL_COUNT } from '../version.js';
import type { SessionStore } from '../session/store.js';

export interface CapabilityGroup {
  group: string;
  purpose: string;
  tools: Array<{ name: string; summary: string }>;
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    group: 'start',
    purpose: 'Start a simulator QA run and recover from blockers.',
    tools: [
      { name: 'qa_agent_brief', summary: 'Brief for agent orchestration: first call, polling, report fetch, and blocker rules.' },
      { name: 'qa_capabilities', summary: 'Grouped overview of the public v1 tool surface.' },
      { name: 'qa_test_this', summary: 'Autopilot for "test it": resolve, prepare, smoke, explore, report, and optional suite output.' },
      { name: 'qa_job_status', summary: 'Poll long-running jobs started by macro tools.' },
      { name: 'qa_status', summary: 'Compact session status and current next action.' },
      { name: 'qa_explain_blocker', summary: 'Explain a typed blocker and the owner of the fix.' },
      { name: 'qa_continue_from_blocker', summary: 'Resume after user input, with secret redaction.' },
      { name: 'qa_get_artifact', summary: 'Fetch Swipium artifact metadata or contents by URI.' },
    ],
  },
  {
    group: 'setup',
    purpose: 'Resolve the project, create a session, and prepare Android Emulator or iOS Simulator targets.',
    tools: [
      { name: 'qa_doctor', summary: 'Check local toolchain readiness.' },
      { name: 'qa_start_session', summary: 'Open a project session with budget and response mode.' },
      { name: 'qa_detect_context', summary: 'Detect project framework, artifacts, devices, and blockers.' },
      { name: 'qa_plan', summary: 'Propose safe workflows before acting.' },
      { name: 'qa_prepare_target', summary: 'Prepare Android Emulator target and launch an APK.' },
      { name: 'qa_prepare_ios_target', summary: 'Prepare iOS Simulator target and launch a simulator .app.' },
      { name: 'qa_ios', summary: 'iOS Simulator operations: boot, install, launch, screenshot, logs, and reset.' },
      { name: 'qa_wda', summary: 'WebDriverAgent attach/build/start for structured iOS Simulator automation.' },
    ],
  },
  {
    group: 'drive',
    purpose: 'Observe, act, and make deterministic health assertions.',
    tools: [
      { name: 'qa_snapshot', summary: 'Capture compact structured UI elements.' },
      { name: 'qa_act', summary: 'Tap, type, clear, swipe, scroll, press, open URL, or wait, then observe.' },
      { name: 'qa_clear_overlay', summary: 'Dismiss common overlays blocking a target.' },
      { name: 'qa_check_health', summary: 'Detect crash, ANR, error boundaries, and foreground health.' },
      { name: 'qa_screenshot', summary: 'Capture a screenshot artifact.' },
      { name: 'qa_note', summary: 'Record a structured QA outcome.' },
      { name: 'qa_assert_visual', summary: 'Capture a visual assertion with evidence.' },
    ],
  },
  {
    group: 'run',
    purpose: 'Run smoke checks, exploration, and reports.',
    tools: [
      { name: 'qa_smoke', summary: 'Run launch smoke and saved flows.' },
      { name: 'qa_explore', summary: 'Guided simulator exploration with evidence and graph output.' },
      { name: 'qa_report', summary: 'Summarize findings, blockers, evidence, and next actions.' },
    ],
  },
  {
    group: 'app-map',
    purpose: 'Maintain the app knowledge map used as Swipium project memory.',
    tools: [
      { name: 'qa_app_map_build', summary: 'Build or update the app map from static analysis and exploration.' },
      { name: 'qa_app_map_read', summary: 'Read compact app map sections.' },
      { name: 'qa_app_map_query', summary: 'Search screens, features, tests, and code links.' },
      { name: 'qa_app_map_feature_scope', summary: 'Resolve a feature query to a focused test scope.' },
      { name: 'qa_app_map_validate', summary: 'Validate schema, provenance, and map links.' },
    ],
  },
  {
    group: 'flows',
    purpose: 'Create and run durable simulator flows and test suites.',
    tools: [
      { name: 'qa_flow_check', summary: 'Parse and statically validate a Swipium flow.' },
      { name: 'qa_flow_run', summary: 'Execute a flow against a prepared simulator session.' },
      { name: 'qa_flow_generate', summary: 'Generate a flow from recorded actions.' },
      { name: 'qa_suite_generate', summary: 'Generate a POM-style suite from recorded actions.' },
      { name: 'qa_suite_compile', summary: 'Compile a generated suite into runnable flows.' },
      { name: 'qa_testcase_generate', summary: 'Generate test case documentation from recorded behavior.' },
    ],
  },
  {
    group: 'first-run',
    purpose: 'Handle login, account creation, onboarding, and paywall first-run screens safely.',
    tools: [
      { name: 'qa_first_run_plan', summary: 'Classify the current first-run screen and produce a safe plan.' },
      { name: 'qa_first_run_continue', summary: 'Execute bounded first-run steps with safe generated test data when allowed.' },
    ],
  },
  {
    group: 'automation',
    purpose: 'Generate Appium automation code from Swipium evidence on request.',
    tools: [
      { name: 'qa_automation_plan', summary: 'Plan generated JS/TS or Python Appium automation.' },
      { name: 'qa_automation_generate', summary: 'Generate an Appium POM suite from recorded actions.' },
      { name: 'qa_automation_validate', summary: 'Validate generated automation code without a device.' },
    ],
  },
];

const groupNames = CAPABILITY_GROUPS.map((g) => g.group) as [string, ...string[]];

export function registerCapabilities(server: McpServer, _sessions: SessionStore): void {
  server.registerTool(
    'qa_capabilities',
    {
      title: 'List Swipium capabilities',
      description: 'Return the public Swipium v1 tools grouped by purpose with short summaries.',
      inputSchema: {
        group: z.enum(groupNames).optional().describe('Return only this group.'),
      },
    },
    async ({ group }) => {
      const groups = group ? CAPABILITY_GROUPS.filter((g) => g.group === group) : CAPABILITY_GROUPS;
      const summary =
        `Swipium v${SWIPIUM_VERSION}: ${TOOL_COUNT} public v1 tools in ${CAPABILITY_GROUPS.length} groups.\n` +
        groups
          .map((g) => `\n[${g.group}] ${g.purpose}\n` + g.tools.map((t) => `  - ${t.name}: ${t.summary}`).join('\n'))
          .join('\n') +
        '\n\nStart with qa_test_this for low-context "test it" requests.';
      return qaOk({ swipiumVersion: SWIPIUM_VERSION, totalTools: TOOL_COUNT, groups }, summary);
    },
  );
}
