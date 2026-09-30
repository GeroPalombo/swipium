# CI reports

`swipium report` turns a finished Swipium QA run into files that CI systems read:

- `junit`: test-report XML;
- `sarif`: SARIF 2.1.0 for GitHub code scanning;
- `github-summary`: Markdown for `$GITHUB_STEP_SUMMARY`;
- `markdown` and `json`.

A CI pipeline built on Swipium has three parts, and only one of them needs an agent:

| Part | Needs an agent? | What does it |
| --- | --- | --- |
| Boot an emulator, build the app, install it | No | Your CI (for example `reactivecircus/android-emulator-runner`, Gradle, `adb install`) |
| **Drive the app and decide what to check** | **Yes** | An MCP client running an LLM (for example Claude Code headless, `claude -p`) that calls Swipium tools and ends with `qa_report` |
| Render JUnit, SARIF and the summary, and fail the job on the release gate | No | `npx swipium report …`: a deterministic CLI with no device and no LLM |

Swipium is an MCP server, not a test runner. Without an MCP client calling its tools, nothing
exercises the app, and there is no standalone command that runs flows. To replay the same steps on
every run instead of letting the model decide what to check, have the agent step call `qa_flow_run`
on committed flows (see [flows.md](flows.md)); that still runs through an MCP client.

## `swipium report`

```text
swipium report --format <junit|sarif|github-summary|markdown|json>
               [--root <dir>] [--latest | --session <id> | --report <file>]
               [--out <file>] [--fail-on-gate]
```

- **Which report it reads.** It renders the report JSON that `qa_report` (or the end of a
  `qa_test_this` run) saved for a session. Session state lives under
  `~/.swipium/runs/<project-hash>/<session>/`, so run the CLI on the same runner, as the same user,
  after the agent step, and from the same project root the agent used (or pass `--root`).
- **`--latest`** is the default. It picks the newest session for `--root` (default: the current
  directory) that has a saved report, and skips sessions that never produced one.
- **`--session <id>`** picks one session. **`--report <file>`** renders a report JSON you copied
  yourself, for example from a downloaded artifact.
- **Output.** The file goes to stdout, or to `--out` (parent directories are created). The verdict
  line `Release gate: PASS|BLOCK: <reason>` always goes to stderr.
- **Exit codes:**

  | Code | Meaning |
  | --- | --- |
  | `0` | The file was written. The gate passed, or it blocked but `--fail-on-gate` was not set. |
  | `1` | `--fail-on-gate` was set and the release-gate policy blocks. |
  | `2` | Usage error, unknown format, no session or report found, or the file is not a Swipium report. |

- **Secrets.** Raw secret values are never written to disk, so the CLI can't scrub them later.
  Instead, `qa_report` deep-redacts the whole report with the session's registered secrets before
  saving it, and the CLI renders that redacted copy. Every string field is redacted, including step
  summaries, workflow names and next steps.

## GitHub Actions recipe (Android)

This recipe keeps every Swipium consent out of the agent's hands:

- The runner boots the emulator.
- The workflow installs the APK with `adb`, so it is your decision, made in the workflow.
- The agent then uses only tools that need no consent: attach to the running emulator, launch the
  installed app, smoke it, and report.
- `SWIPIUM_REQUIRE_ELICITATION=1` plus `--permission-prompts none` means any unexpected consent
  request is refused instead of approved by the model. The run then reports **blocked** and says
  why.

Prerequisites:

- The repository builds a debug APK with Gradle. Adjust the build command, `APK` and `APP_ID` for
  your project.
- `ANTHROPIC_API_KEY` is a repository secret. Claude Code uses it for the agent step, and
  `--bare` requires an API key rather than a subscription login.
- Claude Code v2.1.259 or later, for `--permission-prompts`. `npm install -g` installs the latest.
- React Native and Expo projects: `qa_prepare_target` expects Metro to be serving before it
  launches the app. In CI, build a variant with the JS bundle embedded (for example a release build
  signed with a debug key), and add `allowLaunchWithoutMetro: true` to the `qa_prepare_target` call
  in the prompt.
- For login flows, provide test accounts through `.swipium/fixtures.json` or the
  `SWIPIUM_TEST_EMAIL` / `SWIPIUM_TEST_PASSWORD` secrets passed into the server's `env`. Without
  them, the agent tests what it can reach before login.

`.github/workflows/swipium-qa.yml`:

