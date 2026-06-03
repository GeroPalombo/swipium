// Single source of truth for the Swipium version and the public tool surface. Used by the
// server identity, qa_doctor / qa_start_session, qa_capabilities, and `swipium verify`.

export const SWIPIUM_VERSION = '1.3.0';

export const TOOL_NAMES = [
  'qa_agent_brief',
  'qa_capabilities',
  'qa_test_this',
  'qa_job_status',
  'qa_job_cancel',
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
  // Local build + artifact resolution (REQ "test this app")
  'qa_resolve_target',
  'qa_resolve_artifact',
  'qa_build_plan',
  'qa_build',
  'qa_bundletool',
  // Device / app environment parity (Phase 5)
  'qa_device_info',
  'qa_permissions',
  'qa_orientation',
  'qa_geolocation',
  'qa_network',
  'qa_metro',
  'qa_app_control',
  'qa_screen_info',
  'qa_screen_record',
  'qa_snapshot',
  'qa_act',
  'qa_clear_overlay',
  'qa_check_health',
  'qa_screenshot',
  'qa_note',
  'qa_assert_visual',
  // Visual intelligence (Phase 8, local-first OCR + coordinate audit)
  'qa_visual',
  'qa_visual_find_text',
  // Agent-efficiency helpers (Phase 7)
  'qa_locator_suggest',
  'qa_wait',
  'qa_idling_status',
  'qa_input_capabilities',
  'qa_smoke',
  'qa_explore',
  'qa_report',
  // Report 2.0: durable history and run comparison (Phase 10)
  'qa_report_compare',
  'qa_run_history',
  // Seeded state (Phase 9)
  'qa_seed',
  'qa_state_prepare',
  'qa_state_verify',
  'qa_state_teardown',
  'qa_app_map_build',
  'qa_app_map_read',
  'qa_app_map_query',
  'qa_app_map_feature_scope',
  'qa_app_map_validate',
  // Feature-focused testing (REQ-03: "test the X feature")
  'qa_feature_scope',
  'qa_feature_test_plan',
  'qa_test_feature',
  // Repeatable flow system (Phase 4)
  'qa_flow_check',
  'qa_flow_plan',
  'qa_flow_run',
  'qa_flow_generate',
  'qa_flow_repair',
  // Persistent test suite + POM (REQ-06)
  'qa_suite_generate',
  'qa_suite_compile',
  'qa_suite_lint',
  'qa_pom_generate',
  'qa_testcase_generate',
  'qa_test_suite_read',
  'qa_test_suite_update',
  'qa_test_suite_generate',
  'qa_test_suite_export',
  'qa_test_suite_lint',
  'qa_first_run_plan',
  'qa_first_run_continue',
  'qa_automation_plan',
  'qa_automation_generate',
  'qa_automation_validate',
  // Maestro interop
  'qa_maestro_import',
  'qa_maestro_export',
  // Durable issue memory + executable mobile audit (REQ-07/08)
  'qa_issue_log',
  'qa_issue_history',
  'qa_issue_mark_fixed',
  'qa_issue_triage',
  'qa_issue_suppress',
  'qa_issue_verify_fixed',
  'qa_issue_metrics',
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
  `Swipium v${SWIPIUM_VERSION} exposes ${TOOL_COUNT} tools + ${PROMPT_COUNT} prompts. If your MCP client lists fewer ` +
  `(e.g. qa_test_feature / qa_feature_scope / qa_build / qa_resolve_target / qa_bundletool missing), it is running a server ` +
  `spawned before the upgrade. Restart the client to reload Swipium.`;
