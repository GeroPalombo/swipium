# Concepts

The ideas that cut across Swipium's tools: sessions and jobs, how the project root is found, consent, secret handling, iOS modes, and device policy. Per-tool parameters and failure codes are in the [Tool Reference](tools.md); flow files are in [Flows](flows.md); environment variables are in the [README](../README.md#configuration--environment-variables).

**Contents**: [Sessions and jobs](#sessions-and-jobs) · [Project root](#project-root) · [Consent](#consent) · [Secrets and redaction](#secrets-and-redaction) · [iOS modes](#ios-modes) · [Devices](#devices) · [Glossary](#glossary)

## Sessions and jobs

### Sessions

A session holds one run's device, app, budget, recorded actions, findings, notes, and evidence. `qa_test_this` creates its own; the low-level tools need one from `qa_start_session`. Every tool that takes a `sessionId` returns `INVALID_ARGUMENT` (`Unknown sessionId "…"`) for an unknown id, with nothing run.

- **Location**: each session lives in `~/.swipium/runs/<project-hash>/<sessionId>/`, with `state.json` and artifact folders inside. Files are written atomically with mode 0600 (directories 0700). `~/.swipium/registry.json` lists up to 200 reloadable sessions.
- **What is persisted**: notes, findings, tool errors, jobs, environment changes, and mutations, all redacted with the session's secrets before writing. Recorded actions are persisted in their secret-safe form (see [Secrets and redaction](#secrets-and-redaction)). For fixtures only metadata is written: fixture values, field values, and seed specs never are, and secret generated values are stored as `<redacted>`.
- **What is never persisted**: secret values and the values of supplied inputs (credentials, OTPs). They live in memory only, so after a server restart a login run asks for them again even though the stored metadata still lists them.
- **Rehydration**: after a restart, a session reloads on first use. The device, app id, `driverKind`, `wdaUrl`, jobs, artifacts, findings, notes, and mutations are restored. The device is re-attached with the saved driver kind (WDA when the session had attached it and it is still reachable); an offline device is never replaced by a different one. Fixtures are re-read from `.swipium/fixtures.json`, which supplies the live values. A fixture that was passed inline to `qa_start_session` and is not in that file comes back as metadata only, **without its `value`, field values, or `seed`**; re-declare it (or add it to `fixtures.json`) if a run needs them. If the old state shows secret activity, the session is flagged `redactionDegraded`, because the secret set cannot be rebuilt.
- **Retention**: at startup, session directories are pruned when all of these hold: last activity older than `SWIPIUM_RETENTION_DAYS` (default 30; `0` or `off` disables the automatic prune), not in the registry, not live in this process, and not among the newest `SWIPIUM_RETENTION_KEEP` (default 20) sessions of that project. The prune fails closed: when `registry.json` exists but cannot be read or parsed, nothing is deleted. `swipium gc` applies the same rule on demand.
- **Artifacts** are addressed as `swipium://session/{sessionId}/{kind}/{name}` and read with `qa_get_artifact` or as MCP resources.

### Jobs

Long operations run as background jobs and return a `jobId` at once: `qa_test_this` and `qa_test_feature` in `execute` or `interactive` mode, `qa_explore`, `qa_build` in `run` mode, `qa_bundletool`, and the boot and install steps of `qa_prepare_target`.

The usual loop:

1. `qa_test_this {mode:"execute"}` (after any consent) returns `{sessionId, jobId, state:"running"}`.
2. `qa_job_status {sessionId, jobId, waitMs:60000}` until `status` is no longer `running`.
3. On `result.state:"completed"`, read the report with `qa_get_artifact {uri: result.reportUri}`.

**Job status and result state are different fields.**

| Field | Values | Meaning |
| --- | --- | --- |
| `status` (every job) | `running`, `done`, `failed`, `cancelled` | Where the job is. |
| `result.state` (`qa_test_this` jobs) | `completed`, `blocked`, `unsafe`, `needs_input` | How the run ended. `completed` and `needs_input` end the job `done`; `blocked` and `unsafe` end it `failed`. The envelope is in `result` either way. |

- **needs_input**: there is no `needs_input` job status. A job that stops on a question ends `done` with `result.state:"needs_input"`. `qa_test_this` can also return `state:"needs_input"` **directly, with no `jobId`**: in `interactive` mode, or with `stopOnNeedsInput` or `goal:"test_login"`, the credentials question is asked before any job starts when the project likely has a login and no credentials are available. Either way, relay the one question and make the returned resume call (`qa_continue_from_blocker`).
- **Polling**: `qa_job_status {sessionId, jobId, waitMs}` returns `{jobId, kind, status, progress, progressDetail, error, result, artifactUris}`. `waitMs` (default 0, capped at 120000) long-polls: the call returns as soon as the job leaves `running` and adds `waited:{waitedMs, timedOut}`. An unknown `jobId` is `INVALID_ARGUMENT`.
- **Blocking instead of polling**: `qa_test_this {waitForCompletion:true}` waits up to `timeoutMs` (default 120000) and returns the terminal result directly, or `state:"running"` with `timedOutWaiting:true`.
- **Cancelling**: `qa_job_cancel {sessionId, jobId}` returns `{jobId, cancelled}`; `cancelled:false` means the job had already finished or is unknown. It aborts child processes (build, boot, install, record). A cancelled job has status `cancelled` and no `result`. Side effects already applied are not rolled back, and a worker never overwrites a cancelled job's status.
- **Restarts**: jobs are persisted with the session. A job that was `running` when the server stopped is marked `failed` with `server restarted while job was running (child process gone)`.

### Cancellation

When a tool call is cancelled (MCP `notifications/cancelled`) or its job is cancelled with `qa_job_cancel`, the interrupted work returns `failureCode:"CANCELLED"` with `retrySafe:true`. A call's cancel signal applies to that call only: cancelling an interactive call does not cancel a running job, and the other way round.

`CANCELLED` is not a failure. It is never recorded as a tool error, a snapshot failure, a finding, or a health verdict, and it never switches the session to visual-fallback. Side effects that already happened are not rolled back: a cancelled `qa_act` always reports `changedState:true`, and a cancelled `qa_explore` stops with `stoppedReason:"cancelled"` and records no finding for the screen it was observing.

## Project root

Tools that need a project resolve it in this order; the first hit wins:

1. The `projectRoot` argument. It must be an absolute, existing directory. An invalid value is an error, never silently replaced.
2. MCP roots, when the client exposes a workspace. The first root with a project marker wins, else the first root that is not `/` or `$HOME`.
3. `SWIPIUM_PROJECT_ROOT` from the server environment.
4. `CLAUDE_PROJECT_DIR`, which Claude Code sets for stdio servers.
5. The server's working directory, but never `/` or `$HOME`, and only when it contains a project marker.

**Marker rule**: a directory is a project when it contains `package.json`, `app.json`, `pubspec.yaml`, `build.gradle(.kts)`, `settings.gradle(.kts)`, `Podfile`, an `.xcodeproj` or `.xcworkspace`, or an `android/` or `ios/` directory. Only the MCP-roots preference and the working-directory fallback check markers; the `projectRoot` argument and the two environment variables are trusted as given (absolute and existing).

When nothing resolves, tools fail with `PROJECT_ROOT_UNRESOLVED`: pass an absolute `projectRoot`, or set `SWIPIUM_PROJECT_ROOT` in the MCP server config's `env`. `qa_test_this` returns `PROJECT_ROOT_EMPTY` for an empty directory and `NOT_MOBILE_PROJECT` when no supported app is found there.

**`rootSource`**: results built from a freshly resolved root carry `projectRoot` and `rootSource` (`arg`, `mcp-roots`, `env:SWIPIUM_PROJECT_ROOT`, `env:CLAUDE_PROJECT_DIR`, or `cwd`). When the root came from the working directory, the text also says `project root taken from server cwd: <path>; pass projectRoot to override`. Calls that reuse a session's root do not re-resolve it and carry no `rootSource`.

## Consent

Privileged actions (build, boot, install, Metro start, data wipes, recordings, network changes, location spoofing, OCR, flow mutations, destructive exploration, remote WDA, writing into the project's test directory) are consent-gated. Nothing gated runs without approval.

### Mechanisms

- **Elicitation**: when the client supports MCP form elicitation, the server asks the user directly and the tool continues on approval. The model never sees a `consentId`. The prompt times out after 10 minutes.
- **Consent envelope** (client assertion): otherwise the tool returns `{requiresConsent:true, consentId, action, risk, explain, exactCommand, affects}`. The agent shows it to the user and, only after they agree, re-calls the same tool with the same arguments plus `consentId` and `approve:true`. Only `qa_test_this`'s envelope also carries `sessionId`, so its approving re-call reuses the session without `projectRoot`; for every other tool, re-call with the `sessionId` you already passed.
- **Policy**: with `SWIPIUM_REQUIRE_ELICITATION=1` in the server environment, a client that cannot elicit gets `CONSENT_REFUSED` for every gated action, before the model sees a `consentId`, so the envelope path cannot be used. The setting has no effect on clients that support elicitation.

How each action was approved (`elicitation`, `client-assertion`, or `policy`) is recorded in the report's [mutation ledger](#glossary).

### Outcomes

Nothing runs in any of these, and a `refused` row is written to the mutation ledger.

| Code | When | Retry-safe |
| --- | --- | --- |
| `CONSENT_DECLINED` | The user declined the prompt. | no |
| `CONSENT_CANCELLED` | The prompt was dismissed, timed out, failed in transport, or the call was aborted; also when the action changed while the user was deciding. Re-calling shows a fresh prompt. | yes |
| `CONSENT_REFUSED` | `SWIPIUM_REQUIRE_ELICITATION=1` is set and the client cannot elicit. | no |

Do not retry any of them without asking the user.

### Rules

- **Single use and binding**: a `consentId` works once, for the same action and targets it was issued for. A consent issued in a session works only in that session: an id from session A cannot approve a call in session B, and a replay from B does not use up A's consent. A mismatched action or target is refused without burning the id.
- **Lifetime**: a `consentId` expires 30 minutes after it is issued. At most 200 consents can be pending; beyond that the oldest is dropped.
- **Stale ids**: an unknown, used, or expired `consentId` is refused, never silently replaced. `qa_test_this` issues a new challenge and says so in `consentNote` (with `previousConsentId`).
- **Prompt sanitising**: the elicitation prompt quotes every repository-derived value (flow names, queries, URLs, commands) as JSON, strips control characters, newlines, line separators, zero-width and bidirectional characters, and caps each field (at most 4 command steps, 2000 characters overall), so repository content cannot fake extra prompt lines.
- **Unreviewed sources**: commands and URLs that come from the repository (seed commands, `.swipium/config.json` providers, a configured WDA URL) are labelled as repository-supplied and unreviewed.

### Consent actions and risk levels

| Action | Risk | Raised by |
| --- | --- | --- |
| `test_this_plan` | Highest of its steps: build high, external APK install medium, install from the project low, boot low | `qa_test_this` execute; `qa_test_feature` execute without a `sessionId` |
| `prepare_plan` | Medium for an external APK, else low | `qa_prepare_target` |
| `build_from_source` | High | `qa_build mode:"run"` |
| `install_app` | Medium (`qa_ios`, `qa_bundletool`); low or medium by path (`qa_prepare_ios_target`) | `qa_ios install`, `qa_bundletool install`, `qa_prepare_ios_target` |
| `erase_device` | High | `qa_ios erase` |
| `privacy_reset` | Low | `qa_ios privacy_reset` |
| `wda_build`, `wda_start` | Medium | `qa_wda` |
| `wda_non_loopback` | Medium | `qa_wda` with a remote URL |
| `app_clear_data`, `app_fresh_start` | High | `qa_app_control` |
| `start_metro` | Medium | `qa_metro start` |
| `network_change` | Medium | `qa_network`, `qa_mobile_audit` (resilience, release_gate) |
| `geo_set` | Medium | `qa_geolocation` |
| `screen_record` | Medium | `qa_screen_record start` |
| `ocr_run` | Medium | `qa_visual find_text` |
| `flow_mutation_run` | High for script seeds, else medium | `qa_flow_run` |
| `destructive_ui_candidate` | High | `qa_explore safeMode:"approved_destructive_candidate"` |
| `suite_fresh_state_replay` | Highest of its prepare and teardown steps | `qa_generate target:"suite" replay:"fresh_state"` |
| `automation_project_write` | Medium | `qa_generate target:"appium" integrateIntoProject:true` |

Booting a simulator with `qa_ios boot` is not gated (low-risk and reversible). Inside `qa_test_this` and `qa_prepare_target`, a boot is one step of the combined consent.

## Secrets and redaction

### What becomes a secret

- Text typed into a secure field (a password field, or a field whose label or id reads like password, OTP, PIN, CVV, card number, secret, token, or security code). This applies to native-selector typing too.
- Values answered through `qa_continue_from_blocker` whose field names match the credential-name rule below, plus any field listed in `secretFields` (which adds to the rule; it does not replace it).
- Resolved flow variables and `${SWIPIUM_*}` values from the environment whose names match the credential-name rule: a case-insensitive substring match on `pass`, `secret`, `token`, `otp`, `pin`, `cvv`, `key`, or `code` (so `SWIPIUM_VERIFICATION_CODE` is a secret).
- Fixture field values read from the environment (`fields.<name>.var`).
- A typed value that equals or contains a value already registered as a secret, even in an ordinary text field.

### How redaction works

- Registered secrets are scrubbed from tool text, structured results, persisted state, reports, text artifacts, OCR text, and provider `stderr`. JSON- and XML-escaped spellings are matched too.
- Values of 4 or more characters are matched anywhere. A 3-character value, or an all-digit value shorter than 8 characters, is matched only as a standalone token, so a PIN does not scrub unrelated numbers.
- **Values shorter than 3 characters are not scrubbed.** A text artifact written while such a secret was registered reports `redaction:"partial"` with a `redactionNote`; other artifacts report `applied`, and binary files `not-applied`.
- **Screenshots and recordings are pixels and are never redacted.** `qa_screenshot` and `qa_visual` withhold captures while a password or OTP field is on screen (`CAPTURE_WITHHELD_SECURE`, unless `force:true`).
- `qa_act type` never echoes the typed value. `redacted:true` and `secret:true` appear only when the value was treated as a secret; ordinary text omits both, and the recorded step keeps the text, so a generated suite contains it.
- **Placeholders in `qa_act`**: `${SWIPIUM_*}` names are expanded (only that prefix), from session inputs first, then the server environment. The value is typed but never echoed (`placeholders` lists the names), and the action is recorded with the placeholder. A typed literal that equals a stored session input is recorded as that input's placeholder. An unresolvable placeholder returns `MISSING_TEST_DATA` before anything is tapped.

### Environment access

Flows, fixture `fields.var`, and `qa_act` placeholders read the server environment only for `SWIPIUM_*` names. Other names are never read (flows fail the step with `MISSING_FIXTURE`; fixtures log a warning). Pass other values explicitly (`qa_flow_run variables`) or rename them. See [Flows: variables](flows.md#variables).

### Generated output

Every `qa_generate` target, `qa_suite_generate`, and the persisted state rewrite recorded secrets into environment placeholders at emit time, marked as needing human data. The placeholder is `SWIPIUM_TEST_PASSWORD`, `SWIPIUM_TEST_OTP`, `SWIPIUM_TEST_TOKEN`, or `SWIPIUM_TEST_PIN` by field kind, else `SWIPIUM_SECRET_<n>`. An existing `${VAR}` is kept, prefixed with `SWIPIUM_` when needed.

Form data that `qa_explore` generates is recorded under `SWIPIUM_TEST_EMAIL`, `SWIPIUM_TEST_PASSWORD`, or `SWIPIUM_TEST_OTP`, else `SWIPIUM_GEN_<FIELD>` (a username is `SWIPIUM_GEN_USERNAME`). `qa_first_run` uses the same names, except that a username is `SWIPIUM_TEST_USERNAME`.

Registered secret values never reach `test-suite.json`, `TC-*.yaml`, or `state.json`. A final guard scans the output against the session's registered values (not only name heuristics); if one would still be written, generation fails with `SECRET_IN_GENERATED_OUTPUT` and nothing is written.

### Sensitive sessions

`qa_start_session {sensitive:true}` refuses every screenshot, recording, log capture, and other on-screen evidence (`SENSITIVE_MODE_REFUSED`). Sensitive sessions are never listed as MCP resources.

## iOS modes

Swipium drives iOS Simulators in one of two modes.

| Mode | When | What works |
| --- | --- | --- |
| **Structured (WDA)** | WebDriverAgent is reachable and attached. | `qa_snapshot`, `qa_act` by `@eN` ref, text, id, or native selector (`accessibility id`, `name`, `predicate string`, `class chain`), structured flows. |
| **Visual-only** | No reachable WDA. | `qa_screenshot`, `qa_visual` (assert, baseline, diff, OCR, image find), coordinate taps through `idb` when it is installed, flows in `mode: visual` or `auto`. `qa_snapshot`, `qa_act`, and structured flows return `BACKEND_UNSUPPORTED`. |

`qa_test_this` and `qa_prepare_ios_target` (`attachWda:"auto"`) fall back to visual-only automatically, with a recorded workaround, unless WDA was explicitly required. `qa_orientation`, `qa_geolocation`, and `qa_network` are not available on iOS in either mode.

- **Artifacts**: only simulator `.app` bundles install. A `.ipa` targets a real device and is refused with `IPA_NEEDS_REAL_DEVICE`.
- **Session capabilities**: every WDA session created for an app sends `shouldTerminateApp:false` (unless `ios.wda.capabilities` in `.swipium/config.json` sets it), because WDA tears down the previous session with that session's setting. Re-binding a resumed session after a restart, and recovering from an invalid-session error, also send `forceAppLaunch:false`, so the running app is reused; the latter adds a warning to verify the screen state.
- **Managed WDA lifetime**: `qa_wda start` spawns WDA (`xcodebuild test-without-building`) and records it in `~/.swipium/processes.json`; `qa_wda stop` terminates it, including one adopted from a previous server run. A normal server shutdown does not stop managed WDA, so a resumed iOS session can keep using it.
- **Adoption at startup**: a managed WDA from a previous run is adopted only when it is less than 12 hours old (from its original start) and `GET /status` reports ready; older or unhealthy ones are stopped, as are orphaned Metro bundlers and screen recorders. Orphaned emulators are adopted and left running. A process owned by another running Swipium server is never touched. Each registered process records its start time and full command line, and an orphan is signalled or adopted only when both still match, so a recycled pid is never touched. The startup sweep runs in the background after the server connects.
- **Remote WDA rule**: loopback means `localhost`, `127.0.0.0/8`, or `[::1]`. A non-loopback `webDriverAgentUrl` needs `allowNonLoopback:true` plus the `wda_non_loopback` consent, otherwise `DESTRUCTIVE_REFUSED`. The only pre-approval is user-level: `SWIPIUM_ALLOW_REMOTE_WDA`, a comma-separated list of exact WDA base URLs in the MCP server's environment. The repository's `.swipium/config.json` cannot pre-approve one: `ios.wda.allowNonLoopbackUrls` only adds a note, and a non-loopback `ios.wda.url` is labelled "configured by the repository (.swipium/config.json) — unreviewed" in the prompt. `qa_prepare_ios_target` and `qa_test_this` never connect to a non-loopback configured URL on their own.

## Devices

Swipium drives Android Emulators and iOS Simulators on the local machine. Physical devices are out of scope ([physical-devices.md](physical-devices.md)).

### Physical devices

A connected phone is refused with `PHYSICAL_DEVICE_UNSUPPORTED` only when:

- it is requested explicitly (its serial or UDID as `device`),
- it is the only option (no emulator online, no AVD to boot, and it is the only device on the chosen platform), or
- `preferRealDevice` is set and a phone is visible.

Otherwise target selection (`qa_resolve_target`, `qa_test_this`) picks an emulator or simulator and only mentions the phone in the selection `reason` (for example `Physical device <serial> is visible but out of scope`). Two exceptions: `qa_test_this` refuses `preferRealDevice:true` even when no phone is visible, and refuses an artifact that installs only on a real iOS device; and `qa_prepare_target` acts on the online device rather than planning: a phone that is the only online device is refused, and with more than one device online (a phone included) and no `device` it returns `MULTIPLE_DEVICES`, so pass the emulator's serial. `qa_test_this` is the path that boots an AVD while a phone is connected.

### Android

- **Emulator detection**: an `emulator-NNNN` serial is an emulator. Any other serial, such as an adb-over-TCP `localhost:5555` or `127.0.0.1:<port>`, counts as an emulator only when one `getprop` probe shows an emulator (`ro.kernel.qemu=1`, `ro.boot.qemu=1`, a goldfish or ranchu `ro.hardware`, or Genymotion). When a session binds a device whose properties cannot be read, it is refused as `DEVICE_NOT_READY`; if they show real hardware, `PHYSICAL_DEVICE_UNSUPPORTED`.
- **Booting**: when an AVD must be booted (headless by default), Swipium records the serials online before the boot and uses only a new serial that is a verified emulator, then waits for `sys.boot_completed` (up to 180 s). So when a phone is connected and an AVD exists, it boots the AVD and installs only on the new emulator. A boot that never comes up is `EMULATOR_BOOT_FAILED`; an online device that never finishes booting is `DEVICE_NOT_READY`.
- **Several devices**: with more than one device online (phones count) and no `device` argument, `qa_prepare_target` returns `MULTIPLE_DEVICES` with the online serials.
- **Binding**: a session is only re-bound to its own device. An offline device is never replaced by a different online one.
- **Toolchain**: a missing `adb` is `ADB_NOT_FOUND` from `qa_test_this`. `qa_network` needs Android 11+.

### iOS Simulator

See [iOS modes](#ios-modes). `qa_ios` and `qa_prepare_ios_target` pick a simulator by UDID or name substring; `qa_wda attach` refuses to guess (`MULTIPLE_DEVICES`) when no device is given and none is bound to the session.

## Glossary

| Term | Meaning |
| --- | --- |
| **`@eN` ref** | A handle such as `@e3` for one element of the latest `qa_snapshot`. Refs are invalid after navigation; an old one returns `STALE_REF`. |
| **App map** | Swipium's durable memory of the app in `.swipium/app-map.json`: features, screens, navigation, tests, and a code index, each with provenance. Built by `qa_app_map_build` and updated by runs. |
| **Approval mechanism** | How a consent was decided: `elicitation` (a real user prompt), `client-assertion` (the client re-called with `consentId` and `approve:true`), or `policy` (refused by `SWIPIUM_REQUIRE_ELICITATION=1`). Recorded in the mutation ledger. |
| **Budget** | A session's limits on time, actions, screenshots, consecutive snapshot failures, and no-change actions. A spent budget returns `{ok:true, stopped:true, reason}`. |
| **Canonical suite** | The durable, curated test-case catalog in `.swipium/test-suite.json`, managed by the `qa_suite_*` tools. Unlike per-run assets, it grows across runs. |
| **Capability group** | One of the groups the tools are organised into (start, setup, build, device, drive, run, app-map, feature, flows, generate, test-suite, issues, first-run). `qa_status` without a session returns them. |
| **Consent** | A user approval for one privileged action. See [Consent](#consent). |
| **Failure bucket** | How to triage a failure code: `app_bug`, `environment`, `missing_data`, `mcp_limitation`, or `unsafe_refused`. |
| **Failure owner** | Who fixes a failure: `app`, `environment`, `swipium`, or `user`. Independent of the bucket; `qa_explain_blocker` returns both. |
| **Finding** | A deterministic health observation (crash, ANR, error boundary, wrong foreground app, …) recorded in the session and report. |
| **Fixture** | A declared precondition (test account, saved record, disposable data), from `qa_start_session` or `.swipium/fixtures.json`. Unmet fixtures make a workflow blocked instead of failed. |
| **Flow** | A replayable YAML script of steps under `.swipium/flows/`. See [Flows](flows.md). |
| **Flow V2** | The current flow format: selector-bound input, visual steps, device-relative gestures, waits, setup and teardown, and `structured`, `visual`, or `auto` mode. |
| **Job** | A background operation with a `jobId`, polled with `qa_job_status`. See [Jobs](#jobs). |
| **Mutation ledger** | The report's audit trail of every state-changing action: tool, action, risk, target, consent (with its approval mechanism), and status (`requested`, `approved`, `executed`, `refused`, `blocked`, or `restored`). |
| **Pack** | A YAML list of flows run together, under `.swipium/packs/`. |
| **POM suite** | A generated page-object-model suite (page objects plus suites under `.swipium/`) that compiles into runnable flows. Produced by `qa_generate target:"suite"`. |
| **Response mode** | `compact`, `normal`, or `verbose`: how much of a result is repeated in the text channel. See [Response modes](tools.md#response-modes). |
| **Sensitive session** | A session started with `sensitive:true`; it refuses all pixel, video, and log capture. |
| **Stale client** | A client still running a pre-upgrade tool list; removed calls return `STALE_CLIENT`. |
| **Visual-fallback** | A per-screen switch to screenshot-based work after repeated failed UI-tree dumps (`VISUAL_ONLY_SCREEN`). The next successful structured observation switches back. |
| **Visual-only** | An iOS session without WDA. See [iOS modes](#ios-modes). |
| **WDA** | WebDriverAgent, the on-simulator automation server Appium uses. It gives iOS a UI tree. |
| **Workaround** | A safe fallback Swipium chose on its own (for example visual-only iOS), listed in the report. |
