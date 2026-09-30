# Tool Reference

Swipium exposes 55 public MCP tools. The intended default entry point is `qa_test_this`.

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint:false`, since Swipium only talks to local simulators, toolchains, and the project), so clients can auto-approve the read-only ones. The server also sends MCP `instructions`: a short operating manual covering the first call, polling, stop rules, consent, and project-root resolution. `qa_status` without a `sessionId` returns the same rules plus the tool groups below.

## Start

Use these tools to start autopilot work, get oriented, poll jobs, handle blockers, and fetch artifacts.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_test_this` | Autopilot for "test it": resolves the project, finds or builds an artifact, prepares a simulator, runs smoke or exploration, reports, and can generate a suite. `mode:"plan"` (the default) has no side effects. `mode:"execute"` runs as a background job. | The user gives a low-context request such as "test this app". |
| `qa_status` | Without `sessionId`, returns first-call orientation (operating rules and capability groups by name). With `sessionId`, returns compact session state and `nextBestAction`, the single next tool to call with its args. `goal` biases the recommendation. | The agent needs to orient itself, recover context, or decide the next call. |
| `qa_job_status` | Polls a background job. `waitMs` (at most 120000) long-polls: it returns as soon as the job leaves `running`, or returns `waited.timedOut:true`. | A tool returned a `jobId`. |
| `qa_job_cancel` | Cancels a running job and aborts its child processes. Side effects already applied are not rolled back. | A long-running job must be stopped early. |
| `qa_explain_blocker` | Explains a `failureCode`: meaning, owner, retry safety, and recovery. Every code a tool can return is in the catalog. | A run stops with a blocker and the user needs a plain explanation. |
| `qa_continue_from_blocker` | Resumes after a `needs_input` question. Secrets join the redaction set right away. Returns `ignored[]` for choices it could not apply (each with how to apply it), and returns `projectRoot` for a `monorepo_target` answer. A `monorepo_target` must be an existing directory inside the project root (one of the offered candidates); `/`, `~`, or any path outside the root is `INVALID_ARGUMENT`. | A blocker asks for credentials, OTP, a target choice, or approval. |
| `qa_get_artifact` | Fetches artifact metadata or contents by `swipium://` URI. Images return metadata unless `mode:"inline"`. A text artifact whose redaction was `partial` (secrets shorter than 3 characters are not scrubbed) reports `redaction` plus `redactionNote`. | A report, screenshot, dump, log, or generated file must be read. |

The typical loop is `qa_test_this {mode:"execute"}`, then `qa_job_status {sessionId, jobId, waitMs:60000}` until the job result's `state` is `completed`, `blocked`, `unsafe`, or `needs_input`, then `qa_get_artifact {uri: reportUri}`.

`qa_test_this` job states: `completed` and `needs_input` end with job status `done`; `blocked` and `unsafe` end with `failed`. `needs_input` means the run stopped on one question it was asked to stop for (`stopOnNeedsInput`, or `goal:"test_login"`), such as a login form that needs credentials. The result carries `needsInput` (the question, its fields, and a `resume` call to `qa_continue_from_blocker`), and `nextRecommendedAction` is that resume call. Without `stopOnNeedsInput`, the run completes with pre-login coverage and returns the question as `optionalQuestion`. Credential values are held in memory only, so after a server restart a login run asks for them again, even though the stored metadata still lists them. Answering the credentials question with "test pre-login only" marks login out of scope for the session (`loginOutOfScope:true`). A blocker resume replays the original `goal`, `goalText`, and flags. Plan-mode steps that route back through `qa_test_this`, such as a build or `.aab` conversion, carry `mode:"execute"` and the original goal and flags. On iOS without a ready WebDriverAgent, the default run skips suite generation and exploration, records a workaround, and runs a visual-only smoke. Only explicitly requested WebDriverAgent work returns `WDA_UNREACHABLE`: `generateSuite`/`explore` flags, or `goal` `create_automation_suite`, `explore`, `reproduce_bug`, or `test_login`. Its `nextSteps` include a `goal:"smoke"` call. When the only Android device online is a physical phone, the result is `PHYSICAL_DEVICE_UNSUPPORTED`. When `adb` is missing, it is `ADB_NOT_FOUND`. When a phone is connected and an AVD exists, Swipium boots the AVD and installs only on the new emulator serial, after `sys.boot_completed`. `responseMode` (`compact`, `normal`, or `verbose`) sets the session's text channel. The terminal result keeps the report compact: `reportSummary`, `reportUri`, and suite and app-map counts. The full report is at `reportUri`.

## Setup

