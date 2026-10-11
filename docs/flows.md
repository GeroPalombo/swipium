# Flows

A flow is a replayable YAML script of steps under `.swipium/flows/`. Flows are the Flow V2 format: selector-bound input, visual steps, device-relative gestures, waits, setup and teardown, and a `structured`, `visual`, or `auto` mode. This page covers the file format, waiting, batching steps with an inline flow, variables, starter templates, compiling and repairing, and the CI policy. The tools themselves (`qa_flow_check`, `qa_flow_run`, `qa_flow_compile`, `qa_flow_repair`, `qa_smoke`) are in the [Tool Reference](tools.md#flows).

**Contents**: [Example](#example) · [File format](#file-format) · [Step reference](#step-reference) · [Waiting for targets](#waiting-for-targets) · [Batching steps](#batching-steps) · [Variables](#variables) · [Starter templates](#starter-templates) · [Compile and repair](#compile-and-repair) · [CI policy](#ci-policy)

## Example

`.swipium/flows/login-smoke.yaml`:

```yaml
name: login_smoke
mode: structured
fixtures:
  - test_account
setup:
  - prepareTarget
steps:
  - waitForVisible: "Email"
  - inputText:
      into: "Email"
      text: "${SWIPIUM_TEST_EMAIL}"
  - inputText:
      into: "Password"
      text: "${SWIPIUM_TEST_PASSWORD}"
  - tap: "Sign in"
  - waitForVisible:
      text: "Home"
      timeoutMs: 12000
  - assertVisible: "Home"
```

Validate it with `qa_flow_check {flow:"login-smoke"}`, then run it on a prepared session with `qa_flow_run {sessionId, flow:"login-smoke"}`. The password is typed but treated as a secret, because its variable name contains `pass`.

## File format

A flow is a YAML map with a non-empty `name` and a non-empty `steps` list.

| Key | Meaning |
| --- | --- |
| `name` | Required. |
| `steps` | Required, non-empty. Runs are fail-fast: the first failing step stops the flow. Mutating steps are never retried automatically. |
| `setup` | Steps that run before `steps`. |
| `teardown` | Steps that always run afterwards, even after a failure. |
| `mode` | `structured` (default: needs a UI tree), `visual` (screenshot-based), or `auto`. A structured flow on an iOS Simulator without WDA, or in a visual-fallback session, is refused with `BACKEND_UNSUPPORTED`. |
| `appId` | The app `prepareTarget` and `restartApp` act on (default: the session's app). |
| `fixtures` | Names of fixtures the flow needs (from `qa_start_session` or `.swipium/fixtures.json`). |
| `budgetProfile` | A budget profile label, such as `guardrail` or `full_smoke`. |

Each step is either a bare word (`prepareTarget`, `restartApp`, `waitForIdle`, `clearOverlay`, `networkOffline`, `networkOnline`) or a map with exactly one key. Variables are referenced inline as `${NAME}`; there is no top-level variables block.

**Selectors** (in `tap`, `inputText into`, `assertVisible`, `waitForVisible`, and similar steps):

- Plain text matches an element's text, content description, or id (case-insensitive substring).
- `id=<resource-id>` matches an Android resource id.
- `accessibility id=…`, `name=…`, `predicate string=…`, and `class chain=…` are native WDA selectors on iOS.

Prefer durable ids (`testID`, `accessibilityIdentifier`, resource ids) over visible text; `qa_flow_check` warns about platform-specific or brittle locators.

## Step reference

| Step | Form | What it does |
| --- | --- | --- |
| `prepareTarget` | bare | Launches the flow's app and waits for the screen to settle. |
| `restartApp` | bare | Force-stops and relaunches the app. Mutating. |
| `tap` | `tap: "<selector>"` | Taps an element, waiting up to 5 s for it. |
| `tapAt` | `tapAt: [x, y]` | Taps a coordinate. Coordinate-only flows are flagged as brittle. |
| `tapImage` | `tapImage: <png>` or `{template, minScore}` | Template-matches a PNG and taps it. |
| `tapOcrText` | `tapOcrText: "<text>"` or `{text, minConfidence}` | Finds text by OCR and taps it. Needs an OCR provider. |
| `inputText` | `inputText: "<text>"` or `{into, text, secret}` | Types text; `into` waits up to 5 s for the field, focuses it, and types as soon as the keyboard is up (at most 600 ms). `secret` defaults to true when the text references a credential-like variable. |
| `assertVisible` | `assertVisible: "<selector>"` | Waits up to 5 s for the element; fails with `ASSERTION_FAILED` when it doesn't appear. |
| `assertNotVisible` | `assertNotVisible: "<selector>"` | Fails when visible. Checked once, with no wait. |
| `assertImage` | `assertImage: <png>` or `{template, minScore}` | Asserts a PNG template is on screen. |
| `assertOcrText` | `assertOcrText: "<text>"` or `{text, minConfidence}` | Asserts text by OCR. |
| `assertVisual` | `assertVisual: "<description>"` | Captures screenshot evidence and records a visual checkpoint for a human. It does not fail. |
| `assertDiff` | `assertDiff: <baseline>` or `{baseline, threshold}` | Compares the screen to a saved `qa_visual` baseline. |
| `swipe` | `swipe: up` or `{direction, area, distance}` | Device-relative swipe. `area` is `center`, `top`, `bottom`, `left`, or `right`; `distance` is a fraction of the screen (default 0.6). |
| `scrollTo` | `scrollTo: "<selector>"` | Swipes until the target is visible (up to 8 swipes). |
| `press` | `press: back`, `home`, or `enter` | Presses a key. |
| `openUrl` | `openUrl: "<url>"` | Opens a deep link or URL. Mutating when the URL contains a `${VAR}`. |
| `wait` | `wait: <ms>` or `{text}` / `{id}` | Waits a fixed time, or for an element. |
| `waitForIdle` | bare, or `waitForIdle: <timeoutMs>` | Waits for the UI to settle. |
| `waitForVisible` | `waitForVisible: "<selector>"` or `{text` / `id` / `"accessibility id", timeoutMs}` | Waits for an element to appear. |
| `clearOverlay` | bare | Clears a blocking overlay (see below). |
| `networkOffline`, `networkOnline` | bare | Turns airplane mode on or off (Android 11+). Mutating. |
| `seed` | `seed: <fixture>` | Runs the fixture's `seed` spec (deeplink, script, or API call). Mutating. |
| `note` | `note: "<reason>"` or `{outcome, reason}` | Records a workflow outcome (`pass` by default). |
| `screenshot` | `screenshot: "<reason>"` | Captures evidence. |

**`clearOverlay`** hides an open keyboard and does nothing else. Otherwise, on Android it presses BACK only when a BACK-dismissible overlay is actually open (a dialog, sheet, permission prompt, or RN LogBox or RedBox), never on a bare screen and never for a snackbar or banner; with nothing to clear it reports `nothingCleared:true`. On iOS it dismisses alerts and sheets with the native alert API. When the backend has no alert API or the overlay survives, the step reports `nothingCleared:false` with a note instead of claiming success.

**Mutating steps** are `networkOffline`, `networkOnline`, `seed`, `restartApp`, and `openUrl` with a `${VAR}` in its URL. They, and the OCR steps `tapOcrText` and `assertOcrText` (which send screenshots to an external provider), need the `flow_mutation_run` consent in `qa_flow_run` (risk high for script seeds, otherwise medium). On a headless client (`codex exec`, `claude -p`) that consent can only come from [operator pre-approval](concepts.md#operator-pre-approval), and because these steps can run seed scripts or an external OCR command, it also needs `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1`. `qa_smoke` never runs such a flow implicitly: it records it as `blocked` (category `destructive_refused`) with a pointer to `qa_flow_run`. OCR steps are refused in sensitive sessions (`UNSAFE_ACTION_REFUSED`).

**Paths**: `tapImage` and `assertImage` templates and `assertDiff` baselines must resolve (after symlinks) inside the project root, otherwise the step fails with `UNSAFE_ACTION_REFUSED`.

**Sensitive sessions**: `screenshot`, `assertVisual`, and failure evidence are not captured; the step detail says so, and an `assertVisual` checkpoint is recorded as `skipped`.

## Waiting for targets

Flows wait for their targets, so most flows need no explicit waits:

- `tap` and `inputText into` poll for the target (every 300 ms) for up to 5 s before failing, and `assertVisible` polls for up to 5 s.
- `inputText into` types as soon as the soft keyboard is up after focusing the field, capped at 600 ms (before 2.3.0 it always slept 600 ms).
- After every step the screen settles (see [Screens, refs, and settling](concepts.md#screens-refs-and-settling)), and the first lookup of the next step reuses that settled dump instead of taking a new one.
- `assertNotVisible` checks once. Use `waitForVisible {text, timeoutMs}` for anything slower than 5 s, such as a login round trip.

## Batching steps

When an agent already knows 3 or more steps, one `qa_flow_run {sessionId, flowYaml}` call runs them server-side, with the same waits and settling, instead of one `qa_act` call per step. That saves a round trip and a full result per step. `flowYaml` is a flow inline, so nothing is written to `.swipium/flows/`:

```yaml
name: add_item
steps:
  - tap: "Add"
  - inputText: { into: "Title", text: "Milk" }
  - tap: "Save"
  - assertVisible: "Milk"
```

A failure returns the failed step, a screenshot, and the `failureCode`, like any flow run. Keep `qa_snapshot` and `qa_act` for exploring a screen you don't know yet. To keep a batch, save it under `.swipium/flows/` and validate it with `qa_flow_check`.

## Variables

`${NAME}` resolves in this order:

1. **Explicit variables**: `qa_flow_run {variables:{…}}` (or `qa_smoke {variables}`).
2. **Stored session inputs**: values supplied through a needs-input answer (`qa_continue_from_blocker`) or first-run credentials. Values are never echoed; only their names are listed in `notes`.
3. **The server environment, for `SWIPIUM_*` names only.** Any other environment variable is never read, because a flow file can come from an untrusted repository. The step fails with `MISSING_FIXTURE` and a message such as `Variables not available: HOME (flows only read SWIPIUM_* environment variables; pass it via qa_flow_run { variables } or rename it SWIPIUM_HOME)`.

A missing variable is not locator drift, so the failure does not point at `qa_flow_repair`.

**Secret names**: a variable whose name contains `pass`, `secret`, `token`, `otp`, `pin`, `cvv`, `key`, or `code` (case-insensitive) is a credential. Its resolved value joins the session's redaction set and is scrubbed everywhere, and `inputText` treats it as secret. So `SWIPIUM_TEST_PASSWORD` and `SWIPIUM_VERIFICATION_CODE` are secrets; `SWIPIUM_TEST_EMAIL` is not. See [Secrets and redaction](concepts.md#secrets-and-redaction).

Set `SWIPIUM_*` test data in the MCP server's `env` ([environment variables](../README.md#configuration--environment-variables)).

## Starter templates

`swipium init flows [--root <dir>] [--force]` writes starter flows under `.swipium/flows/` (launch smoke, login smoke, iOS WDA smoke, offline, permission prompt, deep link, saved-item persistence, and a visual map or canvas smoke) plus a `smoke` pack in `.swipium/packs/smoke.yaml` (a list of flow names; no tool runs packs, so use it from your own scripts). Existing files are kept unless you pass `--force`. Edit the selectors and variables, then validate each flow with `qa_flow_check` before running it.

## Compile and repair

- **Record, then generate**: `qa_generate {target:"flow"}` turns a session's recorded actions into one flow; `qa_generate {target:"suite"}` writes a POM suite and compiles it into flows. Recorded secrets become `${SWIPIUM_*}` placeholders.
- **Compile a suite on disk**: `qa_flow_compile {suite}` (or `swipium suite compile` in CI) resolves page-object refs to selectors, carries variables, writes `.swipium/flows/<slug>.yaml` plus a copy under `.swipium/compiled/`, and validates each flow. It needs no session, which makes it the path for committed or hand-edited suites.
- **Repair a failed step**: when `qa_flow_run` fails on a locator, its `nextSteps` point at `qa_flow_repair {flow, failedStep}`. The repair proposes a stronger locator from the current screen, restricted to the failed target's role, and can patch the flow file (`apply:true`) at high or medium confidence. Details: [qa_flow_repair](tools.md#qa_flow_repair).

## CI policy

`qa_flow_check {ci:true}`, the flow CI preflight, and the report release gate (`qa_report` CI exports and `swipium report --fail-on-gate`) read an optional `.swipium/policy.json`:

```json
{
  "ciAllowMutations": ["network", "seed", "restart"],
  "blockOn": ["native_crash", "error_boundary", "anr"],
  "warnOn": ["visual_diff", "missing_fixture"],
  "ignoreKnown": ["REVENUECAT_BILLING_UNAVAILABLE_ON_EMULATOR"]
}
```

### Mutations in CI

`ciAllowMutations` lists the mutating steps a CI run may execute. Without a policy file, or with an empty list, every mutating step is flagged. Tokens are matched case-insensitively with punctuation ignored:

| Step | Accepted tokens |
| --- | --- |
| `networkOffline`, `networkOnline` | the step name, `network`, `network_toggle`, `connectivity` |
| `seed` | `seed`, `seeds`, `fixtures`, `fixture_seed` |
| `restartApp` | `restart_app`, `restart`, `lifecycle`, `app_control` |
| `openUrl` with a `${VAR}` | `open_url` |
| any | `all`, `*`, `mutating_steps` |

The CI variable preflight also reports every `${VAR}` that a CI run cannot resolve: names outside `SWIPIUM_*` always count as missing, because flows never read them from the environment.

### Release gate

`blockOn`, `warnOn`, and `ignoreKnown` decide which failures block a release. Their rules (including that, without a policy file or with an empty `blockOn`, every failure blocks and `warnOn` is ignored) are in [ci-reports.md: Release-gate policy](ci-reports.md#release-gate-policy). Tokens name failure codes such as `native_crash` or `error_boundary`.

Codes are listed in the [failure-code catalog](tools.md#failure-codes). Export formats and CI recipes are in [ci-reports.md](ci-reports.md).
