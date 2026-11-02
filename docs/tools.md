# Tool Reference

Swipium exposes 55 public MCP tools, 7 MCP prompts, 3 MCP resource templates, and one fixed resource (the agent skill). It tests apps on local Android Emulators and iOS Simulators only; physical devices are out of scope (see [physical-devices.md](physical-devices.md)).

This page is the reference: conventions, one section per tool, the failure-code catalog, and the 1.5.0 migration table. Cross-cutting ideas (sessions and jobs, project root, consent, secrets, iOS modes, devices, glossary) are in [concepts.md](concepts.md); the flow file format and CI policy are in [flows.md](flows.md); environment variables are in the [README](../README.md#configuration--environment-variables).

**Contents**

- [Entry points](#entry-points) and [Conventions](#conventions): annotations, common parameters, response modes, the result envelope, and argument checking.
- [Tool index](#tool-index): one row per tool.
- Tool reference by capability group: [Start](#start), [Setup](#setup), [Build](#build), [Device](#device), [Drive](#drive), [Run](#run), [App map](#app-map), [Feature](#feature), [Flows](#flows), [Generate](#generate), [Test suite](#test-suite), [Issues](#issues), [First run](#first-run).
- [MCP resources and prompts](#mcp-resources-and-prompts), [Failure codes](#failure-codes), and [Migrating from 1.5.0](#migrating-from-150).

## Entry points

The default entry point is `qa_test_this {waitForCompletion:true}`; `mode` defaults to `"execute"`. The server sends the same rules as MCP `instructions` when a client connects, and `qa_status` without a `sessionId` returns them as structured data (see [qa_status](#qa_status)). The polling loop, job states, and `needs_input` handling are in [Sessions and jobs](concepts.md#sessions-and-jobs).

| User intent | First call |
| --- | --- |
| "Test it" | `qa_test_this {waitForCompletion:true}` (runs by default; `mode:"plan"` previews) |
| "How do I use Swipium?" | `qa_status` with no arguments |
| "Check my setup" | `qa_doctor` |
| "Test the X feature" | `qa_test_feature {feature}` (runs by default) |
| "Run a release gate" | `qa_test_this {goal:"release_gate", waitForCompletion:true}` or `qa_mobile_audit {profile:"release_gate"}` |
| "Drive the app myself" | `qa_start_session`, then `qa_prepare_target` or `qa_prepare_ios_target`; batch 3 or more known steps in one `qa_flow_run {sessionId, flowYaml}` |
| "Find or build an artifact" | `qa_resolve_artifact`, then `qa_build` |
| "Turn this run into automation" | `qa_generate` with `target:"flow"`, `"suite"`, or `"appium"` |
| "Export results for CI" | `qa_report` with `format`, or the `swipium report` CLI |

## Conventions

### Annotations

Every tool carries explicit MCP annotations, so clients can auto-approve the read-only ones. `openWorldHint` is `false` everywhere, because Swipium only talks to local simulators, local toolchains, and the local project.

| Kind | Annotations | Tools |
| --- | --- | --- |
| Read-only | `readOnlyHint:true, openWorldHint:false` | Marked **RO** in the [index](#tool-index). They do not change the device, the app, the project tree, or durable project memory. In-process session bookkeeping (counters, the last snapshot, health findings) does not count as a change. |
| Write | `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false` | Everything not listed elsewhere. |
| Idempotent write | `readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false` | `qa_job_cancel`, `qa_orientation`, `qa_geolocation`, `qa_network`, `qa_flow_compile`. |
| Destructive | `readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false` | `qa_ios` (`erase`, `privacy_reset`), `qa_app_control` (`clear_data`, `fresh_start`), `qa_app_map_update` (overwrites entries), `qa_suite_update` (`replace_generated` rewrites curated cases). |

Annotations describe the worst case of a tool. [Consent](concepts.md#consent) gates are what actually stop a mutation from running unapproved.

Two more hints for clients:

- **`_meta["anthropic/alwaysLoad"]: true`** on `qa_test_this`, `qa_status`, `qa_act`, and `qa_snapshot`, so clients with tool search keep the core loop loaded.
- **`outputSchema`** on `qa_act`, `qa_snapshot`, `qa_job_status`, and `qa_test_this`. The schemas are permissive (extra keys are allowed) and require only the core keys: `ok` on `qa_act` and `qa_snapshot`, `ok`, `jobId`, `kind`, and `status` on `qa_job_status`, none on `qa_test_this` (its consent envelope has no `ok`).

Tools carry no `execution` field (the spec default applies), and the tools capability is `{listChanged:false}`: the list never changes while the server runs. With `SWIPIUM_TOOLS=core` in the server env, `tools/list` shows only the core set (the one `swipium init codex` suggests for `enabled_tools`), and calling a hidden tool returns `INVALID_ARGUMENT` naming it and `SWIPIUM_TOOLS=all`. Everything that counts tools then counts the listed set: `qa_start_session`'s `toolCount` (plus `toolCountTotal` and `toolsMode:"core"`), the `qa_doctor` client-freshness check and `toolSurface`, the `qa_status` orientation (capability groups with no listed tool are left out), and the startup log line. Guidance that would name a hidden tool points at a listed one instead (for example `qa_flow_run mode:"plan"` instead of `qa_flow_check`).

### Common parameters

- **`sessionId`**: returned by `qa_test_this` or `qa_start_session`. An unknown `sessionId` returns `INVALID_ARGUMENT` (`Unknown sessionId "…"`) with nothing run.
- **`projectRoot`**: an absolute path. Tools that work before a session exists (build, artifact, app map, suite, issue ledger, flow check, feature plan) accept it. See [Project root](concepts.md#project-root).
- **`consentId` / `approve`**: the re-call half of a consent request. See [Consent](concepts.md#consent).
- **`mode:"plan"`**: on `qa_test_this`, `qa_build`, `qa_generate`, `qa_flow_run`, `qa_test_feature`, `qa_first_run`, and `qa_mobile_audit`, the plan mode is a side-effect-free preview. It is the default on `qa_build`, `qa_first_run`, and `qa_mobile_audit`. `qa_test_this` and `qa_test_feature` default to `execute` (since 2.3.0), `qa_generate` and `qa_flow_run` to their run modes.

### Response modes

`responseMode` controls the **text** channel, plus one thing in `structuredContent`: element lists. `structuredContent` always carries every field in every mode, but outside `verbose` the `elements` of `qa_snapshot` and `qa_act` are one-line `@eN` strings (see [Element lines](#element-lines)) instead of one JSON object per element. Claude Code and Codex show the model `structuredContent`, so the lines are what the model reads; they are about 40% smaller.

| Mode | Text channel |
| --- | --- |
| `compact` | The summary line plus any `swipium://` URIs (`artifactUri`, `artifactUris`, `screenshotUri`, `reportUri`). No JSON. |
| `normal` (default) | The summary plus one block of JSON. Fields the summary already rendered are left out of that JSON, and a `renderedAbove` key lists them: `elements` and `diff` for `qa_snapshot`; `elements`, `removed`, `hint`, and `stateChanged` for `qa_act`. `renderedAbove` exists only in the text; it is never in `structuredContent`. |
| `verbose` | The summary plus the full payload as JSON, including the fields `normal` leaves out (so there is no `renderedAbove`). `elements` in `structuredContent` (and in that JSON) are full objects: `ref`, `role`, `label`, `id`, `text`, `bounds`, `clickable`, `focused`, `secure`. |

The mode is a session setting, set by `qa_start_session` or `qa_test_this` (`responseMode`). Calls without a `sessionId` use the `responseMode` argument when the tool has one, else `normal`. The mode is chosen before a call runs, so `qa_test_this {sessionId, responseMode}` on an existing session takes effect from the next call. Errors are complete in every mode: their text is the same in `compact`, `normal`, and `verbose` (see [Result envelope](#result-envelope)).

### Result envelope

A success is `{ok:true, …payload}`. A budget stop is not: once a session budget is spent, a tool returns `{ok:false, stopped:true, performed:false, failureCode:"BUDGET_EXHAUSTED", reason}` (for example `action budget reached (60/60)`) and does nothing. It is not `isError` and is not recorded as a tool error; call `qa_report`, or start a session with a larger `budget` (before 2.3.0 a budget stop was `ok:true`). Some results add `notes[]` (non-fatal remarks, such as parameters ignored for the chosen mode, a clamped timeout, or a job still driving the device) or `warnings[]`.

Because Claude Code and Codex show the model `structuredContent` rather than the text block, a success's `structuredContent` also carries two copies from the text:

- **`summary`** (first key): the summary's first line, capped at 300 characters. `qa_job_status`, `qa_metro`, `qa_build` plans, and a finished `qa_test_this {waitForCompletion:true}` copy the whole summary instead (capped at 4000 characters), because their later lines say things the payload does not. Rendered `@eN` lines are never copied; they are already in `elements`. Left out when the payload has its own `summary`.
- **`next`** (last key): the next calls the summary suggests, as strings that start with the tool name (for example `qa_report to summarize what was verified`). Left out when there is none, or when the payload already has `next`, `nextSteps`, `nextBestAction`, `nextAction`, or `nextRecommendedAction`.

Errors carry neither; their guidance is `nextSteps`.

An error has `isError:true` and this `structuredContent`:

| Field | Meaning |
| --- | --- |
| `ok` | Always `false`. |
| `failureCode` | A code from the [catalog](#failure-codes). `UNKNOWN` when the error is not classified. |
| `what` | One sentence: what went wrong. |
| `changedState` | Whether anything on the device, app, or project changed before the failure. |
| `retrySafe` | Whether re-calling unchanged is safe. |
| `nextSteps` | Concrete recovery steps, usually exact calls. |
| `commandAttempted`, `artifactUri`, `clientHint` | Optional: the command that failed, evidence (for example a build log), and the stale-client hint. |

Triage fields (`bucket`, `owner`, `canSwipiumFix`) are not part of the error contract: get them from `qa_explain_blocker {failureCode}`, which returns them for any code. A `qa_test_this` terminal result lists its `blockers[]` with `failureCode`, `owner`, `retrySafe`, `canSwipiumFix`, `whatItMeans`, and `howToFix` (no `bucket`).

The text channel renders the same error, complete in every response mode: `❌ <failureCode>: <what>`, then `command: …` (when there is one), `changedState=… retrySafe=…`, `next: …` (one line, or `- ` bullets when there are several), and `hint: …`. A compact JSON block follows only for fields the head does not show; a list of strings the head already contains (such as `acceptedParameters` named in a next step) is left out. The head is capped at 5000 characters and the whole text at 10000.

Errors are size-capped, because they often echo caller input: `what` and each `nextSteps` entry keep the head and tail of anything over 2000 characters, at most 20 `nextSteps` are kept, and an error still over 64 KB drops its extra fields (listed in `extraDropped`). Successes are capped too: a success summary keeps the head and tail of anything over 20000 characters, and caller strings a success echoes back (a `qa_note` workflow or reason, a `qa_app_map_query` query) are cut at 2000 characters, as are the `qa_note` strings that get stored.

### Unknown arguments and stale clients

Every call is checked against the tool's input schema before anything runs, in this order: stale-client shapes, then unknown arguments, then per-field validation. Each refusal has `changedState:false` and `retrySafe:true`. A call whose arguments hold more than 10000 elements in total is refused with `INVALID_ARGUMENT` before any of these checks.

- **Unknown arguments**: every tool rejects top-level arguments its input schema does not declare. The call returns `INVALID_ARGUMENT` with `unknownArguments` (up to 20 names; `unknownArgumentCount` gives the total when there are more) and `acceptedParameters`. For example, `qa_app_control {action:"force_stop", appId:"…"}` is refused: `appId` is not a parameter, and the action always targets the session's app. Deprecated aliases that are still declared (`qa_wda udid`, `qa_suite_generate creativityLevel`, `qa_issue_log until`) are accepted. Inside nested objects (such as `qa_act target`), undeclared keys are dropped, not rejected.
- **Invalid values**: a missing required argument, a wrong type, a value outside an enum, or a number outside its bounds returns `INVALID_ARGUMENT` with `invalidArguments` (up to 20 `{path, message}` entries, such as `{path:"target.text", message:"Expected string, received number"}`) and `acceptedParameters`. `what` joins them: `qa_act: invalid arguments: action: Required. Nothing was run.`
- **Stale clients**: a client started before an upgrade may still send 1.5-era calls. Removed tool names, `qa_ios` with `action:"screenshot"` or `action:"wda_*"`, and `qa_wait` with `for:"job_done"` return `failureCode:"STALE_CLIENT"` with `removedCall`, `replacement` (the call to use), and `clientHint` (restart the client so it reloads the tool list). See [Migrating from 1.5.0](#migrating-from-150). A tool name that never existed gets the plain MCP `Tool <name> not found` error instead. `qa_doctor` with `expectedVersion`, `expectedToolCount`, or `expectedSchemaHash` detects the same condition.

### Jobs and cancellation

Long operations return a `jobId` to poll with [qa_job_status](#qa_job_status); cancelled work returns `CANCELLED`. The job lifecycle, status versus `result.state`, long-polling, and cancellation rules are in [Sessions and jobs](concepts.md#sessions-and-jobs). What each tool does when its call is cancelled is in its section.

A tool that drives the device (taps, installs, launches, boots, toggles device settings, records, or starts a job that does) still runs when the session has a job running, but while that job drives the same device the result gets a note: `job <jobId> is still driving this device; actions may interleave. Poll qa_job_status or qa_job_cancel first.` `qa_build` and `qa_bundletool` jobs run on the host and never trigger it, and neither do observation tools such as `qa_snapshot` or `qa_screenshot`.

Two sessions bound to the same simulator fight over the foreground app and the WDA session. `qa_prepare_ios_target` (and `qa_test_this` on iOS) warns in its result, and records a workaround, when another session in the same server process already drives that simulator. Nothing detects a second session on the same Android device, or a session in another Swipium server; use one session per device, or pin each server with `SWIPIUM_DEVICE`.

## Tool index

Hints: **RO** read-only, **D** destructive, **I** idempotent write, blank for other writes. **Consent** marks tools with at least one consent-gated action.

| Tool | Group | Hints | Consent | Summary |
| --- | --- | --- | --- | --- |
| `qa_test_this` | start |  | yes | Autopilot: resolve, build, prepare, smoke, explore, report, generate. |
| `qa_status` | start | RO |  | Orientation without a session; session state and `nextBestAction` with one. |
| `qa_job_status` | start | RO |  | Poll or long-poll a background job. |
| `qa_job_cancel` | start | I |  | Cancel a running job and its child processes. |
| `qa_explain_blocker` | start | RO |  | Explain a `failureCode`: meaning, owner, retry safety, fix. |
| `qa_continue_from_blocker` | start |  |  | Answer a `needs_input` question and resume the run. |
| `qa_get_artifact` | start | RO |  | Read a `swipium://` artifact (metadata or contents). |
| `qa_doctor` | setup | RO |  | Check Node, Android, iOS, WDA, and client freshness. |
| `qa_start_session` | setup |  |  | Open a session for low-level tools (budget, fixtures, sensitive mode). |
| `qa_prepare_target` | setup |  | yes | Android Emulator: bind or boot, Metro, install, launch. |
| `qa_prepare_ios_target` | setup |  | yes | iOS Simulator: boot, install `.app`, launch, WDA or visual-only. |
| `qa_ios` | setup | D | yes | iOS Simulator lifecycle (list, boot, install, launch, logs, erase, …). |
| `qa_wda` | setup |  | yes | Set up (one step), attach, build, start, stop, or diagnose WebDriverAgent. |
| `qa_resolve_target` | build | RO |  | Pick a device or simulator; optional project context and workflow plan. |
| `qa_resolve_artifact` | build | RO |  | Find the best installable `.apk`, `.aab`, `.ipa`, or `.app`. |
| `qa_build` | build |  | yes | Propose build commands, or build from source as a job. |
| `qa_bundletool` | build |  | yes | Convert an `.aab` into an installable APK or APK set. |
| `qa_device_info` | device | RO |  | Device facts: model, SDK, ABIs, locale, screen, packages; filtered Android logcat (`logs`). |
| `qa_orientation` | device | I |  | Set portrait, landscape, or auto rotation (Android). |
| `qa_geolocation` | device | I | yes | Spoof the GPS location (Android Emulator). |
| `qa_network` | device | I | yes | Airplane mode on or off, with automatic restore (Android 11+). |
| `qa_metro` | device |  | yes | Status, diagnose, start, or stop the RN/Expo Metro bundler. |
| `qa_app_control` | device | D | yes | Launch, foreground, background, stop, restart, or wipe the app. |
| `qa_screen_record` | device |  | yes | Record the screen to an mp4 artifact. |
| `qa_snapshot` | drive | RO |  | Structured UI elements (`@eN` refs) with a quality verdict. |
| `qa_inspect` | drive | RO |  | Full attributes of one `@eN` element. |
| `qa_act` | drive |  |  | One UI step (tap, type, swipe, scroll, press, open_url, wait), then observe. |
| `qa_clear_overlay` | drive |  |  | Dismiss the keyboard, dialogs, LogBox, sheets, or toasts. |
| `qa_check_health` | drive | RO |  | Crash, ANR, error-boundary, and foreground check. |
| `qa_screenshot` | drive |  |  | Screenshot artifact with coordinate-space metadata. |
| `qa_note` | drive |  |  | Record a workflow outcome for the report. |
| `qa_visual` | drive |  | yes | Screenshot checks: assert, baseline, diff, OCR find, image find. |
| `qa_wait` | drive | RO |  | Wait for `device_online`, `metro_ready`, `wda_ready`, or `simulator_booted`. |
| `qa_smoke` | run |  |  | Launch, baseline health, evidence, and every saved flow. |
| `qa_explore` | run |  | yes | Bounded, safe-by-default exploration job; builds a screen graph. |
| `qa_report` | run |  |  | Session report, plus optional CI exports. |
| `qa_app_map_build` | app-map |  |  | Build or update `.swipium/app-map.json`. |
| `qa_app_map_read` | app-map | RO |  | Read one compact app-map section. |
| `qa_app_map_query` | app-map | RO |  | Ranked search over features, screens, tests, and code. |
| `qa_app_map_feature_scope` | app-map | RO |  | Turn a feature name into a focused test scope. |
| `qa_app_map_update` | app-map | D |  | Targeted, provenance-tracked app-map edits. |
| `qa_test_feature` | feature |  | yes | Plan or execute a test of one named feature. |
| `qa_flow_check` | flows | RO |  | Statically validate a flow. |
| `qa_flow_run` | flows |  | yes | Run a flow, or preview it per backend. |
| `qa_flow_compile` | flows | I |  | Compile a POM suite on disk into runnable flows. |
| `qa_flow_repair` | flows |  |  | Suggest or apply a stronger locator for a failed step. |
| `qa_generate` | generate |  | yes | Flow, page objects, POM suite, test cases, or Appium code from a run. |
| `qa_suite_read` | test-suite | RO |  | Read the canonical suite `.swipium/test-suite.json`. |
| `qa_suite_update` | test-suite | D |  | Merge cases into the canonical suite. |
| `qa_suite_generate` | test-suite |  |  | Generate canonical cases from a recorded run. |
| `qa_suite_export` | test-suite |  |  | Export the suite as markdown, yaml, json, or junit. |
| `qa_suite_lint` | test-suite | RO |  | Lint the suite and generated page objects. |
| `qa_issue_log` | issues |  |  | The project issue ledger: history, log, fix, verify, suppress, metrics. |
| `qa_mobile_audit` | issues |  | yes | Plan or execute a named release audit profile. |
| `qa_first_run` | first-run |  |  | Get past login, sign-up, OTP, onboarding, permission, or paywall screens. |

## Start

Autopilot, orientation, job polling, blockers, and artifacts.

### qa_test_this

Autopilot for a low-context request such as "test this app". It resolves the project, finds or builds an artifact, picks a simulator, then plans or executes prepare > smoke > (explore) > report > (suite).

- **`mode`**: `execute` (the default since 2.3.0) returns `state:"running"` and a `jobId` at once, after any consent. `plan` has no side effects and returns the plan, preconditions, and any consent it will need. `interactive` asks the credentials question up front (when the project likely has a login and no credentials are available) and then runs as a job like `execute`.
- **`waitForCompletion:true`** blocks up to `timeoutMs` and returns the terminal result directly, or `state:"running"` with `timedOutWaiting:true` and the `jobId` to poll. The cap is `SWIPIUM_MAX_WAIT_MS` (default 50000, allowed 1000 to 230000; `swipium init claude` writes 110000) and the default window is that cap minus 5000 ms (45000 by default). Larger `timeoutMs` values are clamped to the cap with a note in `notes`, never rejected. The cap bounds the whole call, including the project scan, planning, and consent that run before the job starts, so the wait itself gets what is left. While it waits, a request that carries a `progressToken` gets MCP `notifications/progress` (at most one per second, only when the job's progress line changes). Cancelling that call ends the wait early with the same `state:"running"` result; the job keeps running.
- **`goal`** sets default flags; explicit `explore`, `generateSuite`, and `stopOnNeedsInput` win.

  | goal | Explore | Suite | Stops for input | Notes |
  | --- | --- | --- | --- | --- |
  | (none) | no | attempted | no | Smoke, then an attempt at a POM suite (skipped honestly when no actions were recorded). Not the fastest path. |
  | `smoke` | no | no | no | The fastest path. Same as `fastSmoke:true`. |
  | `explore` | yes | no | no | Maps reachable workflows. |
  | `create_automation_suite` | yes | yes | no | |
  | `release_gate` | yes | no | no | Adds the readiness and release-gate summary. |
  | `test_login` | no | no | yes | Stops for credentials when none are available (`SWIPIUM_TEST_EMAIL` and `SWIPIUM_TEST_PASSWORD` in the server env count, and skip the question). Always records a `login` outcome: `pass` when a login was performed and first-run completed, else `blocked` with the reason (credentials submitted but the run got no further, a login screen without credentials, or no login screen reachable). |
  | `reproduce_bug` | yes | no | no | Focus with `goalText`. The result echoes `goalText`, and a `reproduce_bug: <goalText>` outcome is recorded as `blocked` (not verified): reproduction is not judged automatically, so drive to the bug with `qa_act` and `qa_screenshot` and settle it with `qa_note` pass or fail. |

- **`device`**: an adb serial, AVD name, or simulator UDID or name. Without it, the run uses the session's bound device (when its platform matches), then the operator pin `SWIPIUM_DEVICE`, then the first online emulator or booted simulator. A requested device is booted or bound, never substituted: a requested simulator that can't be found is `NO_DEVICE`, and with `SWIPIUM_DEVICE` set a different device is refused with `DEVICE_PINNED` (see [Devices](concepts.md#devices)). The pin matches a serial, AVD, UDID or exact simulator name ignoring case, the same way as in `qa_prepare_ios_target` (`iphone 16` finds "iPhone 16"); a simulator name that several simulators share is refused with `MULTIPLE_DEVICES` before anything runs (pin by UDID). `targetChoice.reason` names the other online emulators or booted simulators that were not chosen.
- **Other parameters**: `platform` (`android` or `ios`, default inferred), `buildIfNeeded` (default true), `allowOutsideRoot`, `fastSmoke`, `responseMode` (`compact` returns the summary + URIs only; it stays the session's default for later calls), `consentId`/`approve`. `preferRealDevice:true` always returns `PHYSICAL_DEVICE_UNSUPPORTED`, even when no phone is connected (see [Devices](concepts.md#devices)).
- **Consent**: one combined `test_this_plan` consent covers build, boot, and install; its risk is the highest of its steps. The prompt names the target device (`adb -s <serial> install …`, `adb -s <AVD once booted> install …`, or `xcrun simctl install <udid> …`, and an Expo Android build runs `npx expo run:android --device <AVD>`), and `affects` carries `device`, so an approval is bound to that device. Its envelope carries `sessionId`, so the approving re-call reuses the session.
- **Terminal states** (in the `qa_job_status` result): `completed`, `blocked`, `unsafe`, or `needs_input`. Every terminal state writes a report, including `report.md`. The result keeps the report compact (`reportSummary`, `reportUri`, `reportMdUri`, `reportHtmlPath` and `reportHtmlUrl` for `report.html` (`null` when it could not be written), suite and app-map counts) and adds `releaseRisk`, `goalText` (when given), `attempted`, `workaroundsAttempted`, `artifactChoice`, `targetChoice`, `blockers[]`, and `nextRecommendedAction`. A `blocked` or `unsafe` run's report says the app was not tested (release risk `block`, app `NOT_RUN`, coverage `NONE`; see [qa_report](#qa_report)), so a run that stopped early never reads as SHIP. An app that never launched is `NOT_RUN` even when the session has earlier evidence; on iOS its `nextRecommendedAction` is the concrete recovery, for example `qa_ios {action:"boot"}` after a launch that timed out, or `qa_ios {action:"logs"}`.
  - `completed`: `reportHead` (the same failure-first summary as `report.md`, at most 2 KB: release risk, health, up to 8 failed or blocked workflows with their failing step and screenshot URI, up to 5 findings, the pass count, `Open the report: <reportHtmlPath>`, and the `report.json` and `report.md` locations) is in the result and in its text, so the outcome can be relayed without another call. `nextRecommendedAction` is `qa_get_artifact {uri: reportMdUri}`.
  - `blocked` / `unsafe`: `nextRecommendedAction` is the blocker's concrete fix when it is a Swipium call it can fill in (for example `qa_doctor {}` or `qa_prepare_target {sessionId}`; never `qa_test_this` itself), else `null`. The text ends with `fix (<CODE>): <howToFix>`.
- **needs_input**: the run stopped on one question it was asked to stop for (`stopOnNeedsInput`, `goal:"test_login"`, or `interactive`), such as a login form that needs credentials. The result carries `needsInput` (the question, its fields, and a `resume` call), and `nextRecommendedAction` is that call. When the question can be asked before any work starts, `qa_test_this` returns `state:"needs_input"` directly, with no `jobId`. Without those flags, the run completes with pre-login coverage and returns the question as `optionalQuestion`. Answering "test pre-login only" sets `loginOutOfScope:true` for the session.
- **Resumes**: a blocker resume replays the original `goal`, `goalText`, `device`, and flags, and every `needs_input` payload carries the resume call as `nextRecommendedAction`. Plan steps that route back through `qa_test_this` (a build or an `.aab` conversion) carry `mode:"execute"` and the original goal.
- **iOS without WebDriverAgent**: the WDA check looks where `qa_prepare_ios_target` does: the session's own WDA for the target simulator (from its last `start`, reuse or `attach`), then `ios.wda.url`, then this simulator's own managed WDA (its per-simulator port, or a WDA registered for its UDID), so a WDA on a per-simulator port such as 8689 counts. A WDA that answers but belongs to another simulator, or whose owner can't be checked (`unverified`), counts as unavailable. The default run (no goal, or `release_gate`) then skips suite generation and exploration, records a workaround, and runs the iOS smoke only. Only explicitly requested WDA work fails with `WDA_UNREACHABLE`: the `generateSuite` or `explore` flags, or goals `create_automation_suite`, `explore`, `reproduce_bug`, and `test_login`. Its `nextSteps` include a `goal:"smoke"` call, and `qa_wda setup` and `attach` with `device:"<udid>"`.
- **WDA hung after launch**: when WDA returns no UI source after the launch (for example hung on the app's splash after a cold simulator boot), the smoke re-probes once (5 s), then marks `launch_smoke` `blocked` with `WDA_UNREACHABLE` (a tool or environment failure, not an app bug), notes the saved flows `blocked (WDA_UNREACHABLE)` instead of replaying them, and the run stops `blocked` with `WDA_UNREACHABLE` and restart advice instead of going on to first-run or exploration. The whole wait is bounded at about 30 s from the launch (the settle after the launch counts against the render wait) plus that one 5 s re-probe, so about 35 s to the verdict, whether or not Metro is serving. After that no WDA call is made: the health verdict is built without WDA, the evidence screenshot comes from `simctl io screenshot`, and the report skips its triage UI dump. The note says how long WDA was silent (`for N s after the launch`). A WDA session that the smoke's launch (re)creates is capped at 15 s, and a timeout there counts as the same hang. `nextRecommendedAction` is `qa_wda {action:"stop"}` on the session's simulator, and the report's risk reasons say the run stopped before the app was tested, not that the app has a high-severity finding. A saved flow that fails with `WDA_UNREACHABLE` mid-smoke blocks the remaining flows too.
- **WDA hung at session creation**: during prepare, creating the WDA session for the launched app is capped at 15 s (`POST /session`; WDA's own default is 60 s). A timeout followed by a `/status` probe that also gets no answer (1.5 s) is a hung WDA, never a visual-only launch pass: the smoke doesn't relaunch or judge the screen, records `launch_smoke` `blocked` with `WDA_UNREACHABLE` and restart advice, takes a `simctl` screenshot, and notes every saved flow `blocked` without running it, so the run ends `blocked`. When `/status` still answers, the old visual-only fallback applies. When this simulator's own WDA is listening but doesn't answer `/status`, the `WDA_UNREACHABLE` text names it ("this simulator's own WDA at <url> is listening but did not answer /status within 1.5 s (hung)") instead of another simulator's WDA on 8100, and the first next step is `qa_wda {action:"stop", device}`, then `setup` and `attach`.
- **Consent retries**: an unknown, used, or expired `consentId` is never silently replaced. The result says `consent <id> unknown or expired; new challenge issued` in `consentNote` (with `previousConsentId`) and returns a new challenge.
- **React Native debug builds**: the smoke check waits (bounded) for the app to render, the same way `qa_smoke` does (see [qa_smoke](#qa_smoke)), so both give the same verdict. A screen that is still blank (no element besides the app's root), still on a Metro banner, or still on the app's own splash or loading screen when the wait ends (about 15 s blank, up to 30 s while Metro is serving or a loading screen is up) ends the run `blocked` with `BLANK_SCREEN` ("launch not verified"; the summary says "blank / splash / loading screen"), before first-run or exploration. A RedBox that says the bundle could not be loaded, or the Expo dev-client launcher ("No development servers found"), ends the run `blocked` with `METRO_REQUIRED` and `nextRecommendedAction` `qa_metro {action:"start"}`. When this project's Metro is already serving and only the dev client isn't connected, the blocker says so instead and gives the deep link to open (`xcrun simctl openurl <udid> "exp+<slug>://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`, or `adb -s <serial> shell am start -a android.intent.action.VIEW -d "<link>"`; `<slug>` comes from `expo.slug` in `app.json`, and without one it says to tap the server or "Enter URL manually" in the dev client), with `nextRecommendedAction` `null`. When this project's Metro answers on `localhost` (`::1`, IPv6) but nothing answers on `127.0.0.1:8081`, where the app and dev client connect, the `METRO_REQUIRED` blocker says so ("Metro is serving on localhost (::1) … nothing answers on 127.0.0.1") and says to restart Metro listening on all interfaces (drop `--localhost` or a `::1`-only host), instead of "start Metro". Another project's Metro on the port is `METRO_WRONG_PROJECT` on iOS too.
- **Android build and boot order**: when the run builds the app and has to boot an AVD, it boots the AVD first (Swipium's own headless boot, under the same consent) and then builds, so `npx expo run:android --device <AVD>` finds it running. A boot failure blocks the run with the boot's code before anything is built.
- **Failure codes**: `PROJECT_ROOT_UNRESOLVED`, `PROJECT_ROOT_EMPTY`, `NOT_MOBILE_PROJECT`, `NO_BUILD_ARTIFACT`, `BUILD_FAILED` and the typed build codes, `PHYSICAL_DEVICE_UNSUPPORTED`, `ADB_NOT_FOUND`, `NO_DEVICE`, `DEVICE_PINNED`, `MULTIPLE_DEVICES` (an ambiguous pin), `METRO_REQUIRED`, `METRO_WRONG_PROJECT`, `BLANK_SCREEN`, `WDA_UNREACHABLE`, `IPA_NEEDS_REAL_DEVICE`. A project root of `/`, your home directory, or a shared system or user folder (`/tmp`, `/Users`, `/Applications`, `~/Library`, `~/Downloads`, `~/Desktop`, and similar) is refused with `PROJECT_ROOT_UNRESOLVED` before any directory walk. A directory with no recognizable project but a prebuilt simulator `.app` or `.apk` within 2 directories of the root, whose app id can be read, is tested as that artifact (only an artifact within those 2 directories is installed, and WebDriverAgent or XCTest runner bundles never count); a shared folder never counts (see [Project root](concepts.md#project-root)). With `SWIPIUM_DEVICE` set, a `platform` the pin overrides is noted in `targetPlan.reason` and as a workaround. With `SWIPIUM_DEVICE` set to a device that matches nothing online, the plan's `NO_DEVICE` names the pin and says to fix or unset it and restart the server.
- **Health on a blocked run**: the result's `health:{native, app}` comes from the report, so a run that never reached the app says `not checked`, not `OK`.
- **Return time**: with `waitForCompletion:true` the call returns at or just under the cap (it keeps about 10% of the cap, at most 2 s, for building the response). Scan and planning that take longer than a very small cap can still overrun it.

### qa_status

- **Without `sessionId`**: first-call orientation, the same rules the server sends as MCP `instructions`: `{orientation:true, swipiumVersion, tools, prompts, firstCall, polling{tool, args, until, terminalStates}, report, goals, rules{needsInput, blocker, consent, stop, iosVisualOnly, batching, appControl, credentials}, capabilityGroups[{group, purpose}], nextBestAction}`. `firstCall` is `qa_test_this {mode:"execute", waitForCompletion:true}`, `report` reads `report.md`, and the groups list names and purposes only (the tool names are already in `tools/list`). Call it when the client dropped the server instructions or the agent lost context.
- **With `sessionId`**: `{sessionId, root, device, appId, mode, budgetRemaining, counters, recordedActions, findings, notes, workarounds, inputsProvided, readiness, lastJob, nextBestAction}`. `goal` biases the recommendation. After a restart with no live driver, `mode` and the platform come from the persisted `driverKind`.
- **Device liveness**: with a bound device it checks that the device is still there (one `adb devices` or `simctl list` call). When the emulator is gone or the simulator is no longer booted, the result adds `deviceOnline:false`, `mode` is `unknown`, the summary says `(offline)`, and every step in the ladder below (`qa_smoke`, `qa_generate`, `qa_report` and the rest) becomes `qa_prepare_target {sessionId}` (Android) or `qa_prepare_ios_target {sessionId, device}` (iOS). `deviceOnline:false` takes priority over every next step except relaying a blocker's fix and reading an existing report (`qa_get_artifact`).
- **Orphaned network change**: when a server that crashed left airplane mode changed on this session's device (its owning process is gone), the result adds `warnings:[…]` and a `WARNING:` summary line naming the session that made the change and the call that restores it (`qa_network {sessionId, action:"restore"}`).
- **`nextBestAction`** is `{tool, args, why}`. The first matching rung wins, and every rung checks state that the recommended call changes, so following it never loops:
  1. A job is running: `qa_job_status`.
  2. The last `qa_test_this` job ended and nothing ran after it. Blocked or unsafe and the fix not yet relayed: the job's fix call (its `nextRecommendedAction`) once, with the fix in `why`; when the fix is outside Swipium (`null`), the ladder continues with the fix prefixed to `why`. `needs_input` already answered with `qa_continue_from_blocker`: `qa_test_this` again. Otherwise the job's own `nextRecommendedAction`, unless it is already done.
  3. No device is bound: `qa_test_this`.
  4. No app is running: `qa_prepare_ios_target` (iOS) or `qa_prepare_target`.
  5. No smoke has run and no actions are recorded: `qa_smoke`. A smoke counts once its milestone is persisted, not by counting actions.
  6. Findings exist and no report is newer: `qa_report`.
  7. A clean run has recorded actions but no generated assets: `qa_generate {target:"suite"}`.
  8. No report is newer than the last activity: `qa_report`.
  9. Otherwise: `qa_get_artifact` on the latest report. The run is done.

### qa_job_status

Polls a job. Parameters: `sessionId`, `jobId`, `waitMs` (default 0, return at once; otherwise long-polls until the job leaves `running`; use 45000). `waitMs` is capped at `SWIPIUM_MAX_WAIT_MS` (default 50000, so one call ends before a 60 s client tool timeout; allowed 1000 to 230000); larger values are clamped. While it waits, a request with a `progressToken` gets MCP `notifications/progress` (at most one per second, only when `progressDetail` changes, with a strictly increasing `progress`). An unknown `jobId` is `INVALID_ARGUMENT`. Cancelling the call ends the wait with `CANCELLED` and leaves the job running (use `qa_job_cancel` to stop it). Returns `{jobId, kind, status, progress, progressDetail, error, result, artifactUris}`, plus `waited:{waitedMs, timedOut}` when `waitMs` is set. See [Sessions and jobs](concepts.md#jobs).

### qa_job_cancel

Cancels a running job and aborts its child processes. Returns `{jobId, cancelled}`; `cancelled:false` means the job had already finished or is unknown. See [Cancellation](concepts.md#cancellation).

### qa_explain_blocker

Explains any code in the catalog: `{failureCode, bucket, owner, severity, retrySafe, canSwipiumFix, whatItMeans, whoFixesIt, howToFix, context}`. This is the source for a code's bucket, owner, and `canSwipiumFix`. Parameters: `failureCode` (required), `context` (free text, echoed back), and `sessionId` (marks the blocker as explained, so `qa_status` moves past it). An unknown code is `INVALID_ARGUMENT`.

### qa_continue_from_blocker

Answers a `needs_input` question. Parameters: `sessionId`, `kind` (for example `credentials` or `monorepo_target`), `values` (a map of field to value), and `secretFields`.

- A value is secret when its field name looks like a credential (the [secret-name rule](flows.md#variables), matched on whole name parts, so `pin` counts but `shipping` doesn't) **or** the field is listed in `secretFields`, which adds to that rule and never replaces it.
- Secret values join the redaction set immediately and are never echoed or logged. They are held in memory only, so after a server restart a login run asks again.
- Non-secret choices (`platform`, `device`, `target`, `allowOutsideRoot`) map onto the re-invocation's arguments.
- Returns `accepted`, `ignored[]` (each with how to apply it), `nextAction`, and `projectRoot` for a `monorepo_target` answer.
- **Direct resume**: when the resume is a `qa_test_this` call and the session is prepared (a device and app are bound), it starts that run itself and returns `resumed:true`, the new `jobId`, `state`, and `nextAction: qa_job_status {sessionId, jobId, waitMs}`. If the re-run would need a new consent, it returns the `qa_test_this` call as `nextAction` instead, so the consent is asked on `qa_test_this`. On an unprepared session it returns `nextAction` only.
- Credentials answers add a `tip`: set `SWIPIUM_TEST_EMAIL` and `SWIPIUM_TEST_PASSWORD` (and `SWIPIUM_TEST_OTP`) in the server env, so later runs don't ask and the password never enters the chat.
- A `monorepo_target` must be an existing directory inside the project root (one of the offered candidates). `/`, `~`, or any path outside the root is `INVALID_ARGUMENT`.

### qa_get_artifact

Reads a `swipium://session/<id>/<kind>/<name>` artifact, or a project app-map URI (`swipium://project/<id>/app-map`, or one section `…/app-map/<kind>/<id>`; text capped at 1 MB, `NO_APP_MAP` when there is none), for clients without MCP resources. `mode` defaults to `inline` for text and `metadata` for images and every other binary (screen recordings, archives). `metadata` on an app-map URI returns `{uri, mime, kind:"app-map", bytes, path, hint}` (`path` for the whole map only) instead of the content. `metadata` returns `{uri, mime, kind, bytes, path, redaction, hint}`; `inline` returns an image as image content and any other binary as a base64 blob resource. An inline image comes as a text block (the URI, any redaction note, and a scale line) plus the image, with no `structuredContent`, and carries `_meta["codex/imageDetail"]: "auto"`. On macOS a PNG whose long edge is over 1568 px is downscaled with `sips` to a 1568 px JPEG; the scale line gives the factor so coordinates map back. Elsewhere, or when `sips` fails, the image is unchanged (scale 1). Text over 1 MB returns the first 1 MB (the last 1 MB for logs, including `*.log` files) with a `[swipium: truncated ...]` marker naming the local file; binaries over 8 MB are not inlined (the result names the local file instead). MCP `resources/read` applies the same caps. A text artifact whose redaction was `partial` reports `redaction:"partial"` plus `redactionNote` in metadata, and a separate warning block when inlined (see [Secrets and redaction](concepts.md#secrets-and-redaction)). An unknown URI returns `INVALID_ARGUMENT`.

## Setup

Check the toolchain, open a session, and prepare a simulator.

### qa_doctor

Checks Node, the Android SDK and emulator, Xcode and `simctl`, WDA, and client freshness. `platform` is `android`, `ios`, or `both` (default `both` on macOS, where it is ready if either platform is; `android` elsewhere). Each check carries `platform` (`android` or `ios`); there is no separate `checksByPlatform`. `simulators` lists booted simulators only, and `simulatorCount` is the total. The `adb` and emulator rows add a hint when platform-tools or the emulator is older than major version 36 (for example `(platform-tools 35; 36+ recommended: sdkmanager "platform-tools")`). `client` (`claude`, `gemini`, `codex`, `cursor`, or `vscode`) adds a `clientHint` with registration advice. When the connected client is Codex (or `client:"codex"`), the result adds two optional rows and a `codex` field:

- **`codex-env`**: Codex passes MCP servers only a fixed env whitelist plus `env_vars` and the `env` table, so shell exports never arrive otherwise. The row lists which Swipium env names are visible (names only, never values) and warns when no Android SDK is found or `java -version` fails without `JAVA_HOME`: forward `ANDROID_HOME` / `JAVA_HOME` if you installed them in a custom location, or install them first. Approval grants (`SWIPIUM_CONSENT_PREAPPROVE`, `SWIPIUM_ALLOW_REMOTE_WDA`) are never in the default list; set them literally in `env = { ... }`.
- **`codex-tool-timeout`**: a reminder to keep `tool_timeout_sec` at 600 or more and `startup_timeout_sec` at 30 (the server cannot read them; `swipium init codex` writes both).
- **`codex`**: `{envVarsLine, toolTimeoutSec}`, the exact `env_vars = [...]` line for `[mcp_servers.swipium]`; the text output prints it too.

`expectedVersion`, `expectedToolCount`, and `expectedSchemaHash` add a `client-freshness` check that reports a stale client; with `SWIPIUM_TOOLS=core` it compares against the listed tool count. The summary's stale-client paragraph appears only on a schema-hash mismatch.

A `project-root` row (a warning, never a hard failure) shows the project root calls without `projectRoot` would use and where it came from, or why none resolves (for example `SWIPIUM_PROJECT_ROOT="app" is not an absolute path (skipped)`) with the fix. The same is in the `projectRoot` field: `{resolved:true, root, source}` or `{resolved:false, hint}`. `ready` still reflects the toolchain only, and an unresolved root never makes the server's working directory count as the project: the WDA cache check then covers an installed Appium WebDriverAgent only, and `wda.projectRoot` and `wda.config.derivedDataPath` are `null`.

The structured `summary` is the version headline plus the readiness sentence (`Swipium v… · N tools · schema … · <readiness>`), including an unsupported Node.js version.

### qa_start_session

Opens a session. Only needed for low-level tools; `qa_test_this` creates its own.

- **`budget`**: defaults to 30 minutes, 60 actions, 40 screenshots (8 minutes, 20 actions and 8 screenshots before 2.3.0), 3 consecutive snapshot failures (`maxSnapshotFailures`), and 3 no-change actions (`maxNoChangeActions`). `profile` sets the time budget instead: `guardrail` 8 min, `login_smoke` 10, `full_smoke` 15, `install_smoke` 20. A session keeps the budget it was created with, so sessions from an older version keep theirs. Everything that runs on the device counts, including the smoke, flow replays and exploration inside `qa_test_this`. Once a budget is spent, tools return a budget stop (`ok:false`, `failureCode:"BUDGET_EXHAUSTED"`, `performed:false`; see [Result envelope](#result-envelope)) and do nothing.
- **`toolCount`**: the number of tools the client can see. With `SWIPIUM_TOOLS=core` it is the listed count, plus `toolCountTotal` and `toolsMode:"core"`.
- **`responseMode`**: see [Response modes](#response-modes).
- **`sensitive:true`**: refuses every screenshot, recording, log capture, and other on-screen evidence (`SENSITIVE_MODE_REFUSED`). Sensitive sessions are never listed as MCP resources.
- **`fixtures`**: declared preconditions, merged with `.swipium/fixtures.json`, so unmet ones report as blocked instead of failed. The schema advertises only `{name, …}`; the full shape is validated server-side, and a bad shape returns `INVALID_ARGUMENT`. Values passed here are held in memory: after a server restart, a fixture that is not also in `.swipium/fixtures.json` comes back without its `value`, field values, or `seed` (see [Sessions](concepts.md#sessions)). The full shape:

```jsonc
{
  "name": "saved_flight", // required
  "description": "…",
  "requiredState": "at least one saved flight",
  "recommendedSetup": "…",
  "testAccount": "…",
  "apkPath": "…",
  "value": "BA123", // non-secret test input for exploration text entry
  "disposable": true, // only for data destructive QA may mutate or delete
  "environment": "test",
  "fields": {
    // typed catalog for form entry, matched by label, id, or role
    "email": { "var": "SWIPIUM_TEST_EMAIL", "secret": false }, // var: SWIPIUM_* names only
    "name": { "generator": "full_name" }, // email, person_name, full_name, number, text, city, country, color, phone, date, …
  },
  "seed": {
    // opt-in, consent-gated way to create the precondition
    "type": "script", // deeplink | script | api
    "command": ["node", "scripts/seed.js"],
    "idempotent": true,
    "cleanup": { "type": "api", "url": "http://localhost:3000/reset", "method": "POST" },
  },
}
```

### qa_prepare_target

Prepares an Android Emulator in order: device > Metro > install > launch, then verifies the foreground.

- **Parameters**: `sessionId`, `apk`, `appId`, `avd`, `device` (required when more than one device is online), `headless` (default true), `force`, `bindOnly` (bind or boot plus `adb reverse` only, which breaks a device/Metro deadlock), `allowLaunchWithoutMetro` (launch a debug RN/Expo build without Metro; it may show a RedBox), `consentId`/`approve`.
- **Consent**: one combined `prepare_plan` consent for the privileged steps. Every install is gated: an APK inside the project root is risk low, an external one medium (the prompt shows its sha256). Inside-ness is decided on resolved real paths, so `<root>/../x.apk` and symlinks that leave the root count as external. The prompt names the target (`adb -s <serial> install …`, or `adb -s <AVD once booted> …` when it will boot one) and `affects` carries `device`. An already-installed app launches without a prompt, and a boot lists an install only when an APK for the app is known.
- **APK**: the `SWIPIUM_DEVICE` pin is checked before the APK lookup, so a pinned-device refusal comes first. Without `apk`, the project's APK is found the same way `qa_test_this` finds it (Gradle outputs included). With an explicit `appId`, only an APK whose package is that `appId` is used. When an install is needed and no such APK exists, the call fails before any consent with `NO_ARTIFACT`, suggesting a close installed package (`Did you mean appId=…`); an APK whose `applicationId` can't be read is `NO_ARTIFACT` too. `qa_prepare_target` is the Android path; for an iOS app use `qa_prepare_ios_target`.
- **Device selection**: it acts on the online device rather than planning one. With several devices online (a phone included) and no `device`, it returns `MULTIPLE_DEVICES` listing the online serials; a phone that is the only online device is refused. `avd` (without `device`) means that AVD: Swipium binds the emulator already running it, or boots it, and never falls back to another device; an unknown AVD is `NO_DEVICE` with the AVDs that exist. When the session's own emulator went offline, it is booted again as its own AVD; if that AVD is unknown the result is `DEVICE_NOT_READY`, never a different AVD. With `SWIPIUM_DEVICE` set, only the pinned device is used, and a different `device` or `avd` is refused with `DEVICE_PINNED`. See [Devices](concepts.md#devices). Boot and install run as a job and return a `jobId`; a failed job has `error: "<CODE>: …"` and `result.failureCode`.
- **Metro**: the Metro gate and `adb reverse` apply only to the project's own app (its Expo `android.package` or Gradle `applicationId`, including suffixed variants). An explicit `appId` of another package, such as a system app, launches without Metro. A Metro on port 8081 that serves another project's bundle (its `X-React-Native-Project-Root` header names another root) is `METRO_WRONG_PROJECT`, not ready.
- **Boot**: an AVD Swipium boots quick-boots from its snapshot and never saves over it (`-no-snapshot-save`; an AVD without one gets one saved after its first, cold boot), renders with `-gpu auto`, and is polled for readiness every 0.5 s. `SWIPIUM_EMULATOR_GPU` overrides the renderer (for example `swiftshader_indirect` on a GPU-less CI host) and `SWIPIUM_EMULATOR_COLD_BOOT=1` forces a cold boot (`-no-snapshot-load`).
- **Launch**: the app's launcher activity is resolved with `cmd package resolve-activity --brief` and started with `am start -W` (an app that is already running is brought forward, not restarted), with `monkey` as the fallback. The call waits until the app is in the foreground (polling every 250 ms, up to 2.5 s), then reads the foreground once more 1 s later, so an app that crashes right after its first frame reports `launchedOk:false`.
- **RedBox check**: after launching a debug React Native or Expo build, it reads the screen once. A RedBox that says the bundle could not be loaded, or the Expo dev-client launcher, makes the call fail with `METRO_REQUIRED` ("launched, but the app shows …", `changedState:true`, with `appError`) instead of a plain success, and `qa_report` treats the session as not tested with `METRO_REQUIRED` until a Swipium outcome runs after it. A JavaScript error RedBox is recorded as an app finding, and the result says "not ready to test" with `ready:false` and `appError`. A job (install or boot) does the same: the job fails with `METRO_REQUIRED: …`, or finishes with `ready:false`.
- **Failure codes**: `PHYSICAL_DEVICE_UNSUPPORTED`, `MULTIPLE_DEVICES`, `NO_DEVICE`, `EMULATOR_BOOT_FAILED`, `DEVICE_NOT_READY`, `NO_ARTIFACT` (no APK to install), `INSTALL_FAILED`, `APK_ARCH_INCOMPATIBLE`, `ANDROID_MIN_SDK_INCOMPATIBLE`, `ANDROID_SIGNATURE_CONFLICT`, `METRO_REQUIRED`, `METRO_WRONG_PROJECT`, `DEVICE_PINNED`, `APP_LAUNCH_FAILED`, `DEVICE_UNRESPONSIVE` (the launch command timed out on a slow or still-booting emulator; `qa_wait {for:"device_online"}`, then retry), `INVALID_ARGUMENT` (for example a malformed app id). A launch of an already-installed app that fails returns one of these codes with next steps, never a raw `adb` error.

### qa_prepare_ios_target

Prepares an iOS Simulator: picks and boots one, installs a simulator `.app`, launches `bundleId`, verifies the foreground, and reports whether WDA structured automation is available or the session is visual-only.

- **Parameters**: `sessionId`, `app` (absolute or project-relative; omitted with no `bundleId` and no session app, the project's best simulator `.app` inside the root is used, under the same install consent), `bundleId`, `device` (UDID or unique exact name, ignoring case; a name several simulators share is `MULTIPLE_DEVICES`), `launch`, `attachWda`, `allowLaunchWithoutMetro` (launch a debug RN/Expo `.app` without a serving Metro; it will show a RedBox), `consentId`/`approve`.
- **Simulator**: `device`, else the session's simulator, else the operator pin `SWIPIUM_DEVICE`, else a booted simulator. A requested simulator is booted if needed, never substituted: one that can't be found is `NO_DEVICE`, and with `SWIPIUM_DEVICE` set a different one is refused with `DEVICE_PINNED`. The pin is checked before the consent prompt: a pin that matches no available simulator (by UDID or exact name, ignoring case) is `NO_DEVICE` naming `SWIPIUM_DEVICE`, with a fix-or-unset-it next step.
- **`launch:false`**: with an explicit `bundleId`, the session's app is still set to it (nothing is launched or install-checked), so later snapshots and `qa_smoke` treat it as the app under test.
- **Pin**: `SWIPIUM_DEVICE` matches a UDID or an exact simulator name ignoring case, as in `qa_test_this`; a name that several simulators share is refused with `MULTIPLE_DEVICES` before the consent prompt (pin by UDID).
- **`attachWda`**: `auto` (default) probes WDA and stays visual-only, with a recorded workaround, when it is unreachable, non-loopback, belongs to another simulator, or session creation fails while WDA's `/status` still answers. Creating the session is capped at 15 s; a timeout with `/status` also silent is a hung WDA: `auto` returns ok with `wda.reachable:false`, `wdaHung`, restart advice in the text and a `blocked` `wda_attach` ledger entry, and a `qa_test_this` run on it ends `blocked` with `WDA_UNREACHABLE` (see [qa_test_this](#qa_test_this)); a standalone `qa_smoke` afterwards gives the same `WDA_UNREACHABLE` verdict (launch blocked, saved flows not run) until WDA answers again or is restarted. `required` fails instead (`WDA_UNREACHABLE`, also for a hung WDA, `WDA_SESSION_FAILED`, `STALE_WDA_DEVICE` for another simulator's WDA, or `DESTRUCTIVE_REFUSED` for a non-loopback URL). `skip` does not probe. It tries the session's own WDA for this simulator first, then this simulator's own port (see [qa_wda](#qa_wda)).
- **Visual-only settle**: after a successful visual-only launch, the call waits (up to about 4 s, usually 1 to 2 s) for two identical screenshots before it answers ready, so a screenshot right after it doesn't catch the launch animation.
- **RedBox and alert check**: after a WDA-structured launch, it reads the UI source once (about 0.3 s). A RedBox that says the bundle could not be loaded ("No script URL provided", "Unable to load script"), or the Expo dev-client launcher, makes the call (or the `prepare_ios` job) fail with `METRO_REQUIRED` ("launched, but the app shows …", with `appError`) instead of "ready", and `qa_report` treats the session as not tested with `METRO_REQUIRED` until a Swipium outcome runs after it, so a `qa_note` pass can't turn it into a tested run. A JavaScript error RedBox is recorded as an app finding, and the result says "not ready to test" with `ready:false` and `appError`. An iOS alert on top of the app (for example SpringBoard's "Sign in to your Apple Account") is named in the text and in `alert`, with a `qa_clear_overlay` hint. A visual-only launch has no UI source, so nothing is checked there.
- **Checks before consent**: `app` is validated before any prompt: a `.ipa` is `IPA_NEEDS_REAL_DEVICE`, a missing path is `IOS_SIMULATOR_APP_MISSING`, and a device (`iphoneos`) build is `IOS_APP_WRONG_ARCH` (binary and XML `Info.plist` both read). A `bundleId` that differs from the `.app`'s own is noted in the result.
- **Metro**: a debug React Native or Expo `.app` (it ships the React Native or Expo runtime but no `main.jsbundle`) is not launched while Metro isn't serving this project: the result is `METRO_REQUIRED` with a `qa_metro {action:"start"}` next step, or `METRO_WRONG_PROJECT` when another project's Metro holds the port (stop it, then start this project's), unless `allowLaunchWithoutMetro:true`. The check runs before the install, so a blocked call leaves the simulator unchanged (`installed:false`). An app passed only by `bundleId` is checked too, by reading its installed `.app` (`simctl get_app_container`); if that lookup fails, it launches as before.
- **Consent**: `install_app`, risk low for an app inside the project root, medium outside it. The prompt names the simulator (`xcrun simctl install <udid> …`, "booting it if needed").
- **Cold boot**: the call waits at most 30 s for the simulator to boot. If it is still booting, the simulator is bound to the session and the call returns `ok` with `status:"booting"`, `udid`, `name`, `elapsedMs`, and a `jobId`: the rest (boot, install, launch, WDA check) runs as a `prepare_ios` job with the consent already given. Poll `qa_job_status {jobId, waitMs:45000}`; the finished job's `result` has the same fields as a direct answer.
- **Failure codes**: `IPA_NEEDS_REAL_DEVICE` (a `.ipa` is refused), `IOS_SIMULATOR_APP_MISSING`, `IOS_APP_WRONG_ARCH`, `NO_DEVICE`, `DEVICE_PINNED`, `SIMULATOR_RUNTIME_MISSING`, `SIMULATOR_BOOT_FAILED`, `SIMULATOR_BOOT_TIMEOUT`, `METRO_REQUIRED`, `METRO_WRONG_PROJECT`, `BUNDLE_ID_NOT_FOUND` (the app is not installed), `APP_LAUNCH_FAILED` (installed but the launch failed or timed out; a timed-out `simctl launch` child is killed), `STALE_WDA_DEVICE`, `MULTIPLE_DEVICES` (an ambiguous pin), `WDA_UNREACHABLE` (with `attachWda:"required"`).

### qa_ios

Direct iOS Simulator control (macOS only). `action` is one of:

| action | Parameters | Consent |
| --- | --- | --- |
| `list` | | |
| `boot` | `device` (UDID or exact name; default: the pinned simulator, else the one booted simulator, else the first iPhone; several booted is `MULTIPLE_DEVICES`). Binds the simulator to the session. | none (low-risk, reversible) |
| `install` | `app` (a `.app`, absolute or project-relative; a `.ipa` or device build is refused before the prompt) | `install_app`, medium |
| `launch`, `terminate` | `bundleId` | |
| `openurl` | `url` (deep link) | |
| `logs` | `last` (default `5m`) | |
| `privacy_reset` | `service` (for example `location`, `photos`, `camera`, `all`), `bundleId` (default: the session's app) | `privacy_reset`, low |
| `erase` | `device` (default: the bound simulator), resolved to its UDID before the prompt, which shows that UDID. Wipes the simulator. | `erase_device`, high |

`boot` waits at most 40 s. A booted simulator returns `status:"booted"`. A cold boot that takes longer returns `ok` with `status:"booting"`, `udid`, `name`, `elapsedMs`, and `next`; the simulator is already bound and keeps booting in the background, so poll `qa_wait {for:"simulator_booted"}` before `install` or `launch`. Cancelling the call returns `CANCELLED` (`changedState:true`) and leaves the boot running.

`launch` failures are typed: `NO_DEVICE` when the simulator is shut down, `BUNDLE_ID_NOT_FOUND` when the app is not installed, else `APP_LAUNCH_FAILED` (including a launch that timed out, often a device build that the simulator refuses; the stuck `simctl launch` is killed). Launching a bundle other than the session's app (Safari, Settings) never changes the app under test: the result adds `appUnderTest` (the session's app) and says to start a new session to test the other one, and that launch doesn't count as reaching the app in `qa_report`. A session with no app yet adopts the launched bundle.

`device` is an available simulator's UDID or its exact name, both ignoring case (never a substring or `booted`). A name that matches no simulator is `INVALID_ARGUMENT`; one that several simulators share is `MULTIPLE_DEVICES` listing them. Neither ever falls back to a booted simulator. On actions other than `boot` and `erase` it must be the session's bound simulator: another one is refused (`DEVICE_PINNED` under the pin, else `INVALID_ARGUMENT`, "not this session's simulator … nothing was done"); omit it, or bind the other simulator first.

With `SWIPIUM_DEVICE` set, `boot` without `device` boots the pinned simulator (never "the first booted"; a pin that matches no simulator is `NO_DEVICE`), and `boot`, `install`, `privacy_reset` and `erase` on any other simulator are refused with `DEVICE_PINNED` before the consent prompt, so a pre-approved `erase_device` can't reach another simulator. A pinned name that several simulators share is `MULTIPLE_DEVICES` for all of them. With an Android pin, every simulator boot or erase is refused.

Every action except `list` and `boot` needs a simulator bound to the session (by `boot`, `qa_prepare_ios_target`, or `qa_test_this`), else `NO_DEVICE`. Screenshots go through `qa_screenshot`, and WebDriverAgent through `qa_wda`. The old `wda_*` and `screenshot` actions return `STALE_CLIENT`.

### qa_wda

Sets up, attaches, diagnoses, or manages WebDriverAgent for structured iOS automation; `setup` is the one-step path. Without WDA, iOS stays visual-only and `qa_visual` does the checking (see [iOS modes](concepts.md#ios-modes)).

- **`action`**: `status`, `doctor`, `diagnose`, `logs`, and `tune` inspect an existing setup. `attach` connects to an external WDA at `webDriverAgentUrl` (default: this session's WDA, meaning the attached one or the URL of the last `start` or reuse, else `ios.wda.url`, `http://127.0.0.1:8100` by default). `setup` is the one-step path (see below). `build` and `start` manage one (consent `wda_build` / `wda_start`, medium) from `wdaProjectPath` (default: an installed Appium WebDriverAgent when one is found), with `derivedDataPath` and `scheme` (default `WebDriverAgentRunner`); build and start output is captured as artifacts. `stop` terminates the managed WDA of this session's simulator, including one adopted from a previous server run whose session has expired, and one that another Swipium server (live or dead) started or adopted for the same simulator (matched by the simulator UDID recorded in `~/.swipium/processes.json`, with the process fingerprint re-checked). It never stops a WDA by port alone, so another simulator's WDA is safe. A WDA found that way is labelled "registered by this server for another session" or "registered by another Swipium server". It needs a simulator bound to the session, or `device`.
- **Long-running actions** (one call stays under a 60 s client tool timeout):
  - `setup` reuses a WDA that already answers ready and belongs to this simulator (`reused:true`, no consent, when `ios.wda.reuse` is on; recorded as a `wda_reuse` mutation). When this simulator's own WDA listens but does not answer `/status` (hung), `setup` and `start` return `WDA_UNREACHABLE` with a `qa_wda {action:"stop"}` next step instead of starting a second WDA next to it. Otherwise it runs the same checks as `start` and asks for one consent (`wda_build` when it must build, else `wda_start`; the prompt shows both commands; with only `wda_build` in `SWIPIUM_CONSENT_PREAPPROVE` a build and start is asked as `wda_start`, so it is never pre-approved by one name), then runs one background job of kind `wda_setup` that builds if needed and starts WDA. Poll `qa_job_status`; the finished job's `result` has `ready:true`, `webDriverAgentUrl`, `udid`, `logUri`, and `buildLogUri` when it built, and its next step is `qa_wda {action:"attach", device:"<udid>"}`. If the approved port was taken by another simulator's WDA while the job built, the job moves to another free port: the result's `portMovedFrom` and the `wda_start` ledger entry ("port changed from X to Y after consent") say so. Then `attach`. A runner that exits early fails the job with `WDA_START_FAILED`. Cancelling the job leaves a started WDA running and registered.
  - `build` first looks for an existing build: a `<scheme>_iphonesimulator*.xctestrun` (or `_iphoneos` for a device UDID) under `<derivedDataPath>/Build/Products`. When one exists it returns `{built:true, reused:true, xctestrun}` at once, with no consent and no xcodebuild. `rebuild:true` (on `build` and `setup`) forces build-for-testing.
  - Otherwise `build` runs `xcodebuild build-for-testing` as a background job (kill timer 10 min) and returns `{jobId, status:"running"}` at once. Poll `qa_job_status` (with `waitMs`); the job result carries `built`, `logUri`, `wdaBuildProduct`, and on failure `failureCode` (`WDA_BUILD_FAILED` or `WDA_SIGNING_FAILED`) and `nextSteps`. `qa_job_cancel` stops the build.
  - `start` launches WDA and waits for `/status` for at most 45 s (or `ios.wda.startupTimeoutMs`, default 120000, when smaller). If WDA is still starting, it returns `ok` with `status:"starting"`, `pid`, `logUri`, and `remainingStartupMs`; poll `qa_wait {for:"wda_ready"}` until satisfied, then `attach`. `WDA_START_FAILED` is returned when the xcodebuild process exits early or the startup timeout is already spent. A managed WDA whose URL refuses connections, and that either served before or is older than the startup timeout, is stale: `start` and `setup` stop it (after consent) and start a new one on the same URL instead of refusing with "already running". Cancelling the call during that wait returns `CANCELLED` (`changedState:true`) and leaves the managed WDA running, so `attach` can still use it. With `ios.wda.reuse` (default true), a WDA that already answers ready at the URL and belongs to this simulator is reused (`reused:true`, `started:false`) instead of starting a second one. Start and reuse replies are lean (no `wdaConfig` or `/status` payload); `status` has the details.
- **One WDA per simulator**: WDA does not report which simulator it drives, so before reusing, attaching to, or waiting on a WDA, Swipium checks which simulator owns the process listening on the port (falling back to comparing the iOS version). When `lsof` or `ps` can't identify a local listener (an error or timeout), the check is `unverified` (in `deviceCheck` and `ownership.owner`), and such a WDA is never reused or attached as this simulator's, unless it is the session's own started, reused or attached WDA. A WDA that belongs to another simulator is never reused or attached: `attach`, `qa_wait {for:"wda_ready"}`, and an explicit `webDriverAgentUrl` on `setup` or `start` return `STALE_WDA_DEVICE`, and `status`, `doctor`, and `diagnose` report it as a blocker in the new `wdaDevice` field (`{check, udid, reason}`). Without an explicit URL, `setup` and `start` always run a managed WDA on this simulator's own port: a stable port in 8101 to 8900 derived from the UDID, else the next free one (ports that other simulators' registered WDAs hold count as taken even before they are bound). They use the shared 8100 only when the WDA already there runs in this simulator, or is ready and can't be identified. A candidate port also needs its stream port (+1000) free. A custom port in `ios.wda.url` is used as is; only the default 8100 is replaced. A fixed custom port means one simulator at a time: while another simulator's managed WDA is still starting on it, `setup` or `start` for a second simulator moves to its own port (`relocatedFrom` says so); an explicit `webDriverAgentUrl` is never moved. Once WDA is ready, the listener is checked again: if another simulator's WDA won the port in the meantime, this start is stopped and the call or job fails with `WDA_PORT_CONFLICT` (retry `setup` or `start`; it picks a free port). Later `qa_wda` and `qa_wait` calls in the session default to that URL, and to the simulator `setup` or `start` was given as `device`, so a bare `attach` after `setup {device}` targets that simulator. When the configured URL's WDA is not this simulator's, `attach`, `status`, `doctor`, `diagnose`, `qa_prepare_ios_target`, `qa_wait {for:"wda_ready"}` and the `qa_test_this` WDA check look for this simulator's own WDA (its per-simulator port, and any WDA registered for its UDID) and use it.
- **Port and bind address**: a managed WDA's control port is the port of its URL (it gets `USE_PORT`), and, when the URL host is a `127.x` address (the default), it listens on loopback only (`USE_IP`). Its MJPEG screen stream gets port WDA port + 1000 (`MJPEG_SERVER_PORT`; 9100 for 8100, 9101 to 9900 for the per-simulator ports), so concurrent simulators no longer collide on 9100. WDA has no bind-address setting for the MJPEG server: **the stream port listens on every network interface**, so anyone who can reach this Mac on that port can watch the simulator screen. Use a firewall on untrusted networks. The consent's `exactCommand` shows the `TEST_RUNNER_USE_PORT=… TEST_RUNNER_MJPEG_SERVER_PORT=… TEST_RUNNER_USE_IP=…` prefix. A `localhost` or `::1` URL, or a WDA build without `USE_IP` support, binds the control port on every interface too.
- **Build cache**: `build` and `setup` write derived data to `<project>/.swipium/cache/wda-derived-data` (about 200 MB, per project; `ios.wda.derivedDataPath` moves it) and add `.swipium/` to `.gitignore`.
- **WDA settings**: after every WDA session it creates, Swipium posts `ios.wda.settings` to WDA's settings endpoint (WDA resets them per session; a WDA without the endpoint keeps its own defaults). Defaults: `waitForIdleTimeout` 1.5 s, `animationCoolOffTimeout` 0.5 s, `accessibilityDeadline` 20 s (WDA 16.8 and later), and `respectSystemAlerts:true`, so a system alert (a SpringBoard permission prompt) shows up in the page source with its buttons, as a `permission_dialog` overlay, instead of the app controls it covers; your values override them. `waitForIdleTimeout` and `accessibilityDeadline` are also sent as session capabilities, which WDA reads before it launches the app.
- **Page source**: `/source` is requested with `excluded_attributes=visible,accessible`, about 14x faster. Set `ios.wda.settings.pageSourceExcludedAttributes` to your own list, or to `""` for every attribute. Without `visible`, an element whose center is off screen, under a navigation bar, tab bar, toolbar, the status bar or the keyboard, or behind a later layer of its window (an alert or sheet) is treated as not tappable; the bars and keyboard keep their own buttons tappable. Content an app hides without removing it can still look tappable; a full source keeps WDA's own verdict. This setting goes into the `/source` request, not to WDA's settings endpoint. Like every `ios.wda.settings` entry it is also sent as a `settings[name]` session capability, which WDA ignores.
- **Taps** use `/session/:id/wda/tap`; WDA 6.0 or newer is required (the pre-6.0 `/wda/tap/0` fallback was removed in 2.3.0).
- **`device`**: the simulator behind this WDA (default: the session device), as a UDID or a simulator name. A name is resolved to its UDID first (exact name ignoring case, never a substring; an unknown name is `INVALID_ARGUMENT`, a shared one `MULTIPLE_DEVICES` listing the matches), before the session-device (`STALE_WDA_DEVICE`) and pin (`DEVICE_PINNED`) checks and before any consent, so `xcodebuild -destination id=` always gets a UDID. `udid` is a deprecated alias. `bundleId` defaults to the session's app. A non-loopback URL needs `allowNonLoopback:true` plus consent each time it is attached, set up, built or started (see [iOS modes](concepts.md#ios-modes)); `status`, `logs`, `diagnose`, `tune`, `doctor` and `stop` on the session's attached remote WDA don't ask again. With `SWIPIUM_DEVICE` set, `build`, `start`, `setup`, `attach` and `stop` for any other simulator are refused with `DEVICE_PINNED`.
- **Failure codes** (for `build`, the build failures arrive in the job result):
  - `attach`: `MULTIPLE_DEVICES` whenever no `device` is given and none is bound to the session (it never guesses), `WDA_UNREACHABLE`, `WDA_SESSION_FAILED`, `STALE_WDA_DEVICE` (the WDA belongs to another simulator; run `setup`), `DESTRUCTIVE_REFUSED` (non-loopback URL without approval). Attach runs before any diagnostics and returns only `{webDriverAgentUrl, udid, bundleId, driverKind:"wda", sessionActive, wdaSessionId, deviceCheck}`; Xcode, simulator, and discovery details are in `status`.
  - `build` and `start`: `NO_DEVICE` (no UDID given or bound), `BACKEND_UNSUPPORTED` (no Xcode command line tools), `NO_ARTIFACT` (no WebDriverAgent project found), `WDA_BUILD_FAILED`, `WDA_SIGNING_FAILED`, `WDA_START_FAILED` (with `managedPid` while a managed WDA is still running: attach to it or `stop` it first), `STALE_WDA_DEVICE` (an explicit `webDriverAgentUrl` already served by another simulator's WDA), `WDA_PORT_CONFLICT` (another simulator's WDA took the port during start; retry).

## Build

Pick a target, find an artifact, or build one. Only `qa_build mode:"run"` and `qa_bundletool install:true` have side effects on the machine or device.

### qa_resolve_target

Picks the best device or simulator deterministically and boots nothing. It honors `platform`, `device` (adb serial, simulator UDID or name, or AVD name; default the operator pin `SWIPIUM_DEVICE`), and a platform-specific artifact, prefers an online emulator or simulator, and otherwise plans a boot. A requested AVD that is already running resolves to its serial. Returns `selected`, `reason`, `alternatives`, `preconditions`, and `willBoot`. When several emulators or booted simulators qualify, `reason` names the ones not chosen (`Also booted, not chosen: …; pass device to pick one`); `alternatives` lists platform kinds, not devices.

A physical device returns `PHYSICAL_DEVICE_UNSUPPORTED` only when it is requested as `device`, when it is the only option on the chosen platform, or when `preferRealDevice` is set and a phone is visible. Otherwise an emulator or simulator is selected and the phone is mentioned in `reason`. See [Devices](concepts.md#devices).

`include` adds sections:

- **`context`**: framework (`expo`, `bare-react-native`, `native-android`, `native-ios`, `flutter`, or `unknown`), monorepo location, prebuilt artifacts, online Android devices, AVDs, booted and available iOS simulators (`iosBooted`, `iosAvailable`; macOS only), toolchain (`adb`, `emulator`, `java`, `aapt2`, `xcodebuild`), and blockers. A usable iOS simulator means a missing `adb` is not reported as a blocker.
- **`plan`**: READY workflows (with a budget profile and satisfied preconditions), BLOCKED workflows (`missing_device`, `missing_artifact`, `missing_test_data`, or `missing_toolchain`, with the required state and how to unblock), and UNSAFE workflows (with a reason, for example `bundle_cache_loss` for `fresh_start` on a debug RN/Expo build). A booted or bootable simulator counts as a device. With `sessionId`, the session's fixtures, observed auth, and prepared app inform the plan; without one, `.swipium/fixtures.json` does.

When target selection itself fails, the requested sections are still attached to the error.

### qa_resolve_artifact

Finds the best installable build in Gradle, Flutter, and Xcode outputs. Parameters: `platform` (`android`, `ios`, `any`), `buildType` (`debug`, `release`, `any`), `path` (short-circuits the search), `allowOutsideRoot`, `requireInstallableOn` (`android-emulator`, `android-real`, `ios-simulator`, `ios-real`). Xcode's DerivedData (`~/Library/Developer/Xcode/DerivedData`) is outside the project, so it is searched only with `allowOutsideRoot:true`. Returns ranked candidates (build type, installability, app id, ABIs, warnings) and the exact locations searched. An explicit `path` that is missing or not an installable type reports that problem for the path itself. The project search stops after 20,000 directories or 10 s, with a warning saying it stopped early. Failure codes: `NO_BUILD_ARTIFACT` (with a `qa_build` next step), `AAB_NEEDS_BUNDLETOOL`, `ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL`.

### qa_build

- **`mode:"plan"`** (default, no side effects): the detected framework (Expo, React Native, native, Flutter), exact prerequisite and build commands, working directory, expected artifact globs, toolchain status, and a cost estimate. Works with `projectRoot` alone.
- **`mode:"run"`**: needs `sessionId`. Consent `build_from_source` (high). Runs as a job, stores a build-log artifact, and re-resolves the produced artifact. `timeoutMs` is per step (default 1200000).
- Parameters: `platform` (required: `android` or `ios`), `variant` (`debug` or `release`).
- **Failure codes** (a build failure is not a test failure): `BUILD_COMMAND_UNAVAILABLE`, `DEPENDENCY_INSTALL_REQUIRED`, `EXPO_PREBUILD_REQUIRED`, `GRADLE_FAILED`, `XCODEBUILD_FAILED`, `FLUTTER_BUILD_FAILED`, `BUILD_FAILED`, `BUILD_TIMED_OUT`, `BUILD_ARTIFACT_UNRESOLVED_AFTER_SUCCESS`.

### qa_bundletool

Converts an `.aab` (not directly installable) into an installable APK, cached under `.swipium/artifacts/`, before `qa_prepare_target`. Runs as a job.

- Default: a universal `.apk` signed with the debug keystore. `aab` defaults to the best `.aab` in the project; `force` rebuilds a cached one.
- `connectedDevice:true` builds a device-specific APK set; with `install:true` it also installs it on `device` (consent `install_app`, medium). `device` defaults to the session's Android device, else the online device matching `SWIPIUM_DEVICE` (`NO_DEVICE` when the pinned one isn't online), else the only online device (several with none chosen is `MULTIPLE_DEVICES`). With the pin set, another `device` is refused with `DEVICE_PINNED`, and a physical device, named or picked, is always refused with `PHYSICAL_DEVICE_UNSUPPORTED`, both before the consent prompt. A session bound to an iOS simulator needs an explicit Android `device`. The prompt and the job use the resolved device, always passed to bundletool as `--device-id`; the cached APK set is keyed by device id and ABI.
- **Failure codes**: a missing bundletool returns `AAB_NEEDS_BUNDLETOOL` at once, before any job starts (`BUNDLETOOL_MISSING` is effectively unreachable from this tool). The job can end with `AAB_BUILD_APKS_FAILED`, `AAB_DEVICE_SPEC_FAILED` (no connected device for a device-specific set), or `ANDROID_SIGNING_FAILED`, and an install with `ANDROID_SIGNATURE_CONFLICT`, `ANDROID_MIN_SDK_INCOMPATIBLE`, `APK_ARCH_INCOMPATIBLE`, or `AAB_INSTALL_FAILED`. Output that would go through a symlink under `.swipium/artifacts` is refused with `ARTIFACT_PATH_UNWRITABLE`. No `.aab` in the project is `NO_BUILD_ARTIFACT`, and so is an explicit `aab` that is not an existing file (`.aab not found: <path>`), refused before any job starts. An explicit `aab` that doesn't end in `.aab` is `INVALID_ARGUMENT`, also up front. A relative `aab` is resolved against the project root, not the server's working directory.

## Device

Inspect and control the device and app without raw `adb` or `simctl`. Mutating actions are logged as environment changes and appear in the report.

### qa_device_info

Read-only, no consent. On Android: `props` (manufacturer, model, SDK, release, ABIs, locale, timezone), `screen` (size and density), `orientation`/`rotation`/`autoRotate`, `installedThirdPartyCount`, and `packages[]` with `listPackages:true` (filter with `packageFilter`). On iOS: `platform:"ios"`, the simulator's name, runtime, and state, the screen in points, `orientation:"unknown"`, and a list of unsupported fields.

**`logs`** (Android only) captures logcat to a `logcat` artifact instead of returning device facts: `adb logcat -d -v threadtime`, optionally from one `buffer` (`main`, `crash`, `system`, `events`, `all`, or `default`), at a minimum `level` (`V`, `D`, `I`, `W`, `E`, `F`; default `V`), for one `tag`, for one `package`, and filtered on the host by `grep` (a case-insensitive regex; an invalid regex is matched literally). `lines` (default 1000, at most 20000) is an overall cap on the output, applied after the `package` and `grep` filters, whatever the buffers; a `package` query scans at least the last 5000 lines. When more lines match than `lines`, the result adds `truncated:true` and `matchedTotal` and the summary says to raise `lines` or narrow the filter. `since` reads from a point in time instead (the whole window is filtered before the cap, so a crash inside it is never cut off by busy noise): a relative age (`"90s"`, `"5m"`, `"1h"`) or a logcat time (`"MM-DD hh:mm:ss[.mmm]"` or `"YYYY-MM-DD …"`); an invalid value is `INVALID_ARGUMENT`. `context` (0 to 200) keeps that many lines after each `grep` match. A `package` is matched by its current pid (when it runs) plus every pid logcat names for it (`Process: <pkg>, PID: n`, `Start proc n:<pkg>`) and lines that name it, so a restarted app still shows the crashed process's lines; `filters.pid` says which. Unknown keys inside `logs` are rejected. It returns `{device, uri, matched, scanned, filters}`; `uri` is `null` when no line matched. The artifact keeps the last 120 KB, and like every log artifact it is scrubbed of registered secrets and of credential-looking values (see [Secrets and redaction](concepts.md#secrets-and-redaction)). Refused in sensitive sessions (`SENSITIVE_MODE_REFUSED`, checked before the device lookup, so it comes first on iOS too); on iOS it returns `BACKEND_UNSUPPORTED` (use `qa_ios {action:"logs"}`); a malformed `tag` or `package` is `INVALID_ARGUMENT`. For a FATAL stack after a crash, use `qa_device_info {sessionId, logs:{buffer:"crash"}}` or `logs:{grep:"FATAL EXCEPTION", context:40}`; for JS warnings, `logs:{tag:"ReactNativeJS", level:"W", since:"5m"}`.

### qa_orientation

`orientation`: `portrait`, `landscape`, or `auto` (re-enables auto-rotate). Android only; iOS returns `BACKEND_UNSUPPORTED`. Logged as an environment change.

### qa_geolocation

Spoofs the GPS location on an Android Emulator (`adb emu geo fix <lng> <lat>`). `lat` and `lng` are required decimal degrees. Consent `geo_set` (medium). iOS returns `BACKEND_UNSUPPORTED`.

### qa_network

Airplane mode via `cmd connectivity airplane-mode`, Android 11+ only. `action`: `status`, `offline`, `online`, or `restore`. `offline` and `online` need consent `network_change` (medium). The original state is recorded on the first change, with the pid of the server that made it, and restored at `qa_report`, on `restore`, and on server shutdown. Only the server that made the change restores it on shutdown (a server that merely read the session, for example with `qa_snapshot`, leaves it alone). A change left behind by a server that crashed is not restored automatically: `qa_status` and `qa_network status` on any session bound to that device warn about it (`status` lists the sessions in `orphanedBySessions`), and `qa_network restore` on any such session takes it back too and says which session it came from; `qa_report` on the original session still restores it. On iOS it returns `BACKEND_UNSUPPORTED` (simulators have no airplane-mode control). If the device rejects the toggle, nothing is recorded as changed. A toggle returns as soon as the device reports the requested state (polled every 150 ms, at most 1.2 s).

### qa_metro

The Metro bundler (port 8081) for debug React Native and Expo builds. `action`:

- `status`: Metro, `adb reverse`, and serving state. It never binds a device: it only looks at the device the session already has (or the `SWIPIUM_DEVICE` pin); on an unbound session it reports `device:null` and `needsDevice:true`. `start`, `stop` and `diagnose` bind through the same guard as every device tool (for example `MULTIPLE_DEVICES` while an iOS Simulator is booted).
- `diagnose`: adds RedBox detection, logcat evidence, and recovery steps. When Metro serves on `localhost` (`::1`) but nothing listens on `127.0.0.1:8081`, the recovery says to restart Metro listening on all interfaces (drop `--localhost`) instead of "Start Metro".
- `start`: consent `start_metro` (medium). Runs `adb reverse tcp:8081 tcp:8081` (Android), spawns Metro detached with a log artifact, and tracks the process. Relaunch the app with `qa_prepare_target` afterwards. It refuses to start while another project's Metro holds the port (`METRO_WRONG_PROJECT`).
- `stop`: stops the whole process group and removes the reverse. It only stops a Metro this session started.

`status` and `diagnose` report `wrongProject` and `metroProjectRoot` when the Metro on the port serves another project (read from its `X-React-Native-Project-Root` header; a root that contains the other, as in a monorepo, counts as the same project), with a recovery line.

**On an iOS session** (the session's simulator, driver, or persisted driver kind is iOS) there is no `adb reverse` and no Android device is ever bound: `start` only spawns Metro (the consent shows just the Metro command), `ready` means listening and serving, the result carries the simulator UDID as `device` plus `platform:"ios"` and `reverseNeeded:false`, and the app is relaunched with `qa_prepare_ios_target`. `diagnose` reads the RedBox from the WDA UI tree and saves the simulator's log instead of logcat; without WDA there is no UI tree, so `redBoxChecked` is false and the result says the RedBox was not checked.

`qa_metro` errors are typed: `MULTIPLE_DEVICES` or `NO_DEVICE` when it can't pick a device, `METRO_FAILED` when `adb reverse` fails or Metro could not be spawned (for example no `npx`; the reverse is already applied, so `changedState:true`), and `METRO_WRONG_PROJECT` when another project's Metro serves the port. It does not return `METRO_REQUIRED`; that code comes from `qa_prepare_target`, `qa_prepare_ios_target`, and `qa_test_this` when a debug build needs a Metro server that isn't running, and its recovery is `qa_metro {action:"start"}`, then `qa_wait {for:"metro_ready"}`.

### qa_app_control

`action`: `launch`, `foreground`, `background`, `force_stop`, `restart` (a relaunch into a fresh task, for persistence checks: on Android `am start -S` with clear-task flags, so another package's activity left on top of the app's task, such as a Settings search, is cleared too; falls back to force-stop plus launch), `clear_data`, or `fresh_start`. The action always targets the session's app. After `background`, the result reports the app that is actually in the foreground.

`launch`, `foreground`, `restart`, and `fresh_start` return as soon as the app is in the foreground (polled every 250 ms, at most 2.5 s); on Android they start the launcher activity with `am start -W`, falling back to `monkey`. A success returns `{packageName, action, changedState:true, processKilled, foreground, foregroundIsApp}`. On an error, `changedState` reflects what actually ran: a driver call that failed before any mutation reports `changedState:false`.

`clear_data` and `fresh_start` wipe app data: consent `app_clear_data` / `app_fresh_start` (high). On debug RN/Expo builds they also need `acknowledgeBundleRisk:true`, because a wipe can remove the cached JS bundle; without it the result is `BUNDLE_LOSS_REFUSED`.

### qa_screen_record

Records to an mp4 artifact on Android (`adb screenrecord`, auto-stops after about 3 minutes) and the iOS Simulator (`simctl io recordVideo`). `action`: `start` (consent `screen_record`, medium; it captures whatever is on screen, so avoid password and OTP screens), `status`, `stop`. `save:"on_failure"` on `start`, plus `failed:false` on `stop`, discards the video of a passing run. One recording per session. `start` is refused in sensitive sessions (`SENSITIVE_MODE_REFUSED`, checked before the device lookup, so it comes before `NO_DEVICE`, like `qa_screenshot`).

## Drive

Observe, act, assert, and collect evidence.

### qa_snapshot

Captures the screen as compact, addressable elements (`@e1`, `@e2`, …) with a snapshot-quality verdict (`quality`, plus `qualityReasons`). Interactive elements only, with no screenshot. Busy screens are capped at 60 elements (the most interaction-relevant ones, focused, clickable, fields, and scrollables first, kept in screen order, with `elementsOmitted` counting the rest); `filter` (a substring of text, label, id, or role) finds capped elements.

- **Stable refs**: an element keeps its `@eN` across snapshots while it stays on screen. It is matched by class, resource id, text and label, its parent, and its position among equal siblings, and keeps its ref when its center moved at most 64 px. An element whose own text changes in place keeps its ref only when it has an id (an id-less counter gets a new ref); a text field keeps its ref when its value or label changes in place (same class and id, same row, overlapping). New elements get new numbers, and a number is never reused within a session. The first snapshot of a session numbers elements in screen order from `@e1`.
- **`diff:true`**: on the same screen it returns no `elements`, only `diff: {added, removed, changed, counts, bigChange:false}` (element lines) plus the header fields (`quality`, `screen`, `elementCount`, overlays). When more than half of the elements are new (a navigation), it returns the full snapshot with `diff: {bigChange:true, counts}`.
- **Weak trees**: when the tree has under 3 elements, a WebView covers most of the screen, or more than half of the clickable elements have no text, label, or id on themselves or on any view inside them (a list row labeled by a child text view counts as labeled), the result adds `treeHint` and a text line suggesting `qa_screenshot` or `qa_visual`.

- **Element lines**<a id="element-lines"></a>: each entry of `elements` is one line, the same line the text block renders: `@e3 [button] "Log in" #login_btn text="Sign in" [40,200][1040,245] (focused,secure)`. In order: the ref, the role, the name (the label, else the text; left out when neither), `#id` when there is one (quoted when it is not a plain token), `text="..."` only when it differs from the label, the bounds as `[x1,y1][x2,y2]` (left out when unknown), flags (`focused`, `secure`) in parentheses when any apply, and a trailing ` -` when the element is not clickable (`@e7 [text] "Total" [40,900][300,940] -`). Before 2.3.0 an empty name was rendered as `""` and a non-clickable element carried a `non-clickable` flag; `parseElementLine` in `src/snapshot/parse.ts` reads both forms. Names are JSON-quoted (quotes and newlines escaped) and cut at 80 characters with `...`. Known secrets are redacted and secure values are `«secure»` before the line is built. `responseMode:"verbose"` returns the full objects instead; `qa_inspect` returns every attribute of one ref.
- **Rows**: a list row is listed once. Exact duplicates of any listed element (same role, text, label, id and bounds, siblings included), a row's own title repeated as a separate text line, and unlabeled wrappers around a clickable element are dropped (they stay available to overlay and obstruction checks), and so is an unnamed scrollable with exactly the bounds of a scrollable it sits in (the outer one is kept). A clickable row with no name of its own carries its child title (`@e8 [button] "Network & internet"`).
- **iOS with WDA**: an element's `id` is its accessibility identifier (WDA's `name` when it differs from the label). `TextField`, `SecureTextField`, `SearchField`, and `TextView` are `text-field` elements that show their typed value; secure fields stay masked. Images and icons are not tap targets, and SF Symbol (`chevron`, `chevron.forward`), asset, and view-class names (`PageFormatMenuButton`) are not used as labels; a name-only element keeps its name as its `#id`, so it stays targetable. Scroll positions (`0 %`) are not used as labels, and scroll indicators are dropped, so an alert's own scroll bar no longer counts as covering its bottom button. Keyboard keys are tappable. A system alert (a permission prompt) is in the tree with its buttons and reported as a `permission_dialog` overlay, because WDA runs with `respectSystemAlerts:true` by default.
- **Overlays**: banners and snackbars are reported only with an overlay signal (an overlay-like class or id, a dismiss control, or banner wording). Navigation-bar titles, text fields, and list rows are never reported as overlays.
- **Visual-fallback**: after `maxSnapshotFailures` consecutive failed dumps (default 3), the session switches to visual-fallback (`VISUAL_ONLY_SCREEN`) for that screen. Each later `qa_snapshot` and `qa_act` still tries one bounded structured dump; the first success switches back (`modeRecovered:true`) and resets the count.
- **iOS without WDA**: there is no UI tree; the result is `BACKEND_UNSUPPORTED`. Use `qa_visual`. A visual-only session whose simulator had a WDA (the session's recorded WDA URL, or a `wda_attach`, `wda_start` or `wda_reuse` ledger entry for it) that no longer answers `/status` gets `WDA_UNREACHABLE` with restart steps instead (`qa_act` too).
- **Stalled Android device**: a UI dump that gets no answer from adb within its timeout (about 20 s) returns `DEVICE_UNRESPONSIVE` at once (`changedState:false`, retry-safe, with a restart hint), without retries, without counting as a snapshot failure, and without switching to visual-fallback.
- **Device or WDA gone**: when the bound emulator or simulator disappears (adb `device not found` or `offline`, a simulator in state `Shutdown`), the result is `NO_DEVICE` with re-boot steps (on iOS sessions, every tool's "no device" next step names `qa_prepare_ios_target`, not `qa_prepare_target`); it does not count as a snapshot failure or switch to visual-fallback. On iOS, a WDA that stopped answering is `WDA_UNREACHABLE` with `qa_wda start` (or `setup`), then `attach`, as next steps.
- **Failure codes**: `SNAPSHOT_FAILED`, `VISUAL_ONLY_SCREEN`, `BACKEND_UNSUPPORTED`, `NO_DEVICE`, `WDA_UNREACHABLE`, `DEVICE_UNRESPONSIVE`.

### qa_inspect

Full attributes of one `@eN` from the latest snapshot: class, id, content description, text, bounds, interaction flags, and raw attributes. Outside `verbose`, `attrs` holds only the attributes that are not already top-level fields; `responseMode:"verbose"` returns all of them. Secrets are redacted, and a secure field's value is shown as `«secure»`. A ref that is not in the latest snapshot is `STALE_REF`.

### qa_act

Performs one action, waits for the screen to settle, and observes: `changed`, `settled`, snapshot quality, a health check, and post-action elements.

| action | Required | Optional |
| --- | --- | --- |
| `tap` | `target` | `durationMs` (press length; coordinate taps default to about 100 ms), `ignoreOverlay` |
| `type` | `target`, `text` | `mode` (`replace`, the default, clears first; or `append`), `submit` (press enter after) |
| `clear` | `target` | |
| `swipe` | `direction` | `target` (start point) |
| `scroll` | `direction` | `untilVisible` (a target), `maxScrolls` (default 8) |
| `press` | `key` (`back`, `home`, `enter`) | |
| `open_url` | `url` | |
| `wait` | | `for` (`{settled:true}` by default, or an element: `ref`, `text`, `id`, or a WDA `selector`, plus `gone:true` to wait until it is no longer on screen), `timeoutMs` (default 8000) |

Every action also takes `observe` and `timeoutMs` (the settle-wait cap, default 8000). `timeoutMs` is at most 50000: larger values are clamped to 50000 with a note in `notes` (not rejected); negative values are `INVALID_ARGUMENT`. A `wait` for an element that never shows up returns `ELEMENT_NOT_FOUND`, and a `gone:true` wait for one that never leaves returns `ASSERTION_FAILED`; a `selector` wait off WDA is `BACKEND_UNSUPPORTED`.

For 3 or more known steps, one `qa_flow_run {sessionId, flowYaml}` call is cheaper than one `qa_act` per step (see [Flows](flows.md#batching-steps)). Cancelling a `wait` stops polling at once and returns `CANCELLED`.

- **Targets**: an `@eN` ref, `text`, `id`, a native `selector` on WDA (`accessibility id`, `name`, `predicate string`, or `class chain`), or `x`/`y` coordinates. A ref must look like `@e12`; anything else (`e3`, `banana`) is `INVALID_ARGUMENT`. A `text` target prefers an exact (case-insensitive) text or label match over a substring match, and a clickable match over a non-clickable one, so `text:"Allow"` taps the button rather than the dialog message that contains the word. Text matching ignores case and treats curly and straight quotes and apostrophes as equal (`text:"Don't allow"` finds `Don’t allow`), on both platforms and in `wait` and `scroll untilVisible` too. An explicit `index` counts every match in screen order.
- **Ref re-check**: a ref is trusted as is when its snapshot is at most 1.5 s old and no action ran since. Otherwise `qa_act` takes one fresh dump and finds the same element again (by identity: the same ref, else the same class, id, and label nearest the old center). If it moved more than 8 px, the tap uses the new center and the result has `refMoved:true`. A text field whose label changed with its value (it was typed into) is also found again by class and id alone when exactly one such field is on screen. If it is gone, the result is `STALE_REF` with up to 3 similar elements in `candidates` (element lines), also named in the error text. A ref that is no longer in the latest snapshot (another action or a scroll of more than 64 px replaced it) is looked up among the last 200 replaced refs of the current app: when exactly one element on screen now has the same class, id, text or label, and the same label inside it, the tap goes there (`refMoved:true`, `via` names the new ref); when none or several match, the result is `STALE_REF` with `candidates`. A ref Swipium never handed out, or one from before a rebind, `clear_data` or an app switch, is `STALE_REF` without candidates. Interactive `qa_act` never waits for a target; flows do (see [Flows](flows.md#waiting-for-targets)).
- **Snapshot reuse**: `text` and `id` targets reuse a snapshot taken under 2 s earlier with no action since; a miss on it always takes a fresh dump.
- **Observe**: `elements` use the `qa_snapshot` [element lines](#element-lines) (objects in `verbose`). `diff` (the default once a snapshot exists) returns added and removed elements; `full` returns the capped list; `none` returns verdicts only. When more than half of the post-action elements are new (a navigation), `diff` returns the full capped list with `diffAsFull:true`, `addedCount`, and `removedCount`.
- **Settling**: after the action, the screen settles when two dumps in a row have the same fingerprint (on-screen elements with bounds bucketed and clocks, percentages, and SeekBar, ProgressBar, and RatingBar values masked). On the Android direct driver the first dump is accepted alone when it differs from the pre-action screen (a snapshot from the last 5 s) and shows no loading marker (a ProgressBar or activity indicator, a Lottie view, `indeterminate="true"`, "loading" text, fewer than 3 nodes); the result then has `settleFast:true`. iOS always uses two dumps.
- **`changed`**: true when elements appeared or disappeared, when positions moved (so a scroll that only shifts content counts), or when a checked, selected, or value state changed. State changes are listed in `stateChanged`, so a toggle is never retried as a press (which would toggle it back). For a `tap` on a target the tree can't judge (no text, label, or id; a WebView, SurfaceView, TextureView, canvas, or Flutter-like view; no snapshot; or a visual-fallback session), Swipium keeps a screenshot from before the tap; if the tree shows no change, a second screenshot with more than 0.5% of pixels changed counts as changed (`pixelChanged:true`) and the long-press retry is skipped. These screenshots are not saved and don't count against the budget.
- **Weak trees**: like `qa_snapshot`, the result adds `treeHint` when the tree looks weak (only when `observe` is not `none`).
- **Keyboard**: if a tap target's center is inside the soft keyboard's frame, Swipium hides the keyboard (never a blind BACK), waits, re-resolves the target, and taps only once it is uncovered; success adds `keyboardHidden:true`. If the keyboard cannot be hidden, the result is `KEYBOARD_OBSTRUCTION` with `changedState:false`. If it was hidden but the target is gone or still covered, `KEYBOARD_OBSTRUCTION` with `changedState:true` and `keyboardHidden:true`. Nothing is tapped in either case. Targets above the keyboard (an accessory toolbar, suggestion chips) are tapped without hiding it. When the keyboard's area is unknown (no frame, or a frame taller than 55% of the screen), Swipium taps without hiding it and warns `keyboard is up; could not determine its area`.
- **Other overlays**: an element drawn over the target returns `OVERLAY_OBSTRUCTION` with `blockedByOverlay` instead of a blind tap. `ignoreOverlay:true` skips both checks. Coordinate taps are always treated as deliberate.
- **Scroll**: a plain `scroll` performs exactly one swipe. With `untilVisible`, visibility is checked before the first swipe, and swiping repeats up to `maxScrolls`. The result reports `swipes`, `untilVisibleFound`, and `endOfList:true` when a swipe no longer changes the screen. Each swipe is anchored inside the largest scrollable container on screen (Android `scrollable="true"`, iOS ScrollView, Table, or CollectionView), 10% inside its edges, so it never starts on a sticky app bar; `anchoredIn` is `scrollable` or `screen`. A match counts as found only when its center is on screen and not under the keyboard.
- **Back on iOS**: iOS has no back key. On WDA, `press key:"back"` taps the navigation bar's back button when one is on screen, otherwise it swipes from the left edge. `backVia` reports `nav_button` or `edge_swipe`. Without either, `BACKEND_UNSUPPORTED`.
- **Typing on Android**: text is escaped for the device shell (spaces, braces, brackets, glob characters, a literal `%s`). Text of up to 40 characters is one `input text` call. Longer text is typed in verified pieces of about 40 characters (a cut never starts or ends on a space): each piece goes out in one adb call together with a move of the caret to the end of the text (Ctrl+End where the device supports key combinations, Android 13 and later, so it reaches the end of a multi-line field too; else plain End), 300 ms apart, and after every 2 pieces and after the last one Swipium reads the focused field (up to 4 s) until it ends with the text typed so far, so a field that moves the caret or drops keys mid-input doesn't scramble it. The read-back takes the field's value, not a label after it (a labeled Compose field reads as `"<value>, <label>"`), and ignores case, runs of whitespace, trailing spaces, and, for masks and filters, anything but letters and digits. When characters were lost, the pieces since the last good read-back are deleted and sent once more. If a read-back's UI dump times out, the rest of the text goes out without per-piece checks and only the final read-back catches a scramble. If the text still doesn't read back (in the driver's checks or in the read-back below), `qa_act` clears the field once and retypes the whole value in careful mode: bursts of 8 characters, each with the move to the end, 250 ms apart, read back after every 5 bursts and after the last. Only if that fails too does the type fail with `TEXT_INPUT_MISMATCH`; a result that needed the retype has `retyped:true`. Careful mode is slower, but it can't stop an app that resets its caret while keys arrive; long text into such a Compose field can still fail. A field that holds a start of the text and stops growing (a max length) ends the typing without an error, and the read-back below gives the "truncated" warning, as for short text. A field that can't be read (a password field, or nothing reports focus) gets 300 ms between all pieces instead. Characters `adb input text` cannot deliver (non-ASCII or control characters) return `TEXT_INPUT_UNSUPPORTED` with `changedState:false`; the value is checked before the field is focused or cleared.
- **Replace mode** clears the whole field first and must read back exactly the typed text; leftover old text fails the call, whatever the target kind (ref, `text`, `id`, or `x`/`y` coordinates). On Android the clear selects all and deletes (Ctrl+A, then Delete, on Android 13 and later; support is probed once per device), which doesn't depend on the caret or the text length. On older Android it reads the field's real length from one dump and deletes that many characters on both sides of the caret, so a multi-line field is emptied on every line; an empty field is left alone. On Android 13 and later the clear waits until the tap that focused the field is about 0.9 s old, so the field's caret placement doesn't undo the select-all. On iOS with a native `selector`, WDA's element clear empties the field. A replace-mode miss is retried once on both platforms, while the typed field still has focus: when the read-back says mismatch (or cut short, see below), Swipium clears the field again (select all and delete on Android 13 and later, by its real length on older Android), retypes (careful mode on Android after a mismatch), settles, and reads back again, and only then fails with `TEXT_INPUT_MISMATCH`. The retry never runs twice in one call, and never in append mode or when the field lost focus. The result has `retyped:true`.
- **Read-back**: after a plain `type` (not secure, no `submit`), the field is read back from the post-action snapshot, ignoring case and whitespace. The field's value is compared, not a Compose label after it, and a hint shown in an empty field counts as empty. Replace mode needs an equal value, append mode needs the value to contain the text. A value with the same letters and digits in another format (an input mask, smart quotes, a phone field that adds `+<country code>` before the number) adds a `warnings` entry. A non-empty start of the typed text is a warning only when it looks like a real limit: an OTP box that handed the digits on to the next box (focus moved), or, in replace mode, a retype that stops at the same length again (a max length cuts the same way every time). A cut that differs on the retype, or comes after a scramble or an earlier retry, is a mismatch. Any other value fails the call with `TEXT_INPUT_MISMATCH` (`ok:false`, `changedState:true`) when the field was targeted by ref or, in replace mode, when it is the focused field under the tap that focused it (a coordinate target, or a ref that moved); a focused field elsewhere (the screen may have moved on) gets a warning instead. A field that completes text inline as you type (`app` becoming `apple`) reads back as a mismatch, because in replace mode it looks the same as old text left behind. In replace mode the error is retry-safe (the retry clears the field first); in append mode it is not, because the field keeps what landed and the same append would type it twice: retry the whole value with `mode:"replace"`. The value is never echoed; the error gives lengths only. Before 2.3.0 a mismatch was only a warning. On iOS, typing by a native `selector` is read back too, from WDA's element value (not for secure fields, `submit`, or empty text; an unreadable value skips the check), with the same mismatch and warning rules but no retry. XCUITest reports an empty field's placeholder as its value, which doesn't matter for non-empty text.
- **`press home` on iOS**: returns within a few seconds (the home request is capped at 3 s and each foreground read at 1 s) with `foreground` (the app now in front), `changed`, `settled:false`, and no element list, because WDA's page source still describes the backgrounded app. It polls until SpringBoard is in front (or, with a session app, until that app left), also with no session app; if WDA is still busy, `foreground` can be `unknown` (`changed:true`). On every platform `press home` never counts as a no-change action, and neither does a `scroll` whose `untilVisible` target was already on screen.
- **`removed`**: in `diff` results, `removed` holds element lines from the pre-action snapshot (capped; the `-N` count is the full count).
- **Placeholders**: `type` expands `${SWIPIUM_*}` placeholders from session inputs (for example credentials given to `qa_continue_from_blocker`), else from the server environment. An unresolvable placeholder returns `MISSING_TEST_DATA` before anything is tapped. Secret handling of typed values is in [Secrets and redaction](concepts.md#secrets-and-redaction).
- **Warnings**: non-fatal caveats come back in `warnings[]`, for example `WDA session was re-created (requested without relaunching the app); verify the screen state`.
- **Mode recovery**: a successful observation switches a visual-fallback session back to structured mode (`modeRecovered:true`). An observation that never reaches idle switches it to visual-fallback for that screen only.
- **Device binding**: a device still booting is `DEVICE_NOT_READY`; a physical device is `PHYSICAL_DEVICE_UNSUPPORTED`. A session is only re-bound to its own device: a resumed iOS session re-attaches its simulator (WDA when it had attached WDA and it is reachable, else the simulator backend). An offline device is never replaced by a different online one. A device that disappears mid-session is `NO_DEVICE` with `changedState:false` (no visual-fallback switch), and a dead WDA is `WDA_UNREACHABLE` (`changedState:false` unless the connection dropped mid-request).
- **Budget**: once the action or screenshot budget is spent, the call does nothing and returns `BUDGET_EXHAUSTED` (`ok:false`, `performed:false`; see [Result envelope](#result-envelope)).
- **Timeline step**: every call, including one that returns an error, records one step in the report's timeline: a target label such as `tap "Sign in"`, `type into "Email"` (never the typed text) or `open_url` without its query string, the result (`ok`, `failed` with its `failureCode`, or `no_change`), the duration and the screen. A failed step also gets a screenshot (secure-field guard applied, not counted against the budget) and the UI dump `qa_act` already holds, when it holds the raw XML. Nothing is captured for `no_change`, for `INVALID_ARGUMENT`, `OVERLAY_OBSTRUCTION`, `CANCELLED` or `BUDGET_EXHAUSTED`, or when the device is gone. See [qa_report](#qa_report).
- **Failure codes**: `INVALID_ARGUMENT` (missing field or target, malformed ref), `STALE_REF`, `ELEMENT_NOT_FOUND`, `AMBIGUOUS_SELECTOR`, `KEYBOARD_OBSTRUCTION`, `OVERLAY_OBSTRUCTION`, `TEXT_INPUT_UNSUPPORTED`, `TEXT_INPUT_MISMATCH`, `MISSING_TEST_DATA`, `BACKEND_UNSUPPORTED`, `NO_DEVICE`, `WDA_UNREACHABLE` (also on a visual-only session whose recorded WDA stopped answering), `DEVICE_UNRESPONSIVE` (adb timed out on a stalled Android device; an input may have partly landed, so an append that hit it is not retry-safe), `BUDGET_EXHAUSTED`.

### qa_clear_overlay

Clears what blocks the screen. `strategy`: `auto` (default, the topmost overlay), `hide_keyboard`, `press_back`, `tap_outside`, `minimize_logbox`, `dismiss_logbox`, `allow_permission`, `deny_permission`, or `dismiss_toast_if_possible`. `targetRef` reports whether that element was obstructed before and after. Returns what was cleared and what remains: `overlaysBefore` and `remaining` include the soft `keyboard` and foreground surfaces such as a `permission_dialog`, and `remaining` is re-checked after acting, so a dialog that is still there makes the outcome `reappeared` or `not_dismissible`, never `cleared`. The outcome only looks at overlay types this call acted on, so an unrelated banner that was already there does not count as `reappeared`. When there was nothing to act on (for example `hide_keyboard` with no keyboard up), the outcome is `nothing_to_clear`; `cleared` still lists the `not_visible_or_unsupported` entry. A strategy that found no control to tap (`minimize_not_found`, `dismiss_not_found`, `allow_not_found`, `deny_not_found`, or a toast it cannot target) is never `cleared`: it is `not_dismissible` when that overlay is on screen, else `nothing_to_clear`. `minimize_logbox` and `dismiss_logbox` tap only a control labelled exactly "Minimize" or "Dismiss", and the permission strategies tap only inside an iOS permission alert when one is in the tree. `auto` taps outside only when an overlay was detected or `targetRef` was obstructed; with nothing detected it does nothing and the outcome is `nothing_to_clear`. `auto` never answers a permission or native dialog for you: it reports it in `cleared` as `present; …` and the outcome is `needs_decision`, so call `allow_permission` or `deny_permission` (or tap the dialog's button with `qa_act`). `allow_permission` and `deny_permission` tap the permission button by its id first, then by exact label, never the dialog's message text. `targetRef` is resolved in the fresh tree by id, then by its structural key, then by the innermost element with the same bounds, so `targetObstructedBefore` and `targetObstructedAfter` agree with what `qa_act` would see. On an iOS Simulator without WDA it returns `BACKEND_UNSUPPORTED` with `changedState:false` before doing anything. A keyboard the backend cannot dismiss (for example WDA's "Did not know how to dismiss the keyboard") returns `KEYBOARD_NOT_DISMISSIBLE` (not retry-safe) with next steps: press enter, tap the app's Done button, or `tap_outside`.

### qa_check_health

Deterministic health check of the current screen: native crash, ANR, framework error boundary or RedBox, error surfaces, and whether the app is still in the foreground. High-severity findings are real bugs, not flakes. `qa_act` runs it after every action.

- **React Native**: the RedBox is recognized in its Android and iOS wording and by its element ids (`catalyst_redbox_title`, `rn_redbox_*`, `redbox-error`, `redbox-dismiss`, `redbox-reload`). A RedBox that says the bundle could not be loaded ("No script URL provided", "Make sure the packager is running", "could not connect to the server") and the Expo dev-client launcher ("No development servers found") are recorded with `METRO_REQUIRED`. A JavaScript error RedBox (`EarlyJsError`, "Unable to resolve module", "Cannot find native module") is a high `REDBOX` finding, an app bug, and so is Expo's or React Native's fatal load screen: "App entry not found", "The app entry point named … was not registered", `"main" has not been registered`, "Exception in HostObject::get", "Unable to parse @ReactMethod", and the Expo Go or dev-client "There was a problem loading the project" screen (a bundle-load RedBox is still checked first, so a Metro-missing screen stays `METRO_REQUIRED`).
- **Another app in front**: system surfaces are exempt (the `android` system package, System UI, the package installer, the intent resolver, `com.android.internal.*`, the keyboard, the permission controller, and the launcher). Any other app, Chrome and Settings included, is a `wrong_foreground_app` finding: medium while the app's process is alive, high with "app process is gone (possible crash)" when it isn't. An activity of another package running inside the app's own task (for example a Settings search; the task's owner is read from its `realActivity`) is only an info finding and is not recorded.
- **Crash evidence**: a high crash, ANR, or possible-crash finding on Android saves a logcat excerpt as a `logcat` artifact in the finding's `logUri`. For a crash it reads the crash buffer first and keeps the app's own block (`Process: <appId>` next to the `FATAL EXCEPTION` line), ignoring other apps' and older crashes; otherwise (and for an ANR) it reads 3000 lines of the default buffers and takes the app's crash block (from the last `FATAL EXCEPTION`, `ANR in`, or fatal signal). The excerpt starts at the crash's first line and stops before the next crash, and a Java `FATAL EXCEPTION` block keeps only the crashed process's lines. Swipium's own `uiautomator` processes are filtered out. The finding in the `qa_check_health` (and `qa_act`) response carries the `logUri` too. At most one excerpt is saved per class (crash or ANR) every 30 s, and never in sensitive sessions; a later crash-class finding in that window (for example the `qa_act` right after a `qa_check_health`) links the same excerpt in its `logUri`. A medium "different app in front" finding reaches the issue ledger as an app-owned `app_bug` (medium), like the crash it often precedes. Findings reach the issue ledger with descriptive titles and their screenshot and log URIs as evidence; an app that left the foreground is titled "App left the foreground (possible crash): <appId>", not after the launcher that replaced it.
- **Device gone**: a bound device that disappeared returns `NO_DEVICE` (health unknown), not a healthy screen, and records no finding.

### qa_screenshot

Captures the screen as a session artifact and returns its `swipium://` URI with coordinate-space metadata. Alongside the capture it checks which app is in front (capped at about 1.5 s, so it can add that much on a slow backend); only a screenshot taken while the app under test was in front counts as reaching the app in `qa_report` (a home-screen screenshot doesn't). `inline:true` also returns the image: the result is a text block (the usual summary plus a scale line) and an image block with `_meta["codex/imageDetail"]: "auto"`, and has no `structuredContent`, so clients that prefer it (Codex) still show the image. On macOS a PNG with a long edge over 1568 px is downscaled to a 1568 px JPEG; the scale line gives the factor between inline pixels and screenshot pixels, so coordinates map back. `reason` is shown in the report. Counts against the screenshot budget. A sensitive session gets `SENSITIVE_MODE_REFUSED` before the device lookup, so it never sees `NO_DEVICE` first; otherwise a session without a device returns `NO_DEVICE`; a device that disappeared is `NO_DEVICE`, and a dead WDA `WDA_UNREACHABLE`. Withheld with `CAPTURE_WITHHELD_SECURE` when a password or OTP field is on screen, unless `force:true` (pixels cannot be redacted). The check uses the stored snapshot while no action or screen change happened since it; otherwise (or with no snapshot) Android and WebDriverAgent sessions dump the screen first. The same tree is checked for a React Native RedBox or the Expo dev-client launcher (no extra device call; a visual-only session has no tree, so nothing is checked): the result then has `appError` (with `failureCode:"METRO_REQUIRED"` for the bundle-load variant) and a warning line, and the screenshot doesn't count as reaching the app.

### qa_note

Records a structured outcome for one workflow, so the report is honest about what was verified.

- `workflow` and `outcome` (`pass`, `fail`, `blocked`, `skipped`, `not_applicable`) are required.
- `category` (`app_bug`, `mcp_limitation`, `missing_test_data`, `intentionally_skipped`, `destructive_refused`, `other`) says why and is independent of the outcome. A failing note without a category is recorded as `app_bug`, which also lands in the issue ledger as an app-owned `app_bug` with medium severity. Pass `category:"mcp_limitation"` for tool problems.
- Use `outcome:"blocked"` with `missingPrecondition`, `requiredState`, and `recommendedSetup` instead of a false failure.
- `reason` explains the outcome. Attach evidence in `artifactUris`; `verifiedVisually:true` says the pass was confirmed from an attached screenshot. For a screenshot-verified check, `qa_visual mode:"assert"` does both in one call.
- **Evidence links itself** (since 2.4.0): every note records one `note` step in the timeline and links the steps since the previous note as its `stepRange` (returned in the result). A `pass` or `fail` note also takes one checkpoint screenshot (`checkpointUri`, saved as artifact kind `checkpoint`), best-effort with a 3 s cap. It uses the session's existing device only (a note never attaches one) and is skipped, with the reason in `checkpointSkipped`, when no device is attached, the last step was a transport failure (`NO_DEVICE`, `DEVICE_NOT_READY`, `DEVICE_UNRESPONSIVE`, `WDA_UNREACHABLE`, `STALE_WDA_DEVICE`), the session is sensitive, a secure field is on screen, or the capture times out. It never fails the note and doesn't count against the screenshot budget.
- **A checkpoint is not proof**: it never satisfies `verifiedVisually` (that still needs an explicit `artifactUris` entry), and it is never device evidence: it doesn't count as reaching or exercising the app, so a pass note plus its checkpoint alone stays an unverified claim.
- **`artifactUris` must be this session's artifacts**: other URIs (another session's, a typo, an outside path) are dropped and listed in `warnings` (and a `⚠` line in the text); the note is still recorded. The drop happens before the `verifiedVisually` check, so a visual pass whose URIs were all dropped is refused as missing evidence.
- **A `pass` note is a claim, not evidence**: `qa_report` counts an agent's `pass` note only when the session also holds device evidence that the app was exercised: a Swipium outcome (smoke, flows, explore, audit), an exploration, an action taken while the app under test was in front, or a finding. A launch or an app-in-front screenshot only shows the app was reached, so a `pass` note on top of only those is an unverified claim: risk `caution`, app `UNVERIFIED`, and a failing `swipium: not tested` gate verdict with `NOT_TESTED` ("only an unverified qa_note pass claim on a launched app"). A `pass` note with no device evidence at all leaves the run not tested (risk `block`, app `NOT_RUN`, same gate failure). In JUnit and the summaries an unverified claim is a skipped testcase and shows as `pass (unverified)` (see [ci-reports.md](ci-reports.md#release-gate-policy)). A `fail` note always counts.

### qa_visual

Screenshot-based checks for screens without a usable UI tree (maps, canvases, games, iOS without WDA) and for visual regression.

| mode | Required | What it does |
| --- | --- | --- |
| `assert` | `assertion` | Records the agent's visual assertion: screenshot evidence plus a `qa_note` whose evidence kind is `manual_review`, so the report counts it as agent-judged, not as a visual match. Swipium does not inspect the image; the verdict is the caller's. `pass` defaults to true; `pass:false` means the expected thing is not visible. `reason` adds detail. The text reads `visual assertion recorded (agent-asserted, the screenshot was NOT checked by Swipium): pass\|fail`. Returns `{mode, assertion, pass, screenshotUri, coordinateSpace, secureFieldCheck, evidenceKind:"agent_assertion", checkedBySwipium:false}`, plus `passDefaulted:true` when `pass` was omitted. |
| `baseline` | `name` | Saves the screen as `<repo>/.swipium/baselines/<name>.png` (commit it or ignore it) plus a session artifact. |
| `diff` | `name` | Compares the screen to a baseline. Returns the changed ratio, the changed box (screenshot and device space), and an evidence artifact. `pass` means within `threshold` (default 0.02). |
| `find_text` | `query` | OCR through a locally configured provider (none is bundled). Consent `ocr_run` (medium). `minConfidence` defaults to 0.8. OCR text is secret-redacted. |
| `find_image` | `template` | Template-matches a PNG. `minScore` defaults to 0.85. |

A mode called without its required argument returns `INVALID_ARGUMENT`. In a sensitive session every mode is refused with `SENSITIVE_MODE_REFUSED`, checked before the device lookup (like `qa_screenshot`).

- **Paths**: `name` must match `[A-Za-z0-9._-]{1,64}` and must not start with `.`. `template` must be inside the project root (after resolving symlinks) or a `swipium://` artifact of the same project. Escapes and symlinked baselines return `VISUAL_PATH_REFUSED`.
- **Coordinates**: finds return a bounding box in screenshot pixels and a tappable `devicePoint`: points on iOS (WDA and `idb`), pixels on Android. Every result declares its `coordinateSpace`.
- **Tapping**: `tap:true` taps the found point through the driver. On a simulator without WDA it uses `idb ui tap` when `idb` is on PATH, else it returns the coordinates with install steps. Taps are recorded as session actions (for `qa_generate`) and count against the action budget.
- **Budgets**: every capture counts as a screenshot. Nothing runs once a budget is spent.
- **Secure screens**: every mode is withheld (`CAPTURE_WITHHELD_SECURE`) when a password or OTP field is on screen, unless `force:true`. When the cached UI tree is missing or older than a visual tap, Android and WDA re-dump it to check. With no UI tree at all (a simulator without WDA) in a session that has handled credentials, only `baseline` is withheld, because it persists the capture in the repository; `diff` and `assert` still run but save no screenshot (`currentUri`/`screenshotUri` is `null`, `captureWithheld:true`), and `find_image` returns coordinates only. `find_text` screens the OCR text itself and withholds a screen that reads like a password, OTP, or payment screen. Results carry `secureFieldCheck`: `clear`, `secure`, `forced`, `ocr` (only the OCR text was checked), or `unverified`; the last two come with a warning.
- **OCR provider contract**: set `ocrCommand` in `.swipium/config.json` (an argv array with an `{image}` placeholder, or `{command, io:"json", timeoutMs}`), or the `SWIPIUM_OCR_CMD` environment variable; the project config wins. The command runs with the project root as its working directory, gets a symlink-resolved PNG path (already masked when `visualMaskCommand` is configured), and must print JSON to stdout: `[{"text":"Log in","confidence":0.97,"bbox":{"x":53,"y":182,"width":104,"height":38}}]` or `{"regions":[…]}`, with the box in screenshot pixels, confidence from 0 to 1, and one region per text line. With `io:"json"` it also receives a `swipium.visual.provider.v1` JSON line on stdin. The default timeout is 30 s. Provider images go to a private per-call temporary directory (mode 0700) that is removed afterwards.
- **Provider failures**: a non-zero exit or a timeout returns `OCR_PROVIDER_FAILED` with `provider`, `exitCode`, `timedOut`, and the trimmed, secret-redacted `stderr`, never `found:false`. A Git executable as the provider is refused with `GIT_SCOPE_FORBIDDEN`. Without a provider, `find_text` returns `OCR_NOT_CONFIGURED` with an `exampleProvider`: a tesseract script to save as `.swipium/ocr_tesseract.py` (needs `brew install tesseract`), used with `"ocrCommand": ["python3", ".swipium/ocr_tesseract.py", "{image}"]`.
- **Mask command**: `visualMaskCommand` in `.swipium/config.json` (or `SWIPIUM_VISUAL_MASK_CMD`; the project config wins) follows the same contract and failure rules. The `ocr_run` consent prompt shows every command that will run, the mask command first, each with its argv and where it came from; a command from the repository's `.swipium/config.json` is labelled "unreviewed". `affects` carries `maskArgv` too.

### qa_wait

Blocks (bounded) until a setup condition holds, instead of a shell `sleep`. `for`: `device_online` (the session's own device, or the pinned one. On a session bound to an Android device it waits for that serial only, or for its AVD booted again under another serial, which it reports with a re-bind hint; on a session bound to a simulator it waits for that simulator to be booted; on an unbound session with `SWIPIUM_DEVICE` set only the pinned serial, AVD or simulator counts. Other online devices never satisfy it, and a timeout is `DEVICE_NOT_READY` (`satisfied:false`, `timedOut:true`) with a re-boot next step naming the device or pin), `metro_ready` (Android and iOS sessions), `wda_ready` (the session's WebDriverAgent `/status` reports ready: the attached WDA, else the URL of the last `qa_wda start`, else the configured `ios.wda.url`, and with a simulator bound, that simulator's own managed WDA on its per-simulator port when the configured one isn't its; an owner that can't be checked (`unverified`) keeps it polling, never ready; a non-loopback configured URL is refused with `DESTRUCTIVE_REFUSED` until it is attached with consent), or `simulator_booted` (the iOS Simulator bound to the session finished booting, for example after `qa_ios boot` returned `status:"booting"`; no bound simulator is `NO_DEVICE`, and a boot that failed in the background is `SIMULATOR_BOOT_FAILED` or `SIMULATOR_BOOT_TIMEOUT` instead of a timeout). A ready WDA that belongs to another simulator is `STALE_WDA_DEVICE` (`satisfied:false`), and a Metro that serves another project is `METRO_WRONG_PROJECT`, both returned at once. `timeoutMs`: integer of at least 0, default 45000 (or the cap, when smaller); larger values (older docs used 60000 or 180000) are accepted and clamped to `SWIPIUM_MAX_WAIT_MS` (default 50000) with a note naming the cap, so one call stays under the client's tool timeout. On `timedOut`, call again. Returns `satisfied`, `timedOut`, and the current state. Cancelling the call stops polling at once and returns `CANCELLED`. To wait for a job, use `qa_job_status` with `waitMs`.

## Run

Smoke checks, exploration, and reports.

### qa_smoke

Server-side smoke on a prepared device: optionally launches (`launch`, default true with an app id), runs the baseline (snapshot quality, health, an evidence screenshot, skipped in sensitive sessions), then every saved flow in `.swipium/flows` (`runFlows`, default true) with `variables`. Records a `qa_note` per workflow; call `qa_report` afterwards.

After launch (and with `launch:false` too, whenever the session has an app id) it waits (bounded) for the app to render before the baseline. The wait ends as soon as real content is on screen (anything beyond the app's root node, with no loading marker), on the first dump, when an interactive element is there, or on two rendered dumps in a row; it does not wait for an animated screen to stop changing. A loading marker is a React Native banner (`Bundling 47%`, `Bundling…`, `Downloading 100%`, `Loading from localhost…`, `Building JavaScript bundle`, `Connect to Metro…`) or the app's own splash or loading screen: an element id containing `splash` (`nav.splash`, `SplashScreen`), or a short caption that is only a loading message ending in `…` or `...`. A strong caption ("Loading…", "Downloading…", "Refreshing…", "Please wait…") and a splash id count on a screen with at most 2 controls, so a feed's "Loading more…" row doesn't count. A weak caption (starting with "Looking for", "Fetching", "Preparing", "Getting ready" or "Starting up", such as "Looking for your plane in the sky…") counts only when it is the whole screen: no control and no other text, so a "Looking for nearby devices…" line on a rendered screen isn't `BLANK_SCREEN`. While a loading marker is on screen it waits up to 30 s. A blank tree (an iOS splash with only the app's root node counts as blank) gets up to 15 s, extended to the full 30 s when Metro is listening, so a cold bundle isn't cut off. On a visual-only screen it waits up to 8 s for two identical screenshots. A dump that fails before any tree was read is retried within the blank bound; when no tree is read at all, health stays `unverified` rather than `BLANK_SCREEN`. A tree still blank, or still on a loading marker, at the end makes `launch_smoke` `blocked` ("app showed no UI after N s … launch NOT verified", category `other`, with a `qa_wait {for:"metro_ready"}` or check-the-logs setup step), sets `baseline.launch.failureCode:"BLANK_SCREEN"` with `notRendered:"blank"` or `"loading"`, and app health `unverified`. A banner still up at the end is never judged a `fail`, because a slow cold bundle is not an app bug; an app that really never leaves its loading screen shows up as the same `BLANK_SCREEN` block; an app whose first screen has no accessibility nodes at all (a pure canvas or game, an opaque WebView) is reported this way too. The wait stats are in `baseline.launch`. Without a UI tree the baseline's app health is `unverified`, not `ok`. A RedBox that needs Metro (or the Expo dev-client launcher) makes `launch_smoke` `blocked` with `METRO_REQUIRED`. When WDA returns no UI source after the launch (for example hung on a splash after a cold simulator boot), the smoke re-probes once (5 s), then marks `launch_smoke` `blocked` with category `mcp_limitation` and `baseline.launch.failureCode:"WDA_UNREACHABLE"` (a tool or environment failure, launch not verified, with "restart WDA or relaunch the app" as the setup step). The render wait, the settle after the launch included, is bounded at 30 s from the launch, so the verdict comes about 35 s after it; the health verdict is then built without calling WDA and the evidence screenshot comes from `simctl` (see [qa_test_this](#qa_test_this)). After any of these, and after a high app finding at launch (a fatal RedBox or Expo's "App entry not found"), the saved flows are not run: each is noted `blocked` ("launch failed: …; flows not run", `blocked (app not rendered)`, `blocked (METRO_REQUIRED)`, or `blocked (WDA_UNREACHABLE)`) rather than failed. A saved flow that fails with `WDA_UNREACHABLE` blocks the flows after it the same way.

A failed saved flow is classified at the source: a missing variable or fixture (`MISSING_FIXTURE`, `MISSING_SECRET`) is `blocked` with category `missing_test_data`; a Swipium-generated or compiled flow that fails on a locator step is `fail` with category `other` (automation or starting-state drift, not an app bug: in the report it makes coverage `BLOCKED` and risk `caution`, never app `BLOCKED`); a flow whose app is not installed (`BUNDLE_ID_NOT_FOUND` from its launch step) is `blocked` with category `other`, a setup problem; other tool-side codes are `mcp_limitation`. A flow stopped by the session budget is `skipped` (`intentionally_skipped`) with `BUDGET_EXHAUSTED` and "stopped at step N", never a flow or app failure; raise the budget with `qa_start_session {budget}` and run it again.

Repository flows are untrusted, so `qa_smoke` never runs a flow with mutating steps or an external OCR or visual provider implicitly. Such a flow is skipped: its entry in `flows[]` has `skipped:true` and the reason "skipped: mutating steps (…) need flow_mutation_run consent; run it with qa_flow_run", it is left out of `flowsTotal` and counted in `flowsSkipped` (the summary reads, for example, `flows 0/0 passed, 1 skipped (need consent)`), and its note is still `blocked` (category `destructive_refused`), so the gate sees a flow that didn't run.

When `qa_prepare_ios_target` found this simulator's WDA hung and it still doesn't answer, `qa_smoke` reports `WDA_UNREACHABLE`, the same verdict `qa_test_this` gives, instead of running visual-only.

Cancelling the call skips the rest of the baseline and flows and returns `CANCELLED` (`changedState:true`). The interrupted workflow is noted as `skipped`, never as a failure or a health finding.

### qa_explore

Bounded, safe-by-default exploration of the launched app, as a job. It observes screens, taps ranked safe actions, checks health after each, and builds a screen graph (JSON and Markdown, `graphUri` in the job result). Taps are recorded for `qa_generate`, and the app map is updated.

- **Bounds**: `maxActions` (20), `maxScreens` (12), `maxDurationMs` (360000), all positive integers. `depth` (default 3, also a positive integer) is not a depth limit: `1` turns off going back from a dead-end screen. `goal` is a natural-language focus.
- **`strategy`**: `crawl` (default, deterministic), `task_planner` (infer QA tasks first), or `hybrid`.
- **`safeMode`**: `strict` (default); `balanced` (unknown-risk actions allowed); `dry_run_destructive` (lists destructive candidates without tapping); `approved_destructive_candidate` (taps exactly one candidate from a dry run). `approved_destructive` is refused with `DESTRUCTIVE_REFUSED`.
- **`approved_destructive_candidate` requirements**: an exact `destructiveCandidate` copied from the dry run (else `DESTRUCTIVE_REFUSED`); disposable test state, meaning a fixture with `disposable:true` or `environment:"test"` (else `MISSING_FIXTURE`); `confirmHighImpact:true` for payment, send, permission, account-delete, and bulk-delete candidates; and the `destructive_ui_candidate` consent (high).
- **Text and data**: `includeTextEntry` (default false) types into fields that have a value source (fixtures). `allowGeneratedData` permits generated disposable test data; `accountCycle` additionally permits logout, only on a disposable generated account. Generated values are recorded under `SWIPIUM_TEST_*` or `SWIPIUM_GEN_<FIELD>` names (see [Secrets and redaction](concepts.md#generated-output)).
- **Auth**: `stopOnAuth` (default true) returns `needs_input` at an auth wall without credentials. With `stopOnAuth:false` the wall is recorded once as a blocked note and exploration keeps going on the public screens (auth controls are not safe, so strict mode never taps into the login). A secure field is always a wall; auth wording ("Sign in to your account") counts only next to a non-search input field or on a screen with fewer than 4 other controls, so an optional sign-in row in a settings list doesn't stop the run.
- **Risk**: state-changing controls (dismiss, archive, snooze, mute, mark as read or done, turn on or off, enable or disable, undo) are `unknown` risk and skipped in `strict` mode; a dialog's negative button stays safe. Tabs rank above overflow ("More options") menus, and a control that already led to a screen is not tapped again from other screens.
- **Feature coverage**: a feature is `covered` when a visited screen's title, or a tap or type that changed the screen, matches it; a feature only seen as a label on some screen is `observed` (not covered). The other statuses are `blocked`, `unsafe`, `not_found` and `needs_fixture`.
- **Going back**: when a screen has nothing safe left to tap, the explorer goes back and checks on the next look that the screen really changed (the edge records the real result, or `blocked` when back left the app). A back that changes nothing counts as a no-change action (3 in a row stop the run), and that screen is never backed out of again: the explorer tries an in-app back or close control once (a label such as "Back", "Go back", "Navigate up" or "Close", or an id ending in `back` or `close`), then relaunches the app (terminate, launch, render wait; at most 2 relaunches per run), and the screen after a relaunch becomes the graph's root. With no way back left, the run stops with `no way back from "<title>"`.
- **Navigation steps count**: back, in-app back, relaunch and alert-close steps count against `maxActions` and the session's action budget, like taps. The stop reason says how many there were: `action budget reached (N, k of them back / relaunch / alert-close steps)`.
- **Other apps and alerts**: a screen of another app (iOS Settings, a browser) always counts as leaving the app, also next to a permission dialog; on iOS only SpringBoard (a system alert) is exempt. A run that starts in another app relaunches the app instead of mapping that screen, and other apps' screens are removed from the graph, so they earn no feature coverage. An alert (an iOS alert, including the app's own `UIAlertController`) is closed with its cancel button (Cancel, Close, Not Now, Dismiss, Don't Allow, No thanks, Maybe later, Later, Skip; OK or Got it only on a single-button alert; at most 5 per run) and never explored, so its "Settings" button is never tapped; an alert without a cancel button stops the run.
- **Sign-in with a third party**: "Sign in with Apple", "Continue with Google" and other third-party or OS sign-in controls (Apple, Google, Facebook, Microsoft, Twitter, GitHub, LinkedIn, by label or by ids such as `social-signin` or `google_sign_in`) are never tapped, in any `safeMode`, `balanced` included.
- **Budget**: only one evidence screenshot per distinct screen is saved and counted against the screenshot budget (plus one for a screen showing an app error); revisits reuse the screen's first screenshot. A session-budget stop ends the job `state:"blocked"` (never `completed`) with `failureCode:"BUDGET_EXHAUSTED"` and `nextRecommendedAction` `qa_start_session` with a larger budget. A run cut by `maxDurationMs` also ends `state:"blocked"` (it was `completed`), with `stoppedReason` `time budget reached (<s> s; <n> actions, <m> navigation steps)`; `qa_report` then lists an "exploration blocked" coverage gap (risk `caution`, never SHIP), and in `qa_test_feature` the run is `blocked` with that reason.
- **`generateSuite:true`** also writes and compiles a POM suite from the promoted paths. `suitePromotion` scoring is always returned.

### qa_report

Assembles the session report: executive summary (release risk ship, caution, or block, plus the next action), health, outcomes by workflow, findings, evidence links, environment changes and their restoration, the mutation ledger, and workarounds. It never binds a device: a session without one reports without a UI dump. Saves the full report as `report.json`, saves an agent-readable summary as `report.md` (`report-<timestamp>-summary.md`, `text/markdown`), writes `report.html` for a human, and returns the lean view. `qa_test_this` calls it automatically.

- **Result**: `structuredContent` holds `sessionId`, `appId`, `device`, `executiveSummary`, `appVerdict`, `coverageVerdict`, `toolVerdict`, `prSummary`, `counts` (`findings`, `findingOccurrences`, `highSeverity` (`highSeverityCount`: unique high findings, tool and environment findings such as `WDA_UNREACHABLE` left out), `toolErrors`, `outcomes` (`qa_note` outcomes only), `testCatalog` (the run's test-catalog counts, which also include cases derived from findings and exploration), `artifacts`), the URIs (`reportMdUri`, `reportUri`, `reportHtmlPath`, `reportHtmlUrl`, `manifestUri`, `dumpUri`, and `exportUri` with `exportFormat` for an export), `reportLinks` (always present; `null` without `baseline` or `trendRoot`), and `summary` (the summary text). The full report payload (plus `manifest`) comes back only with `format:"json"` or `responseMode:"verbose"`, and since 2.4.0 without `steps`: `stepsUri` points at the saved `report.json` that has them, so a long run doesn't flood the context. Otherwise read `report.md`, or `report.json` for CI.
- **`report.html`**: one self-contained page per session at `<session>/report/report.html`, overwritten on every call, rendered from the already-redacted report. `reportHtmlPath` is its absolute path and `reportHtmlUrl` its `file://` URL; give the user that path. It has no JavaScript and a strict Content-Security-Policy, loads nothing from the network, and embeds screenshots as 480 px wide thumbnails (8 MB in total, then file paths). Layout and contents: [What's in a report](concepts.md#whats-in-a-report). When it can't be rendered, both fields are `null` and `reportHtmlError` says why; `report.json` and `report.md` are still written. Its artifact record says `redaction:"not-applied"`, because the embedded screenshots are pixels.
- **Summary (`report.md`, and the result text)**: at most 2 KB, failure first: the release risk and reason, a `Partial:` line when another job was still running, health, the not-tested reason once with its fix and the log to read, up to 8 failed or blocked outcomes (each with its failing step `#i`, failure code, and a screenshot URI to fetch with `qa_get_artifact` or `(no screenshot: <reason>)`, then `+N more in report.html`), up to 5 findings, `Passed: N of M outcome(s)` with flaky, contradicted and unverified counts, `Open the report: <reportHtmlPath>`, and the `report.json` location. The result text adds `report.md: <uri>`. Readiness, QA level, evidence taxonomy, the mutation ledger, WDA details, timing and the artifact list are in `report.json` and `report.html` only.
- **Step timeline**: `report.json` has `steps[]` (`i`, `at`, `durationMs`, `source` (`act`, `flow`, `smoke`, `explore`, `note`), `action`, `target` (a short label such as `tap "Sign in"` or `type into "Email"`; typed text never appears), `result` (`ok`, `failed`, `no_change`), `failureCode`, `screen`, `screenshotUri`, `dumpUri` on failed steps, `screenshotSkipped` with the reason when no screenshot was taken, `group` (the flow or workflow)). At most 500 steps are kept: the oldest passing steps are dropped first, so early failures survive.
- **Outcomes** (`testOutcomes[]`) carry `stepRange` (the steps they cover), `evidence[]` (this session's artifacts only: the note's checkpoint, the screenshot and dump of failed steps in the range, and its `artifactUris`), and display flags that don't change the gate: `unverified` (an agent pass claim nothing backs), `contradicted` (a pass whose range holds a high crash, ANR or app-error finding, or a failed flow or smoke step; a failed `qa_act` step doesn't count), and `flaky` when the workflow's attempts include both a pass and a fail (the other attempts are in `attempts[]`) (see [ci-reports.md](ci-reports.md#release-gate-policy)). An outcome with nothing captured renders `(no evidence)`.
- **`partial`**: `{jobId, kind}` when another job of the session (an exploration, a suite replay, a second `qa_test_this`) was still running, else `null`. It is in `report.json`, the HTML banner and the summary. `qa_test_this` and `qa_test_feature` don't count their own job.
- **Other `report.json` fields** added in 2.4.0: `schemaVersion: 2`, and `artifacts[]` with `path` (relative to the session folder, never absolute), `createdAt` and `redaction`.
- **Re-calls**: a second call with no new activity since the last one (same notes, findings, steps, recorded actions and exploration) reuses that report's suite and issue results instead of folding them into the suite, the issue ledger and the app map again.

- **`baseline`** (a baseline `report.json` path) adds comparison links; **`trendRoot`** (a project root) adds trend and flake context from the latest report of each of that project's saved sessions, plus report files copied into its `.swipium/runs` or `.swipium/ci`. With fewer than 2 reports, `flakeStatus` is `not_checked`; unreadable reports are skipped and listed in the trend's `unreadableReports`.
- **No evidence never ships.** A run that never reached the app, or a `qa_test_this` run that ended `blocked` or `unsafe`, has release risk `block`, app verdict `NOT_RUN`, coverage verdict `NONE`, and QA level `not_observed`, and the report JSON carries `notTested: {reachedApp:false, reason, failureCode}` (code `NOT_TESTED`, or the blocker's code). Reaching the app takes a launch of the app under test that reached the foreground (by a prepare call, `qa_smoke`, or `qa_ios launch` of the session's own app; a launch of another bundle or a failed launch doesn't count), or a screenshot or recording taken while the app under test was in front (a home-screen screenshot, or one showing a RedBox, doesn't count). Reaching is not exercising: only a Swipium pass or fail outcome (smoke, flows, explore, audit), an exploration, an action taken while the app under test was in front (an action on SpringBoard or another app, or a press home, doesn't count; neither do `qa_visual` taps, and first-run actions count only when the app was in front), a health finding, or an agent's fail note count as exercising it. An agent's `qa_note` pass counts only on top of that; with only a launch or a screenshot behind it, it is an unverified claim (risk `caution`, app `UNVERIFIED`, gate fails with `NOT_TESTED`, reason "only an unverified qa_note pass claim on a launched app … run qa_smoke or a flow"), and with nothing behind it the run is not tested (`block`). Blocked or skipped notes never upgrade an untested run, a fail note under `mcp_limitation` doesn't count as exercised, and the report's own UI dump and exports are never evidence. A run that reached the app but exercised nothing (only a launch or a screenshot plus blocked notes, or `qa_test_feature` with 0 cases executed) is `caution` with coverage `NOT_COVERED`, and its `notTested` is `{reachedApp:true, exercised:false, reason, failureCode}` with the blocked note's code (for example `BLANK_SCREEN` or `METRO_REQUIRED`), else `NOT_TESTED`; the gate fails it too. A not-tested verdict is kept on the session: every later `qa_report` reuses its reason and code (so `METRO_REQUIRED` doesn't turn into `NOT_TESTED`) until it is retested after it: a Swipium outcome or an exploration, or an agent outcome note together with an action taken with the app in front. An action alone, a finding, a launch, or a screenshot plus a note don't clear it. A prepare call that launched onto a bundle-load RedBox or the Expo dev-client launcher sets the same marker, with `METRO_REQUIRED`. Without a `qa_test_this` marker, the code comes from the first blocked note whose reason starts with a failure code; when nothing was exercised after a refused consent, it is the refusal's code (`CONSENT_CANCELLED`, `CONSENT_DECLINED` or `CONSENT_REFUSED`, reason `nothing ran: consent for "<action>" was refused (<code>)`). When the app was never reached, native and app health are `not checked` (not `OK`), and `emulatorDisplay` is `null` without a device. CI exports gate it as a failed workflow (see [ci-reports.md](ci-reports.md#release-gate-policy)).
- **Verdicts**: the app verdict (`PASS`, `PASS_WITH_WARNING`, `UNVERIFIED`, `BLOCKED`, or `NOT_RUN`; `UNVERIFIED` means the app launched but its health was not verified, so check the screenshot: the app verdict's summary names why: no UI tree was read at all (a visual-only run), the automation backend returned no UI tree (a tool failure), or the launch smoke could not judge the screen; app health is `unverified`, the risk is at most `caution`, and the QA level stays OBSERVED), the coverage verdict (`COVERED`, `SMOKE_ONLY`, `PARTIAL`, `BLOCKED`, `NOT_COVERED`, or `NONE`), and the tool verdict are separate, and tool status never changes the app verdict. When the app showed a fatal error screen (app or native health `error`), the canonical suite merge keeps only recorded outcomes, so no test cases are generated from the error screen. The tool verdict (`toolVerdict.status`) is:
  - `BLOCKED` when a workflow was limited by a Swipium or MCP capability (a `qa_note` with category `mcp_limitation`);
  - `DEGRADED` when tools returned typed driver or Swipium errors (for example a WDA 404 or a snapshot failure), or a tool call threw a raw, uncoded error instead of returning a result (recorded with `thrown:true`; cancellations and protocol errors are not recorded);
  - `PASS` otherwise.

  Recorded tool errors are listed in `toolErrorsByCode` with `degradingCount`, `uncodedCount`, and `probingCount`. Uncoded errors (`UNKNOWN`, mostly deliberate refusals and guard messages), agent-probing codes (`ELEMENT_NOT_FOUND`, `STALE_REF`, `AMBIGUOUS_SELECTOR`, `INVALID_ARGUMENT`) and environment gate refusals (`environmentCount`: `METRO_REQUIRED`, `METRO_WRONG_PROJECT`, `DEV_SERVER_DOWN`, `MULTIPLE_DEVICES`, `DEVICE_PINNED`, `NOT_MOBILE_PROJECT`, `MONOREPO_TARGET_AMBIGUOUS`, `PROJECT_ROOT_EMPTY`, `PROJECT_ROOT_UNRESOLVED`, `MULTIPLE_ARTIFACTS_AMBIGUOUS`, `ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL`) are counted but never make the verdict `DEGRADED` on their own. Real environment failures (`WDA_*`, `NO_DEVICE`, build failures) still do. Consent refusals, missing test data, and `CANCELLED` are not recorded as tool errors.
- **Deduplicated findings**: identical findings (same failure code and kind, severity, layer, screen or foreground, and message) are reported once, with `count`, `firstAt`/`lastAt`, and every distinct `screenshotUris` entry. `findingOccurrences` keeps the raw total; text and markdown show repeats as `(×N)`.
- **Network restore**: a network change made during the session is restored when the report is generated. A restore that fails is reported in `networkRestore` instead of failing the report.
- **Release-gate policy**: when `.swipium/policy.json` is invalid (ignored, so every failure blocks) or has unknown keys (ignored), `report.json` says so in `releasePolicyNotice`.
- **`format`** adds an export artifact (`exportUri`, `exportFormat`). The CI formats carry the `.swipium/policy.json` release-gate verdict ([CI policy](flows.md#ci-policy)). The same files can be rendered outside the agent with the `swipium report` CLI; recipes and exit codes are in [ci-reports.md](ci-reports.md).

| Format | Notes |
| --- | --- |
| `summary` (default) | No export. |
| `markdown`, `json` | The full report. The saved report is deep-redacted with the session's secrets before it is written. |
| `junit` | One case per workflow (latest attempt) with a unique name and a `time`, then one per high-severity finding. Failed workflows and high app findings are `<failure type="<failureCode>">`. Tool and environment failures (`mcp_limitation`, environment-bucket codes, a `WDA_UNREACHABLE` finding named `tool/wda_unreachable`) and the `swipium: not tested` case a run that never reached the app gets are `<error>`. Blocked, skipped, and not-applicable outcomes are `<skipped message="blocked: …">`, and so is an unverified `qa_note` pass claim ("unverified manual claim"). Medium and low findings are not cases. Failures the policy treats as lenient (`warnOn` or `ignoreKnown`) are `<skipped message="policy …">`, so a passing gate never fails CI. Always two suites (workflows, then findings, empty when there are none). Details: [ci-reports.md](ci-reports.md#what-each-file-contains). |
| `sarif` | Experimental. SARIF 2.1.0 with one result per high-severity app finding only (no workflow, not-tested, tool or medium/low results), with fingerprints built from the rule, screen and detail. Every result is anchored to a real repository file (a `%SRCROOT%`-relative `physicalLocation`, line 1), as GitHub code scanning requires: the app-map source file of the screen or workflow, else the first project manifest that exists (`app.json`, `package.json`, `pubspec.yaml`, Gradle files, `Info.plist`, `README.md`), skipping build products (`*.app`, `build/`, `DerivedData`, `Pods`, …), then an Xcode project (`ios/*.xcodeproj/project.pbxproj`, then `*.xcodeproj/project.pbxproj`), then the first non-hidden file in the root, then `.gitignore`; `package.json` only when the root holds no file at all. Results are `error` (`warning` or `note` when the policy warns on or ignores them). `swipium://` evidence stays in related locations and properties. `invocations[0].executionSuccessful` is always `true`, because the run itself worked. The gate verdict is `runs[0].properties.releaseGateVerdict` (`pass` or `block`). |
| `github-summary` | Markdown for `$GITHUB_STEP_SUMMARY`, failure first (verdict, the not-tested reason or the failures with their failing step and code, the outcomes table, findings, then `Full report: the swipium-report.html artifact of this run`), capped at 900 KB (below GitHub's 1 MiB limit) so the verdict always survives. Truncation is stated in the output. The gate line reads `✅ PASS` or `❌ BLOCK`; the app line says `(not resolved)` and `(no device bound)` instead of placeholders. Evidence shows as `swipium://` code spans, not links, and no images are embedded. Control characters and ANSI escapes from run text are stripped. The severity counts leave out tool and environment findings (`WDA_UNREACHABLE`) and add a `· N tool/environment` count, and an unverified `qa_note` pass claim is tallied as `pass (unverified)`. |
| `playwright` | Deprecated; it will be removed in a future release (the JSON carries a `deprecated` note, and the result text says so). Playwright JSON-reporter-style results: one spec per workflow outcome, with evidence attachments. An unverified `qa_note` pass claim is `skipped`. |
| `flow` | The recorded actions as Flow V2 YAML. Needs recorded actions. |

## App map

The durable app knowledge map in `.swipium/app-map.json`, also served as MCP resources. It is project memory: read it before feature work.

### qa_app_map_build

Builds or updates the map: a framework-aware static scan (Expo Router, React Navigation, the Android manifest, SwiftUI and UIKit, Flutter) plus, with `sessionId`, a merge of the latest exploration screen graph. `mode`: `static_only`, `runtime_merge`, or `full` (default). `includeCodeIndex` (default true) persists a code-symbol index for queries; `forceRescan` rescans even when the map is current. Returns a summary and the map URI. Does not commit.

### qa_app_map_read

Reads one compact section: `summary` (default), `screens`, `features`, `auth`, `automation`, `testSuite`, or `full`. `featureId` or `screenId` drills into one node. Large sections come back as a resource URI; `section:"full"` says to read it with `qa_get_artifact {uri: appMapUri}` on clients without MCP resources. Without a map: `NO_APP_MAP`.

### qa_app_map_query

Searches the feature index, static topology, runtime graph, and tests for a natural-language `query` (for example "checkout flow"). `intent` (`feature`, `screen`, `code`, `test`, `freeform`) biases the search; `limit` caps it. Each result has provenance, confidence, source files, screens, and the recommended next Swipium call.

### qa_app_map_feature_scope

Resolves a feature (`featureId`, or a free-text `query`) into a focused test scope: code symbols, static and runtime screens, existing tests, objective, coverage gaps, strategy, and ranked candidates. It asks one disambiguation question only on a genuine tie. Works without a map (it falls back to a code scan). `includeCode` (default true) and `limit` (default 8 per list) shape query mode; `platform` (`android` or `ios`) only names the platform in the objective; `sessionId` adds runtime evidence.

### qa_app_map_update

Targeted, provenance-tracked edits without a rebuild: `note` (a user note), `testCases`, `automationSuite` (link a suite to features and screens), `environment` (for example `test` or `staging`), or `featureCoverage` (override a feature's coverage). Existing entries with the same id or path are overwritten, which is why the tool is marked destructive.

## Feature

### qa_test_feature

A focused test of one named `feature` (natural language).

- **`mode:"execute"`** (the default since 2.3.0): a job that explores toward the feature, records pass, fail, or blocked per case, updates the app map, and writes a report (see the `qa_job_status` result). `interactive` runs until the first question.
- **`mode:"plan"`** (read-only): scope, objective, generated cases, required fixtures, and an ordered plan.
- **Without `sessionId`**, `execute` bootstraps a device from `projectRoot` (optionally `platform` and `device`) with one consent for boot, install, and launch. The boot, install, and launch run inside the job, so the call returns at once; a preparation failure fails the job with the same blocker the call used to return. The consent envelope carries the new `sessionId`; pass it on the approving re-call so that session is reused. A `sessionId` whose session has no device yet is prepared in place, never replaced by a new session.
- A feature behind auth, a paywall, a permission, or a missing fixture is **blocked** with setup guidance, not failed. A blocked run's job is `status:"done"` with `result.state:"blocked"` (as `qa_explore` does), not `failed`. A session-budget stop carries `failureCode:"BUDGET_EXHAUSTED"` and `nextRecommendedAction` `qa_start_session` with a larger budget; exploration saves one evidence screenshot per distinct screen, so revisits don't use up the screenshot budget.
- A run that executed none of its cases says so in its report (`0 of N "<feature>" case(s) were executed`): coverage `NOT_COVERED` and release risk `caution` (or `block` when nothing was exercised), never SHIP. `nextRecommendedAction` reads `report.md`.
- The job result carries `reportUri`, plus `reportHtmlPath` and `reportHtmlUrl` for `report.html` (`null` when it could not be written), and the text says `Open the report: <path>`. The run's own job never marks its report `partial`.
- Other parameters: `creativity` (`conservative`, `standard`, `creative`, `adversarial`) with `allowAdversarial`, `maxScreens` (default 8), `maxActions` (default 20), `timeoutMs` (accepted and ignored: the run is bounded by `maxScreens` and `maxActions`; poll `qa_job_status`), `generateCases` (default true), `includeCode`, `limit`.

## Flows

Validate, run, compile, and repair reusable Flow V2 files under `.swipium/flows/`. The file format, step reference, variables, and CI policy are in [flows.md](flows.md).

`flow` is a name (`.swipium/flows/<name>.yaml`, `.yml`, or `.json`) or a `.yaml`, `.yml`, or `.json` path under the project root. Without a session, `qa_flow_check` and `qa_flow_run mode:"plan"` resolve it against `projectRoot`, then the session root, then MCP roots, then `SWIPIUM_PROJECT_ROOT` / `CLAUDE_PROJECT_DIR`, then a server working directory that looks like an app. A path (after symlinks) outside the project root, any other file type, or a path flow when no root resolves, is refused with `UNSAFE_ACTION_REFUSED` and never read; inline `flowYaml` is unaffected. A flow that does not exist returns `FLOW_NOT_FOUND` with the paths checked; a call with neither `flow` nor `flowYaml` returns `INVALID_ARGUMENT`; YAML that does not parse returns `INVALID_FLOW`, as does a POM test file (`.swipium/tests/*.yaml`), whose error names the compiled flow to run instead.

### qa_flow_check

Statically validates a flow (a lint of the YAML) without running it: syntax and schema errors with the offending step, plus warnings. Pass `flow` (see above) or `flowYaml`. `platform` (`android`, `ios`, `cross-platform`) adds platform-aware locator warnings. `ci:true` adds CI preflight checks: variables a CI run cannot resolve, and mutating steps the [CI policy](flows.md#ci-policy) does not allow. Lint errors fail the check: the result is `INVALID_FLOW` with `valid:false` and the errors in `lintErrors` (for example a mutating step other than `restartApp` without a `ciAllowMutations` policy under `ci:true`, or an inline secret, `INLINE_SECRET`: an `inputText` literal rather than a `${VAR}` that has `secret:true`, is one word carrying a credential word such as `hunter2Password` or `my_api_key`, or holds a `password: x` or `token=x` pair, while a sentence such as "secret santa" is not flagged; `restartApp` is allowed in CI without a policy entry); before 2.3.0 they were listed under `warnings` with `valid:true`. Warnings are de-duplicated, and "No appId" is only raised for a flow with a `prepareTarget` or `restartApp` step. A negative or non-numeric `wait`, `waitForIdle`, or `timeoutMs` is a schema error.

### qa_flow_run

- **`flowYaml`** runs an inline flow without a file. It is the cheap way to batch 3 or more known steps in one call instead of one `qa_act` per step ([example](flows.md#batching-steps)).
- **`mode:"run"`** (default) executes a flow on the prepared session, server-side, with setup and teardown, fail-fast, and no automatic retry of mutating steps. Without a prepared device it is `NO_DEVICE` (`INVALID_ARGUMENT` when no `sessionId` was given). `repeat` (1 to 10) runs it several times to classify flakes; the likely cause is `selector_weakness`, `backend_timing`, `environment_setup`, `app_nondeterminism`, `wrong_start_state` (the run failed on its first locator step after only launch or reset steps: start the flow with `restartApp`), or `mixed`. A failure returns the failed step (`failedAtStep`), a screenshot, the `failureCode`, health, and `nextSteps` pointing at `qa_flow_repair {flow, failedStep}` (except when the cause is a missing variable, which is not locator drift).
- **Outcome**: every run is recorded on the session as the flow's outcome, so `qa_report` counts it (filed like a saved flow in `qa_smoke`). A pass is a pass. A Swipium-generated flow failing on a locator step is automation drift (risk `caution`, coverage `BLOCKED`); a tool-side code is a Swipium limitation (`caution`); a flow whose app is not installed on the device fails its launch step with `BUNDLE_ID_NOT_FOUND` and is `blocked` (category `other`, an environment problem, with an "install the app or fix the flow's appId" setup step), not a Swipium limitation; a missing variable is `blocked`; a session-budget stop is `skipped`; any other failure (a hand-written assertion, a crash) is an app failure (`block`). With `repeat`, the first failed run is recorded, with the pass count. A cancelled run records nothing.
- **`mode:"plan"`** previews without a device: per backend (`android-direct`, `ios-raw-simulator`, `ios-wda`, `appium-uiautomator2`, `appium-xcuitest`; `backend` narrows it), whether each step is `native`, `fallback`, `visual_only`, or `unsupported`. `appium` passes Appium session hints.
- **Variables**: `variables` win over the session's stored inputs, then `SWIPIUM_*` environment variables; no other environment name is ever read (`MISSING_FIXTURE`). See [Flows: variables](flows.md#variables).
- **Structured flows** (`mode: structured`, the default) on an iOS Simulator without WDA, or in a visual-fallback session, are refused with `BACKEND_UNSUPPORTED`. Use `mode: visual` or `auto`, or attach WDA.
- **Consent**: mutating steps and OCR steps need the `flow_mutation_run` consent. Its risk is high with a script seed; medium with another seed, a network toggle, a variable `openUrl`, or an OCR provider; low when the only mutating step is `restartApp`. The prompt's `exactCommand` and `affects` show each seed's exact argv or URL, labelled as repository-supplied and unreviewed, and each variable `openUrl` destination with credential-like values masked. Which steps count is in [Flows: step reference](flows.md#step-reference).
- **Refusals**: OCR steps are refused in sensitive sessions (`UNSAFE_ACTION_REFUSED`) and report `VISUAL_ONLY_SCREEN` when no OCR provider is configured. Image templates and baselines outside the project root fail with `UNSAFE_ACTION_REFUSED`.

### Flow steps

Moved to [Flows: step reference](flows.md#step-reference), with the file format and a full example.

### qa_flow_compile

Compiles an existing POM suite on disk (`suite`, relative to `.swipium/`, default `suites/smoke.yaml`) into runnable Flow V2: it resolves page-object refs to selectors, carries variables, writes `.swipium/flows/<slug>.yaml` (plus a copy under `.swipium/compiled/`), and validates each flow. It needs no session or recorded actions, which makes it the path for committed or hand-edited suites and CI (`swipium suite`). `qa_generate target:"suite"` already compiles the suite it generates. The POM layout is in [Flows: POM suites](flows.md#pom-suites).

A `.swipium/flows/<slug>.yaml` that was edited by hand since the last compile (it differs from `.swipium/compiled/<slug>.flow.yaml`), or that some other tool wrote, is kept: the new output goes to `<slug>.yaml.new`, and the result marks that flow with `keptEditedFlow:true` and `newOutputPath`. `force:true` overwrites it. The compiled copy is always refreshed. A suite that does not exist is `FLOW_NOT_FOUND`; other compile errors are `INVALID_FLOW`. The summary lists the `qa_flow_run flow:"<slug>"` call for each compiled flow.

### qa_flow_repair

Given a flow (`flow`, a name or path under `.swipium/flows`, or inline `flowYaml`), a failed step (`failedStep`, zero-based, from `qa_flow_run`'s `failedAtStep`), and the current screen, suggests a stronger locator plus app code changes (such as adding `accessibilityIdentifier` or `testID`). An exact id, label, or text match on the current screen is high confidence. Otherwise candidates are restricted to the failed target's role (a tap stays on a button, an `inputText` stays on a text field) and ranked by text similarity plus word overlap with a few common UI synonyms (sign in and log in, sign up and register or create account, apps and applications, delete and remove, next and continue, settings and preferences), so a button renamed from "Sign in" to "Log in" gets a low-confidence proposal and is never repaired to the "Email" field. Medium confidence needs the same words, up to case, punctuation, camelCase and plurals ("Notification" and "Notifications", `login` and `btnLogin`). A label that adds words ("Submit" and "Submit order", "Delete" and "Delete account", "Google" and "Google account") is only a low-confidence proposal (`partial:true`) that is never applied, because it may be a different action, and only when the shared word isn't generic ("Settings" is not proposed for "Search Settings"). Other low-confidence proposals need a shared word or synonym that isn't generic (such as "settings" or "button"), or close spelling once generic words are removed. Opposite actions are never proposed in any branch (sign in and sign out, log in and log out, on and off, enable and disable, lock and unlock, `un`/`dis` prefixes, and negations: "Don't allow", "Do not allow" or "Don’t allow" for "Allow"; not, no, never, don't, doesn't, didn't, cannot, can't, won't, isn't and without count, with straight or curly apostrophes), and neither are unrelated labels. `apply:true` patches simple YAML selector steps in a flow file only at high or medium confidence, and records the patch in the mutation ledger; at low confidence it returns the proposal with `applied:false` and a note (for an extra-words match: "only contains X with extra words, may be a different action"), and it never patches inline `flowYaml`. The flow is read like `qa_flow_run` reads it: a path outside the project root, or a file that isn't `.yaml`, `.yml`, or `.json`, is `UNSAFE_ACTION_REFUSED`; a missing flow is `FLOW_NOT_FOUND`, one that doesn't parse `INVALID_FLOW`, and a `failedStep` outside the flow `INVALID_ARGUMENT` (these returned `UNKNOWN` before 2.3.5). `apply` writes a `.json` flow back as JSON.

## Generate

### qa_generate

Turns the actions recorded in a session (`qa_act`, `qa_smoke`, `qa_explore`) into per-run assets. For the durable repository suite, use `qa_suite_generate`. `mode:"plan"` is a read-only preview. Parameters for other targets are ignored with a note. Every target returns `NO_RECORDED_ACTIONS` when the session has recorded nothing (for `appium`, `bootstrap` records a run first).

| target | Output | Target-specific parameters |
| --- | --- | --- |
| `flow` | Flow V2 YAML for `qa_flow_run` | `budgetProfile` |
| `pom` | Page objects and a locator audit | |
| `suite` | The full per-run POM suite under `.swipium/`, compiled to runnable flows, with a replay gate | `compile` (default true), `replay` (`none`, `dry_run` (default), `same_session`, `fresh_state`), `stateProfile` (for `fresh_state`, which is consent-gated) |
| `testcases` | A `TC-xxx` catalog (the platform is the one the session ran on; `android+ios` only when unknown). A case links `automation: {status: automated, test: tests/<name>.smoke.yaml}` only when that test file exists under `.swipium/` (after `target:"suite"` with `save`); otherwise its status is `candidate`, with no `test` | `format` (`yaml`, `markdown`, `both` (default)) |
| `appium` | A runnable WebdriverIO (TypeScript or JavaScript) or Python Appium suite | `language` (default auto), `platform` (`auto`, `android`, `ios`, `both`), `backend`, `projectRoot`, `bootstrap`, `feature`, `device`, `integrateIntoProject` (consent `automation_project_write`; never overwrites), `includeCi`, `candidateOnly`, `brittleThreshold` (default 40) |

`name` sets the asset name (default from the app id). `save` writes files (default true for `suite` and `appium`, false otherwise). `sessionId` is required except for `appium`, which can plan or `bootstrap` (smoke plus explore) from `projectRoot`.

- **Flow**: the flow starts with `prepareTarget`, or with `restartApp` when the recording began with a `qa_app_control` `restart` or `fresh_start` (a `restartApp` start makes the flow mutating, so `qa_flow_run` asks for `flow_mutation_run` consent and `qa_smoke` skips it). It ends with a `waitForVisible` plus `assertVisible` on a stable title from the last screen (top of the screen, not clickable, not a number, never a typed value or secret); when there is none, the header carries a TODO. That final assertion is a navigation check (the screen the recording ended on); the header also lists up to 3 recorded passing outcomes (`# recorded outcome to assert: <workflow>: <reason>`) to turn into real assertions. A tap or type on a text field uses its resource id or accessibility identifier when the recording has one, because the visible text is the placeholder and changes once the field has a value; otherwise the step is listed as brittle. Recorded taps on a third-party or OS sign-in control ("Sign in with Apple", `social-signin.apple-button`) are left out, and the header says so (`# left out: tap(s) on a third-party / OS sign-in (…)`); the report's auto-generated flow does the same. The header says which start step and final assertion were used. Saving over an existing flow with different content reports `overwroteExisting`. A flow that starts with `restartApp` passes `qa_flow_check {ci:true}` without a policy entry.
- **Suite**: a second generation merges into the shared files instead of replacing them: page objects keep their elements (new ones are added, same-named ones refreshed, platforms unioned), and `suites/*.yaml` keep their existing `tests`, so `suites/smoke.yaml` accumulates tests across generations. Page objects claim only the platform the session ran on. Screens with the same title share one page object (the elements of each state are merged into it), so a screen seen in two states is `AlarmsPage`, not `AlarmsPage` and `Alarms2Page`; a numbered name is used only for different screens whose names collide.
- **Replay**: `same_session` and `fresh_state` run the flows this call just compiled (`.swipium/compiled/<slug>.flow.yaml`), never a hand-edited `.swipium/flows/` copy that generation kept. A replayed flow with seed, network, or variable `openUrl` steps needs the `flow_mutation_run` consent first, as in `qa_flow_run`; for `fresh_state` it is part of the `suite_fresh_state_replay` consent. A `restartApp` runs without a prompt.
- **Names**: file and directory names derived from a title or flow name are capped at 80 characters plus an 8-character hash; shorter names are unchanged.
- **Appium code**: every recorded step becomes real code. Swipes and scrolls are real gestures (bounded scroll-until-visible loops). A step that cannot be expressed fails generation with `UNEMITTABLE_STEP` instead of emitting a silent no-op. Class, method, and file names are sanitized, so they are always valid identifiers in the target language.
- **Appium version**: generated projects depend on `appium ^3.0.0`. Android capabilities set `appium:appWaitActivity` to `*` unless `ANDROID_APP_ACTIVITY` is set, so the driver resolves the launcher activity itself. The Python suite reads `APPIUM_URL`, else `APPIUM_HOST` and `APPIUM_PORT` (default `127.0.0.1:4723`).
- **Platform**: the generated suite's default `SWIPIUM_PLATFORM` is resolved from the explicit `platform` argument, then the platform of the session's device, then the project profile, then Android. `ios` means Appium XCUITest and `android` means UiAutomator2. The plan reports `primaryPlatform` and `platformSource`. Generated suites also read `SWIPIUM_NO_RESET` at run time.
- **Visual assertions**: a `qa_visual mode:"assert"` step is free-form prose, not on-screen text, so it becomes a clearly marked manual checkpoint: a `TODO(manual visual check, not automated)` comment in code, a `visualCheck` POM step, an evidence-capturing `assertVisual` step in compiled flows, and "MANUAL visual check" in test cases. Only real text assertions become `assertTextVisible`.
- **Secrets**: recorded secrets become `${SWIPIUM_*}` placeholders (see [Generated output](concepts.md#generated-output)). If a registered secret value would still be written, generation fails with `SECRET_IN_GENERATED_OUTPUT` and nothing is written. The Appium `validation.secretsClean` check scans every generated file, comments included.

## Test suite

The canonical suite in `.swipium/test-suite.json`. It persists and grows across runs, unlike the per-run assets from `qa_generate`. All five tools accept `sessionId` or `projectRoot`. An unknown `sessionId` is `INVALID_ARGUMENT` (`Unknown sessionId`), never a fallback to the suite of the server's working directory.

A `test-suite.json` that exists but does not parse is never replaced: reads see an empty suite, and `qa_suite_update` and `qa_suite_generate` refuse with `INVALID_ARGUMENT` until the file is fixed or moved aside, and `qa_report` says the suite was not updated. Saves are atomic and hold a cross-process lock (`.swipium/test-suite.lock`).

The suite file is checked when it is read, since it can be edited by hand: each stored case is filled out to the suite's shape (a missing `featureId`, `expectedResult` or `actualResult`, string steps), and a stored id that is unsafe as a file name (`../../x`, a number) or a duplicate (the second occurrence) is renamed to a fresh `TC-<FEATURE>-NNN`. `qa_suite_read`, `qa_suite_update` and `qa_suite_export` return the renames as `loadRepairs` with a warning line, and the next save persists them.

### qa_suite_read

Reads the suite, filtered by `functionality` or `status` (`active`, `draft`, `deprecated`, `blocked`, `manual_only`). `format`: `summary` (counts and ids), `json`, or `markdown`. Always returns `suitePath`, the absolute path of `.swipium/test-suite.json`; with a `sessionId` it also returns a `swipium://` resource URI for the full suite (readable with `qa_get_artifact`), otherwise a `suiteUriNote` says so.

### qa_suite_update

Merges `cases` into the suite. `source` (required) is `report`, `exploration`, `feature`, `ticket`, `manual`, `generate`, or `suite`, with an optional `sourceUri`. A case matching feature, objective, and normalized steps is updated, not duplicated; new cases get stable ids (`TC-<FEATURE>-NNN`). `mergeMode`: `append`, `update`, or `replace_generated` (overwrites generated fields over curated ones). Returns created, updated, and deprecated ids plus conflicts, and `idsIgnored` (`{given, id, reason}`, with a "Given id(s) not used" summary line) when a caller-supplied `id` wasn't used: the case merged into an existing one (dedup wins), or the id was already used or retired. A stored case too malformed to merge is `INVALID_ARGUMENT` ("A stored case in test-suite.json is malformed: run qa_suite_lint …"), not a disk error. A long `functionality` title is kept in full; its YAML mirror directory is capped at 80 characters plus a hash. A disk error while saving returns `ARTIFACT_PATH_UNWRITABLE` (as do `qa_suite_generate` and `qa_suite_export`), and the YAML mirror is written before `test-suite.json`, so a failed save leaves the suite readable.

Each case needs a non-empty `title`, `functionality`, or `objective`; string fields must be strings, list fields arrays of strings, and `platforms`, `actualResult`, `automation`, and `steps` must have the suite's shape. A step is an object (`{action, …}`) or a plain string, which becomes `{action:"<string>"}`. A case `id`, when given, must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (it names the case's YAML mirror file); omit it to get an allocated id. Any problem returns `INVALID_ARGUMENT` with `invalidArguments` (`{path:"cases[0].steps[1].action", message}`), and nothing is written.

### qa_suite_generate

Generates or refreshes canonical cases from the session's recorded actions, outcomes, and exploration coverage, and merges them into the suite (re-running updates cases, with no duplicates). `feature` labels the generated flow case. `creativity` (`conservative`, `standard` (default), `creative`, `adversarial` for negative and abuse cases) sets how far cases go beyond the happy path; `creativityLevel` is a deprecated alias. `includeManualOnly` keeps manual-only cases. Returns generated cases, skipped or blocked features, and map-coverage gaps. Features that exploration did not find get no case; a feature exploration reached gets a `not_run` case ("reached during exploration, not verified"), or `fail` when exploration saw app errors, until real steps run; an `observed` feature (only seen as a label) gets a draft `not_run` case; a blocked one (or one needing a fixture) `blocked`, an unsafe one `skipped`, and anything else `not_run`. Cases take the platform the session actually ran on.

### qa_suite_export

Exports the suite. `format` (required) is one of:

- `markdown`: a review-ready document, returned as `content`; saved as `test-suite.md`.
- `yaml`: one file per case in a per-functionality directory. Nothing is inlined: the result carries `fileCount`, and `save:true` writes the files under `.swipium/test-suite-export/yaml/`.
- `json`: the suite file itself (`content`); saved as `test-suite.json`.
- `junit`: JUnit XML (`content`); saved as `test-suite.xml`.

`save:true` writes the export under `.swipium/test-suite-export/` and lists the paths in `written`; a YAML file whose path would resolve outside `.swipium/test-suite-export/yaml/` is skipped, never written. Every result also carries `totalCases`.

### qa_suite_lint

Lints the suite (missing expected or actual results, unlinked or stale feature and screen links, duplicate ids, brittle automation, adversarial cases without safety metadata) and, when `.swipium/pages` exists, generated page objects (coordinate-only, locale-fragile, or dynamic locators) and POM tests. `brittleThreshold` is `C` or `D`. `liveFeatureIds` enables the stale-link rule. Returns errors and warnings.

- **Case rules**: `no_steps` and `placeholder_steps` (warnings: a case with no real steps), `duplicate_steps` (a warning: cases with identical normalized steps, whatever their feature label), `unproven_pass` (an error: a `pass` whose evidence says the feature was not found, or a `pass` with only placeholder steps and no evidence), and `unsafe_id` (an error per stored id that was renamed on read, see above; the result is `ok:false`). Because duplicate ids are renamed on read, `duplicate_id` no longer fires for a suite read from disk.
- **Page and test rules** (in `pagesLint`, the same checks as `swipium suite lint`): `YAML_PARSE_ERROR` (with the parser's line and column), `UNRESOLVED_REFERENCE` (an error: a test step names a page or element that does not exist, the same check `qa_flow_compile` runs), `COORDINATE_ONLY` (a warning: a `tapAt` or coordinates-only `tap` step), plus the locator rules such as `DYNAMIC_TEXT_LOCATOR`, `IOS_MISSING_ACCESSIBILITY_IDENTIFIER` and `ANDROID_MISSING_RESOURCE_ID` (an Android-only page selected by text). Step numbers in messages start at 1.

## Issues

### qa_issue_log

The durable project issue ledger in `.swipium/issues-log.jsonl`, an append-only event log plus an index. Fingerprints let later runs detect regressions of issues that were already fixed.

| mode | Parameters | What it does |
| --- | --- | --- |
| `history` (default) | filters `state`, `category`, `severity`, `platform`, `since`, `includeSuppressed` | Lists issues with counts and recurrence. |
| `log` | `title` (required, descriptive), `summary`, `failureCode`, `category`, `severity`, `platform`, `evidenceUris` | Records an observation. |
| `mark_fixed` | `issueId` or `fingerprint`; `fixedInCommit`, `fixedInVersion`, `howFixed`, `fixedBy` | Marks an active issue fixed. |
| `verify_fixed` | `issueId` or `fingerprint`; evidence: `reportUri`, `testCaseId`, `auditCheckId`, or `evidenceUris` | Confirms a fix with current-run evidence. |
| `suppress` | `issueId` or `fingerprint`; `suppressionReason`, `suppressedUntil` (alias `until`), `suppressionScope`, `unsuppress` | Hides an issue as expected noise. |
| `metrics` | `since`, `until`, `groupBy` (default `week`), `includeSuppressed` | Trends from the event log. |

- **Identity**: a manually logged issue's identity is its normalized title (ids and numbers scrubbed, trailing ones included, so "coupon 42" and "coupon" are one issue; titles that ended in a number get a new fingerprint once, on their next observation), plus `failureCode` or category, plus platform. The app id is left out because the ledger is already project-scoped, so the same title logged with a `sessionId` or a `projectRoot` lands on the same issue. A title with no identifying words left after scrubbing is refused with `ISSUE_LOG_TOO_VAGUE`. An explicit `severity` is kept unless the classifier recognizes the observation and rates it differently; the result then carries `severityOverride` and the text says why. Logging the same issue again without `severity` (or `category`) keeps the stored one; an explicit value still wins. A new manual log with no `category` that no rule recognizes is filed as `mcp_limitation` for triage, and the result says so in `categoryNote` (pass `category`, for example `app_bug`, to file it as an app bug).
- **Issues logged before 2.0.0** keep their old fingerprint (platform and `failureCode` only), and new logs never merge into them. Close them with `mark_fixed`, or hide them with `suppress`.
- **Lifecycle**: re-observing a fixed issue reopens it with a message that quotes `howFixed` and `fixedInCommit`. `mark_fixed` only applies to an active issue, otherwise `ISSUE_STATE_INVALID`. `verify_fixed` needs a fixed issue plus evidence, otherwise `ISSUE_EVIDENCE_REQUIRED`. An unknown key is `ISSUE_NOT_FOUND`.
- **Suppression**: `suppressedUntil` (an ISO timestamp) makes it expire automatically, after which the issue returns to its previous state; without it the suppression is open-ended. `unsuppress:true` lifts it early. Suppressed issues are hidden from `history` unless `includeSuppressed:true`, and show as known noise in reports.
- **Redaction**: with a `sessionId`, registered session secrets are scrubbed from `title`, `summary`, `howFixed`, `suppressionReason`, and `fixedBy` before they reach the committed ledger.
- **Evidence**: in `log` and `verify_fixed`, every `swipium://session/…` URI in `evidenceUris` must name an existing artifact; an unknown one is refused with `INVALID_ARGUMENT` and `unknownEvidenceUris`, and nothing is recorded. Other URIs, such as web links, are accepted as given. Evidence URIs are machine-local: they stop resolving after `swipium gc` prunes the session, and on another machine.
- **Findings from runs**: health findings reach the ledger once per run (identical findings are merged). A `METRO_REQUIRED` or `METRO_WRONG_PROJECT` finding is filed as an environment gate (owner `test_env`, release impact warn), not an app bug. Findings carry a descriptive title (for example `Native crash in com.x/.MainActivity: "Clock keeps stopping"`) and their screenshot and log URIs as evidence.

### qa_mobile_audit

Plans or executes a named release audit. `profile` (required):

| profile | Checks |
| --- | --- |
| `smoke` | Launch and baseline checks. |
| `account_cycle` | Create > logout > login > forgot-password on a disposable generated account. Needs `allowGeneratedData`. Logout passes only when the settled screen after it shows sign-in wording plus an input field (or a buttons-only sign-in screen), and logging in again is skipped unless logout passed. |
| `store_compliance` | Privacy policy, terms, account deletion, subscription, and paywall. |
| `resilience` | Offline, relaunch, and rotation. |
| `release_gate` | All of the above, plus locator readiness and issue recurrence. |

`mode:"plan"` (default) returns the checklist and safety contract without a device. `mode:"execute"` needs a prepared session (`INVALID_ARGUMENT` without one), waits (up to 20 s) for the first rendered screen after its relaunch and before the locator-readiness check (the same render wait as [qa_smoke](#qa_smoke): a launch that never renders, or stays on a splash or loading screen, is a `blocked` launch check with `failureCode:"BLANK_SCREEN"`, printed as `BLOCKED (BLANK_SCREEN): …`, with a `metro_ready` next step), runs every check, logs failed and blocked checks to the issue ledger with evidence, and returns the release impact. Check results carry `failureCode` when one applies. It also records a `mobile_audit: <profile>` outcome on the session that `qa_report` counts: `fail` (`app_bug`) when the release impact is `block`, `blocked` when any check failed or was blocked or the run didn't complete (the report is then `caution` with coverage `BLOCKED` and names the blocked checks), else `pass`, with the audit's evidence attached. It runs inside the call (no job). No check passes without evidence. Cancelling the call skips the remaining checks and returns `CANCELLED` (`changedState:true`): an interrupted check is not evidence, so nothing is logged to the issue ledger for it. `allowTestAccountDeletion` permits deleting disposable test accounts (never a real account). `offlineMode` hints that resilience checks should drive offline state; `targetApp` and `sourceRevision` (`{commit, buildVersion, branch}`) identify what was audited. An executed audit also writes the session report: the result carries `reportUri`, `reportHtmlPath` and `reportHtmlUrl` (left out when `report.html` could not be written), and the text ends with `Open the report: <path>`.

Executing `resilience` or `release_gate` (which runs all four other profiles) on Android needs the `network_change` consent (medium), the same gate as `qa_network`, because it toggles airplane mode. The tool returns the consent request before running anything. With consent, the original airplane state is recorded first and restored afterwards, even if a check fails or the call is cancelled. On iOS the offline-entry and network-restoration checks are `skipped` (no airplane-mode control on simulators), no consent is asked, and no network state is recorded.

`store_compliance` reads only the screen it inspects. A privacy-policy link, terms link, account-deletion path, or restore/manage-subscription control that is not on that screen is `blocked` (not verified on this screen, with a next step to open Settings or About), not `fail`, so it is not logged as an issue and limits the release impact to a warning.

## First run

### qa_first_run

Gets past a first-run gate: login, sign-up, OTP, onboarding, permissions, or a paywall. Needs a prepared device.

- **`mode:"plan"`** (default, read-only) classifies the current screen and returns the safe plan. `until`, `maxSteps`, and `maxDurationMs` are ignored with a note.
- **`mode:"continue"`** runs bounded steps. `until`: `one_step` (default), `until_gate` (stop at a paywall, OTP, or permission), or `until_home`. In test or staging environments it fills forms with generated data (the password is kept secret), advances onboarding, and records paywalls without purchasing. It refuses sign-up in production-like environments and returns one `needs_input` question on an OTP.
- `testDataPolicyPath` (default `.swipium/test-data-policy.json`) and `allowGeneratedAccount` control whether a throwaway account may be created.
- **Paywalls**: a screen counts as a paywall when it offers something (subscribe, trial, restore, a billing period) or shows a price such as "$9.99"; a close glyph such as an X is recognised as its close button. "Premium", "upgrade" or "unlock" wording alone is not a paywall, so a "Go Premium" button on a freemium home is not one.
- **Third-party sign-in**: "Sign in with Apple", "Continue with Google" and similar third-party or OS sign-in controls are never picked as the submit or next button; the app's own "Sign In" is.
- **Alerts**: an alert over the screen is closed with its cancel button (at most 3 times, not counted as a step, recorded as a workaround) and the screen behind it is classified afterwards, never the alert itself (so an alert's "Settings" button doesn't make a sign-up screen read as home). An alert with no cancel button, or one that keeps coming back, stops the run `blocked` with a `first_run` note. `mode:"plan"` reports "an alert (…) covers the screen" as the blocked reason.
- **Evidence**: first-run taps count as exercising the app in `qa_report` only when the app under test was in front.
- It never binds a device on its own (in either mode): a session without one gets `NO_DEVICE` (`No device attached to this session`), even when a single emulator is online. Bind one with `qa_prepare_target` or `qa_prepare_ios_target` first.

## MCP resources and prompts

**Resource templates** (read by URI; `qa_get_artifact` and `qa_app_map_read` are the fallbacks for clients without resources):

| Template | Content |
| --- | --- |
| `swipium://session/{sessionId}/{kind}/{name}` | Session artifacts: screenshots, dumps, reports, logs, videos. |
| `swipium://project/{projectId}/app-map` | The complete app map JSON. |
| `swipium://project/{projectId}/app-map/{kind}/{id}` | One app-map section: a feature, screen, or test-suite entry. |

**Fixed resource**: `skill://swipium-qa/SKILL.md` (`text/markdown`) is the swipium-qa agent skill, the same file `swipium init claude|codex --apply` installs. It is always listed.

`resources/list` is scoped to the current client's project roots (its MCP roots plus the roots of sessions used in this server process), so one client never browses another project's artifacts. Each listing shows the newest 100 entries and says so on the last entry when it is capped; the rest stay readable by URI. Artifacts of sensitive sessions are never listed.

**Prompts**:

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `swipium_setup_check` | `projectRoot?` | Check whether Swipium can test a project with `qa_test_this {mode:"plan"}` (no side effects), plus `qa_doctor` on a toolchain problem, and list what is missing. |
| `swipium_guardrail_validation` | `projectRoot?` | Confirm Swipium refuses an unsafe bundle-loss wipe on a debug RN/Expo build, on Android (`qa_prepare_target`) or iOS (`qa_prepare_ios_target`). If the app can't be launched it reports NOT TESTED; PASS only when the wipe was refused on a launched app. |
| `swipium_full_smoke` | `projectRoot?`, `platform?` | Run the autopilot smoke: `qa_test_this {mode:"execute", goal:"smoke", waitForCompletion:true}`, then the polling loop and a summary. Before 2.3.0 it took `appId`. |
| `swipium_bug_repro` | `bug`, `projectRoot?` | `qa_test_this {mode:"execute", goal:"reproduce_bug", goalText, waitForCompletion:true}`, then drive to the bug by hand, capture evidence, and record it as a structured outcome. |
| `swipium_test_feature` | `feature`, `projectRoot?` | Test one named feature with `qa_test_feature {feature, mode:"execute"}` and report pass, fail, or blocked per case. New in 2.3.0. |
| `swipium_generate_suite` | `projectRoot?` | Run `qa_test_this` with `goal:"create_automation_suite"`, then `qa_suite_generate` and `qa_suite_lint`. New in 2.3.0. |
| `swipium_convert_run_to_flow` | `name?` | Draft a `.swipium/flows/*.yaml` from the steps just performed, then validate it. |

The loop, batching, credentials, and app-control text in the prompts comes from the same source as the swipium-qa skill (`src/skills/content.ts`).


## Moved topics

These sections used to live on this page:

- Project root resolution: [concepts.md#project-root](concepts.md#project-root).
- Consent, elicitation, and the consent-action table: [concepts.md#consent](concepts.md#consent).
- Sessions, persistence, retention, jobs, and cancellation: [concepts.md#sessions-and-jobs](concepts.md#sessions-and-jobs).
- Secrets and redaction: [concepts.md#secrets-and-redaction](concepts.md#secrets-and-redaction).
- Devices, iOS Simulator, and WebDriverAgent: [concepts.md#devices](concepts.md#devices) and [concepts.md#ios-modes](concepts.md#ios-modes).
- Flow steps and CI policy: [flows.md](flows.md).
- Report formats: [qa_report](#qa_report) and [ci-reports.md](ci-reports.md).
- Environment variables: [README](../README.md#configuration--environment-variables).

## Failure codes

Every code a tool can return is in the catalog, and `qa_explain_blocker` explains any of them. Each code has a **bucket** (how to triage it: `app_bug`, `environment`, `missing_data`, `mcp_limitation`, or `unsafe_refused`), an **owner** (who fixes it: `app`, `environment`, `swipium`, or `user`), a severity, and a default retry safety. The tables below are grouped by bucket; owner is per code. A `qa_note` without a code is bucketed by its category in the report's failure buckets: `app_bug`, `missing_test_data` (`missing_data`), `destructive_refused` (`unsafe_refused`), `mcp_limitation`, and `other`, which counts as `environment` on a `blocked` note (a setup gap such as Metro not serving or a blank launch) and as `mcp_limitation` otherwise.

Codes marked **reserved** are defined for classifying evidence, reports, and policy rules (so `blockOn`, `warnOn`, `ignoreKnown`, and report consumers can name them stably), but no tool returns them yet. A reserved code may start being returned in a minor release. Codes marked **finding** appear as health findings in reports rather than as tool errors.

### Bucket: app_bug

| Code | Owner | Meaning |
| --- | --- | --- |
| `NATIVE_CRASH` | app | The native process crashed. Finding. |
| `ANR` | app | App not responding. Finding. |
| `ERROR_BOUNDARY` | app | An app error screen, error boundary, or WebView error. Finding. |
| `REDBOX` | app | A framework red-box error. Finding. |
| `LOGBOX` | app | A framework warning overlay. Finding. |
| `BACKEND_ERROR` | app | An error surface shown to the user. Finding. |
| `ASSERTION_FAILED` | app | Expected UI was not present. |
| `WDA_MAIN_THREAD_BUSY` | app | The app's main thread appears busy during WDA automation. |
| `BLANK_SCREEN` | app | Nothing rendered, or only a splash or loading screen: an app that showed no UI for about 15 s after launch (up to 30 s while Metro is serving), or still showed a loading screen at the end of the wait (`qa_smoke` blocks `launch_smoke`, `qa_mobile_audit` blocks its launch check, and `qa_test_this` stops there). For a debug RN or Expo build, wait until Metro finished bundling (`qa_wait {for:"metro_ready"}`) and re-run; otherwise check for a failed initial fetch, a missing data state, or a swallowed error. |
| `INFINITE_SPINNER` | app | A stuck loading indicator. Reserved. |

### Bucket: environment

Device, simulator, and WebDriverAgent:

| Code | Owner | Meaning |
| --- | --- | --- |
| `NO_DEVICE` | environment | No online device or bootable emulator, a requested device that can't be found, the bound device disappeared (offline or shut down), or no device UDID for a WDA build or start. |
| `ADB_NOT_FOUND` | environment | `adb` is not installed or not on PATH. |
| `DEVICE_NOT_READY` | environment | The device exists but is not ready (booting, or properties unreadable). |
| `DEVICE_UNRESPONSIVE` | environment | The Android device did not answer adb in time (a stalled or overloaded emulator): an `input text`, launch, or UI dump timed out, so an input may have partly landed. Run `qa_screenshot` to see the screen, then restart the app or the emulator and retry. |
| `EMULATOR_BOOT_FAILED` | environment | The emulator failed to boot. |
| `SIMULATOR_RUNTIME_MISSING`, `SIMULATOR_BOOT_FAILED`, `SIMULATOR_BOOT_TIMEOUT` | environment | No usable iOS runtime; simulator boot failed or timed out. |
| `MULTIPLE_DEVICES` | environment | More than one device matches (including a `SWIPIUM_DEVICE` simulator name that several simulators share), or a WDA attach has no device; pass one explicitly, or pin by UDID. |
| `DEVICE_PINNED` | environment | The requested device is not the one the operator pinned with `SWIPIUM_DEVICE`; omit `device`, or change the pin. |
| `WRONG_FOREGROUND`, `PERMISSION_DIALOG`, `NATIVE_ALERT` | environment | Another app, a permission dialog, or a native alert is in front. Finding. |
| `WDA_UNREACHABLE`, `WDA_BUILD_FAILED`, `WDA_SIGNING_FAILED`, `WDA_START_FAILED`, `WDA_SESSION_FAILED`, `WDA_PORT_CONFLICT` | environment | WebDriverAgent could not be reached (including a WDA hung after the launch or at session creation), built, signed, started, or given a session, or its port is taken. In reports a `WDA_UNREACHABLE` finding is a tool or environment item, not an app defect, but it still fails the gate. |
| `STALE_WDA_DEVICE` | environment | WDA appears bound to a different device than the session, or its owner can't be checked (`unverified`). |
| `DEV_SERVER_DOWN`, `NETWORK_SERVICE_UNAVAILABLE`, `NETWORK_OFFLINE` | environment | Reserved. |
| `DEVICE_BOOT_FAILED` | swipium | Reserved. |

Project, artifact, install, and build:

| Code | Owner | Meaning |
| --- | --- | --- |
| `PROJECT_ROOT_UNRESOLVED`, `PROJECT_ROOT_EMPTY` | user | No usable project root (none resolves, or it is `/`, your home directory, or a shared folder such as `/Applications` or `~/Library`); the root is empty. |
| `NOT_MOBILE_PROJECT`, `UNSUPPORTED_FRAMEWORK` | user | No supported mobile project at the root; unsupported framework. |
| `NO_BUILD_ARTIFACT` | swipium | No installable artifact found (Swipium can often build one). |
| `NO_ARTIFACT` | environment | A required file is missing (an APK to install, a WebDriverAgent project, an app id for a flow). |
| `ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL` | user | The best artifact is outside the project root; pass `allowOutsideRoot`. |
| `AAB_NEEDS_BUNDLETOOL`, `BUNDLETOOL_MISSING`, `AAB_BUILD_APKS_FAILED`, `AAB_DEVICE_SPEC_FAILED`, `AAB_INSTALL_FAILED` | environment | `.aab` conversion problems. |
| `INSTALL_FAILED`, `WRONG_ARCH`, `APK_ARCH_INCOMPATIBLE`, `ANDROID_MIN_SDK_INCOMPATIBLE`, `ANDROID_SIGNING_FAILED` | environment | Android install and signing problems. |
| `ANDROID_SIGNATURE_CONFLICT` | swipium | An installed app with a different signature blocks the install. |
| `IPA_NEEDS_REAL_DEVICE` | user | A `.ipa` targets a real device; build a simulator `.app`. |
| `IPA_INSTALL_UNSUPPORTED`, `IOS_APP_WRONG_ARCH` | environment | iOS artifact problems. |
| `IOS_SIMULATOR_APP_MISSING` | swipium | No simulator `.app` found (Swipium can often build one). |
| `BUNDLE_ID_NOT_FOUND` | environment | The bundle id is not installed on the device (also a flow's launch step for an app that isn't installed). |
| `APP_LAUNCH_FAILED` | environment | Installed, but the app did not launch. |
| `BUILD_FAILED`, `GRADLE_FAILED`, `XCODEBUILD_FAILED`, `FLUTTER_BUILD_FAILED` | app | Build from source failed. |
| `BUILD_COMMAND_UNAVAILABLE`, `DEPENDENCY_INSTALL_REQUIRED`, `BUILD_TIMED_OUT` | environment | Build prerequisites and outcomes. |
| `EXPO_PREBUILD_REQUIRED`, `BUILD_ARTIFACT_UNRESOLVED_AFTER_SUCCESS` | swipium | Expo prebuild needed; the build succeeded but its artifact was not found. |
| `METRO_REQUIRED` | swipium | A debug RN/Expo build needs Metro: it isn't serving, a RedBox says the bundle could not be loaded, or the Expo dev-client launcher is showing. |
| `METRO_FAILED` | environment | Metro failed, or could not be spawned. |
| `METRO_WRONG_PROJECT` | environment | The Metro on the dev-server port serves another project's bundle. |
| `NOT_TESTED` | user | The run never reached or exercised the app, so nothing was tested (not a pass). Gates as a failed workflow. |
| `INVALID_FLOW` | environment | A flow is invalid. |
| `FLOW_NOT_FOUND` | user | A flow does not exist. |
| `SEED_FAILED` | environment | Seeding a precondition failed (setup, not an app bug). |
| `OCR_NOT_CONFIGURED`, `OCR_PROVIDER_FAILED` | user | No OCR provider; the OCR or mask provider failed or timed out. |
| `ARTIFACT_PATH_UNWRITABLE`, `REPORT_UPLOAD_SKIPPED` | environment | Reserved. |
| `MONOREPO_TARGET_AMBIGUOUS`, `MULTIPLE_ARTIFACTS_AMBIGUOUS`, `IPA_SIGNING_REQUIRED`, `REAL_DEVICE_NOT_CONNECTED`, `REAL_DEVICE_UDID_NOT_PROVISIONED`, `REAL_DEVICE_BUNDLE_ID_MISMATCH`, `REAL_DEVICE_TEAM_MISMATCH` | user | Reserved. |

### Bucket: missing_data

| Code | Owner | Meaning |
| --- | --- | --- |
| `AUTH_GATE` | user | Login required and no usable credentials. |
| `MISSING_FIXTURE` | user | A required precondition, fixture, disposable test state, or flow variable is absent. |
| `MISSING_TEST_DATA` | user | Required test data (for example an unresolvable `${SWIPIUM_*}` placeholder). |
| `ISSUE_LOG_TOO_VAGUE`, `ISSUE_NOT_FOUND`, `ISSUE_EVIDENCE_REQUIRED` | user | Issue-ledger input problems. |
| `NO_APP_MAP` | swipium | No app map yet; build it with `qa_app_map_build`. |
| `NO_RECORDED_ACTIONS` | swipium | No recorded actions to generate from. |
| `MISSING_SECRET`, `AUTH_REQUIRED` | user | Reserved. |

### Bucket: mcp_limitation

| Code | Owner | Meaning |
| --- | --- | --- |
| `VISUAL_ONLY_SCREEN` | swipium | No usable UI tree; the session is in visual-fallback for this screen. |
| `SNAPSHOT_FAILED` | swipium | The UI tree could not be captured. |
| `STALE_REF` | swipium | The `@eN` ref is from an older screen. |
| `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_HITTABLE` | swipium | No match; a match that cannot be tapped. |
| `AMBIGUOUS_SELECTOR`, `INVALID_SELECTOR` | swipium | The selector matched several elements, or is malformed. |
| `KEYBOARD_OBSTRUCTION`, `KEYBOARD_NOT_DISMISSIBLE`, `OVERLAY_OBSTRUCTION` | swipium | The keyboard or an overlay covers the target, or the keyboard cannot be dismissed. |
| `TEXT_INPUT_UNSUPPORTED` | swipium | The backend cannot type this text. |
| `TEXT_INPUT_MISMATCH` | swipium | After typing, the field holds other text (reordered, characters dropped, or old text not cleared). Re-snapshot, then retry the whole value in replace mode; retry-safe only in replace mode: never repeat a failed append (it types the landed part twice). For long text, type it in shorter parts. A max length or input mask that only cuts or reformats the text gives a warning, not this code. |
| `BACKEND_UNSUPPORTED` | swipium | The operation is not supported on this backend (for example iOS rotation, or iOS without WDA). |
| `UI_IDLE_TIMEOUT`, `ANIMATION_IDLE_BLOCKED` | swipium | The UI did not settle. |
| `WDA_SOURCE_SLOW`, `WDA_APP_NOT_IDLE`, `WDA_HIERARCHY_TOO_LARGE`, `WDA_XPATH_REFUSED` | swipium | WDA performance and locator limits. |
| `WEBVIEW_UNAVAILABLE` | swipium | WebView content is not reachable by native automation. |
| `VISUAL_LOCATOR_DRIFT` | swipium | A visual or OCR locator drifted. |
| `UNEMITTABLE_STEP` | swipium | A recorded step cannot be expressed as Appium code. |
| `BUDGET_EXHAUSTED` | user | The session budget (time, actions, screenshots, or no-change actions) is spent; the call did nothing. |
| `STALE_CLIENT` | swipium | The client runs an old tool list; restart it. |
| `UNKNOWN` | swipium | Unclassified. |
| `MISSING_DURABLE_LOCATOR` | app | An element has no durable locator (`testID`, `accessibilityIdentifier`, resource-id). |
| `COORDINATE_ONLY_FLOW` | app | A flow relies on coordinate taps. |
| `SNAPSHOT_TOO_DEEP`, `NO_CHANGE_LOOP`, `VISUAL_ONLY_ASSERTION` | swipium | Reserved. |
| `VISUAL_MASKING_STATUS_MISSING`, `EVIDENCE_RETENTION_UNDECLARED` | user | Reserved. |

### Bucket: unsafe_refused

Expected guardrails, not bugs.

| Code | Owner | Meaning |
| --- | --- | --- |
| `INVALID_ARGUMENT` | user | A malformed, missing, or undeclared argument, or an unknown `sessionId` or `jobId`. Nothing ran. |
| `CANCELLED` | user | The call or job was cancelled. Not a failure. |
| `CONSENT_DECLINED`, `CONSENT_CANCELLED`, `CONSENT_REFUSED` | user | Nothing ran. When the client's consent prompt was declined or cancelled, the error carries `action`, `answeredInMs`, `likelyAutomatic`, and, when the prompt itself failed, `elicitationFailure`. A session that tested nothing after a refused consent gates with the refusal's code. See [Consent](concepts.md#consent). |
| `DESTRUCTIVE_REFUSED` | user | A destructive action without approval (including a remote WDA URL). |
| `UNSAFE_ACTION_REFUSED` | user | An unsafe action or a path outside the project root. |
| `BUNDLE_LOSS_REFUSED` | user | A wipe that would remove a debug build's JS bundle, without `acknowledgeBundleRisk`. |
| `PHYSICAL_DEVICE_UNSUPPORTED` | user | Physical devices are out of scope. |
| `CAPTURE_WITHHELD_SECURE` | user | A password or OTP field is on screen; pass `force:true` to capture anyway. |
| `SENSITIVE_MODE_REFUSED` | user | The session is in sensitive mode. |
| `VISUAL_PATH_REFUSED` | user | A baseline name or template path escapes the allowed directory. |
| `GIT_SCOPE_FORBIDDEN` | user | Git commands are outside Swipium's scope (for example a Git executable as OCR provider). |
| `ISSUE_STATE_INVALID` | user | The issue transition is not allowed from its current state. |
| `SECRET_IN_GENERATED_OUTPUT` | swipium | Generated output would contain a secret; nothing was written. |
| `SECRET_ARTIFACT_IN_EVIDENCE` | user | Reserved. |

## Migrating from 1.5.0

A client still running a pre-upgrade tool list, or an agent that remembers old names, gets a typed `STALE_CLIENT` error with `replacement` and `clientHint` instead of a raw "Tool not found" (see [Unknown arguments and stale clients](#unknown-arguments-and-stale-clients)). Removed tools and actions are gone from the schemas; two renamed arguments are still listed as deprecated aliases: `qa_wda.udid` and `qa_suite_generate.creativityLevel`.

| Removed | Use instead |
| --- | --- |
| `qa_agent_brief` | Server `instructions`, or `qa_status` without `sessionId` |
| `qa_capabilities` | `qa_status` without `sessionId` (`capabilityGroups`) |
| `qa_next_best_action {sessionId, goal}` | `qa_status {sessionId, goal}` > `nextBestAction` |
| `qa_detect_context {projectRoot}` | `qa_resolve_target {projectRoot, include:["context"]}` |
| `qa_plan {sessionId}` | `qa_resolve_target {sessionId, include:["plan"]}` |
| `qa_assert_visual {assertion, pass}` | `qa_visual {mode:"assert", assertion, pass}` |
| `qa_ios` `wda_status` / `wda_attach` | `qa_wda` `status` / `attach` (with `device`) |
| `qa_ios` `screenshot` | `qa_screenshot` |
| `qa_wait {for:"job_done", jobId}` | `qa_job_status {jobId, waitMs}` |
| `qa_wda {udid}` | `qa_wda {device}` (`udid` still accepted) |
| `qa_suite_generate {creativityLevel}` | `qa_suite_generate {creativity}` (`creativityLevel` still accepted) |
| `qa_mobile_audit {waitForCompletion}` | removed; passing it returns `INVALID_ARGUMENT` |

Other 2.0.0 changes an upgrading agent should know:

- Undeclared arguments are rejected with `INVALID_ARGUMENT` instead of being silently ignored.
- Manually logged issues use a new identity (see [qa_issue_log](#qa_issue_log)); 1.5.x issues keep their old fingerprint.

Adding or changing a tool: see [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-tool).
