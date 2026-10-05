# MCP server reference

Swipium is a local stdio MCP server. Your MCP client starts it as a child process and talks
JSON-RPC over its stdin and stdout. Nothing listens on the network.

This page covers client setup, the protocol, and how the server behaves. Sessions, consent and the
project root are explained in [concepts.md](concepts.md); every tool is in [tools.md](tools.md);
environment variables are in the
[README](../README.md#configuration--environment-variables).

**Contents**: [Requirements](#requirements) · [Server command](#server-command) ·
[Client setup](#client-setup) · [Protocol versions](#protocol-versions) ·
[What the server exposes](#what-the-server-exposes) · [Server behavior](#server-behavior) ·
[Verification](#verification) · [Debugging](#debugging) · [Troubleshooting](#troubleshooting)

## Requirements

- Node.js 20 or newer.
- Host OS: macOS for the iOS Simulator and Android; Linux for Android. Android on Windows is
  experimental and untested.
- Android: platform-tools (`adb`), the Android Emulator package, and at least one AVD, usually
  installed through Android Studio. Build-tools (`aapt2`) are optional; Swipium uses them to read
  an APK's package name and SDK level. See [How Android tools are found](#how-android-tools-are-found).
- iOS: Xcode with an iOS Simulator runtime and at least one simulator. WebDriverAgent is needed for
  the structured UI tree, taps, typing and swipes. Visual-only checks work through `simctl` without
  it: `qa_visual` baselines and diffs, OCR `find_text`, and template `find_image`.

Swipium only drives Android Emulators and iOS Simulators, never a physical device. See
[physical-devices.md](physical-devices.md).

### How Android tools are found

Swipium looks for an Android SDK in `$ANDROID_HOME`, then `$ANDROID_SDK_ROOT`, then the default
directory (`~/Library/Android/sdk` on macOS, `~/Android/Sdk` on Linux,
`%LOCALAPPDATA%\Android\Sdk` on Windows).

- **`adb`**: the copy on `PATH` is used when there is one. Otherwise Swipium appends the SDK's
  `platform-tools` to its own `PATH` at startup. It never shadows your `adb`, because a different
  adb version would kill the adb server you are running.
- **`emulator`**: booting an AVD runs the SDK copy (`emulator/emulator`) first, and falls back to
  `emulator` on `PATH` only when no SDK copy exists. Listing AVDs and the `qa_doctor` check follow
  the `adb` rule (`PATH` first, then the SDK copy).
- **`aapt2`**: taken from the newest version under the SDK's `build-tools`. There is no `PATH`
  fallback.

This matters for GUI-launched clients (Claude Desktop, Cursor started from the Dock), which don't
inherit your shell `PATH`. If Swipium still can't find the tools, set `ANDROID_HOME` in the server
`env`.

## Server command

`npx -y swipium` is the portable command. After `npm install -g swipium` you can run `swipium`
instead. From a source checkout, run `npm run build` and use
`node /absolute/path/to/swipium/dist/index.js`.

| Invocation | Behavior |
| --- | --- |
| `swipium` or `swipium serve` | Runs the stdio MCP server. |
| `swipium --stdio` (flags only, no subcommand) | Runs the server and warns on stderr that the flags were ignored. |
| `swipium init`, `verify`, `scan`, `suite`, `report`, `gc` | CLI subcommands. See `swipium --help`. |
| `swipium <unknown word>` | Prints usage and exits with status 2 instead of starting a server. |

## Client setup

`swipium init <client>` prints the exact registration and changes nothing. Add `--apply` to
perform it. After a successful apply it runs `swipium verify`. Options: `--scope local|user|project`
(default `local`) and `--cwd <app dir>` (default: the directory you run it from).

| Client | `swipium init` does | Where it lands |
| --- | --- | --- |
| Claude Code | Runs `claude mcp add swipium [--scope …] -- <command>` | `local` / `user`: `~/.claude.json`; `project`: `.mcp.json` |
| Codex | Appends a `[mcp_servers.swipium]` block with `cwd`, timeouts and `env_vars` (see [Codex](#codex)) | `~/.codex/config.toml` (`$CODEX_HOME/config.toml` when set) |
| Gemini CLI | Runs `gemini mcp add --scope project\|user swipium …`; prints a manual block if that fails | `.gemini/settings.json` (project, the default), `~/.gemini/settings.json` (`--scope user`) |
| Cursor | Merges a `swipium` entry under `mcpServers` | `.cursor/mcp.json` (for all projects, add the same entry to `~/.cursor/mcp.json` yourself) |
| VS Code | Merges a `swipium` entry under `servers`; prints a `code --add-mcp …` line for the user profile | `.vscode/mcp.json` |
| Claude Desktop | Not supported by `init`; configure manually | `claude_desktop_config.json` |
| Windsurf | Not supported by `init`; configure manually | `mcp_config.json` (Cascade > MCP settings) |

Which command gets written:

- **Team-shared files** get the portable `npx -y swipium`. That covers Claude `--scope project`,
  Gemini project scope, `.cursor/mcp.json` and `.vscode/mcp.json`.
- **Machine-local registrations** get this machine's `node` and the absolute path of the installed
  `dist/index.js`. That covers Claude local and user scope, Gemini user scope, and Codex. The node
  path is one that survives upgrades: a Homebrew `node` is written as its `opt` path (for example
  `/opt/homebrew/opt/node@20/bin/node`), not the versioned `Cellar` path that `brew upgrade`
  removes; otherwise `init` prefers the `node` on your `PATH` that resolves to the running binary.
  If Swipium itself runs from the npx cache, that path would disappear, so these get
  `npx -y swipium` too.

For Cursor and VS Code, `init` refuses to edit a file that isn't plain JSON (for example JSONC with
comments), prints the entry to add by hand, and exits with status 2. An existing `swipium` entry
is left unchanged.

### Project root

Every tool call works in one app repository. The full resolution order is in
[concepts.md](concepts.md#project-root). For setup, the practical rule: if your client neither
sends MCP roots nor lets you set a `cwd` (Claude Desktop, Windsurf), set `SWIPIUM_PROJECT_ROOT` in
the server `env`. Clients on MCP 2026-07-28 never send roots (see
[Protocol versions](#protocol-versions)); Claude Code covers that by setting `CLAUDE_PROJECT_DIR`.

### Manual configuration

#### Claude Code

```bash
claude mcp add swipium --scope project -- npx -y swipium
```

Claude Code sets `CLAUDE_PROJECT_DIR` for the servers it launches, so Swipium picks up the open
project without extra config. Claude Code 2.1.285 and later (verified on 2.1.289) connect on MCP 2026-07-28, so consent
prompts arrive as an `InputRequiredResult` (see [Protocol versions](#protocol-versions)); the user
sees the same one-checkbox prompt either way.

#### Codex

Add this to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Codex's defaults of 10 s to
start and 60 s per tool call are too short for a first `npx` run and for simulator boots:

```toml
[mcp_servers.swipium]
command = "npx"
args = ["-y", "swipium"]
cwd = "/absolute/path/to/your/mobile-app"
startup_timeout_sec = 30
tool_timeout_sec = 600
env_vars = ["SWIPIUM_TEST_EMAIL", "SWIPIUM_TEST_USERNAME", "SWIPIUM_TEST_PASSWORD", "SWIPIUM_TEST_OTP", "SWIPIUM_TEST_PIN", "SWIPIUM_TEST_TOKEN", "SWIPIUM_TEST_DEEP_LINK", "SWIPIUM_VERIFICATION_CODE", "SWIPIUM_PROJECT_ROOT", "SWIPIUM_REQUIRE_ELICITATION", "SWIPIUM_LOG_LEVEL", "SWIPIUM_OCR_CMD", "SWIPIUM_VISUAL_MASK_CMD", "SWIPIUM_RETENTION_DAYS", "SWIPIUM_RETENTION_KEEP", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_SDK_HOME", "ANDROID_USER_HOME", "ANDROID_AVD_HOME", "ANDROID_EMULATOR_HOME", "JAVA_HOME", "JAVA_TOOL_OPTIONS", "GRADLE_USER_HOME", "GRADLE_OPTS", "BUNDLETOOL_JAR", "APPIUM_HOME", "DEVELOPER_DIR", "DEVELOPMENT_TEAM", "XCODE_DEVELOPMENT_TEAM", "WDA_PROJECT_PATH", "WEBDRIVERAGENT_PROJECT", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "CI", "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "CI_COMMIT_SHA", "CI_COMMIT_REF_NAME", "CI_PIPELINE_URL", "BITBUCKET_COMMIT", "BITBUCKET_BRANCH"]
# Optional: a smaller tool list (off by default). `swipium init codex` prints the core list here
# as a comment; it includes every tool the server instructions and qa_status point to.
# enabled_tools = ["qa_test_this", "qa_status", ...]
```

**Codex does not pass your shell environment to MCP servers.** A stdio server only gets a fixed
whitelist (`HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `USER`,
`__CF_USER_TEXT_ENCODING` and the CA certificate variables), plus the names in `env_vars` and the
`env = { NAME = "value" }` table of `[mcp_servers.swipium]` (see the
[Codex config reference](https://developers.openai.com/codex/config-reference)). So
`SWIPIUM_TEST_*`, other `SWIPIUM_*` settings, `ANDROID_HOME` and `JAVA_HOME` exported in your shell
never reach Swipium unless they are listed.

- `env_vars` forwards a name from the environment Codex was started in (unset names are skipped);
  `env` sets a literal value. Add any custom `SWIPIUM_*` flow variables and
  `ORG_GRADLE_PROJECT_*` signing variables you use.
- The default list leaves out the names that grant approval (`SWIPIUM_CONSENT_PREAPPROVE`,
  `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE`, `SWIPIUM_ALLOW_REMOTE_WDA`). Forwarding them would let an
  inherited shell export, or a per-directory env tool such as direnv in a cloned repo, pre-approve
  actions. If you want them, set them literally in `env = { ... }`.
- `env_vars` is config-only: `codex mcp add --env NAME=value` sets literal values but can't forward
  names, so after `codex mcp add`, add the `env_vars` line and the timeouts to `config.toml` by hand.

What `swipium init codex --apply` does: it refuses if `--cwd` doesn't exist, and otherwise appends
the block above (with this machine's `node`, the commented `enabled_tools` line, and a few comment
lines). If `config.toml` already has a `[mcp_servers.swipium]` (or `[mcp_servers."swipium"]`)
table, it leaves it alone: when that table has no `env_vars`, it prints just the line to add;
otherwise it prints the expected block so you can compare.

`qa_doctor` adds two rows when the client is Codex (or you pass `qa_doctor { client: "codex" }`):

- `codex-env` lists the Swipium variables the server can see and prints the `env_vars` line. It
  warns when no Android SDK is found (no `ANDROID_HOME`/`ANDROID_SDK_ROOT`, no SDK at the default
  location, no `adb` on `PATH`) or `java -version` fails without `JAVA_HOME`: if you installed the
  SDK or JDK in a custom location, forward `ANDROID_HOME` / `JAVA_HOME`; if not, install it first.
- `codex-tool-timeout` is a reminder only: the server can't read `tool_timeout_sec`, so keep it at
  600 or more.

Codex 0.146 connects on MCP 2025-06-18. Known caveat: in the Codex Desktop app, custom stdio MCP
tools can show up in `/mcp` without being available in threads
([openai/codex#19425](https://github.com/openai/codex/issues/19425)). If that happens, use the
Codex CLI.

#### Gemini CLI

```bash
gemini mcp add --scope project swipium npx -- -y swipium
```

The `--` keeps Gemini from reading `-y` as its own flag. `init gemini` also suggests
`"timeout": 600000` in the settings entry.

#### Cursor and VS Code

This is the entry `swipium init cursor` writes to `.cursor/mcp.json`. For VS Code
(`.vscode/mcp.json`, written by `swipium init vscode`), use the same entry under a top-level
`"servers"` key instead of `"mcpServers"`:

```json
{
  "mcpServers": {
    "swipium": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "swipium"],
      "env": { "SWIPIUM_PROJECT_ROOT": "${workspaceFolder}" }
    }
  }
}
```

Why set `SWIPIUM_PROJECT_ROOT` when these editors can send MCP roots: roots come first in the
resolution order, so when the editor sends them, Swipium uses them and ignores the variable. The
variable is a fallback for an editor version or window that sends no roots. The editor replaces
`${workspaceFolder}` with the open folder; if it's left unexpanded, the value isn't an absolute
path and Swipium skips it.

#### Claude Desktop and Windsurf

```json
{
  "mcpServers": {
    "swipium": {
      "command": "npx",
      "args": ["-y", "swipium"],
      "env": { "SWIPIUM_PROJECT_ROOT": "/absolute/path/to/your/mobile-app" }
    }
  }
}
```

### Headless runs

`codex exec` and `claude -p` advertise elicitation but answer every consent prompt automatically
(decline or cancel), so boots, installs and builds never run there. To allow specific actions, an
operator lists them in `SWIPIUM_CONSENT_PREAPPROVE` in the server's environment. The rules (exact
names only, the `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1` tier for actions that run code, what can
never be pre-approved) are in [concepts.md](concepts.md#consent). Where to set it:

- **Codex**: literally in the `env` table, since `env_vars` never forwards it:
  `env = { SWIPIUM_CONSENT_PREAPPROVE = "prepare_plan,install_app" }`.
- **`claude -p`**: in the `env` of the server entry you pass with `--mcp-config`. The
  [CI recipe](ci-reports.md#pre-approving-consents-in-ci) shows a complete config.

## Protocol versions

Swipium is a dual-era stdio server. The client's first message picks the era for the whole
connection:

| Client opens with | Protocol | Served as |
| --- | --- | --- |
| `initialize` (`protocolVersion` 2025-06-18 or 2025-11-25), e.g. Codex | 2025-era | Handshake, session-scoped capabilities, `elicitation/create` and `roots/list` requests to the client. |
| `server/discover`, or any request with the `io.modelcontextprotocol/*` `_meta` envelope, e.g. Claude Code | 2026-07-28 | No handshake: the version and client capabilities come with every request. |

What differs on a 2026-07-28 connection:

- `server/discover` returns the supported versions (`2026-07-28`), capabilities, the server
  instructions and `serverInfo`. Every result carries `resultType`.
- `tools/list` is sorted by tool name (2025-era connections keep the registration order; the schema
  hash doesn't depend on order). List results carry cache hints: `tools/list`, `prompts/list`,
  `resources/templates/list` and `server/discover` are `ttlMs: 3600000`, `cacheScope: "public"`
  (fixed for the life of the process); `resources/list` and `resources/read` are `ttlMs: 0`,
  `cacheScope: "private"` (they change during a run and name local paths).
- Consent prompts travel inside an `InputRequiredResult`, and the answer comes back on the client's
  retry of the tool call (see [Consent](#consent-prompts) below).
- There are no server-to-client requests, so MCP roots are never asked for. Pass `projectRoot`, or
  rely on `SWIPIUM_PROJECT_ROOT` / `CLAUDE_PROJECT_DIR`.
- `ping` and `logging/setLevel` don't exist in 2026-07-28. Swipium logs to stderr either way.

The same in both eras: cancellation (`notifications/cancelled`), the `INVALID_ARGUMENT`,
`STALE_CLIENT` and `CONSENT_*` envelopes, and the `-32602` error for a missing resource.

Swipium is built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.3.1). For
2025-era clients the move from the 1.x SDK is invisible: tool results are byte-identical and the
schema hash is unchanged. The one `tools/list` difference is that `qa_act`'s `for.selector` schema
is inlined instead of a `$ref`.

## What the server exposes

- **Tools**: listed in [tools.md](tools.md). Run `swipium verify` to see the exact list, count and
  schema hash your installed version serves. Every tool carries MCP annotations: read-only tools set
  `readOnlyHint: true` and `openWorldHint: false`, and the others also set `destructiveHint` and
  `idempotentHint`.
- **Server instructions**: sent on `initialize` (2025) or `server/discover` (2026-07-28). They give
  the first call (`qa_test_this { mode: "execute" }`), the polling loop
  (`qa_job_status … waitMs: 45000`), how to relay `needs_input`, blockers and consent, and the
  project-root order. `qa_status` without a `sessionId` returns the same orientation plus the tool
  groups.
- **Prompts** (5): `swipium_setup_check`, `swipium_guardrail_validation`, `swipium_full_smoke`,
  `swipium_bug_repro`, `swipium_convert_run_to_flow`.
- **Resources**:
  - `swipium://session/{sessionId}/{kind}/{name}`: session artifacts (screenshots, dumps, reports,
    logs).
  - `swipium://project/{projectId}/app-map`: the full app map.
  - `swipium://project/{projectId}/app-map/{kind}/{id}`: one feature, screen or test-suite section.

  `resources/list` shows only the current client's projects: the client's MCP roots (2025-era
  connections only) plus the roots of sessions used in this server process. It never lists
  sensitive-mode sessions, and it's capped at 100 entries per template, with the cap stated on the
  last entry. Anything not listed can still be read by URI. Clients without resource support use
  `qa_get_artifact` and `qa_app_map_read`.

## Server behavior

### What the model sees

Every tool result has a text block and `structuredContent`. Claude Code and Codex give the model
the `structuredContent` JSON, not the text, for successful results (Codex does it for every result
that has `structuredContent`; Claude Code shows the text only for errors). So successful results
carry:

- `summary`: the summary's first line (its headline). Results whose later lines say something the
  payload doesn't (for example `qa_job_status` with the job's result text) keep the whole summary.
- `next`: next-step guidance ("Next: ...", "Call qa_report ..."), a list where each entry starts
  with the tool to call. It's left out when the payload already has `nextBestAction`, `nextAction`,
  `nextRecommendedAction` or `nextSteps`. Budget stops always carry `next: ["qa_report ..."]`.

Errors carry `what` and `nextSteps`. The text block stays as a plain-text copy for clients that
read it.

`responseMode` (`compact`, `normal`, `verbose`, set per session) mostly changes the text block, so
on Claude Code and Codex it makes little difference, with one exception: element lists. Outside
`verbose`, the `elements` of `qa_snapshot` and `qa_act` are compact one-line strings such as
`@e3 [button] "Log in" #login_btn [40,200][1040,245]`, about 40% smaller than one JSON object per
element; `verbose` returns the objects. Details: [Response modes](tools.md#response-modes) and
[Element lines](tools.md#element-lines).

### Every call returns within about 50 s

Client tool timeouts are short (Codex defaults to 60 s), so calls that wait are capped below that,
and long work runs as a background job:

- `qa_job_status` long-polls at most 50 s (`waitMs`, recommended 45000). Larger values are clamped,
  not rejected.
- `qa_wait`, `qa_act` and `qa_test_this { waitForCompletion: true }` clamp `timeoutMs` to 50000
  with a note (`qa_wait` and `qa_test_this` default to 45000).
- `qa_wda build` runs as a job. `qa_wda start` waits at most 45 s, then returns
  `status: "starting"`; poll `qa_wait { for: "wda_ready" }` until WebDriverAgent is up.
- `qa_ios { action: "boot" }` waits at most 40 s for an iOS Simulator. A slower cold boot returns
  `status: "booting"` with the simulator already bound; poll `qa_wait { for: "simulator_booted" }`.
  `qa_prepare_ios_target` waits at most 30 s, then hands the rest (boot, install, launch) to a job
  and returns `status: "booting"` with its `jobId`.
- Builds, test runs, exploration, Android boot and install steps, and the device preparation of
  `qa_test_feature` are jobs too (see [Jobs](concepts.md#jobs)).

A few synchronous steps can still take longer: a large app install (`qa_ios install`, or
`qa_prepare_ios_target` on a simulator that is already booted), `qa_flow_run` and `qa_smoke` with
long saved flows, `qa_mobile_audit`, and `qa_generate { target: "appium" }` when it bootstraps a
device. Keep the client's tool timeout generous (Codex `tool_timeout_sec = 600`).

### Cancellation

When the client cancels a call (`notifications/cancelled`), the call's own work stops: waits,
long-polls, UI settling, boot waits and WebDriverAgent startup all end early, and the result is
`CANCELLED`. Cancelling a call never cancels a background job (use `qa_job_cancel`). The rules,
including what is and isn't rolled back, are in [Cancellation](concepts.md#cancellation).

### Resources and artifacts

Evidence is stored under `~/.swipium/runs/` and returned as `swipium://` URIs.

- `qa_get_artifact` returns metadata (URI, MIME type, size, local path) for images, recordings and
  other non-text artifacts by default. Pass `mode: "inline"` only when you need the bytes.
- `resources/read` and `qa_get_artifact` share the same size caps. Text over 1 MB returns the first
  1 MB (the last 1 MB for logs, including `*.log` files such as Metro and WDA logs) with a
  `[swipium: truncated ...]` marker naming the local file to read for the rest. Binaries over 8 MB
  aren't inlined; you get a note with the size and local path.
- A URI that matches a Swipium template but names nothing that exists (unknown artifact, a project
  without an app map, an unknown section) fails with JSON-RPC error `-32602` and the URI in
  `error.data.uri`. Swipium 2.0 sent a generic `-32603` (internal error); the spec asks clients to
  accept the older `-32002` too.

### Invalid arguments and stale clients

- An argument a tool doesn't declare, a missing required argument or a wrong type returns
  `INVALID_ARGUMENT` with the accepted parameter list, and nothing runs. Swipium never silently
  drops an argument. Validation failures carry a per-field `what` (for example `uri: Required`) and
  `invalidArguments`.
- An unknown tool name returns an `isError` result ("Tool ... not found").
- Errors never echo caller input at full size: argument names and paths are cut at 100 characters
  (20 listed at most), `what` keeps its first and last part around a marker, every string is
  capped, and an error still over 64 KB drops its extra fields (`extraDropped` names them).
- A call to a tool removed in 2.0, or a legacy call shape, returns `STALE_CLIENT` with the
  replacement call and a hint to restart the client. `qa_doctor` accepts `expectedVersion`,
  `expectedToolCount` and `expectedSchemaHash` and reports a mismatch. See
  [tools.md](tools.md#unknown-arguments-and-stale-clients).

### Consent prompts

Privileged actions (builds, boots, installs, data wipes and similar) need consent. When the client
supports MCP form elicitation, Swipium asks the user directly and the model never sees a
`consentId`:

- 2025-era: an `elicitation/create` request while the tool call waits.
- 2026-07-28: an `InputRequiredResult` with the same form and a single-use `requestState`, sent
  only when the request's `_meta` client capabilities declare form elicitation. A `requestState`
  that is forged, reused or presented on another tool call fails with JSON-RPC `-32602`
  (`Invalid or expired requestState`) and nothing runs.

Otherwise the tool returns a `requiresConsent` envelope for the agent to relay. Operator
pre-approval is checked first in both eras. The full model (mechanisms, outcomes, rules) is in
[concepts.md](concepts.md#consent); the security reasoning is in
[THREAT_MODEL.md](../THREAT_MODEL.md).

### Startup and shutdown

At startup the version and tool count are logged to stderr, and processes left behind by a crashed
earlier server are reaped in the background.

The server shuts down when the client closes stdin (even in the middle of a long call), on
`SIGINT` or `SIGTERM`, or when the transport closes. It then cancels running jobs, restores network
state it changed, and stops screen recorders and Metro. Managed WebDriverAgent keeps running so the
next server can reuse it; `qa_wda stop` stops it.

## Verification

```bash
swipium verify
```

This starts a Swipium server over stdio, checks that every tool and prompt this version declares is
listed, prints their names, count and schema hash, and calls `qa_doctor`. It exits with status 1 if
a tool is missing or `qa_doctor` errors. It starts the copy of Swipium you ran it with, not the
command your client is configured with.

Inside the client, call `qa_doctor`. It checks both platforms by default on macOS (ready if either
one is) and Android elsewhere. Pass `platform: "android" | "ios" | "both"` to be explicit.

## Debugging

Swipium logs JSON lines to stderr only (stdout carries the MCP stream). Most clients show server
stderr in their MCP logs. Set `SWIPIUM_LOG_LEVEL` in the server `env` to change how much it writes
(an unknown value falls back to `info`):

| Value | Writes |
| --- | --- |
| `error` | Errors only. |
| `warn` | Errors and warnings, including every operator pre-approved consent. |
| `info` (default) | Startup, shutdown, and notable events. |
| `debug` | Everything above, plus one `tool call` line per call and the protocol era of each connection. |

A `tool call` line carries `tool`, `sessionId` (when the call has one), `durationMs`, `isError`,
`failureCode` (on errors) and `cancelled`. Argument values are never logged, since they can hold
secrets.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The client lists fewer or different tools than `swipium verify`, or calls return `STALE_CLIENT` | The client is still running a server it started before the upgrade. Restart the client, or reload its MCP server list. |
| `PROJECT_ROOT_UNRESOLVED` | Pass an absolute `projectRoot`, or set `SWIPIUM_PROJECT_ROOT` in the server `env` (needed on Claude Desktop and Windsurf). |
| The server times out on first start (Codex, Gemini) | The first `npx` run downloads the package. Raise the startup timeout (Codex `startup_timeout_sec = 30`), or install globally and point the client at `swipium`. |
| Long tool calls time out | Raise the client's tool timeout (Codex `tool_timeout_sec = 600`, Gemini `timeout: 600000`). For builds and runs, use `qa_test_this { mode: "execute" }` and poll `qa_job_status`. |
| `CONSENT_DECLINED` or `CONSENT_CANCELLED` with `likelyAutomatic: true` | A headless client (`codex exec`, `claude -p`) answered the prompt. See [Headless runs](#headless-runs). |
| `adb` or `emulator` not found from a GUI client | Set `ANDROID_HOME` in the server `env`, or install the SDK in its default location. See [How Android tools are found](#how-android-tools-are-found). |
| `INVALID_ARGUMENT` listing accepted parameters | Remove the undeclared argument. If the tool list looks outdated, restart the client. |
| Codex: test credentials, `ANDROID_HOME` or `JAVA_HOME` ignored | Codex only passes a fixed env whitelist to MCP servers. List the names in `env_vars` under `[mcp_servers.swipium]` (see [Codex](#codex)); `qa_doctor` prints the line. |
| Tools missing in Codex Desktop threads | Known Codex Desktop issue ([openai/codex#19425](https://github.com/openai/codex/issues/19425)). Use the Codex CLI. |
| `swipium init cursor --apply` or `init vscode --apply` exits with status 2 | The existing file isn't plain JSON. Add the printed entry by hand. |
| `PHYSICAL_DEVICE_UNSUPPORTED` | A phone was the only device, or was requested explicitly. Start an emulator or simulator. See [physical-devices.md](physical-devices.md). |
