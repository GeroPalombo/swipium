// The public tool surface grouped by purpose. Returned (names only) by qa_status when called
// without a sessionId, mirrored by the section layout of docs/tools.md, and checked at startup
// by server.ts assertToolSurface(): every TOOL_NAMES entry must appear in exactly one group, so
// the grouping can never drift from the registered surface (test/publicSurface.test.ts too).

import type { ToolName } from '../version.js';

export interface CapabilityGroup {
  group: string;
  purpose: string;
  tools: ToolName[];
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    group: 'start',
    purpose: 'Autopilot, orientation, job polling, blockers, artifacts.',
    tools: [
      'qa_test_this',
      'qa_status',
      'qa_job_status',
      'qa_job_cancel',
      'qa_explain_blocker',
      'qa_continue_from_blocker',
      'qa_get_artifact',
    ],
  },
  {
    group: 'setup',
    purpose: 'Check the toolchain, open a session, prepare an Android Emulator or iOS Simulator.',
    tools: ['qa_doctor', 'qa_start_session', 'qa_prepare_target', 'qa_prepare_ios_target', 'qa_ios', 'qa_wda'],
  },
  {
    group: 'build',
    purpose: 'Pick a target (plus project context/plan), find an artifact, or build one from source.',
    tools: ['qa_resolve_target', 'qa_resolve_artifact', 'qa_build', 'qa_bundletool'],
  },
  {
    group: 'device',
    purpose: 'Inspect and control the device/app environment without raw adb or simctl.',
    tools: ['qa_device_info', 'qa_orientation', 'qa_geolocation', 'qa_network', 'qa_metro', 'qa_app_control', 'qa_screen_record'],
  },
  {
    group: 'drive',
    purpose: 'Observe, act, assert, and collect evidence.',
    tools: [
      'qa_snapshot',
      'qa_inspect',
      'qa_act',
      'qa_clear_overlay',
      'qa_check_health',
      'qa_screenshot',
      'qa_note',
      'qa_visual',
      'qa_wait',
    ],
  },
  {
    group: 'run',
    purpose: 'Smoke checks, guided exploration, reports.',
    tools: ['qa_smoke', 'qa_explore', 'qa_report'],
  },
  {
    group: 'app-map',
    purpose: 'The durable app knowledge map (project memory).',
    tools: ['qa_app_map_build', 'qa_app_map_read', 'qa_app_map_query', 'qa_app_map_feature_scope', 'qa_app_map_update'],
  },
  {
    group: 'feature',
    purpose: 'Test one feature by name.',
    tools: ['qa_test_feature'],
  },
  {
    group: 'flows',
    purpose: 'Validate, run, compile, and repair durable flows.',
    tools: ['qa_flow_check', 'qa_flow_run', 'qa_flow_compile', 'qa_flow_repair'],
  },
  {
    group: 'generate',
    purpose: 'Per-run assets (flow, page objects, POM suite, test cases, Appium code) from recorded actions.',
    tools: ['qa_generate'],
  },
  {
    group: 'test-suite',
    purpose: 'The canonical repo-level test suite (.swipium/test-suite.json).',
    tools: ['qa_suite_read', 'qa_suite_update', 'qa_suite_generate', 'qa_suite_export', 'qa_suite_lint'],
  },
  {
    group: 'issues',
    purpose: 'Durable issue ledger and release audits.',
    tools: ['qa_issue_log', 'qa_mobile_audit'],
  },
  {
    group: 'first-run',
    purpose: 'Login, sign-up, onboarding, and paywall first-run screens.',
    tools: ['qa_first_run'],
  },
];
