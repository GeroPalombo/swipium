# MCP server reference

Swipium is a local stdio MCP server. Your MCP client starts it as a child process and talks
JSON-RPC over its stdin and stdout. Nothing listens on the network.

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

## Project root

Every tool call works in one app repository. Swipium takes it from the `projectRoot` argument, then
the client's MCP roots, then `SWIPIUM_PROJECT_ROOT`, then `CLAUDE_PROJECT_DIR`, then the server's
working directory when that looks like an app. The full rules are in
[concepts.md](concepts.md#project-root). For client setup, the practical rule is: if your client
neither sends MCP roots nor lets you set a `cwd` (Claude Desktop, Windsurf), set
`SWIPIUM_PROJECT_ROOT` in the server `env`.

## Client setup

`swipium init <client>` prints the exact registration and changes nothing. Add `--apply` to
perform it. After a successful apply it runs `swipium verify`. Options: `--scope local|user|project`
(default `local`) and `--cwd <app dir>` (default: the directory you run it from).

| Client | `swipium init` does | Where it lands |
| --- | --- | --- |
| Claude Code | Runs `claude mcp add swipium [--scope …] -- <command>` | `local` / `user`: `~/.claude.json`; `project`: `.mcp.json` |
| Codex | Appends a `[mcp_servers.swipium]` block with `cwd`, timeouts and `env_vars` (refuses if `--cwd` doesn't exist; leaves an existing block alone and, if it has no `env_vars`, prints the line to add) | `~/.codex/config.toml` (`$CODEX_HOME/config.toml` when set) |
| Gemini CLI | Runs `gemini mcp add --scope project\|user swipium …`; prints a manual block if that fails | `.gemini/settings.json` (project, the default), `~/.gemini/settings.json` (`--scope user`) |
| Cursor | Merges a `swipium` entry under `mcpServers` | `.cursor/mcp.json` (for all projects, add the same entry to `~/.cursor/mcp.json` yourself) |
| VS Code | Merges a `swipium` entry under `servers`; prints a `code --add-mcp …` line for the user profile | `.vscode/mcp.json` |
| Claude Desktop | Not supported by `init`; configure manually | `claude_desktop_config.json` |
| Windsurf | Not supported by `init`; configure manually | `mcp_config.json` (Cascade > MCP settings) |

Which command gets written:

- **Team-shared files** get the portable `npx -y swipium`. That covers Claude `--scope project`,
  Gemini project scope, `.cursor/mcp.json` and `.vscode/mcp.json`.
- **Machine-local registrations** get this machine's `node` and the absolute path of the installed
  `dist/index.js`. That covers Claude local and user scope, Gemini user scope, and Codex. A
  Homebrew `node` is written as its stable `opt` path (for example `/opt/homebrew/opt/node@20/bin/node`)
  rather than the versioned `Cellar` path that `brew upgrade` removes; otherwise `init` prefers the
  `node` on your `PATH` that resolves to the running binary. The
  exception is when Swipium itself runs from the npx cache; that path would disappear, so these
  also get `npx -y swipium`.

For Cursor and VS Code, `init` refuses to edit a file that isn't plain JSON (for example JSONC with
comments), prints the entry to add by hand, and exits with status 2. An existing `swipium` entry
is left unchanged.

### Manual configuration

Claude Code:

```bash
claude mcp add swipium --scope project -- npx -y swipium
```

Codex (`~/.codex/config.toml`). Codex's defaults of 10 s to start and 60 s per tool call are too
short for a first `npx` run and for builds and boots:

```toml
[mcp_servers.swipium]
command = "npx"
args = ["-y", "swipium"]
cwd = "/absolute/path/to/your/mobile-app"
startup_timeout_sec = 30
tool_timeout_sec = 600
env_vars = ["SWIPIUM_TEST_EMAIL", "SWIPIUM_TEST_USERNAME", "SWIPIUM_TEST_PASSWORD", "SWIPIUM_TEST_OTP", "SWIPIUM_TEST_PIN", "SWIPIUM_TEST_TOKEN", "SWIPIUM_TEST_DEEP_LINK", "SWIPIUM_VERIFICATION_CODE", "SWIPIUM_PROJECT_ROOT", "SWIPIUM_REQUIRE_ELICITATION", "SWIPIUM_LOG_LEVEL", "SWIPIUM_OCR_CMD", "SWIPIUM_VISUAL_MASK_CMD", "SWIPIUM_RETENTION_DAYS", "SWIPIUM_RETENTION_KEEP", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_SDK_HOME", "ANDROID_USER_HOME", "ANDROID_AVD_HOME", "ANDROID_EMULATOR_HOME", "JAVA_HOME", "JAVA_TOOL_OPTIONS", "GRADLE_USER_HOME", "GRADLE_OPTS", "BUNDLETOOL_JAR", "APPIUM_HOME", "DEVELOPER_DIR", "DEVELOPMENT_TEAM", "XCODE_DEVELOPMENT_TEAM", "WDA_PROJECT_PATH", "WEBDRIVERAGENT_PROJECT", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "CI", "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "CI_COMMIT_SHA", "CI_COMMIT_REF_NAME", "CI_PIPELINE_URL", "BITBUCKET_COMMIT", "BITBUCKET_BRANCH"]
# Optional: a smaller tool list. Off by default; `swipium init codex` prints the core list as a comment
# (it includes every tool the server instructions and qa_status point to).
# enabled_tools = ["qa_test_this", "qa_status", ...]
```

**Codex does not pass your shell environment to MCP servers.** A stdio server only gets a fixed
whitelist (`HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `USER`,
`__CF_USER_TEXT_ENCODING` and the CA certificate variables), plus the names in `env_vars` and the
`env = { NAME = "value" }` table of `[mcp_servers.swipium]` (see the
[Codex config reference](https://developers.openai.com/codex/config-reference)). So
`SWIPIUM_TEST_*`, other `SWIPIUM_*` settings, `ANDROID_HOME` and `JAVA_HOME` exported in your shell
never reach Swipium unless they are listed. `env_vars` forwards a name from the environment Codex
was started in (unset names are skipped); `env` sets a literal value. Add any custom `SWIPIUM_*`
flow variables and `ORG_GRADLE_PROJECT_*` signing variables you use. The default list deliberately
leaves out the names that grant approval (`SWIPIUM_CONSENT_PREAPPROVE`, `SWIPIUM_ALLOW_REMOTE_WDA`):
forwarding them would let an inherited shell export, or a per-directory env tool such as direnv in a
cloned repo, pre-approve actions. If you want them, set them literally in `env = { ... }`. `env_vars` is config-only: `codex mcp add --env NAME=value` sets literal
values but cannot forward names, so add the `env_vars` line and the timeouts to `config.toml` after
`codex mcp add`. When Codex is the client (or you pass `qa_doctor { client: "codex" }`), `qa_doctor`
adds a `codex-env` row and prints the `env_vars` line. The row warns when no Android SDK is found
(no `ANDROID_HOME`/`ANDROID_SDK_ROOT`, no SDK at the OS default location, no `adb` on `PATH`) or
`java -version` fails on the server's `PATH` without `JAVA_HOME`: if you installed the SDK or JDK in
a custom location, forward `ANDROID_HOME` / `JAVA_HOME`; if not, install it first. It can't read `tool_timeout_sec`, so it only reminds you to keep it at 600 or more.

Known caveat: in the Codex Desktop app, custom stdio MCP tools can show up in `/mcp` without being
available in threads ([openai/codex#19425](https://github.com/openai/codex/issues/19425)). If that
happens, use the Codex CLI.

Gemini CLI:

```bash
gemini mcp add --scope project swipium npx -- -y swipium
```

The `--` keeps Gemini from reading `-y` as its own flag. `init gemini` also suggests
`"timeout": 600000` in the settings entry.

Cursor (`.cursor/mcp.json`). For VS Code (`.vscode/mcp.json`), use the same entry under a top-level
`"servers"` key instead of `"mcpServers"`. This is the entry `swipium init cursor` and
`swipium init vscode` write:

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

Why the entry sets `SWIPIUM_PROJECT_ROOT` even though these editors can send MCP roots: roots come
first in the resolution order, so when the editor sends them, Swipium uses them and ignores the
variable. The variable is a fallback for an editor version or window that sends no roots. The editor
replaces `${workspaceFolder}` with the open folder; if it is left unexpanded, the value is not an
absolute path and Swipium skips it.

Claude Desktop and Windsurf:

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

Environment variables (test credentials, OCR provider, remote WDA allowlist, elicitation policy,
retention) are listed in the
[README's configuration section](../README.md#configuration--environment-variables).

## What the server exposes

- **Tools**: listed in [tools.md](tools.md). Run `swipium verify` to see the exact list and count
  your installed version serves. Every tool carries MCP annotations: read-only tools set
  `readOnlyHint: true` and `openWorldHint: false`, and the others also set `destructiveHint` and
  `idempotentHint`.
- **Server instructions**: sent on `initialize`. They give the first call
  (`qa_test_this { mode: "execute" }`), the polling loop (`qa_job_status … waitMs`), how to relay
  `needs_input`, blockers and consent, and the project-root order. `qa_status` without a
  `sessionId` returns the same orientation plus the tool groups.
- **Prompts** (5): `swipium_setup_check`, `swipium_guardrail_validation`, `swipium_full_smoke`,
  `swipium_bug_repro`, `swipium_convert_run_to_flow`.
- **Resources**:
  - `swipium://session/{sessionId}/{kind}/{name}`: session artifacts (screenshots, dumps, reports,
    logs).
  - `swipium://project/{projectId}/app-map`: the full app map.
  - `swipium://project/{projectId}/app-map/{kind}/{id}`: one feature, screen or test-suite section.

  `resources/list` shows only the current client's project roots (its MCP roots plus roots of
  sessions in this server process), never lists sensitive-mode sessions, and is capped at 100
  entries per template, with the cap stated on the last entry. Anything not listed can still be
  read by URI. Clients without resource support use `qa_get_artifact` and `qa_app_map_read`.

