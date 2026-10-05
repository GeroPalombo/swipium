# Changelog

All notable public changes to Swipium are documented here.

## 2.2.0 - 2026-10-05

Swipium 2.2.0 moves to the MCP TypeScript SDK v2, adds the MCP 2026-07-28 protocol revision next to the 2025 ones, and changes the shape of element lists in `structuredContent` for every client. It also makes Swipium usable from headless and non-Claude clients (`codex exec`, `claude -p`, Codex in general), keeps waits under common client tool timeouts, and makes cancellation actually stop work. No tools were added or removed (still 55). Work through the upgrade checklist before upgrading.

### Upgrade checklist

Items tagged **You** need an action from you. Items tagged **Automatic** happen on their own and are listed so they don't surprise you.

1. **You:** restart your MCP client so it reloads the server instructions and tool list. The schema hash changed (descriptions were trimmed and `qa_wait` gained `wda_ready` and `simulator_booted`), so update any `qa_doctor { expectedSchemaHash }` check.
2. **You (scripts reading results):** `structuredContent.elements` from `qa_snapshot` and `qa_act` are now `@eN` strings, not objects. Pass `responseMode: "verbose"` to keep the objects, or parse the lines (see Breaking changes).
3. **You (Codex):** Codex passes MCP servers only a small whitelist of environment variables. Add the `env_vars = [...]` line that `swipium init codex` prints under `[mcp_servers.swipium]`, or `SWIPIUM_TEST_*`, `ANDROID_HOME` and `JAVA_HOME` exported in your shell never reach Swipium. Keep `tool_timeout_sec = 600`: some synchronous steps can still take longer than Codex's 60 s default (a large `qa_ios install`, `qa_flow_run`, `qa_smoke`, `qa_mobile_audit`, `qa_generate { target:"appium" }`). `qa_doctor` checks the env part when it runs under Codex.
4. **You (headless runs):** `codex exec` and `claude -p` answer consent prompts automatically, so boots, installs and builds were always refused there. To allow specific actions without a prompt, list them in `SWIPIUM_CONSENT_PREAPPROVE` in the MCP server env (see Added). For Codex, set it literally in the `env = { ... }` table: `init` deliberately doesn't forward it from your shell.
5. **You (iOS automation):** `qa_wda build` now returns a `jobId` right away (poll `qa_job_status`), `qa_wda start` can return `status:"starting"` after 45 s (poll `qa_wait { for:"wda_ready" }`), `qa_ios boot` can return `status:"booting"` after 40 s (poll `qa_wait { for:"simulator_booted" }`), and `qa_prepare_ios_target` can hand a slow boot to a job (poll `qa_job_status`). Agents that waited on one long call need the extra poll.
6. **You (resource clients):** reading a missing `swipium://` resource now fails with `-32602` instead of `-32603`, and `qa_get_artifact` returns `INVALID_ARGUMENT` for an unknown URI.
7. **Automatic:** waits and long-polls end within about 50 s. `qa_job_status` long-polls at most 50 s (was 120 s, recommended `waitMs` is now 45000), and larger `timeoutMs` values on `qa_wait`, `qa_act` and `qa_test_this` are clamped to 50000 with a note instead of being rejected.
8. **Automatic:** Claude Code 2.1.285 and later connect on MCP 2026-07-28. Consent prompts look the same, but Swipium no longer asks those clients for MCP roots; Claude Code sets `CLAUDE_PROJECT_DIR`, so the project root still resolves to the open project.

### Breaking changes

