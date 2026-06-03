# Tool Reference

Swipium exposes 91 public MCP tools. The intended default entry point is `qa_test_this`.

## Start

Use these tools to orient the agent, start autopilot work, poll jobs, handle blockers, and fetch artifacts.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_agent_brief` | Returns the recommended orchestration rules for agents. | The agent needs the correct first call, polling behavior, report behavior, or blocker handling rules. |
| `qa_capabilities` | Lists the public tool surface grouped by purpose. | The agent or user needs to discover available Swipium capabilities. |
| `qa_test_this` | Autopilot for "test it": resolves the project, finds or builds an artifact, prepares a simulator, runs smoke or exploration, reports results, and can generate suite output. | The user gives a low-context request such as "test this app". |
| `qa_job_status` | Polls a long-running job started by `qa_test_this` or prepare tools. | A tool returns a `jobId` with status `running`. |
| `qa_status` | Returns compact session status and recommended next action. | The agent needs to recover context during a session. |
| `qa_explain_blocker` | Explains a typed blocker, likely owner, and recovery path. | A run stops with a blocker and the user needs a concise explanation. |
| `qa_continue_from_blocker` | Resumes after user input and registers secret values for redaction. | A blocker asks for credentials, OTP, target choice, or approval data. |
| `qa_get_artifact` | Fetches artifact metadata or contents by `swipium://` URI. | A report, screenshot, dump, log, or generated file must be read. |
| `qa_job_cancel` | Cancels a running job and aborts its spawned children. | A long-running job must be stopped early. |

## Setup

Use these tools to verify the local environment, create sessions, and prepare simulator targets.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_doctor` | Checks Node, Android Emulator readiness, iOS Simulator readiness, WDA status, and stale-client symptoms. Accepts `platform:"android"`, `"ios"`, or `"both"`. | Before the first run or when setup fails. |
| `qa_start_session` | Opens a project QA session with budget, response mode, fixtures, and sensitive mode. | Running lower-level tools directly instead of `qa_test_this`. |
| `qa_detect_context` | Detects framework, project readiness, artifacts, devices, and likely blockers. | The agent needs a preflight view before selecting a path. |
| `qa_plan` | Produces a safe workflow plan before acting. | The user asks for a plan or the agent needs a low-risk next step. |
| `qa_prepare_target` | Prepares an Android Emulator target, installs or launches an APK, and binds the session. | Testing Android on an emulator. |
| `qa_prepare_ios_target` | Boots an iOS Simulator, installs a simulator `.app` when provided, launches a bundle id, and reports visual or WDA mode. | Testing iOS on a simulator. |
| `qa_ios` | Runs iOS Simulator lifecycle operations such as boot, install, launch, screenshot, logs, privacy reset, and erase. | Direct iOS simulator control is needed. |
| `qa_wda` | Checks, builds, or starts WebDriverAgent for structured iOS simulator automation. | iOS needs structured UI tree access instead of visual-only checks. |

## Build

Use these tools to resolve a device and an installable artifact, or build one from source locally. `qa_build` is consent-gated; the others are side-effect free.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_resolve_target` | Picks the best device or simulator (prefers online over needing a boot; honors a requested platform or device). | The agent needs to choose where to run. |
| `qa_resolve_artifact` | Finds the best installable `.apk`/`.aab`/`.ipa`/`.app` and explains where it looked. | An artifact path is unknown or ambiguous. |
| `qa_build_plan` | Proposes the exact build commands per framework and platform without running them. | The agent needs to know how the app would be built. |
| `qa_build` | Builds from source as a consent-gated job, captures a build log, and re-resolves the artifact. | No reusable artifact exists and the project must be compiled. |
| `qa_bundletool` | Converts an `.aab` to an installable APK: a universal `.apk` or a device-specific APK set. | Only an Android App Bundle is available. |

## Device

