// MCP tool annotations (spec: Tool.annotations / ToolAnnotations) for EVERY public tool, applied
// centrally at registration by server.ts (installResponseModeWrapper) so no tool can ship without
// them. The table is keyed by ToolName, so adding a tool to TOOL_NAMES without classifying it
// here is a compile error.
//
// Spec defaults are the pessimistic ones (readOnlyHint false, destructiveHint true,
// idempotentHint false, openWorldHint true), so every entry is explicit:
//
//   readOnlyHint    true:   the tool does not change the device/simulator, the app, the project
//                           tree, or durable project memory (app map, issue ledger, test suite).
//                           In-process session bookkeeping (counters, the last UI snapshot, health
//                           findings fed to qa_report) is Swipium's own scratch state, not the
//                           environment, and does not disqualify a tool.
//   destructiveHint true:   the tool has an action whose PURPOSE is to delete, reset, or overwrite
//                           user-visible state that is not Swipium-generated output:
//                             qa_app_control   clear_data / fresh_start wipe app data (pm clear)
//                             qa_ios           erase wipes the simulator; privacy_reset revokes grants
//                             qa_suite_update  mergeMode replace_generated / deprecations rewrite curated cases
//                             qa_app_map_update overwrites existing test-case/suite entries + coverage overrides
//                   false:  everything else that mutates: it installs/launches/drives the app,
//                           writes evidence, or (re)generates Swipium-owned output under .swipium/
//                           (flows, page objects, baselines, exports; same name = intentional
//                           regeneration). qa_issue_log is an append-only event log (suppress/fix
//                           are appended events, reversible via unsuppress / reopen). Destructive
//                           steps inside qa_explore / qa_mobile_audit / qa_act-driven app flows are
//                           separately consent- or flag-gated by Swipium itself.
//   idempotentHint  true:   repeating the same call leaves the environment as the first did
//                           (set orientation/location/network to X; cancel a job; recompile the
//                           same suite to the same files).
//   openWorldHint   false:  everywhere. Swipium only talks to local simulators, local toolchains,
//                           and the local project (a non-loopback WDA URL is consent-gated).

import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { ToolName } from '../version.js';

type Kind = 'read' | 'write' | 'write-idempotent' | 'destructive';

const KIND: Record<ToolName, Kind> = {
  // start
  qa_test_this: 'write',
  qa_status: 'read',
  qa_job_status: 'read',
  qa_job_cancel: 'write-idempotent',
  qa_explain_blocker: 'read',
  qa_continue_from_blocker: 'write',
  qa_get_artifact: 'read',
  // setup
  qa_doctor: 'read',
  qa_start_session: 'write',
  qa_prepare_target: 'write',
  qa_prepare_ios_target: 'write',
  qa_ios: 'destructive',
  qa_wda: 'write',
  // build
  qa_resolve_target: 'read',
  qa_resolve_artifact: 'read',
  qa_build: 'write',
  qa_bundletool: 'write',
  // device
  qa_device_info: 'read',
  qa_orientation: 'write-idempotent',
  qa_geolocation: 'write-idempotent',
  qa_network: 'write-idempotent',
  qa_metro: 'write',
  qa_app_control: 'destructive',
  qa_screen_record: 'write',
  // drive
  qa_snapshot: 'read',
  qa_inspect: 'read',
  qa_act: 'write',
  qa_clear_overlay: 'write',
  qa_check_health: 'read',
  qa_screenshot: 'write',
  qa_note: 'write',
  qa_visual: 'write',
  qa_wait: 'read',
  // run
  qa_smoke: 'write',
  qa_explore: 'write',
  qa_report: 'write',
  // app map
  qa_app_map_build: 'write',
  qa_app_map_read: 'read',
  qa_app_map_query: 'read',
  qa_app_map_feature_scope: 'read',
  qa_app_map_update: 'destructive',
  // feature
  qa_test_feature: 'write',
  // flows
  qa_flow_check: 'read',
  qa_flow_run: 'write',
  qa_flow_compile: 'write-idempotent',
  qa_flow_repair: 'write',
  // generate
  qa_generate: 'write',
  // test suite
  qa_suite_read: 'read',
  qa_suite_update: 'destructive',
  qa_suite_generate: 'write',
  qa_suite_export: 'write',
  qa_suite_lint: 'read',
  qa_first_run: 'write',
  // issues
  qa_issue_log: 'write',
  qa_mobile_audit: 'write',
};

/** The annotations advertised for `name` in tools/list. */
export function toolAnnotations(name: ToolName): ToolAnnotations {
  switch (KIND[name]) {
    case 'read':
      return { readOnlyHint: true, openWorldHint: false };
    case 'write':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    case 'write-idempotent':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case 'destructive':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  }
}