Use these tools to verify the local environment, create sessions, and prepare simulator targets.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_doctor` | Checks Node, Android Emulator readiness, iOS Simulator readiness, WDA status, and stale-client symptoms. `platform` is `android`, `ios`, or `both` (default `both` on macOS). `client` is `claude`, `gemini`, `codex`, `cursor`, or `vscode` and adds registration hints. | Before the first run, or when setup fails. |
| `qa_start_session` | Opens a project session with budget, response mode, fixtures, and sensitive mode. See [qa_start_session](#qa_start_session). | Running lower-level tools directly instead of `qa_test_this`. |
| `qa_prepare_target` | Prepares an Android Emulator target: device, Metro, install, launch, with one combined consent. | Testing Android on an emulator. |
| `qa_prepare_ios_target` | Boots an iOS Simulator, installs a simulator `.app`, launches it, and reports WDA or visual-only mode. A `.ipa` is refused (`IPA_NEEDS_REAL_DEVICE`). | Testing iOS on a simulator. |
| `qa_ios` | iOS Simulator lifecycle: `list`, `boot`, `install`, `launch`, `terminate`, `openurl`, `logs`, `privacy_reset`, and `erase`. `install`, `privacy_reset`, and `erase` are consent-gated; booting a simulator is low-risk and reversible, so `boot` is not. Screenshots go through `qa_screenshot` and WebDriverAgent through `qa_wda`. | Direct iOS Simulator control is needed. |
| `qa_wda` | Checks, attaches, builds, or starts WebDriverAgent for structured iOS automation. `device` is the simulator UDID (`udid` is a deprecated alias). | iOS needs a structured UI tree. Without WDA, iOS stays in visual-only mode, where `qa_visual` does the checking. |

### Project root resolution

Tools that need a project resolve it in this order:

1. The `projectRoot` argument. It must be an absolute, existing directory. An invalid value is an error, never silently replaced.
2. MCP roots, when the client exposes a workspace.
3. `SWIPIUM_PROJECT_ROOT` from the server environment.
4. `CLAUDE_PROJECT_DIR`, which Claude Code sets for stdio servers.
5. The server's working directory, but never `/` or `$HOME`, and only when it contains a project marker (`package.json`, `app.json`, `pubspec.yaml`, Gradle files, `Podfile`, an `.xcodeproj`/`.xcworkspace`, or an `android/` or `ios/` directory).

When nothing resolves, tools fail with `PROJECT_ROOT_UNRESOLVED`. Pass an absolute `projectRoot`, or set `SWIPIUM_PROJECT_ROOT` in the MCP server config `env`.

Every tool result built from a resolved root carries `rootSource` (`arg`, `mcp-roots`, `env:SWIPIUM_PROJECT_ROOT`, `env:CLAUDE_PROJECT_DIR`, or `cwd`) and `projectRoot`. When the root came from the server's working directory, the text also says `project root taken from server cwd: <path>; pass projectRoot to override`. Calls that reuse a session's root do not re-resolve it, so they carry no `rootSource`.

### qa_start_session

- `budget` defaults to 8 minutes, 20 actions, 8 screenshots, 3 snapshot failures, and 3 no-change actions. `profile` sizes the time budget: `guardrail` 8m, `login_smoke` 10m, `full_smoke` 15m, `install_smoke` 20m.
- `responseMode` controls the text channel of every tool in the session: `compact` returns a summary and URIs, `normal` adds compact JSON without the fields the summary already rendered (for example `elements`, listed in `renderedAbove`), and `verbose` returns everything. `structuredContent` is always complete.
- `sensitive:true` refuses every screenshot, recording, and on-screen evidence capture.
- `fixtures` declares preconditions, merged with `.swipium/fixtures.json`, so unmet ones report as blocked instead of failed. The tool schema only advertises `{ name, … }`. The full shape is validated server-side, and a bad shape returns `INVALID_ARGUMENT`:

```jsonc
{
  "name": "saved_flight",                 // required
  "description": "…", "requiredState": "at least one saved flight", "recommendedSetup": "…",
  "testAccount": "…", "apkPath": "…",
  "value": "BA123",                       // non-secret test input for exploration text entry
  "disposable": true,                     // only for data destructive QA may mutate or delete
  "environment": "test",
  "fields": {                             // typed catalog for form entry, matched by label/id/role
    "email": { "var": "SWIPIUM_TEST_EMAIL", "secret": false },
    "name":  { "generator": "full_name" } // email, person_name, number, text, city, country, color, phone, date, …
  },
  "seed": {                               // opt-in, consent-gated way to create the precondition
    "type": "script",                     // deeplink | script | api
    "command": ["node", "scripts/seed.js"], "idempotent": true,
    "cleanup": { "type": "api", "url": "http://localhost:3000/reset", "method": "POST" }
  }
}
```

### qa_wda

- **Session capabilities**: every WebDriverAgent session created for an app (`bundleId`) sends `shouldTerminateApp:false` in `capabilities.alwaysMatch` unless `ios.wda.capabilities` in `.swipium/config.json` sets it, because WebDriverAgent tears the previous session down with *that* session's setting before it applies a new request. A fresh `attach` still launches the app as before. Re-binding a resumed session after a server restart, and recovering from an invalid-session error, also send `forceAppLaunch:false`, so the running app is reused instead of relaunched.
- **Managed WDA lifetime**: `start` spawns WebDriverAgent (`xcodebuild test-without-building`) and records its pid and URL in `~/.swipium/processes.json`. `stop` terminates it, including one adopted from a previous server run. A normal server shutdown does not stop managed WDA, so a resumed iOS session can keep using it. On the next startup, a managed WDA from a previous server run is adopted (kept and re-owned by the new server) only when it is less than 12 hours old and its `GET /status` reports ready. Older or unhealthy ones are stopped, as are orphaned Metro bundlers and screen recorders. A process still owned by another running Swipium server is never touched. Each registered process records its start time and full command line; an orphan is signalled or adopted only when both still match, so a recycled pid (another `node`, the `adb` server, your own `xcodebuild` WDA) is never touched. Only a process Swipium spawned as a process-group leader has its group signalled. The startup sweep runs in the background after the server is connected. `start` is refused (`WDA_START_FAILED`, with `managedPid`) while a managed WDA for the session is still running: attach to it or `stop` it first.
- **Remote WDA URLs**: a non-loopback `webDriverAgentUrl` (anything other than `localhost`, `127.0.0.0/8`, or `[::1]`) is refused with `DESTRUCTIVE_REFUSED` unless the call passes `allowNonLoopback:true` and the user approves the consent prompt. The only pre-approval is user-level: `SWIPIUM_ALLOW_REMOTE_WDA`, a comma-separated list of exact WDA base URLs set in the MCP server's environment. The repository's `.swipium/config.json` cannot pre-approve one: `ios.wda.allowNonLoopbackUrls` no longer skips consent, and a non-loopback `ios.wda.url` is labelled "configured by the repository (.swipium/config.json) — unreviewed" in the prompt. `qa_prepare_ios_target` / `qa_test_this` never connect to a non-loopback configured URL on their own: they stay visual-only (or fail with `DESTRUCTIVE_REFUSED` when WDA is required) until you attach it explicitly with `qa_wda`.

## Build

Use these tools to resolve a device and an installable artifact, or build one from source locally. `qa_build` with `mode:"run"` is consent-gated (risk high). Everything else here is side-effect free.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_resolve_target` | Picks the best device or simulator (online beats booting; honors a requested platform or device). `include:["context"]` adds project context. `include:["plan"]` adds READY, BLOCKED, and UNSAFE workflows. | The agent must choose where to run, or wants a preflight view before acting. |
| `qa_resolve_artifact` | Finds the best installable `.apk`, `.aab`, `.ipa`, or `.app` and lists where it looked. | An artifact path is unknown or ambiguous. |
| `qa_build` | `mode:"plan"` (default) proposes exact build commands per framework and platform. `mode:"run"` builds from source as a consent-gated job, captures a build log, and re-resolves the artifact. | The agent needs to know how the app would be built, or no reusable artifact exists. |
| `qa_bundletool` | Converts an `.aab` into an installable universal APK or a device-specific APK set. | Only an Android App Bundle is available. |

### qa_resolve_target include

- **`context`**: framework (`expo`, `bare-react-native`, `native-android`, `native-ios`, `flutter`, or `unknown`), monorepo location, prebuilt artifacts, online Android devices, AVDs, booted and available iOS simulators (`iosBooted` and `iosAvailable`, macOS only), toolchain (`adb`, `emulator`, `java`, `aapt2`, `xcodebuild`), and blockers. A usable iOS simulator means `adb` is not reported missing.
- **`plan`**: READY workflows (with a budget profile and satisfied preconditions), BLOCKED workflows (category `missing_device`, `missing_artifact`, `missing_test_data`, or `missing_toolchain`, plus the required state and how to unblock), and UNSAFE workflows (with a reason, for example `bundle_cache_loss` for `fresh_start` on a debug RN/Expo build). A booted or bootable iOS simulator counts as a device. With `sessionId`, the session's declared fixtures, observed auth, and prepared app inform the plan. Without one, `.swipium/fixtures.json` does.
- When target selection itself is blocked (for example `PHYSICAL_DEVICE_UNSUPPORTED`), the requested sections are still attached to the error envelope.

