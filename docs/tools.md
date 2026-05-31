# Tool Reference

Swipium v1 exposes 42 public MCP tools. The intended default entry point is `qa_test_this`.

## Start

Use these tools to orient the agent, start autopilot work, poll jobs, handle blockers, and fetch artifacts.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_agent_brief` | Returns the recommended orchestration rules for agents. | The agent needs the correct first call, polling behavior, report behavior, or blocker handling rules. |
| `qa_capabilities` | Lists the public v1 tool surface grouped by purpose. | The agent or user needs to discover available Swipium capabilities. |
| `qa_test_this` | Autopilot for "test it": resolves the project, finds or builds an artifact, prepares a simulator, runs smoke or exploration, reports results, and can generate suite output. | The user gives a low-context request such as "test this app". |
| `qa_job_status` | Polls a long-running job started by `qa_test_this` or prepare tools. | A tool returns a `jobId` with status `running`. |
| `qa_status` | Returns compact session status and recommended next action. | The agent needs to recover context during a session. |
| `qa_explain_blocker` | Explains a typed blocker, likely owner, and recovery path. | A run stops with a blocker and the user needs a concise explanation. |
| `qa_continue_from_blocker` | Resumes after user input and registers secret values for redaction. | A blocker asks for credentials, OTP, target choice, or approval data. |
| `qa_get_artifact` | Fetches artifact metadata or contents by `swipium://` URI. | A report, screenshot, dump, log, or generated file must be read. |

## Setup

Use these tools to verify the local environment, create sessions, and prepare simulator targets.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_doctor` | Checks Node, Android tooling, emulator availability, AVDs, and stale-client symptoms. | Before the first run or when setup fails. |
| `qa_start_session` | Opens a project QA session with budget, response mode, fixtures, and sensitive mode. | Running lower-level tools directly instead of `qa_test_this`. |
| `qa_detect_context` | Detects framework, project readiness, artifacts, devices, and likely blockers. | The agent needs a preflight view before selecting a path. |
| `qa_plan` | Produces a safe workflow plan before acting. | The user asks for a plan or the agent needs a low-risk next step. |
| `qa_prepare_target` | Prepares an Android Emulator target, installs or launches an APK, and binds the session. | Testing Android on an emulator. |
| `qa_prepare_ios_target` | Boots an iOS Simulator, installs a simulator `.app` when provided, launches a bundle id, and reports visual or WDA mode. | Testing iOS on a simulator. |
| `qa_ios` | Runs iOS Simulator lifecycle operations such as boot, install, launch, screenshot, logs, privacy reset, and erase. | Direct iOS simulator control is needed. |
| `qa_wda` | Checks, builds, or starts WebDriverAgent for structured iOS simulator automation. | iOS needs structured UI tree access instead of visual-only checks. |

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

## Run

Use these tools to run broader QA workflows and produce reports.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_smoke` | Runs launch smoke, baseline health, screenshot evidence, and saved flows. | The app is prepared and the agent needs a deterministic smoke pass. |
| `qa_explore` | Performs bounded guided exploration, builds a screen graph, and records evidence. | The agent needs to discover reachable workflows or collect runtime app-map data. |
| `qa_report` | Generates a session report with findings, blockers, evidence, mutations, workarounds, and next actions. | A run should be summarized or exported. |

## App Map

Use these tools to build and read Swipium's durable app knowledge map.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_app_map_build` | Builds or updates the app map from static analysis and runtime observations. | The project needs durable QA memory. |
| `qa_app_map_read` | Reads compact app-map sections such as features, screens, auth, automation, or test suite. | The agent needs app context without flooding the transcript. |
| `qa_app_map_query` | Searches features, screens, tests, and code links with ranked results. | The user asks about a feature, screen, or test surface. |
| `qa_app_map_feature_scope` | Resolves a feature query or feature id into focused testing scope and recommended plan. | The agent needs to test a specific feature. |
| `qa_app_map_validate` | Validates schema, provenance, links, duplicate ids, impossible states, and stale fingerprints. | The map must be trusted before feature-focused testing. |

## Flows and Suites

Use these tools to create, validate, run, and compile reusable test assets.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_flow_check` | Parses and statically validates a Swipium flow. | A flow file should be checked before execution. |
| `qa_flow_run` | Executes a Swipium flow against a prepared simulator session. | A saved flow needs to run against the app. |
| `qa_flow_generate` | Generates a flow from recorded actions. | A manual or exploratory run should become a reusable flow. |
| `qa_suite_generate` | Generates a POM-style suite from recorded behavior. | The run should become a structured test suite. |
| `qa_suite_compile` | Compiles a generated suite into runnable Swipium flows. | A generated suite needs executable flow output. |
| `qa_testcase_generate` | Generates test-case documentation from recorded behavior. | The run should produce human-readable test cases and steps. |

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
