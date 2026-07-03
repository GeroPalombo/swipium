# Tool Reference

Swipium 1.5.0 exposes 60 public MCP tools. The intended default entry point is `qa_test_this`.

This is the production public surface. Lower-level visual, seeded-state, report-history, and issue-lifecycle helpers from earlier development builds were merged into canonical workflows or deferred from public MCP registration; use the grouped tools below as the supported entry points.

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
| `qa_next_best_action` | Returns the single best next tool to call (with args) and why, deterministically. | The agent wants the orchestration sequence decided for it. |
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

Use these tools to resolve a device and an installable artifact, or build one from source locally. `qa_build` with `mode:"run"` is consent-gated; everything else is side-effect free.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_resolve_target` | Picks the best device or simulator (prefers online over needing a boot; honors a requested platform or device). | The agent needs to choose where to run. |
| `qa_resolve_artifact` | Finds the best installable `.apk`/`.aab`/`.ipa`/`.app` and explains where it looked. | An artifact path is unknown or ambiguous. |
| `qa_build` | `mode:"plan"` (default) proposes the exact build commands per framework and platform without running them; `mode:"run"` builds from source as a consent-gated job, captures a build log, and re-resolves the artifact. | The agent needs to know how the app would be built, or no reusable artifact exists and the project must be compiled. |
| `qa_bundletool` | Converts an `.aab` to an installable APK: a universal `.apk` or a device-specific APK set. | Only an Android App Bundle is available. |

## Device

Use these tools to inspect and control the device and app environment without raw `adb` or `simctl`. Mutating actions are consent-gated and recorded as environment changes; network changes are auto-restored at report end.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_device_info` | Reports model, SDK, ABIs, locale, screen, orientation, and installed apps (read-only). | The agent needs device context before testing. |
| `qa_orientation` | Sets portrait, landscape, or auto orientation. | A screen must be tested in a specific orientation. |
| `qa_geolocation` | Spoofs a GPS location on the emulator. Consent-gated. | Testing map or location-aware screens. |
| `qa_network` | Reports, sets offline/online, or restores airplane-mode state. Consent-gated and auto-restored. | Testing offline behavior or network errors. |
| `qa_metro` | Reports, starts, stops, or diagnoses the RN/Expo Metro bundler with RedBox detection. | A debug RN/Expo build needs Metro. |
| `qa_app_control` | Runs launch, foreground, background, force_stop, restart, clear_data, or fresh_start. Destructive actions are guarded. | The app lifecycle must be controlled directly. |
| `qa_screen_record` | Records a screen video to an mp4 artifact (start/stop). Consent-gated with sensitive-screen warnings. | A run needs a video of the reproduction. |

## Drive

Use these tools to observe the UI, act on it, collect evidence, and record results.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_snapshot` | Captures compact structured UI elements where the backend supports it. | The agent needs selectors, visible text, or UI state. |
| `qa_inspect` | Returns the full attributes of a single `@eN` element from the latest snapshot. | One element's details are needed without dumping the whole tree. |
| `qa_act` | Taps, types, clears, swipes, scrolls, presses keys, opens URLs, waits, and observes after action. | The agent needs to drive the app step by step. |
| `qa_clear_overlay` | Attempts to dismiss common overlays blocking a target. | Popups, permissions, modals, or sheets block the next action. |
| `qa_check_health` | Checks foreground app status, crash signals, ANR, error boundaries, and native health. | The agent needs to distinguish app bugs from environment issues. |
| `qa_screenshot` | Captures a screenshot artifact with coordinate-space metadata. | Visual evidence is required. |
| `qa_note` | Records a structured QA outcome in the session. | The agent needs to log pass, fail, blocked, skipped, or finding details. |
| `qa_assert_visual` | Captures a visual assertion with evidence. | The agent needs to document that a visual condition is true or false. |
| `qa_wait` | Waits without a shell for `device_online`, `metro_ready`, or `job_done`. | The agent needs to block on a condition without raw `adb`/`sleep`. |

## Run

Use these tools to run broader QA workflows and produce reports.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_smoke` | Runs launch smoke, baseline health, screenshot evidence, and saved flows. | The app is prepared and the agent needs a deterministic smoke pass. |
| `qa_explore` | Performs bounded guided exploration, builds a screen graph, and records evidence. | The agent needs to discover reachable workflows or collect runtime app-map data. |
| `qa_report` | Generates a session report with findings, blockers, evidence, mutations, workarounds, next actions, and separate app and coverage verdicts. | A run should be summarized or exported. |

