# Changelog

All notable public changes to Swipium are documented here.

## 2.0.0 - 2026-09-28

This release fixes the typing, gesture, and secret-handling defects in the core loop, adds CI exports and a consolidated visual tool, and narrows the public surface from 61 to 55 tools. **It removes and renames public tools** — see [Migrating from 1.5.0](#migrating-from-150) below and the same table at the end of `docs/tools.md`.

### Migrating from 1.5.0

| 1.5.0 call | Now |
| --- | --- |
| `qa_agent_brief`, `qa_capabilities` | Server `instructions` (sent at connect), or `qa_status` without `sessionId` |
| `qa_next_best_action {sessionId, goal}` | `qa_status {sessionId, goal}` (always returns `nextBestAction`) |
| `qa_detect_context` | `qa_resolve_target {include:["context"]}` |
| `qa_plan {sessionId}` | `qa_resolve_target {sessionId, include:["plan"]}` |
| `qa_assert_visual` | `qa_visual {mode:"assert", assertion, pass}` |
| `qa_ios action:"wda_status"` / `"wda_attach"` | `qa_wda action:"status"` / `"attach"` |
| `qa_ios action:"screenshot"` | `qa_screenshot` |
| `qa_wait {for:"job_done"}` | `qa_job_status {jobId, waitMs}` |
| `qa_wda {udid}` | `qa_wda {device}` (`udid` still accepted) |
| `qa_suite_generate {creativityLevel}` | `qa_suite_generate {creativity}` (`creativityLevel` still accepted) |
| `qa_mobile_audit {waitForCompletion}` | removed (was reserved and unused) |

MCP clients pick up the new tool list after a restart. Saved prompts or scripts that name removed tools need the replacements above.

### Added

- `qa_visual`: one visual-intelligence tool with `mode:"baseline"|"diff"|"find_text"|"find_image"|"assert"`. It works from screenshots only, so it also works on an iOS simulator without WebDriverAgent, where `qa_act`/`qa_snapshot` are unavailable. `find_text`/`find_image` return tappable device coordinates (points on iOS) and can tap them (`tap:true`, via `idb` on a WDA-less simulator); those taps are recorded and budgeted like `qa_act` taps. `find_text` needs a local OCR command (`SWIPIUM_OCR_CMD` or `ocrCommand` in `.swipium/config.json`); without one it returns `OCR_NOT_CONFIGURED` with the provider contract and a tesseract example.
- `qa_issue_log` lifecycle: `mode:"history"` (default, the 1.5.0 behavior), `"log"`, `"mark_fixed"`, `"verify_fixed"`, `"suppress"` (with `suppressedUntil` expiry and `unsuppress:true`), and `"metrics"`. An issue marked fixed and seen again is classified as a regression.
- CI exports: `qa_report format:"junit"|"sarif"|"github-summary"`, and a new `swipium report` CLI (`--latest --format … --out … --fail-on-gate`) that renders the last saved report and exits `1` when the `.swipium/policy.json` release gate blocks. SARIF results are anchored to real repository files so GitHub code scanning shows them. `docs/ci-reports.md` has a complete GitHub Actions recipe (Android emulator, headless Claude Code, report, SARIF upload, JUnit).
- `qa_act observe:"diff"|"full"|"none"`: return only the elements that changed after an action (`diff` is the default once a snapshot exists).
- `qa_status` without `sessionId` returns first-call orientation; with `goal` it biases `nextBestAction`. `qa_job_status waitMs` long-polls until the job finishes (up to 120 s).
- MCP tool annotations on every tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint:false`), so clients can auto-approve read-only calls, and server `instructions` with the operating guide. The `tools/list` payload is about 26% smaller.
- MCP resource listing for session artifacts and app-map sections, scoped to the current project and excluding sensitive-mode sessions.
- Consent through MCP elicitation: on clients that support it, privileged actions are approved in a real user prompt, and the mutation ledger records how each action was approved (`elicitation`, `client-assertion`, or `policy`). `SWIPIUM_REQUIRE_ELICITATION=1` refuses every consent-gated action on clients without elicitation.
- CLI: `swipium --help`, `--version`, `swipium serve`; an unknown subcommand prints usage and exits `2` instead of starting the server (unknown `--flags` such as `--stdio` still start the server, with a warning). New `swipium init cursor` and `swipium init vscode`; `init` accepts `--cwd <dir>`.
- Disk retention: at startup Swipium prunes `~/.swipium/runs` session folders older than 30 days that are not in the session registry, always keeping the newest 20 per project (`SWIPIUM_RETENTION_DAYS`, `SWIPIUM_RETENTION_KEEP`; `0`/`off` disables). `swipium gc [--dry-run] [--days N] [--keep N]` reclaims space on demand, and `~/.swipium/projects.json` drops entries for deleted projects.
- `qa_test_this` accepts `responseMode`, has a `needs_input` terminal job state (a credentials question found during a run is returned instead of dropped), and its terminal result carries a compact report summary.
- `qa_device_info` on iOS simulators returns name, runtime, state, and screen size. `qa_resolve_target include:["context"]` lists booted and available iOS simulators.

### Changed

- Project root resolution: explicit `projectRoot` → MCP roots → `SWIPIUM_PROJECT_ROOT` → `CLAUDE_PROJECT_DIR` → the server's working directory, only when it contains a project marker (`package.json`, `app.json`, `pubspec.yaml`, Gradle or Xcode files, `android/`, `ios/`). Results report where the root came from (`rootSource`). Unresolved roots fail with `PROJECT_ROOT_UNRESOLVED`.
- `swipium init` writes a portable `npx -y swipium` command for project-scoped registrations (shared `.mcp.json`, Gemini project settings, Cursor, VS Code); absolute paths are used only for user/local scope. Codex registrations include `startup_timeout_sec = 30` and `tool_timeout_sec = 600`.
- `adb` and `emulator` are found through `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the default SDK location for the OS when they are not on `PATH` (useful for GUI-launched clients).
- `qa_doctor` checks both platforms by default on macOS, and checks the Node version against `engines`.
- `build_from_source` consent is now high risk and `start_metro` medium.
- Generated Appium suites perform real scroll and swipe gestures; steps that cannot be generated fail with `UNEMITTABLE_STEP` instead of producing no-op code. A scroll recorded without a target is now replayed in the correct direction.
- `qa_continue_from_blocker` returns `ignored[]` for answers the resumed tool cannot use, instead of dropping them silently, and replays the original goal and flags of the interrupted `qa_test_this` call.
- Flows resolve `${VAR}` from the server environment only for names starting with `SWIPIUM_` (explicit variables and stored session inputs still work). Generated flows and suites always use `SWIPIUM_`-prefixed names (`SWIPIUM_TEST_*` for stored inputs, `SWIPIUM_SECRET_N` otherwise), and `qa_flow_run` fills in the session's stored inputs. `swipium init flows` templates use `SWIPIUM_TEST_EMAIL`/`SWIPIUM_TEST_PASSWORD`.
- Every app install is consent-gated, including an APK inside the project (Android now matches iOS). `qa_mobile_audit` `resilience`/`release_gate` profiles ask for network-change consent before toggling airplane mode, and restore its original state afterwards.
- `qa_status` follows the last job: after a finished run it returns that run's next action instead of re-suggesting `qa_smoke`; smoke and report milestones are remembered.
- Responses are smaller: the JSON block in normal response mode is compact and omits data already shown in the text (a 32-element `qa_snapshot` went from about 8.6k to 1.9k characters), and `qa_act`'s default diff falls back to the full list when most of the screen changed.
- Fewer device round trips per action: adaptive settle interval, bounded screen-dump timeouts, a cheaper foreground/health check, longer-lived screen-size caches, one keyboard lookup per action, and the MCP cancel signal reaches the device call.

### Fixed

- Android typing escapes every shell metacharacter (including `{ } [ ]`), types a literal `%s` correctly, and treats empty text as a no-op. Characters `adb input text` cannot deliver fail with `TEXT_INPUT_UNSUPPORTED`.
- Deep links and launch extras containing `&`, spaces, or `;` reach the app intact on Android.
- Swipe and scroll geometry comes from the live screen size, accounts for rotation, and keeps clear of screen edges; the old fixed 1080×2400 coordinates were off-screen on iOS.
- Tapping a control hidden under the soft keyboard no longer types into the field: when the keyboard area is known and covers the target, Swipium hides the keyboard, re-finds the target, and returns `KEYBOARD_OBSTRUCTION` if it is still covered; when the area is unknown it taps and returns a warning. `qa_act` results now include `warnings[]`.
- `qa_act scroll untilVisible` checks before the first swipe and stops at the end of a list (`endOfList`).
- Flow `clearOverlay` no longer presses BACK on a plain screen (which could leave the app); it dismisses dialogs, sheets, and dev overlays and reports when there was nothing to clear.
- A single USB phone, or an emulator that is still booting, is no longer bound automatically; tools return `PHYSICAL_DEVICE_UNSUPPORTED` or `DEVICE_NOT_READY`. Network-attached emulators (e.g. `localhost:5555`) are accepted.
- Monorepo projects: answering the "which app?" question now selects that app instead of being treated as a device ID, and the question is not asked again.
- iOS: platform-aware next steps after `qa_ios boot`, simulators counted in target plans, keyboard detection on WebDriverAgent, request timeouts on every WebDriverAgent call, and recovery from an expired WebDriverAgent session that asks WebDriverAgent not to relaunch or terminate the app (`forceAppLaunch:false`, `shouldTerminateApp:false`).
- `qa_issue_log mode:"log"` no longer merges unrelated issues into one; each issue's identity includes its title and category. Titles with no identifying words return `ISSUE_LOG_TOO_VAGUE`. Issues logged manually by 1.5.x keep their old identity and can be closed with `mark_fixed` or `suppress`.
- The issue ledger is locked across processes and rebuilds its index when another process changed it.
- JUnit exports are always well-formed XML (control characters from device logs are replaced), and failures the release-gate policy ignores are reported as skipped instead of failed. GitHub step summaries are capped below GitHub's 1 MiB limit.
- Generated JavaScript suites no longer contain TypeScript-only syntax, and generated JavaScript/Python suites compile when element labels are keywords ("Continue", "Return"), start with digits, or contain quotes or backslashes.
- App-map and session state writes are atomic and locked; a stale lock is taken over safely, long app-map scans run outside the lock, and a corrupt `app-map.json` is restored from history.
- Generated suite files from `qa_test_this generateSuite:true` are fetchable `swipium://` artifacts.
- `swipium scan` writes nothing when it cannot identify a project; the docs and CLI no longer reference the nonexistent `swipium plan` and `swipium ci` commands.
- A child process exiting before reading its stdin can no longer crash the server; iOS screen size no longer downloads the full UI tree.
- Found by device testing on an Android 16 emulator and an iOS 18 simulator:
  - A resumed iOS session is rebound to its own simulator (through WebDriverAgent when it was attached), never to another online device, and the rebind reuses the running app instead of relaunching it. `state.json` now records the driver kind and WebDriverAgent URL.
  - A managed WebDriverAgent started by a previous server run is no longer stopped at startup when it is less than 12 hours old and healthy: the new server adopts it, so a resumed iOS session keeps structured automation instead of falling back to visual-only. `qa_wda stop` can stop an adopted WebDriverAgent.
  - Scrolls start inside the scrollable list instead of the screen center (in landscape, the center could be on the app bar), a plain `scroll` performs one swipe, and `changed` also reflects content that moved.
  - Snapshots skip rows that Android reports as scrolled off the list (empty or inverted bounds) or that lie off-screen, so `scroll untilVisible` no longer reports an off-screen row as found and taps no longer land on the list edge. `untilVisible` only reports `endOfList` when the list stopped moving, not when it moved but showed the same labels.
  - Replace-mode typing of text `adb` cannot deliver is refused before the field is cleared.
  - iOS snapshots include accessibility identifiers and search/text fields, so typed values can be read back.
  - `press key:"back"` on iOS taps the navigation bar's back button or swipes from the left edge, instead of calling a WebDriverAgent endpoint that does not exist.
  - The documented tesseract OCR setup works: the provider runs from the project root, a crashing provider returns `OCR_PROVIDER_FAILED` instead of "not found", and screenshots are written to a path macOS tesseract can open.
  - Navigation bars, list rows, and text fields are no longer reported as banner or snackbar overlays.
  - A password field's show/hide button keeps its label in snapshots; only secure values are masked.
  - Generated suites default to the session's platform (iOS sessions get XCUITest), the Python generator passes its own validation, and `qa_visual mode:"assert"` steps become marked manual checks instead of failing text assertions.
  - `qa_report` collapses identical findings into one with a count, and reports `DEGRADED` tool status when tools failed during the run.
  - `qa_flow_check` and `qa_flow_run mode:"plan"` resolve the project root like other tools (`projectRoot`, MCP roots, `SWIPIUM_PROJECT_ROOT`, working directory).
  - Several errors that returned `UNKNOWN` now carry typed codes (`INVALID_ARGUMENT`, `FLOW_NOT_FOUND`, `KEYBOARD_NOT_DISMISSIBLE`, `CAPTURE_WITHHELD_SECURE`, `SENSITIVE_MODE_REFUSED`, `NO_DEVICE`).
  - `qa_status` reports a simulator session without WebDriverAgent as `visual-only`.
- Found in pre-release review:
  - With a physical phone connected, `qa_test_this` could install the app on the phone instead of the emulator it planned to boot. It now waits for the new emulator and never targets a physical device; a phone alone returns `PHYSICAL_DEVICE_UNSUPPORTED`, and a missing `adb` returns `ADB_NOT_FOUND`.
  - `qa_test_this` on iOS without WebDriverAgent no longer blocks by default: it skips suite generation and runs visual-only. Plan-mode "next" calls include `mode:"execute"` so they don't repeat the plan.
  - The file lock could spin forever on a stale lock it could not take over, blocking server startup.
  - Common-word passwords ("test", "password") no longer rewrite selectors or block generation on template text.
  - Apps whose package name contains `debug` or `alert` no longer show false banner/snackbar overlays.
  - Tapping a switch or checkbox is detected as a change, instead of being retried and toggled back.
  - `qa_flow_repair` proposes elements of the same kind, ranked by text similarity, and refuses to apply low-confidence repairs; a failed `qa_flow_run` points to it.
  - Flow `clearOverlay` dismisses iOS alerts with the alert API. A brief WebDriverAgent outage while resuming no longer downgrades an iOS session permanently.
  - Unknown sessions, invalid app IDs, and deliberate refusals return typed failure codes, and the report's tool status no longer counts them as tool errors.
  - `qa_status` no longer repeats advice that was already followed (an answered question, a report generated after the run, an explained blocker). `qa_explain_blocker` accepts `sessionId`.
  - Cancelling one call no longer cancels another: each tool call and background job carries its own cancel signal, so cancelling a `qa_snapshot` cannot stop a running install, and a cancelled job cannot break later calls.
  - An orphaned Metro started through `npx` is cleaned up after a crash (npm renames its process title), and process start times are read in a fixed locale.
  - Fixtures are no longer saved to `state.json` in redacted form and replayed as `«redacted»` after a restart; a resumed session reloads them from `.swipium/fixtures.json`.
  - iOS `press back` only reuses a page source from the last few seconds, and app launches through `qa_ios` reset it.

### Security

- A consent prompt the user dismisses or leaves unanswered is a refusal (`CONSENT_CANCELLED`); the agent cannot approve that action itself. An open prompt cannot be bypassed with `approve:true`.
- Secrets never appear in error messages: a failed `adb input text` no longer echoes the typed value, and `qa_act`/flow errors are redacted.
- Report exports (JUnit, SARIF, GitHub summary, Markdown, JSON) are redacted field by field before rendering, so escaping cannot defeat redaction.
- Values typed into secure fields (passwords, PINs, OTPs, CVVs) are redacted regardless of length using whole-token matching, JSON and XML artifacts are redacted structurally so they stay valid, and secrets shorter than 3 characters are reported as not redacted instead of blanking unrelated text. A session resumed after a restart is flagged `redactionDegraded` in `qa_report`.
- Typing through a native selector into a secure field registers the value as a secret; generated flows use `${SWIPIUM_TEST_PASSWORD}` instead of the plaintext.
- A registered secret typed into an ordinary (non-password) field is recorded as a secret too, and every generator checks its output against the session's secrets: generation fails with `SECRET_IN_GENERATED_OUTPUT` and writes nothing rather than emit a secret. `state.json`, `test-suite.json`, and test cases no longer store secret values.
- `qa_visual` baseline names and template paths are confined to the project (`VISUAL_PATH_REFUSED`); artifact names can no longer escape the session directory. On screens Swipium cannot inspect, OCR results that look like credentials are withheld.
- `THREAT_MODEL.md` documents the limits of the re-call consent convention and the stronger elicitation path.
- A cloned repository is treated as untrusted input: flows and `.swipium/fixtures.json` cannot read server environment variables outside `SWIPIUM_*` (values read from the environment are treated as secrets), and an `openUrl` containing a variable is consent-gated; consent shows the exact commands of flow seed steps and of repository-configured OCR/mask commands, labelled as unreviewed; a project config can no longer point iOS automation at a non-loopback WebDriverAgent (use `SWIPIUM_ALLOW_REMOTE_WDA` to allow specific URLs).
- Consent prompts strip control characters and are bound to the session that requested them.
- Orphan-process cleanup only signals a process whose recorded start time and command still match, so a reused process ID can no longer be killed; it runs after the server connects.
- App IDs are validated and quoted for the device shell. Sensitive mode suppresses screenshots in flows and smoke runs. `qa_issue_log` redacts session secrets before writing the ledger. Session folders and files are private (`0700`/`0600`), and OCR temp files live in private per-call directories.
- CI workflows pin third-party actions to commit SHAs.
- Production dependencies updated for advisories in transitive MCP SDK dependencies (`fast-uri`, `hono`, `@hono/node-server`, `body-parser`).

### Removed

- The tools listed in the migration table above.
- Unregistered pre-1.5.0 tool modules that still shipped in `dist/`. `qa_seed`, `qa_permissions`, `qa_screen_info`, and `qa_locator_suggest` moved to `src/tools/deferred/` (excluded from the build and the npm package).
- Maestro import/export is out of scope; flows recorded with `source: "maestro_import"` remain valid.

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
