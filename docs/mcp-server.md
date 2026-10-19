# MCP server reference

Swipium is a local stdio MCP server. Your MCP client starts it as a child process and talks
JSON-RPC over its stdin and stdout. The server itself listens on no network port. The one listener
it can start is a managed WebDriverAgent for iOS: its control port binds the loopback address of
its URL (`127.0.0.1` by default), but its MJPEG screen stream (WDA port + 1000) listens on every
interface, because WebDriverAgent can't restrict it (see [qa_wda](tools.md#qa_wda)).

This page covers client setup, the protocol, and how the server behaves. Sessions, consent and the
project root are explained in [concepts.md](concepts.md); every tool is in [tools.md](tools.md);
environment variables are in the
[README](../README.md#configuration--environment-variables).

**Contents**: [Requirements](#requirements) · [Server command](#server-command) ·
[Client setup](#client-setup) · [Server settings](#server-settings) · [Protocol versions](#protocol-versions) ·
[What the server exposes](#what-the-server-exposes) · [Server behavior](#server-behavior) ·
[Verification](#verification) · [Debugging](#debugging) · [Troubleshooting](#troubleshooting)

## Requirements

- Node.js 22.12 or newer.
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
| `swipium --stdio` (flags only, no subcommand) | Runs the server and warns on stderr that the flags were ignored. `swipium serve <args>` does the same. |
| `swipium init`, `verify`, `scan`, `suite`, `report`, `gc` | CLI subcommands. See `swipium --help`. |
| `swipium <flags> <subcommand>` (for example `swipium -y init claude`) | Exits with status 2 and prints the corrected command (`swipium init claude`) instead of starting a server that ignores the subcommand. The suggestion keeps only flags that subcommand takes (`swipium --apply init claude` suggests `swipium init claude --apply`; `swipium --verbose init` suggests `swipium init`). |
| `swipium <unknown word>` | Prints usage and exits with status 2 instead of starting a server. |

On a Node.js older than 22.12 the server and every subcommand print a warning on stderr first, and
`swipium verify` fails.

## Client setup

`swipium init <client>` prints the exact registration and changes nothing. Add `--apply` to
perform it. After a successful apply it runs `swipium verify`. Options: `--scope local|user|project`
(default `local`) and `--cwd <app dir>` (default: the directory you run it from), as `--flag value`
or `--flag=value`. An unknown option, a flag without its value, an extra argument, or a `--cwd`
that doesn't exist or isn't a directory exits with status 2 and changes nothing, in a preview too
("Refusing to preview: cwd … does not exist"). `swipium init flows` takes only `--root` and
`--force`; a registration flag there (`--scope`, `--apply`, `--cwd`, `--no-skill`,
`--trust-local`) exits 2. A failed apply exits with status 1
(2 for a config file it refuses to edit).

| Client | `swipium init` does | Where it lands |
| --- | --- | --- |
| Claude Code | Runs `claude mcp add swipium [--scope …] -e SWIPIUM_MAX_WAIT_MS=110000 -- <command>` and installs the swipium-qa skill | `local` / `user`: `~/.claude.json`; `project`: `.mcp.json`. Skill: `~/.claude/skills/swipium-qa/SKILL.md` (user scope, or `$CLAUDE_CONFIG_DIR/skills/…`), `.claude/skills/swipium-qa/SKILL.md` (local and project scope) |
| Codex | Appends a `[mcp_servers.swipium]` block with `cwd`, timeouts and `env_vars` (see [Codex](#codex)) and installs the skill | `~/.codex/config.toml` (`$CODEX_HOME/config.toml` when set). Skill: `.agents/skills/swipium-qa/SKILL.md` in `--cwd` |
| Gemini CLI | Runs `gemini mcp add --scope project\|user --timeout 600000 swipium …`; if that fails, merges the entry into the settings file directly (like Cursor) | `.gemini/settings.json` (project, the default), `~/.gemini/settings.json` (`--scope user`) |
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
  `/opt/homebrew/opt/node@22/bin/node`), not the versioned `Cellar` path that `brew upgrade`
  removes; otherwise `init` prefers the `node` on your `PATH` that resolves to the running binary.
  If Swipium itself runs from the npx cache, that path would disappear, so these get
  `npx -y swipium` too.

**The swipium-qa skill.** For `claude` and `codex`, `--apply` also writes the agent skill (the
canonical loop, batching with `qa_flow_run {flowYaml}`, credentials via env, app-control shortcuts
and the CI CLI) and reports it as `created`, `updated` or `unchanged`; the preview prints the path.
`--no-skill` skips it. The same file is served as the MCP resource `skill://swipium-qa/SKILL.md`.
The Claude Code `local` scope is private to you, but its skill still lands in the repository's
`.claude/skills/`, which is usually committed; add `.claude/skills/swipium-qa/` to `.gitignore`, or
pass `--no-skill`, if you don't want it in the repository.

**Re-running `init claude --apply`.** `claude mcp add` never overwrites an existing entry, so `init`
first reads the registration for that scope (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`,
for `local` and `user`; `.mcp.json` for `project`). A matching entry is reported as already
registered (unchanged). A different one (for example after adding `--trust-local`) is left alone:
`init` prints `claude mcp remove swipium --scope <scope>` followed by the add command, and exits
with status 1. A missing `claude` binary is reported as `claude CLI not found on PATH` (status 1).

**`--trust-local`** (Claude Code, `--scope local` or `user` only) adds
`-e SWIPIUM_CONSENT_PREAPPROVE=<list>` with every consent action that runs no repository- or
model-chosen code (except `destructive_ui_candidate`), and prints the list. Boots, installs, data wipes, network and location changes
and screen recordings then run without a prompt; builds, Metro, WebDriverAgent, seed scripts, OCR
commands and destructive UI taps still ask. It is refused (exit 2) with `--scope project`, which writes the team-shared
`.mcp.json`, and for other clients. Rules: [Operator pre-approval](concepts.md#operator-pre-approval).

For Cursor, VS Code and the Gemini fallback, `init` refuses to edit a file that isn't plain JSON
(for example JSONC with comments), prints the entry to add by hand, and exits with status 2. An
existing `swipium` entry is left unchanged.

### Project root

Every tool call works in one app repository. The full resolution order is in
[concepts.md](concepts.md#project-root). For setup, the practical rule: if your client neither
sends MCP roots nor lets you set a `cwd` (Claude Desktop, Windsurf), set `SWIPIUM_PROJECT_ROOT` in
the server `env`. Clients on MCP 2026-07-28 never send roots (see
[Protocol versions](#protocol-versions)); Claude Code covers that by setting `CLAUDE_PROJECT_DIR`.

### Manual configuration

#### Claude Code

```bash
claude mcp add swipium --scope project -e SWIPIUM_MAX_WAIT_MS=110000 -- npx -y swipium
```

`SWIPIUM_MAX_WAIT_MS=110000` lets one `qa_test_this {waitForCompletion:true}` or `qa_job_status`
call wait up to 110 s, which fits Claude Code's longer tool timeout, so most runs finish in one call
(see [Server settings](#server-settings)). Without it every wait ends within about 50 s.

**Plugin.** `plugin/` in the repository is a Claude Code plugin with the same registration
(`npx -y swipium`, `SWIPIUM_MAX_WAIT_MS=110000`) and the skill, listed in the repository's plugin
marketplace: `/plugin marketplace add GeroPalombo/swipium`, then `/plugin install swipium@swipium`.
It never pre-approves consent. See [plugin/README.md](../plugin/README.md).

**MCP Registry.** Swipium is published to the [MCP Registry](https://registry.modelcontextprotocol.io)
as `io.github.GeroPalombo/swipium` (the npm package `swipium`, stdio transport). Clients that install
from the registry run the same `npx -y swipium` command; `SWIPIUM_PROJECT_ROOT`,
`SWIPIUM_TEST_EMAIL` and `SWIPIUM_TEST_PASSWORD` are the optional settings it lists.

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
env_vars = ["SWIPIUM_TEST_EMAIL", "SWIPIUM_TEST_USERNAME", "SWIPIUM_TEST_PASSWORD", "SWIPIUM_TEST_OTP", "SWIPIUM_TEST_PIN", "SWIPIUM_TEST_TOKEN", "SWIPIUM_TEST_DEEP_LINK", "SWIPIUM_VERIFICATION_CODE", "SWIPIUM_PROJECT_ROOT", "SWIPIUM_REQUIRE_ELICITATION", "SWIPIUM_LOG_LEVEL", "SWIPIUM_OCR_CMD", "SWIPIUM_VISUAL_MASK_CMD", "SWIPIUM_RETENTION_DAYS", "SWIPIUM_RETENTION_KEEP", "SWIPIUM_MAX_WAIT_MS", "SWIPIUM_TOOLS", "SWIPIUM_ANDROID_DUMPER", "SWIPIUM_EMULATOR_GPU", "SWIPIUM_EMULATOR_COLD_BOOT", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_SDK_HOME", "ANDROID_USER_HOME", "ANDROID_AVD_HOME", "ANDROID_EMULATOR_HOME", "JAVA_HOME", "JAVA_TOOL_OPTIONS", "GRADLE_USER_HOME", "GRADLE_OPTS", "BUNDLETOOL_JAR", "APPIUM_HOME", "DEVELOPER_DIR", "DEVELOPMENT_TEAM", "XCODE_DEVELOPMENT_TEAM", "WDA_PROJECT_PATH", "WEBDRIVERAGENT_PROJECT", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "CI", "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "CI_COMMIT_SHA", "CI_COMMIT_REF_NAME", "CI_PIPELINE_URL", "BITBUCKET_COMMIT", "BITBUCKET_BRANCH"]
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

What `swipium init codex --apply` does: it refuses if `--cwd` doesn't exist, and refuses a
`config.toml` that doesn't look like valid TOML (status 2, with the offending line and the block to
add by hand). It is a conservative check, not a full TOML parser, so a rare malformed file can
still pass. That check catches an unterminated `"…"` or `'…'` string (also inside a multi-line
array), an invalid escape in a `"…"` string, a bare value that isn't a boolean, number or date, a
key defined twice in one table (dotted and quoted keys included), a `[table]` header defined twice
(`[[array]]` entries are fine), and a table redefined another way (`a.b = 1` and then `[a]`, or
`[[t]]` and then `[t]`), or a header whose brackets don't pair (`[a]]`, `[[a]`). Quoted table names
and keys are accepted with any characters, so the headers Codex writes itself for trusted folders
and plugins (`[projects."/Users/me/app"]`, `[plugins."documents@openai-primary-runtime"]`) and
`"KEY:WITH:COLON" = "x"` keys pass. Otherwise it appends the block above (with this
machine's `node`, the commented `enabled_tools` line, and a few comment lines). If `config.toml`
already has a `[mcp_servers.swipium]` (or `[mcp_servers."swipium"]`) table, it leaves it alone and
says how it differs from the expected one: a different `command`, `args` or `cwd` (a different
`cwd` means Codex keeps testing the other app), `startup_timeout_sec` or `tool_timeout_sec` missing
or below 30 and 600, or no `env_vars` (then it prints just the line to add). A matching table is
reported as matching.

`qa_doctor` adds two rows when the client is Codex (or you pass `qa_doctor { client: "codex" }`):

- `codex-env` lists the Swipium variables the server can see and prints the `env_vars` line. It
  warns when no Android SDK is found (no `ANDROID_HOME`/`ANDROID_SDK_ROOT`, no SDK at the default
  location, no `adb` on `PATH`) or `java -version` fails without `JAVA_HOME`: if you installed the
  SDK or JDK in a custom location, forward `ANDROID_HOME` / `JAVA_HOME`; if not, install it first.
- `codex-tool-timeout` is a reminder only: the server can't read `tool_timeout_sec`, so keep it at
  600 or more.

Codex keeps its own 60 s default per tool call unless `tool_timeout_sec` is raised, so `init codex`
leaves `SWIPIUM_MAX_WAIT_MS` at its 50000 default. Codex shows the model `structuredContent` and
drops images from results that also carry it, so inline images (`qa_screenshot inline:true`,
`qa_get_artifact mode:"inline"`) come without `structuredContent` and with
`_meta["codex/imageDetail"]: "auto"`. To list fewer tools, set `SWIPIUM_TOOLS = "core"` in the
`env` table instead of `enabled_tools` (see [Server settings](#server-settings)).

Codex 0.146 connects on MCP 2025-06-18. Known caveat: in the Codex Desktop app, custom stdio MCP
tools can show up in `/mcp` without being available in threads
([openai/codex#19425](https://github.com/openai/codex/issues/19425)). If that happens, use the
Codex CLI.

#### Gemini CLI

```bash
gemini mcp add --scope project --timeout 600000 swipium npx -- -y swipium
```

The `--` keeps Gemini from reading `-y` as its own flag. The settings entry `init gemini` writes
(or suggests) carries `"timeout": 600000` too. At user scope (`~/.gemini/settings.json`, shared by
every project) no `cwd` is written: Gemini starts the server in the directory you launch `gemini`
from, so Swipium tests that directory.

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

Approving in the chat and re-calling doesn't help in these clients: the re-call's prompt is answered
automatically again, so the operator setting is the only way. Pre-approval is not tied to a device;
when more than one emulator or simulator can be online, also set `SWIPIUM_DEVICE` so approved
actions only ever run on that device ([Device pin](concepts.md#device-pin)).

## Server settings

Swipium passes its environment on to the tools it starts (builds, Metro, xcodebuild, adb, OCR and
mask commands) minus the test credentials: `SWIPIUM_TEST_*`, `SWIPIUM_SECRET_*`, and `SWIPIUM_*`
names with a credential part by the [secret-name rule](flows.md#variables) (`SWIPIUM_API_KEY`,
`SWIPIUM_VERIFICATION_CODE`) are left out. Fixture
seed scripts still get them, because they may sign in with the test account.

Set these in the server's `env` (the complete list of variables is in the
[README](../README.md#configuration--environment-variables)):

| Variable | Default | Effect |
| --- | --- | --- |
| `SWIPIUM_MAX_WAIT_MS` | `50000` | The longest one `qa_job_status` long-poll or `qa_test_this {waitForCompletion:true}` may block, in ms, clamped to 1000 to 230000. The default `waitForCompletion` window is this minus 5000. Set it just under the client's tool timeout: `swipium init claude` and the plugin write `110000`; keep the default for Codex (60 s). `qa_wait` follows the same cap; `qa_act` keeps its 50000 cap. Read on every call. |
| `SWIPIUM_TOOLS` | `all` | `core` lists only the core tools (the set `swipium init codex` suggests for `enabled_tools`); a call to a hidden tool returns `INVALID_ARGUMENT` naming it and `SWIPIUM_TOOLS=all`. Tool counts (`qa_start_session`, the `qa_doctor` freshness check, the `qa_status` orientation, the startup log) then count the listed tools, with the total alongside. Read once per connection; no `list_changed` is sent, so restart the client after changing it. |
| `SWIPIUM_DEVICE` | unset | Pins the server to one device: an adb serial, AVD name, or simulator UDID or exact name (case-insensitive in every tool, never a substring; a simulator name several simulators share is refused with `MULTIPLE_DEVICES`, so pin by UDID). Plans, auto-binding and `qa_ios boot` use only that device, and a call naming another one (including `qa_ios install`, `privacy_reset` or `erase`, `qa_wda` setup, build, start or attach, and `qa_bundletool` install) is refused with `DEVICE_PINNED` before any consent prompt, so `SWIPIUM_CONSENT_PREAPPROVE` only ever applies to it. Set it on shared CI runners. Not in the default Codex `env_vars` list; add it, or set it in `env`. See [Device pin](concepts.md#device-pin). |
| `SWIPIUM_ANDROID_DUMPER` | unset | `agent` reads Android UI trees through a persistent on-device agent instead of `uiautomator dump` (about 2x to 7x faster, depending on host load). It pushes a 6 KB jar to `/data/local/tmp`, needs no APK, and falls back to `uiautomator dump` for 60 s on any failure (with a `warn` log line naming the error). Swipium removes the jar and its `adb forward` when it stops the agent and when the server shuts down. While it runs (up to 120 s after its last dump) other UiAutomation clients such as Appium UiAutomator2 and Maestro can't connect. Set it for apps with screens that never go idle: there `uiautomator dump` gives up after one attempt of about 12 s, while the agent returns a dump within 2 s. See [android-agent/README.md](../android-agent/README.md). |
| `SWIPIUM_EMULATOR_GPU` | `auto` | The `-gpu` mode for emulators Swipium boots. `swiftshader_indirect` (the pre-2.3.0 default) for hosts without a usable GPU, such as Linux CI runners without `/dev/dri`. |
| `SWIPIUM_EMULATOR_COLD_BOOT` | unset | `1` adds `-no-snapshot-load`: a full cold boot that ignores the AVD's snapshot. By default Swipium quick-boots from the AVD's `default_boot` snapshot and never saves over it (`-no-snapshot-save`). When the AVD has no snapshot (or it no longer loads), that boot is cold and Swipium saves one right after `boot_completed` (about 3.5 s, roughly the AVD's RAM size on disk). Measured headless on an Apple Silicon Mac (API 36 AVD, 2 GB RAM): cold boot about 21 to 25 s, quick boot about 3.5 s to the launcher. |

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
  `idempotentHint`. `qa_test_this`, `qa_status`, `qa_act` and `qa_snapshot` carry
  `_meta["anthropic/alwaysLoad"]: true`, so clients with tool search keep them loaded, and `qa_act`,
  `qa_snapshot`, `qa_job_status` and `qa_test_this` declare a permissive `outputSchema`. The tools
  capability is `{ listChanged: false }`: the list never changes while the server runs.
- **Server instructions**: sent on `initialize` (2025) or `server/discover` (2026-07-28), under
  2,000 characters. They give the first call (`qa_test_this { waitForCompletion: true }`, which runs
  by default), the polling loop (`qa_job_status … waitMs: 45000` while the state is `running`),
  reading `report.md` on completion, how to relay `needs_input`, blockers (with the fix the result
  carries) and consent, batching 3 or more known steps in one `qa_flow_run { flowYaml }`, the
  app-control shortcuts, credentials via `SWIPIUM_TEST_EMAIL` / `SWIPIUM_TEST_PASSWORD`, and the
  project-root order. `qa_status` without a `sessionId` returns the same orientation plus the tool
  groups.
- **Prompts** (7): `swipium_setup_check`, `swipium_guardrail_validation`, `swipium_full_smoke`,
  `swipium_bug_repro`, `swipium_test_feature`, `swipium_generate_suite`,
  `swipium_convert_run_to_flow` ([details](tools.md#mcp-resources-and-prompts)).
- **Resources**:
  - `swipium://session/{sessionId}/{kind}/{name}`: session artifacts (screenshots, dumps, reports,
    logs).
  - `swipium://project/{projectId}/app-map`: the full app map.
  - `swipium://project/{projectId}/app-map/{kind}/{id}`: one feature, screen or test-suite section.
  - `skill://swipium-qa/SKILL.md` (`text/markdown`): the swipium-qa agent skill, always listed.

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

Errors carry `what` and `nextSteps`. Their text block is complete in every response mode, because
Claude Code shows the model only the text of an error: it starts with `❌ <failureCode>: <what>`,
lists the next steps, and adds a compact JSON block only for fields the head doesn't show (capped
at 10,000 characters). For successful results the text block stays as a plain-text copy for
clients that read it.

`responseMode` (`compact`, `normal`, `verbose`, set per session) mostly changes the text block, so
on Claude Code and Codex it makes little difference, with one exception: element lists. Outside
`verbose`, the `elements` of `qa_snapshot` and `qa_act` are compact one-line strings such as
`@e3 [button] "Log in" #login_btn [40,200][1040,245]` (a trailing ` -` marks a non-clickable
element), about 40% smaller than one JSON object per element; `verbose` returns the objects. Refs
stay stable while an element stays on screen ([refs and settling](concepts.md#screens-refs-and-settling)). Details: [Response modes](tools.md#response-modes) and
[Element lines](tools.md#element-lines).

### Every call returns within about 50 s

Client tool timeouts are short (Codex defaults to 60 s), so calls that wait are capped below that
by default, and long work runs as a background job:

- `qa_job_status` long-polls at most 50 s (`waitMs`, recommended 45000). Larger values are clamped,
  not rejected.
- `qa_wait`, `qa_act` and `qa_test_this { waitForCompletion: true }` clamp `timeoutMs` to 50000
  with a note (`qa_wait` and `qa_test_this` default to 45000).
- `SWIPIUM_MAX_WAIT_MS` moves the cap for `qa_job_status`, `qa_wait` and `qa_test_this` (1000 to
  230000; the `qa_test_this` default becomes the cap minus 5 s, and the cap covers the whole
  `qa_test_this` call, planning included). Set it only when the client's tool timeout is
  longer; `swipium init claude` writes 110000.
- While `qa_job_status` or `qa_test_this { waitForCompletion: true }` waits, a request that carries
  a `progressToken` gets `notifications/progress` (at most one per second, only when the job's
  progress line changes, with a strictly increasing `progress`). Clients that show progress or reset
  their timeout on progress benefit; nothing is sent without a token.
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

At startup the version and tool count (the listed count under `SWIPIUM_TOOLS=core`) are logged to
stderr, with one `warn` line for each setting that can't be used (an unparseable
`SWIPIUM_MAX_WAIT_MS`, `SWIPIUM_TOOLS` or `SWIPIUM_LOG_LEVEL` falls back to its default). Processes
left behind by a crashed earlier server are reaped in the background, and old session directories
are pruned in the background with a 2 s budget ([Retention](concepts.md#sessions)).

The server shuts down when the client closes stdin (even in the middle of a long call), on
`SIGINT` or `SIGTERM`, or when the transport closes. It then cancels running jobs, restores network
state it changed itself (never a change another server made), and stops screen recorders and
Metro. Build jobs it cancels get up to 2 s to exit before their process groups are killed. Managed
WebDriverAgent keeps running so the next server can reuse it; `qa_wda stop` stops it.

## Verification

```bash
swipium verify
```

This starts a Swipium server over stdio, checks that every tool and prompt this version declares is
listed, prints their names, count and schema hash, and calls `qa_doctor`. Every failed `qa_doctor`
check is printed as `[fail] <name>: <detail> -> <fix>`. It prints `✅ verify OK`, `⚠ verify OK with
warnings` (the environment isn't fully ready), or `❌ verify FAILED`, and exits with status 1 if the
server doesn't start, a tool is missing, `qa_doctor` errors, or Node.js is older than 22.12.
`swipium verify --help` prints its usage; any other argument exits with status 2. It starts the copy
of Swipium you ran it with, not the command your client is configured with. That short-lived
server skips the startup sweep, so it never adopts or reaps a managed WebDriverAgent, Metro or
emulator left by an earlier run.

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
| `swipium: WARNING: Node.js v… is not supported`, or `verify` fails its `node` check | Install Node.js 22.12 or newer and point the client's server command at it (`swipium init` writes this machine's `node` path for local registrations). |
| `swipium init … --apply` exits with status 1 after a re-run | The existing registration differs. Run the printed `claude mcp remove swipium --scope …` and the add command. |
| The client lists fewer or different tools than `swipium verify`, or calls return `STALE_CLIENT` | The client is still running a server it started before the upgrade. Restart the client, or reload its MCP server list. |
| `PROJECT_ROOT_UNRESOLVED` | Pass an absolute `projectRoot`, or set `SWIPIUM_PROJECT_ROOT` in the server `env` (needed on Claude Desktop and Windsurf). |
| The server times out on first start (Codex, Gemini) | The first `npx` run downloads the package. Raise the startup timeout (Codex `startup_timeout_sec = 30`), or install globally and point the client at `swipium`. |
| Long tool calls time out | Raise the client's tool timeout (Codex `tool_timeout_sec = 600`, Gemini `timeout: 600000`). For builds and runs, use `qa_test_this` and poll `qa_job_status`. If you set `SWIPIUM_MAX_WAIT_MS`, keep it below the client's tool timeout. |
| Emulator won't start headless, or screenshots are black | The host has no usable GPU for `-gpu auto`. Set `SWIPIUM_EMULATOR_GPU=swiftshader_indirect` in the server `env`. |
| An emulator boots with an old app or state | Swipium quick-boots from the AVD's snapshot, which restores its RAM and disk: the screen, apps and settings are those of the snapshot, and changes made in earlier Swipium runs are gone (Swipium reinstalls the app). Set `SWIPIUM_EMULATOR_COLD_BOOT=1` for a cold boot, or delete the AVD's snapshot in Android Studio so Swipium saves a fresh one. |
| Screenshots are black and the emulator ignores `adb emu kill` | `SWIPIUM_EMULATOR_GPU=host` with a headless emulator (seen on macOS). Leave it unset (`auto` picks a software renderer when headless). |
| Appium or Maestro report "UiAutomationService already registered" | `SWIPIUM_ANDROID_DUMPER=agent` holds the UiAutomation connection for up to 120 s after its last dump. Wait two minutes or unset the variable. |
| `CONSENT_DECLINED` or `CONSENT_CANCELLED` with `likelyAutomatic: true` | A headless client (`codex exec`, `claude -p`) answered the prompt. See [Headless runs](#headless-runs). |
| `adb` or `emulator` not found from a GUI client | Set `ANDROID_HOME` in the server `env`, or install the SDK in its default location. See [How Android tools are found](#how-android-tools-are-found). |
| `INVALID_ARGUMENT` listing accepted parameters | Remove the undeclared argument. If the tool list looks outdated, restart the client. |
| Codex: test credentials, `ANDROID_HOME` or `JAVA_HOME` ignored | Codex only passes a fixed env whitelist to MCP servers. List the names in `env_vars` under `[mcp_servers.swipium]` (see [Codex](#codex)); `qa_doctor` prints the line. |
| Tools missing in Codex Desktop threads | Known Codex Desktop issue ([openai/codex#19425](https://github.com/openai/codex/issues/19425)). Use the Codex CLI. |
| `swipium init cursor`, `vscode`, `gemini` or `codex --apply` exits with status 2 | The existing file isn't plain JSON (or valid TOML for Codex), or an option was wrong. Add the printed entry by hand, or fix the option. |
| `PHYSICAL_DEVICE_UNSUPPORTED` | A phone was the only device, or was requested explicitly. Start an emulator or simulator. See [physical-devices.md](physical-devices.md). |
