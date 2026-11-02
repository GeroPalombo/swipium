# CI reports

`swipium report` turns a finished Swipium QA run into files that CI systems read:

- `html`: one self-contained page for a human, screenshots included (`report.html`);
- `junit`: test-report XML;
- `github-summary`: Markdown for `$GITHUB_STEP_SUMMARY`;
- `sarif`: SARIF 2.1.0 for GitHub code scanning (experimental, high-severity app findings only);
- `markdown` and `json`.

A CI pipeline built on Swipium has three parts, and only one of them needs an agent:

| Part | Needs an agent? | What does it |
| --- | --- | --- |
| Boot an emulator, build the app, install it | No | Your CI (for example `reactivecircus/android-emulator-runner`, Gradle, `adb install`) |
| **Drive the app and decide what to check** | **Yes** | An MCP client running an LLM (for example Claude Code headless, `claude -p`) that calls Swipium tools and ends with `qa_report` |
| Render the HTML report, JUnit and the summary, and fail the job on the release gate | No | `npx swipium report …`: a deterministic CLI with no device and no LLM |

Swipium is an MCP server, not a test runner. Without an MCP client calling its tools, nothing
exercises the app, and there is no standalone command that runs flows. To replay the same steps on
every run instead of letting the model decide what to check, have the agent step call `qa_flow_run`
on committed flows (see [flows.md](flows.md)); that still runs through an MCP client.

## `swipium report`

```text
swipium report --format <html|junit|sarif|github-summary|markdown|json>
               [--root <dir>] [--latest | --session <id> | --report <file>]
               [--out <file>] [--max-age <minutes>] [--fail-on-gate]
```

- **Which report it reads.** It renders the report JSON that `qa_report` (or the end of a
  `qa_test_this` run) saved for a session. Session state lives under
  `~/.swipium/runs/<project-hash>/<session>/`, so run the CLI on the same runner, as the same user,
  after the agent step, and from the same project root the agent used (or pass `--root`).
- **`report.md`.** Every report also saves `report-<timestamp>-summary.md` next to the JSON: the
  summary text an agent reads (`reportMdUri`). Since 2.4.0 it is at most 2 KB and failure first, so
  don't parse it in CI: read `report.json` (`--format json`). The CLI renders from the JSON.
