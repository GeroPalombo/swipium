# CI reports

Swipium can turn a QA run into CI-native files: `junit` (test-report XML), `sarif` (SARIF 2.1.0
for GitHub code scanning), `github-summary` (Markdown for `$GITHUB_STEP_SUMMARY`), plus
`markdown` and `json`.

A CI pipeline has two very different halves. Be clear about which is which:

| Part | Needs an agent? | What does it |
| --- | --- | --- |
| Boot an emulator, build and install the app | No | Your CI (`reactivecircus/android-emulator-runner`, Gradle) |
| **Drive the app and decide what to test** | **Yes** | An MCP client running an LLM (for example Claude Code headless, `claude -p`) that calls Swipium tools and ends with `qa_report` |
| Render JUnit / SARIF / summary from that run, and fail the job on the release gate | No | `npx swipium report …` (deterministic CLI, no device, no LLM) |

Swipium is an MCP server, not a test runner. Without an agent step, nothing exercises the app. If
you only want a deterministic replay, run a compiled Flow V2 suite instead: see `swipium suite`
and `qa_flow_check` with `ci:true`.

## `swipium report`

```text
swipium report --format <junit|sarif|github-summary|markdown|json>
               [--root <dir>] [--session <id> | --latest] [--report <file>]
               [--out <file>] [--fail-on-gate]
```

- It reads the report JSON that `qa_report` saved for the session. Swipium keeps session state
  under `~/.swipium/runs/<project-hash>/<session>/`, so run the CLI on the same runner, as the
  same user, after the agent step. `--latest` is the default and picks the newest session for
  `--root` (default: the current directory) that has a report. It skips sessions that never
  called `qa_report`.
- `--report <file>` renders a report JSON you copied somewhere yourself, for example a
  downloaded artifact.
- The output goes to stdout, or to `--out`. The verdict line (`Release gate: PASS|BLOCK — …`)
  goes to stderr.
- Exit codes: `0` means the file was written. `1` means `--fail-on-gate` was set and the
  release-gate policy blocks. `2` means a usage error or no report was found.
- Secrets: raw secret values are never written to disk, so the CLI can't scrub them later.
  Instead, `qa_report` deep-redacts the whole report with the session's secrets before saving
  it. Every string field is redacted, including step summaries, workflow names and next steps.
  The CLI renders that redacted copy.

## GitHub Actions recipe (Android)

Before you copy this recipe, check these prerequisites:

- The repository builds a debug APK with Gradle. Adjust the build command and APK path for your
  project.
- `ANTHROPIC_API_KEY` is a repository secret, used by Claude Code for the agent step.
- If the app needs credentials, provide test accounts through `.swipium/fixtures.json` or
  `SWIPIUM_TEST_EMAIL` / `SWIPIUM_TEST_PASSWORD` secrets. If none are given, the agent tests
  what it can reach before login and reports login as blocked.

`.github/workflows/swipium-qa.yml`:

```yaml
name: Swipium QA
on: [pull_request]

permissions:
  contents: read
  checks: write          # mikepenz/action-junit-report
  pull-requests: write   # mikepenz/action-junit-report PR annotations
  security-events: write # github/codeql-action/upload-sarif
  actions: read          # upload-sarif on private repositories

jobs:
  qa:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }

      - uses: actions/setup-node@v4
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
      # android-emulator-runner runs each `script` line as its own shell command, so keep
      # the agent logic in a script file.
      - name: Agent QA run (needs an LLM)
        uses: reactivecircus/android-emulator-runner@v2
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
        if: always()
        uses: mikepenz/action-junit-report@v6
        with:
          report_paths: swipium/junit.xml
          include_passed: true

      - name: Upload SARIF to code scanning
        if: always()
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: swipium/results.sarif
          category: swipium

      # Screenshots and recordings are pixels and are NOT redacted; drop this step for apps
      # that show real secrets on screen.
      - name: Keep raw evidence
        if: always()
        uses: actions/upload-artifact@v4
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

# Swipium as the only MCP server for this run. projectRoot is passed explicitly in the prompt:
# the server does not infer the project from its working directory.
cat > /tmp/swipium-mcp.json <<'JSON'
{ "mcpServers": { "swipium": { "command": "npx", "args": ["-y", "swipium"] } } }
JSON

claude --bare -p "You are running unattended in CI against the Android emulator that is already booted.
Use only the swipium MCP tools. Always pass projectRoot=\"$GITHUB_WORKSPACE\".
1. Call qa_test_this with mode \"execute\", goal \"release_gate\", platform \"android\", buildIfNeeded false.
   The APK is at app/build/outputs/apk/debug/app-debug.apk. Poll qa_job_status until the job is terminal.
2. If the job is blocked, do not try to work around consent or credential prompts.
   Record the blocker and continue to step 3.
3. Call qa_report for the session (format \"summary\") so the report is persisted, then stop." \
  --mcp-config /tmp/swipium-mcp.json \
  --allowedTools "mcp__swipium" \
  --permission-mode dontAsk \
  --output-format json > "$RUNNER_TEMP/claude-result.json" || true

# The agent's own exit status does not gate the job. The gate is `swipium report --fail-on-gate`.
jq -r '.result // empty' "$RUNNER_TEMP/claude-result.json" || true
```

