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
| Codex | Appends a `[mcp_servers.swipium]` block with `cwd` and timeouts (refuses if `--cwd` doesn't exist; leaves an existing block alone) | `~/.codex/config.toml` |
| Gemini CLI | Runs `gemini mcp add --scope project\|user swipium …`; prints a manual block if that fails | `.gemini/settings.json` (project, the default), `~/.gemini/settings.json` (`--scope user`) |
| Cursor | Merges a `swipium` entry under `mcpServers` | `.cursor/mcp.json` (for all projects, add the same entry to `~/.cursor/mcp.json` yourself) |
| VS Code | Merges a `swipium` entry under `servers`; prints a `code --add-mcp …` line for the user profile | `.vscode/mcp.json` |
| Claude Desktop | Not supported by `init`; configure manually | `claude_desktop_config.json` |
| Windsurf | Not supported by `init`; configure manually | `mcp_config.json` (Cascade > MCP settings) |

Which command gets written:

- **Team-shared files** get the portable `npx -y swipium`. That covers Claude `--scope project`,
  Gemini project scope, `.cursor/mcp.json` and `.vscode/mcp.json`.
- **Machine-local registrations** get this machine's `node` and the absolute path of the installed
  `dist/index.js`. That covers Claude local and user scope, Gemini user scope, and Codex. The
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
```

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

- **Response modes.** Pass `responseMode: "compact" | "normal" | "verbose"` on `qa_start_session`
  or `qa_test_this`, and every later call in that session uses it. `compact` shortens only the
  text channel to a summary plus URIs. `structuredContent` always carries the full payload.
- **Artifacts.** Evidence is stored under `~/.swipium/runs/` and returned as `swipium://` URIs.
  `qa_get_artifact` returns metadata for images by default. Pass `mode: "inline"` only when you
  need the pixels.
- **Unknown arguments are rejected.** A top-level argument a tool doesn't declare returns
  `INVALID_ARGUMENT` with the accepted parameter list, and nothing runs. Swipium doesn't silently
  drop it.
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
| Tools missing in Codex Desktop threads | Known Codex Desktop issue ([openai/codex#19425](https://github.com/openai/codex/issues/19425)). Use the Codex CLI. |
| `swipium init cursor --apply` or `init vscode --apply` exits with status 2 | The existing file isn't plain JSON. Add the printed entry by hand. |
| `PHYSICAL_DEVICE_UNSUPPORTED` | A phone was the only device, or was requested explicitly. Start an emulator or simulator. See [physical-devices.md](physical-devices.md). |
