# MCP Server

Swipium runs as a local stdio MCP server. The MCP client starts the process and sends tool calls over stdin and stdout.

## Requirements

- Node.js 20 or newer.
- Host OS: macOS for iOS Simulator and Android; Linux for Android; Windows for Android is experimental and untested.
- Android: platform-tools (`adb`), the Android Emulator package, and at least one AVD, usually from Android Studio. Swipium resolves `adb`/`emulator` from `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, and the default SDK dir (`~/Library/Android/sdk`, `~/Android/Sdk`, `%LOCALAPPDATA%\Android\Sdk`) before `PATH`, so GUI clients that don't inherit your shell `PATH` still find them.
- iOS: Xcode with an iOS Simulator runtime and at least one simulator. WebDriverAgent is needed for structured UI-tree access, taps, typing, and swipes. Visual-only iOS checks (`qa_visual` baseline/diff, OCR `find_text`, template `find_image`) work through `simctl` without WDA.

## Server Command

`npx -y swipium` is the canonical command (or `swipium` after `npm install -g swipium`). From a source checkout, run `npm run build` and use `node /absolute/path/to/swipium/dist/index.js`.

With no arguments (or `swipium serve`), the binary runs the stdio server. `swipium --help` lists the CLI subcommands, and an unknown subcommand exits with status 2 instead of starting a server.

## Project Root

Tools resolve the app repository in this order:

1. The `projectRoot` tool argument (must be absolute).
2. MCP roots from the client (Claude Code, Cursor, and VS Code provide them).
3. The `SWIPIUM_PROJECT_ROOT` environment variable.
4. `CLAUDE_PROJECT_DIR` (set by Claude Code for every stdio server).
5. The server process's working directory, unless it is `/` or `$HOME`, and only when it contains a project marker (`package.json`, `app.json`, `pubspec.yaml`, Gradle files, `Podfile`, an `.xcodeproj`/`.xcworkspace`, or an `android/` or `ios/` directory).

If none of these resolves, the tool fails with `failureCode: "PROJECT_ROOT_UNRESOLVED"`. On clients without roots or `cwd` support (Claude Desktop, Windsurf), set `SWIPIUM_PROJECT_ROOT` in the server `env`.

## Client Setup

`swipium init <client>` prints the exact registration. Add `--apply` to perform it.

| Client | Command | Where it goes |
| --- | --- | --- |
| Claude Code | `swipium init claude --scope project --apply` or `claude mcp add swipium --scope project -- npx -y swipium` | `.mcp.json` (project), `~/.claude.json` (local/user) |
| Codex | `swipium init codex --apply` (from the app repo, or `--cwd <dir>`) | `~/.codex/config.toml` |
| Gemini CLI | `swipium init gemini --apply` or `gemini mcp add --scope project swipium npx -- -y swipium` | `.gemini/settings.json` (project), `~/.gemini/settings.json` (user) |
| Cursor | `swipium init cursor --apply` | `.cursor/mcp.json` |
| VS Code | `swipium init vscode --apply`, or `code --add-mcp '{"name":"swipium","command":"npx","args":["-y","swipium"]}'` for the user profile | `.vscode/mcp.json` |
| Claude Desktop | manual | `claude_desktop_config.json` |
| Windsurf | manual | `mcp_config.json` (Cascade → MCP settings) |

Anything written to a team-shared project file uses the portable `npx -y swipium`. Machine-local registrations (Claude local/user, Gemini user, Codex) use this machine's `node` and install path, except when Swipium itself runs from the npx cache.

Keys each client supports for a stdio server:

- **Claude Code** (`.mcp.json`): `command`, `args`, `env`, `cwd`, with `${VAR}` / `${VAR:-default}` expansion. Per-tool `timeout` is in ms.
- **Codex** (`[mcp_servers.swipium]`): `command`, `args`, `env`, `cwd`, `startup_timeout_sec` (default 10), `tool_timeout_sec` (default 60). `init codex` sets 30 and 600.
- **Gemini CLI**: `command`, `args`, `env`, `cwd`, `timeout` (ms; default 600000), `trust`.
- **Cursor**: `type`, `command`, `args`, `env`, `envFile`, with `${workspaceFolder}`, `${userHome}`, and `${env:NAME}` interpolation. There is no `cwd` or timeout key.
- **VS Code**: top-level `servers` (not `mcpServers`); `type`, `command`, `args`, `env`, `envFile`, `cwd`, with `${workspaceFolder}`.
- **Claude Desktop**: `command`, `args`, `env`. There is no `cwd` or timeout key.
- **Windsurf**: `command`, `args`, `env`, with `${env:NAME}` interpolation.

Codex manual config:

```toml
[mcp_servers.swipium]
command = "npx"
args = ["-y", "swipium"]
cwd = "/absolute/path/to/your/mobile-app"
startup_timeout_sec = 30
tool_timeout_sec = 600
```

Known caveat: in the Codex Desktop app, custom stdio MCP tools can be discovered by `/mcp` but not exposed to threads ([openai/codex#19425](https://github.com/openai/codex/issues/19425), open). The Codex CLI is not reported as affected.

Cursor (`.cursor/mcp.json`) / VS Code (`.vscode/mcp.json`, with `"servers"` in place of `"mcpServers"`):

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

Claude Desktop / Windsurf:

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

Environment variables (test credentials, OCR provider, SDK paths, elicitation policy) are listed in the README under [Configuration & environment variables](../README.md#configuration--environment-variables).

## Verification

Run:

```bash
swipium verify
```

This starts the server over stdio, checks that every expected tool is listed, prints the tool names, and runs `qa_doctor`. Inside the MCP client, call `qa_doctor`. It defaults to both platforms on macOS (ready if either platform is ready) and to Android elsewhere. Pass `platform:"android" | "ios" | "both"` to be explicit.

If the client lists fewer tools than `swipium verify`, restart the MCP client. Clients often keep an old server process alive after a package upgrade. The current tool list is in [tools.md](tools.md).

## Artifacts

Swipium stores evidence as local artifacts and returns `swipium://` URIs. Use:

- `qa_get_artifact` to read an artifact by URI.
- `qa_report` to generate report artifacts.
- `qa_screenshot` to capture screenshot artifacts.
- `qa_app_map_read` to read app-map sections.

Images default to metadata through `qa_get_artifact`. Request inline mode only when pixels are needed.

## Consent

Swipium requests consent before high-impact local actions such as:

- Booting an Android emulator when required by the plan.
- Installing external app artifacts.
- Writing generated automation into a project directory.
- Running mutating flow steps.

The consent result includes a `consentId`. Re-call the same tool with `approve: true` and that `consentId` to continue.

## Simulator Scope

Public scope supports:

- Android Emulator.
- iOS Simulator.
- Optional WebDriverAgent for structured iOS simulator automation.

The public build does not support real-device execution.