Notes on the agent step:

- `claude -p` runs Claude Code without an interactive session. `--bare` skips the local hooks,
  plugins, `CLAUDE.md` and any `.mcp.json` servers, so the server from `--mcp-config` is the
  only MCP server. `--allowedTools "mcp__swipium"` pre-approves every Swipium tool, and
  `--permission-mode dontAsk` denies anything else instead of waiting on a prompt. For flags, see
  the Claude Code docs:
  [headless](https://code.claude.com/docs/en/headless) and
  [CLI reference](https://code.claude.com/docs/en/cli-reference).
- Swipium's own consent gates (external-APK install, builds, destructive app-state changes)
  cannot be approved by anyone in CI. The recipe keeps to the paths that don't need consent: the
  emulator is booted by the runner, and the APK is inside the workspace. If a step still needs
  consent, the run ends **blocked** and the report says why. It does not guess.
- Timing depends on the model and the app. Treat the first runs as calibration and set
  `timeout-minutes` from those runs.

## What each file means

**JUnit** has one testcase per recorded workflow and one per finding.

- `fail` becomes `<failure>`. `blocked`, `skipped` and `not_applicable` become `<skipped>`.
- A failure that the release-gate policy only **warns on** or **ignores** (`warnOn` /
  `ignoreKnown`) becomes `<skipped message="policy warned|suppressed (release gate not blocked):
  …">`. This way a gate PASS never shows up as a failed test.
- The gate verdict and reason are testsuite `<properties>`.
- XML-illegal control characters, such as ANSI escapes and NULs from logcat, are replaced with
  U+FFFD, so strict parsers accept the file.

**SARIF**: each finding or failed workflow becomes one result. GitHub code scanning only shows
results that have a repository file location, so each result points at the most specific real
file Swipium can justify:

1. the app-map source file of the screen or feature involved, when `.swipium/app-map.json`
   exists (see `qa_app_map_update`);
2. otherwise, the project manifest: `app.json`, `package.json`, `pubspec.yaml`, the Gradle app
   module, or an iOS `Info.plist`.

Other SARIF details:

- The location has `uriBaseId: %SRCROOT%` and a region on line 1.
- Screenshots and other `swipium://` evidence go in `relatedLocations` and `properties`.
- Each result carries its own `partialFingerprints.primaryLocationLineHash`. This keeps
  distinct results on the same manifest line from collapsing into one alert, and keeps alerts
  stable across runs, because volatile ids and timestamps are scrubbed first.
- `invocations[0].executionSuccessful` is `true` whenever Swipium produced the file. The
  release-gate verdict is in `runs[0].properties.releaseGateVerdict` and `releaseGate`.

See GitHub's
[SARIF support for code scanning](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)
and
[Uploading a SARIF file](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github).

**GitHub summary** contains:

- the verdict, the gate line, finding counts, the top findings, failed or blocked workflows,
  and links to the evidence;
- escaped text: app id, device name, policy reason and next action are escaped, so they can't
  inject Markdown or HTML.

The summary is capped at about 900 KB and ends with a truncation note. GitHub rejects step
summaries over 1 MiB.

## From inside an agent session (no CLI)

`qa_report { sessionId, format: "junit" | "sarif" | "github-summary" }` writes the same files as
session artifacts and returns `exportUri`. Read the file with `qa_get_artifact { uri }`. This is
useful when the agent itself publishes results. In CI, prefer the CLI, because it doesn't depend
on the agent remembering to write files.

## Release-gate policy

`.swipium/policy.json` decides the verdict in every export and the `--fail-on-gate` exit code:

```json
{
  "blockOn": ["native_crash", "app_error_boundary", "failed_required_flow"],
  "warnOn": ["missing_test_data"],
  "ignoreKnown": ["REVENUECAT_BILLING_UNAVAILABLE_ON_EMULATOR"]
}
```

Without a policy file, any failed workflow or high-severity finding blocks.