- **`--format html`** renders the same `report.html` that `qa_report` writes into the session
  folder: no JavaScript, no network requests, screenshots embedded as thumbnails. It needs the
  session folder for the images; with `--report <file>` outside a session folder, each image shows
  "evidence not available" instead of failing. See [What's in a report](concepts.md#whats-in-a-report).
- **`--latest`** is the default. It picks the newest session for `--root` (default: the current
  directory) that has a saved report, and skips sessions that never produced one. When newer
  sessions saved no report (the latest agent step probably failed before `qa_report`), it prints a
  warning on stderr naming them and the older session it renders. With `--fail-on-gate` it refuses
  instead (exit 2): the gate would otherwise judge an older run. Pass `--max-age` to accept an
  older report that is still recent enough, or `--session <id>` to gate a specific session.
- **`--max-age <minutes>`** refuses (exit 2) a report saved longer ago than that, so a job never
  publishes an earlier run's report when this run's agent step produced none. Use it on persistent
  or self-hosted runners, where `~/.swipium/runs` survives between jobs.
- **`--session <id>`** picks one session. **`--report <file>`** renders a report JSON you copied
  yourself, for example from a downloaded artifact.
- **Boolean flags** (`--fail-on-gate`, `--latest`, `--help`) take no value: `--fail-on-gate=false`
  is a usage error (exit 2). Leave the flag out to turn it off.
- **Output.** The file goes to stdout, or to `--out` (parent directories are created). The verdict
  line `Release gate: PASS|BLOCK: <reason> (session <id>, report saved <ISO time>)` always goes to
  stderr.
- **Exit codes:**

  | Code | Meaning |
  | --- | --- |
  | `0` | The file was written. The gate passed, or it blocked but `--fail-on-gate` was not set. |
  | `1` | `--fail-on-gate` was set and the release-gate policy blocks. |
  | `2` | Usage error, unknown format, no session or report found, the file is not a Swipium report, the report is older than `--max-age`, `--fail-on-gate --latest` found newer sessions without a report (and no `--max-age`), `.swipium/policy.json` is invalid, the format could not be rendered, or the `--out` file could not be written. |

- **Secrets.** Raw secret values are never written to disk, so the CLI can't scrub them later.
  Instead, `qa_report` deep-redacts the whole report with the session's registered secrets before
  saving it, and the CLI renders that redacted copy. Every string field is redacted, including step
  summaries, workflow names and next steps.

## GitHub Actions recipe (Android)

This recipe keeps every Swipium consent out of the agent's hands, which is the safest setup:

- The runner boots the emulator.
- The workflow installs the APK with `adb`, so it is your decision, made in the workflow.
- The agent then uses only tools that need no consent: attach to the running emulator, launch the
  installed app, smoke it, and report.
- `SWIPIUM_REQUIRE_ELICITATION=1` plus `--permission-prompts none` means any unexpected consent
  request is refused instead of approved by the model. The run then reports **blocked** and says
  why.

If you'd rather let the agent install or run `qa_test_this`, pre-approve exactly those actions
instead (see [Pre-approving consents in CI](#pre-approving-consents-in-ci)).

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
        with: { node-version: '24' } # Swipium needs Node.js 22.12 or newer

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

      - name: Swipium job summary
        if: always()
        run: npx -y swipium report --latest --format github-summary >> "$GITHUB_STEP_SUMMARY"

      - name: Publish JUnit
        if: always() && hashFiles('swipium/junit.xml') != ''
        uses: mikepenz/action-junit-report@a9170d5795813c01ab4901ffb045b52bab4ab09d # v6.5.0
        with:
          report_paths: swipium/junit.xml
          include_passed: true

      # One file a reviewer opens in a browser. Its text is redacted, but the embedded screenshots
      # are pixels and are NOT redacted. Drop these two steps for apps that show real secrets on screen.
      - name: Swipium HTML report
        if: ${{ !cancelled() }}
        run: npx -y swipium report --latest --format html --out swipium-report.html

      # archive: false uploads the file as is (no zip). The artifact is named after the file,
      # swipium-report.html, which is what the job summary points at.
      - name: Upload the HTML report
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          path: swipium-report.html
          archive: false
          retention-days: 14

      # Last step, so every report above is published before the job fails. --max-age keeps a
      # persistent runner from gating on an earlier job's report.
      - name: Release gate
        run: npx -y swipium report --latest --max-age 120 --format json --out swipium/report.json --fail-on-gate
```

`.github/scripts/swipium-agent.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Install the app yourself. Swipium's own install path is consent-gated, and nobody is there
#    to answer a prompt. Installing here keeps that decision in the workflow.
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
2. qa_prepare_target { sessionId, appId: \"$APP_ID\" }. If it returns a jobId, poll qa_job_status { sessionId, jobId, waitMs: 45000 } until it is no longer running.
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
  (`test_this_plan`) for the privileged steps it plans, and every app install is among them. With
  nobody to approve and no pre-approval, it ends blocked. The low-level path above attaches to the
  running emulator, and an app that is already installed skips the install consent.
- **Refused consents keep the session.** A `CONSENT_*` refusal carries the `sessionId` of the call
  (including the session `qa_test_this` created before it asked), so the agent can still record it
  with `qa_note` and save the report with `qa_report`.
- **Testing more.** `qa_explore { sessionId }` can follow the smoke. By default it skips
  destructive-looking actions without asking. It asks for consent only when a call names one
  explicit `destructiveCandidate` to run, which the settings above would refuse.
- **Timing** depends on the model and the app. Treat the first runs as calibration, and set
  `timeout-minutes` from them.

Notes on the report steps:

- **`if: ${{ !cancelled() }}`** renders and uploads the HTML report when the agent step failed too
  (that is when you need it most), but not when the run was cancelled. A run that tested nothing
  still has a report: the page then shows the blocker, its fix and the log tail.
- **The HTML artifact.** `actions/upload-artifact` v7 with `archive: false` uploads a single file
  without zipping it, and names the artifact after the file (`name` is ignored). The job summary's
  last line, `Full report: the swipium-report.html artifact of this run`, refers to it. Open it from
  the run's **Artifacts** list. It needs no network: images are embedded and it loads nothing else.
- **Before 2.4.0** the recipe uploaded all of `~/.swipium/runs`. Don't: that folder holds raw
  full-size screenshots, recordings, UI dumps and logs from every session on the runner. Use the
  debug step below only when you need them.

### Raw evidence (optional, debug only)

> [!WARNING]
> `~/.swipium/runs` holds **raw** evidence: full-size screenshots and recordings (pixels are never
> redacted), UI dumps and logs. Anyone who can download the artifact sees them. Don't add this step
> for apps that show real secrets on screen, and keep the retention short.

```yaml
      - name: Raw Swipium evidence (debug)
        if: ${{ failure() }}
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: swipium-runs-debug
          path: /home/runner/.swipium/runs/ # $HOME on GitHub-hosted ubuntu runners
          retention-days: 3
```

### SARIF (experimental)

SARIF is experimental and not part of the recipe above. It holds only high-severity app findings
(see [What each file contains](#what-each-file-contains)): a run without one gives an empty results
list. To try it, add these permissions and steps:

```yaml
permissions:
  security-events: write # github/codeql-action/upload-sarif
  actions: read # upload-sarif on private repositories

# ...
      - name: Swipium SARIF (experimental)
        if: ${{ !cancelled() }}
        run: npx -y swipium report --latest --format sarif --out swipium/results.sarif

      - name: Upload SARIF to code scanning
        if: ${{ !cancelled() && hashFiles('swipium/results.sarif') != '' }}
        uses: github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2
        with:
          sarif_file: swipium/results.sarif
          category: swipium
```

### Pre-approving consents in CI

`claude -p` (and `codex exec`) answer every consent prompt automatically, so a gated action never
runs by default. The operator can pre-approve exact action names in the server `env` with
`SWIPIUM_CONSENT_PREAPPROVE`. It's read only from the server's environment, never from the
repository, and each approval is logged on stderr at `warn` with the exact command. The full rules
are in [concepts.md](concepts.md#operator-pre-approval).

For example, to let the agent install the APK itself (`qa_prepare_target { sessionId, apk }`, whose
boot and install consent is `prepare_plan`, or `qa_test_this` on the booted emulator, whose plan is
`test_this_plan`), change the server entry in `swipium-agent.sh` to:

```json
{ "mcpServers": { "swipium": { "command": "npx", "args": ["-y", "swipium"],
  "env": { "SWIPIUM_REQUIRE_ELICITATION": "1",
           "SWIPIUM_CONSENT_PREAPPROVE": "prepare_plan,test_this_plan" } } } }
```

Keep the list as short as the prompt needs:

- Pre-approval works with `SWIPIUM_REQUIRE_ELICITATION=1`, which still refuses every action you
  didn't list.
- Actions that run repository or model-chosen code (`build_from_source`, `start_metro`, seed
  scripts and others) also need `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1`. A `test_this_plan` that
  includes a build is only covered when `build_from_source` is pre-approved that way too. Building
  in the workflow, as the recipe does, avoids that.
- Pre-approval is not tied to a device: a listed action is approved for whatever device the plan
  picks. On a runner with more than one emulator, or shared between jobs, also set
  `SWIPIUM_DEVICE` (for example `"SWIPIUM_DEVICE": "emulator-5554"`, or an AVD name) in the same
  `env`. Every plan then targets that device, and a call that names another one is refused with
  `DEVICE_PINNED` ([Device pin](concepts.md#device-pin)).
- Installing with `adb` in the workflow is still the safest option: nothing the model chooses gets
  approved.

## What each file contains

**HTML** (`report.html`) is the file for people. It is the same page `qa_report` writes to
`<session>/report/report.html`, failure first: the gate verdict and reason, then each failure and
finding with its screenshot, failing step, failure code and log tail, the outcomes table with an
evidence thumbnail per outcome, the step timeline (collapsed on a pass), environment changes, device,
app and timing, and the artifacts with paths relative to the session folder. A run that tested
nothing (by the same rule as the [release gate](#release-gate-policy)) shows the blocker, its fix and
the last 40 lines of the relevant log, then its failures and findings and the timeline. The banner
says so when `.swipium/policy.json` was ignored. Log tails are redacted with the session's secrets
and scrubbed of credential shapes (Bearer tokens, JWTs, API keys, passwords); `swipium report` has no
session secrets (they are never on disk), so it scrubs only the credential shapes. It
has no JavaScript and a strict Content-Security-Policy, loads nothing from the network, and links
only to the Swipium docs. Screenshots are 480 px wide thumbnails, 8 MB in total; past that, or for a
PNG it can't decode, an image is listed as a file path instead. See
[What's in a report](concepts.md#whats-in-a-report).

**JUnit** always has two suites. The first holds one testcase per workflow, the second one per
high-severity finding (empty, with `tests="0"`, when there are none). Since 2.4.0:

- **One case per workflow.** The latest attempt wins (see
  [Release-gate policy](#release-gate-policy)), so a workflow retried in the same session is one
  case. Case names are unique: a repeated name gets the screen appended (`Login [Home]`), then an
  index (`Login #2`), because GitLab and others merge cases that share a name.
- **`time`** on each case is the sum of its steps' durations (0 when the report has no steps).
- A workflow `fail` is `<failure type="<failureCode>" message="<reason>">`, with the failing step in
  the body.
- **Tool and environment failures are `<error>`, not `<failure>`**: a failed workflow with category
  `mcp_limitation` or whose failure code is in the
  [environment bucket](tools.md#bucket-environment) (`NO_DEVICE`, `WDA_UNREACHABLE`,
  `BUILD_FAILED`, ...). So is the synthetic `swipium: not tested` case a run that never reached the
  app, or reached it but exercised nothing, adds to the workflows suite (see
  [Release-gate policy](#release-gate-policy)). Test checks can turn red on these.
- `blocked`, `skipped` and `not_applicable` are `<skipped message="blocked: <reason>">` (`skipped:
  …`, `not applicable: …`).
- An agent's `qa_note` pass that no Swipium check or device evidence backs is
  `<skipped message="unverified manual claim (…)">`, never a passing testcase.
- **Only high-severity findings are testcases.** An app finding is `<failure>`. A tool or
  environment finding (`WDA_UNREACHABLE`) is named `[high] tool/wda_unreachable` and is `<error>`;
  it fails the gate too. Medium and low findings are in the report, not in JUnit.
- A failure that the release-gate policy only warns on (`warnOn`) or suppresses (`ignoreKnown`)
  becomes `<skipped message="policy warned|suppressed (release gate not blocked): …">`, so a gate
  PASS never shows up as a failed test.
- The gate verdict (`swipium.releaseGate`, `pass` or `fail`), the same verdict in the SARIF
  vocabulary (`swipium.releaseGate.verdict`, `pass` or `block`) and the reason
  (`swipium.releaseGate.reason`) are testsuite `<properties>`.
- Each testcase's `<system-out>` has the failing step (`failing step #12: tap "Pay" (ELEMENT_NOT_FOUND)`),
  `flaky: attempts fail, pass (the latest attempt counts)` and a `contradicted` note when they
  apply, and the evidence URIs, or `(no evidence)` for a pass or fail with nothing captured.
- XML-illegal control characters, such as ANSI escapes and NULs from logcat, are replaced with
  U+FFFD, so strict parsers accept the file.

**SARIF** is experimental (not in the default recipe). Since 2.4.0 it has one result per
high-severity **app** finding and nothing else: failed workflows, the not-tested case, tool and
environment findings (`WDA_UNREACHABLE`) and medium or low findings are not code alerts, and stay in
JUnit and the report. A run that tested nothing is still visible in `runs[0].properties.notTested`.
GitHub code scanning only shows results that point at a file in the repository, so each result is
anchored to the most specific real file Swipium can justify:

1. the app-map source file of the finding's screen, when `.swipium/app-map.json` exists (see
   `qa_app_map_update`);
2. otherwise the project manifest, in this order: `app.json`, `package.json`, `pubspec.yaml`, the
   Gradle app module, an iOS `Info.plist`, then `README.md`. Paths inside build products (`*.app`,
   `*.xcarchive`, `*.framework`, `*.appex`, `*.bundle`, `*.dSYM`, `build/`, `DerivedData/`,
   `.build/`, `dist/`, `Pods/`) are skipped, because they are usually not committed and GitHub
   would drop the alert;
3. otherwise an Xcode project (`ios/*.xcodeproj/project.pbxproj`, then
   `*.xcodeproj/project.pbxproj`), then the first non-hidden file in the root (sorted), then
   `.gitignore`. `package.json` is used as a last resort only when the root holds no file at all.

Other SARIF details:

- Paths are relative to the repository root, the nearest ancestor with `.git`. In a monorepo an
  anchor reads `apps/mobile/app.json`. Each location has `uriBaseId: %SRCROOT%` and a region on
  line 1.
- The level is `error`. As in JUnit, a finding the release-gate policy only warns on (`warnOn`) is
  `warning`, and one it suppresses (`ignoreKnown`) is `note`.
- Screenshots and other `swipium://` evidence go in `relatedLocations` and `properties`.
- **Fingerprints are built from content**: `partialFingerprints.primaryLocationLineHash` (and
  `swipium/v1`) hash the rule, the screen and the finding detail, with volatile ids and timestamps
  removed. The same findings in a different order keep the same alerts. Upgrading from 2.3.x closes
  and reopens existing alerts once, because the old fingerprints depended on finding order.
- `invocations[0].executionSuccessful` is `true` whenever Swipium produced the file. The verdict is
  in `runs[0].properties.releaseGateVerdict` (`pass` or `block`), with the full decision in
  `releaseGate`.

See GitHub's
[SARIF support for code scanning](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)
and
[Uploading a SARIF file](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github).

**Playwright JSON** (`qa_report { format: "playwright" }`, not a CLI format) is deprecated and will
be removed in a future release. It still works; its JSON carries a `deprecated` note. Use JUnit or
the HTML report.

**GitHub summary** is failure first, in this order:

1. the risk badge and the gate line (`✅ PASS` or `❌ BLOCK`, with the policy reason);
2. for a run that tested nothing, `Not tested: <reason> (<code>)` and the path of the log to read
   (or `No log captured.`); otherwise up to 20 failures, each with its workflow, failing step
   (`step #12 tap "Pay"`), failure code and reason, and `(flaky)` when attempts disagreed;
3. the next action, then the counts (`Findings: N high · N medium · N low` and the `Workflows:`
   tally);
4. the outcomes table (workflow, outcome with its flags, reason, evidence) and up to 10 findings;
5. the app and device line, then `Full report: the swipium-report.html artifact of this run`.

No images: artifact URLs need a login. Evidence is shown as `swipium://` paths in code spans, not
links, because GitHub can't open them: the HTML report embeds the screenshots, or read them with
`qa_get_artifact`. Without an app id or device the app line says `(not resolved)` and
`(no device bound)` instead of placeholders. Text that comes from the run is escaped so it can't
inject Markdown or HTML: the app id, device name, policy reason, workflow names, reasons and next
action. `@mentions`, `://` URLs and `www.` links in that text get a zero-width space, so they don't
ping anyone or turn into links. ANSI escapes and other control characters (except tab and newlines)
are stripped, in the Markdown export and `report.md` too. The Markdown export also escapes `<`
outside code blocks (so run text can't inject HTML such as `<img onerror>`; a generated `<redacted>`
value shows as `&lt;redacted>`), and escapes pipes and flattens newlines in table cells, so a note
reason can't break the Workflows table. The PR summary (`prSummary`) lists device evidence only, and
a not-tested run with none says `Evidence: none recorded`. The high count is `highSeverityCount`:
unique findings, tool and environment findings (`WDA_UNREACHABLE`) left out. The medium and low
counts leave them out too, and a `· N tool/environment` count is added. An unverified `qa_note` pass
claim is tallied as `pass (unverified)=1` on the `Workflows:` line (not `pass=1`); the Markdown
export's Workflows table says `pass (unverified)` too, and the Playwright export marks it `skipped`.
`outcomeTally` in `report.json` is unchanged. GitHub rejects a step summary over 1 MiB, so the
summary stops at about 900 KB and ends with a truncation note.

**The gate verdict in each format:**

| Where | Pass | Block |
| --- | --- | --- |
| CLI stderr verdict line | `PASS` | `BLOCK` |
| JUnit `swipium.releaseGate` property | `pass` | `fail` |
| JUnit `swipium.releaseGate.verdict` property | `pass` | `block` |
| SARIF `runs[0].properties.releaseGateVerdict` | `pass` | `block` |
| GitHub summary gate line | `✅ PASS` | `❌ BLOCK` |

## From inside an agent session (no CLI)

`qa_report { sessionId, format: "junit" | "sarif" | "github-summary" }` writes the same file as a
session artifact and returns its `exportUri`. Read it with `qa_get_artifact { uri }`. This is useful
when the agent itself publishes the results. Every `qa_report` call also writes `report.html` and
returns its absolute path in `reportHtmlPath` (and a `file://` URL in `reportHtmlUrl`), with no
`format` needed. In CI, prefer the CLI: it doesn't depend on the agent
remembering to write files.

## Release-gate policy

`.swipium/policy.json` decides the verdict in every export and the `--fail-on-gate` exit code. The
file's other settings, such as `ciAllowMutations`, are described in
[flows.md](flows.md#ci-policy). The gate looks at every failed workflow and every high-severity
finding:

- **The latest attempt per workflow wins** (since 2.4.0). Workflow names are compared trimmed and
  case-folded (`"Login"` and `"login "` are one workflow). A later attempt replaces an earlier one
  only from the same source: Swipium runs (flows, smoke) replace Swipium runs, and agent `qa_note`
  notes replace agent notes, and only a pass or fail replaces anything (a later `blocked`, `skipped`
  or `not_applicable` keeps the last pass or fail as the outcome that counts). So two separate `qa_flow_run` calls that fail and then pass now pass the
  gate, with the outcome marked `flaky` and the other attempts kept in `attempts[]`, while an
  agent's pass note never clears a Swipium failure. Explore notes and in-flow `note` steps never
  replace or get replaced, and findings are separate verdicts that are never replaced: a crash
  finding still blocks after the flow passes on a retry. `qa_flow_run { repeat: N }` is one attempt
  and still records its first failure. The CLI applies the same rule to reports saved by older
  versions, so an old report can flip to PASS when re-rendered.
- A failed workflow's code is the failure code of its first failing step, else its category, else
  `UNKNOWN`.
- A finding's code is its failure code, else its kind.
- **A run that tested nothing fails the gate.** When the report says the app was never reached
  (`notTested` with `reachedApp:false`: the run stopped before the app, for example on a build,
  Metro or device blocker, or nothing at all was exercised), the gate adds a failed workflow
  `swipium: not tested` whose code is the blocker's code, or `NOT_TESTED`, with the reason as its
  text. Such a report reads release risk `block`, app verdict `NOT_RUN` and coverage `NONE`. So
  `--fail-on-gate` exits 1 on a run that tested nothing. The same holds for a run that
  reached the app but exercised no workflow (for example a launch that ended `blocked` on
  `BLANK_SCREEN`, or only a launch and a screenshot plus blocked notes): its risk is `caution` and
  coverage `NOT_COVERED`, but
  `notTested` is `{reachedApp:true, exercised:false}` and the gate adds the same failed workflow
  with the blocked note's code (`BLANK_SCREEN`, `METRO_REQUIRED`, ...) or `NOT_TESTED`. To only
  warn instead, list the code in `warnOn` (for example `"not_tested"`, `"blank_screen"` or
  `"build_failed"`). Reports saved before this change carry no `exercised` field and gate as before.
- **Only a healthy Swipium check counts as testing.** A run is exercised only by a check Swipium
  ran itself that read the app's UI and found it healthy:
  - a `launch_smoke` pass whose oracle read the UI tree and ruled out a RedBox or blank screen
    (`app=ok` in its reason; a visual-only smoke reads `app=unverified` and doesn't count);
  - a saved-flow, `qa_flow_run`, first-run or mobile-audit pass;
  - an exploration that reached at least one structured (not visual-only) app screen without an app
    error.

  A Swipium failure also counts, since it can only block. Nothing else counts, however many there
  are: an agent's `qa_note` pass, a `qa_visual` `mode:"assert"` pass (the verdict is the agent's,
  not Swipium's), a launch, a screenshot, a `qa_act` action with the app in front (tapping
  "Dismiss" on a RedBox leaves an empty app view), any finding, or an exploration of a blank or
  visual-only screen. These only show that the app was reached (risk `caution` instead of `block`),
  and the gate fails with `NOT_TESTED` (for an unverified pass claim: "only an unverified qa_note
  pass claim on a launched app ... run qa_smoke or a flow"). A pass claim with no evidence at all
  leaves the run not tested (`block`). An agent's fail note doesn't count either: it still reaches
  the gate as a failed workflow, so it can block, but a run whose only outcome is that note is not
  tested and also gates with `NOT_TESTED` (so a `warnOn` entry for the note's category can't turn
  it into a PASS). A `blocked` or `skipped` note, a fail note under `mcp_limitation` (such as
  "baseline failed: device offline") and the report's own exports don't count.
- **The verdict sticks.** A not-tested verdict is saved on the session, so every later `qa_report`
  call keeps its reason and code (a Metro-blocked run stays `METRO_REQUIRED`, not `NOT_TESTED`)
  until one of the healthy Swipium checks above is recorded after it. An agent note, a `qa_visual`
  assert, an action, a finding, a launch or a screenshot never clear it, in any combination.
  Without a `qa_test_this` marker, the code comes from the first blocked note whose reason starts
  with a failure code (`METRO_REQUIRED: …`), else `NOT_TESTED`.
- **Refused consent.** A run that tested nothing after a refused consent gates with the refusal's
  code instead of `NOT_TESTED`: `CONSENT_CANCELLED`, `CONSENT_DECLINED` or `CONSENT_REFUSED` (also
  when the agent's blocked note doesn't start with a code). Use `consent_cancelled`,
  `consent_declined` or `consent_refused` in `warnOn` or `blockOn`.
- **WebDriverAgent failures.** A `WDA_UNREACHABLE` finding is exported as a tool or environment item
  (JUnit `<error>`, not a SARIF result, its own count in the GitHub summary) and doesn't count as a
  high-severity app finding in the release risk, but the run still never passes the gate on it
  (gate code `WDA_UNREACHABLE`).
- With no failures the reason says what actually ran:
  - `all required flows passed` only when every flow verdict is a pass;
  - `no failures recorded (N of M workflow(s) passed; the rest were blocked or skipped)`;
  - `no failures recorded (launch smoke only, 0 flows run)` (`launch_smoke` and findings are not
    flows);
  - `no failures recorded (0 workflows run)` when the report has no workflow outcomes at all.
- A flow stopped or skipped by the session budget is a skipped workflow (`BUDGET_EXHAUSTED`), not a
  failure, but it was not covered: the risk is at least `caution`, coverage is `PARTIAL` (or
  `BLOCKED` when something else blocked too), and the report names the flows and says to re-run
  with a larger `qa_start_session { budget }`. A blocked exploration (blockers, only unsafe actions
  left, a session-budget stop, `time budget reached` on `maxDurationMs`, or an alert with no close
  button, leaving the app 3 times or no way back when nothing was explored) is also at least `caution`: coverage `BLOCKED` never comes with `ship`.
- A `qa_flow_run` result is recorded as that flow's outcome, like a saved flow in `qa_smoke`.
- A Swipium-generated flow that fails on a locator step is reported as automation drift (coverage
  `BLOCKED`, risk `caution`), not an app failure, but the gate still counts it as a failed workflow
  with its step's code (for example `ELEMENT_NOT_FOUND`), because the flow is broken. List that code
  in `warnOn` to only warn, or repair the flow with `qa_flow_repair`. A `blocked` workflow, such as
  one missing test data, never fails the gate.

```json
{
  "blockOn": ["native_crash", "anr", "error_boundary"],
  "warnOn": ["missing_test_data", "assertion_failed"],
  "ignoreKnown": []
}
```

Each failure is checked in this order:

1. **No policy file**: every failure blocks. **An invalid one** (not JSON, not an object, or a list
   field that isn't an array of strings) is refused by the CLI with
   `❌ INVALID_ARGUMENT: <path> <problem>` and exit 2, before anything is rendered. `qa_report`
   exports inside an agent session fall back to "every failure blocks" instead, and the report
   records why in `releasePolicyNotice` (`report.json`). **Unknown keys** (a typo such as
   `"warnon"`) don't make the file invalid: they are ignored, the CLI prints
   `⚠ <path>: unknown key(s) "warnon" ignored. Known keys: …` on stderr, and the report records the
   same warning in `releasePolicyNotice`. The known keys are `blockOn`, `warnOn`, `ignoreKnown`, `ciAllowMutations` and
   `$schema`.
2. **`ignoreKnown`**: an exact code match (case and punctuation ignored) is suppressed.
3. **`blockOn`**: a matching code blocks. An empty or missing `blockOn` blocks every failure. The
   token `failed_required_flow` matches every failure, so with it in `blockOn`, `warnOn` never
   applies.
4. **`warnOn`**: a matching code only warns.
5. **Anything else blocks.** A failure the policy doesn't mention is not ignored.

Tokens match failure codes case-insensitively, with punctuation ignored (`native_crash` matches
`NATIVE_CRASH`). A few synonyms also work: `crash` means `NATIVE_CRASH`, and `app_bug`
also matches `ASSERTION_FAILED`. `visual_diff` matches only a failed visual comparison: a flow
step `assertImage`, `assertOcrText` or `assertDiff`, or (without step detail) an outcome whose
evidence is Swipium's own `visual_match`, `ocr_locator` or `ocr_text`. A failing `assertVisible`,
`waitForVisible` or other structured assertion is never a visual diff, nor is an agent's
`qa_visual` assert, so `warnOn: ["visual_diff"]` can't downgrade them. `ciAllowMutations` does not
affect the gate.
