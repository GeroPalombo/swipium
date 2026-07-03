# MCP Server

Swipium runs as a local stdio MCP server. The MCP client starts the process and sends tool calls over stdin and stdout.

## Requirements

- Node.js 20 or newer.
- A mobile app repository as the MCP `cwd`.
- Android platform-tools with `adb` on your PATH, usually from Android Studio.
- Android Emulator package plus at least one AVD for Android Emulator workflows.
- Xcode with an iOS Simulator runtime and at least one simulator for iOS workflows.
- WebDriverAgent for structured iOS UI-tree access, taps, typing, and swipes. Visual-only iOS checks can still use `simctl` without WDA.

## Server Command

No global install:

```jsonc
{
  "mcpServers": {
    "swipium": {
      "command": "npx",
      "args": ["-y", "swipium"],
      "cwd": "/absolute/path/to/your/mobile-app",
      "timeout": 600000
    }
  }
}
```

Global install:

```jsonc
{
  "mcpServers": {
    "swipium": {
      "command": "swipium",
      "args": [],
      "cwd": "/absolute/path/to/your/mobile-app",
      "timeout": 600000
    }
  }
}
```

`npx -y swipium` is the canonical setup for npm users. From a source checkout, build with `npm run build` and use `node /absolute/path/to/swipium/dist/index.js` as the command instead.

## Claude Code

```bash
npm install -g swipium
swipium init claude --apply --scope project
```

No global install:

```bash
claude mcp add swipium --scope project -- npx -y swipium
```

## Gemini CLI

```bash
npm install -g swipium
swipium init gemini --apply
```

No global install:

```bash
gemini mcp add swipium npx -y swipium
```

## Codex

```bash
npm install -g swipium
swipium init codex --apply
```

Manual config:

```toml
[mcp_servers.swipium]
command = "npx"
args = ["-y", "swipium"]
cwd = "/absolute/path/to/your/mobile-app"
```

Known caveat: Codex builds after ~0.120.0 have an open tool-injection regression (openai/codex#19425). Set `cwd` explicitly, and if `qa_*` tools do not appear after setup, switch `command` to an absolute path and restart Codex.

## Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`), then restart Claude Desktop:

```jsonc
{
  "mcpServers": {
    "swipium": {
      "command": "npx",
      "args": ["-y", "swipium"],
      "cwd": "/absolute/path/to/your/mobile-app",
      "timeout": 600000
    }
  }
}
```

## Cursor

Add to `.cursor/mcp.json` in the mobile app repository, or `~/.cursor/mcp.json` for all projects:

```jsonc
{
  "mcpServers": {
    "swipium": {
      "command": "npx",
      "args": ["-y", "swipium"],
      "cwd": "/absolute/path/to/your/mobile-app",
      "timeout": 600000
    }
  }
}
```

## Verification

Run:

```bash
swipium verify
```

Then, inside the MCP client, call:

```text
qa_doctor
qa_capabilities
```

Use `qa_doctor` with `platform:"android"`, `platform:"ios"`, or `platform:"both"` when checking platform-specific readiness.

Expected tool count: 60.

If the client lists fewer tools, restart the MCP client. MCP clients often keep an old server process alive after package upgrades.

## Artifacts

Swipium stores evidence as local artifacts and returns `swipium://` URIs. Use:

- `qa_get_artifact` to read an artifact by URI.
- `qa_report` to generate report artifacts.
- `qa_screenshot` to capture screenshot artifacts.
- `qa_app_map_read` to read app-map sections.

Images default to metadata through `qa_get_artifact`. Request inline mode only when pixels are needed.

## Consent

Swipium requests consent before high-impact local actions such as:

- Booting a simulator when required by the plan.
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