Use these tools to inspect and control the device and app environment without raw `adb` or `simctl`. Mutating actions are consent-gated and recorded as environment changes; network changes are auto-restored at report end.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_device_info` | Reports model, SDK, ABIs, locale, screen, orientation, and installed apps (read-only). | The agent needs device context before testing. |
| `qa_permissions` | Lists, grants, or revokes runtime permissions. Revoke is consent-gated. | A flow needs a known permission state. |
| `qa_orientation` | Sets portrait, landscape, or auto orientation. | A screen must be tested in a specific orientation. |
| `qa_geolocation` | Spoofs a GPS location on the emulator. Consent-gated. | Testing map or location-aware screens. |
| `qa_network` | Reports, sets offline/online, or restores airplane-mode state. Consent-gated and auto-restored. | Testing offline behavior or network errors. |
| `qa_metro` | Reports, starts, stops, or diagnoses the RN/Expo Metro bundler with RedBox detection. | A debug RN/Expo build needs Metro. |
| `qa_app_control` | Runs launch, foreground, background, force_stop, restart, clear_data, or fresh_start. Destructive actions are guarded. | The app lifecycle must be controlled directly. |
| `qa_screen_info` | Reports screen width, height, density, orientation, mode, and coordinate landmarks. | Coordinate-space context is needed for visual work. |
| `qa_screen_record` | Records a screen video to an mp4 artifact (start/stop). Consent-gated with sensitive-screen warnings. | A run needs a video of the reproduction. |

## Drive

Use these tools to observe the UI, act on it, collect evidence, and record results.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_snapshot` | Captures compact structured UI elements where the backend supports it. | The agent needs selectors, visible text, or UI state. |
| `qa_act` | Taps, types, clears, swipes, scrolls, presses keys, opens URLs, waits, and observes after action. | The agent needs to drive the app step by step. |
| `qa_clear_overlay` | Attempts to dismiss common overlays blocking a target. | Popups, permissions, modals, or sheets block the next action. |
| `qa_check_health` | Checks foreground app status, crash signals, ANR, error boundaries, and native health. | The agent needs to distinguish app bugs from environment issues. |
| `qa_screenshot` | Captures a screenshot artifact with coordinate-space metadata. | Visual evidence is required. |
| `qa_note` | Records a structured QA outcome in the session. | The agent needs to log pass, fail, blocked, skipped, or finding details. |
| `qa_assert_visual` | Captures a visual assertion with evidence. | The agent needs to document that a visual condition is true or false. |
| `qa_visual` | Runs local visual operations: baseline capture, regression diff, image-target matching with tappable coordinates, and optional OCR. | A screen is visual-only or needs pixel-level regression checks. |
| `qa_visual_find_text` | Locates on-screen text with OCR and returns structured regions with coordinate-space conversion. | A target has visible text but no structured selector. |
| `qa_locator_suggest` | Scores each element's locator durability and grades automation readiness. | The agent needs to know which controls need testIDs before generating automation. |
| `qa_input_capabilities` | Reports backend text-entry limits: ASCII, Unicode, clipboard, and WDA typing frequency. | Typing fails or behaves oddly and the agent needs the backend's input limits. |
| `qa_wait` | Waits without a shell for `device_online`, `metro_ready`, or `job_done`. | The agent needs to block on a condition without raw `adb`/`sleep`. |
| `qa_idling_status` | Reads app-declared idling hooks or label-heuristic settling before automation. | The agent needs to know the app has settled before acting. |

## State

Use these tools to create and verify reproducible preconditions instead of only reporting them as missing. All mutating seed and state actions are consent-gated and recorded.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_seed` | Creates a declared precondition via a fixture seed using a deeplink, script, or API hook. Consent-gated. | A workflow is blocked by missing test data. |
| `qa_state_prepare` | Prepares a reproducible state profile: reset, launch, seed, and verify a ledger. | A test needs a known starting state. |
| `qa_state_verify` | Verifies a state profile without treating setup drift as an app bug. | The precondition must be confirmed before testing. |
| `qa_state_teardown` | Runs state-profile teardown and restores declared environment state. | A run must leave the environment clean. |

## Run

Use these tools to run broader QA workflows and produce reports.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_smoke` | Runs launch smoke, baseline health, screenshot evidence, and saved flows. | The app is prepared and the agent needs a deterministic smoke pass. |
| `qa_explore` | Performs bounded guided exploration, builds a screen graph, and records evidence. | The agent needs to discover reachable workflows or collect runtime app-map data. |
| `qa_report` | Generates a session report with findings, blockers, evidence, mutations, workarounds, next actions, and separate app and coverage verdicts. | A run should be summarized or exported. |
| `qa_report_compare` | Compares the current `report.json` against a baseline report. | A run should be checked for regression against a known-good report. |
| `qa_run_history` | Summarizes local run history with pass rate, failures, flaky flows, and confidence calibration. | The user wants trends across runs, not a single report. |

## App Map