## App Map

Use these tools to build and read Swipium's durable app knowledge map.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_app_map_build` | Builds or updates the app map from static analysis and runtime observations. | The project needs durable QA memory. |
| `qa_app_map_read` | Reads compact app-map sections such as features, screens, auth, automation, or test suite. | The agent needs app context without flooding the transcript. |
| `qa_app_map_query` | Searches features, screens, tests, and code links with ranked results. | The user asks about a feature, screen, or test surface. |
| `qa_app_map_feature_scope` | Resolves a feature id or free-text query into a focused testing scope: ranked candidates, code symbols, screens, existing tests, an objective model, and a recommended plan. Read-only; works before a map exists. | The user names a feature and the agent needs its scope. |
| `qa_app_map_update` | Applies targeted, provenance-tracked updates (note, test cases, automation suite, environment, feature coverage) without a full rebuild. | The map needs a small correction or annotation. |

## Feature Testing

Use these tools to test a specific feature by name, backed by the app knowledge map.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_test_feature` | Tests a named feature: `mode:"plan"` (default) returns the read-only test plan (scope, objective, generated cases, fixtures, execution plan); `mode:"execute"` runs targeted exploration toward the feature, records cases, then updates the feature map and report. | The user asks to plan or run a test of a specific feature. |

## Flows

Use these tools to create, validate, run, compile, and repair reusable flows.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_flow_check` | Parses and statically validates a Swipium flow (static lint of the YAML). | A flow file should be checked before execution. |
| `qa_flow_run` | `mode:"run"` (default) executes a Swipium flow against a prepared simulator session; `mode:"plan"` is a read-only execution preview against backend capabilities without touching a device. | A saved flow needs to run against the app, or its feasibility should be checked before a run. |
| `qa_flow_compile` | Compiles a generated POM suite into runnable Flow V2 for `qa_flow_run` and `swipium ci`. | A generated suite needs executable flow output. |
| `qa_flow_repair` | Suggests or patches a stronger locator for a failed flow step from the current screen. | A flow step fails on a brittle locator. |

## Generate

Use `qa_generate` to turn a session's recorded actions into reusable, per-run test assets. Pick the output with `target`; `mode:"plan"` gives a read-only preview. For the durable repo-level test suite that grows across runs, use `qa_suite_generate` instead.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_generate` | Generates test assets from recorded actions: `target:"flow"` (repeatable Flow V2 YAML), `target:"pom"` (page objects + locator audit), `target:"suite"` (full per-run `.swipium/` POM suite with compile/replay gates), `target:"testcases"` (test-case catalog docs), or `target:"appium"` (runnable Appium POM code in JS/TS/Python, with bootstrap from `projectRoot`). `mode:"plan"` previews without writing; for `target:"appium"` it returns the full automation plan with blockers. | A manual or exploratory run should become a reusable flow, page objects, a structured suite, test-case docs, or automation code. |

## Persistent Test Suite

Use these tools to grow and maintain a canonical test suite that persists across runs in `.swipium/test-suite.json`. This is the durable repo-level suite — distinct from the per-run assets `qa_generate` emits.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_suite_read` | Reads the canonical suite, filtered by functionality or status, as summary, json, or markdown. | The agent needs the durable suite without re-deriving it. |
| `qa_suite_update` | Merges cases into the persistent suite, deduping by feature, objective, and steps. | A run produced cases to fold into the suite. |
| `qa_suite_generate` | Generates or refreshes canonical cases from a recorded run and exploration, merging into the durable suite (not per-run assets — use `qa_generate` for those). | The durable suite needs to be (re)built from observed behavior. |
| `qa_suite_export` | Exports the persistent suite to markdown, a yaml directory, json, or junit. | The suite must be shared or fed to CI. |
| `qa_suite_lint` | Validates the durable suite (missing expected/actual, stale map links, duplicate ids) and, when `.swipium/pages` exists, also lints generated page objects for brittle locators. | The suite and generated pages must be trusted before a release sign-off. |

## Issue Memory and Mobile Audit

Use these tools for a durable, per-project issue ledger and executable mobile-QA audit profiles. The ledger lives in `.swipium/issues-log.jsonl`; fingerprints let later runs detect regressions of previously fixed issues.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_issue_log` | Lists the durable issue ledger with counts, recurrence candidates, and linked evidence. | The agent needs the project's known issues. |
| `qa_mobile_audit` | Plans or executes a named mobile-QA profile (smoke, account_cycle, store_compliance, resilience, release_gate). | A structured, repeatable audit is needed; execution records issues and evidence. |