## Device

Use these tools to inspect and control the device and app environment without raw `adb` or `simctl`. Mutating actions are consent-gated and recorded as environment changes. Network changes are auto-restored at report time.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_device_info` | Reports model, SDK, ABIs, locale, screen, orientation, and installed apps. On an iOS backend it returns `platform:"ios"` simulator facts (name, runtime, state, screen). Read-only. | The agent needs device context before testing. |
| `qa_orientation` | Sets portrait, landscape, or auto rotation. Android only; other backends return `BACKEND_UNSUPPORTED`. | A screen must be tested in a specific orientation. |
| `qa_geolocation` | Spoofs a GPS location on the emulator. Consent-gated. | Testing map or location-aware screens. |
| `qa_network` | Reports status, sets offline or online, or restores airplane mode. Consent-gated and auto-restored. | Testing offline behavior or network errors. |
| `qa_metro` | Reports, starts, stops, or diagnoses the RN/Expo Metro bundler, with RedBox detection. `start` is consent-gated (risk medium). | A debug RN/Expo build needs Metro. |
| `qa_app_control` | Runs launch, foreground, background, force_stop, restart, clear_data, or fresh_start. Wipes are destructive and consent-gated. | The app lifecycle must be controlled directly. |
| `qa_screen_record` | Records a screen video to an mp4 artifact (start, status, stop). Consent-gated, with sensitive-screen warnings. | A run needs a video of the reproduction. |

## Drive

Use these tools to observe the UI, act on it, collect evidence, and record results.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_snapshot` | Captures compact structured UI elements (`@eN` refs) with a quality verdict. On WDA, an element's `id` is its accessibility identifier, which WDA reports as `name` when that differs from the label. iOS `TextField`, `SecureTextField`, `SearchField`, and `TextView` elements are `text-field` elements that show their typed value, except that secure fields stay masked. Banner and snackbar overlays are reported only when there is an overlay signal (an overlay-like class or id, a dismiss control, or banner wording). Navigation-bar titles, text fields, and list rows are not reported as overlays. | The agent needs selectors, visible text, or UI state. |
| `qa_inspect` | Returns the full attributes of one `@eN` element from the latest snapshot. Secure values are masked. | One element's details are needed without dumping the whole tree. |
| `qa_act` | Taps, types, clears, swipes, scrolls, presses keys, opens URLs, and waits, then observes. See [qa_act](#qa_act). | The agent drives the app step by step. |
| `qa_clear_overlay` | Dismisses common overlays: keyboard, permission dialogs, RN LogBox, sheets, toasts. A keyboard the backend cannot dismiss (for example WDA "Did not know how to dismiss the keyboard" on iOS) returns `KEYBOARD_NOT_DISMISSIBLE` with next steps (press enter, the app's Done button, or `tap_outside`). | Something blocks the next action. |
| `qa_check_health` | Checks foreground status, crash, ANR, error boundaries, and error surfaces. | The agent needs to tell app bugs from environment issues. |
| `qa_screenshot` | Captures a screenshot artifact with coordinate-space metadata. Withheld when a password or OTP field is on screen unless `force:true` (`CAPTURE_WITHHELD_SECURE`). Counts against the screenshot budget. | Visual evidence is required. |
| `qa_note` | Records a structured outcome (pass, fail, blocked, skipped, not_applicable) with a category and evidence. | The agent logs a result the report must reflect honestly. |
| `qa_visual` | Screenshot-based checks: `assert`, `baseline`, `diff`, `find_text`, and `find_image`. See [qa_visual](#qa_visual). | The screen has no usable UI tree (map, canvas, game, or iOS without WDA), or needs visual-regression checks. |
| `qa_wait` | Waits, without a shell, for `device_online` or `metro_ready`. Use `qa_job_status` with `waitMs` to wait for jobs. | The agent must block on a setup condition. |

### qa_act

- **Targets**: `@eN` refs from `qa_snapshot` (invalid after navigation), `text`, `id`, a native `selector` (WDA-backed iOS: `accessibility id`, `name`, `predicate string`, or `class chain`), or `x`/`y`.
- **Keyboard obstruction**: if a tap target's center sits inside the soft keyboard's reported frame, Swipium hides the keyboard (never a blind BACK), re-resolves the target, and taps only once it is uncovered. If the keyboard cannot be hidden, the result is `KEYBOARD_OBSTRUCTION` with `changedState:false`. If it was hidden but the target is gone or still covered, the result is `KEYBOARD_OBSTRUCTION` with `changedState:true` and `keyboardHidden:true`. In both cases nothing is tapped. Targets above the keyboard, such as an accessory toolbar or suggestion chips, are tapped without hiding it. When the keyboard is up but its area is unknown (the backend reports no frame, or a frame taller than 55% of the screen), Swipium taps without hiding it and adds the warning `keyboard is up; could not determine its area`. `ignoreOverlay:true` skips this check and the overlay check. Coordinate taps are always treated as deliberate.
- **Warnings**: non-fatal caveats come back in `warnings[]`. One example is `WDA session was re-created (requested without relaunching the app) — verify the screen state`: after an invalid-session error the session is re-created with `forceAppLaunch:false` and `shouldTerminateApp:false`, which asks WebDriverAgent not to relaunch the app but cannot guarantee the app is still where it was.
- **Overlay obstruction**: another element drawn over the target returns `blockedByOverlay` instead of tapping blindly.
- **Scroll**: a plain `scroll` performs exactly one swipe. With `untilVisible`, visibility is checked before the first swipe, and swiping repeats up to `maxScrolls` (default 8, used only with `untilVisible`). The result reports `swipes`, and `endOfList:true` when a swipe no longer changes the screen. Each swipe is anchored inside the largest scrollable container on screen (Android `scrollable="true"`, iOS ScrollView/Table/CollectionView), kept 10% inside its edges, so it never starts on a sticky app bar; clipped containers with inverted bounds are ignored, and the screen center is used when no container is known. `anchoredIn` reports `scrollable` or `screen`. A match counts as found only when its center is on screen and not under a known keyboard frame; a row that just crosses the bottom edge gets one more swipe.
- **changed**: for `scroll` and `swipe`, `changed` is true when elements appeared or disappeared OR when element positions moved, so a scroll that shifts content without adding or removing elements still counts as a change. For every action, a checked/selected/value change (a Switch or Checkbox toggle, a tab selection) also counts as a change and is listed in `stateChanged`, so a toggle is never retried as a press (which would toggle it back).
- **Typing on Android**: text is escaped for the device shell, including spaces, braces, brackets, and glob characters. A literal `%s` is delivered correctly. Characters `adb input text` cannot deliver (non-ASCII or control characters) return `TEXT_INPUT_UNSUPPORTED` with `changedState:false`: the value is checked before the field is focused or cleared, so a refused replace-mode type leaves the field untouched. Typing into a secure field registers the value for redaction everywhere.
- **Placeholders**: `type` expands `${SWIPIUM_*}` placeholders (only that prefix) from session inputs (for example the credentials given to `qa_continue_from_blocker`), else from the Swipium server's environment. The value is typed but never echoed (`placeholders` lists the names), and the action is recorded with the placeholder. A typed literal that equals a stored session input (email included) is recorded as that input's placeholder. Secret inputs, and environment variables whose names look secret, join the redaction set. An unresolvable placeholder returns `MISSING_TEST_DATA` before anything is tapped.
- **Secret recording**: a typed value is recorded as `secret:true` with no plaintext (a `${SECRET_n}` variable in generated flows) when the field is secure OR when the value equals or contains a value already registered as a session secret, even in an ordinary text field. This applies to native-selector typing too.
- **press back on iOS**: iOS has no back key. On WDA, `press key:"back"` taps the navigation bar's back button when one is on screen (the first button in the bar's left half), otherwise it performs a left-edge swipe (x=2 to 60% of the width, at mid-height). `backVia` reports `nav_button` or `edge_swipe`. If neither is possible, the result is `BACKEND_UNSUPPORTED`.
- **keyboardHidden**: when the keyboard covered the target and Swipium hid it before acting, a successful result carries `keyboardHidden:true` and a note.
- **Device binding**: a device that is still booting returns `DEVICE_NOT_READY`. A physical device returns `PHYSICAL_DEVICE_UNSUPPORTED` (simulator-only policy). A session that already has a device is only re-bound to that device: a resumed iOS session re-attaches its simulator (WDA when the session had attached it and it is reachable, else the simctl backend), a simulator that is not booted returns `DEVICE_NOT_READY`, and an offline device is never replaced by a different online one (including an Android emulator for an iOS session).
- **Failure codes**: an unknown `sessionId`, a missing required field, or an absent target returns `INVALID_ARGUMENT`; a stale ref returns `STALE_REF`; no match returns `ELEMENT_NOT_FOUND`.
- **observe**: `diff` (the default once a snapshot exists) returns elements added and removed, `full` returns the capped list, and `none` returns verdicts only. When more than half of the post-action elements are new (a navigation), `diff` returns the capped full list with `diffAsFull:true`, `addedCount`, and `removedCount` instead of listing every removed element. `changed`, `settled`, quality, and health are always returned.

### qa_visual

| mode | What it does |
| --- | --- |
| `assert` | Records a visual assertion in one call: screenshot evidence plus a `qa_note` with `verifiedVisually:true`. `assertion` is required, and `pass:false` means the expected thing is not visible. A pass is also recorded as a semantic step, so generated suites keep the check. Returns `{mode, assertion, pass, screenshotUri, coordinateSpace, secureFieldCheck}`. |
| `baseline` | Saves the screen as `<repo>/.swipium/baselines/<name>.png` (in the repository, so commit it or ignore it) plus a session artifact. `name` must match `[A-Za-z0-9._-]{1,64}` and must not start with `.`. Symlinked baselines are refused (`VISUAL_PATH_REFUSED`). |
| `diff` | Compares the screen to a baseline and returns the changed ratio, the changed box (screenshot and device space), and an evidence artifact. `pass` means within `threshold` (default 0.02). |
| `find_text` | OCR via a locally configured provider. None is bundled. Consent-gated, because the screenshot is passed to that local command. The consent shows every command that will run: the `visualMaskCommand` (when configured) and the `ocrCommand`, each with its argv and where it came from (a repository `.swipium/config.json` command is labelled "unreviewed"); `affects` carries `maskArgv` too. OCR text is secret-redacted. |
| `find_image` | Template-matches a PNG. `template` must be inside the project root (symlinks resolved) or a `swipium://` artifact of the same project. |

- **Coordinates**: finds return a screenshot-pixel bbox and a tappable `devicePoint`. The device point is in points on iOS (WDA, and the `idb` fallback) and in pixels on Android. Every result declares its `coordinateSpace`.
- **Tapping**: `tap:true` taps the found point through the driver. On the simulator without WDA it uses `idb` when it is on PATH, else it returns `BACKEND_UNSUPPORTED` with the coordinates. Taps are recorded as session actions (for `qa_generate`) and count against the action budget.
- **Budgets**: every capture counts as a screenshot. Nothing runs once a budget is spent.
- **Secure screens**: every mode is withheld when a password or OTP field is on screen. When the cached UI tree is missing or predates a visual tap, Android and WDA re-dump the tree to check, so a visual tap alone does not leave the next call unverified. Without any UI tree (the simulator without WDA) in a session that has handled credentials, only `baseline` is withheld, because it persists the capture into the repository. `diff` and `assert` still run but save no screenshot artifact: `currentUri`/`screenshotUri` is `null` and `captureWithheld:true`. `find_image` returns coordinates only. `find_text` screens the OCR text itself, and a screen that reads like a password, OTP, or payment screen is withheld. Every withheld result has `failureCode: "CAPTURE_WITHHELD_SECURE"`. `force:true` overrides all of these. Outputs carry `secureFieldCheck`: `clear`, `secure`, `ocr` (only the OCR text was checked), `unverified`, or `forced`. `ocr` and `unverified` come with a warning.
- **Missing arguments**: a mode called without its required argument (`find_text` without `query`, `baseline` or `diff` without `name`, `find_image` without `template`, `assert` without `assertion`) returns `INVALID_ARGUMENT`.
- **OCR provider contract**: set `ocrCommand` in `.swipium/config.json` (an argv array with an `{image}` placeholder, or `{command, io:"json", timeoutMs}`), or the `SWIPIUM_OCR_CMD` env var. Project config wins. The command gets a PNG path (already masked when `visualMaskCommand` is configured). It must print JSON to stdout, either `[{"text":"Log in","confidence":0.97,"bbox":{"x":53,"y":182,"width":104,"height":38}}]` or `{"regions":[…]}`, with the bbox in screenshot pixels, confidence from 0 to 1, and one region per text line. With `io:"json"`, it also receives a `swipium.visual.provider.v1` JSON line on stdin. The command runs with its working directory set to the project root, so relative argv entries such as `.swipium/ocr_tesseract.py` resolve there, and the screenshot path is symlink-resolved (for example `/private/tmp/...`, which tesseract can open on macOS). A non-zero exit or a timeout returns `OCR_PROVIDER_FAILED` with `exitCode`, `timedOut`, and the trimmed, secret-redacted `stderr`, rather than `found:false`. The same applies to `visualMaskCommand`. Provider images are written to a private per-call temporary directory (mode 0700, random name) that is removed after the call. The timeout is 30 s, and Git executables are refused. Without a provider, `find_text` returns `OCR_NOT_CONFIGURED` with an `exampleProvider`: a verified tesseract script to save as `.swipium/ocr_tesseract.py` (needs `brew install tesseract`), used with `"ocrCommand": ["python3", ".swipium/ocr_tesseract.py", "{image}"]`.

## Run

Use these tools to run broader QA workflows and produce reports.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_smoke` | Runs launch smoke, baseline health, screenshot evidence, and every saved flow. | The app is prepared and the agent needs a deterministic smoke pass. |
| `qa_explore` | Performs bounded, safe-by-default exploration as a job, builds a screen graph, records taps, and updates the app map. `generateSuite:true` also writes and compiles a POM suite from the promoted paths. | The agent needs to discover reachable workflows or collect runtime app-map data. |
| `qa_report` | Generates the session report (findings, blockers, evidence, mutations, workarounds, next actions, separate app and coverage verdicts). `format` exports markdown, json, junit, sarif, github-summary, playwright, or flow. | A run should be summarized or exported to a CI sink. |

### qa_report CI formats

The CI formats carry the `.swipium/policy.json` release-gate verdict. See [ci-reports.md](ci-reports.md). Files can also be rendered outside the agent with the deterministic `swipium report` CLI (`--format junit|sarif|github-summary|markdown|json`, `--fail-on-gate`).

- **SARIF 2.1.0**: every result is anchored to a real repository file (`%SRCROOT%`-relative `physicalLocation`), as GitHub code scanning requires. `swipium://` evidence stays in related locations and properties. `invocations[0].executionSuccessful` is always `true`, because the run itself worked. The gate verdict is in `runs[0].properties.releaseGateVerdict` (`pass` or `block`).
- **JUnit**: failed workflows and high-severity findings are `<failure>`. Blocked, skipped, and not-applicable outcomes are `<skipped>`. Failures the policy treats as lenient (`warnOn` or `ignoreKnown`) are emitted as `<skipped message="policy …">`, so a PASS gate never fails CI.
- **github-summary**: Markdown for `$GITHUB_STEP_SUMMARY`, capped at 900 KB, below GitHub's 1 MiB limit, so the verdict always survives. Truncation is stated in the output.

### qa_report findings and tool status

- **Deduplicated findings**: identical findings (same failure code and kind, severity, layer, screen or foreground, and message) are reported once, with `count`, `firstAt`/`lastAt`, and every distinct `screenshotUris` entry. `findingOccurrences` keeps the raw total. Text and markdown outputs show repeats as `(×N)`.
- **Tool status**: tool calls that return an error for a session (for example a WDA 404 or `UNKNOWN`) are recorded in the session (`toolErrors`, persisted). Consent refusals and missing test data are not counted. `toolVerdict.status` is `PASS` (no tool errors or limitations), `DEGRADED` (tool errors recorded: the summary gives the count and codes, and `toolErrorsByCode` breaks them down), or `BLOCKED` (a workflow was limited by a Swipium or MCP capability). Tool status never changes the app verdict.

## App Map

Use these tools to build and read Swipium's durable app knowledge map (`.swipium/app-map.json`, also served as MCP resources).

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_app_map_build` | Builds or updates the map from static analysis and runtime observations. | The project needs durable QA memory. |
| `qa_app_map_read` | Reads compact sections: summary, screens, features, auth, automation, testSuite, or full. | The agent needs app context without flooding the transcript. |
| `qa_app_map_query` | Searches features, screens, tests, and code links with ranked results. | The user asks about a feature, screen, or test surface. |
| `qa_app_map_feature_scope` | Resolves a feature id or free-text query into a focused test scope: ranked candidates, code symbols, screens, existing tests, objective, and plan. Read-only, and works before a map exists. | The user names a feature and the agent needs its scope. |
| `qa_app_map_update` | Applies targeted, provenance-tracked edits: note, test cases, automation suite, environment, or feature coverage. Existing entries with the same id or path are overwritten. | The map needs a small correction or annotation. |

## Feature Testing

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_test_feature` | Tests a named feature. `mode:"plan"` (default) returns the read-only test plan. `mode:"execute"` runs targeted exploration as a job, records cases, and updates the map and report. `sessionId` is optional: without one, `execute` bootstraps a device from `projectRoot` (consent-gated). | The user asks to plan or run a test of a specific feature. |

## Flows

Use these tools to validate, run, compile, and repair reusable flows.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_flow_check` | Parses and statically validates a flow (a lint of the YAML). `ci:true` adds CI preflight warnings. | A flow file should be checked before execution. |
| `qa_flow_run` | `mode:"run"` (default) executes a flow against a prepared session. `mode:"plan"` previews execution per backend without a device. | A saved flow needs to run, or its feasibility should be checked first. |
| `qa_flow_compile` | Compiles an existing POM suite on disk (`.swipium/suites/<suite>.yaml`, committed or hand-edited) into runnable Flow V2 under `.swipium/flows/`. Needs no session or recorded actions. | A suite on disk needs runnable flows, for example after editing page objects. |
| `qa_flow_repair` | Suggests, or safely patches, a stronger locator for a failed flow step from the current screen. | A flow step fails on a brittle locator. |

Without a session, `qa_flow_check` and `qa_flow_run mode:"plan"` resolve flow names the same way other tools resolve the project root: the `projectRoot` argument, then the session root, then MCP roots, then `SWIPIUM_PROJECT_ROOT` / `CLAUDE_PROJECT_DIR`, then a server cwd that looks like an app. A flow that does not exist returns `FLOW_NOT_FOUND` with the paths that were checked, a call with neither `flow` nor `flowYaml` returns `INVALID_ARGUMENT`, and YAML that does not parse returns `INVALID_FLOW`.

`qa_flow_run` run-mode details:

- **Variables**: `${NAME}` resolves from the explicit `variables` argument first, then the session's stored inputs (for example credentials supplied through `qa_agent` needs-input, so a generated flow replays without re-sending the raw password; values are never echoed, only the names are listed in `notes`), then the server environment **only for `SWIPIUM_*` names**. Any other environment variable (for example `DATABASE_URL`) is never read; the step fails with `MISSING_FIXTURE` and a message naming the allowed prefix. Resolved values whose name looks credential-like (`pass`, `secret`, `token`, `otp`, `pin`, `cvv`, `key`, `code`) are registered as session secrets and redacted everywhere.
- **Mutating steps and consent**: `seed`, `networkOffline`/`networkOnline`, `restartApp`, and any `openUrl` whose URL contains a `${VAR}` need the `flow_mutation_run` consent. The consent's `exactCommand` and `affects` show each seed's exact argv or URL, labelled as repo-supplied and unreviewed (fixtures come from `.swipium/fixtures.json`), and each variable `openUrl` destination with credential-like values masked. `qa_smoke` never runs such flows implicitly.
- **Sensitive sessions**: `screenshot`, `assertVisual`, and failure evidence are not captured; the step detail says so (an `assertVisual` checkpoint is recorded as `skipped`). The `qa_smoke` baseline screenshot is skipped the same way.
- **Paths**: `tapImage`/`assertImage` templates and `assertDiff` baselines must resolve (after symlinks) inside the project root; otherwise the step fails with `UNSAFE_ACTION_REFUSED`.
- **clearOverlay on iOS** dismisses alerts and sheets with the native alert API (never BACK). When the backend has no alert API or the overlay survives, the step reports `nothingCleared:false` with a note instead of claiming success.
- **Failures** return `nextSteps` that point at `qa_flow_repair { flow, failedStep }`.

`qa_flow_repair` proposes a replacement of the same role as the failed target (a tap stays on a button, an `inputText` stays on a text field), ranked by text similarity, so a button renamed from "Sign in" to "Log in" is never repaired to the "Email" field. `apply:true` writes the file only at high or medium confidence. At low confidence it returns the proposal with `applied:false` and a note. The flow path must resolve inside the project root, otherwise it is refused with `UNSAFE_ACTION_REFUSED`.

`qa_flow_compile` stays separate from `qa_generate`. `qa_generate` always generates from a session's recorded actions, and `target:"suite"` already compiles what it generates (`compile:true` by default). `qa_flow_compile` recompiles a suite that already exists on disk, with no session, which is the path for committed suites and CI (`swipium suite`).

### Flow steps

`prepareTarget`, `tap`, `tapAt`, `tapImage`, `tapOcrText`, `inputText` (also `{ into, text }` to focus a named field), `assertVisible`, `assertNotVisible`, `assertImage`, `assertOcrText`, `assertVisual`, `assertDiff`, `swipe` (device-relative `{ direction, area, distance }`), `scrollTo`, `press`, `openUrl`, `wait`, `waitForIdle`, `waitForVisible`, `clearOverlay`, `networkOffline`, `networkOnline`, `restartApp`, `seed`, `note`, and `screenshot`. Flows may declare `setup` and `teardown` (teardown always runs) and a mode (`structured`, `visual`, or `auto`). Runs are fail-fast, and mutating steps are never auto-retried. `clearOverlay` presses BACK only when a BACK-dismissible overlay is actually open (a dialog, sheet, permission prompt, or RN LogBox). It never presses BACK on a bare screen, and never for a snackbar or banner.

### CI policy (`.swipium/policy.json`)

`qa_flow_check` with `ci:true`, the flow CI preflight, and the report release gate read an optional `.swipium/policy.json` in the project root:

```json
{
  "ciAllowMutations": ["network", "seed", "restart_app"],
  "blockOn": ["native_crash", "app_error_boundary", "failed_required_flow"],
  "warnOn": ["visual_diff"],
  "ignoreKnown": ["REVENUECAT_BILLING_UNAVAILABLE_ON_EMULATOR"]
}
```

- `ciAllowMutations` lists the mutating step kinds allowed in CI (for example `network`, `seed`, or `clear_data`; `"all"` allows everything). Mutating steps that are not listed are flagged as policy violations. An `openUrl` that interpolates a `${VAR}` counts as mutating (allow it with `openUrl`), and the CI variable preflight treats non-`SWIPIUM_*` environment names as missing, because flows never read them.
- `blockOn`, `warnOn`, and `ignoreKnown` classify failure codes for the release gate: `blockOn` matches block, `warnOn` matches only warn, and `ignoreKnown` suppresses known issues. Tokens match failure codes case-insensitively, and `failed_required_flow` matches any failed flow.
- **Reserved codes**: the failure catalog (`qa_explain_blocker`) also defines some codes that no tool returns yet. They are reserved for classifying evidence, reports, and policy rules (for example `BLANK_SCREEN`, `INFINITE_SPINNER`, `SECRET_ARTIFACT_IN_EVIDENCE`, `REAL_DEVICE_*`) so `blockOn`/`warnOn`/`ignoreKnown` and report consumers can name them stably. A reserved code may start being returned in a minor release without a breaking change.

## Generate

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_generate` | Generates per-run assets from recorded actions. `target:"flow"` gives repeatable Flow V2 YAML. `target:"pom"` gives page objects and a locator audit. `target:"suite"` gives the full `.swipium/` POM suite with compile and replay gates. `target:"testcases"` gives a test-case catalog. `target:"appium"` gives runnable Appium POM code in JS, TS, or Python, and can bootstrap from `projectRoot`. `mode:"plan"` previews without writing. | A manual or exploratory run should become reusable assets. |

For `target:"appium"`, every recorded step must become real code. Swipes and scrolls are emitted as real gestures (bounded scroll-until-visible loops). A step that cannot be expressed fails generation with `UNEMITTABLE_STEP` instead of emitting a silent no-op. Generated identifiers (class, method, and file names) are sanitized, so they are always valid in the target language.

- **Secrets**: every target rewrites, at emit time, any recorded literal that equals or contains a value registered as a session secret (even one typed into a field the UI did not flag as secure) into the same env-var placeholder used for secure fields (`${SECRET_n}` / `SWIPIUM_*`), marked needs-human-data. The appium `validation.secretsClean` check scans every generated file, comments included, against the session's registered secret values (not only name heuristics). If a secret value would still be written, generation fails with `SECRET_IN_GENERATED_OUTPUT` and nothing is written. Registered secret values also never reach `test-suite.json`, `TC-*.yaml`, or the session's `state.json` (recorded actions are persisted in the same rewritten form).
- **Platform**: the generated suite's default `SWIPIUM_PLATFORM` and backend are resolved in this order: the explicit `platform` argument, then the platform of the session's device (driver kind, else Android serial vs iOS UDID), then the project profile, then Android. `ios` always means Appium XCUITest and `android` means UiAutomator2. The plan and profile report `primaryPlatform` and `platformSource`. Python capabilities built with `UiAutomator2Options`/`XCUITestOptions` pass validation.
- **Visual assertions**: a `qa_visual mode:"assert"` step is free-form prose, not on-screen text. It becomes a clearly marked manual checkpoint: a `TODO(manual visual check — not automated)` comment in JS/TS/Python, a `visualCheck` POM step, an evidence-capturing `assertVisual` step in compiled flows, and "MANUAL visual check" in test cases. It is never an `assertTextVisible` call. Only real text assertions become `assertTextVisible`.

## Persistent Test Suite

These tools maintain the canonical suite in `.swipium/test-suite.json`. It persists across runs, unlike the per-run assets `qa_generate` emits.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_suite_read` | Reads the canonical suite, filtered by functionality or status, as summary, json, or markdown. | The agent needs the durable suite without re-deriving it. |
| `qa_suite_update` | Merges cases into the suite, deduplicating by feature, objective, and steps. `mergeMode:"replace_generated"` can overwrite generated fields. | A run produced cases to fold into the suite. |
| `qa_suite_generate` | Generates or refreshes canonical cases from a recorded run and its exploration. `creativity` sets how far beyond the happy path they go (`creativityLevel` is a deprecated alias). | The durable suite needs to be rebuilt from observed behavior. |
| `qa_suite_export` | Exports the suite as markdown, a yaml directory, json, or junit. | The suite must be shared or fed to CI. |
| `qa_suite_lint` | Validates the suite and, when `.swipium/pages` exists, generated page objects. | The suite must be trusted before a release sign-off. |

## Issue Memory and Mobile Audit

The issue ledger lives in `.swipium/issues-log.jsonl` (an append-only event log plus an index). Fingerprints let later runs detect regressions of issues that were already fixed.

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_issue_log` | The issue-ledger lifecycle in one tool: `history` (default), `log`, `mark_fixed`, `verify_fixed`, `suppress`, and `metrics`. | The agent needs the project's known issues, or must record, resolve, verify, or suppress one. |
| `qa_mobile_audit` | Plans or executes a named mobile-QA profile: `smoke`, `account_cycle`, `store_compliance`, `resilience`, or `release_gate`. | A structured, repeatable audit is needed. Execution records issues and evidence. |

`qa_issue_log` details:

- **Identity**: a manually logged issue's identity is its normalized title (ids and numbers scrubbed) plus `failureCode` or category, and platform. The app id is deliberately left out because the ledger is already project-scoped, so the same title logged with a `sessionId` or with a `projectRoot` lands on the same issue. A title with no identifying words left after scrubbing is refused with `ISSUE_LOG_TOO_VAGUE` (pass a descriptive title or a `failureCode`).
- **Issues logged manually before 2.0.0 (1.5.x)** keep their old fingerprint, which was built from platform and `failureCode` only. A new log never merges into them automatically. Close them with `mark_fixed`, or hide them with `suppress`.
- **Recurrence**: re-observing a fixed issue reopens it with a recurrence message that quotes `howFixed` and `fixedInCommit`.
- **mark_fixed** only applies to an active issue. From any other state it returns `ISSUE_STATE_INVALID`. **verify_fixed** needs a fixed issue plus current-run evidence (`reportUri`, `testCaseId`, `auditCheckId`, or `evidenceUris`), else `ISSUE_EVIDENCE_REQUIRED`. An unknown key returns `ISSUE_NOT_FOUND`.
- **Redaction**: with a `sessionId`, registered session secrets are scrubbed from `title`, `summary`, `howFixed`, `suppressionReason`, and `fixedBy` before they are written to the committed ledger.
- **From `qa_note`**: a failing `qa_note` without a `category` is recorded as `app_bug`, which lands in the ledger as an app-owned `app_bug` with medium severity. Pass `category:"mcp_limitation"` explicitly for tool problems.
- **suppress** hides an issue as expected noise. `suppressedUntil` (an ISO timestamp; `until` is an alias) makes it expire automatically, after which the issue returns to its previous state. Without it, the suppression is open-ended. `unsuppress:true` lifts a suppression early. Suppressed issues are hidden from `history` unless `includeSuppressed:true`, and they show as known noise in reports.

`qa_mobile_audit` resilience (also inside `release_gate`) toggles airplane mode only with the `network_change` consent, the same gate as `qa_network`. Without it, `offline_entry` is reported `blocked` and the device network is left untouched. With it, the original airplane state is recorded first and restored afterwards, even if a check fails, so a device that started offline stays offline.

## First Run

| Tool | What it does | Use when |
| --- | --- | --- |
| `qa_first_run` | `mode:"plan"` (default) classifies the current first-run screen and makes a safe plan without acting. `mode:"continue"` executes bounded steps (`until`: `one_step`, `until_gate`, or `until_home`) with safe generated data when allowed, and stops at gates. | The agent reaches login, sign-up, onboarding, permission, OTP, paywall, or home screens. |

## Consent

Privileged actions (emulator boot, install, build, Metro start, OCR, wipes, recordings, network changes, destructive exploration) are consent-gated. Each request has a risk level; for example, `build_from_source` is high and `start_metro` is medium.

- When the client supports MCP elicitation, the user is asked directly and the tool continues on approval. Declining returns `CONSENT_DECLINED`. Dismissing the prompt, a timeout (10 minutes), or an aborted call counts as a refusal and returns `CONSENT_CANCELLED` (retry-safe: re-calling shows a fresh prompt). Nothing runs in any of these cases, and a `refused` row is written to the mutation ledger.
- When the client does not support elicitation, the tool returns a `requiresConsent` envelope. The agent must show it to the user and re-call with `consentId` and `approve:true` only after they agree.
- With `SWIPIUM_REQUIRE_ELICITATION=1`, every consent-gated action is refused with `CONSENT_REFUSED` unless the client can elicit.
- A consent is bound to the session it was issued in: a `consentId` minted by a call with `sessionId` A cannot approve a call in session B.
- A `consentId` that is unknown, already used, or expired is not silently replaced. `qa_test_this` says `consent <id> unknown or expired — new challenge issued` (`consentNote`) and returns the new challenge. Consent results carry `sessionId`, so the approving re-call reuses the same session without `projectRoot`.
- Every Android install is consent-gated, as on iOS. `qa_prepare_target` asks before installing an APK from inside the project (risk low), not only an external one (risk medium, with its sha256). An already-installed app launches without a prompt. Whether an APK is inside the root is decided on resolved real paths, so `<root>/../x.apk` and symlinks that leave the root count as external.
- The elicitation prompt quotes every repository-derived value (flow names, queries, URLs, commands), strips control characters and newlines from it, and caps its length, so repo content cannot fake extra prompt lines.

## Detailed Reference

Most tools take a `sessionId` from `qa_start_session` or `qa_test_this`. The build, artifact, app-map, and read-only feature tools also accept `projectRoot`, so they work before a session exists. Mutating actions accept `consentId` and `approve`, and are recorded in the report's mutation ledger.

### Device and app environment

- **`qa_device_info`**: read-only. *Inputs:* `listPackages?`, `packageFilter?`. *Outputs on Android:* `props` (manufacturer, model, SDK, release, ABIs, locale, timezone), `screen`, `orientation`/`rotation`/`autoRotate`, `installedThirdPartyCount`, and optionally `packages[]`. *On iOS:* `platform:"ios"` with the simulator's name, runtime, and state, plus the screen in points.
- **`qa_orientation`**: `orientation` is `portrait`, `landscape`, or `auto`. Logged as an environment change. Returns `BACKEND_UNSUPPORTED` on non-Android backends.
- **`qa_geolocation`**: runs `adb emu geo fix <lng> <lat>` on the emulator. Consent-gated (medium). iOS and other backends return `BACKEND_UNSUPPORTED`.
- **`qa_network`**: runs `cmd connectivity airplane-mode` (Android 11+). The original state is recorded on the first change and restored at `qa_report`, on `restore`, and on server shutdown.
- **`qa_metro`**: `start` runs `adb reverse tcp:8081 tcp:8081` and spawns Metro detached, logging to an artifact and tracking the PID. `stop` signals the whole process group. `diagnose` adds RedBox detection, logcat evidence, and recovery steps.
- **`qa_app_control`**: `clear_data` and `fresh_start` are destructive and consent-gated (high). On debug RN/Expo builds they also require `acknowledgeBundleRisk:true`, because a wipe can remove the cached JS bundle.
- **`qa_screen_record`**: consent-gated (medium) and refused on sensitive sessions. Android uses `adb screenrecord --time-limit 180`, and iOS uses `simctl io recordVideo`. One recording per session.

### Build and artifact resolution

- **`qa_resolve_artifact`**: *Inputs:* `platform?` (`android`, `ios`, or `any`), `buildType?`, `path?`, `allowOutsideRoot?`, `requireInstallableOn?`. On failure it returns the exact globs searched and a `qa_build` next step.
- **`qa_build`**: in `plan` mode, returns the detected framework, exact commands, expected artifact path, and a cost estimate. In `run` mode (requires `sessionId`), returns a `jobId`; on completion you get a build-log artifact and the re-resolved artifact. Failures are typed: `GRADLE_FAILED`, `XCODEBUILD_FAILED`, `FLUTTER_BUILD_FAILED`, `BUILD_TIMED_OUT`, `DEPENDENCY_INSTALL_REQUIRED`, and others.
- **`qa_bundletool`**: `install` is consent-gated because it installs app code on a device or emulator.

### Agent helpers

- **`qa_inspect`**: *Inputs:* `sessionId`, `ref` (for example `@e3`). *Outputs:* class, id, content description, text, bounds, interaction flags, and raw attributes. Secrets are redacted, and a secure field's value is shown as `«secure»`.
- **`qa_status`**: without `sessionId`, returns `{orientation:true, firstCall, polling, report, goals, rules, capabilityGroups, nextBestAction}`. With `sessionId`, returns state plus `nextBestAction`, chosen by an explicit ladder in which every step changes the state it checks, so following it never loops:
  1. A job is running: poll it.
  2. The last `qa_test_this` job ended and nothing ran after it: the job's own next action. For a completed job this reads the report (or `qa_report` when the job could not write one); for a blocked or unsafe job, `qa_explain_blocker {failureCode, sessionId}`; for `needs_input`, the `qa_continue_from_blocker` resume call. Once that action is done (a newer report, an answer stored by `qa_continue_from_blocker` — then `qa_test_this` re-runs with it — or `qa_explain_blocker` called with the `sessionId`), the ladder moves on instead of repeating it.
  3. No device is bound: `qa_test_this`.
  4. No app is running: `qa_prepare_target` or `qa_prepare_ios_target`.
  5. No smoke has run and no actions are recorded: `qa_smoke`. A smoke run is a persisted milestone (the `launch_smoke` note or the `smoke_completed` milestone), not a count of recorded actions.
  6. Findings exist and no report is newer than them: `qa_report`.
  7. A clean run has recorded actions but no generated assets: `qa_generate`.
  8. No report is newer than the last activity: `qa_report`.
  9. Otherwise: `qa_get_artifact` on the latest report. The run is done.
  After a restart, `mode` and the platform come from the persisted `driverKind` when no driver is live.

## Migrating from 1.5.0

A client still running a pre-upgrade server list, or an agent that remembers old names, gets a typed error instead of a raw "Tool not found" or schema-validation message: calling a removed tool, or `qa_ios` with a `wda_*`/`screenshot` action, or `qa_wait` with `for:"job_done"`, returns `failureCode: "STALE_CLIENT"` with `replacement` (the call to use) and `clientHint` (restart the client to reload Swipium). The current schemas do not list the old values.

| Removed | Use instead |
| --- | --- |
| `qa_agent_brief` | Server `instructions`, or `qa_status` without `sessionId` |
| `qa_capabilities` | `qa_status` without `sessionId` (`capabilityGroups`) |
| `qa_next_best_action {sessionId, goal}` | `qa_status {sessionId, goal}` → `nextBestAction` |
| `qa_detect_context {projectRoot}` | `qa_resolve_target {projectRoot, include:["context"]}` |
| `qa_plan {sessionId}` | `qa_resolve_target {sessionId, include:["plan"]}` |
| `qa_assert_visual {assertion, pass}` | `qa_visual {mode:"assert", assertion, pass}` |
| `qa_ios` `wda_status` / `wda_attach` | `qa_wda` `status` / `attach` (with `device`) |
| `qa_ios` `screenshot` | `qa_screenshot` |
| `qa_wait {for:"job_done", jobId}` | `qa_job_status {jobId, waitMs}` |
| `qa_wda {udid}` | `qa_wda {device}` (`udid` still accepted) |
| `qa_suite_generate {creativityLevel}` | `qa_suite_generate {creativity}` (`creativityLevel` still accepted) |
| `qa_mobile_audit {waitForCompletion}` | Removed (it was never used; execute always runs to completion) |

## Recommended Entry Points

| User intent | First tool |
| --- | --- |
| "Test it" | `qa_test_this` |
| "How do I use Swipium?" | `qa_status` (no args) |
| "Check setup" | `qa_doctor` |
| "Start a manual run" | `qa_start_session` |
| "Launch Android" | `qa_prepare_target` |
| "Launch iOS" | `qa_prepare_ios_target` |
| "Smoke test" | `qa_smoke` |
| "Explore the app" | `qa_explore` |
| "Generate report" | `qa_report` |
| "Read app memory" | `qa_app_map_read` |
| "Test the X feature" | `qa_test_feature` |
| "Find/build an artifact" | `qa_resolve_artifact` / `qa_build` |
| "Create a flow" | `qa_generate` with `target:"flow"` |
| "Generate automation" | `qa_generate` with `target:"appium"` |

## Extension Pattern

When adding a tool, add it to `TOOL_NAMES` (`src/version.ts`), `CAPABILITY_GROUPS` (`src/core/capabilityGroups.ts`), the annotation table (`src/lib/toolAnnotations.ts`), and exactly one table row in this file. The startup assertion and `test/publicSurface.test.ts` enforce all four. Document the tool's:

- Name and group.
- What it does, and when to use it.
- Main inputs and outputs.
- Scope limits.
- Consent or mutation behavior.