- **Element lists are compact lines, for every client.** `qa_snapshot` and `qa_act` return `structuredContent.elements` as one-line strings, the same lines as the text block, instead of one JSON object per element. For example: `@e3 [button] "Log in" #login_btn [40,200][1040,245] (focused)`. That's about 40% smaller, and it's what Claude Code and Codex show the model. Lines carry bounds, the text when it differs from the label, and a `secure` flag; names are JSON-escaped and capped at 80 characters after redaction. Programmatic readers that expect objects should pass `responseMode: "verbose"`, which still returns them, or parse the lines ([format](docs/tools.md#element-lines)).
- **`qa_wda build` is a job, and `qa_wda start` doesn't wait for WebDriverAgent forever.** `build` returns a `jobId` at once (the xcodebuild timeout goes from 3 to 10 minutes). `start` waits at most 45 s, then returns `ok` with `status:"starting"` while WebDriverAgent keeps booting.
- **Shorter waits.** `qa_job_status` `waitMs` is capped at 50000 (was 120000). `qa_wait` `timeoutMs` defaults to 45000 (was 60000, or 180000 for `device_online`) and `qa_test_this` `waitForCompletion` `timeoutMs` to 45000 (was 120000). Values above 50000 on those two and on `qa_act` are clamped with a note. Negative values, and non-integers on `qa_wait` and `qa_test_this`, return `INVALID_ARGUMENT`.
- **Missing resources.** Reading a `swipium://` URI that matches a template but names nothing that exists returns JSON-RPC `-32602` with the URI in `error.data.uri`, in every protocol era. 2.0.1 sent `-32603` (internal error). Clients should also accept the older `-32002`.

### Added

- **MCP 2026-07-28 (dual-era stdio).** Swipium answers `server/discover` for 2026-07-28 clients and `initialize` for 2025-06-18 and 2025-11-25 clients; the client's first message picks the era for the whole connection. Claude Code probes 2026-07-28 from 2.1.285 (verified on 2.1.289); Codex 0.146 stays on 2025-06-18. On a 2026-07-28 connection:
  - Consent prompts travel as an `InputRequiredResult` (the same one-checkbox form) and the answer comes back on the client's retry of the tool call. The `requestState` is a single-use server-side handle bound to the tool, its arguments and the session: a forged, reused or re-targeted one fails with `-32602` and nothing runs.
  - `tools/list` is sorted by name, and list results carry cache hints: `ttlMs: 3600000`, `cacheScope: "public"` for tools, prompts, resource templates and `server/discover`; `ttlMs: 0`, `cacheScope: "private"` for `resources/list` and `resources/read`.
  - MCP roots are never requested (roots are deprecated in that revision). The project root comes from `projectRoot`, `SWIPIUM_PROJECT_ROOT`, `CLAUDE_PROJECT_DIR` or the working directory.
- **Operator consent pre-approval** for headless clients. `SWIPIUM_CONSENT_PREAPPROVE` is a comma-separated list of exact consent action names (for example `prepare_plan,install_app`) approved without a prompt, on any client and in both protocol eras.
  - It's read only from the server process environment, never from `.swipium/` or any repository file. No wildcards; unknown names are ignored with a startup warning that suggests the closest valid name.
  - Actions that run repository- or model-chosen code (`build_from_source`, `flow_mutation_run`, `ocr_run`, `seed_state`, `start_metro`, `suite_fresh_state_replay`, `wda_build`, `wda_start`) also need `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1`. Pre-approving `test_this_plan` doesn't cover a plan with a build step unless `build_from_source` is pre-approved that way too.
  - `wda_non_loopback` can never be pre-approved; use `SWIPIUM_ALLOW_REMOTE_WDA`.
  - Approvals stay single-use and session-bound, are recorded in the mutation ledger as `operator-policy`, and each one is logged at `warn` with the action and its exact command.
- `qa_wait { for:"wda_ready" }` polls the session's WebDriverAgent `/status`, and `qa_wait { for:"simulator_booted" }` polls the session's bound iOS Simulator after a boot that returned `status:"booting"`.
- `SWIPIUM_LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`; unknown values fall back to `info`). At `debug`, one stderr line per tool call with the tool, session, duration, error code and whether it was cancelled, plus the protocol era of each connection. Argument values are never logged.
- **Codex setup.** `swipium init codex` writes an `env_vars` line covering every variable Swipium and its toolchains read, except the approval grants (`SWIPIUM_CONSENT_PREAPPROVE`, `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE`, `SWIPIUM_ALLOW_REMOTE_WDA`), plus a commented `enabled_tools` core profile that includes every tool the server instructions point to. It honours `CODEX_HOME`, detects an existing `[mcp_servers.swipium]` or `[mcp_servers."swipium"]` table, and then prints only the missing `env_vars` line.
- `qa_doctor` adds `codex-env` and `codex-tool-timeout` rows when the client is Codex (or `client:"codex"`). `codex-env` lists the Swipium variables the server can see and warns when no Android SDK or JDK is found.
- A device-driving tool called while a background job is still driving the same device gets a note that the two may interleave.

### Changed

- **MCP SDK v2.** Swipium moved from `@modelcontextprotocol/sdk` 1.x to `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.3.1, and zod is `^4.2.0` (was `^3.25`). A production install goes from 100 packages to 21, and picks up the SDK's UriTemplate ReDoS fix ([GHSA-cqwc-fm46-7fff](https://github.com/advisories/GHSA-cqwc-fm46-7fff), CVE-2026-0621; 2.0.1 allowed SDK versions below the 1.25.2 fix). For 2025-era clients the move itself is invisible: tool results are byte-identical, and so is `tools/list` apart from `qa_act`'s `for.selector`, which is now inlined instead of a `$ref`.
- Argument validation, unknown-argument rejection and stale-client mapping no longer patch private SDK internals. Swipium answers `tools/list` and `tools/call` through the public request-handler API and validates each call against one strict schema per tool.
- Successful results carry the summary headline and next steps in `structuredContent` (`summary`, `next`). Claude Code and Codex show the model `structuredContent` instead of the text block, so hints such as "call qa_report" were invisible before. `next` lists only real tool calls and is left out when the payload already has next-step fields.
- Consent declines and cancels include `action`, `answeredInMs` and `likelyAutomatic` (answered in under 1.5 s). Only when `likelyAutomatic` is true does the error name `SWIPIUM_CONSENT_PREAPPROVE` and tell the agent not to re-call in a loop; a real human decline is never nudged toward pre-approval. A prompt that failed (timeout, transport error, aborted call) reports `likelyAutomatic: false` and an `elicitationFailure` reason.
- `qa_get_artifact` defaults to metadata for every non-text artifact (recordings included, not only images), never decodes binaries as text, applies the same size caps as `resources/read`, and returns `INVALID_ARGUMENT` for an unknown URI.
- Missing, wrong-typed or out-of-range arguments return the typed `INVALID_ARGUMENT` envelope with per-field `invalidArguments` instead of a raw validation dump.
- Server instructions are 1,900 characters (were 2,518), under Claude Code's 2,048-character limit, and their first 512 characters stand alone. They recommend `waitMs: 45000`.
- `tools/list` is about 9% smaller (63.5 KB, was 69.6 KB): descriptions were trimmed, and no parameters were removed.
- `swipium init` writes a `node` path that survives a Homebrew upgrade (`/opt/homebrew/opt/<formula>/bin/node` instead of the versioned `Cellar` path).
- MCP roots requests (2025-era connections) time out after 5 s instead of 60 s.

### Fixed

- **Simulator boots no longer block a call.** `qa_ios { action:"boot" }` waits at most 40 s; a slower cold boot returns ok `status:"booting"` (`udid`, `name`, `elapsedMs`, `next`) with the simulator already bound, and the new `qa_wait { for:"simulator_booted" }` polls until it is up. `qa_prepare_ios_target` waits at most 30 s for a boot, then returns `status:"booting"` with a `jobId`: a `prepare_ios` job finishes boot, install, launch and the WDA check under the consent already given. `qa_test_feature` (execute without `sessionId`) now boots, installs and launches inside its job, so the call returns at once.
- A Metro bundler started through `npx` is now reaped after a server crash. Under load, Swipium could record it during the brief moment `npx` titles itself a bare `npm`, so the startup sweep could never verify it and left it holding port 8081.
- Cancelling a call now stops its work. `qa_wait`, the `qa_job_status` long-poll, element waits in `qa_act` and flows, UI settling, emulator boot and appear waits, WebDriverAgent startup and UI dump retries used to keep running until their deadline.
- Cancelled smoke runs and mobile audits are no longer recorded as failures, findings or issues, and a cancelled mobile audit restores the device network instead of leaving it offline.
- The server exits when the client closes stdin, even during a long call. Before, it lingered until the call finished. On shutdown, running jobs are cancelled before device network state is restored.
- `resources/read` caps what it returns: text over 1 MB comes back as the head (the tail for logs) with a marker naming the local file, binaries over 8 MB are not inlined, non-text files are returned as blobs instead of being decoded as text, and a cut never splits a UTF-8 character.
- Errors no longer echo unbounded caller input. A multi-MB argument (or argument name) used to produce an error larger than a client's read buffer, and the client dropped the connection. Names and paths are cut at 100 characters, and long messages keep both their start and their end, where the deciding line of a command failure usually is.

## 2.0.1 - 2026-09-30

A small maintenance release. No behavior changes for agents or flows.

### Fixed

- SARIF exports (`qa_report format:"sarif"`) link the tool to the real repository, `https://github.com/GeroPalombo/swipium`. The old link pointed at a GitHub account that doesn't exist, which code-scanning pages show to users.

### Changed

- Test fixtures no longer contain paths from a developer's machine.

## 2.0.0 - 2026-09-30

Swipium 2.0.0 fixes the typing, gesture, and secret-handling defects in the core test loop, makes iOS Simulator sessions and background jobs more reliable, adds CI report exports and one visual tool, and narrows the public surface from 60 to 55 tools (6 removed, `qa_visual` added). **It removes and renames public tools and tightens several defaults.** Work through the upgrade checklist before upgrading.

### Upgrade checklist

Items tagged **You** need an action from you. Items tagged **Automatic** happen on their own and are listed so they don't surprise you.

1. **You:** restart your MCP client (or reload its server list) after upgrading. A client still holding the 1.5.x tool list gets `STALE_CLIENT` errors that name the replacement call.
2. **You:** rename the environment variables your flows and `.swipium/fixtures.json` read through `${VAR}` so they start with `SWIPIUM_`. Other names no longer resolve from the server environment. See [README.md](README.md#configuration--environment-variables).
3. **You:** in CI, install the app yourself (for example `adb install -r -g app.apk`) before the agent step. Every Swipium install now asks for consent, and nobody can approve it in CI. [docs/ci-reports.md](docs/ci-reports.md#github-actions-recipe-android) has a complete recipe.
4. **You:** replace calls to removed tools using the [migration table](#migrating-from-150), and remove arguments a tool does not declare. They are now rejected with `INVALID_ARGUMENT` instead of being ignored.
5. **You:** if you use a remote (non-loopback) WebDriverAgent, `ios.wda.allowNonLoopbackUrls` in `.swipium/config.json` no longer pre-approves it. Pass `allowNonLoopback: true` and approve the consent prompt, or set `SWIPIUM_ALLOW_REMOTE_WDA` to the exact URL in the MCP server environment.
6. **You:** scripts that call `swipium <word>` with a word that is not a subcommand now exit with status `2` instead of starting a server. Use `swipium` or `swipium serve`.
7. **You:** stop any Metro bundler or WebDriverAgent that a 1.5.x server started and left running. 2.0 only cleans up processes it recorded with a start-time and command fingerprint, and 1.5.x recorded none.
8. **Automatic:** when a call has no `projectRoot`, no MCP roots, and no `SWIPIUM_PROJECT_ROOT` or `CLAUDE_PROJECT_DIR`, the server's working directory becomes the project root if it contains a project marker (see Breaking changes).
9. **Automatic:** old session folders under `~/.swipium/runs` are pruned (see Added). Set `SWIPIUM_RETENTION_DAYS=off` to keep them.

### Breaking changes

- **Removed and renamed tools.** See the migration table below (also at the end of `docs/tools.md`). A client still running a pre-upgrade server, or a saved prompt that calls a removed tool, gets a typed `STALE_CLIENT` error that names the replacement.
- **Environment variables in flows and fixtures.** Flows and `.swipium/fixtures.json` resolve `${VAR}` from the server environment only for names starting with `SWIPIUM_`. Explicit `variables` and inputs stored in the session still work. Generated flows and suites use `SWIPIUM_TEST_*` for stored inputs and `SWIPIUM_SECRET_N` for other secrets. `swipium init flows` templates use `SWIPIUM_TEST_EMAIL`, `SWIPIUM_TEST_PASSWORD` and `SWIPIUM_TEST_DEEP_LINK` (was `TEST_DEEP_LINK`). Rename any other variables your flows read from the environment.
- **Every app install asks for consent**, including an APK inside the project (Android now matches iOS). Only an app already installed on a running emulator skips the prompt.
- **Unknown tool arguments are rejected** with `INVALID_ARGUMENT`, which lists the accepted parameters, and nothing runs. They used to be ignored silently, so a call such as `qa_app_control {appId:"other.app"}` ran against the session's app.
- **Remote WebDriverAgent.** A repository config can no longer pre-approve a non-loopback WDA: `ios.wda.allowNonLoopbackUrls` is ignored as an approval. Use `allowNonLoopback: true` with consent, or the user-level `SWIPIUM_ALLOW_REMOTE_WDA`.
- **Project root from the server's working directory.** 1.5.0 never used the working directory: without `projectRoot` or MCP roots it asked for a path. 2.0 falls back to `SWIPIUM_PROJECT_ROOT`, then `CLAUDE_PROJECT_DIR`, then the working directory when it is not `/` or `$HOME` and contains a project marker. A server launched inside an app directory now works in that directory without asking. The result's `rootSource` says which one was used.
- **Physical devices.** A single USB phone is no longer bound automatically, and `preferRealDevice: true` or an iOS build that installs only on real hardware returns `PHYSICAL_DEVICE_UNSUPPORTED` (was `BACKEND_UNSUPPORTED`). `qa_resolve_target` no longer plans a real device. See [docs/physical-devices.md](docs/physical-devices.md).
- **Consent risk of source builds.** `build_from_source` is `high` risk (was `medium`), and `start_metro` is `medium` (was `low`). Prompts and the mutation ledger show the new level, and an executed high-risk build lowers the report's readiness score.
- **CLI:** an unknown subcommand prints usage and exits `2` instead of starting the server. Unknown `--flags` (such as `--stdio`) still start the server, with a warning.

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
| `qa_mobile_audit {waitForCompletion}` | removed; passing it returns `INVALID_ARGUMENT` |

### Added

- `qa_visual`: one screenshot-based tool with `mode:"assert"|"baseline"|"diff"|"find_text"|"find_image"`. Because it needs only screenshots, it also works on an iOS Simulator without WebDriverAgent, where `qa_snapshot` and `qa_act` are unavailable. `find_text` and `find_image` return tappable device coordinates (points on iOS) and can tap them (`tap:true`, through `idb` on a simulator without WebDriverAgent). Those taps are recorded and budgeted like `qa_act` taps. `find_text` is consent-gated and needs a local OCR command (`SWIPIUM_OCR_CMD` or `ocrCommand` in `.swipium/config.json`). Without one it returns `OCR_NOT_CONFIGURED` with the provider contract and a tesseract example.
- `qa_issue_log` lifecycle: `mode:"history"` (default, the 1.5.0 behavior), `"log"`, `"mark_fixed"` (`fixedInCommit`, `fixedInVersion`, `howFixed`), `"verify_fixed"` (`evidenceUris`), `"suppress"` (`suppressionScope`, a `suppressedUntil` expiry, and `unsuppress:true`), and `"metrics"` (`groupBy`). A manually logged issue is identified by its title, category and platform, and a title with no identifying words returns `ISSUE_LOG_TOO_VAGUE`. Lifecycle errors are typed: `ISSUE_NOT_FOUND`, `ISSUE_STATE_INVALID`, `ISSUE_EVIDENCE_REQUIRED`. An issue marked fixed and seen again is classified as a regression.
- CI exports: `qa_report format:"junit"|"sarif"|"github-summary"`, and a `swipium report` CLI (`--latest --format … --out … --fail-on-gate`) that renders the last saved report and exits `1` when the `.swipium/policy.json` release gate blocks. SARIF results point at real repository files so GitHub code scanning shows them. `docs/ci-reports.md` has a complete GitHub Actions recipe (Android emulator, headless Claude Code, report, SARIF upload, JUnit).
- `qa_act observe:"diff"|"full"|"none"`, and `warnings[]` in `qa_act` results.
- `qa_job_status waitMs` long-polls until the job leaves `running` (up to 120 s). `qa_status` accepts `goal` to bias `nextBestAction`.
- `qa_test_this`: `responseMode`, and a compact report summary in the terminal result.
- `qa_explain_blocker` accepts `sessionId`, so `qa_status` moves past the blocker it explained.
- `qa_app_control` results carry `changedState`, which is `false` when the call failed before changing anything.
- MCP tool annotations on every tool. Read-only tools carry `readOnlyHint: true` and `openWorldHint: false`; every other tool also sets `destructiveHint` and `idempotentHint`. Clients can use them to auto-approve read-only calls. The server also sends `instructions` with the operating guide.
- MCP resource listing for session artifacts and app-map sections, scoped to the current project and excluding sensitive-mode sessions.
- Consent through MCP elicitation: on clients that support it, privileged actions are approved in a real user prompt. A declined prompt returns `CONSENT_DECLINED`, and the mutation ledger records how each action was approved (`elicitation`, `client-assertion`, or `policy`). `SWIPIUM_REQUIRE_ELICITATION=1` refuses every consent-gated action on clients without elicitation (`CONSENT_REFUSED`).
- CLI: `swipium --help`, `--version`, `swipium serve`, `swipium init cursor`, `swipium init vscode`, and `init --cwd <dir>`.
- Disk retention: when the session registry is first loaded, Swipium prunes, in the background, `~/.swipium/runs` session folders older than 30 days that are not in the session registry and are not among the newest 20 of their project. `SWIPIUM_RETENTION_DAYS=0|off` disables the prune, and `SWIPIUM_RETENTION_KEEP` sets how many recent sessions per project are kept. If `~/.swipium/registry.json` cannot be read, nothing is deleted. `swipium gc [--dry-run] [--days N] [--keep N]` reclaims space on demand, and `~/.swipium/projects.json` drops entries for deleted projects.
- `qa_device_info` on iOS Simulators returns name, runtime, state, and screen size. `qa_resolve_target include:["context"]` lists booted and available iOS Simulators.
- `qa_wda build` and `start` find an Appium-installed WebDriverAgent project (under `$APPIUM_HOME`, `~/.appium`, or the global npm roots) when `wdaProjectPath` is not given.

### Changed

- Project root resolution: explicit `projectRoot` > MCP roots > `SWIPIUM_PROJECT_ROOT` > `CLAUDE_PROJECT_DIR` > the server's working directory, which is used only when it is not `/` or `$HOME` and contains a project marker (`package.json`, `app.json`, `pubspec.yaml`, Gradle or Xcode files, `Podfile`, `android/`, `ios/`). Results report where the root came from (`rootSource`). An unresolved root fails with `PROJECT_ROOT_UNRESOLVED`. `qa_flow_check` and `qa_flow_run mode:"plan"` resolve the root the same way. See [docs/concepts.md](docs/concepts.md#project-root).
- **`qa_status`** without `sessionId` returns first-call orientation instead of an error. With a session, it follows the last job: after a finished run it recommends that run's next action (read the report, explain the blocker, answer the question) instead of `qa_smoke` again, and it stops repeating advice that was already followed.
- **`qa_test_this`:**
  - It never installs on a physical phone. With a phone connected it waits for the emulator it planned to boot; when a phone is the only option it returns `PHYSICAL_DEVICE_UNSUPPORTED`.
  - `needs_input` is a terminal job state. A credentials question found during a run is returned instead of dropped.
  - On iOS without WebDriverAgent it no longer blocks by default. It skips suite generation and exploration and runs a visual-only smoke. It still blocks when you explicitly ask for work that needs WebDriverAgent.
- **Response format in normal mode:** the JSON block in the text channel is compact and omits keys the text above it already shows; `renderedAbove` lists the omitted keys (a 32-element `qa_snapshot` is under half its 1.5.0 size). `responseMode: "verbose"` restores every key, and `structuredContent` always carries the full payload. `qa_act` returns only the elements that changed once a snapshot exists (`observe:"diff"`), and falls back to the full list when most of the screen changed.
- Consent challenges (`consentId`) expire after 30 minutes, and at most 200 are pending at once. See [docs/concepts.md](docs/concepts.md#consent).
- An unknown `sessionId` returns `INVALID_ARGUMENT`.
- `qa_prepare_target` with several devices online and no `device` returns `MULTIPLE_DEVICES`.
- `qa_network` on an iOS Simulator returns `BACKEND_UNSUPPORTED` (airplane-mode control is Android-only). A toggle that fails on the device leaves no restore record behind.
- Flow and fixture variables whose names contain `code` (such as `SWIPIUM_VERIFICATION_CODE`) are treated as secrets, like names containing `pass`, `secret`, `token`, `otp`, `pin`, `cvv` or `key`.
- `swipium init` writes a portable `npx -y swipium` command for project-scoped registrations (shared `.mcp.json`, Gemini project settings, Cursor, VS Code). Absolute paths are used only for user or local scope. Codex registrations include `startup_timeout_sec = 30` and `tool_timeout_sec = 600`.
- `adb` and `emulator` are found through `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the OS default SDK location when they are not on `PATH` (useful for GUI-launched clients). See [docs/mcp-server.md](docs/mcp-server.md#requirements).
- `qa_doctor` checks both platforms by default on macOS, and checks the Node version against `engines`.
- `qa_mobile_audit` `resilience` and `release_gate` profiles ask for network-change consent before toggling airplane mode, and restore its original state afterwards.
- `qa_continue_from_blocker` returns `ignored[]` for answers the resumed tool cannot use, and replays the goal and flags of the interrupted `qa_test_this` call.
- `qa_flow_repair` proposes elements of the same kind ranked by text similarity and refuses to apply low-confidence repairs. A failed `qa_flow_run` points to it.
- `qa_report` merges identical findings into one with a count, and reports `DEGRADED` tool status when tools failed during the run. Cancelled calls, unknown sessions, invalid app IDs, and deliberate refusals do not count as tool errors.
- `qa_generate` returns `NO_RECORDED_ACTIONS` for every target when the session has recorded no actions.
- Errors that returned `UNKNOWN` now carry typed codes (`INVALID_ARGUMENT`, `FLOW_NOT_FOUND`, `KEYBOARD_NOT_DISMISSIBLE`, `CAPTURE_WITHHELD_SECURE`, `SENSITIVE_MODE_REFUSED`, `NO_DEVICE`, `CANCELLED`).
- Fewer device round trips per action: adaptive settle interval, bounded screen-dump timeouts, a cheaper foreground and health check, longer-lived screen-size caches, and one keyboard lookup per action.

### Fixed

**Android**

- Typing escapes every shell metacharacter (including `{ } [ ]`), types a literal `%s` correctly, and treats empty text as a no-op. Characters `adb input text` cannot deliver fail with `TEXT_INPUT_UNSUPPORTED`, and replace-mode typing refuses them before clearing the field.
- Deep links and launch extras containing `&`, spaces, or `;` reach the app intact.
- An emulator that is still booting is no longer bound automatically (`DEVICE_NOT_READY`). Network-attached emulators (such as `localhost:5555`) are accepted. A missing `adb` returns `ADB_NOT_FOUND`.
- Snapshots skip rows Android reports as scrolled off the list or that lie off-screen, so `scroll untilVisible` no longer reports an off-screen row as found and taps no longer land on the list edge.
- Apps whose package name contains `debug` or `alert` no longer show false banner or snackbar overlays.

**Gestures and actions (both platforms)**

- Swipe and scroll geometry comes from the live screen size, accounts for rotation, and keeps clear of screen edges. The old fixed 1080×2400 coordinates were off-screen on iOS.
- Scrolls start inside the scrollable list rather than the screen center, a plain `scroll` performs one swipe, and `changed` also reflects content that moved. `scroll untilVisible` checks before the first swipe and reports `endOfList` only when the list stopped moving.
- Tapping a control hidden under the soft keyboard no longer types into the field. When the keyboard covers the target, Swipium hides the keyboard, finds the target again, and returns `KEYBOARD_OBSTRUCTION` if it is still covered. When the keyboard area is unknown, it taps and returns a warning.
- Tapping a switch or checkbox is detected as a change instead of being retried and toggled back.
- Navigation bars, list rows, and text fields are no longer reported as banner or snackbar overlays. A password field's show/hide button keeps its label in snapshots; only secure values are masked.
- Flow `clearOverlay` no longer presses BACK on a plain screen (which could leave the app). It dismisses dialogs, sheets, and dev overlays (iOS alerts through the alert API) and reports when there was nothing to clear.

**iOS**

- A resumed iOS session is rebound to its own simulator (through WebDriverAgent when it was attached), never to another device, and reuses the running app instead of relaunching it.
- A managed WebDriverAgent started by a previous server run is adopted at startup when it is healthy and less than 12 hours old, so a resumed session keeps structured automation. It is recognized even though Xcode's `xcodebuild` shim re-executes under its full path, and `qa_wda stop` can stop it, including when its registry entry was lost.
- Recovery from an expired WebDriverAgent session no longer relaunches or terminates the app, every WebDriverAgent call has a request timeout, and a brief outage while resuming no longer downgrades the session permanently.
- A session that fell back to visual-only on one slow screen returns to structured mode once screen dumps work again. `qa_status` reports a simulator session without WebDriverAgent as `visual-only`.
- `qa_ios launch` and `terminate` work while WebDriverAgent is attached. `qa_app_control background` waits for the home screen and reports the real foreground app, or `unknown` when WebDriverAgent cannot tell.
- `press key:"back"` taps the navigation bar's back button or swipes from the left edge. It reuses the last settled screen dump only for 3 s, and never after the screen changed, so it does not press a back button that is no longer there.
- Snapshots include accessibility identifiers and search and text fields, so typed values can be read back. Keyboard detection works through WebDriverAgent.
- After `qa_ios boot`, next steps point at iOS tools, and target plans count simulators.

**Sessions and jobs**

- Cancelling one call no longer cancels another: each tool call and background job carries its own cancel signal. Cancelled calls and jobs return `CANCELLED` and are never recorded as tool errors or findings.
- App-map and session state writes are atomic and locked. A stale lock is taken over safely (the lock can no longer spin forever and block startup), long app-map scans run outside the lock, and a corrupt `app-map.json` is restored from history.
- Fixtures are reloaded from `.swipium/fixtures.json` on resume instead of being replayed as `«redacted»` after a restart.
- Monorepos: answering the "which app?" question selects that app instead of being treated as a device ID, and the question is not asked again.
- An orphaned Metro started through `npx` is cleaned up after a crash, including on Linux when it was recorded while its `#!/usr/bin/env node` launcher was still starting. A child process that exits before reading its stdin can no longer crash the server.

**Generation**

- Generated Appium suites perform real scroll and swipe gestures, and a scroll recorded without a target replays in the right direction. Steps that cannot be generated fail with `UNEMITTABLE_STEP` instead of producing no-op code.
- Generated JavaScript suites contain no TypeScript-only syntax, and JavaScript and Python suites compile when element labels are keywords, start with digits, or contain quotes or backslashes. The Python generator passes its own validation.
- Generated suites default to the session's platform (iOS sessions get XCUITest), and `qa_visual mode:"assert"` steps become marked manual checks.
- Common-word passwords ("test", "password") no longer rewrite selectors or block generation on template text.
- Suite files from `qa_test_this generateSuite:true` are fetchable `swipium://` artifacts.

**Reports and issues**

- JUnit exports are always well-formed XML, and failures the release-gate policy ignores are reported as skipped. GitHub step summaries stay below GitHub's 1 MiB limit.
- The issue ledger is locked across processes, and issues recorded by 1.5.x keep their identity.
- The documented tesseract OCR setup works: the provider runs from the project root, a crashing provider returns `OCR_PROVIDER_FAILED`, and screenshots are written where macOS tesseract can read them.

**CLI**

- `swipium scan` writes nothing when it cannot identify a project, and the docs and CLI no longer mention the nonexistent `swipium plan` and `swipium ci` commands.

### Security

- A consent prompt the user dismisses or leaves unanswered is a refusal (`CONSENT_CANCELLED`); the agent cannot approve that action itself, and an open prompt cannot be bypassed with `approve:true`. Consent prompts strip control characters and are bound to the session that requested them.
- A cloned repository is treated as untrusted input. Flows and `.swipium/fixtures.json` cannot read server environment variables outside `SWIPIUM_*`, and values read from the environment are treated as secrets. An `openUrl` containing a variable is consent-gated. Consent shows the exact commands of flow seed steps and of repository-configured OCR and mask commands, labelled as unreviewed. A repository config can no longer pre-approve a non-loopback WebDriverAgent (the user can set `SWIPIUM_ALLOW_REMOTE_WDA` to allow specific URLs).
- Secrets never appear in error messages: a failed `adb input text` no longer echoes the typed value, and `qa_act` and flow errors are redacted.
- Values typed into secure fields (passwords, PINs, OTPs, CVVs) are redacted regardless of length with whole-token matching. JSON and XML artifacts are redacted structurally so they stay valid. Secrets shorter than 3 characters are reported as not redacted instead of blanking unrelated text, and a session resumed after a restart is flagged `redactionDegraded` in `qa_report`.
- Report exports (JUnit, SARIF, GitHub summary, Markdown, JSON) are redacted field by field before rendering, so escaping cannot defeat redaction.
- A value typed through a native selector into a secure field, or a registered secret typed into an ordinary field, is recorded as a secret (generated flows use `${SWIPIUM_TEST_PASSWORD}` instead of the plaintext), and every generator checks its output against the session's secrets: generation fails with `SECRET_IN_GENERATED_OUTPUT` and writes nothing rather than emit one. `state.json`, `test-suite.json`, and test cases no longer store secret values.
- `qa_visual` baseline names and template paths are confined to the project (`VISUAL_PATH_REFUSED`), and artifact names cannot escape the session directory. On screens Swipium cannot inspect, OCR results that look like credentials are withheld.
- Orphan-process cleanup only signals a process whose recorded start time and command still match, so a reused process ID can no longer be killed.
- App IDs are validated and quoted for the device shell. Sensitive mode suppresses screenshots in flows and smoke runs. `qa_issue_log` redacts session secrets before writing the ledger. Session folders and files are private (`0700` / `0600`), and OCR temp files live in private per-call directories.
- `THREAT_MODEL.md` documents the limits of the re-call consent convention and the stronger elicitation path.
- GitHub Actions in this repository's workflows are pinned to commit SHAs. Production dependencies are updated for advisories in transitive MCP SDK dependencies (`fast-uri`, `hono`, `@hono/node-server`, `body-parser`).

### Known issues

- The first time an iOS session from a pre-2.0 WebDriverAgent run is rebound after upgrading, the app may be relaunched once.
- Stale-client hints (`STALE_CLIENT` for removed tools) depend on an internal of the MCP SDK. If a future SDK changes it, Swipium logs a warning and those calls get the SDK's plain "tool not found" error instead.
- Fixtures passed inline to `qa_start_session` come back without their values after a server restart. Fixtures in `.swipium/fixtures.json` are reloaded.
- On slow emulators a tap that navigates to a new screen can take several seconds, most of it spent on screen dumps.

### Removed

- The tools listed in the migration table.
- Unregistered pre-1.5.0 tool modules that still shipped in `dist/`. `qa_seed`, `qa_permissions`, `qa_screen_info`, and `qa_locator_suggest` moved to `src/tools/deferred/`, which is excluded from the build and the npm package.

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
