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
      { name: 'qa_capabilities', summary: 'Grouped overview of the public tool surface.' },
      { name: 'qa_test_this', summary: 'Autopilot for "test it": resolve, prepare, smoke, explore, report, and optional suite output.' },
      { name: 'qa_job_status', summary: 'Poll long-running jobs started by macro tools.' },
      { name: 'qa_job_cancel', summary: 'Cancel a running job; aborts spawned children.' },
      { name: 'qa_status', summary: 'Compact session status and current next action.' },
      { name: 'qa_explain_blocker', summary: 'Explain a typed blocker and the owner of the fix.' },
      { name: 'qa_continue_from_blocker', summary: 'Resume after user input, with secret redaction.' },
      { name: 'qa_next_best_action', summary: 'Deterministic recommendation of the single best next tool to call, and why.' },
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
    group: 'build',
    purpose: 'Resolve a device and an installable artifact, or build one from source locally.',
    tools: [
      { name: 'qa_resolve_target', summary: 'Pick the best device/simulator (online > boot; honors platform/device).' },
      { name: 'qa_resolve_artifact', summary: 'Find the best installable .apk/.aab/.ipa/.app and explain where it looked.' },
      { name: 'qa_build_plan', summary: 'Propose exact build commands per framework/platform (side-effect free).' },
      { name: 'qa_build', summary: 'Build from source (consent-gated job); captures a log and re-resolves the artifact.' },
      { name: 'qa_bundletool', summary: 'Convert an .aab to an installable APK (universal or device-specific set).' },
    ],
  },
  {
    group: 'device',
    purpose: 'Inspect and control the device/app environment without raw adb or simctl.',
    tools: [
      { name: 'qa_device_info', summary: 'Model/SDK/ABIs/locale/screen/orientation + installed apps (read-only).' },
      { name: 'qa_permissions', summary: 'list / grant / revoke runtime permissions (revoke consent-gated).' },
      { name: 'qa_orientation', summary: 'Set portrait / landscape / auto (logged).' },
      { name: 'qa_geolocation', summary: 'Spoof GPS location (emulator; consent-gated) for map/location apps.' },
      { name: 'qa_network', summary: 'airplane-mode status/offline/online/restore (consent-gated; auto-restored).' },
      { name: 'qa_metro', summary: 'RN/Expo Metro status/start/stop/diagnose (RedBox detection + logcat).' },
      { name: 'qa_app_control', summary: 'launch/foreground/background/force_stop/restart/clear_data/fresh_start.' },
      { name: 'qa_screen_info', summary: 'Screen w/h/density, orientation, mode, counters, coordinate landmarks.' },
      { name: 'qa_screen_record', summary: 'Record a screen video to an mp4 artifact (start/stop; consent-gated).' },
    ],
  },
  {
    group: 'drive',
    purpose: 'Observe, act, and make deterministic health assertions.',
    tools: [
      { name: 'qa_snapshot', summary: 'Capture compact structured UI elements.' },
      { name: 'qa_inspect', summary: 'Return the full attributes of a single @eN element from the latest snapshot.' },
      { name: 'qa_act', summary: 'Tap, type, clear, swipe, scroll, press, open URL, or wait, then observe.' },
      { name: 'qa_clear_overlay', summary: 'Dismiss common overlays blocking a target.' },
      { name: 'qa_check_health', summary: 'Detect crash, ANR, error boundaries, and foreground health.' },
      { name: 'qa_screenshot', summary: 'Capture a screenshot artifact.' },
      { name: 'qa_note', summary: 'Record a structured QA outcome.' },
      { name: 'qa_assert_visual', summary: 'Capture a visual assertion with evidence.' },
      { name: 'qa_visual', summary: 'Local visual ops: baseline / diff (regression) / find_image (tappable coords) / ocr (optional).' },
      { name: 'qa_visual_find_text', summary: 'OCR text locator with structured regions + coordinate-space conversion.' },
      { name: 'qa_locator_suggest', summary: "Score each element's locator durability and grade automation readiness (which controls need testIDs)." },
      { name: 'qa_input_capabilities', summary: 'Backend text-entry limits: ASCII, Unicode, clipboard, WDA typing frequency.' },
      { name: 'qa_wait', summary: 'Non-shell wait for device_online / metro_ready / job_done.' },
      { name: 'qa_idling_status', summary: 'Read app-declared idling hooks or label-heuristic settling before automation.' },
    ],
  },
  {
    group: 'state',
    purpose: 'Create and verify reproducible preconditions instead of reporting them as missing.',
    tools: [
      { name: 'qa_seed', summary: 'Create a declared precondition via a fixture seed (deeplink/script/api; consent-gated).' },
      { name: 'qa_state_prepare', summary: 'Prepare a reproducible state profile: reset, launch, seed, verify ledger.' },
      { name: 'qa_state_verify', summary: 'Verify a state profile without treating setup drift as an app bug.' },
      { name: 'qa_state_teardown', summary: 'Run state-profile teardown and restore declared environment state.' },
    ],
  },
  {
    group: 'run',
    purpose: 'Run smoke checks, exploration, and reports.',
    tools: [
      { name: 'qa_smoke', summary: 'Run launch smoke and saved flows.' },
      { name: 'qa_explore', summary: 'Guided simulator exploration with evidence and graph output.' },
      { name: 'qa_report', summary: 'Summarize findings, blockers, evidence, and next actions.' },
      { name: 'qa_report_compare', summary: 'Compare current report.json against a baseline report.json.' },
      { name: 'qa_run_history', summary: 'Summarize local run history, pass rate, failures, flaky flows, and confidence calibration.' },
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
      { name: 'qa_app_map_update', summary: 'Targeted provenance-tracked map updates: note, test cases, automation suite, environment, coverage.' },
      { name: 'qa_app_map_diff', summary: 'Diff two app-map snapshots: screen/coverage/locator/test changes and new untested code.' },
      { name: 'qa_app_map_validate', summary: 'Validate schema, provenance, and map links.' },
    ],
  },
  {
    group: 'feature',
    purpose: 'Test a specific feature by name, backed by the app knowledge map.',
    tools: [
      { name: 'qa_feature_scope', summary: 'Map a natural-language feature to code/screens/routes/runtime/tests + objective + strategy (read-only).' },
      { name: 'qa_feature_test_plan', summary: 'Feature test plan: scope + objective + generated cases + fixtures + automation readiness (read-only).' },
      { name: 'qa_test_feature', summary: 'Focused feature test: scope, targeted exploration toward the feature, record cases, update the map and report.' },
    ],
  },
  {
    group: 'flows',
    purpose: 'Create, plan, run, and repair durable simulator flows and POM suites.',
    tools: [
      { name: 'qa_flow_check', summary: 'Parse and statically validate a Swipium flow.' },
      { name: 'qa_flow_plan', summary: 'Plan a flow against backend capabilities without executing it.' },
      { name: 'qa_flow_run', summary: 'Execute a flow against a prepared simulator session.' },
      { name: 'qa_flow_generate', summary: 'Generate a flow from recorded actions.' },
      { name: 'qa_flow_repair', summary: 'Suggest or patch a stronger locator for a failed flow step from the current screen.' },
      { name: 'qa_suite_generate', summary: 'Generate a POM-style suite from recorded actions.' },
      { name: 'qa_suite_compile', summary: 'Compile a generated suite into runnable flows.' },
      { name: 'qa_suite_lint', summary: 'Lint generated page objects for brittle/coordinate-only/dynamic locators.' },
      { name: 'qa_pom_generate', summary: 'Generate page objects and a locator audit from recorded actions.' },
      { name: 'qa_testcase_generate', summary: 'Generate test case documentation from recorded behavior.' },
    ],
  },
  {
    group: 'test-suite',
    purpose: 'Grow and maintain a canonical, persistent test suite across runs (.swipium/test-suite.json).',
    tools: [
      { name: 'qa_test_suite_read', summary: 'Read the canonical suite: filter by functionality/status; summary/json/markdown.' },
      { name: 'qa_test_suite_update', summary: 'Merge cases into the persistent suite (dedupe by feature+objective+steps).' },
      { name: 'qa_test_suite_generate', summary: 'Generate or refresh canonical cases from a recorded run and exploration.' },
      { name: 'qa_test_suite_export', summary: 'Export the persistent suite to markdown, yaml dir, json, or junit.' },
      { name: 'qa_test_suite_lint', summary: 'Validate the suite: missing expected/actual, stale map links, duplicate ids.' },
    ],
  },
  {
    group: 'interop',
    purpose: 'Exchange flows with the Maestro ecosystem.',
    tools: [
      { name: 'qa_maestro_import', summary: 'Import supported Maestro YAML commands into Swipium Flow V2.' },
      { name: 'qa_maestro_export', summary: 'Export Swipium Flow V2 to Maestro YAML with portability grades.' },
    ],
  },
  {
    group: 'issues',
    purpose: 'Durable issue memory and executable mobile-QA audit profiles.',
    tools: [
      { name: 'qa_issue_log', summary: 'List the durable project issue ledger: records, counts, recurrence, linked evidence.' },
      { name: 'qa_issue_history', summary: 'Append-only event trail for one issue.' },
      { name: 'qa_issue_mark_fixed', summary: 'Record a fix so future runs detect regressions via the same fingerprint.' },
      { name: 'qa_issue_triage', summary: "Change an issue's category/severity/owner or add a note (append-only)." },
      { name: 'qa_issue_suppress', summary: 'Suppress known noise with a reason/expiration; stays visible under known-noise.' },
      { name: 'qa_issue_verify_fixed', summary: 'Link passing evidence to a FIXED issue so reports can claim it was verified.' },
      { name: 'qa_issue_metrics', summary: 'Issue quality trends: opened/fixed/reopened/verified, aging, reopen rate.' },
      { name: 'qa_mobile_audit', summary: 'Plan or execute a named mobile-QA profile (smoke / account_cycle / store_compliance / resilience / release_gate).' },
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
      description: 'Return the public Swipium tools grouped by purpose with short summaries.',
      inputSchema: {
        group: z.enum(groupNames).optional().describe('Return only this group.'),
      },
    },
    async ({ group }) => {
      const groups = group ? CAPABILITY_GROUPS.filter((g) => g.group === group) : CAPABILITY_GROUPS;
      const summary =
        `Swipium v${SWIPIUM_VERSION}: ${TOOL_COUNT} public tools in ${CAPABILITY_GROUPS.length} groups.\n` +
        groups
          .map((g) => `\n[${g.group}] ${g.purpose}\n` + g.tools.map((t) => `  - ${t.name}: ${t.summary}`).join('\n'))
          .join('\n') +
        '\n\nStart with qa_test_this for low-context "test it" requests.';
      return qaOk({ swipiumVersion: SWIPIUM_VERSION, totalTools: TOOL_COUNT, groups }, summary);
    },
  );
}
