<p align="center">
  <img src="docs/assets/swipium-lockup-ink-on-light.png" alt="Swipium" width="420">
</p>

# Swipium

MCP server for simulator-based mobile QA agents.

[![npm version](https://img.shields.io/npm/v/swipium.svg)](https://www.npmjs.com/package/swipium)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)
[![Platform](https://img.shields.io/badge/platform-Android%20Emulator%20%2B%20iOS%20Simulator-blue.svg)](https://swipium.com)

Swipium lets an AI agent run practical mobile QA from a local MCP client: launch an app in an Android Emulator or iOS Simulator, inspect screens, act on the UI, run smoke checks, collect evidence, build an app knowledge map, generate reports, and create reusable test assets.

Website: [swipium.com](https://swipium.com)

## About

The goal of the MCP is to give your agent a ready-to-use suite of tools so it can test your application using an emulator and real user flows, not directly against the code, with the experience of a QA. Avoid reaching TestFlight or production only to find an error that could have been caught before making the build.

Focused on mobile applications, for now.

## What is Swipium?

Swipium is not a replacement for a test runner. It is an agent-facing QA harness.

It helps an agent answer requests like:

- "Test it."
- "Test this e2e flow."
- "Create test automation for this app."
- "Smoke test this app."
- "Explore the login flow."
- "Generate a report with evidence."
- "Turn this run into a reusable flow."
- "Create an automation suite from what you observed."

The MCP server keeps the workflow deterministic where possible and explicit where risk exists. Heavy steps such as booting simulators, installing apps, writing files, or generating automation are exposed as tools with structured outputs, blockers, artifacts, and consent prompts.

## QuickStart

Run this from the mobile app repository:

```bash
npx -y swipium verify
```

Add Swipium to your agent:

```bash
npm install -g swipium
swipium init claude --apply --scope project
```

Then ask the agent:

```text
Test this app with Swipium. Start with qa_test_this. Use Android Emulator or iOS Simulator only. Generate a report with evidence.
```

For a direct MCP configuration without a global install:

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

## Installation

Run without installing:

```bash
npx -y swipium verify
```

Install globally:

```bash
npm install -g swipium
swipium verify
```

Install in a project:

```bash
npm install --save-dev swipium
npx swipium verify
```

Requirements:

- Node.js 20 or newer.
- Android Studio for Android Emulator workflows.
- Xcode for iOS Simulator workflows.
- A simulator-ready app artifact when testing iOS, such as a simulator `.app`.
- An APK or buildable Android project when testing Android.

## Usage

Start with the autopilot tool:

```text
qa_test_this {
  "projectRoot": "/absolute/path/to/app",
  "mode": "execute",
  "goal": "smoke"
}
```

Common workflow:

1. `qa_doctor` checks local toolchain readiness. Use `platform:"android"`, `platform:"ios"`, or `platform:"both"`.
2. `qa_test_this` resolves the project, artifact, and simulator target.
3. `qa_job_status` polls long-running work.
4. `qa_smoke` or `qa_explore` runs the app.
5. `qa_report` produces the evidence report, including separate app and coverage verdicts.
6. `qa_app_map_read` or `qa_app_map_query` reads the durable app map.
7. `qa_flow_generate`, `qa_suite_generate`, or `qa_automation_generate` creates reusable QA assets.

CLI helpers:

```bash
swipium verify                 # starts the server and checks tool injection
swipium init claude            # preview Claude Code registration
swipium init gemini            # preview Gemini registration
swipium init codex             # preview Codex config
swipium init flows             # create starter flow templates
swipium scan                   # scan project context
swipium suite                  # local suite helper
```

## MCP Server

Swipium runs as a stdio MCP server. MCP clients launch it as a local process and communicate through JSON-RPC over stdin and stdout.

Manual MCP configuration:

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

Installed binary configuration:

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

Important:

- Set `cwd` to the mobile app repository.
- Restart the MCP client after installing or upgrading.
- Run `qa_doctor` if tools are missing or stale.
- Use `qa_get_artifact` for report, screenshot, dump, and log artifacts.

More detail: [docs/mcp-server.md](docs/mcp-server.md)

## Agent Integration

### Claude Code

Global install:

```bash
npm install -g swipium
swipium init claude --apply --scope project
```

No global install:

```bash
claude mcp add swipium --scope project -- npx -y swipium
```

### Gemini CLI

Global install:

```bash
npm install -g swipium
swipium init gemini --apply
```

No global install:

```bash
gemini mcp add swipium npx -y swipium
```

### Codex

Global install:

```bash
npm install -g swipium
swipium init codex --apply
```

Manual Codex config:

```toml
[mcp_servers.swipium]
command = "npx"
args = ["-y", "swipium"]
cwd = "/absolute/path/to/your/mobile-app"
```

After setup, verify that the client lists `qa_test_this`, `qa_capabilities`, and `qa_report`.

## Tool Docs

Swipium v1 exposes 42 public MCP tools. Start with `qa_test_this` for low-context requests.

Full reference: [docs/tools.md](docs/tools.md)

| Group | Tools |
| --- | --- |
| Start | `qa_agent_brief`, `qa_capabilities`, `qa_test_this`, `qa_job_status`, `qa_status`, `qa_explain_blocker`, `qa_continue_from_blocker`, `qa_get_artifact` |
| Setup | `qa_doctor`, `qa_start_session`, `qa_detect_context`, `qa_plan`, `qa_prepare_target`, `qa_prepare_ios_target`, `qa_ios`, `qa_wda` |
| Drive | `qa_snapshot`, `qa_act`, `qa_clear_overlay`, `qa_check_health`, `qa_screenshot`, `qa_note`, `qa_assert_visual` |
| Run | `qa_smoke`, `qa_explore`, `qa_report` |
| App map | `qa_app_map_build`, `qa_app_map_read`, `qa_app_map_query`, `qa_app_map_feature_scope`, `qa_app_map_validate` |
| Flows and suites | `qa_flow_check`, `qa_flow_run`, `qa_flow_generate`, `qa_suite_generate`, `qa_suite_compile`, `qa_testcase_generate` |
| First run | `qa_first_run_plan`, `qa_first_run_continue` |
| Automation | `qa_automation_plan`, `qa_automation_generate`, `qa_automation_validate` |

## Why Swipium?

- Agent-native: exposes QA work as MCP tools with structured outputs.
- Simulator-first: focuses v1 on Android Emulator and iOS Simulator reliability.
- Evidence-first: screenshots, logs, reports, dumps, and artifacts are stored and linked.
- App memory: the app map preserves screens, features, test cases, flows, and coverage context.
- Practical consent: mutating actions are gated instead of hidden behind agent text.
- Reusable output: exploratory runs can become flows, test cases, suites, and generated automation.
- Local by default: the server runs on the developer machine and uses local simulators.

## Docs

- [MCP Server](docs/mcp-server.md)
- [Tool Reference](docs/tools.md)
- [Project Docs Index](docs/README.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