Use these tools to build and read Swipium's durable app knowledge map.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_app_map_build` | Builds or updates the app map from static analysis and runtime observations. | The project needs durable QA memory. |
| `qa_app_map_read` | Reads compact app-map sections such as features, screens, auth, automation, or test suite. | The agent needs app context without flooding the transcript. |
| `qa_app_map_query` | Searches features, screens, tests, and code links with ranked results. | The user asks about a feature, screen, or test surface. |
| `qa_app_map_feature_scope` | Resolves a feature query or feature id into focused testing scope and recommended plan. | The agent needs to test a specific feature. |
| `qa_app_map_validate` | Validates schema, provenance, links, duplicate ids, impossible states, and stale fingerprints. | The map must be trusted before feature-focused testing. |

## Feature Testing

Use these tools to test a specific feature by name, backed by the app knowledge map.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_feature_scope` | Maps a natural-language feature ("weather analysis") to code, screens, routes, runtime, and tests, plus an objective and strategy. Read-only. | The user names a feature and the agent needs its scope. |
| `qa_feature_test_plan` | Produces a feature test plan: scope, objective, generated cases, fixtures, automation readiness, and an execution plan. Read-only. | A feature needs a concrete test plan before running. |
| `qa_test_feature` | Runs a focused feature test: scope, targeted exploration toward the feature, recorded cases, then updates the feature map and report. | The user asks to test a specific feature. |

## Flows and Suites

Use these tools to create, validate, run, and compile reusable test assets.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_flow_check` | Parses and statically validates a Swipium flow. | A flow file should be checked before execution. |
| `qa_flow_plan` | Plans a flow against backend capabilities without executing it. | A flow should be checked for feasibility before a run. |
| `qa_flow_run` | Executes a Swipium flow against a prepared simulator session. | A saved flow needs to run against the app. |
| `qa_flow_generate` | Generates a flow from recorded actions. | A manual or exploratory run should become a reusable flow. |
| `qa_flow_repair` | Suggests or patches a stronger locator for a failed flow step from the current screen. | A flow step fails on a brittle locator. |
| `qa_suite_generate` | Generates a POM-style suite from recorded behavior. | The run should become a structured test suite. |
| `qa_suite_compile` | Compiles a generated suite into runnable Swipium flows. | A generated suite needs executable flow output. |
| `qa_suite_lint` | Lints generated page objects for brittle, coordinate-only, or dynamic locators. | A generated suite needs a durability check. |
| `qa_pom_generate` | Generates page objects and a locator audit from recorded actions. | A run should produce reusable page objects. |
| `qa_testcase_generate` | Generates test-case documentation from recorded behavior. | The run should produce human-readable test cases and steps. |

## Persistent Test Suite

Use these tools to grow and maintain a canonical test suite that persists across runs in `.swipium/test-suite.json`.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_test_suite_read` | Reads the canonical suite, filtered by functionality or status, as summary, json, or markdown. | The agent needs the durable suite without re-deriving it. |
| `qa_test_suite_update` | Merges cases into the persistent suite, deduping by feature, objective, and steps. | A run produced cases to fold into the suite. |
| `qa_test_suite_generate` | Generates or refreshes canonical cases from a recorded run and exploration. | The suite needs to be (re)built from observed behavior. |
| `qa_test_suite_export` | Exports the persistent suite to markdown, a yaml directory, json, or junit. | The suite must be shared or fed to CI. |
| `qa_test_suite_lint` | Validates the suite for missing expected/actual, stale map links, and duplicate ids. | The suite must be trusted before a release sign-off. |

## Maestro Interop

Use these tools to exchange flows with the Maestro ecosystem.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_maestro_import` | Imports supported Maestro YAML commands into a Swipium Flow V2. | An existing Maestro flow should run under Swipium. |
| `qa_maestro_export` | Exports a Swipium Flow V2 to Maestro YAML with portability grades. | A Swipium flow should be shared as Maestro YAML. |

## Issue Memory and Mobile Audit

