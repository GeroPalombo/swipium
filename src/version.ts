// Single source of truth for the Swipium version and the public v1 tool surface. Used by the
// server identity, qa_doctor / qa_start_session, qa_capabilities, and `swipium verify`.

export const SWIPIUM_VERSION = '1.0.1';

export const TOOL_NAMES = [
  'qa_agent_brief',
  'qa_capabilities',
  'qa_test_this',
  'qa_job_status',
  'qa_status',
  'qa_explain_blocker',
  'qa_continue_from_blocker',
  'qa_get_artifact',
  'qa_doctor',
  'qa_start_session',
  'qa_detect_context',
  'qa_plan',
  'qa_prepare_target',
  'qa_prepare_ios_target',
  'qa_ios',
  'qa_wda',
  'qa_snapshot',
  'qa_act',
  'qa_clear_overlay',
  'qa_check_health',
  'qa_screenshot',
  'qa_note',
  'qa_assert_visual',
  'qa_smoke',
  'qa_explore',
  'qa_report',
  'qa_app_map_build',
  'qa_app_map_read',
  'qa_app_map_query',
  'qa_app_map_feature_scope',
  'qa_app_map_validate',
  'qa_flow_check',
  'qa_flow_run',
  'qa_flow_generate',
  'qa_suite_generate',
  'qa_suite_compile',
  'qa_testcase_generate',
  'qa_first_run_plan',
  'qa_first_run_continue',
  'qa_automation_plan',
  'qa_automation_generate',
  'qa_automation_validate',
] as const;

export const TOOL_COUNT = TOOL_NAMES.length;
export const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

/** MCP prompts (reusable workflow templates) — PHASE3-PLAN §3.3. */
export const PROMPT_NAMES = [
  'swipium_setup_check',
  'swipium_full_smoke',
  'swipium_bug_repro',
  'swipium_convert_run_to_flow',
] as const;

export const PROMPT_COUNT = PROMPT_NAMES.length;

/** Shown when a client may be running an older build than what's installed on disk. */
export const STALE_CLIENT_HINT =
  `Swipium v${SWIPIUM_VERSION} exposes ${TOOL_COUNT} tools + ${PROMPT_COUNT} prompts. If your MCP client lists fewer ` +
  `(e.g. qa_test_this / qa_plan / qa_flow_run / qa_ios missing), it is running a server ` +
  `spawned before the upgrade. Restart the client to reload Swipium.`;
