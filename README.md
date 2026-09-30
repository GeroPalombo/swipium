<p align="center">
  <img src="docs/assets/swipium-lockup-ink-on-light.png" alt="Swipium" width="420">
</p>

# Swipium

An MCP server that lets coding agents QA mobile apps on Android Emulators and iOS Simulators.

[![npm version](https://img.shields.io/npm/v/swipium.svg)](https://www.npmjs.com/package/swipium)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)
[![Platform](https://img.shields.io/badge/platform-Android%20Emulator%20%2B%20iOS%20Simulator-blue.svg)](https://swipium.com)

Swipium gives an AI coding agent (Claude Code, Codex, Gemini CLI, Cursor, VS Code, and other MCP clients) the tools to test your app the way a QA engineer would: build or find the app, boot a simulator, install and launch it, read the screen, tap and type through real user flows, and come back with a report backed by screenshots, logs, and UI dumps. Runs can be turned into repeatable flows, a persistent test suite, and generated Appium code.

It is for mobile developers who want their agent to catch the broken login screen on a local simulator, before a TestFlight or Play Console build.

- **Local.** A stdio process on your machine that drives local simulators. There is no network listener and no cloud service.
- **Direct.** Swipium drives devices through `adb`, `simctl`, and WebDriverAgent. It does not run on Appium; Appium is one of its export formats.
- **Explicit about risk.** Builds, installs, data wipes, and other side effects need your consent, and secrets are redacted from everything Swipium writes.

Website: [swipium.com](https://swipium.com)

## Contents

- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [Client setup](#client-setup)
- [How it works](#how-it-works)
- [Tools](#tools)
- [Configuration & environment variables](#configuration--environment-variables)
- [CLI reference](#cli-reference)
- [CI](#ci)
- [Security](#security)
- [Upgrading from 1.5](#upgrading-from-15)
- [Troubleshooting](#troubleshooting)
- [Disk usage](#disk-usage)
- [Documentation](#documentation)

## Requirements

| Host | Android Emulator | iOS Simulator |
| --- | --- | --- |
| macOS | Supported | Supported (Xcode required) |
| Linux | Supported | Not available (needs Xcode) |
| Windows | Experimental: untested, and some process-cleanup helpers rely on `ps` | Not available |

Swipium works with emulators and simulators only. Physical devices are refused with `PHYSICAL_DEVICE_UNSUPPORTED` (see [docs/physical-devices.md](docs/physical-devices.md)).

- **Node.js 20 or newer.**
- **Android:** platform-tools (`adb`), the Android Emulator, and at least one AVD, usually installed through Android Studio. You also need an APK or a buildable Android project (`.aab` files are converted with bundletool). Swipium looks for `adb` and `emulator` in `$ANDROID_HOME`, then `$ANDROID_SDK_ROOT`, then the default SDK location (`~/Library/Android/sdk` on macOS, `~/Android/Sdk` on Linux, `%LOCALAPPDATA%\Android\Sdk` on Windows), and only then on `PATH`. This matters for GUI clients such as Claude Desktop, which don't inherit your shell `PATH`. Java is needed only to build from source.
- **iOS (macOS only):** Xcode with an iOS Simulator runtime, at least one simulator, and a simulator `.app` (a device `.ipa` is refused). Taps, typing, and UI-tree snapshots also need WebDriverAgent; see [iOS: visual-only and WebDriverAgent](#ios-visual-only-and-webdriveragent).

## Quickstart

**1. Check that the server runs.** From your mobile app repository:

```bash
npx -y swipium verify
```

This starts the server, lists its tools, and runs `qa_doctor`. You can also install it: `npm install -g swipium` (then run `swipium verify`), or `npm install --save-dev swipium` (then `npx swipium verify`).

**2. Register it with your MCP client.** `swipium init <client>` prints the exact registration and changes nothing. Add `--apply` to perform it. For Claude Code:

```bash
npx -y swipium init claude --scope project           # preview
npx -y swipium init claude --scope project --apply   # writes .mcp.json, then runs verify
```

Other clients (`codex`, `gemini`, `cursor`, `vscode`) and manual configs are in [Client setup](#client-setup).

**3. Restart the client** and confirm it lists `qa_test_this`, `qa_doctor`, and `qa_report`.

**4. Ask the agent to test the app:**

```text
Use Swipium to smoke test this app on an Android Emulator or iOS Simulator.
Run qa_doctor, then qa_test_this with mode "execute" and goal "smoke",
poll qa_job_status until the job finishes, and summarize the report.
```

If a tool returns `PROJECT_ROOT_UNRESOLVED`, add "the project root is /absolute/path/to/app" to the prompt, or set `SWIPIUM_PROJECT_ROOT` in the server config (see [Project root](#project-root)).

## Client setup

`swipium init <client> [--apply] [--scope local|user|project] [--cwd <dir>]` supports `claude`, `codex`, `gemini`, `cursor`, and `vscode`. Run it from your app repository, or pass `--cwd <dir>`. Without `--apply` it only prints what it would do. After a successful `--apply` it runs `swipium verify`.

Anything written to a file your team shares (Claude Code project scope, Gemini project scope, `.cursor/mcp.json`, `.vscode/mcp.json`) uses the portable `npx -y swipium`. Machine-local registrations (Claude Code local/user scope, Gemini user scope, Codex) use this machine's `node` and install path, except when `init` itself runs from the npx cache, where they also use `npx -y swipium`.

### Claude Code

```bash
swipium init claude --scope project --apply
# or, directly:
claude mcp add swipium --scope project -- npx -y swipium
```

Project scope writes `.mcp.json`. The default scope is `local`. Claude Code provides MCP roots and `CLAUDE_PROJECT_DIR`, so no project-root setting is needed.

### Codex

```bash
swipium init codex --apply        # from your app repo, or pass --cwd <dir>
```

This appends a `[mcp_servers.swipium]` block to `~/.codex/config.toml` (and leaves an existing one unchanged). To write it by hand:

```toml
[mcp_servers.swipium]
command = "npx"
args = ["-y", "swipium"]
cwd = "/absolute/path/to/your/mobile-app"
startup_timeout_sec = 30   # Codex default is 10 s; the first npx run can be slower
tool_timeout_sec = 600     # Codex default is 60 s; builds and simulator boots take longer
```

`codex mcp add swipium --env SWIPIUM_PROJECT_ROOT=/absolute/path/to/app -- npx -y swipium` also works, but it can't set the timeouts, so add those two lines afterwards.

Known issue: in the Codex Desktop app, tools from custom stdio MCP servers can be discovered but not exposed to threads ([openai/codex#19425](https://github.com/openai/codex/issues/19425)). If the `qa_*` tools don't appear there, use the Codex CLI.

### Gemini CLI

```bash
swipium init gemini --apply
# or, directly:
gemini mcp add --scope project swipium npx -- -y swipium
```

The default registers the server in the project's `.gemini/settings.json`. `--scope user` registers this machine's `node` path in `~/.gemini/settings.json`. If `gemini mcp add` fails or isn't installed, `init` prints the `settings.json` entry to add by hand; entries support `command`, `args`, `env`, `cwd`, and `timeout` (milliseconds; `init` uses 600000).

### Cursor

```bash
swipium init cursor --apply       # merges into .cursor/mcp.json
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

`init` only writes the project file. To enable Swipium in every project, add the same entry to `~/.cursor/mcp.json`.

### VS Code (Copilot agent mode)

```bash
swipium init vscode --apply       # merges into .vscode/mcp.json
code --add-mcp '{"name":"swipium","command":"npx","args":["-y","swipium"]}'   # user profile instead
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

For Cursor and VS Code, `--apply` never overwrites: it refuses to edit a file that isn't plain JSON (for example one with comments) and prints the entry to add by hand, and it leaves an existing `swipium` entry unchanged.

### Claude Desktop

Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart the app. Claude Desktop has no workspace and no `cwd` setting, so set the project root in `env`, or name it in your prompt:

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

Add the same block to Windsurf's `mcp_config.json`, which you can open from Cascade's MCP settings:

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

### From a source checkout

Run `npm ci && npm run build`, then use `node /absolute/path/to/swipium/dist/index.js` as the command in any of the configs above.

## How it works

### The autopilot loop

Most requests need only three tools:

1. **`qa_test_this`** resolves the project, finds or builds an artifact, picks or boots a simulator, installs and launches the app, runs a smoke check (plus exploration or suite generation, depending on `goal`), and writes a report. The default `mode:"plan"` has no side effects and shows what would happen. `mode:"execute"` starts a background job and returns a `jobId`. `goal` is one of `smoke` (default), `explore`, `create_automation_suite`, `release_gate`, `test_login`, or `reproduce_bug`.
2. **`qa_job_status`** polls the job. `waitMs` (up to 120000) long-polls until the job finishes. The run ends as `completed`, `blocked`, `unsafe`, or `needs_input`; a `needs_input` result (for example a login form that needs credentials) carries the question and a resume call to `qa_continue_from_blocker`.
3. **`qa_report`** (or `qa_get_artifact` on the returned `reportUri`) gives the evidence report, with separate verdicts for the app and for how much of it was covered.

When something fails, the result carries a `failureCode`; `qa_explain_blocker` explains any code. `qa_status` without arguments returns the operating rules and tool groups; with a `sessionId` it returns the single next call to make. For hands-on work, open a session with `qa_start_session` and use the lower-level tools directly. The server also ships MCP prompts for common workflows (setup check, smoke test, bug reproduction, turning a run into a flow).

### Project root

Every tool needs to know which app repository it is testing. Swipium resolves it in this order, and the first match wins:

1. The `projectRoot` argument on the tool call. It must be an absolute, existing directory; an invalid value is an error, not a fallback.
2. MCP roots, when the client provides them.
3. `SWIPIUM_PROJECT_ROOT` in the server's environment.
4. `CLAUDE_PROJECT_DIR`, which Claude Code sets automatically.
5. The server's working directory, but only if it is not `/` or your home directory **and** it contains a project marker: `package.json`, `app.json`, `pubspec.yaml`, a Gradle build or settings file, `Podfile`, an `.xcodeproj`/`.xcworkspace`, or an `android/` or `ios/` directory. Clients that support a `cwd` setting (Codex, Gemini CLI) land here.

If nothing resolves, tools fail with `PROJECT_ROOT_UNRESOLVED`. Results report which source was used as `rootSource`.

### Consent

Actions with side effects, such as booting an emulator, installing an app, building from source, starting Metro, running OCR or seed commands, wiping app data, or changing the network, are gated by consent on the server side:

- **If your client supports MCP elicitation**, Swipium asks you directly in a prompt that the model cannot answer for you. Only an explicit approval runs the action. Declining returns `CONSENT_DECLINED`; dismissing the prompt, a 10-minute timeout, or an aborted call returns `CONSENT_CANCELLED`.
- **Otherwise**, the tool returns a `requiresConsent` result with a `consentId`. The agent shows it to you and re-calls the tool with `consentId` and `approve:true` after you agree.
- Set **`SWIPIUM_REQUIRE_ELICITATION=1`** to refuse every consent-gated action (`CONSENT_REFUSED`) when the client can't show a real prompt, instead of relying on the re-call.

A consent is single-use, bound to the exact action and target, and bound to the session it was issued in. How each action was approved (`elicitation`, `client-assertion`, or `policy`) is recorded in the session's mutation ledger, which appears in the report.

### Sensitive mode

`qa_start_session { sensitive: true }` refuses every screenshot, screen recording, and on-screen log capture for that session (`SENSITIVE_MODE_REFUSED`). Structured UI snapshots and health checks still work. Outside sensitive mode, captures are also withheld while a password or OTP field is on screen (`CAPTURE_WITHHELD_SECURE`), because pixels cannot be redacted.

### iOS: visual-only and WebDriverAgent

Android has full interaction out of the box through `adb`. iOS runs in one of two modes:

- **Visual-only (no WebDriverAgent).** Install, launch, deep links, screenshots, logs, and visual checks through `simctl`. `qa_visual` handles visual assertions (`mode:"assert"`), baselines and diffs, OCR text search (`find_text`, needs an [OCR command](#configuration--environment-variables)), and template matching (`find_image`). Taps from `qa_visual` use `idb` when it is on `PATH`. UI-tree snapshots, `qa_act` taps, typing, and swipes return `BACKEND_UNSUPPORTED` with a pointer to `qa_wda`. `qa_test_this` falls back to a visual-only smoke run when WebDriverAgent isn't ready.
- **Full interaction (WebDriverAgent running).** Structured snapshots and input work as they do on Android.

`qa_wda` manages WebDriverAgent: `status`, `doctor`, `diagnose`, `build`, `start`, `stop`, `attach`, `logs`, and `tune`. `build` and `start` use the `wdaProjectPath` you pass, or else an Appium-installed WebDriverAgent (`appium-webdriveragent` under `$APPIUM_HOME`, `~/.appium`, or global npm). Signing uses `ios.wda.developmentTeam` in `.swipium/config.json`, or `DEVELOPMENT_TEAM` / `XCODE_DEVELOPMENT_TEAM`.

A WebDriverAgent that Swipium starts keeps running when the server shuts down, so a resumed iOS session can keep using it. On the next start, Swipium adopts it only if it is less than 12 hours old and its `/status` reports ready; otherwise it stops it. Processes are matched by start time and command line, so a recycled PID or a WebDriverAgent you started yourself is never touched. `qa_wda { action: "stop" }` stops it explicitly.

WebDriverAgent URLs outside loopback (`localhost`, `127.0.0.0/8`, `[::1]`) require `allowNonLoopback:true` plus consent. The repository's `.swipium/config.json` cannot pre-approve one; only `SWIPIUM_ALLOW_REMOTE_WDA` in your own client configuration can.

### What Swipium writes

- **In your project:** `.swipium/` holds the app map, flows, the test suite (`.swipium/test-suite.json`), the issue ledger, visual baselines, and generated files. When the project is a Git repository, Swipium adds `.swipium/` to `.gitignore`. You can also put configuration there: `config.json` (WebDriverAgent, OCR, masking), `fixtures.json` (test preconditions and data), and `policy.json` (the release gate).
- **In your home directory:** `~/.swipium/runs/` holds per-session evidence (screenshots, logs, dumps, reports), which tools return as `swipium://` URIs. See [Disk usage](#disk-usage).

## Tools

Tools are grouped by capability. `qa_status` (with no arguments) returns the same groups. The full reference, with parameters and behavior for each tool, is in **[docs/tools.md](docs/tools.md)**, and `swipium verify` prints the exact list your installed version exposes.

| Group | Purpose | Tools |
| --- | --- | --- |
| Start | Autopilot, orientation, job polling, blockers, artifacts | `qa_test_this`, `qa_status`, `qa_job_status`, `qa_job_cancel`, `qa_explain_blocker`, `qa_continue_from_blocker`, `qa_get_artifact` |
| Setup | Check the toolchain, open a session, prepare an emulator or simulator | `qa_doctor`, `qa_start_session`, `qa_prepare_target`, `qa_prepare_ios_target`, `qa_ios`, `qa_wda` |
| Build | Pick a target, find an artifact, or build one from source | `qa_resolve_target`, `qa_resolve_artifact`, `qa_build`, `qa_bundletool` |
| Device | Inspect and control the device and app environment | `qa_device_info`, `qa_orientation`, `qa_geolocation`, `qa_network`, `qa_metro`, `qa_app_control`, `qa_screen_record` |
| Drive | Observe, act, assert, and collect evidence | `qa_snapshot`, `qa_inspect`, `qa_act`, `qa_clear_overlay`, `qa_check_health`, `qa_screenshot`, `qa_note`, `qa_visual`, `qa_wait` |
| Run | Smoke checks, guided exploration, reports | `qa_smoke`, `qa_explore`, `qa_report` |
| App map | The durable app knowledge map (project memory) | `qa_app_map_build`, `qa_app_map_read`, `qa_app_map_query`, `qa_app_map_feature_scope`, `qa_app_map_update` |
| Feature | Test one feature by name | `qa_test_feature` |
| Flows | Validate, run, compile, and repair repeatable flows | `qa_flow_check`, `qa_flow_run`, `qa_flow_compile`, `qa_flow_repair` |
| Generate | Flows, page objects, a POM suite, test cases, or Appium code from a recorded run | `qa_generate` |
| Test suite | The repo-level test suite (`.swipium/test-suite.json`) | `qa_suite_read`, `qa_suite_update`, `qa_suite_generate`, `qa_suite_export`, `qa_suite_lint` |
| Issues | Durable issue ledger and release audits | `qa_issue_log`, `qa_mobile_audit` |
| First run | Login, sign-up, onboarding, and paywall screens | `qa_first_run` |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint:false`), so clients can auto-approve the read-only ones.

## Configuration & environment variables

Set these in the MCP server's `env` block, or in your shell for CLI commands.

| Variable | Purpose |
| --- | --- |
| `SWIPIUM_PROJECT_ROOT` | Absolute path of the app repository, used when the client provides no MCP roots (see [Project root](#project-root)). |
| `CLAUDE_PROJECT_DIR` | Set by Claude Code. Used as the project root when no argument, MCP root, or `SWIPIUM_PROJECT_ROOT` applies. |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | Android SDK location, searched for `adb`, `emulator`, and `aapt2` before `PATH`. |
| `BUNDLETOOL_JAR` | Path to `bundletool.jar`, used to convert `.aab` files into an installable APK. A `bundletool` launcher on `PATH` also works. |
| `DEVELOPMENT_TEAM`, `XCODE_DEVELOPMENT_TEAM` | Apple team ID for signing WebDriverAgent (`ios.wda.developmentTeam` in `.swipium/config.json` takes precedence). |
| `APPIUM_HOME` | Extra location searched for an Appium-installed WebDriverAgent (besides `~/.appium` and global npm). |
| `WDA_PROJECT_PATH`, `WEBDRIVERAGENT_PROJECT` | Extra `WebDriverAgent.xcodeproj` candidates reported by `qa_doctor` and `qa_wda` status checks. To build or start from a specific project, pass `wdaProjectPath` to `qa_wda`. |
| `SWIPIUM_ALLOW_REMOTE_WDA` | Comma-separated list of exact non-loopback WebDriverAgent base URLs you pre-approve. Set it in your client configuration, never in the repository. |
| `SWIPIUM_TEST_EMAIL`, `SWIPIUM_TEST_USERNAME`, `SWIPIUM_TEST_PASSWORD`, `SWIPIUM_TEST_OTP`, `SWIPIUM_TEST_TOKEN`, `SWIPIUM_TEST_PIN` | Test-account values. Flows reference them as `${SWIPIUM_TEST_EMAIL}`, and `.swipium/fixtures.json` fields as `"var": "SWIPIUM_TEST_EMAIL"`. They are redacted from all output. You can also answer a credentials question through `qa_continue_from_blocker`. |
| Any other `SWIPIUM_*` name | Flows and `.swipium/fixtures.json` read environment variables **only** when the name starts with `SWIPIUM_`, and treat those values as secrets. Any other name (such as `${HOME}` or `${AWS_SECRET_ACCESS_KEY}`) is never read from the environment, so a flow from a cloned repository can't pull in unrelated variables. |
| `SWIPIUM_OCR_CMD` | OCR command for `qa_visual` `find_text`; none is bundled. `{image}` is replaced with a PNG path, and the command must print JSON `[{"text","confidence","bbox":{x,y,width,height}}]` in screenshot pixels. `ocrCommand` in `.swipium/config.json` (an argv array) takes precedence. Running it asks for consent. |
| `SWIPIUM_VISUAL_MASK_CMD` | Optional command that masks screenshots before OCR and other visual providers see them. `visualMaskCommand` in `.swipium/config.json` takes precedence. |
| `SWIPIUM_REQUIRE_ELICITATION=1` | Refuse every consent-gated action when the client can't show a real consent prompt (see [Consent](#consent)). |
| `SWIPIUM_RETENTION_DAYS` | Age limit for session directories in `~/.swipium/runs` (default 30). `0` or `off` turns off the automatic prune at startup; `swipium gc` still works. |
| `SWIPIUM_RETENTION_KEEP` | Number of most recent sessions per project that are always kept (default 20). |
| `CI` | When set, reports label the run environment as CI. |

**Placeholders in generated output.** Generated flows, suites, and code never contain credential values. Collected inputs use the `SWIPIUM_TEST_*` names above, other secret fields get a numbered `SWIPIUM_SECRET_N`, and generated (non-secret) test data uses `SWIPIUM_GEN_<FIELD>` (for example `SWIPIUM_GEN_NAME`). Provide these in the environment when you replay.

Generated Appium projects (`qa_generate target:"appium"`) read their own variables (`SWIPIUM_PLATFORM`, `SWIPIUM_NO_RESET`, `APPIUM_HOST`, `APPIUM_PORT`, `ANDROID_*`, `IOS_*`), which the README they include documents.

## CLI reference

With no subcommand, `swipium` runs the stdio MCP server, which is what MCP clients launch. `swipium --help` prints this list.

| Command | What it does |
| --- | --- |
| `swipium` (alias `swipium serve`) | Start the stdio MCP server. Unrecognized flags alone (such as `--stdio`) are ignored with a warning and the server starts; an unknown subcommand prints usage and exits 2. |
| `swipium init <client> [--apply] [--scope local\|user\|project] [--cwd <dir>]` | Preview (default) or apply the MCP registration for `claude`, `codex`, `gemini`, `cursor`, or `vscode`. See [Client setup](#client-setup). |
| `swipium init flows [--root <dir>] [--force]` | Write starter flow templates into `.swipium/flows/`. Existing files are kept unless you pass `--force`. |
| `swipium verify` | Start the server over stdio, check that every tool is listed, and run `qa_doctor`. |
| `swipium scan [path] [--check \| --dry-run \| --no-write]` | Print a readiness report for a project. It creates `.swipium/` unless the result is `BLOCKED` or you pass one of the no-write flags. |
| `swipium suite <lint\|compile\|init> [projectRoot] [--suite suites/smoke.yaml]` | `lint` audits generated page objects for brittle locators, `compile` turns a POM suite into runnable flows under `.swipium/flows/`, and `init` explains how to create a suite. |
| `swipium report --format junit\|sarif\|github-summary\|markdown\|json` | Render a run's report for CI. Options: `--latest` (default), `--session <id>`, or `--report <file>`; `--root <dir>`; `--out <file>`; `--fail-on-gate`. Exits 0 on success, 1 when `--fail-on-gate` is set and the release gate blocks, and 2 on a usage error or when no report is found. |
| `swipium gc [--dry-run] [--days N] [--keep N]` | Delete old session directories and stale project entries. See [Disk usage](#disk-usage). |
| `swipium --help` / `-h`, `swipium --version` / `-v` | Print usage or the version. |

`swipium verify` only checks that the server starts and its tools load. Setup problems (platform-tools, Xcode, WebDriverAgent) and how to fix them come from `qa_doctor`, which it runs and which you can also call from your client.

## CI

`swipium report` renders a finished run as JUnit XML, SARIF 2.1.0, a GitHub job summary, Markdown, or JSON, and `--fail-on-gate` fails the job when the release-gate policy in `.swipium/policy.json` blocks. A CI run still needs an agent (for example Claude Code in headless mode) to drive the app; for deterministic replays, run a compiled flow suite instead. See **[docs/ci-reports.md](docs/ci-reports.md)** for a GitHub Actions recipe.

## Security

Swipium runs as a local stdio process with no network listener. Actions with side effects are consent-gated on the server side, known secret values are redacted from snapshots, artifacts, and reports, and generated output is checked for leaked secrets. Swipium refuses to run `git`, including from repo-supplied seed and provider commands, and it treats a cloned repository's `.swipium/` directory as untrusted input: repo-supplied commands are shown verbatim in the consent prompt, and flows can read only `SWIPIUM_*` environment variables.

Screenshots and recordings are pixels and are never redacted; use [sensitive mode](#sensitive-mode) when that matters. Trust boundaries, threats, and controls are in the [Threat Model](THREAT_MODEL.md). Report vulnerabilities privately as described in the [Security Policy](SECURITY.md).

## Upgrading from 1.5

2.0.0 removes and renames several tools; the [migration table in the CHANGELOG](CHANGELOG.md#migrating-from-150) lists the replacement for each. The same table is at the end of [docs/tools.md](docs/tools.md).

After upgrading, **restart your MCP client**. Clients often keep the old server process running, and an agent calling a removed tool or an old call shape gets `STALE_CLIENT`.

## Troubleshooting

Every error includes a `failureCode`, `nextSteps`, and whether a retry is safe. `qa_explain_blocker { failureCode }` explains any code, and `qa_doctor` checks the whole toolchain.

| `failureCode` | What it means | What to do |
| --- | --- | --- |
| `PROJECT_ROOT_UNRESOLVED` | Swipium couldn't tell which app to test. | Pass `projectRoot` (absolute) in the prompt, or set `SWIPIUM_PROJECT_ROOT` in the server `env` or a `cwd` where the client supports it. See [Project root](#project-root). |
| `ADB_NOT_FOUND` | Android platform-tools aren't installed or can't be found. | Install platform-tools and the emulator (Android Studio SDK Manager), and set `ANDROID_HOME` in the server `env` if they're in a non-default location. |
| `NO_DEVICE` | No emulator is online and none can be booted. | Create an AVD (Android Studio Device Manager) or an iOS Simulator (Xcode), then re-run `qa_test_this`; it boots it for you. |
| `PHYSICAL_DEVICE_UNSUPPORTED` | The only device available is a real phone. | Expected: Swipium works with emulators and simulators only. Start an emulator, or unplug the phone if it was picked by accident. |
| `DEVICE_NOT_READY` | The device exists but hasn't finished booting or is locked. | Wait for boot to finish and unlock it, then retry. |
| `WDA_UNREACHABLE` | WebDriverAgent isn't running or isn't answering. | Run `qa_wda { action: "status" }` or `"logs"`, then `start` or `attach`. For a plain smoke check, run `qa_test_this` with `goal:"smoke"`, which works visual-only. |
| `BACKEND_UNSUPPORTED` | The action isn't available on this backend, typically iOS without WebDriverAgent. | Attach WebDriverAgent with `qa_wda`, or use `qa_visual` and `qa_ios` instead. |
| `OCR_NOT_CONFIGURED` | `qa_visual` `find_text` has no OCR command. | Set `ocrCommand` in `.swipium/config.json` or `SWIPIUM_OCR_CMD` (the error includes a tesseract example), or use `find_image`. |
| `STALE_CLIENT` | The client is using a server started before an upgrade, or an old tool name or call shape. | Restart the MCP client. See [Upgrading from 1.5](#upgrading-from-15). |
| `CONSENT_DECLINED` | You declined the consent prompt. Nothing ran. | Don't retry unless you want the action. |
| `CONSENT_CANCELLED` | The prompt was dismissed, timed out, or failed. Nothing ran. | Re-call the tool to get a fresh prompt. |
| `CONSENT_REFUSED` | `SWIPIUM_REQUIRE_ELICITATION=1` is set and the client can't show consent prompts. | Use a client that supports MCP elicitation, or unset the variable. |

If the client lists fewer tools than `swipium verify` prints, restart it. If `adb` works in your terminal but not from a GUI client, set `ANDROID_HOME` in the server's `env` block; GUI clients don't inherit your shell `PATH`.

## Disk usage

Session evidence lives in `~/.swipium/runs/`. At startup, Swipium deletes session directories whose last activity is older than `SWIPIUM_RETENTION_DAYS` (default 30), except sessions still listed in `~/.swipium/registry.json` and the newest `SWIPIUM_RETENTION_KEEP` (default 20) per project.

To clean up on demand:

```bash
swipium gc --dry-run          # show what would be deleted
swipium gc --days 7 --keep 5  # delete, with custom thresholds
```

`gc` also removes entries from `~/.swipium/projects.json` whose project directory no longer exists. Project-level data in `<app>/.swipium/` (app map, flows, test suite, baselines) is never pruned automatically.

## Documentation

- [Tool reference](docs/tools.md): every tool, its parameters, and its behavior.
- [MCP server](docs/mcp-server.md): server command, project root, client setup, verification.
- [CI reports](docs/ci-reports.md): JUnit, SARIF, and GitHub summaries, and the release gate.
- [Physical devices](docs/physical-devices.md): why real devices are out of scope today.
- [Threat model](THREAT_MODEL.md) and [security policy](SECURITY.md).
- [Changelog](CHANGELOG.md).
- [Contributing](CONTRIBUTING.md) and [support](SUPPORT.md).

## License

MIT. See [LICENSE](LICENSE).