```yaml
name: Swipium QA
on: [pull_request]

permissions:
  contents: read
  checks: write # mikepenz/action-junit-report (add pull-requests: write only if you set comment: true)
  security-events: write # github/codeql-action/upload-sarif
  actions: read # upload-sarif on private repositories

jobs:
  qa:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      APK: app/build/outputs/apk/debug/app-debug.apk
      APP_ID: com.example.app # your applicationId
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

      - uses: actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3 # v4.9.1
        with: { distribution: temurin, java-version: '17' }

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with: { node-version: '20' }

      - name: Build debug APK
        run: ./gradlew assembleDebug

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      # Hardware acceleration for the emulator (from the android-emulator-runner README).
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm

      # The emulator only lives while `script` runs, so the agent step runs INSIDE it.
      # android-emulator-runner runs each `script` line as its own shell command, so the
      # logic lives in a script file.
      - name: Agent QA run (needs an LLM)
        uses: reactivecircus/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d # v2.38.0
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          api-level: 34
          arch: x86_64
          target: google_apis
          disable-animations: true
          script: bash .github/scripts/swipium-agent.sh

      # Everything below is deterministic: no emulator, no LLM.
      - name: Swipium JUnit
        if: always()
        run: npx -y swipium report --latest --format junit --out swipium/junit.xml

      - name: Swipium SARIF
        if: always()
        run: npx -y swipium report --latest --format sarif --out swipium/results.sarif

      - name: Swipium job summary
        if: always()
        run: npx -y swipium report --latest --format github-summary >> "$GITHUB_STEP_SUMMARY"

      - name: Publish JUnit
        if: always() && hashFiles('swipium/junit.xml') != ''
        uses: mikepenz/action-junit-report@a9170d5795813c01ab4901ffb045b52bab4ab09d # v6.5.0
        with:
          report_paths: swipium/junit.xml
          include_passed: true

      - name: Upload SARIF to code scanning
        if: always() && hashFiles('swipium/results.sarif') != ''
        uses: github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2
        with:
          sarif_file: swipium/results.sarif
          category: swipium

      # Screenshots and recordings are pixels and are NOT redacted. Drop this step for apps
      # that show real secrets on screen.
      - name: Keep raw evidence
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: swipium-runs
          path: /home/runner/.swipium/runs/ # $HOME on GitHub-hosted ubuntu runners
          retention-days: 14

      # Last step, so every report above is published before the job fails.
      - name: Release gate
        run: npx -y swipium report --latest --format json --out swipium/report.json --fail-on-gate
```

`.github/scripts/swipium-agent.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Install the app yourself. Swipium's own install path is consent-gated, and nobody can
#    approve a consent in CI.
adb wait-for-device
adb install -r -g "$APK"

# 2. Swipium as the only MCP server. SWIPIUM_REQUIRE_ELICITATION=1: an unexpected consent is
#    refused (CONSENT_CANCELLED / CONSENT_REFUSED) instead of self-approved by the model.
cat > "$RUNNER_TEMP/swipium-mcp.json" <<'JSON'
{ "mcpServers": { "swipium": { "command": "npx", "args": ["-y", "swipium"],
  "env": { "SWIPIUM_REQUIRE_ELICITATION": "1" } } } }
JSON

# 3. The agent step. Every call below works without consent on a booted emulator with the app
#    already installed.
claude --bare -p "You are running unattended in CI. An Android emulator is booted and $APP_ID is installed.
Use only the swipium MCP tools. Always pass projectRoot=\"$GITHUB_WORKSPACE\" where a tool accepts it.
1. qa_start_session { projectRoot, profile: \"full_smoke\" }.
2. qa_prepare_target { sessionId, appId: \"$APP_ID\" }. If it returns a jobId, poll qa_job_status { sessionId, jobId, waitMs: 60000 } until it is no longer running.
3. qa_smoke { sessionId }.
4. If any result is requiresConsent, CONSENT_*, needs_input or blocked, do not try to work around it: record it with qa_note and go to step 5.
5. qa_report { sessionId, format: \"summary\" } so the report is saved, then stop." \
  --mcp-config "$RUNNER_TEMP/swipium-mcp.json" \
  --allowedTools "mcp__swipium" \
  --permission-mode dontAsk \
  --permission-prompts none \
  --output-format json > "$RUNNER_TEMP/claude-result.json" || true

# The agent's exit status does not gate the job. `swipium report --fail-on-gate` does.
jq -r '.result // empty' "$RUNNER_TEMP/claude-result.json" || true
```

Notes on the agent step:

- **Claude Code flags.** `claude -p` runs Claude Code without an interactive session.
  - `--bare` skips local hooks, plugins, skills, `CLAUDE.md` and any `.mcp.json` servers, so the
    server from `--mcp-config` is the only MCP server.
  - `--allowedTools "mcp__swipium"` pre-approves every Swipium tool.
  - `--permission-mode dontAsk` denies anything else instead of prompting.
  - `--permission-prompts none` tells Claude nobody can answer prompts, and cancels any MCP
    elicitation request.

  See the Claude Code docs: [headless](https://code.claude.com/docs/en/headless),
  [CLI reference](https://code.claude.com/docs/en/cli-reference) and
  [permissions](https://code.claude.com/docs/en/permissions).
- **Why the recipe avoids `qa_test_this` in CI.** Its execute mode requests one combined consent
  for the privileged steps it plans, and every app install is among them. With nobody to approve,
  it would end blocked. The low-level path above attaches to the running emulator, and an app that
  is already installed skips the install consent.
- **Testing more.** `qa_explore { sessionId }` can follow the smoke. By default it skips
  destructive-looking actions without asking. It asks for consent only when a call names one
  explicit `destructiveCandidate` to run, which the settings above would refuse.
- **Timing** depends on the model and the app. Treat the first runs as calibration, and set
  `timeout-minutes` from them.

## What each file contains

**JUnit** has two suites. The first holds one testcase per recorded workflow, the second one per
finding.

- A workflow `fail` becomes `<failure>`. `blocked`, `skipped` and `not_applicable` become
  `<skipped>`.
- A high-severity finding becomes `<failure>`. Medium and low findings pass, with the detail in
  `<system-out>`.
- A failure that the release-gate policy only warns on (`warnOn`) or suppresses (`ignoreKnown`)
  becomes `<skipped message="policy warned|suppressed (release gate not blocked): …">`, so a gate
  PASS never shows up as a failed test.
- The gate verdict (`swipium.releaseGate`) and reason (`swipium.releaseGate.reason`) are testsuite
  `<properties>`.
- Evidence URIs appear in each testcase's `<system-out>`.
- XML-illegal control characters, such as ANSI escapes and NULs from logcat, are replaced with
  U+FFFD, so strict parsers accept the file.

**SARIF** has one result per finding and one per failed workflow. GitHub code scanning only shows
results that point at a file in the repository, so each result is anchored to the most specific
real file Swipium can justify:

1. the app-map source file of the screen or workflow involved, when `.swipium/app-map.json` exists
   (see `qa_app_map_update`);
2. otherwise the project manifest, in this order: `app.json`, `package.json`, `pubspec.yaml`, the
   Gradle app module, an iOS `Info.plist`, then `README.md`.

Other SARIF details:

- Paths are relative to the repository root, the nearest ancestor with `.git`. In a monorepo an
  anchor reads `apps/mobile/app.json`. Each location has `uriBaseId: %SRCROOT%` and a region on
  line 1.
- The level follows severity: high is `error`, medium is `warning`, low is `note`. Failed workflows
  are `error`.
- Screenshots and other `swipium://` evidence go in `relatedLocations` and `properties`.
- Each result carries its own `partialFingerprints.primaryLocationLineHash`. Volatile ids and
  timestamps are removed before hashing. This keeps distinct results on the same manifest line from
  collapsing into one alert, and keeps alerts stable across runs.
- `invocations[0].executionSuccessful` is `true` whenever Swipium produced the file. The verdict is
  in `runs[0].properties.releaseGateVerdict` (`pass` or `block`), with the full decision in
  `releaseGate`.

See GitHub's
[SARIF support for code scanning](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)
and
[Uploading a SARIF file](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github).

**GitHub summary** contains the verdict, the gate line, finding counts, the top findings, failed or
blocked workflows, and links to the evidence. Text that comes from the run is escaped so it can't
inject Markdown or HTML: the app id, device name, policy reason and next action. GitHub rejects a
step summary over 1 MiB, so the summary stops at about 900 KB and ends with a truncation note.

## From inside an agent session (no CLI)

`qa_report { sessionId, format: "junit" | "sarif" | "github-summary" }` writes the same file as a
session artifact and returns its `exportUri`. Read it with `qa_get_artifact { uri }`. This is useful
when the agent itself publishes the results. In CI, prefer the CLI: it doesn't depend on the agent
remembering to write files.

## Release-gate policy

`.swipium/policy.json` decides the verdict in every export and the `--fail-on-gate` exit code. The
file's other settings, such as `ciAllowMutations`, are described in
[flows.md](flows.md#ci-policy). The gate looks at every failed workflow and every high-severity
finding:

- A failed workflow's code is the failure code of its first failing step, else its category, else
  `UNKNOWN`.
- A finding's code is its failure code, else its kind.

```json
{
  "blockOn": ["native_crash", "anr", "error_boundary"],
  "warnOn": ["missing_test_data", "assertion_failed"],
  "ignoreKnown": []
}
```

Each failure is checked in this order:

1. **No policy file, or one that doesn't parse**: every failure blocks.
2. **`ignoreKnown`**: an exact code match (case and punctuation ignored) is suppressed.
3. **`blockOn`**: a matching code blocks. An empty or missing `blockOn` blocks every failure. The
   token `failed_required_flow` matches every failure, so with it in `blockOn`, `warnOn` never
   applies.
4. **`warnOn`**: a matching code only warns.
5. **Anything else blocks.** A failure the policy doesn't mention is not ignored.

Tokens match failure codes case-insensitively, with punctuation ignored (`native_crash` matches
`NATIVE_CRASH`). A few synonyms also work: `crash` means `NATIVE_CRASH`, `app_bug` and
`visual_diff` mean `ASSERTION_FAILED`. `ciAllowMutations` does not affect the gate.