Use these tools for a durable, per-project issue ledger and executable mobile-QA audit profiles. The ledger lives in `.swipium/issues-log.jsonl`; fingerprints let later runs detect regressions of previously fixed issues.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_issue_log` | Lists the durable issue ledger with counts, recurrence candidates, and linked evidence. | The agent needs the project's known issues. |
| `qa_issue_history` | Shows the append-only event trail for one issue. | An issue's lifecycle needs auditing. |
| `qa_issue_mark_fixed` | Records a fix (date, commit, version, how-fixed) so future runs detect regressions. | A reported issue has been resolved. |
| `qa_issue_triage` | Changes an issue's category, severity, or owner, or appends a note. | An issue needs reclassification. |
| `qa_issue_suppress` | Suppresses known noise with a reason and expiration; it stays visible as known-noise. | A recurring non-bug should stop dominating reports. |
| `qa_issue_verify_fixed` | Links passing test or audit evidence to a fixed issue. | A report should honestly claim an issue was verified this run. |
| `qa_issue_metrics` | Summarizes issue trends: opened, fixed, reopened, verified, aging, and reopen rate. | The user wants issue quality trends. |
| `qa_mobile_audit` | Plans or executes a named mobile-QA profile (smoke, account_cycle, store_compliance, resilience, release_gate). | A structured, repeatable audit is needed; execution records issues and evidence. |

## First Run

Use these tools for login, account creation, onboarding, permissions, OTP, and paywall screens.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_first_run_plan` | Classifies the current first-run screen and creates a safe plan without acting. | The agent reaches login, signup, onboarding, permission, OTP, paywall, or home screens. |
| `qa_first_run_continue` | Executes bounded first-run steps with safe generated data when allowed and stops at gates. | The plan can safely proceed in a test or staging environment. |

## Automation

