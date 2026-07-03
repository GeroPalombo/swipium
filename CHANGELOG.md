# Changelog

All notable public changes to Swipium are documented here.

## 1.5.0 - 2026-07-03

Swipium 1.5.0 is the production consolidation release. It narrows the MCP surface from 95 to 60 public tools, keeps the main simulator QA workflows, and moves lower-level/internal helpers out of the public contract so agents have fewer overlapping choices.

### Highlights

- `qa_generate` is now the single generator for flow YAML, page objects, per-run suites, test-case docs, and Appium code.
- `qa_first_run` replaces the first-run plan/continue split with `mode:"plan"` and `mode:"continue"`.
- Planning/execution patterns are standardized: `qa_build` uses `mode:"plan"|"run"` (default `plan`), and `qa_flow_run` uses `mode:"plan"|"run"` (default `run`).
- Durable suite tools now use the shorter `qa_suite_*` names, and generated POM suites compile through `qa_flow_compile`.
- `qa_app_map_feature_scope`, `qa_test_feature`, `qa_mobile_audit`, `qa_report`, and the suite/reporting tools remain the supported public paths for feature, audit, evidence, and release-gate workflows.

### Compatibility Notes

- Public tool count is now 60. Tools removed from public registration were merged into canonical tools or deferred from the public v1 surface.
- Main migrations: generation tools move to `qa_generate target:"flow"|"pom"|"suite"|"testcases"|"appium"`; `qa_feature_scope` moves to `qa_app_map_feature_scope`; `qa_feature_test_plan` moves to `qa_test_feature mode:"plan"`; first-run twins move to `qa_first_run`; build/flow plan twins move to `qa_build mode:"plan"` and `qa_flow_run mode:"plan"`.
- `qa_build` without `mode` now returns a build plan. Use `qa_build mode:"run"` to start the consent-gated build job.
- `qa_act` now requires structured selector objects instead of free-form selector strings.
- Timing fields are normalized to milliseconds (`*Ms`), and snapshot/action element lists are capped with an `elementsOmitted` count plus filtering support.

### Reliability and Release Readiness

- Added hermetic coverage for the core happy path, `qa_doctor`, docs/version consistency, and every public tool's structured error envelope.
- Every `qaError` now includes a `failureCode`, with `UNKNOWN` as the fallback.
- Release checks now run typecheck, lint, format check, tests, production audit, clean build, and pack dry-run.
- `npm run build` cleans `dist/` before compiling so stale removed tools cannot ship.
- File-lock timeouts now fail instead of falling back to unlocked writes.
- Added the published threat model documenting local trust boundaries, consent gates, and secret redaction.

## 1.4.0 - 2026-06-04

This release expands the public tool surface from 91 to 95 tools, completing the simulator-local agent and app-map helpers. It is a minor release: the additions are backward compatible, existing tools and input schemas are unchanged, and clients on 1.3.0 keep working and gain the new tools after a restart. Scope stays simulator-local with no external service integrations, real-device execution, or remote AI.

### Added

- `qa_inspect` returns the full attributes (class, resource-id, content-desc, text, bounds, flags) of a single `@eN` element from the latest snapshot, with secret redaction and secure-field masking.
- `qa_next_best_action` returns a deterministic recommendation of the single best next tool to call (with args) and why, optionally biased by a goal.
- `qa_app_map_update` applies targeted, provenance-tracked updates to the app map (note, test cases, automation suite, environment, feature coverage) without a full rebuild.
- `qa_app_map_diff` compares two app-map snapshots and reports screen, coverage, locator-readiness, and stale-test changes plus new untested code areas.

### Changed

- `qa_capabilities` lists the new app-map, drive, and start tools.

## 1.3.0 - 2026-06-03

This release expands the public tool surface from 83 to 91 tools, adding feature-focused testing and local build/artifact resolution. It is a minor release: the additions are backward compatible, existing tools and input schemas are unchanged, and clients on 1.2.0 keep working and gain the new tools after a restart. Scope stays simulator-local with no external service integrations, real-device execution, or remote AI.

### Added

- Feature-focused testing backed by the app knowledge map: `qa_feature_scope` maps a natural-language feature to code, screens, routes, runtime, and tests; `qa_feature_test_plan` produces a full test plan with generated cases, fixtures, and automation readiness; `qa_test_feature` runs a focused test toward a named feature and updates the map and report.
- Local build and artifact resolution: `qa_resolve_target` picks the best device or simulator, `qa_resolve_artifact` finds the best installable artifact, `qa_build_plan` proposes exact build commands, `qa_build` builds from source as a consent-gated job, and `qa_bundletool` converts an `.aab` to an installable APK.

### Changed

- `qa_capabilities` adds build and feature groups and lists the new tools.

## 1.2.0 - 2026-06-02

This release expands the public tool surface from 59 to 83 tools, advancing the roadmap's repeatable-flow, failure-taxonomy, and reporting phases plus durable QA memory. It is a minor release: the additions are backward compatible, existing tools and input schemas are unchanged, and clients on 1.1.0 keep working and gain the new tools after a restart. Scope stays simulator-local with no external service integrations, real-device execution, or remote AI.

### Added

