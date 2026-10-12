# Concepts

The ideas that cut across Swipium's tools: sessions and jobs, how the project root is found, consent, secret handling, how Swipium reads the screen (refs and settling), iOS modes, and device policy. Per-tool parameters and failure codes are in the [Tool Reference](tools.md); flow files are in [Flows](flows.md); environment variables are in the [README](../README.md#configuration--environment-variables).

**Contents**: [Sessions and jobs](#sessions-and-jobs) · [Project root](#project-root) · [Consent](#consent) · [Secrets and redaction](#secrets-and-redaction) · [Screens, refs, and settling](#screens-refs-and-settling) · [iOS modes](#ios-modes) · [Devices](#devices) · [Glossary](#glossary)

## Sessions and jobs

### Sessions

A session holds one run's device, app, budget, recorded actions, findings, notes, and evidence. `qa_test_this` creates its own; the low-level tools need one from `qa_start_session`. Every tool that takes a `sessionId` returns `INVALID_ARGUMENT` (`Unknown sessionId "…"`) for an unknown id, with nothing run.

- **Location**: each session lives in `~/.swipium/runs/<project-hash>/<sessionId>/`, with `state.json` and artifact folders inside. Files are written atomically with mode 0600 (directories 0700), as compact JSON. `state.json` keeps the newest 500 artifacts, findings, and notes, plus total `counts`. `~/.swipium/registry.json` lists about 200 reloadable sessions. Over that cap the least recently used ones drop out, but never one owned by a server that is still running; an id that fell out is still reloaded from its `runs/` directory for as long as retention keeps it. The shared state files (`registry.json`, `projects.json`, `processes.json`) are also 0600, inside a `~/.swipium` that is 0700; files written by older versions get the mode on their next write.
- **What is persisted**: notes, findings, tool errors, jobs, environment changes, and mutations, all redacted with the session's secrets before writing. Recorded actions are persisted in their secret-safe form (see [Secrets and redaction](#secrets-and-redaction)). For fixtures only metadata is written: fixture values, field values, and seed specs never are, and secret generated values are stored as `<redacted>`.
- **What is never persisted**: secret values and the values of supplied inputs (credentials, OTPs). They live in memory only, so after a server restart a login run asks for them again even though the stored metadata still lists them.
- **Budget**: 30 minutes, 60 actions and 40 screenshots by default (8 minutes, 20 actions and 8 screenshots before 2.3.0), plus 3 consecutive snapshot failures and 3 no-change actions. Everything that runs on the device counts, including the smoke, saved-flow replays and exploration inside `qa_test_this`. A session keeps the budget it was created with. Set your own with `qa_start_session {budget}` ([details](tools.md#qa_start_session)).
- **Rehydration**: after a restart, a session reloads on first use. The device, app id, `driverKind`, `wdaUrl`, jobs, artifacts, findings, notes, and mutations are restored. The device is re-attached with the saved driver kind (WDA when the session had attached it and it is still reachable); an offline device is never replaced by a different one. An Android emulator Swipium booted or bound for the session is remembered with its AVD, so `qa_prepare_target` and `qa_test_this` boot that same AVD again; when its AVD is unknown they return `DEVICE_NOT_READY` or `NO_DEVICE` instead of picking another one. Fixtures are re-read from `.swipium/fixtures.json`, which supplies the live values. A fixture that was passed inline to `qa_start_session` and is not in that file comes back as metadata only, **without its `value`, field values, or `seed`**; re-declare it (or add it to `fixtures.json`) if a run needs them. If the old state shows secret activity, the session is flagged `redactionDegraded`, because the secret set cannot be rebuilt.
- **Retention**: at startup, session directories are pruned when all of these hold: last activity older than `SWIPIUM_RETENTION_DAYS` (default 30; `0` or `off` disables the automatic prune), not in the registry, not live in this process, and not among the newest `SWIPIUM_RETENTION_KEEP` (default 20) sessions of that project. The keep-newest rule applies only while the project's root still exists (read from the newest sessions' `state.json`; when it can't be read, the sessions are kept), so sessions of deleted roots, such as temporary directories, age out by days alone. The startup prune runs in the background with a 2 s budget, starting at a random project, so a large backlog clears over a few starts. It fails closed: when `registry.json` exists but cannot be read or parsed, nothing is deleted. `swipium gc` applies the same rule on demand, without the time budget.
- **Artifacts** are addressed as `swipium://session/{sessionId}/{kind}/{name}` and read with `qa_get_artifact` or as MCP resources.

### Jobs

Long operations run as background jobs and return a `jobId` at once: `qa_test_this` and `qa_test_feature` in `execute` (their default) or `interactive` mode, `qa_explore`, `qa_build` in `run` mode, `qa_bundletool`, `qa_wda build` and `setup`, the boot and install steps of `qa_prepare_target`, and the rest of a `qa_prepare_ios_target` whose simulator is still booting after 30 s. Every call that waits (a long-poll, `qa_wait`, `waitForCompletion`) returns within about 50 s by default, so it fits common client tool timeouts. For clients with longer timeouts, `SWIPIUM_MAX_WAIT_MS` raises the `qa_job_status`, `qa_test_this`, and `qa_wait` cap ([details](mcp-server.md#every-call-returns-within-about-50-s)).

The usual loop:

1. `qa_test_this {waitForCompletion:true}` (`mode` defaults to `"execute"`; after any consent) waits for the run and returns the terminal result, or `{sessionId, jobId, state:"running"}` when the run takes longer.
2. While the state is `running`: `qa_job_status {sessionId, jobId, waitMs:45000}` until `status` is no longer `running`.
3. On `result.state:"completed"`, the result already carries `reportHead`; for more, read `report.md` with `qa_get_artifact {uri: result.reportMdUri}` (the call in `nextRecommendedAction`). On `blocked` or `unsafe`, `nextRecommendedAction` is the blocker's fix, or `null` when the fix is outside Swipium.

**Job status and result state are different fields.**

| Field | Values | Meaning |
| --- | --- | --- |
| `status` (every job) | `running`, `done`, `failed`, `cancelled` | Where the job is. |
| `result.state` (`qa_test_this` jobs) | `completed`, `blocked`, `unsafe`, `needs_input` | How the run ended. `completed` and `needs_input` end the job `done`; `blocked` and `unsafe` end it `failed`. The envelope is in `result` either way. |

- **needs_input**: there is no `needs_input` job status. A job that stops on a question ends `done` with `result.state:"needs_input"`. `qa_test_this` can also return `state:"needs_input"` **directly, with no `jobId`**: in `interactive` mode, or with `stopOnNeedsInput` or `goal:"test_login"`, the credentials question is asked before any job starts when the project likely has a login and no credentials are available. Either way, relay the one question and make the returned resume call (`qa_continue_from_blocker`). On a prepared session that needs no new consent, it starts the resumed run itself and returns its `jobId`.
- **Polling**: `qa_job_status {sessionId, jobId, waitMs}` returns `{jobId, kind, status, progress, progressDetail, error, result, artifactUris}`. `waitMs` (default 0, use 45000; larger values are clamped to `SWIPIUM_MAX_WAIT_MS`, default 50000) long-polls: the call returns as soon as the job leaves `running` and adds `waited:{waitedMs, timedOut}`. A request with a `progressToken` gets MCP `notifications/progress` while it waits. An unknown `jobId` is `INVALID_ARGUMENT`.
- **Blocking instead of polling**: `qa_test_this {waitForCompletion:true}` waits up to `timeoutMs` (default: the cap minus 5000, so 45000; larger values are clamped to `SWIPIUM_MAX_WAIT_MS`, default 50000) and returns the terminal result directly, or `state:"running"` with `timedOutWaiting:true`.
- **Cancelling**: `qa_job_cancel {sessionId, jobId}` returns `{jobId, cancelled}`; `cancelled:false` means the job had already finished or is unknown. It aborts child processes (build, boot, install, record). A cancelled job has status `cancelled` and no `result`. Side effects already applied are not rolled back, and a worker never overwrites a cancelled job's status.
- **Restarts**: jobs are persisted with the session. A job that was `running` when the server stopped is marked `failed` with `server restarted while job was running (child process gone)`.

### Cancellation

When a tool call is cancelled (MCP `notifications/cancelled`) or its job is cancelled with `qa_job_cancel`, the interrupted work returns `failureCode:"CANCELLED"` with `retrySafe:true`. Cancelling a call stops its waits and child processes right away (element waits, UI settling, boot and WDA startup waits, a `qa_job_status` long-poll), not at their deadline. A call's cancel signal applies to that call only: cancelling an interactive call does not cancel a running job, and the other way round. When the server shuts down (the client closed stdin, or a signal), it cancels every running job first.

`CANCELLED` is not a failure. It is never recorded as a tool error, a snapshot failure, a finding, or a health verdict, and it never switches the session to visual-fallback. Side effects that already happened are not rolled back: a cancelled `qa_act` always reports `changedState:true`, and a cancelled `qa_explore` stops with `stoppedReason:"cancelled"` and records no finding for the screen it was observing.

## Project root

Tools that need a project resolve it in this order; the first hit wins:

1. The `projectRoot` argument. It must be an absolute, existing directory, and not `/` (or a drive root), your home directory, or a shared system or user folder that holds other apps, caches or downloads (the list under "Testing a prebuilt build" below, plus `~/Library`, `~/Downloads` and `~/Desktop`; a subdirectory of one is fine). Those are refused at once, before any directory walk. The path is normalized first, so a trailing `/` or a `..` segment names the same root. An invalid value is `PROJECT_ROOT_UNRESOLVED`, never silently replaced.
2. MCP roots, when the client exposes a workspace. The first root with a project marker wins, else the first root that is not `/` or `$HOME`. Only on 2025-era connections: MCP 2026-07-28 deprecates roots and has no server-to-client `roots/list`, so 2026 clients go straight to the next steps (pass `projectRoot`, or set `SWIPIUM_PROJECT_ROOT`; Claude Code is covered by `CLAUDE_PROJECT_DIR`).
3. `SWIPIUM_PROJECT_ROOT` from the server environment.
4. `CLAUDE_PROJECT_DIR`, which Claude Code sets for stdio servers.

   Either variable is skipped when it is not absolute, does not exist, or is `/` or your home directory, and the `PROJECT_ROOT_UNRESOLVED` hint says which one was skipped and why.
5. The server's working directory, but never `/` or `$HOME`, and only when it contains a project marker.

**Marker rule**: a directory is a project when it contains `package.json`, `app.json`, `pubspec.yaml`, `build.gradle(.kts)`, `settings.gradle(.kts)`, `Podfile`, an `.xcodeproj` or `.xcworkspace`, or an `android/` or `ios/` directory. Only the MCP-roots preference and the working-directory fallback check markers; the `projectRoot` argument and the two environment variables are trusted as given (absolute, existing, and not `/` or the home directory).

When nothing resolves, tools fail with `PROJECT_ROOT_UNRESOLVED`: pass an absolute `projectRoot`, or set `SWIPIUM_PROJECT_ROOT` in the MCP server config's `env`. A session from `qa_start_session` does not become the default root; pass its `sessionId` on later calls. `qa_doctor` shows which root calls without `projectRoot` would use (its `project-root` row). `qa_test_this` returns `PROJECT_ROOT_EMPTY` for an empty directory and `NOT_MOBILE_PROJECT` when no supported app is found there.

**Testing a prebuilt build**: to test an app without its source, put the simulator `.app` or the `.apk` in a directory and pass that directory as `projectRoot`. When Swipium finds no project there but can read the app id of an artifact at most 2 directories below the root, `qa_test_this` tests the artifact as it is (with a workaround note), and `swipium scan` reports it (naming the artifact) instead of "Could not identify a mobile project". A shared system directory (`/`, your home or its parent, `/tmp`, `/private`, `/private/tmp`, `/private/var`, `/var`, `/var/tmp`, `/Users`, `/home`, `/Volumes`, `/opt`, `/usr`, `/Library`, `/Applications`, `/System`, and your `~/Library`, `~/Downloads` and `~/Desktop`) never counts as a prebuilt-only root, so a stray build somewhere below it gives `NOT_MOBILE_PROJECT`; as an explicit `projectRoot` it is refused (step 1). Only an artifact within those 2 directories is installed, never a deeper build the search also finds, and XCTest and WebDriverAgent runner bundles (`WebDriverAgentRunner-Runner.app`, `*.xctrunner`) are never taken as the app under test (Flutter's plain `Runner.app` still is).

**Artifact search**: the search for installable builds under the root stops after 20,000 directories or 10 s, with a warning that it stopped early.

**`rootSource`**: results built from a freshly resolved root carry `projectRoot` and `rootSource` (`arg`, `mcp-roots`, `env:SWIPIUM_PROJECT_ROOT`, `env:CLAUDE_PROJECT_DIR`, or `cwd`). When the root came from the working directory, the text also says `project root taken from server cwd: <path>; pass projectRoot to override`. Calls that reuse a session's root do not re-resolve it and carry no `rootSource`.

## Consent

Privileged actions (build, boot, install, Metro start, data wipes, recordings, network changes, location spoofing, OCR, flow mutations, destructive exploration, remote WDA, writing into the project's test directory) are consent-gated. Nothing gated runs without approval.

### How an action gets approved

Swipium checks these in order for every gated call:

1. **Operator pre-approval**: if the action is listed in `SWIPIUM_CONSENT_PREAPPROVE` (and its tier allows it), it runs without a prompt, on any client. See [Operator pre-approval](#operator-pre-approval).

   An explicit decline comes first: a re-call with `{consentId, approve:false}` for a consent still pending in that session returns `CONSENT_DECLINED` and runs nothing (see [Rules](#rules)).
2. **Elicitation**: when the client supports MCP form elicitation, the server asks the user directly and the tool continues on approval. The model never sees a `consentId`, and the prompt times out after 10 minutes. How the prompt travels depends on the protocol era ([mcp-server.md](mcp-server.md#protocol-versions)):
   - MCP 2025-06-18 / 2025-11-25 (`initialize`): an `elicitation/create` request while the tool call waits.
   - MCP 2026-07-28 (`server/discover`): the tool call answers with an `InputRequiredResult` carrying the same one-checkbox form, and the client retries the call with the user's answer. Swipium sends it only when the request's `_meta` client capabilities declare form elicitation. The `requestState` in that result is an opaque single-use handle: Swipium keeps what it stands for (the consent, the tool, a digest of the arguments, the session) on its side, so an answer can't be replayed or moved to another call. A retry without an answer gets the same prompt again.
3. **Consent envelope** (client assertion): otherwise the tool returns `{requiresConsent:true, consentId, action, risk, explain, exactCommand, affects}`. The agent shows it to the user and, only after they agree, re-calls the same tool with the same arguments plus `consentId` and `approve:true`. Only `qa_test_this`'s envelope also carries `sessionId`, so its approving re-call reuses the session without `projectRoot`; for every other tool, re-call with the `sessionId` you already passed.

With `SWIPIUM_REQUIRE_ELICITATION=1` in the server environment, step 3 is closed: a client that can't elicit gets `CONSENT_REFUSED` for every gated action, before the model sees a `consentId`. The setting has no effect on clients that support elicitation, and it doesn't block operator pre-approval.

How each action was approved (`elicitation`, `client-assertion`, `operator-policy`, or `policy` for a refusal) is recorded in the report's [mutation ledger](#glossary). `elicitation` covers both protocol eras.

### Operator pre-approval

Headless clients (`codex exec`, `claude -p`) advertise elicitation but decline or cancel every prompt automatically, so no gated action can run there. `SWIPIUM_CONSENT_PREAPPROVE` is the operator's way out: a comma-separated list of exact action names that are approved without a prompt.

- **Where it's read**: only from the server process environment. That is whatever the MCP client passes to the server (its config `env`) plus anything inherited from the shell that launched the client. For Codex, set it literally in the `env` table of `[mcp_servers.swipium]`; it is never forwarded by default ([setup](mcp-server.md#headless-runs)). It is never read from `.swipium/` or any repository file, so neither the model nor a cloned project can grant it.
- **Exact names only**: no wildcards or risk thresholds. Unknown names are ignored with one warning on stderr at startup, with a suggestion for near misses (`INSTALL-APP`: did you mean `install_app`?).
- **Action names**: `app_clear_data`, `app_fresh_start`, `automation_project_write`, `build_from_source`, `destructive_ui_candidate`, `erase_device`, `flow_mutation_run`, `geo_set`, `install_app`, `network_change`, `ocr_run`, `prepare_plan` (boots and installs planned by `qa_prepare_target`), `privacy_reset`, `screen_record`, `start_metro`, `suite_fresh_state_replay`, `test_this_plan`, `wda_build`, `wda_start`.
- **Actions that run code** need `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1` as well, or they are ignored with a startup warning: `build_from_source` (repository build scripts), `flow_mutation_run` (fixture seed scripts, external OCR providers, `openUrl` with variables), `ocr_run` (the configured OCR and mask commands), `start_metro` (`npx expo start` / `npx react-native start`, which load the project's Metro and Babel config), `suite_fresh_state_replay` (state-profile seed scripts), `wda_build` and `wda_start` (`xcodebuild` on a model-chosen `wdaProjectPath`). These run repository- or model-chosen code with your privileges; under `codex exec` they run outside the client's sandbox. Set the opt-in only for repositories you trust.
- **`test_this_plan`** bundles sub-steps. Pre-approving it doesn't cover a sub-step that runs code: a plan that includes a `build_from_source` step is approved without a prompt only if `build_from_source` is also listed and `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1` is set. Otherwise the plan is prompted for as usual.
- **`wda_non_loopback`** can never be pre-approved by name. List the exact URL in `SWIPIUM_ALLOW_REMOTE_WDA` instead ([Remote WDA rule](#ios-modes)).
- **`swipium init claude --trust-local`** writes this variable into a machine-local Claude Code registration (`--scope local` or `user`; it refuses `--scope project`, the team-shared `.mcp.json`). It lists every action that runs no repository- or model-chosen code and can be pre-approved by name, except `destructive_ui_candidate`, so boots, installs, data wipes, network and location changes, and screen recordings stop prompting, while builds, Metro, WebDriverAgent, seed scripts, OCR commands, and destructive UI taps (which act on the app's backend) still ask. `init` prints the exact list.
- **Not device-scoped**: a pre-approved action is approved for whatever device the planner picks. Set `SWIPIUM_DEVICE` as well on a shared runner or a machine with several emulators: then every plan targets the pinned device, and a call naming another device is refused with `DEVICE_PINNED`, so the pre-approval can only ever apply to that device (see [Device pin](#device-pin)).
- **Still audited**: a pre-approved challenge is still single-use and session-bound, and each approval is logged on stderr at `warn` (visible with `SWIPIUM_LOG_LEVEL=warn`) with the action and its exact command (or a short hash and the first 200 characters).

### Outcomes

Nothing runs in any of these, and a `refused` row is written to the mutation ledger.

| Code | When | Retry-safe |
| --- | --- | --- |
| `CONSENT_DECLINED` | The user declined the prompt, or the agent re-called with `approve:false` (the challenge is burned). | no |
| `CONSENT_CANCELLED` | The prompt was dismissed, timed out, failed in transport, or the call was aborted; also when the action changed while the user was deciding. Re-calling shows a fresh prompt. | yes |
| `CONSENT_REFUSED` | `SWIPIUM_REQUIRE_ELICITATION=1` is set and the client cannot elicit. | no |

Do not retry any of them without asking the user. Every consent refusal carries `sessionId` when the call had or created a session (`qa_test_this` creates one before it asks), so `qa_note` and `qa_report` still work on it. `CONSENT_DECLINED` and `CONSENT_CANCELLED` carry the `action` name, `answeredInMs`, and `likelyAutomatic` (answered in under 1.5 s, so probably no human saw it). Only when `likelyAutomatic` is true do they add a hint naming the [operator setting](#operator-pre-approval) that can pre-approve the action, tell the agent not to re-call in a loop, and say that approving in chat and re-calling won't work in that client; a real human decline is never nudged toward pre-approval. When the prompt itself failed (timeout, transport error, aborted call), `likelyAutomatic` is false, `elicitationFailure` says why, and the ledger row's detail starts with `transport/abort`.

### Rules

- **Single use and binding**: a `consentId` works once, for the same action and targets it was issued for. Device actions name the device in the prompt and carry it in `affects` (`adb -s <serial> install …`, `xcrun simctl install <udid> …`), so an approval is bound to that device. A consent issued in a session works only in that session: an id from session A cannot approve a call in session B, and a replay from B does not use up A's consent. A mismatched action or target is refused without burning the id.
- **Lifetime**: a `consentId` expires 30 minutes after it is issued. At most 200 consents can be pending; beyond that the oldest is dropped.
- **Stale ids**: an unknown, used, or expired `consentId` is refused, never silently replaced. Every tool then issues a new challenge and says why the old id was not applied, in `consentNote` (with `previousConsentId`) and a `⚠️ consent <id> not applied (…); new challenge issued.` line.
- **Answers**: `approve:true` runs the action once. `approve:false` is a decline: `CONSENT_DECLINED`, nothing runs, and a `refused` row is ledgered. A re-call that carries the `consentId` without `approve` does not use it up: the challenge stays pending.
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
| `flow_mutation_run` | High with a script seed; medium with another seed, a network toggle, a variable `openUrl`, or an OCR provider; low when `restartApp` is the only mutating step | `qa_flow_run` |
| `destructive_ui_candidate` | High | `qa_explore safeMode:"approved_destructive_candidate"` |
| `suite_fresh_state_replay` | Highest of its prepare and teardown steps | `qa_generate target:"suite" replay:"fresh_state"` |
| `automation_project_write` | Medium | `qa_generate target:"appium" integrateIntoProject:true` |

Booting a simulator with `qa_ios boot` is not gated (low-risk and reversible). Inside `qa_test_this` and `qa_prepare_target`, a boot is one step of the combined consent.

## Secrets and redaction

### What becomes a secret

- Text typed into a secure field. A field is secure when it is a password field (`password="true"` on Android, a `SecureTextField` on iOS), or an input field (text field, search field, text view) whose label or id reads like password, OTP, PIN, CVV, card number, secret, token, or security code. Buttons, rows, and labels are never secure, so a "Passwords" settings row or app icon doesn't withhold screenshots. This applies to native-selector typing too.
- Values answered through `qa_continue_from_blocker` whose field names match the credential-name rule below, plus any field listed in `secretFields` (which adds to the rule; it does not replace it).
- Resolved flow variables and `${SWIPIUM_*}` values from the environment whose names match the credential-name rule: a case-insensitive substring match on `pass`, `secret`, `token`, `otp`, `pin`, `cvv`, `key`, or `code` (so `SWIPIUM_VERIFICATION_CODE` is a secret).
- Fixture field values read from the environment (`fields.<name>.var`).
- A typed value that equals or contains a value already registered as a secret, even in an ordinary text field.

### How redaction works

- Registered secrets are scrubbed from tool text, structured results, persisted state, reports, text artifacts, OCR text, and provider `stderr`. JSON- and XML-escaped spellings are matched too.
- Log artifacts (logcat, Metro, WDA, and other files in a session's `logs/` folder) are also scrubbed of credential-looking values that were never registered: `Bearer` and `Basic` tokens, JWTs, `password=`, `token:`, `api_key=`-style pairs, and AWS, Google, Stripe, GitHub, and Slack key formats. The live log Metro writes itself is not covered.
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

## Screens, refs, and settling

Swipium reads the screen as a UI tree (Android `uiautomator`, iOS WebDriverAgent page source), turns it into compact elements, and addresses each one with an `@eN` ref.

- **Stable refs**: an element keeps its ref across snapshots while it stays on screen and moves at most 64 px, matched by class, resource id, text and label, its parent, and its position among equal siblings (and its bounds). A row whose label sits in a child view must also still show the same label. An element whose own text changes in place keeps its ref only when it has an id, and a text field keeps its ref while its value or label changes as you type. Anything else gets a new number: a scroll of more than 64 px gives the moved rows new refs. Numbers only grow (expect `@e300` after a few screens) and are not reused until the session's refs are reset (a rebind or `clear_data`), so a ref never silently points at a different element.
- **Stale refs**: `qa_act` trusts a ref when its snapshot is at most 1.5 s old and no action ran since. On Android, an older ref with no action since is also trusted when one raw screenshot (about 0.15 s) matches the one taken right after the snapshot, for up to 60 s. The status bar is ignored, and a toast, banner, late-loaded list or scroll counts as a change. On iOS the fresh dump is already fast (about 0.1 s), so there is no screenshot check. Otherwise it takes one fresh dump and finds the element again: a moved element is tapped at its new center (`refMoved:true`), a vanished one returns `STALE_REF` with up to 3 similar `candidates`. A ref that a later snapshot replaced (after another action or a scroll) works the same way: Swipium remembers the last 200 replaced refs of the current app, taps the element when exactly one element with the same identity and label is on screen now, and otherwise returns `STALE_REF` with `candidates`. Call `qa_snapshot` again, or use one of the candidates.
- **Settling**: after an action Swipium waits until the screen stops changing. It compares a fingerprint of the on-screen elements, not the raw XML: bounds are bucketed, and clocks (`12:34`, `1:02:03`), percentages, and SeekBar, ProgressBar, and RatingBar values are masked, so a ticking clock doesn't keep a screen unsettled. Two equal dumps in a row mean settled. On the Android direct driver the first dump is enough when it differs from the pre-action screen and shows no loading marker (`settleFast:true` on the `qa_act` result), which saves one dump per action. iOS always uses two.
- **Reuse**: a settled dump becomes the session's latest snapshot, so flows, `text` and `id` lookups, and exploration reuse it while it is under 2 s old and no action ran since, instead of dumping again.
- **Weak trees**: WebViews, canvases, games, and maps often expose few usable elements. Results then carry a `treeHint` pointing at `qa_screenshot` and `qa_visual` (a clickable counts as labeled when it, or any view inside it, has text, a label, or an id), and taps on unlabeled or WebView-like targets compare screenshots to tell whether anything changed (`pixelChanged:true`).
- **Faster Android dumps (opt-in)**: `SWIPIUM_ANDROID_DUMPER=agent` keeps a small agent running on the emulator instead of starting `uiautomator dump` each time, about 2x to 7x faster depending on host load (a screen that never goes idle still waits up to 2 s per dump). Without it, `uiautomator dump` on a screen that never goes idle (a looping animation) fails after one attempt of about 12 s ("could not get idle state"; it used to retry for about 60 s), and the error suggests the agent dumper; set it for such apps. See [android-agent/README.md](../android-agent/README.md) for how it works and its limits.

## iOS modes

Swipium drives iOS Simulators in one of two modes.

| Mode | When | What works |
| --- | --- | --- |
| **Structured (WDA)** | WebDriverAgent is reachable and attached. | `qa_snapshot`, `qa_act` by `@eN` ref, text, id, or native selector (`accessibility id`, `name`, `predicate string`, `class chain`), structured flows. |
| **Visual-only** | No reachable WDA. | `qa_screenshot`, `qa_visual` (assert, baseline, diff, OCR, image find), coordinate taps through `idb` when it is installed, flows in `mode: visual` or `auto`. `qa_snapshot`, `qa_act`, and structured flows return `BACKEND_UNSUPPORTED`. |

`qa_test_this` and `qa_prepare_ios_target` (`attachWda:"auto"`) fall back to visual-only automatically, with a recorded workaround, unless WDA was explicitly required. `qa_orientation`, `qa_geolocation`, and `qa_network` are not available on iOS in either mode.

- **Artifacts**: only simulator `.app` bundles install. A `.ipa` targets a real device and is refused with `IPA_NEEDS_REAL_DEVICE`.
- **System alerts**: WDA's page source describes the app, so a SpringBoard permission alert used to be invisible. Swipium's default WDA settings include `respectSystemAlerts:true`, so the alert and its buttons appear in the snapshot (overlay `permission_dialog`) and the app controls under it are not offered as tappable. Set it to `false` in `ios.wda.settings` to turn this off; older WDA builds ignore it.
- **Session capabilities**: every WDA session created for an app sends `shouldTerminateApp:false` (unless `ios.wda.capabilities` in `.swipium/config.json` sets it), because WDA tears down the previous session with that session's setting. Re-binding a resumed session after a restart, and recovering from an invalid-session error, also send `forceAppLaunch:false`, so the running app is reused; the latter adds a warning to verify the screen state.
- **One WDA per simulator**: every simulator's WDA would otherwise answer on the same default URL (`http://127.0.0.1:8100`), so Swipium checks which simulator owns a WDA before it reuses, attaches to, or waits on it (`lsof` on the port, then the listener's simulator path; else the iOS version). When `lsof` or `ps` fails or times out, the owner is `unverified`, and such a WDA is treated like another simulator's (only the session's own attached WDA is still accepted). A ready WDA that belongs to another simulator is never reused: an explicit URL, `qa_wda attach`, and `qa_wait {for:"wda_ready"}` return `STALE_WDA_DEVICE`, `qa_prepare_ios_target` stays visual-only with a `qa_wda setup` hint (or fails with `STALE_WDA_DEVICE` under `attachWda:"required"`), and `qa_wda setup` or `start` run this simulator's WDA on its own port. Without an explicit URL a managed WDA always gets its own port (a stable port in 8101 to 8900 derived from the UDID, else the next free one); it uses the shared 8100 only when the WDA already there runs in this simulator. A free port also needs its stream port (+1000) free. A custom port in `ios.wda.url` is used as is, which means one simulator at a time on it: while another simulator's managed WDA is still starting on that port, a second simulator's `setup` or `start` moves to its own port instead. If another simulator's WDA wins the port while this one starts, the start fails with `WDA_PORT_CONFLICT`; retry and it picks a free port. Later `qa_wda` and `qa_wait` calls in the session default to that URL and simulator, and `qa_prepare_ios_target`, `qa_wda attach`, `qa_wait {for:"wda_ready"}`, the `qa_test_this` WDA check and `qa_doctor`'s optional `wda-server` row find this simulator's own WDA (its port, or a WDA registered for its UDID) when the configured URL's WDA is someone else's or isn't running.
- **Managed WDA lifetime**: `qa_wda start` spawns WDA (`xcodebuild test-without-building`) and records it in `~/.swipium/processes.json`. Its control port is its URL's port and, for a `127.x` URL (the default), listens on loopback only; a `localhost` or `::1` URL, or a WDA build without `USE_IP` support, binds every interface. Its MJPEG screen stream runs on WDA port + 1000 (9100 for 8100, 9101 to 9900 for per-simulator ports) and **always listens on every interface**, because WDA has no bind-address setting for it: anyone who can reach the Mac on that port can watch the simulator screen, so use a firewall on untrusted networks. It waits at most 45 s; if WDA is still booting it returns `status:"starting"`, and `qa_wait { for:"wda_ready" }` polls until it is up. Booting a simulator works the same way: `qa_ios boot` waits at most 40 s, then returns `status:"booting"` (the simulator is bound already), and `qa_wait { for:"simulator_booted" }` polls. `qa_wda build` runs as a background job (poll `qa_job_status`); `qa_wda stop` terminates this simulator's managed WDA, including one adopted from a previous server run or started by another Swipium server for the same simulator; it never stops another simulator's WDA. `start` and `setup` replace a stale managed WDA (its URL refuses connections and it either served before or is older than the startup timeout) instead of refusing. A normal server shutdown does not stop managed WDA, so a resumed iOS session can keep using it.
- **Adoption at startup**: a managed WDA from a previous run is adopted only when it is less than 12 hours old (from its original start) and `GET /status` reports ready, or keeps timing out (a busy WDA, probed again for 8 s); older ones, and ones that refuse the connection or answer not ready, are stopped, as are orphaned Metro bundlers and screen recorders. Orphaned emulators are adopted and left running. A process owned by another running Swipium server is never touched. Each registered process records its start time and full command line, and an orphan is signalled or adopted only when both still match, so a recycled pid is never touched. The startup sweep runs in the background after the server connects.
- **Remote WDA rule**: loopback means `localhost`, `127.0.0.0/8`, or `[::1]`. A non-loopback `webDriverAgentUrl` needs `allowNonLoopback:true` plus the `wda_non_loopback` consent, otherwise `DESTRUCTIVE_REFUSED`. The approval is single-use: every later `attach`, `setup`, `build` or `start` on that URL asks again, and only read-only actions (`status`, `logs`, `diagnose`, `tune`, `doctor`) and `stop` on the session's attached remote WDA don't. The only pre-approval is user-level: `SWIPIUM_ALLOW_REMOTE_WDA`, a comma-separated list of exact WDA base URLs in the MCP server's environment. The repository's `.swipium/config.json` cannot pre-approve one: `ios.wda.allowNonLoopbackUrls` only adds a note, and a non-loopback `ios.wda.url` is labelled "configured by the repository (.swipium/config.json), unreviewed" in the prompt. `qa_prepare_ios_target` and `qa_test_this` never connect to a non-loopback configured URL on their own.

## Devices

Swipium drives Android Emulators and iOS Simulators on the local machine. Physical devices are out of scope.

### Physical devices

A connected phone doesn't stop a run by itself: target selection (`qa_resolve_target`, `qa_test_this`) picks an emulator or simulator when one is viable and only mentions the phone in the selection `reason`. The phone is refused with `PHYSICAL_DEVICE_UNSUPPORTED` when it is requested explicitly (its serial or UDID as `device`), when it is the only option, or when `preferRealDevice` is set. `qa_prepare_target` acts on the online devices rather than planning, so with a phone and an emulator online and no `device` it returns `MULTIPLE_DEVICES`; pass the emulator's serial. The per-tool behavior and how emulators are recognized are in [physical-devices.md](physical-devices.md).

### Android

- **Emulator detection**: an `emulator-NNNN` serial is an emulator. Any other serial (an adb-over-TCP `localhost:5555`, Genymotion) counts as one only when a `getprop` probe shows an emulator ([details](physical-devices.md#how-android-emulators-are-recognized)). When a session binds a device whose properties can't be read, it is refused as `DEVICE_NOT_READY`; if they show real hardware, `PHYSICAL_DEVICE_UNSUPPORTED`.
- **Booting**: when an AVD must be booted (headless by default), Swipium records the serials online before the boot and uses only a new serial that is a verified emulator, then waits for `sys.boot_completed` (up to 180 s, checked every 0.5 s). The emulator quick-boots from the AVD's snapshot and never saves over it (`-no-snapshot-save`), so its screen, apps and settings come from that snapshot; when the AVD has none, the first boot is cold and Swipium saves one right after it (later boots about 3.5 s instead of 21 to 25 s); `SWIPIUM_EMULATOR_COLD_BOOT=1` forces a cold boot. It renders with `-gpu auto`; set `SWIPIUM_EMULATOR_GPU=swiftshader_indirect` on a host without a usable GPU (black screenshots or a headless emulator that won't start). So when a phone is connected and an AVD exists, it boots the AVD and installs only on the new emulator. A boot that never comes up is `EMULATOR_BOOT_FAILED`; an online device that never finishes booting is `DEVICE_NOT_READY`.
- **Several devices**: with more than one device online (phones count) and no `device` argument, `qa_prepare_target` returns `MULTIPLE_DEVICES` with the online serials. Without an explicit device, the session's own device (`qa_test_this` only), or the pin, `qa_test_this` and `qa_resolve_target` pick the first online emulator and name the others in `reason`.
- **AVDs**: an explicit `avd` means that AVD. When it is already running, its emulator is bound (recorded as `bind_emulator`) instead of booting a second copy; otherwise it is booted. It is never replaced by another device. An Expo Android build is pinned to the target AVD with `--device <AVD>`.
- **Binding**: a session is only re-bound to its own device. An offline device is never replaced by a different online one.
- **Toolchain**: a missing `adb` is `ADB_NOT_FOUND` from `qa_test_this`. `qa_network` needs Android 11+.

### iOS Simulator

See [iOS modes](#ios-modes). `qa_ios` and `qa_wda` take a simulator by UDID or exact name (ignoring case, never a substring); an unknown one is `INVALID_ARGUMENT` and a name several simulators share is `MULTIPLE_DEVICES`, never another booted one. `qa_ios boot` without `device` uses the pinned simulator, else the one booted simulator (several booted: `MULTIPLE_DEVICES`), else the first iPhone. `qa_wda attach` refuses to guess (`MULTIPLE_DEVICES`) when no device is given and none is bound to the session.

### Auto-binding

A session with no device binds one in three ways: explicitly (`qa_prepare_target`, `qa_prepare_ios_target`, `qa_ios boot`), through `qa_test_this` or `qa_test_feature`, or by auto-binding on first use. Auto-binding happens when a tool that needs a device (such as `qa_snapshot`, `qa_check_health`, or `qa_device_info`) runs on a session without one and exactly one Android device is online; Swipium probes it first and refuses a phone or a still-booting emulator. It does not happen:

- in `qa_report` and `qa_first_run`, which never bind a device;
- while any iOS Simulator is booted (the session may be meant for it): the result is `MULTIPLE_DEVICES` with both bind calls;
- when the session already has a device that went offline (`DEVICE_NOT_READY`, naming its AVD when known);
- with `SWIPIUM_DEVICE` set, for any device other than the pinned one.

### Device pin

`SWIPIUM_DEVICE` in the MCP server env pins the server to one device: an adb serial, an AVD name, or a simulator UDID or exact name. It matches ignoring case (`iphone 16` pins `iPhone 16`), the same way in every tool, but never as a substring (`iPhone 16` does not pin `iPhone 16 Pro`). A pinned simulator name that several simulators share pins none of them: it is refused with `MULTIPLE_DEVICES` (by `qa_test_this`, `qa_test_feature`, `qa_prepare_ios_target` and `qa_ios`) before anything runs; pin by UDID then. It is read only from the server process environment, never the repository. With it set:

- `qa_test_this` (after an explicit `device` and the session's own device), `qa_test_feature`, `qa_resolve_target`, `qa_prepare_target`, `qa_prepare_ios_target`, `qa_ios boot` and auto-binding default to the pinned device, and nothing else is ever picked automatically. A tool for the other platform refuses instead of picking: `qa_prepare_target` (Android) under an iOS pin is `DEVICE_PINNED`, and so is `qa_test_feature` with a `platform` the pin is not. `qa_wait {for:"device_online"}` waits for the session's own device or the pinned one, never any device.
- An explicit `device`, `avd`, or simulator that is a different device is refused with `DEVICE_PINNED` by `qa_test_this`, `qa_prepare_target`, `qa_prepare_ios_target`, `qa_ios` (`boot`, `install`, `privacy_reset`, `erase`) and `qa_wda` (`build`, `start`, `setup`, `attach`, `stop`; a `device` given as a simulator name is resolved to its UDID first), and by `qa_bundletool {connectedDevice:true, install:true}`, before any consent prompt. The AVD name and serial of the same emulator, or a simulator's name and UDID, count as the same device. With an Android pin, every simulator boot or erase is refused.
- A pin that matches no available simulator makes `qa_prepare_ios_target` fail with `NO_DEVICE` naming `SWIPIUM_DEVICE`, before consent. A `platform` the pin overrides in `qa_test_this` is reported in `targetPlan.reason` and as a workaround.
- `SWIPIUM_CONSENT_PREAPPROVE` then only ever approves actions on the pinned device, `erase_device` included. Set both on shared CI runners.

## Glossary

| Term | Meaning |
| --- | --- |
| **`@eN` ref** | A handle such as `@e3` for one on-screen element. Results list elements as one line each, starting with the ref (see [Element lines](tools.md#element-lines)). A ref stays the same while its element stays on screen and moves at most 64 px; one whose element is gone returns `STALE_REF` (see [Screens, refs, and settling](#screens-refs-and-settling)). |
| **App map** | Swipium's durable memory of the app in `.swipium/app-map.json`: features, screens, navigation, tests, and a code index, each with provenance. Built by `qa_app_map_build` and updated by runs. |
| **Approval mechanism** | How a consent was decided: `elicitation` (a real user prompt, in either protocol era), `client-assertion` (the client re-called with `consentId` and `approve:true`), `operator-policy` (pre-approved by `SWIPIUM_CONSENT_PREAPPROVE`), or `policy` (refused by `SWIPIUM_REQUIRE_ELICITATION=1`). Recorded in the mutation ledger. |
| **Budget** | A session's limits on time, actions, screenshots, consecutive snapshot failures, and no-change actions (default 30 min, 60 actions, 40 screenshots, 3 and 3). A spent budget returns `{ok:false, stopped:true, performed:false, failureCode:"BUDGET_EXHAUSTED", reason}`, and the call does nothing. |
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
| **Pack** | A YAML list of flows under `.swipium/packs/` (`swipium init flows` writes a `smoke` pack). No tool runs or reads packs; the file is a starting point for your own scripts. |
| **POM suite** | A generated page-object-model suite (page objects plus suites under `.swipium/`) that compiles into runnable flows. Produced by `qa_generate target:"suite"`. |
| **Response mode** | `compact`, `normal`, or `verbose`: how much of a result is repeated in the text channel, and whether element lists are `@eN` lines or full objects (`verbose`). See [Response modes](tools.md#response-modes). |
| **Sensitive session** | A session started with `sensitive:true`; it refuses all pixel, video, and log capture. |
| **Stale client** | A client still running a pre-upgrade tool list; removed calls return `STALE_CLIENT`. |
| **Visual-fallback** | A per-screen switch to screenshot-based work after repeated failed UI-tree dumps (`VISUAL_ONLY_SCREEN`). The next successful structured observation switches back. |
| **Visual-only** | An iOS session without WDA. See [iOS modes](#ios-modes). |
| **WDA** | WebDriverAgent, the on-simulator automation server Appium uses. It gives iOS a UI tree. |
| **Workaround** | A safe fallback Swipium chose on its own (for example visual-only iOS), listed in the report. |