Use these tools to generate and validate automation code from Swipium evidence.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_automation_plan` | Plans generated JS, TS, or Python Appium automation from project profile and recorded actions. | The user asks to automate the tested behavior. |
| `qa_automation_generate` | Generates an Appium POM suite from recorded actions and validates it. | The run should produce automation code. |
| `qa_automation_validate` | Validates generated automation code without a device. | Generated files need checks for secrets, durability, capabilities, syntax, and empty files. |

## Detailed Reference: Device, Visual, State, History, Build, and Feature Tools

Technical detail for the tools added alongside the device-parity, visual-intelligence, seeded-state, reporting, build, and feature-testing phases. Most take a `sessionId` from `qa_start_session`; the build, artifact, and read-only feature tools also accept a `projectRoot` so they work before a session exists. Mutating actions accept `consentId` + `approve` and are recorded in the report's mutation ledger.

### Device and app environment

- **`qa_device_info`** — read-only Android introspection. *Inputs:* `listPackages?`, `packageFilter?`. *Outputs:* `props` (manufacturer, model, SDK, release, ABIs, locale, timezone), `screen` (`width`/`height`/`density`), `orientation`/`rotation`/`autoRotate`, `installedThirdPartyCount`, optional `packages[]`. No consent.
- **`qa_orientation`** — set rotation. *Inputs:* `orientation: portrait | landscape | auto`. *Outputs:* resulting `orientation`/`rotation`/`autoRotate`. Non-destructive; logged as an environment change.
- **`qa_geolocation`** — spoof GPS via `adb emu geo fix <lng> <lat>`. *Inputs:* `lat`, `lng` (decimal degrees). *Outputs:* `{ lat, lng, set }`. Consent-gated (medium). Emulator/`direct` backend only; iOS and real devices return `BACKEND_UNSUPPORTED`.
- **`qa_permissions`** — runtime permission control. *Inputs:* `action: list | grant | revoke`, `package?` (default session `appId`), `permission?` (`android.permission.*`, required for grant/revoke). *Outputs:* `granted[]`/`denied[]` (list) or `{ package, permission, action }`. `list` is read-only; `grant` is consent-gated low (it can mask a permission-prompt bug); `revoke` is consent-gated medium (can break app state).
- **`qa_network`** — offline/online via `cmd connectivity airplane-mode` (Android 11+). *Inputs:* `action: status | offline | online | restore`. *Outputs:* `network` (`online`/`offline`), `restoreAvailable`. `offline`/`online` consent-gated (medium); the original airplane state is recorded on first change and auto-restored at `qa_report`, on `restore`, and on server shutdown.
- **`qa_metro`** — RN/Expo Metro lifecycle. *Inputs:* `action: status | diagnose | start | stop`. *Outputs:* `framework`, `metroListening`, `reverseSet`, `serving`, `ready`, `metroPid`, plus `redBox` + `recovery[]` (+ logcat artifact) for `diagnose`. `start` is consent-gated (low): it runs `adb reverse tcp:8081 tcp:8081` and spawns Metro (`npx expo start --dev-client` or `npx react-native start`) detached, logging to an artifact and tracking the PID; `stop` signals the whole process group.
- **`qa_app_control`** — app lifecycle. *Inputs:* `action: launch | foreground | background | force_stop | restart | clear_data | fresh_start`, `acknowledgeBundleRisk?`. *Outputs:* `packageName`, `action`, `processKilled`, `foreground`, `foregroundIsApp`. `clear_data`/`fresh_start` are destructive → consent-gated (high); on debug RN/Expo builds they additionally require `acknowledgeBundleRisk:true` because a data wipe can remove the cached JS bundle.
- **`qa_screen_info`** — coordinate-space metadata for visual-fallback work. *Outputs:* `screen` (`width`/`height`/`density`), `orientation`, session `mode`, `latestScreenshot`, named `landmarks` and `bands` (device pixels, origin top-left), `counters`, `budget`. Read-only.
- **`qa_screen_record`** — screen video. *Inputs:* `action: start | status | stop`, `save?: always | on_failure`, `failed?`. *Outputs:* `recording`/`capturing`/`autoStopped`, `seconds`, and on stop a `uri` (mp4 artifact) + `bytes`. Consent-gated (medium); refused on sensitive sessions. Android uses `adb screenrecord --time-limit 180`; iOS uses `simctl io recordVideo`. One recording per session.

### Visual intelligence (local-first)

- **`qa_visual`** — deterministic visual ops + regression. *Inputs:* `action: baseline | diff | find_image | ocr`, `name?` (baseline/diff), `template?` (find_image PNG path), `threshold?` (diff, default 0.02), `minScore?` (find_image, default 0.85), `force?`. *Outputs:* always include `coordinateSpace` (screenshot↔device scale); `diff` adds `changedRatio`/`pass`/`changedBoxDevice`; `find_image` adds `devicePoint`. `baseline`/`diff`/`find_image` are local and need no consent; `ocr` is consent-gated and requires a configured `ocrCommand`. Withheld when a secure (password/OTP) field is on screen unless `force:true`.
- **`qa_visual_find_text`** — OCR text locator. *Inputs:* `query`, `minConfidence?` (default 0.8). *Outputs:* `found`, matched `region` (text/confidence/bbox), `devicePoint`, `coordinateSpace`. Consent-gated (the screenshot is passed to the configured local OCR provider); requires `ocrCommand` returning JSON regions.

### Seeded state

- **`qa_seed`** — create a declared precondition. *Inputs:* `fixture` (must declare a `seed`: `deeplink | script | api`). *Outputs:* `{ fixture, type, seeded, warnings[] }`. Consent-gated; risk scales by type (`script` high, `api` medium, `deeplink` low). Git commands are refused (`GIT_SCOPE_FORBIDDEN`); a failed seed is reported as a SETUP failure (`missing_test_data`), never an app bug.
- **`qa_state_prepare`** — apply a state profile as one transaction. *Inputs:* `profile` (`.swipium/state/<name>.yaml` or inline YAML). *Outputs:* a state `ledger` + `ledgerUri`. Consent-gated when it mutates (reset/launch/seed); refuses debug-bundle-loss resets unless acknowledged.
- **`qa_state_verify`** — confirm a profile's declared checks (e.g. `assertVisible`). *Inputs:* `profile`. *Outputs:* verification `ledger`. Non-mutating; failures are setup/state blockers, not app-test failures.
- **`qa_state_teardown`** — run profile teardown. *Inputs:* `profile`. *Outputs:* teardown `ledger`. Consent-gated when it mutates; restores declared state such as `networkOnline` and runs fixture cleanup hooks.

### Report history

- **`qa_report_compare`** — diff two reports. *Inputs:* `current`, `baseline` (paths to `report.json`), `trendRoot?`. *Outputs:* new/fixed failures, changed screenshots, outcome changes, runtime regression, optional flake status, and a `summary`. Filesystem-only — no session or device.
- **`qa_run_history`** — local trend summary. *Inputs:* `sessionId?` or `projectRoot?`. *Outputs:* report count, per-flow `passRate`, median/average runtime, top failures, flaky flows, confidence calibration, and slowest steps. Reads `.swipium/runs/**/report.json` (and legacy `.swipium/ci/**`).

### Build and artifact resolution

- **`qa_resolve_target`** — choose the best device or simulator, deterministically and side-effect free. *Inputs:* `sessionId?`, `projectRoot?`, `platform?` (`android`/`ios`), `device?` (name/serial/udid), `preferRealDevice?`. *Outputs:* `selection` (kind + id), a human `reason`, `alternatives[]`, `preconditions` (e.g. WDA/signing), and `willBoot`. Does not boot anything — `qa_prepare_target`/`qa_ios` do that.
- **`qa_resolve_artifact`** — find the best installable artifact and explain the search. *Inputs:* `sessionId?`, `projectRoot?`, `platform?` (`android`/`ios`/`any`), `buildType?` (`debug`/`release`/`any`), `path?` (explicit artifact), `allowOutsideRoot?`, `requireInstallableOn?` (`android-emulator`/`android-real`/`ios-simulator`/`ios-real`). *Outputs:* the resolved `.apk`/`.aab`/`.ipa`/`.app` and its type; on failure, the exact globs searched plus a `qa_build_plan` → `qa_build` next step. Read-only.
- **`qa_build_plan`** — propose exact build commands without running them. *Inputs:* `sessionId?`, `projectRoot?`, `platform` (`android`/`ios`), `variant?` (`debug`/`release`). *Outputs:* detected `framework`, the exact build commands, the expected artifact path, and a cost estimate. Returns a typed error when no supported framework (Expo, bare React Native, native Android/iOS, Flutter) is detected. Side-effect free.
- **`qa_build`** — build from source as a consent-gated job. *Inputs:* `sessionId` (required), `platform` (`android`/`ios`), `variant?`, `timeoutMs?`, `consentId?`/`approve?`. *Outputs:* a `jobId` to poll with `qa_job_status`; on completion a build-log artifact and the re-resolved artifact path. Consent-gated (it compiles the app).
- **`qa_bundletool`** — convert an Android App Bundle to an installable APK. *Inputs:* `sessionId` (required), `aab?` (default: the best `.aab` under the project), `force?`, `connectedDevice?` (device-specific APK set vs a universal APK), `install?` (also run `install-apks`), `deviceId?`, `consentId?`/`approve?`. *Outputs:* the generated APK or APK-set path. `install` is consent-gated because it installs app code on a device/emulator.

### Feature-focused testing

- **`qa_feature_scope`** — map a natural-language feature to the app, read-only. *Inputs:* `feature` (required, e.g. "weather analysis"), `sessionId?` (adds runtime screen-graph evidence), `projectRoot?` (static code scope), `platform?`, `includeCode?` (default true), `limit?`. *Outputs:* ranked `candidates` each tagged by `source` (`code`/`screen`/`route`/`runtime`/`test`) with confidence, plus a test `objective` and `strategy`. No consent. Returns `found:false` with guidance when nothing matches.
- **`qa_feature_test_plan`** — generate a full feature test plan, read-only. *Inputs:* `feature` (required), `sessionId?`/`projectRoot?`, `platform?`, `creativity?` (`conservative`=happy path; `standard` (default)=+validation/empty/error; `creative`=+boundary/offline/interruption; `adversarial`=+destructive), `allowAdversarial?`, `includeCode?`, `limit?`. *Outputs:* a `plan` with scope, objective, generated `cases`, `fixtures`, automation readiness, and an execution plan. Adversarial cases are consent-gated at execution time.
- **`qa_test_feature`** — run a focused test toward a named feature. *Inputs:* `feature` (required), `sessionId` (required), `mode?` (`plan` (default) / `execute` (focused run as a job) / `interactive` (run until the first question)), `platform?`, `device?`, `creativity?`, `allowAdversarial?`, `maxScreens?`, `maxActions?`, `timeoutMs?`, `generateCases?`, `consentId?`/`approve?`. *Outputs:* in `plan` mode the scope + cases; in `execute` mode a `jobId` whose run performs targeted exploration toward the feature, records cases, updates the feature map, and emits a report. `execute`/`interactive` are consent-gated.

## Recommended Entry Points

| User intent | First tool |
| --- | --- |
| "Test it" | `qa_test_this` |
| "Check setup" | `qa_doctor` |
| "Start a manual run" | `qa_start_session` |
| "Launch Android" | `qa_prepare_target` |
| "Launch iOS" | `qa_prepare_ios_target` |
| "Smoke test" | `qa_smoke` |
| "Explore the app" | `qa_explore` |
| "Generate report" | `qa_report` |
| "Read app memory" | `qa_app_map_read` |
| "Test the X feature" | `qa_test_feature` |
| "Find/build an artifact" | `qa_resolve_artifact` / `qa_build` |
| "Create a flow" | `qa_flow_generate` |
| "Generate automation" | `qa_automation_plan` |

## Extension Pattern

When adding tools in future releases, document each tool with:

- Name.
- Group.
- What it does.
- When to use it.
- Main inputs.
- Main outputs.
- Scope limits.
- Consent or mutation behavior.
