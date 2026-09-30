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

Swipium does not run on Appium. It drives devices directly via `adb`, `simctl`, and WebDriverAgent; Appium is one of the export formats for generated tests (`qa_generate` with `target:"appium"`), not the execution engine.

## QuickStart

From your mobile app repository:

```bash
npx -y swipium verify                          # server starts, tools inject, qa_doctor runs
npx -y swipium init claude --scope project     # preview; add --apply to register (writes .mcp.json)
```

Other clients: `swipium init codex | gemini | cursor | vscode` (preview by default, `--apply` to write). Manual configs are in [Agent Integration](#agent-integration).

Then ask the agent:

```text
Use Swipium to smoke test this app on an Android Emulator or iOS Simulator:
run qa_doctor, then qa_test_this with goal "smoke", and finish with qa_report.
```

If the agent reports `PROJECT_ROOT_UNRESOLVED`, add "the project root is /absolute/path/to/app" to the prompt, or set `SWIPIUM_PROJECT_ROOT` in the server config (see [Project root](#project-root)).

## Installation

```bash
npx -y swipium verify              # run without installing
npm install -g swipium             # or install globally: `swipium verify`
npm install --save-dev swipium     # or per project: `npx swipium verify`
```

### Host OS support

| Host | Android Emulator | iOS Simulator |
| --- | --- | --- |
| macOS | Supported | Supported (Xcode required) |
| Linux | Supported | Not available (needs Xcode) |
| Windows | Experimental: untested, and some process-cleanup helpers rely on `ps` | Not available |

### Prerequisites

- Node.js 20 or newer.
- Android: platform-tools (`adb`) and the Android Emulator with at least one AVD (or an emulator already online), usually via Android Studio; plus an APK or a buildable Android project. Swipium looks for `adb`/`emulator` in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, then the default SDK location (`~/Library/Android/sdk` on macOS, `~/Android/Sdk` on Linux, `%LOCALAPPDATA%\Android\Sdk` on Windows) before `PATH`. That matters for GUI clients such as Claude Desktop, which don't inherit your shell `PATH`. Java is only needed for native build-from-source.
- iOS (macOS only): Xcode with an iOS Simulator runtime and at least one simulator, and a simulator `.app`. For taps, typing, and `qa_snapshot` you also need WebDriverAgent: install `appium-webdriveragent`, or configure `ios.wda.derivedDataPath` / `wdaProjectPath`, then let `qa_wda` build and start it.

#### iOS runs in two modes

- **Visual-only** (no WebDriverAgent): install, launch, deep links, screenshots, logs, and visual assertions via `simctl`. `qa_visual` covers visual assertions (`mode:"assert"`), baseline/diff, OCR `find_text`, and template `find_image`. UI-tree snapshots, taps, typing, and swipes are rejected with an error that points to `qa_wda`.
- **Full interaction** (WebDriverAgent running): structured snapshots and input work the same way they do on Android.

Android has full interaction out of the box through `adb`.

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

1. `qa_doctor` checks toolchain readiness. It defaults to both platforms on macOS and Android elsewhere.
2. `qa_test_this` resolves the project, artifact, and simulator target.
3. `qa_job_status` polls long-running work (`waitMs` long-polls until the job finishes).
4. `qa_smoke` or `qa_explore` runs the app.
5. `qa_report` produces the evidence report, with separate app and coverage verdicts.
6. `qa_app_map_read` or `qa_app_map_query` reads the durable app map.
7. `qa_generate` creates reusable QA assets from the run (flow, page objects, POM suite, test cases, or Appium code).

CLI (`swipium --help` lists everything):

```bash
swipium                        # start the stdio MCP server (what clients run; alias: swipium serve)
swipium verify                 # start the server, list its tools, run qa_doctor
swipium init <client>          # claude | codex | gemini | cursor | vscode — preview; --apply to write
swipium init flows             # create starter flow templates
swipium scan [path] [--check]  # readiness report; scaffolds .swipium/ unless BLOCKED or --check/--dry-run
swipium suite lint|compile     # audit / compile a generated POM suite into runnable flows
swipium report --latest --format junit|sarif|github-summary [--out file] [--fail-on-gate]
swipium --version
```

`swipium verify` only reports whether the server starts and its tools inject. Fix hints (platform-tools, Xcode, WebDriverAgent) come from the `qa_doctor` tool inside your MCP client.

## MCP Server

Swipium is a stdio MCP server: the client launches it as a local process and talks JSON-RPC over stdin/stdout. `npx -y swipium` is the canonical command. From a source checkout, run `npm run build` and use `node /absolute/path/to/swipium/dist/index.js` instead.

### Project root

Every tool needs to know which app repository it's testing. Swipium resolves it in this order:

1. The `projectRoot` argument on the tool call.
2. MCP roots, when the client provides them (Claude Code, Cursor, VS Code).
3. `SWIPIUM_PROJECT_ROOT` in the server's environment.
4. `CLAUDE_PROJECT_DIR`, which Claude Code sets automatically.
5. The server's working directory, if it is not `/` or your home directory **and** it contains a project marker (`package.json`, `app.json`, `pubspec.yaml`, Gradle files, `Podfile`, an `.xcodeproj`/`.xcworkspace`, or an `android/` or `ios/` directory). Set it with `cwd` in clients that support it (Codex, Gemini CLI) or with `init --cwd <dir>`.

If none of these resolves, tools fail with `failureCode: "PROJECT_ROOT_UNRESOLVED"`.

After installing or upgrading, restart the MCP client. Run `qa_doctor` if tools are missing or stale. More detail: [docs/mcp-server.md](docs/mcp-server.md).

## Agent Integration

### Claude Code

```bash
swipium init claude --scope project --apply              # or, without installing:
claude mcp add swipium --scope project -- npx -y swipium
```

Project scope writes a portable `.mcp.json` for the team. Local and user scope register this machine's `node` and install path. Claude Code provides MCP roots and `CLAUDE_PROJECT_DIR`, so you don't need to configure a project root.

### Codex

```bash
swipium init codex --apply        # run from your app repo, or pass --cwd <dir>
```

This appends a `[mcp_servers.swipium]` block to `~/.codex/config.toml` that uses this machine's `node` path. To write it by hand instead:

```toml
[mcp_servers.swipium]
command = "npx"
args = ["-y", "swipium"]
cwd = "/absolute/path/to/your/mobile-app"
startup_timeout_sec = 30   # Codex default is 10 s; the first npx run can be slower
tool_timeout_sec = 600     # Codex default is 60 s; builds and simulator boots take longer
```

`codex mcp add swipium --env SWIPIUM_PROJECT_ROOT=/absolute/path/to/app -- npx -y swipium` also works, but it can't set the timeouts, so add those two lines afterwards.

Known caveat: in the Codex Desktop app, tools from custom stdio MCP servers can be discovered but not exposed to threads ([openai/codex#19425](https://github.com/openai/codex/issues/19425), open). If the `qa_*` tools don't appear in Desktop, use the Codex CLI.

### Gemini CLI

```bash
swipium init gemini --apply                        # project scope (.gemini/settings.json), portable
gemini mcp add --scope project swipium npx -- -y swipium
```

`--scope user` registers this machine's `node` path with a `cwd` instead. `settings.json` entries support `command`, `args`, `env`, `cwd`, and `timeout` (ms; default 600000).

### Cursor

```bash
swipium init cursor --apply       # merges into .cursor/mcp.json (preview without --apply)
```

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

Use `.cursor/mcp.json` in the app repo, or `~/.cursor/mcp.json` for all projects.

### VS Code (Copilot agent mode)

```bash
swipium init vscode --apply       # merges into .vscode/mcp.json (preview without --apply)
code --add-mcp '{"name":"swipium","command":"npx","args":["-y","swipium"]}'   # user profile
```

`.vscode/mcp.json` uses a top-level `servers` key:

```json
{
  "servers": {
    "swipium": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "swipium"],
      "env": { "SWIPIUM_PROJECT_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### Claude Desktop

Add the following to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart the app. Claude Desktop has no workspace and no `cwd` setting, so set the project root in `env` or pass `projectRoot` in your prompt:

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

### Windsurf

Add to Windsurf's `mcp_config.json`, which you can open from Cascade's MCP settings. The format uses `mcpServers` with `command`, `args`, and `env`:

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

After setup, confirm the client lists `qa_test_this`, `qa_doctor`, and `qa_report`.

## Configuration & environment variables

Set these in the MCP server's `env` block, or in the shell for CLI commands.

| Variable | Purpose |
| --- | --- |
| `SWIPIUM_PROJECT_ROOT` | Absolute path of the app repo, used when the client provides no MCP roots (see [Project root](#project-root)). |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Android SDK location, checked for `platform-tools/adb`, `emulator/emulator`, and `build-tools/*/aapt2` before `PATH`. |
| `SWIPIUM_TEST_EMAIL`, `SWIPIUM_TEST_USERNAME`, `SWIPIUM_TEST_PASSWORD`, `SWIPIUM_TEST_OTP`, `SWIPIUM_TEST_TOKEN`, `SWIPIUM_TEST_PIN` | Test-account values for login/first-run flows. Flows reference them as `${SWIPIUM_TEST_EMAIL}` etc. and are redacted in outputs. Never inline secrets in flow files. |
| Other `SWIPIUM_*` variables | Flows and `.swipium/fixtures.json` resolve environment variables **only** for names prefixed `SWIPIUM_` (values read from the environment are treated as secrets); any other name (e.g. `${HOME}`, `${AWS_SECRET_ACCESS_KEY}`) is not read from the environment, so a flow from a cloned repo cannot exfiltrate unrelated env vars. |
| `SWIPIUM_RETENTION_DAYS` / `SWIPIUM_RETENTION_KEEP` | Disk retention for `~/.swipium/runs` session directories: age limit (default 30 days; `0` or `off` disables pruning) and how many recent sessions per project are always kept (default 20). See `swipium gc` below. |
| `SWIPIUM_ALLOW_REMOTE_WDA` | Comma-separated list of exact non-loopback WebDriverAgent base URLs you pre-approve. Set it in your MCP client's server environment, never in the repository. |
| `SWIPIUM_OCR_CMD` | OCR provider for `qa_visual` `find_text` (none is bundled). A command whose `{image}` placeholder is replaced by a PNG path and which prints JSON `[{"text","confidence","bbox":{x,y,width,height}}]` in screenshot pixels. `ocrCommand` in `.swipium/config.json` (an argv array) takes precedence. |
| `SWIPIUM_VISUAL_MASK_CMD` | Optional command that masks screenshots before visual providers see them (`visualMaskCommand` in config wins). |
| `SWIPIUM_REQUIRE_ELICITATION=1` | Refuse **every** consent-gated action (builds, Metro, installs, data wipes, seeds, …), not only high-risk ones, when the client can't show a real consent prompt, instead of falling back to the re-call convention. |
| `BUNDLETOOL_JAR` | Path to `bundletool.jar`, for installing `.aab` artifacts. |
| `DEVELOPMENT_TEAM` / `XCODE_DEVELOPMENT_TEAM` | Apple team ID for WebDriverAgent signing (or `ios.wda.developmentTeam` in config). |

Generated flows, suites, and code never contain credential values; they reference placeholders instead. Values the run collected as stored inputs use the canonical `SWIPIUM_TEST_*` names above; other secret fields get a numbered `SWIPIUM_SECRET_N`; generated (non-secret) test data uses `SWIPIUM_GEN_<FIELD>` (e.g. `SWIPIUM_GEN_NAME`). Provide these in the environment when you replay.

**Disk retention.** At startup, and on demand with `swipium gc [--dry-run] [--days N] [--keep N]`, Swipium prunes session directories under `~/.swipium/runs` that are older than `SWIPIUM_RETENTION_DAYS` (default 30) and no longer in the session registry, always keeping the newest `SWIPIUM_RETENTION_KEEP` (default 20) per project. `--dry-run` lists what would be removed; `gc` also drops `~/.swipium/projects.json` entries for projects that no longer exist.

**WebDriverAgent URL.** A non-loopback WDA URL (anything other than `localhost`, `127.0.0.0/8`, or `[::1]`) requires explicit consent (`qa_wda` with `allowNonLoopback:true`); `.swipium/config.json` cannot pre-approve it. The only pre-approval is `SWIPIUM_ALLOW_REMOTE_WDA` in your own MCP client configuration.

Generated Appium code (`qa_generate target:"appium"`) reads its own variables (`SWIPIUM_PLATFORM`, `SWIPIUM_NO_RESET`, `APPIUM_HOST`/`APPIUM_PORT`, `ANDROID_*`, `IOS_*`). Those are documented in the README it generates, not in the server.

## Tool Docs

Start with `qa_test_this` for low-context requests. The full, current list of tools and parameters is in [docs/tools.md](docs/tools.md). `swipium verify` prints exactly which tools your installed version exposes. Release-by-release changes are in the [CHANGELOG](CHANGELOG.md); upgrading from 1.x, see [Migrating from 1.5.0](CHANGELOG.md#migrating-from-150) for renamed and removed tools.

## Why Swipium?

- Agent-native: exposes QA work as MCP tools with structured outputs.
- Simulator-first: focuses on Android Emulator and iOS Simulator reliability.
- Evidence-first: screenshots, logs, reports, dumps, and artifacts are stored and linked.
- App memory: the app map preserves screens, features, test cases, flows, and coverage context.
- Practical consent: mutating actions are gated instead of hidden behind agent text.
- Reusable output: exploratory runs can become flows, test cases, suites, and generated automation.
- Local by default: the server runs on the developer machine and uses local simulators.

## Security

Swipium runs locally as a stdio process: no network listener, no remote service. Destructive actions are consent-gated server-side, and known secret shapes are redacted from snapshots, artifacts, and reports. Trust boundaries, threats, and controls are documented in the [Threat Model](THREAT_MODEL.md). Report vulnerabilities per the [Security Policy](SECURITY.md).

Consent is elicitation-aware: when the connected MCP client supports the elicitation capability, each consent prompt is routed to a real out-of-band user prompt — the server asks the human directly and only an explicit approval runs the gated action, instead of trusting the model to relay approval via a re-call. How each consent was decided — `elicitation` (the human answered an out-of-band prompt), `client-assertion` (the client re-called with approval), or `policy` (the server refused without asking) — is recorded in the session's mutation ledger. Set `SWIPIUM_REQUIRE_ELICITATION=1` to refuse every consent-gated action outright (recorded as `policy`) when the client cannot elicit, rather than falling back to the portable re-call convention.

## Docs

- [MCP Server](docs/mcp-server.md)
- [Tool Reference](docs/tools.md)
- [CI Reports](docs/ci-reports.md)
- [Physical Devices (roadmap)](docs/physical-devices.md)
- [Project Docs Index](docs/README.md)
- [Threat Model](THREAT_MODEL.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