## First Run

Use this tool for login, account creation, onboarding, permissions, OTP, and paywall screens.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_first_run` | `mode:"plan"` (default) classifies the current first-run screen and creates a safe plan without acting; `mode:"continue"` executes bounded first-run steps (`until: one_step`/`until_gate`/`until_home`) with safe generated data when allowed and stops at gates. | The agent reaches login, signup, onboarding, permission, OTP, paywall, or home screens. |

## Detailed Reference: Device, Build, and Feature Tools

Technical detail for retained public device, build, feature, app-map, and agent-helper tools. Most take a `sessionId` from `qa_start_session`; the build, artifact, and read-only feature tools also accept a `projectRoot` so they work before a session exists. Mutating actions accept `consentId` + `approve` and are recorded in the report's mutation ledger.

### Device and app environment

- **`qa_device_info`** — read-only Android introspection. *Inputs:* `listPackages?`, `packageFilter?`. *Outputs:* `props` (manufacturer, model, SDK, release, ABIs, locale, timezone), `screen` (`width`/`height`/`density`), `orientation`/`rotation`/`autoRotate`, `installedThirdPartyCount`, optional `packages[]`. No consent.
- **`qa_orientation`** — set rotation. *Inputs:* `orientation: portrait | landscape | auto`. *Outputs:* resulting `orientation`/`rotation`/`autoRotate`. Non-destructive; logged as an environment change.
- **`qa_geolocation`** — spoof GPS via `adb emu geo fix <lng> <lat>`. *Inputs:* `lat`, `lng` (decimal degrees). *Outputs:* `{ lat, lng, set }`. Consent-gated (medium). Emulator/`direct` backend only; iOS and real devices return `BACKEND_UNSUPPORTED`.
- **`qa_network`** — offline/online via `cmd connectivity airplane-mode` (Android 11+). *Inputs:* `action: status | offline | online | restore`. *Outputs:* `network` (`online`/`offline`), `restoreAvailable`. `offline`/`online` consent-gated (medium); the original airplane state is recorded on first change and auto-restored at `qa_report`, on `restore`, and on server shutdown.
- **`qa_metro`** — RN/Expo Metro lifecycle. *Inputs:* `action: status | diagnose | start | stop`. *Outputs:* `framework`, `metroListening`, `reverseSet`, `serving`, `ready`, `metroPid`, plus `redBox` + `recovery[]` (+ logcat artifact) for `diagnose`. `start` is consent-gated (low): it runs `adb reverse tcp:8081 tcp:8081` and spawns Metro (`npx expo start --dev-client` or `npx react-native start`) detached, logging to an artifact and tracking the PID; `stop` signals the whole process group.
- **`qa_app_control`** — app lifecycle. *Inputs:* `action: launch | foreground | background | force_stop | restart | clear_data | fresh_start`, `acknowledgeBundleRisk?`. *Outputs:* `packageName`, `action`, `processKilled`, `foreground`, `foregroundIsApp`. `clear_data`/`fresh_start` are destructive → consent-gated (high); on debug RN/Expo builds they additionally require `acknowledgeBundleRisk:true` because a data wipe can remove the cached JS bundle.
- **`qa_screen_record`** — screen video. *Inputs:* `action: start | status | stop`, `save?: always | on_failure`, `failed?`. *Outputs:* `recording`/`capturing`/`autoStopped`, `seconds`, and on stop a `uri` (mp4 artifact) + `bytes`. Consent-gated (medium); refused on sensitive sessions. Android uses `adb screenrecord --time-limit 180`; iOS uses `simctl io recordVideo`. One recording per session.

### Build and artifact resolution

- **`qa_resolve_target`** — choose the best device or simulator, deterministically and side-effect free. *Inputs:* `sessionId?`, `projectRoot?`, `platform?` (`android`/`ios`), `device?` (name/serial/udid), `preferRealDevice?`. *Outputs:* `selection` (kind + id), a human `reason`, `alternatives[]`, `preconditions` (e.g. WDA/signing), and `willBoot`. Does not boot anything — `qa_prepare_target`/`qa_ios` do that.
- **`qa_resolve_artifact`** — find the best installable artifact and explain the search. *Inputs:* `sessionId?`, `projectRoot?`, `platform?` (`android`/`ios`/`any`), `buildType?` (`debug`/`release`/`any`), `path?` (explicit artifact), `allowOutsideRoot?`, `requireInstallableOn?` (`android-emulator`/`android-real`/`ios-simulator`/`ios-real`). *Outputs:* the resolved `.apk`/`.aab`/`.ipa`/`.app` and its type; on failure, the exact globs searched plus a `qa_build { mode:"plan" }` → `qa_build { mode:"run" }` next step. Read-only.
- **`qa_build`** — plan or run a from-source build. *Inputs:* `mode?` (`plan` (default) / `run`), `platform` (`android`/`ios`), `variant?` (`debug`/`release`); `sessionId?`/`projectRoot?` for `mode:"plan"`; `sessionId` (required), `timeoutMs?`, `consentId?`/`approve?` for `mode:"run"`. *Outputs:* in `plan` mode the detected `framework`, the exact build commands, the expected artifact path, and a cost estimate — side-effect free, with a typed error when no supported framework (Expo, bare React Native, native Android/iOS, Flutter) is detected; in `run` mode a `jobId` to poll with `qa_job_status`, and on completion a build-log artifact and the re-resolved artifact path. `mode:"run"` is consent-gated (it compiles the app).
- **`qa_bundletool`** — convert an Android App Bundle to an installable APK. *Inputs:* `sessionId` (required), `aab?` (default: the best `.aab` under the project), `force?`, `connectedDevice?` (device-specific APK set vs a universal APK), `install?` (also run `install-apks`), `device?` (adb serial), `consentId?`/`approve?`. *Outputs:* the generated APK or APK-set path. `install` is consent-gated because it installs app code on a device/emulator.

### Feature-focused testing

- **`qa_app_map_feature_scope`** — map a feature to the app, read-only. *Inputs:* `query` (free text, e.g. "weather analysis") or `featureId` (exact map feature id), `sessionId?` (adds runtime screen-graph evidence), `projectRoot?` (static code scope), `platform?`, `includeCode?` (default true), `limit?`. *Outputs:* in query mode, ranked `candidates` each tagged by `source` (`code`/`screen`/`route`/`runtime`/`test`) with confidence, plus a test `objective` and `strategy`; in featureId mode, the map feature's source files, screens, coverage, blockers, and recommended plan. No consent. Query mode works before a map exists; returns `found:false` with guidance when nothing matches.
- **`qa_test_feature`** — run a focused test toward a named feature. *Inputs:* `feature` (required), `sessionId` (required), `mode?` (`plan` (default) / `execute` (focused run as a job) / `interactive` (run until the first question)), `platform?`, `device?`, `creativity?`, `allowAdversarial?`, `maxScreens?`, `maxActions?`, `timeoutMs?`, `generateCases?`, `consentId?`/`approve?`. *Outputs:* in `plan` mode the read-only test plan (scope, objective, generated cases, fixtures, execution plan); in `execute` mode a `jobId` whose run performs targeted exploration toward the feature, records cases, updates the feature map, and emits a report. `execute`/`interactive` are consent-gated.

### App-map maintenance and agent helpers

- **`qa_inspect`** — full attributes of one element. *Inputs:* `sessionId`, `ref` (e.g. `@e3`). *Outputs:* `class`, `id`, `contentDesc`, `text`, `bounds`, the interaction flags (`clickable`/`scrollable`/`focused`/`enabled`/…), and the raw `attrs`. Secret values are redacted and a secure field's value is masked as `«secure»`. Read-only; refs come from the most recent `qa_snapshot` and invalidate after navigation.
- **`qa_next_best_action`** — deterministic next-step recommendation. *Inputs:* `sessionId`, `goal?` (`smoke`/`explore`/`create_automation_suite`/`release_gate`/`test_login`/`reproduce_bug`). *Outputs:* `nextBestAction` (the `tool`, suggested `args`, and `why`). Read-only.
- **`qa_app_map_update`** — targeted, provenance-tracked map edits. *Inputs:* `projectRoot?`/`sessionId?` plus any of `note`, `testCases[]`, `automationSuite`, `environment`, `featureCoverage`. *Outputs:* `applied[]` and the `appMapUri`. Recomputes confidence and coverage and persists. Requires an existing map (`qa_app_map_build` first).

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
| "Create a flow" | `qa_generate` with `target:"flow"` |
| "Generate automation" | `qa_generate` with `target:"appium"` |

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
