// Single source of truth for the Swipium version and the public tool surface. Used by the
// server identity, qa_doctor / qa_start_session, qa_status orientation, and `swipium verify`.

export const SWIPIUM_VERSION = '2.0.1';

export const TOOL_NAMES = [
  // Start: autopilot, orientation, polling, blockers, artifacts
  'qa_test_this',
  'qa_status',
  'qa_job_status',
  'qa_job_cancel',
  'qa_explain_blocker',
  'qa_continue_from_blocker',
  'qa_get_artifact',
  // Setup
  'qa_doctor',
  'qa_start_session',
  'qa_prepare_target',
  'qa_prepare_ios_target',
  'qa_ios',
  'qa_wda',
  // Local build + artifact resolution
  'qa_resolve_target',
  'qa_resolve_artifact',
  'qa_build',
  'qa_bundletool',
  // Device / app environment
  'qa_device_info',
  'qa_orientation',
  'qa_geolocation',
  'qa_network',
  'qa_metro',
  'qa_app_control',
  'qa_screen_record',
  // Drive: observe, act, assert
  'qa_snapshot',
  'qa_inspect',
  'qa_act',
  'qa_clear_overlay',
  'qa_check_health',
  'qa_screenshot',
  'qa_note',
  'qa_visual',
  'qa_wait',
  // Run
  'qa_smoke',
  'qa_explore',
  'qa_report',
  // App knowledge map
  'qa_app_map_build',
  'qa_app_map_read',
  'qa_app_map_query',
  'qa_app_map_feature_scope',
  'qa_app_map_update',
  // Feature-focused testing
  'qa_test_feature',
  // Repeatable flows
  'qa_flow_check',
  'qa_flow_run',
  'qa_flow_compile',
  'qa_flow_repair',
  // Per-run asset generation from recorded actions
  'qa_generate',
  // Persistent test suite (.swipium/test-suite.json)
  'qa_suite_read',
  'qa_suite_update',
  'qa_suite_generate',
  'qa_suite_export',
  'qa_suite_lint',
  'qa_first_run',
  // Durable issue memory + executable mobile audit
  'qa_issue_log',
  'qa_mobile_audit',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_COUNT = TOOL_NAMES.length;
export const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

/** MCP prompts (reusable workflow templates). */
export const PROMPT_NAMES = [
  'swipium_setup_check',
  'swipium_guardrail_validation',
  'swipium_full_smoke',
  'swipium_bug_repro',
  'swipium_convert_run_to_flow',
] as const;

export const PROMPT_COUNT = PROMPT_NAMES.length;

/** Tools removed from the public surface, mapped to their replacement. Shown in the stale-client
 * hint so an agent that still sees (or remembers) an old name knows the call to use instead. */
export const REMOVED_TOOLS: Readonly<Record<string, string>> = {
  qa_agent_brief: 'server instructions + qa_status (no sessionId)',
  qa_capabilities: 'qa_status (no sessionId): capability groups',
  qa_next_best_action: 'qa_status { sessionId, goal? } > nextBestAction',
  qa_detect_context: 'qa_resolve_target { include: ["context"] }',
  qa_plan: 'qa_resolve_target { sessionId, include: ["plan"] }',
  qa_assert_visual: 'qa_visual { mode: "assert", assertion, pass? }',
};

/** Shown when a client may be running an older build than what's installed on disk. */
export const STALE_CLIENT_HINT =
  `Swipium v${SWIPIUM_VERSION} exposes ${TOOL_COUNT} tools + ${PROMPT_COUNT} prompts. If your MCP client lists a ` +
  `different set, it is running a server spawned before the upgrade. Signs: it still shows ` +
  `${Object.keys(REMOVED_TOOLS).join(' / ')} (replaced by qa_status, qa_resolve_target include:[…] and ` +
  `qa_visual mode:"assert"), or qa_ios wda_* / screenshot actions (use qa_wda / qa_screenshot), or ` +
  `qa_wait for:"job_done" (use qa_job_status waitMs). Restart the client to reload Swipium.`;