- Durable issue memory: `qa_issue_log`, `qa_issue_history`, `qa_issue_mark_fixed`, `qa_issue_triage`, `qa_issue_suppress`, `qa_issue_verify_fixed`, and `qa_issue_metrics` over a per-project ledger (`.swipium/issues-log.jsonl`). Fingerprints let later runs detect regressions of previously fixed issues; suppressed noise stays visible as known-noise rather than hidden.
- Executable mobile-QA audit: `qa_mobile_audit` plans or runs named profiles (smoke, account_cycle, store_compliance, resilience, release_gate); execution records issues and evidence.
- Persistent test suite: `qa_test_suite_read`, `qa_test_suite_update`, `qa_test_suite_generate`, `qa_test_suite_export`, and `qa_test_suite_lint` maintain a canonical suite that grows across runs.
- Flow system and suite quality: `qa_flow_plan` (feasibility against backend capabilities), `qa_flow_repair` (stronger locator for a failed step), `qa_suite_lint`, and `qa_pom_generate`.
- Maestro interop: `qa_maestro_import` and `qa_maestro_export` exchange flows with Maestro YAML, with portability grades on export.
- Agent-efficiency helpers: `qa_locator_suggest`, `qa_input_capabilities`, `qa_wait`, `qa_idling_status`, and `qa_job_cancel`.

### Changed

- `qa_capabilities` adds test-suite, interop, and issues groups, and lists the new flow, suite, and agent-efficiency tools.

## 1.1.0 - 2026-06-01

This release expands the public tool surface from 42 to 59 tools, advancing the roadmap's device-parity, visual-intelligence, seeded-state, and reporting phases. It is a minor release: the additions are backward compatible, existing tools and input schemas are unchanged, and clients on 1.0.1 keep working and gain the new tools after a restart.

### Added

- Device and app environment parity tools so common setup no longer needs raw `adb` or `simctl`: `qa_device_info`, `qa_permissions`, `qa_orientation`, `qa_geolocation`, `qa_network`, `qa_metro`, `qa_app_control`, `qa_screen_info`, and `qa_screen_record`. Mutating actions are consent-gated and recorded as environment changes; network changes are auto-restored at report end.
- Local-first visual intelligence: `qa_visual` for baseline capture, regression diff, image-target matching with tappable coordinates, and optional OCR; `qa_visual_find_text` for OCR text location with coordinate-space conversion.
- Seeded state so a blocked precondition can be created and verified instead of only reported: `qa_seed`, `qa_state_prepare`, `qa_state_verify`, and `qa_state_teardown`. All mutating actions are consent-gated.
- Report history tools: `qa_report_compare` to diff a run against a baseline report, and `qa_run_history` for pass rate, failures, flaky flows, and confidence calibration across local runs.
- New MCP prompt `swipium_guardrail_validation` that drives a non-destructive check confirming Swipium refuses bundle-loss actions on debug RN/Expo builds.

### Fixed

- Fixed default iOS text entry so replace-mode typing clears focused fields with current WebDriverAgent attributes and falls back to keyboard deletion when needed.
- Fixed `qa_test_this` build handling so successful Expo iOS builds are not reported as app build failures when artifact resolution needs follow-up.
- Fixed `qa_prepare_ios_target` so structured iOS mode is reported only after a WebDriverAgent session is created and attached to the run.
- Fixed report verdicts so Swipium tool limitations do not block the app status; they are reported under coverage and tool status.
- `qa_metro` stop now signals the entire detached process group, so the Metro bundler holding port 8081 is terminated rather than only its `npx` launcher, and it only signals a PID still confirmed to belong to a Metro/Node process. Any Swipium-started Metro is also stopped on server shutdown so a budget stop or crash does not leave a bundler running.
- `qa_screen_record` status now reports an Android time-limit recording that has stopped on its own as auto-stopped instead of implying it is still capturing, while retaining the entry so the video can still be saved.

### Changed

- Added exploration diagnostics for visible action-like text that is not exposed as clickable or editable.
- Improved app-map queries by indexing visible copy from source files.
- Improved generated POM suites by segmenting recorded actions by screen identity.

## 1.0.1 - 2026-06-01

### Fixed

- Updated iOS WDA point taps to use the current `/wda/tap` route with legacy fallback.
- Added focused typing fallback through `/wda/keys` for iOS WDA sessions.
- Made overlay clearing tolerate unsupported driver probes and use native WDA alert actions.

### Changed

- Added platform-specific `qa_doctor` readiness for Android Emulator and iOS Simulator.
- Clarified Expo Android local run planning for `npx expo run:android --variant debug`.
- Split report output into app status and coverage status.

## 1.0.0 - 2026-05-31

### Added

- Initial public release of Swipium.
- Limited v1 MCP tool surface focused on Android Emulator and iOS Simulator workflows.
- Core mobile QA flow: prepare a simulator target, observe the app, act on the UI, run smoke checks, capture evidence, and generate reports.
- Durable app knowledge map for storing tested screens, flows, findings, and generated test assets.
- Flow and test-suite generation from recorded or explored behavior.
- Consent gates for mutating actions and sensitive automation steps.
- Secret redaction in reports, artifacts, and generated automation.

### Security

- Latest-version-only security support.
- Production dependency audit included in the release check.
- Public security contact: hi@swipium.com.

### Not In Scope For v1

- Real-device certification.
- Jira or external tracker integration.
- Broad public support for every internal or experimental tool.
