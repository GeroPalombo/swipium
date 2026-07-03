// Single source of truth for the Swipium version and the public tool surface. Used by the
// server identity, qa_doctor / qa_start_session, qa_capabilities, and `swipium verify`.

export const SWIPIUM_VERSION = '1.5.0';

export const TOOL_NAMES = [
  'qa_agent_brief',
  'qa_capabilities',
  'qa_test_this',
  'qa_job_status',
  'qa_job_cancel',
  'qa_status',
  'qa_explain_blocker',
  'qa_continue_from_blocker',
  'qa_next_best_action',
  'qa_get_artifact',
  'qa_doctor',
  'qa_start_session',
  'qa_detect_context',
  'qa_plan',
  'qa_prepare_target',
  'qa_prepare_ios_target',
  'qa_ios',
  'qa_wda',
  // Local build + artifact resolution (REQ "test this app")
  'qa_resolve_target',
  'qa_resolve_artifact',
  'qa_build',
  'qa_bundletool',
  // Device / app environment parity (Phase 5)
  'qa_device_info',
  'qa_orientation',
  'qa_geolocation',
  'qa_network',
  'qa_metro',
  'qa_app_control',
  'qa_screen_record',
  'qa_snapshot',
  'qa_inspect',
  'qa_act',
  'qa_clear_overlay',
  'qa_check_health',
  'qa_screenshot',
  'qa_note',
  'qa_assert_visual',
  // Agent-efficiency helpers (Phase 7)
  'qa_wait',
  'qa_smoke',
  'qa_explore',
  'qa_report',
  'qa_app_map_build',
  'qa_app_map_read',
  'qa_app_map_query',
  'qa_app_map_feature_scope',
  'qa_app_map_update',
  // Feature-focused testing (REQ-03: "test the X feature")
  'qa_test_feature',
  // Repeatable flow system (Phase 4)
  'qa_flow_check',
  'qa_flow_run',
  'qa_flow_compile',
  'qa_flow_repair',
  // Per-run asset generation from recorded actions (1.5.0 consolidation)
  'qa_generate',
  // Persistent test suite (REQ-06, durable .swipium/test-suite.json)
  'qa_suite_read',
  'qa_suite_update',
  'qa_suite_generate',
  'qa_suite_export',
  'qa_suite_lint',
  'qa_first_run',
  // Durable issue memory + executable mobile audit (REQ-07/08)
  'qa_issue_log',
  'qa_mobile_audit',
] as const;

export const TOOL_COUNT = TOOL_NAMES.length;
export const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

/** MCP prompts (reusable workflow templates) — PHASE3-PLAN §3.3. */
export const PROMPT_NAMES = [
  'swipium_setup_check',
  'swipium_guardrail_validation',
  'swipium_full_smoke',
  'swipium_bug_repro',
  'swipium_convert_run_to_flow',
] as const;

export const PROMPT_COUNT = PROMPT_NAMES.length;

/** Shown when a client may be running an older build than what's installed on disk. */
export const STALE_CLIENT_HINT =
  `Swipium v${SWIPIUM_VERSION} exposes ${TOOL_COUNT} tools + ${PROMPT_COUNT} prompts. If your MCP client lists a ` +
  `different set (e.g. qa_generate / qa_first_run / qa_flow_compile / qa_test_feature missing, or tools ` +
  `removed or merged in the 1.5.0 consolidation still present — including the old _plan/_run/_continue twins ` +
  `now folded into qa_build, qa_flow_run, and qa_first_run), it is running a server spawned before the upgrade. ` +
  `Restart the client to reload Swipium.`;
