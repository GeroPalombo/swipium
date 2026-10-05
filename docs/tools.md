# Tool Reference

Swipium exposes 55 public MCP tools, 5 MCP prompts, and 3 MCP resource templates. It tests apps on local Android Emulators and iOS Simulators only; physical devices are out of scope (see [physical-devices.md](physical-devices.md)).

This page is the reference: conventions, one section per tool, the failure-code catalog, and the 1.5.0 migration table. Cross-cutting ideas (sessions and jobs, project root, consent, secrets, iOS modes, devices, glossary) are in [concepts.md](concepts.md); the flow file format and CI policy are in [flows.md](flows.md); environment variables are in the [README](../README.md#configuration--environment-variables).

**Contents**

- [Entry points](#entry-points) and [Conventions](#conventions): annotations, common parameters, response modes, the result envelope, and argument checking.
- [Tool index](#tool-index): one row per tool.
- Tool reference by capability group: [Start](#start), [Setup](#setup), [Build](#build), [Device](#device), [Drive](#drive), [Run](#run), [App map](#app-map), [Feature](#feature), [Flows](#flows), [Generate](#generate), [Test suite](#test-suite), [Issues](#issues), [First run](#first-run).
- [MCP resources and prompts](#mcp-resources-and-prompts), [Failure codes](#failure-codes), and [Migrating from 1.5.0](#migrating-from-150).

## Entry points

The default entry point is `qa_test_this`. The server sends the same rules as MCP `instructions` when a client connects, and `qa_status` without a `sessionId` returns them as structured data (see [qa_status](#qa_status)). The polling loop, job states, and `needs_input` handling are in [Sessions and jobs](concepts.md#sessions-and-jobs).

| User intent | First call |
| --- | --- |
| "Test it" | `qa_test_this {mode:"execute"}` |
| "How do I use Swipium?" | `qa_status` with no arguments |
| "Check my setup" | `qa_doctor` |
| "Test the X feature" | `qa_app_map_feature_scope`, then `qa_test_feature` |
| "Run a release gate" | `qa_test_this {mode:"execute", goal:"release_gate"}` or `qa_mobile_audit {profile:"release_gate"}` |
| "Drive the app myself" | `qa_start_session`, then `qa_prepare_target` or `qa_prepare_ios_target` |
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

### Common parameters

- **`sessionId`**: returned by `qa_test_this` or `qa_start_session`. An unknown `sessionId` returns `INVALID_ARGUMENT` (`Unknown sessionId "…"`) with nothing run.
- **`projectRoot`**: an absolute path. Tools that work before a session exists (build, artifact, app map, suite, issue ledger, flow check, feature plan) accept it. See [Project root](concepts.md#project-root).
- **`consentId` / `approve`**: the re-call half of a consent request. See [Consent](concepts.md#consent).
- **`mode:"plan"`**: on `qa_test_this`, `qa_build`, `qa_generate`, `qa_flow_run`, `qa_test_feature`, `qa_first_run`, and `qa_mobile_audit`, the plan mode is a side-effect-free preview. It is the default everywhere except `qa_generate` and `qa_flow_run`.

### Response modes

`responseMode` controls the **text** channel only. `structuredContent` always carries the complete payload in every mode.

| Mode | Text channel |
| --- | --- |
| `compact` | The summary line plus any `swipium://` URIs (`artifactUri`, `artifactUris`, `screenshotUri`, `reportUri`). No JSON. |
| `normal` (default) | The summary plus one block of JSON. Fields the summary already rendered are left out of that JSON, and a `renderedAbove` key lists them: `elements` and `diff` for `qa_snapshot`; `elements`, `removed`, `hint`, and `stateChanged` for `qa_act`. `renderedAbove` exists only in the text; it is never in `structuredContent`. |
| `verbose` | The summary plus the full payload as JSON, including the fields `normal` leaves out (so there is no `renderedAbove`). |

The mode is a session setting, set by `qa_start_session` or `qa_test_this` (`responseMode`). Calls without a `sessionId` use the `responseMode` argument when the tool has one, else `normal`. The mode is chosen before a call runs, so `qa_test_this {sessionId, responseMode}` on an existing session takes effect from the next call. Errors always show their heading lines; compact mode drops only the JSON.

### Result envelope

A success is `{ok:true, …payload}`. A budget stop is also a success: `{ok:true, stopped:true, reason}` (for example `action budget reached (20/20)`). Some results add `notes[]` (non-fatal remarks, such as parameters ignored for the chosen mode) or `warnings[]`.

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

The text channel renders the same error as `❌ <what>`, then `changedState=… retrySafe=…`, `next: …`, and `hint: …` lines.

### Unknown arguments and stale clients

- **Unknown arguments**: every tool rejects top-level arguments its input schema does not declare, before anything runs. The call returns `INVALID_ARGUMENT` with `unknownArguments` and `acceptedParameters`. For example, `qa_app_control {action:"force_stop", appId:"…"}` is refused: `appId` is not a parameter, and the action always targets the session's app. Deprecated aliases that are still declared (`qa_wda udid`, `qa_suite_generate creativityLevel`, `qa_issue_log until`) are accepted. Nested objects are not checked this way.
- **Stale clients**: a client started before an upgrade may still send 1.5-era calls. Removed tool names, `qa_ios` with `action:"screenshot"` or `action:"wda_*"`, and `qa_wait` with `for:"job_done"` return `failureCode:"STALE_CLIENT"` with `removedCall`, `replacement` (the call to use), and `clientHint` (restart the client so it reloads the tool list). See [Migrating from 1.5.0](#migrating-from-150). `qa_doctor` with `expectedVersion`, `expectedToolCount`, or `expectedSchemaHash` detects the same condition.

### Jobs and cancellation

Long operations return a `jobId` to poll with [qa_job_status](#qa_job_status); cancelled work returns `CANCELLED`. The job lifecycle, status versus `result.state`, long-polling, and cancellation rules are in [Sessions and jobs](concepts.md#sessions-and-jobs).

## Tool index

Hints: **RO** read-only, **D** destructive, **I** idempotent write, blank for other writes. **Consent** marks tools with at least one consent-gated action.

| Tool | Group | Hints | Consent | Summary |
| --- | --- | --- | --- | --- |
| `qa_test_this` | start |  | yes | Autopilot: resolve, build, prepare, smoke, explore, report, generate. |
| `qa_status` | start | RO |  | Orientation without a session; session state and `nextBestAction` with one. |
| `qa_job_status` | start | RO |  | Poll or long-poll a background job. |
| `qa_job_cancel` | start | I |  | Cancel a running job and its child processes. |
| `qa_explain_blocker` | start | RO |  | Explain a `failureCode`: meaning, owner, retry safety, fix. |
| `qa_continue_from_blocker` | start |  |  | Answer a `needs_input` question and get the resume call. |
| `qa_get_artifact` | start | RO |  | Read a `swipium://` artifact (metadata or contents). |
| `qa_doctor` | setup | RO |  | Check Node, Android, iOS, WDA, and client freshness. |
| `qa_start_session` | setup |  |  | Open a session for low-level tools (budget, fixtures, sensitive mode). |
| `qa_prepare_target` | setup |  | yes | Android Emulator: bind or boot, Metro, install, launch. |
| `qa_prepare_ios_target` | setup |  | yes | iOS Simulator: boot, install `.app`, launch, WDA or visual-only. |
| `qa_ios` | setup | D | yes | iOS Simulator lifecycle (list, boot, install, launch, logs, erase, …). |
| `qa_wda` | setup |  | yes | Diagnose, attach, build, start, or stop WebDriverAgent. |
| `qa_resolve_target` | build | RO |  | Pick a device or simulator; optional project context and workflow plan. |
| `qa_resolve_artifact` | build | RO |  | Find the best installable `.apk`, `.aab`, `.ipa`, or `.app`. |
| `qa_build` | build |  | yes | Propose build commands, or build from source as a job. |
| `qa_bundletool` | build |  | yes | Convert an `.aab` into an installable APK or APK set. |
| `qa_device_info` | device | RO |  | Device facts: model, SDK, ABIs, locale, screen, packages. |
| `qa_orientation` | device | I |  | Set portrait, landscape, or auto rotation (Android). |
| `qa_geolocation` | device | I | yes | Spoof the GPS location (Android Emulator). |
| `qa_network` | device | I | yes | Airplane mode on or off, with automatic restore (Android 11+). |
| `qa_metro` | device |  | yes | Status, diagnose, start, or stop the RN/Expo Metro bundler. |
| `qa_app_control` | device | D | yes | Launch, foreground, background, stop, restart, or wipe the app. |
| `qa_screen_record` | device |  | yes | Record the screen to an mp4 artifact. |
| `qa_snapshot` | drive | RO |  | Structured UI elements (`@eN` refs) with a quality verdict. |
| `qa_inspect` | drive | RO |  | Full attributes of one `@eN` element. |
| `qa_act` | drive |  |  | One UI action (tap, type, scroll, …), then observe. |
| `qa_clear_overlay` | drive |  |  | Dismiss the keyboard, dialogs, LogBox, sheets, or toasts. |
| `qa_check_health` | drive | RO |  | Crash, ANR, error-boundary, and foreground check. |
| `qa_screenshot` | drive |  |  | Screenshot artifact with coordinate-space metadata. |
| `qa_note` | drive |  |  | Record a workflow outcome for the report. |
| `qa_visual` | drive |  | yes | Screenshot checks: assert, baseline, diff, OCR find, image find. |
| `qa_wait` | drive | RO |  | Wait for `device_online`, `metro_ready`, or `wda_ready`. |
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

- **`mode`**: `plan` (default) has no side effects and returns the plan, preconditions, and any consent it will need. `execute` returns `state:"running"` and a `jobId` at once. `interactive` asks the credentials question up front (when the project likely has a login and no credentials are available) and then runs as a job like `execute`. `waitForCompletion:true` blocks up to `timeoutMs` (default 45000, max 50000; larger values are clamped to 50000 with a note in `notes`, never rejected) and returns the terminal result directly, or `state:"running"` with the `jobId` to poll.
- **`goal`** sets default flags; explicit `explore`, `generateSuite`, and `stopOnNeedsInput` win.

  | goal | Explore | Suite | Stops for input | Notes |
  | --- | --- | --- | --- | --- |
  | (none) | no | attempted | no | Smoke, then an attempt at a POM suite (skipped honestly when no actions were recorded). Not the fastest path. |
  | `smoke` | no | no | no | The fastest path. Same as `fastSmoke:true`. |
  | `explore` | yes | no | no | Maps reachable workflows. |
  | `create_automation_suite` | yes | yes | no | |
  | `release_gate` | yes | no | no | Adds the readiness and release-gate summary. |
  | `test_login` | no | no | yes | Stops for credentials when none are available. |
  | `reproduce_bug` | yes | no | no | Focus with `goalText`. |

- **Other parameters**: `platform` (`android` or `ios`, default inferred), `device`, `buildIfNeeded` (default true), `allowOutsideRoot`, `fastSmoke`, `responseMode` (`compact` returns the summary + URIs only; it stays the session's default for later calls), `consentId`/`approve`. `preferRealDevice:true` always returns `PHYSICAL_DEVICE_UNSUPPORTED`, even when no phone is connected (see [Devices](concepts.md#devices)).
- **Consent**: one combined `test_this_plan` consent covers build, boot, and install; its risk is the highest of its steps. Its envelope carries `sessionId`, so the approving re-call reuses the session.
- **Terminal states** (in the `qa_job_status` result): `completed`, `blocked`, `unsafe`, or `needs_input`. Every terminal state writes a report. The result keeps the report compact (`reportSummary`, `reportUri`, suite and app-map counts) and adds `attempted`, `workaroundsAttempted`, `artifactChoice`, `targetChoice`, `blockers[]`, and `nextRecommendedAction`.
- **needs_input**: the run stopped on one question it was asked to stop for (`stopOnNeedsInput`, `goal:"test_login"`, or `interactive`), such as a login form that needs credentials. The result carries `needsInput` (the question, its fields, and a `resume` call), and `nextRecommendedAction` is that call. When the question can be asked before any work starts, `qa_test_this` returns `state:"needs_input"` directly, with no `jobId`. Without those flags, the run completes with pre-login coverage and returns the question as `optionalQuestion`. Answering "test pre-login only" sets `loginOutOfScope:true` for the session.
- **Resumes**: a blocker resume replays the original `goal`, `goalText`, and flags. Plan steps that route back through `qa_test_this` (a build or an `.aab` conversion) carry `mode:"execute"` and the original goal.
- **iOS without WebDriverAgent**: the default run skips suite generation and exploration, records a workaround, and runs a visual-only smoke. Only explicitly requested WDA work fails with `WDA_UNREACHABLE`: the `generateSuite` or `explore` flags, or goals `create_automation_suite`, `explore`, `reproduce_bug`, and `test_login`. Its `nextSteps` include a `goal:"smoke"` call.
- **Consent retries**: an unknown, used, or expired `consentId` is never silently replaced. The result says `consent <id> unknown or expired; new challenge issued` in `consentNote` (with `previousConsentId`) and returns a new challenge.
- **Failure codes**: `PROJECT_ROOT_UNRESOLVED`, `PROJECT_ROOT_EMPTY`, `NOT_MOBILE_PROJECT`, `NO_BUILD_ARTIFACT`, `BUILD_FAILED` and the typed build codes, `PHYSICAL_DEVICE_UNSUPPORTED`, `ADB_NOT_FOUND`, `NO_DEVICE`, `WDA_UNREACHABLE`, `IPA_NEEDS_REAL_DEVICE`.

### qa_status

- **Without `sessionId`**: first-call orientation, the same rules the server sends as MCP `instructions`: `{orientation:true, swipiumVersion, tools, prompts, firstCall, polling{tool, args, until, terminalStates}, report, goals, rules{needsInput, blocker, consent, stop, iosVisualOnly, appMap}, capabilityGroups[{group, purpose, tools}], nextBestAction}`. Call it when the client dropped the server instructions or the agent lost context.
- **With `sessionId`**: `{sessionId, root, device, appId, mode, budgetRemaining, counters, recordedActions, findings, notes, workarounds, inputsProvided, readiness, lastJob, nextBestAction}`. `goal` biases the recommendation. After a restart with no live driver, `mode` and the platform come from the persisted `driverKind`.
- **`nextBestAction`** is `{tool, args, why}`. The first matching rung wins, and every rung checks state that the recommended call changes, so following it never loops:
  1. A job is running: `qa_job_status`.
  2. The last `qa_test_this` job ended and nothing ran after it. Blocked or unsafe and not yet explained: `qa_explain_blocker {failureCode, sessionId}`. `needs_input` already answered with `qa_continue_from_blocker`: `qa_test_this` again. Otherwise the job's own `nextRecommendedAction`, unless it is already done.
  3. No device is bound: `qa_test_this`.
  4. No app is running: `qa_prepare_ios_target` (iOS) or `qa_prepare_target`.
  5. No smoke has run and no actions are recorded: `qa_smoke`. A smoke counts once its milestone is persisted, not by counting actions.
  6. Findings exist and no report is newer: `qa_report`.
  7. A clean run has recorded actions but no generated assets: `qa_generate {target:"suite"}`.
  8. No report is newer than the last activity: `qa_report`.
  9. Otherwise: `qa_get_artifact` on the latest report. The run is done.

### qa_job_status

Polls a job. Parameters: `sessionId`, `jobId`, `waitMs` (long-polls until the job leaves `running`; use 45000, values above 50000 are clamped to 50000 so one call ends before a 60 s client tool timeout). Cancelling the call ends the wait with `CANCELLED` and leaves the job running (use `qa_job_cancel` to stop it). Returns `{jobId, kind, status, progress, progressDetail, error, result, artifactUris}`, plus `waited:{waitedMs, timedOut}` when `waitMs` is set. See [Sessions and jobs](concepts.md#jobs).

### qa_job_cancel

Cancels a running job and aborts its child processes. Returns `{jobId, cancelled}`; `cancelled:false` means the job had already finished or is unknown. See [Cancellation](concepts.md#cancellation).

### qa_explain_blocker

Explains any code in the catalog: `{failureCode, bucket, owner, severity, retrySafe, canSwipiumFix, whatItMeans, whoFixesIt, howToFix, context}`. This is the source for a code's bucket, owner, and `canSwipiumFix`. Parameters: `failureCode` (required), `context` (free text, echoed back), and `sessionId` (marks the blocker as explained, so `qa_status` moves past it). An unknown code is an error.

### qa_continue_from_blocker

Answers a `needs_input` question. Parameters: `sessionId`, `kind` (for example `credentials` or `monorepo_target`), `values` (a map of field to value), and `secretFields`.

- A value is secret when its field name looks like a credential (`pass`, `secret`, `token`, `otp`, `pin`, `cvv`, `key`, or `code`) **or** the field is listed in `secretFields`, which adds to that rule and never replaces it.
- Secret values join the redaction set immediately and are never echoed or logged. They are held in memory only, so after a server restart a login run asks again.
- Non-secret choices (`platform`, `device`, `target`, `allowOutsideRoot`) map onto the re-invocation's arguments.
- Returns `accepted`, `ignored[]` (each with how to apply it), `nextAction`, and `projectRoot` for a `monorepo_target` answer.
- A `monorepo_target` must be an existing directory inside the project root (one of the offered candidates). `/`, `~`, or any path outside the root is `INVALID_ARGUMENT`.

### qa_get_artifact

Reads a `swipium://session/<id>/<kind>/<name>` artifact, for clients without MCP resources. `mode` defaults to `inline` for text and `metadata` for images and every other binary (screen recordings, archives); `inline` returns an image as image content and any other binary as a base64 blob resource. Text over 1 MB returns the first 1 MB (the last 1 MB for logs, including `*.log` files) with a `[swipium: truncated ...]` marker naming the local file; binaries over 8 MB are not inlined. A text artifact whose redaction was `partial` reports `redaction:"partial"` plus `redactionNote` (see [Secrets and redaction](concepts.md#secrets-and-redaction)).

## Setup

Check the toolchain, open a session, and prepare a simulator.

### qa_doctor

Checks Node, the Android SDK and emulator, Xcode and `simctl`, WDA, and client freshness. `platform` is `android`, `ios`, or `both` (default `both` on macOS, where it is ready if either platform is; `android` elsewhere). `client` (`claude`, `gemini`, `codex`, `cursor`, or `vscode`) adds a `clientHint` with registration advice. When the connected client is Codex (or `client:"codex"`), the result adds two optional rows and a `codex` field:

- **`codex-env`**: Codex passes MCP servers only a fixed env whitelist plus `env_vars` and the `env` table, so shell exports never arrive otherwise. The row lists which Swipium env names are visible (names only, never values) and warns when no Android SDK is found or `java -version` fails without `JAVA_HOME`: forward `ANDROID_HOME` / `JAVA_HOME` if you installed them in a custom location, or install them first. Approval grants (`SWIPIUM_CONSENT_PREAPPROVE`, `SWIPIUM_ALLOW_REMOTE_WDA`) are never in the default list; set them literally in `env = { ... }`.
- **`codex-tool-timeout`**: a reminder to keep `tool_timeout_sec` at 600 or more (the server cannot read it).
- **`codex`**: `{envVarsLine, toolTimeoutSec}`, the exact `env_vars = [...]` line for `[mcp_servers.swipium]`; the text output prints it too.

`expectedVersion`, `expectedToolCount`, and `expectedSchemaHash` add a `client-freshness` check that reports a stale client.

### qa_start_session

Opens a session. Only needed for low-level tools; `qa_test_this` creates its own.

- **`budget`**: defaults to 8 minutes, 20 actions, 8 screenshots, 3 consecutive snapshot failures (`maxSnapshotFailures`), and 3 no-change actions (`maxNoChangeActions`). `profile` sets the time budget: `guardrail` 8 min, `login_smoke` 10, `full_smoke` 15, `install_smoke` 20. Once a budget is spent, tools return a budget stop.
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
- **Consent**: one combined `prepare_plan` consent for the privileged steps. Every install is gated: an APK inside the project root is risk low, an external one medium (the prompt shows its sha256). Inside-ness is decided on resolved real paths, so `<root>/../x.apk` and symlinks that leave the root count as external. An already-installed app launches without a prompt.
- **Device selection**: it acts on the online device rather than planning one. With several devices online (a phone included) and no `device`, it returns `MULTIPLE_DEVICES` listing the online serials; a phone that is the only online device is refused. See [Devices](concepts.md#devices). Boot and install run as a job and return a `jobId`.
- **Failure codes**: `PHYSICAL_DEVICE_UNSUPPORTED`, `MULTIPLE_DEVICES`, `NO_DEVICE`, `EMULATOR_BOOT_FAILED`, `DEVICE_NOT_READY`, `NO_ARTIFACT` (no APK to install), `INSTALL_FAILED`, `APK_ARCH_INCOMPATIBLE`, `ANDROID_MIN_SDK_INCOMPATIBLE`, `ANDROID_SIGNATURE_CONFLICT`, `METRO_REQUIRED`, `APP_LAUNCH_FAILED`, `INVALID_ARGUMENT` (for example a malformed app id).

### qa_prepare_ios_target

Prepares an iOS Simulator: picks and boots one, installs a simulator `.app`, launches `bundleId`, verifies the foreground, and reports whether WDA structured automation is available or the session is visual-only.

- **Parameters**: `sessionId`, `app` (absolute or project-relative), `bundleId`, `device` (UDID or name substring), `launch`, `attachWda`, `consentId`/`approve`.
- **`attachWda`**: `auto` (default) probes WDA and stays visual-only, with a recorded workaround, when it is unreachable, non-loopback, or session creation fails. `required` fails instead (`WDA_UNREACHABLE`, `WDA_SESSION_FAILED`, or `DESTRUCTIVE_REFUSED` for a non-loopback URL). `skip` does not probe.
- **Consent**: `install_app`, risk low for an app inside the project root, medium outside it.
- **Failure codes**: `IPA_NEEDS_REAL_DEVICE` (a `.ipa` is refused), `IOS_SIMULATOR_APP_MISSING`, `IOS_APP_WRONG_ARCH`, `SIMULATOR_RUNTIME_MISSING`, `SIMULATOR_BOOT_FAILED`, `SIMULATOR_BOOT_TIMEOUT`, `BUNDLE_ID_NOT_FOUND`.

### qa_ios

Direct iOS Simulator control (macOS only). `action` is one of:

| action | Parameters | Consent |
| --- | --- | --- |
| `list` | | |
| `boot` | `device` (UDID or name substring). Binds the simulator to the session. | none (low-risk, reversible) |
| `install` | `app` (a `.app`, absolute or project-relative) | `install_app`, medium |
| `launch`, `terminate` | `bundleId` | |
| `openurl` | `url` (deep link) | |
| `logs` | `last` (default `5m`) | |
| `privacy_reset` | `bundleId`, `service` (for example `location`, `photos`, `camera`, `all`) | low |
| `erase` | `device`. Wipes the simulator. | `erase_device`, high |

Screenshots go through `qa_screenshot`, and WebDriverAgent through `qa_wda`. The old `wda_*` and `screenshot` actions return `STALE_CLIENT`.

### qa_wda

Diagnoses, attaches, or manages WebDriverAgent for structured iOS automation. Without WDA, iOS stays visual-only and `qa_visual` does the checking (see [iOS modes](concepts.md#ios-modes)).

- **`action`**: `status`, `doctor`, `diagnose`, `logs`, and `tune` inspect an existing setup. `attach` connects to an external WDA at `webDriverAgentUrl` (default `http://127.0.0.1:8100`). `build` and `start` manage one (consent `wda_build` / `wda_start`, medium) from `wdaProjectPath` (default: an installed Appium WebDriverAgent when one is found), with `derivedDataPath` and `scheme` (default `WebDriverAgentRunner`); build and start output is captured as artifacts. `stop` terminates it.
- **Long-running actions** (one call stays under a 60 s client tool timeout):
  - `build` runs `xcodebuild build-for-testing` as a background job (kill timer 10 min) and returns `{jobId, status:"running"}` at once. Poll `qa_job_status` (with `waitMs`); the job result carries `built`, `logUri`, `wdaBuildProduct`, and on failure `failureCode` (`WDA_BUILD_FAILED` or `WDA_SIGNING_FAILED`) and `nextSteps`. `qa_job_cancel` stops the build.
  - `start` launches WDA and waits for `/status` for at most 45 s (or `ios.wda.startupTimeoutMs`, default 120000, when smaller). If WDA is still starting, it returns `ok` with `status:"starting"`, `pid`, `logUri`, and `remainingStartupMs`; poll `qa_wait {for:"wda_ready"}` until satisfied, then `attach`. `WDA_START_FAILED` is returned when the xcodebuild process exits early or the startup timeout is already spent.
- **`device`**: the simulator UDID behind this WDA (default: the session device). `udid` is a deprecated alias. `bundleId` defaults to the session's app. A non-loopback URL needs `allowNonLoopback:true` plus consent (see [iOS modes](concepts.md#ios-modes)).
- **Failure codes** (for `build`, the build failures arrive in the job result):
  - `attach`: `MULTIPLE_DEVICES` whenever no `device` is given and none is bound to the session (it never guesses), `WDA_UNREACHABLE`, `WDA_SESSION_FAILED`, `STALE_WDA_DEVICE`, `DESTRUCTIVE_REFUSED` (non-loopback URL without approval).
  - `build` and `start`: `NO_DEVICE` (no UDID given or bound), `BACKEND_UNSUPPORTED` (no Xcode command line tools), `NO_ARTIFACT` (no WebDriverAgent project found), `WDA_BUILD_FAILED`, `WDA_SIGNING_FAILED`, `WDA_START_FAILED` (with `managedPid` while a managed WDA is still running: attach to it or `stop` it first).

## Build

Pick a target, find an artifact, or build one. Only `qa_build mode:"run"` and `qa_bundletool install:true` have side effects on the machine or device.

### qa_resolve_target

Picks the best device or simulator deterministically and boots nothing. It honors `platform`, `device` (adb serial, simulator UDID or name, or AVD name), and a platform-specific artifact, prefers an online emulator or simulator, and otherwise plans a boot. Returns `selected`, `reason`, `alternatives`, `preconditions`, and `willBoot`.

A physical device returns `PHYSICAL_DEVICE_UNSUPPORTED` only when it is requested as `device`, when it is the only option on the chosen platform, or when `preferRealDevice` is set and a phone is visible. Otherwise an emulator or simulator is selected and the phone is mentioned in `reason`. See [Devices](concepts.md#devices).

`include` adds sections:

- **`context`**: framework (`expo`, `bare-react-native`, `native-android`, `native-ios`, `flutter`, or `unknown`), monorepo location, prebuilt artifacts, online Android devices, AVDs, booted and available iOS simulators (`iosBooted`, `iosAvailable`; macOS only), toolchain (`adb`, `emulator`, `java`, `aapt2`, `xcodebuild`), and blockers. A usable iOS simulator means a missing `adb` is not reported as a blocker.
- **`plan`**: READY workflows (with a budget profile and satisfied preconditions), BLOCKED workflows (`missing_device`, `missing_artifact`, `missing_test_data`, or `missing_toolchain`, with the required state and how to unblock), and UNSAFE workflows (with a reason, for example `bundle_cache_loss` for `fresh_start` on a debug RN/Expo build). A booted or bootable simulator counts as a device. With `sessionId`, the session's fixtures, observed auth, and prepared app inform the plan; without one, `.swipium/fixtures.json` does.

When target selection itself fails, the requested sections are still attached to the error.

### qa_resolve_artifact

Finds the best installable build in Gradle, Flutter, and Xcode outputs. Parameters: `platform` (`android`, `ios`, `any`), `buildType` (`debug`, `release`, `any`), `path` (short-circuits the search), `allowOutsideRoot`, `requireInstallableOn` (`android-emulator`, `android-real`, `ios-simulator`, `ios-real`). Xcode's DerivedData (`~/Library/Developer/Xcode/DerivedData`) is outside the project, so it is searched only with `allowOutsideRoot:true`. Returns ranked candidates (build type, installability, app id, ABIs, warnings) and the exact locations searched. Failure codes: `NO_BUILD_ARTIFACT` (with a `qa_build` next step), `AAB_NEEDS_BUNDLETOOL`, `ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL`.

### qa_build

- **`mode:"plan"`** (default, no side effects): the detected framework (Expo, React Native, native, Flutter), exact prerequisite and build commands, working directory, expected artifact globs, toolchain status, and a cost estimate. Works with `projectRoot` alone.
- **`mode:"run"`**: needs `sessionId`. Consent `build_from_source` (high). Runs as a job, stores a build-log artifact, and re-resolves the produced artifact. `timeoutMs` is per step (default 1200000).
- Parameters: `platform` (required: `android` or `ios`), `variant` (`debug` or `release`).
- **Failure codes** (a build failure is not a test failure): `BUILD_COMMAND_UNAVAILABLE`, `DEPENDENCY_INSTALL_REQUIRED`, `EXPO_PREBUILD_REQUIRED`, `GRADLE_FAILED`, `XCODEBUILD_FAILED`, `FLUTTER_BUILD_FAILED`, `BUILD_FAILED`, `BUILD_TIMED_OUT`, `BUILD_ARTIFACT_UNRESOLVED_AFTER_SUCCESS`.

### qa_bundletool

Converts an `.aab` (not directly installable) into an installable APK, cached under `.swipium/artifacts/`, before `qa_prepare_target`. Runs as a job.

- Default: a universal `.apk` signed with the debug keystore. `aab` defaults to the best `.aab` in the project; `force` rebuilds a cached one.
- `connectedDevice:true` builds a device-specific APK set; with `install:true` it also installs it on `device` (consent `install_app`, medium).
- **Failure codes**: a missing bundletool returns `AAB_NEEDS_BUNDLETOOL` at once, before any job starts (`BUNDLETOOL_MISSING` is effectively unreachable from this tool). The job can end with `AAB_BUILD_APKS_FAILED`, `AAB_DEVICE_SPEC_FAILED` (no connected device for a device-specific set), or `ANDROID_SIGNING_FAILED`, and an install with `ANDROID_SIGNATURE_CONFLICT`, `ANDROID_MIN_SDK_INCOMPATIBLE`, `APK_ARCH_INCOMPATIBLE`, or `AAB_INSTALL_FAILED`. No `.aab` in the project is `NO_BUILD_ARTIFACT`.

## Device

Inspect and control the device and app without raw `adb` or `simctl`. Mutating actions are logged as environment changes and appear in the report.

### qa_device_info

Read-only, no consent. On Android: `props` (manufacturer, model, SDK, release, ABIs, locale, timezone), `screen` (size and density), `orientation`/`rotation`/`autoRotate`, `installedThirdPartyCount`, and `packages[]` with `listPackages:true` (filter with `packageFilter`). On iOS: `platform:"ios"`, the simulator's name, runtime, and state, the screen in points, `orientation:"unknown"`, and a list of unsupported fields.

### qa_orientation

`orientation`: `portrait`, `landscape`, or `auto` (re-enables auto-rotate). Android only; iOS returns `BACKEND_UNSUPPORTED`. Logged as an environment change.

### qa_geolocation

Spoofs the GPS location on an Android Emulator (`adb emu geo fix <lng> <lat>`). `lat` and `lng` are required decimal degrees. Consent `geo_set` (medium). iOS returns `BACKEND_UNSUPPORTED`.

### qa_network

Airplane mode via `cmd connectivity airplane-mode`, Android 11+ only. `action`: `status`, `offline`, `online`, or `restore`. `offline` and `online` need consent `network_change` (medium). The original state is recorded on the first change and restored at `qa_report`, on `restore`, and on server shutdown. On iOS it returns `BACKEND_UNSUPPORTED` (simulators have no airplane-mode control). If the device rejects the toggle, nothing is recorded as changed.

### qa_metro

The Metro bundler (port 8081) for debug React Native and Expo builds. `action`:

- `status`: Metro, `adb reverse`, and serving state.
- `diagnose`: adds RedBox detection, logcat evidence, and recovery steps.
- `start`: consent `start_metro` (medium). Runs `adb reverse tcp:8081 tcp:8081`, spawns Metro detached with a log artifact, and tracks the process. Relaunch the app with `qa_prepare_target` afterwards.
- `stop`: stops the whole process group and removes the reverse.

`qa_metro` errors are typed: `MULTIPLE_DEVICES` or `NO_DEVICE` when it can't pick a device, and `METRO_FAILED` when `adb reverse` fails. It does not return `METRO_REQUIRED`; that code comes from `qa_prepare_target` and `qa_test_this` when a debug build needs a Metro server that isn't running.

### qa_app_control

`action`: `launch`, `foreground`, `background`, `force_stop`, `restart` (force-stop plus launch, for persistence checks), `clear_data`, or `fresh_start`. The action always targets the session's app. After `background`, the result reports the app that is actually in the foreground.

A success returns `{packageName, action, changedState:true, processKilled, foreground, foregroundIsApp}`. On an error, `changedState` reflects what actually ran: a driver call that failed before any mutation reports `changedState:false`.

`clear_data` and `fresh_start` wipe app data: consent `app_clear_data` / `app_fresh_start` (high). On debug RN/Expo builds they also need `acknowledgeBundleRisk:true`, because a wipe can remove the cached JS bundle; without it the result is `BUNDLE_LOSS_REFUSED`.

### qa_screen_record

Records to an mp4 artifact on Android (`adb screenrecord`, auto-stops after about 3 minutes) and the iOS Simulator (`simctl io recordVideo`). `action`: `start` (consent `screen_record`, medium; it captures whatever is on screen, so avoid password and OTP screens), `status`, `stop`. `save:"on_failure"` on `start`, plus `failed:false` on `stop`, discards the video of a passing run. One recording per session. Refused in sensitive sessions.

## Drive

Observe, act, assert, and collect evidence.

### qa_snapshot

Captures the screen as compact, addressable elements (`@e1`, `@e2`, …) with a `snapshotQuality` verdict. Interactive elements only, with no screenshot. Busy screens are capped; `filter` (a substring of text, label, id, or role) finds capped elements, and `diff:true` returns only what changed since the previous snapshot. Refs are invalid after navigation.

- **iOS with WDA**: an element's `id` is its accessibility identifier (WDA's `name` when it differs from the label). `TextField`, `SecureTextField`, `SearchField`, and `TextView` are `text-field` elements that show their typed value; secure fields stay masked.
- **Overlays**: banners and snackbars are reported only with an overlay signal (an overlay-like class or id, a dismiss control, or banner wording). Navigation-bar titles, text fields, and list rows are never reported as overlays.
- **Visual-fallback**: after `maxSnapshotFailures` consecutive failed dumps (default 3), the session switches to visual-fallback (`VISUAL_ONLY_SCREEN`) for that screen. Each later `qa_snapshot` and `qa_act` still tries one bounded structured dump; the first success switches back (`modeRecovered:true`) and resets the count.
- **iOS without WDA**: there is no UI tree; the result is `BACKEND_UNSUPPORTED`. Use `qa_visual`.
- **Failure codes**: `SNAPSHOT_FAILED`, `VISUAL_ONLY_SCREEN`, `BACKEND_UNSUPPORTED`, `NO_DEVICE`.

### qa_inspect

Full attributes of one `@eN` from the latest snapshot: class, id, content description, text, bounds, interaction flags, and raw attributes. Secrets are redacted, and a secure field's value is shown as `«secure»`. A ref from an older screen is `STALE_REF`.

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
| `wait` | | `for` (`{settled:true}` by default, or an element), `timeoutMs` (default 8000) |

Every action also takes `observe` and `timeoutMs` (the settle-wait cap). `timeoutMs` is at most 50000: larger values are clamped to 50000 with a note in `notes` (not rejected); negative values are `INVALID_ARGUMENT`.

- **Targets**: an `@eN` ref, `text`, `id`, a native `selector` on WDA (`accessibility id`, `name`, `predicate string`, or `class chain`), or `x`/`y` coordinates.
- **Observe**: `diff` (the default once a snapshot exists) returns added and removed elements; `full` returns the capped list; `none` returns verdicts only. When more than half of the post-action elements are new (a navigation), `diff` returns the full capped list with `diffAsFull:true`, `addedCount`, and `removedCount`.
- **`changed`**: true when elements appeared or disappeared, when positions moved (so a scroll that only shifts content counts), or when a checked, selected, or value state changed. State changes are listed in `stateChanged`, so a toggle is never retried as a press (which would toggle it back).
- **Keyboard**: if a tap target's center is inside the soft keyboard's frame, Swipium hides the keyboard (never a blind BACK), waits, re-resolves the target, and taps only once it is uncovered; success adds `keyboardHidden:true`. If the keyboard cannot be hidden, the result is `KEYBOARD_OBSTRUCTION` with `changedState:false`. If it was hidden but the target is gone or still covered, `KEYBOARD_OBSTRUCTION` with `changedState:true` and `keyboardHidden:true`. Nothing is tapped in either case. Targets above the keyboard (an accessory toolbar, suggestion chips) are tapped without hiding it. When the keyboard's area is unknown (no frame, or a frame taller than 55% of the screen), Swipium taps without hiding it and warns `keyboard is up; could not determine its area`.
- **Other overlays**: an element drawn over the target returns `OVERLAY_OBSTRUCTION` with `blockedByOverlay` instead of a blind tap. `ignoreOverlay:true` skips both checks. Coordinate taps are always treated as deliberate.
- **Scroll**: a plain `scroll` performs exactly one swipe. With `untilVisible`, visibility is checked before the first swipe, and swiping repeats up to `maxScrolls`. The result reports `swipes`, `untilVisibleFound`, and `endOfList:true` when a swipe no longer changes the screen. Each swipe is anchored inside the largest scrollable container on screen (Android `scrollable="true"`, iOS ScrollView, Table, or CollectionView), 10% inside its edges, so it never starts on a sticky app bar; `anchoredIn` is `scrollable` or `screen`. A match counts as found only when its center is on screen and not under the keyboard.
- **Back on iOS**: iOS has no back key. On WDA, `press key:"back"` taps the navigation bar's back button when one is on screen, otherwise it swipes from the left edge. `backVia` reports `nav_button` or `edge_swipe`. Without either, `BACKEND_UNSUPPORTED`.
- **Typing on Android**: text is escaped for the device shell (spaces, braces, brackets, glob characters, a literal `%s`). Characters `adb input text` cannot deliver (non-ASCII or control characters) return `TEXT_INPUT_UNSUPPORTED` with `changedState:false`; the value is checked before the field is focused or cleared.
- **Placeholders**: `type` expands `${SWIPIUM_*}` placeholders from session inputs (for example credentials given to `qa_continue_from_blocker`), else from the server environment. An unresolvable placeholder returns `MISSING_TEST_DATA` before anything is tapped. Secret handling of typed values is in [Secrets and redaction](concepts.md#secrets-and-redaction).
- **Warnings**: non-fatal caveats come back in `warnings[]`, for example `WDA session was re-created (requested without relaunching the app); verify the screen state`.
- **Mode recovery**: a successful observation switches a visual-fallback session back to structured mode (`modeRecovered:true`). An observation that never reaches idle switches it to visual-fallback for that screen only.
- **Device binding**: a device still booting is `DEVICE_NOT_READY`; a physical device is `PHYSICAL_DEVICE_UNSUPPORTED`. A session is only re-bound to its own device: a resumed iOS session re-attaches its simulator (WDA when it had attached WDA and it is reachable, else the simulator backend). An offline device is never replaced by a different online one.
- **Failure codes**: `INVALID_ARGUMENT` (missing field or target), `STALE_REF`, `ELEMENT_NOT_FOUND`, `AMBIGUOUS_SELECTOR`, `KEYBOARD_OBSTRUCTION`, `OVERLAY_OBSTRUCTION`, `TEXT_INPUT_UNSUPPORTED`, `MISSING_TEST_DATA`, `BACKEND_UNSUPPORTED`, `NO_DEVICE`.

### qa_clear_overlay

Clears what blocks the screen. `strategy`: `auto` (default, the topmost overlay), `hide_keyboard`, `press_back`, `tap_outside`, `minimize_logbox`, `dismiss_logbox`, `allow_permission`, `deny_permission`, or `dismiss_toast_if_possible`. `targetRef` reports whether that element was obstructed before and after. Returns what was cleared and what remains. A keyboard the backend cannot dismiss (for example WDA's "Did not know how to dismiss the keyboard") returns `KEYBOARD_NOT_DISMISSIBLE` (not retry-safe) with next steps: press enter, tap the app's Done button, or `tap_outside`.

### qa_check_health

Deterministic health check of the current screen: native crash, ANR, framework error boundary or RedBox, error surfaces, and whether the app is still in the foreground. High-severity findings are real bugs, not flakes. `qa_act` runs it after every action.

### qa_screenshot

Captures the screen as a session artifact and returns its `swipium://` URI with coordinate-space metadata (not inline bytes). `reason` is shown in the report. Counts against the screenshot budget. Withheld with `CAPTURE_WITHHELD_SECURE` when a password or OTP field is on screen, unless `force:true` (pixels cannot be redacted).

### qa_note

Records a structured outcome for one workflow, so the report is honest about what was verified.

- `workflow` and `outcome` (`pass`, `fail`, `blocked`, `skipped`, `not_applicable`) are required.
- `category` (`app_bug`, `mcp_limitation`, `missing_test_data`, `intentionally_skipped`, `destructive_refused`, `other`) says why and is independent of the outcome. A failing note without a category is recorded as `app_bug`, which also lands in the issue ledger as an app-owned `app_bug` with medium severity. Pass `category:"mcp_limitation"` for tool problems.
- Use `outcome:"blocked"` with `missingPrecondition`, `requiredState`, and `recommendedSetup` instead of a false failure.
- Attach evidence in `artifactUris`. For a screenshot-verified check, use `qa_visual mode:"assert"`.

### qa_visual

Screenshot-based checks for screens without a usable UI tree (maps, canvases, games, iOS without WDA) and for visual regression.

| mode | Required | What it does |
| --- | --- | --- |
| `assert` | `assertion` | Records a visual assertion: screenshot evidence plus a `qa_note` with `verifiedVisually:true`. `pass` defaults to true; `pass:false` means the expected thing is not visible. `reason` adds detail. Returns `{mode, assertion, pass, screenshotUri, coordinateSpace, secureFieldCheck}`. |
| `baseline` | `name` | Saves the screen as `<repo>/.swipium/baselines/<name>.png` (commit it or ignore it) plus a session artifact. |
| `diff` | `name` | Compares the screen to a baseline. Returns the changed ratio, the changed box (screenshot and device space), and an evidence artifact. `pass` means within `threshold` (default 0.02). |
| `find_text` | `query` | OCR through a locally configured provider (none is bundled). Consent `ocr_run` (medium). `minConfidence` defaults to 0.8. OCR text is secret-redacted. |
| `find_image` | `template` | Template-matches a PNG. `minScore` defaults to 0.85. |

A mode called without its required argument returns `INVALID_ARGUMENT`.

- **Paths**: `name` must match `[A-Za-z0-9._-]{1,64}` and must not start with `.`. `template` must be inside the project root (after resolving symlinks) or a `swipium://` artifact of the same project. Escapes and symlinked baselines return `VISUAL_PATH_REFUSED`.
- **Coordinates**: finds return a bounding box in screenshot pixels and a tappable `devicePoint`: points on iOS (WDA and `idb`), pixels on Android. Every result declares its `coordinateSpace`.
- **Tapping**: `tap:true` taps the found point through the driver. On a simulator without WDA it uses `idb ui tap` when `idb` is on PATH, else it returns the coordinates with install steps. Taps are recorded as session actions (for `qa_generate`) and count against the action budget.
- **Budgets**: every capture counts as a screenshot. Nothing runs once a budget is spent.
- **Secure screens**: every mode is withheld (`CAPTURE_WITHHELD_SECURE`) when a password or OTP field is on screen, unless `force:true`. When the cached UI tree is missing or older than a visual tap, Android and WDA re-dump it to check. With no UI tree at all (a simulator without WDA) in a session that has handled credentials, only `baseline` is withheld, because it persists the capture in the repository; `diff` and `assert` still run but save no screenshot (`currentUri`/`screenshotUri` is `null`, `captureWithheld:true`), and `find_image` returns coordinates only. `find_text` screens the OCR text itself and withholds a screen that reads like a password, OTP, or payment screen. Results carry `secureFieldCheck`: `clear`, `secure`, `forced`, `ocr` (only the OCR text was checked), or `unverified`; the last two come with a warning.
- **OCR provider contract**: set `ocrCommand` in `.swipium/config.json` (an argv array with an `{image}` placeholder, or `{command, io:"json", timeoutMs}`), or the `SWIPIUM_OCR_CMD` environment variable; the project config wins. The command runs with the project root as its working directory, gets a symlink-resolved PNG path (already masked when `visualMaskCommand` is configured), and must print JSON to stdout: `[{"text":"Log in","confidence":0.97,"bbox":{"x":53,"y":182,"width":104,"height":38}}]` or `{"regions":[…]}`, with the box in screenshot pixels, confidence from 0 to 1, and one region per text line. With `io:"json"` it also receives a `swipium.visual.provider.v1` JSON line on stdin. The default timeout is 30 s. Provider images go to a private per-call temporary directory (mode 0700) that is removed afterwards.
- **Provider failures**: a non-zero exit or a timeout returns `OCR_PROVIDER_FAILED` with `provider`, `exitCode`, `timedOut`, and the trimmed, secret-redacted `stderr`, never `found:false`. A Git executable as the provider is refused with `GIT_SCOPE_FORBIDDEN`. Without a provider, `find_text` returns `OCR_NOT_CONFIGURED` with an `exampleProvider`: a tesseract script to save as `.swipium/ocr_tesseract.py` (needs `brew install tesseract`), used with `"ocrCommand": ["python3", ".swipium/ocr_tesseract.py", "{image}"]`.
- **Mask command**: `visualMaskCommand` in `.swipium/config.json` (or `SWIPIUM_VISUAL_MASK_CMD`; the project config wins) follows the same contract and failure rules. The `ocr_run` consent prompt shows every command that will run, the mask command first, each with its argv and where it came from; a command from the repository's `.swipium/config.json` is labelled "unreviewed". `affects` carries `maskArgv` too.

### qa_wait

Blocks (bounded) until a setup condition holds, instead of a shell `sleep`. `for`: `device_online`, `metro_ready`, or `wda_ready` (the session's WebDriverAgent `/status` reports ready: the attached WDA, else the URL of the last `qa_wda start`, else the configured `ios.wda.url`; a non-loopback configured URL is refused with `DESTRUCTIVE_REFUSED` until it is attached with consent). `timeoutMs`: integer of at least 0, default 45000; larger values (older docs used 60000 or 180000) are accepted and clamped to 50000 with a note, so one call stays under a 60 s client tool timeout. On `timedOut`, call again. Returns `satisfied`, `timedOut`, and the current state. Cancelling the call stops polling at once and returns `CANCELLED`. To wait for a job, use `qa_job_status` with `waitMs`.

## Run

Smoke checks, exploration, and reports.

### qa_smoke

Server-side smoke on a prepared device: optionally launches (`launch`, default true with an app id), runs the baseline (snapshot quality, health, an evidence screenshot, skipped in sensitive sessions), then every saved flow in `.swipium/flows` (`runFlows`, default true) with `variables`. Records a `qa_note` per workflow; call `qa_report` afterwards.

Repository flows are untrusted, so `qa_smoke` never runs a flow with mutating steps or an external OCR or visual provider implicitly. Such a flow is recorded as `blocked` (category `destructive_refused`) with a pointer to `qa_flow_run` and its consent.

### qa_explore

Bounded, safe-by-default exploration of the launched app, as a job. It observes screens, taps ranked safe actions, checks health after each, and builds a screen graph (JSON and Markdown, `graphUri` in the job result). Taps are recorded for `qa_generate`, and the app map is updated.

- **Bounds**: `depth` (default 3), `maxActions` (20), `maxScreens` (12), `maxDurationMs` (360000). `goal` is a natural-language focus.
- **`strategy`**: `crawl` (default, deterministic), `task_planner` (infer QA tasks first), or `hybrid`.
- **`safeMode`**: `strict` (default); `balanced` (unknown-risk actions allowed); `dry_run_destructive` (lists destructive candidates without tapping); `approved_destructive_candidate` (taps exactly one candidate from a dry run). `approved_destructive` is refused with `DESTRUCTIVE_REFUSED`.
- **`approved_destructive_candidate` requirements**: an exact `destructiveCandidate` copied from the dry run (else `DESTRUCTIVE_REFUSED`); disposable test state, meaning a fixture with `disposable:true` or `environment:"test"` (else `MISSING_FIXTURE`); `confirmHighImpact:true` for payment, send, permission, account-delete, and bulk-delete candidates; and the `destructive_ui_candidate` consent (high).
- **Text and data**: `includeTextEntry` (default false) types into fields that have a value source (fixtures). `allowGeneratedData` permits generated disposable test data; `accountCycle` additionally permits logout, only on a disposable generated account. Generated values are recorded under `SWIPIUM_TEST_*` or `SWIPIUM_GEN_<FIELD>` names (see [Secrets and redaction](concepts.md#generated-output)).
- **Auth**: `stopOnAuth` (default true) returns `needs_input` at an auth wall without credentials.
- **`generateSuite:true`** also writes and compiles a POM suite from the promoted paths. `suitePromotion` scoring is always returned.

### qa_report

Assembles the session report: executive summary (release risk ship, caution, or block, plus the next action), health, outcomes by workflow, findings, evidence links, environment changes and their restoration, the mutation ledger, and workarounds. Saves the full report as an artifact and returns a summary plus `reportUri`, `manifestUri`, and `dumpUri`. `qa_test_this` calls it automatically.

- **`baseline`** (a baseline `report.json` path) adds comparison links; **`trendRoot`** (a project root with `.swipium/runs` history) adds trend and flake context.
- **Verdicts**: the app verdict, the coverage verdict, and the tool verdict are separate, and tool status never changes the app verdict. The tool verdict (`toolVerdict.status`) is:
  - `BLOCKED` when a workflow was limited by a Swipium or MCP capability (a `qa_note` with category `mcp_limitation`);
  - `DEGRADED` when tools returned typed driver or Swipium errors (for example a WDA 404 or a snapshot failure);
  - `PASS` otherwise.

  Recorded tool errors are listed in `toolErrorsByCode` with `degradingCount`, `uncodedCount`, and `probingCount`. Uncoded errors (`UNKNOWN`, mostly deliberate refusals and guard messages) and agent-probing codes (`ELEMENT_NOT_FOUND`, `STALE_REF`, `AMBIGUOUS_SELECTOR`, `INVALID_ARGUMENT`) are counted but never make the verdict `DEGRADED` on their own. Consent refusals, missing test data, and `CANCELLED` are not recorded as tool errors.
- **Deduplicated findings**: identical findings (same failure code and kind, severity, layer, screen or foreground, and message) are reported once, with `count`, `firstAt`/`lastAt`, and every distinct `screenshotUris` entry. `findingOccurrences` keeps the raw total; text and markdown show repeats as `(×N)`.
- **Network restore**: a network change made during the session is restored when the report is generated.
- **`format`** adds an export artifact (`exportUri`, `exportFormat`). The CI formats carry the `.swipium/policy.json` release-gate verdict ([CI policy](flows.md#ci-policy)). The same files can be rendered outside the agent with the `swipium report` CLI; recipes and exit codes are in [ci-reports.md](ci-reports.md).

| Format | Notes |
| --- | --- |
| `summary` (default) | No export. |
| `markdown`, `json` | The full report. The saved report is deep-redacted with the session's secrets before it is written. |
| `junit` | Failed workflows and high-severity findings are `<failure>`. Blocked, skipped, and not-applicable outcomes are `<skipped>`. Failures the policy treats as lenient (`warnOn` or `ignoreKnown`) are `<skipped message="policy …">`, so a passing gate never fails CI. |
| `sarif` | SARIF 2.1.0. Every result is anchored to a real repository file (a `%SRCROOT%`-relative `physicalLocation`, line 1), as GitHub code scanning requires: the app-map source file of the screen or workflow, else the first project manifest that exists (`app.json`, `package.json`, `pubspec.yaml`, Gradle files, `Info.plist`, `README.md`). `swipium://` evidence stays in related locations and properties. `invocations[0].executionSuccessful` is always `true`, because the run itself worked. The gate verdict is `runs[0].properties.releaseGateVerdict` (`pass` or `block`). |
| `github-summary` | Markdown for `$GITHUB_STEP_SUMMARY`, capped at 900 KB (below GitHub's 1 MiB limit) so the verdict always survives. Truncation is stated in the output. |
| `playwright` | Playwright JSON-reporter-style results: one spec per workflow outcome, with evidence attachments. |
| `flow` | The recorded actions as Flow V2 YAML. Needs recorded actions. |

## App map

The durable app knowledge map in `.swipium/app-map.json`, also served as MCP resources. It is project memory: read it before feature work.

### qa_app_map_build

Builds or updates the map: a framework-aware static scan (Expo Router, React Navigation, the Android manifest, SwiftUI and UIKit, Flutter) plus, with `sessionId`, a merge of the latest exploration screen graph. `mode`: `static_only`, `runtime_merge`, or `full` (default). `includeCodeIndex` (default true) persists a code-symbol index for queries; `forceRescan` rescans even when the map is current. Returns a summary and the map URI. Does not commit.

### qa_app_map_read

Reads one compact section: `summary` (default), `screens`, `features`, `auth`, `automation`, `testSuite`, or `full`. `featureId` or `screenId` drills into one node. Large sections come back as a resource URI. Without a map: `NO_APP_MAP`.

### qa_app_map_query

Searches the feature index, static topology, runtime graph, and tests for a natural-language `query` (for example "checkout flow"). `intent` (`feature`, `screen`, `code`, `test`, `freeform`) biases the search; `limit` caps it. Each result has provenance, confidence, source files, screens, and the recommended next Swipium call.

### qa_app_map_feature_scope

Resolves a feature (`featureId`, or a free-text `query`) into a focused test scope: code symbols, static and runtime screens, existing tests, objective, coverage gaps, strategy, and ranked candidates. It asks one disambiguation question only on a genuine tie. Works without a map (it falls back to a code scan). `includeCode` (default true) and `limit` (default 8 per list) shape query mode; `sessionId` adds runtime evidence.

### qa_app_map_update

Targeted, provenance-tracked edits without a rebuild: `note` (a user note), `testCases`, `automationSuite` (link a suite to features and screens), `environment` (for example `test` or `staging`), or `featureCoverage` (override a feature's coverage). Existing entries with the same id or path are overwritten, which is why the tool is marked destructive.

## Feature

### qa_test_feature

A focused test of one named `feature` (natural language).

- **`mode:"plan"`** (default, read-only): scope, objective, generated cases, required fixtures, and an ordered plan.
- **`mode:"execute"`**: a job that explores toward the feature, records pass, fail, or blocked per case, updates the app map, and writes a report (see the `qa_job_status` result). `interactive` runs until the first question.
- **Without `sessionId`**, `execute` bootstraps a device from `projectRoot` (optionally `platform` and `device`) with one consent for boot, install, and launch.
- A feature behind auth, a paywall, a permission, or a missing fixture is **blocked** with setup guidance, not failed.
- Other parameters: `creativity` (`conservative`, `standard`, `creative`, `adversarial`) with `allowAdversarial`, `maxScreens` (default 8), `maxActions` (default 20), `timeoutMs`, `generateCases` (default true), `includeCode`, `limit`.

## Flows

Validate, run, compile, and repair reusable Flow V2 files under `.swipium/flows/`. The file format, step reference, variables, and CI policy are in [flows.md](flows.md).

Without a session, `qa_flow_check` and `qa_flow_run mode:"plan"` resolve flow names against `projectRoot`, then the session root, then MCP roots, then `SWIPIUM_PROJECT_ROOT` / `CLAUDE_PROJECT_DIR`, then a server working directory that looks like an app. A flow that does not exist returns `FLOW_NOT_FOUND` with the paths checked; a call with neither `flow` nor `flowYaml` returns `INVALID_ARGUMENT`; YAML that does not parse returns `INVALID_FLOW`.

### qa_flow_check

Statically validates a flow (a lint of the YAML) without running it: syntax and schema errors with the offending step, plus warnings. Pass `flow` (a name under `.swipium/flows` or a path) or `flowYaml`. `platform` (`android`, `ios`, `cross-platform`) adds platform-aware locator warnings. `ci:true` adds CI preflight warnings: variables a CI run cannot resolve, and mutating steps the [CI policy](flows.md#ci-policy) does not allow.

### qa_flow_run

- **`mode:"run"`** (default) executes a flow on the prepared session, server-side, with setup and teardown, fail-fast, and no automatic retry of mutating steps. `repeat` (1 to 10) runs it several times to classify flakes. A failure returns the failed step (`failedAtStep`), a screenshot, the `failureCode`, health, and `nextSteps` pointing at `qa_flow_repair {flow, failedStep}` (except when the cause is a missing variable, which is not locator drift).
- **`mode:"plan"`** previews without a device: per backend (`android-direct`, `ios-raw-simulator`, `ios-wda`, `appium-uiautomator2`, `appium-xcuitest`; `backend` narrows it), whether each step is `native`, `fallback`, `visual_only`, or `unsupported`. `appium` passes Appium session hints.
- **Variables**: `variables` win over the session's stored inputs, then `SWIPIUM_*` environment variables; no other environment name is ever read (`MISSING_FIXTURE`). See [Flows: variables](flows.md#variables).
- **Structured flows** (`mode: structured`, the default) on an iOS Simulator without WDA, or in a visual-fallback session, are refused with `BACKEND_UNSUPPORTED`. Use `mode: visual` or `auto`, or attach WDA.
- **Consent**: mutating steps and OCR steps need the `flow_mutation_run` consent (risk high for script seeds, otherwise medium). The prompt's `exactCommand` and `affects` show each seed's exact argv or URL, labelled as repository-supplied and unreviewed, and each variable `openUrl` destination with credential-like values masked. Which steps count is in [Flows: step reference](flows.md#step-reference).
- **Refusals**: OCR steps are refused in sensitive sessions (`UNSAFE_ACTION_REFUSED`) and report `VISUAL_ONLY_SCREEN` when no OCR provider is configured. Image templates and baselines outside the project root fail with `UNSAFE_ACTION_REFUSED`.

### Flow steps

Moved to [Flows: step reference](flows.md#step-reference), with the file format and a full example.

### qa_flow_compile

Compiles an existing POM suite on disk (`suite`, relative to `.swipium/`, default `suites/smoke.yaml`) into runnable Flow V2: it resolves page-object refs to selectors, carries variables, writes `.swipium/flows/<slug>.yaml` (plus a copy under `.swipium/compiled/`), and validates each flow. It needs no session or recorded actions, which makes it the path for committed or hand-edited suites and CI (`swipium suite`). `qa_generate target:"suite"` already compiles the suite it generates.

### qa_flow_repair

Given a failed step (`failedStep`, zero-based, from `qa_flow_run`) and the current screen, suggests a stronger locator plus app code changes (such as adding `accessibilityIdentifier` or `testID`). An exact id, label, or text match on the current screen is high confidence. Otherwise candidates are restricted to the failed target's role (a tap stays on a button, an `inputText` stays on a text field) and ranked by text similarity (medium for a contained match, low for a similar one), so a button renamed from "Sign in" to "Log in" is never repaired to the "Email" field. `apply:true` patches simple YAML selector steps in a flow file only at high or medium confidence, and records the patch in the mutation ledger; at low confidence it returns the proposal with `applied:false` and a note, and it never patches inline `flowYaml`. The flow must resolve inside the project root, otherwise `UNSAFE_ACTION_REFUSED`.

## Generate

### qa_generate

Turns the actions recorded in a session (`qa_act`, `qa_smoke`, `qa_explore`) into per-run assets. For the durable repository suite, use `qa_suite_generate`. `mode:"plan"` is a read-only preview. Parameters for other targets are ignored with a note. Every target returns `NO_RECORDED_ACTIONS` when the session has recorded nothing (for `appium`, `bootstrap` records a run first).

| target | Output | Target-specific parameters |
| --- | --- | --- |
| `flow` | Flow V2 YAML for `qa_flow_run` | `budgetProfile` |
| `pom` | Page objects and a locator audit | |
| `suite` | The full per-run POM suite under `.swipium/`, compiled to runnable flows, with a replay gate | `compile` (default true), `replay` (`none`, `dry_run` (default), `same_session`, `fresh_state`), `stateProfile` (for `fresh_state`, which is consent-gated) |
| `testcases` | A `TC-xxx` catalog | `format` (`yaml`, `markdown`, `both` (default)) |
| `appium` | A runnable WebdriverIO (TypeScript or JavaScript) or Python Appium suite | `language` (default auto), `platform` (`auto`, `android`, `ios`, `both`), `backend`, `projectRoot`, `bootstrap`, `feature`, `device`, `integrateIntoProject` (consent `automation_project_write`; never overwrites), `includeCi`, `candidateOnly`, `brittleThreshold` (default 40) |

`name` sets the asset name (default from the app id). `save` writes files (default true for `suite` and `appium`, false otherwise). `sessionId` is required except for `appium`, which can plan or `bootstrap` (smoke plus explore) from `projectRoot`.

- **Appium code**: every recorded step becomes real code. Swipes and scrolls are real gestures (bounded scroll-until-visible loops). A step that cannot be expressed fails generation with `UNEMITTABLE_STEP` instead of emitting a silent no-op. Class, method, and file names are sanitized, so they are always valid identifiers in the target language.
- **Platform**: the generated suite's default `SWIPIUM_PLATFORM` is resolved from the explicit `platform` argument, then the platform of the session's device, then the project profile, then Android. `ios` means Appium XCUITest and `android` means UiAutomator2. The plan reports `primaryPlatform` and `platformSource`. Generated suites also read `SWIPIUM_NO_RESET` at run time.
- **Visual assertions**: a `qa_visual mode:"assert"` step is free-form prose, not on-screen text, so it becomes a clearly marked manual checkpoint: a `TODO(manual visual check, not automated)` comment in code, a `visualCheck` POM step, an evidence-capturing `assertVisual` step in compiled flows, and "MANUAL visual check" in test cases. Only real text assertions become `assertTextVisible`.
- **Secrets**: recorded secrets become `${SWIPIUM_*}` placeholders (see [Generated output](concepts.md#generated-output)). If a registered secret value would still be written, generation fails with `SECRET_IN_GENERATED_OUTPUT` and nothing is written. The Appium `validation.secretsClean` check scans every generated file, comments included.

## Test suite

The canonical suite in `.swipium/test-suite.json`. It persists and grows across runs, unlike the per-run assets from `qa_generate`. All five tools accept `sessionId` or `projectRoot`.

### qa_suite_read

Reads the suite, filtered by `functionality` or `status` (`active`, `draft`, `deprecated`, `blocked`, `manual_only`). `format`: `summary` (counts and ids), `json`, or `markdown`. Returns a resource URI for the full suite.

### qa_suite_update

Merges `cases` into the suite. `source` (required) is `report`, `exploration`, `feature`, `ticket`, `manual`, `generate`, or `suite`, with an optional `sourceUri`. A case matching feature, objective, and normalized steps is updated, not duplicated; new cases get stable ids (`TC-<FEATURE>-NNN`). `mergeMode`: `append`, `update`, or `replace_generated` (overwrites generated fields over curated ones). Returns created, updated, and deprecated ids plus conflicts.

### qa_suite_generate

Generates or refreshes canonical cases from the session's recorded actions, outcomes, and exploration coverage, and merges them into the suite (re-running updates cases, with no duplicates). `feature` labels the generated flow case. `creativity` (`conservative`, `standard` (default), `creative`, `adversarial` for negative and abuse cases) sets how far cases go beyond the happy path; `creativityLevel` is a deprecated alias. `includeManualOnly` keeps manual-only cases. Returns generated cases, skipped or blocked features, and map-coverage gaps.

### qa_suite_export

Exports the suite as `markdown` (review-ready), `yaml` (a per-functionality directory), `json`, or `junit`. `save:true` writes it under `.swipium/test-suite-export/`.

### qa_suite_lint

Lints the suite (missing expected or actual results, unlinked or stale feature and screen links, duplicate ids, brittle automation, adversarial cases without safety metadata) and, when `.swipium/pages` exists, generated page objects (coordinate-only, locale-fragile, or dynamic locators). `brittleThreshold` is `C` or `D`. `liveFeatureIds` enables the stale-link rule. Returns errors and warnings.

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

- **Identity**: a manually logged issue's identity is its normalized title (ids and numbers scrubbed), plus `failureCode` or category, plus platform. The app id is left out because the ledger is already project-scoped, so the same title logged with a `sessionId` or a `projectRoot` lands on the same issue. A title with no identifying words left after scrubbing is refused with `ISSUE_LOG_TOO_VAGUE`.
- **Issues logged before 2.0.0** keep their old fingerprint (platform and `failureCode` only), and new logs never merge into them. Close them with `mark_fixed`, or hide them with `suppress`.
- **Lifecycle**: re-observing a fixed issue reopens it with a message that quotes `howFixed` and `fixedInCommit`. `mark_fixed` only applies to an active issue, otherwise `ISSUE_STATE_INVALID`. `verify_fixed` needs a fixed issue plus evidence, otherwise `ISSUE_EVIDENCE_REQUIRED`. An unknown key is `ISSUE_NOT_FOUND`.
- **Suppression**: `suppressedUntil` (an ISO timestamp) makes it expire automatically, after which the issue returns to its previous state; without it the suppression is open-ended. `unsuppress:true` lifts it early. Suppressed issues are hidden from `history` unless `includeSuppressed:true`, and show as known noise in reports.
- **Redaction**: with a `sessionId`, registered session secrets are scrubbed from `title`, `summary`, `howFixed`, `suppressionReason`, and `fixedBy` before they reach the committed ledger.

### qa_mobile_audit

Plans or executes a named release audit. `profile` (required):

| profile | Checks |
| --- | --- |
| `smoke` | Launch and baseline checks. |
| `account_cycle` | Create > logout > login > forgot-password on a disposable generated account. Needs `allowGeneratedData`. |
| `store_compliance` | Privacy policy, terms, account deletion, subscription, and paywall. |
| `resilience` | Offline, relaunch, and rotation. |
| `release_gate` | All of the above, plus locator readiness and issue recurrence. |

`mode:"plan"` (default) returns the checklist and safety contract without a device. `mode:"execute"` needs a prepared session, runs every check, logs failed and blocked checks to the issue ledger with evidence, and returns the release impact. It always runs to completion. No check passes without evidence. `allowTestAccountDeletion` permits deleting disposable test accounts (never a real account). `offlineMode` hints that resilience checks should drive offline state; `targetApp` and `sourceRevision` (`{commit, buildVersion, branch}`) identify what was audited.

Executing `resilience` or `release_gate` (which runs all four other profiles) needs the `network_change` consent (medium), the same gate as `qa_network`, because it toggles airplane mode. The tool returns the consent request before running anything. With consent, the original airplane state is recorded first and restored afterwards, even if a check fails.

## First run

### qa_first_run

Gets past a first-run gate: login, sign-up, OTP, onboarding, permissions, or a paywall. Needs a prepared device.

- **`mode:"plan"`** (default, read-only) classifies the current screen and returns the safe plan. `until`, `maxSteps`, and `maxDurationMs` are ignored with a note.
- **`mode:"continue"`** runs bounded steps. `until`: `one_step` (default), `until_gate` (stop at a paywall, OTP, or permission), or `until_home`. In test or staging environments it fills forms with generated data (the password is kept secret), advances onboarding, and records paywalls without purchasing. It refuses sign-up in production-like environments and returns one `needs_input` question on an OTP.
- `testDataPolicyPath` (default `.swipium/test-data-policy.json`) and `allowGeneratedAccount` control whether a throwaway account may be created.

## MCP resources and prompts

**Resource templates** (read by URI; `qa_get_artifact` and `qa_app_map_read` are the fallbacks for clients without resources):

| Template | Content |
| --- | --- |
| `swipium://session/{sessionId}/{kind}/{name}` | Session artifacts: screenshots, dumps, reports, logs, videos. |
| `swipium://project/{projectId}/app-map` | The complete app map JSON. |
| `swipium://project/{projectId}/app-map/{kind}/{id}` | One app-map section: a feature, screen, or test-suite entry. |

`resources/list` is scoped to the current client's project roots (its MCP roots plus the roots of sessions used in this server process), so one client never browses another project's artifacts. Each listing shows the newest 100 entries and says so on the last entry when it is capped; the rest stay readable by URI. Artifacts of sensitive sessions are never listed.

**Prompts**:

| Prompt | Purpose |
| --- | --- |
| `swipium_setup_check` | Verify Swipium can test a project and report what is blocking it. |
| `swipium_guardrail_validation` | Confirm Swipium refuses an unsafe bundle-loss wipe on a debug RN/Expo build. |
| `swipium_full_smoke` | Plan, prepare, run the top ready workflows, and produce a report. |
| `swipium_bug_repro` | Drive to a described bug, capture deterministic evidence, and record it as a structured outcome. |
| `swipium_convert_run_to_flow` | Draft a `.swipium/flows/*.yaml` from the steps just performed, then validate it. |

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

Every code a tool can return is in the catalog, and `qa_explain_blocker` explains any of them. Each code has a **bucket** (how to triage it: `app_bug`, `environment`, `missing_data`, `mcp_limitation`, or `unsafe_refused`), an **owner** (who fixes it: `app`, `environment`, `swipium`, or `user`), a severity, and a default retry safety. The tables below are grouped by bucket; owner is per code.

Codes marked **reserved** are defined for classifying evidence, reports, and policy rules (so `blockOn`, `warnOn`, `ignoreKnown`, and report consumers can name them stably), but no tool returns them in 2.0.0. A reserved code may start being returned in a minor release. Codes marked **finding** appear as health findings in reports rather than as tool errors.

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
| `BLANK_SCREEN`, `INFINITE_SPINNER` | app | Blank screen; stuck loading indicator. Reserved. |

### Bucket: environment

Device, simulator, and WebDriverAgent:

| Code | Owner | Meaning |
| --- | --- | --- |
| `NO_DEVICE` | environment | No online device or bootable emulator, or no device UDID for a WDA build or start. |
| `ADB_NOT_FOUND` | environment | `adb` is not installed or not on PATH. |
| `DEVICE_NOT_READY` | environment | The device exists but is not ready (booting, or properties unreadable). |
| `EMULATOR_BOOT_FAILED` | environment | The emulator failed to boot. |
| `SIMULATOR_RUNTIME_MISSING`, `SIMULATOR_BOOT_FAILED`, `SIMULATOR_BOOT_TIMEOUT` | environment | No usable iOS runtime; simulator boot failed or timed out. |
| `MULTIPLE_DEVICES` | environment | More than one device matches, or a WDA attach has no device; pass one explicitly. |
| `WRONG_FOREGROUND`, `PERMISSION_DIALOG`, `NATIVE_ALERT` | environment | Another app, a permission dialog, or a native alert is in front. Finding. |
| `WDA_UNREACHABLE`, `WDA_BUILD_FAILED`, `WDA_SIGNING_FAILED`, `WDA_START_FAILED`, `WDA_SESSION_FAILED`, `WDA_PORT_CONFLICT` | environment | WebDriverAgent could not be reached, built, signed, started, or given a session, or its port is taken. |
| `STALE_WDA_DEVICE` | environment | WDA appears bound to a different device than the session. |
| `DEV_SERVER_DOWN`, `NETWORK_SERVICE_UNAVAILABLE`, `NETWORK_OFFLINE` | environment | Reserved. |
| `DEVICE_BOOT_FAILED` | swipium | Reserved. |

Project, artifact, install, and build:

| Code | Owner | Meaning |
| --- | --- | --- |
| `PROJECT_ROOT_UNRESOLVED`, `PROJECT_ROOT_EMPTY` | user | No usable project root; the root is empty. |
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
| `BUNDLE_ID_NOT_FOUND` | environment | The bundle id is not installed on the device. |
| `APP_LAUNCH_FAILED` | environment | Installed, but the app did not launch. |
| `BUILD_FAILED`, `GRADLE_FAILED`, `XCODEBUILD_FAILED`, `FLUTTER_BUILD_FAILED` | app | Build from source failed. |
| `BUILD_COMMAND_UNAVAILABLE`, `DEPENDENCY_INSTALL_REQUIRED`, `BUILD_TIMED_OUT` | environment | Build prerequisites and outcomes. |
| `EXPO_PREBUILD_REQUIRED`, `BUILD_ARTIFACT_UNRESOLVED_AFTER_SUCCESS` | swipium | Expo prebuild needed; the build succeeded but its artifact was not found. |
| `METRO_REQUIRED` | swipium | A debug RN/Expo build needs Metro. |
| `METRO_FAILED` | environment | Metro failed. |
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
| `BACKEND_UNSUPPORTED` | swipium | The operation is not supported on this backend (for example iOS rotation, or iOS without WDA). |
| `UI_IDLE_TIMEOUT`, `ANIMATION_IDLE_BLOCKED` | swipium | The UI did not settle. |
| `WDA_SOURCE_SLOW`, `WDA_APP_NOT_IDLE`, `WDA_HIERARCHY_TOO_LARGE`, `WDA_XPATH_REFUSED` | swipium | WDA performance and locator limits. |
| `WEBVIEW_UNAVAILABLE` | swipium | WebView content is not reachable by native automation. |
| `VISUAL_LOCATOR_DRIFT` | swipium | A visual or OCR locator drifted. |
| `UNEMITTABLE_STEP` | swipium | A recorded step cannot be expressed as Appium code. |
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
| `CONSENT_DECLINED`, `CONSENT_CANCELLED`, `CONSENT_REFUSED` | user | See [Consent](concepts.md#consent). |
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