## Server behavior

- **What the model sees.** Every tool result has a text block and `structuredContent`. Claude Code
  and Codex give the model the `structuredContent` JSON, not the text, for successful results
  (Codex does it for every result that has `structuredContent`; Claude Code shows the text only
  for errors). So successful results put the summary's first line (its headline) first under
  `summary`, and any next-step guidance ("Next: ...", "Call qa_report ...") under `next`, a list
  where each entry starts with the tool to call. The rest of the summary mostly re-renders payload
  fields, so it is left out; results whose later lines say something the payload does not (for
  example `qa_job_status` with the job's result text) keep the whole summary. `next` is left out
  when the payload already has `nextBestAction`, `nextAction`, `nextRecommendedAction` or
  `nextSteps`. Budget stops always carry `next: ["qa_report ..."]`; consent requests carry the
  approval instruction in `next`. Errors carry `what` and `nextSteps`. The text block stays as a
  plain-text copy for clients that read it.
- **Response modes.** Pass `responseMode: "compact" | "normal" | "verbose"` on `qa_start_session`
  or `qa_test_this`, and every later call in that session uses it. The mode only changes the text
  block: `compact` cuts it to the summary plus URIs, `normal` adds a compact JSON copy without the
  keys the summary already rendered, `verbose` adds the full JSON. `structuredContent` is always
  the full payload in every mode, so on Claude Code and Codex the mode makes little difference to
  what the model reads.
- **Artifacts.** Evidence is stored under `~/.swipium/runs/` and returned as `swipium://` URIs.
  `qa_get_artifact` returns metadata for images and other binaries (screen recordings) by
  default. Pass `mode: "inline"` only when you need the bytes. `resources/read` and
  `qa_get_artifact` share the same size caps: text over 1 MB returns the first 1 MB (the last
  1 MB for logs, including `*.log` files such as Metro and WDA logs) with a
  `[swipium: truncated ...]` marker naming the local file to read for the rest, and binaries over
  8 MB are not inlined (you get a note with the size and local path).
  A URI that matches a Swipium template but names nothing that exists (unknown artifact, project
  without an app map, unknown section) fails with JSON-RPC error `-32002` (resource not found).
- **Invalid arguments are rejected.** A top-level argument a tool doesn't declare returns
  `INVALID_ARGUMENT` with the accepted parameter list, and nothing runs. Swipium doesn't silently
  drop it. A missing required argument or a wrong type returns the same typed `INVALID_ARGUMENT`
  envelope, with a per-field `what` (for example `uri: Required`) and `invalidArguments`, instead
  of the SDK's raw validation dump. An unknown tool name stays the SDK's protocol error. Errors
  never echo caller input at full size: argument names and validation paths are cut at 100
  characters (20 listed at most), `what` keeps its first and last part around a marker, every
  string in an error is capped, and an error still over 64 KB drops its extra fields
  (`extraDropped` names them).
- **Stale clients.** A call to a tool removed in 2.0 (`qa_agent_brief`, `qa_capabilities`,
  `qa_next_best_action`, `qa_detect_context`, `qa_plan`, `qa_assert_visual`), or a legacy call
  shape (`qa_ios` `wda_*` or `screenshot` actions, `qa_wait for:"job_done"`), returns
  `STALE_CLIENT` with the replacement call and a hint to restart the client. `qa_doctor` accepts
  `expectedVersion`, `expectedToolCount` and `expectedSchemaHash` and reports a mismatch.
- **Consent.** Privileged actions (builds, boots, installs, data wipes and similar) return
  `requiresConsent` with a `consentId` instead of running. On clients that support MCP elicitation,
  Swipium asks the user directly. How consent works, and what each outcome returns, is in
  [concepts.md](concepts.md#consent); the security reasoning is in
  [THREAT_MODEL.md](../THREAT_MODEL.md).
- **Startup and shutdown.** The version and tool count are logged to stderr at startup, and
  processes left behind by a crashed earlier server are reaped in the background. On shutdown or
  client disconnect, Swipium restores changed network state and stops screen recorders and Metro.
  Managed WebDriverAgent keeps running so the next server can reuse it; `qa_wda stop` stops it.

## Scope

Swipium supports the Android Emulator and the iOS Simulator, with optional WebDriverAgent for
structured iOS automation. Swipium never acts on a physical device. See
[physical-devices.md](physical-devices.md).

## Verification

```bash
swipium verify
```

This starts a Swipium server over stdio, checks that every tool and prompt this version declares is
listed, prints their names, count and schema hash, and calls `qa_doctor`. It exits with status 1 if a tool is missing
or `qa_doctor` errors. It starts the copy of Swipium you ran it with, not the command your client is
configured with.

Inside the client, call `qa_doctor`. It checks both platforms by default on macOS (ready if either
one is) and Android elsewhere. Pass `platform: "android" | "ios" | "both"` to be explicit.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The client lists fewer or different tools than `swipium verify`, or calls return `STALE_CLIENT` | The client is still running a server it started before the upgrade. Restart the client, or reload its MCP server list. |
| `PROJECT_ROOT_UNRESOLVED` | Pass an absolute `projectRoot`, or set `SWIPIUM_PROJECT_ROOT` in the server `env` (needed on Claude Desktop and Windsurf). |
| The server times out on first start (Codex, Gemini) | The first `npx` run downloads the package. Raise the startup timeout (Codex `startup_timeout_sec = 30`), or install globally and point the client at `swipium`. |
| Long tool calls time out | Raise the client's tool timeout (Codex `tool_timeout_sec = 600`, Gemini `timeout: 600000`). For builds and runs, prefer `qa_test_this { mode: "execute" }` plus `qa_job_status` polling. |
| `adb` or `emulator` not found from a GUI client | Set `ANDROID_HOME` in the server `env`, or install the SDK in its default location. See [How Android tools are found](#how-android-tools-are-found). |
| `INVALID_ARGUMENT` listing accepted parameters | Remove the undeclared argument. If the tool list looks outdated, restart the client. |
| Codex: test credentials, `ANDROID_HOME` or `JAVA_HOME` ignored | Codex only passes a fixed env whitelist to MCP servers. List the names in `env_vars` under `[mcp_servers.swipium]` (see [Manual configuration](#manual-configuration)); `qa_doctor` prints the line. |
| Tools missing in Codex Desktop threads | Known Codex Desktop issue ([openai/codex#19425](https://github.com/openai/codex/issues/19425)). Use the Codex CLI. |
| `swipium init cursor --apply` or `init vscode --apply` exits with status 2 | The existing file isn't plain JSON. Add the printed entry by hand. |
| `PHYSICAL_DEVICE_UNSUPPORTED` | A phone was the only device, or was requested explicitly. Start an emulator or simulator. See [physical-devices.md](physical-devices.md). |

## Debugging

Swipium logs JSON lines to stderr only (stdout carries the MCP stream). Set `SWIPIUM_LOG_LEVEL`
in the server `env` to change how much it writes:

| Value | Writes |
| --- | --- |
| `error` | Errors only. |
| `warn` | Errors and warnings. |
| `info` (default) | Startup, shutdown, and notable events. |
| `debug` | Everything above, plus one `tool call` line per call. |

A `tool call` line carries `tool`, `sessionId` (when the call has one), `durationMs`, `isError`,
`failureCode` (on errors) and `cancelled`. Argument values are never logged, since they can hold
secrets. Most clients show server stderr in their MCP logs.
