# Changelog

All notable public changes to Swipium are documented here.

## 2.3.0 - 2026-10-12

Swipium 2.3.0 makes the core loop faster, more precise and cheaper in tokens. `qa_test_this` now runs by default, so a typical session is three calls: `qa_test_this {waitForCompletion:true}`, `qa_job_status` if the run is still going, and a read of the new `report.md`. Android actions settle about one UI dump sooner, app launches no longer sleep a fixed 2.5 s, iOS page source is about 14x faster, element refs stay stable across snapshots, and results, errors and reports are about half their 2.2.0 size. It ships an agent skill, two new prompts, a Claude Code plugin skeleton and an MCP Registry entry, and needs Node.js 22.12 or newer. No tools were added or removed (still 55). Work through the upgrade checklist before upgrading.

### Upgrade checklist

Items tagged **You** need an action from you. Items tagged **Automatic** happen on their own and are listed so they don't surprise you.

1. **You:** use Node.js 22.12 or newer (`engines` was `>=20`). Then restart your MCP client so it reloads the server instructions and tool list. The schema hash changed (new parameters on `qa_screenshot`, `qa_wda` and `qa_act`, new defaults, edited descriptions), so update any `qa_doctor { expectedSchemaHash }` check.
2. **You (agents and scripts calling `qa_test_this` or `qa_test_feature`):** `mode` now defaults to `"execute"`. A call without `mode` starts the run (after consent) instead of returning a plan. Pass `mode:"plan"` for the old side-effect-free preview.
3. **You (scripts reading results):** element lines changed. An empty `""` name is left out, and a trailing ` -` marks a non-clickable element instead of the `non-clickable` flag (`@e7 [text] "Total" [40,900][300,940] -`). `responseMode:"verbose"` still returns objects ([format](docs/tools.md#element-lines)).
4. **You (scripts reading `qa_report`):** `structuredContent` is now the lean view (verdicts, executive and PR summary, counts, URIs including the new `reportMdUri`, and the summary text); `manifest` is gone (`manifestUri` stays). Pass `format:"json"`, or use `responseMode:"verbose"`, for the full report payload. `report.json` on disk is unchanged.
5. **You (CI with Android emulators):** emulators Swipium boots now quick-boot from the AVD's snapshot (`-no-snapshot-save` instead of `-no-snapshot`), so device state (screen, apps, settings) comes from that snapshot and changes from earlier runs are discarded; an AVD without a snapshot gets one saved right after its first, cold boot, and they render with `-gpu auto` instead of `swiftshader_indirect`. Set `SWIPIUM_EMULATOR_COLD_BOOT=1` for a guaranteed clean cold boot, and `SWIPIUM_EMULATOR_GPU=swiftshader_indirect` on GPU-less hosts (Linux runners without `/dev/dri`, some Docker images) where `auto` fails to start or renders black screenshots.
6. **You (MCP prompt users):** `swipium_full_smoke` takes `platform` instead of `appId`.
7. **You (iOS):** WebDriverAgent 6.0 or newer is required for coordinate taps: the fallback to the pre-6.0 `/wda/tap/0` route was removed. `ios.wda.settings` in `.swipium/config.json` now actually reaches WebDriverAgent (it was ignored before), so values you set there start to take effect.
8. **Automatic:** a ref read from a snapshot older than 1.5 s, or taken before another action, is re-checked before `qa_act` uses it. A ref that vanished returns `STALE_REF` with up to 3 similar `candidates` instead of tapping a stale position. After a scroll of more than 64 px the moved rows have new refs; an old ref is tapped only when exactly one element with its identity is on screen.
9. **Automatic:** a blocked or unsafe `qa_test_this` run recommends the blocker's concrete fix in `nextRecommendedAction` (or `null` when the fix is outside Swipium) instead of `qa_explain_blocker`, and a completed run points at `report.md`. `qa_status` relays that fix once as its `nextBestAction`, then moves on.
10. **Automatic:** error text now starts with the failure code (`❌ CODE: what`) and is complete in every response mode, including `compact`.
11. **You (CI using `swipium report --fail-on-gate`):** a run that tested nothing is never SHIP. A report with no evidence, or from a `qa_test_this` run that ended `blocked` or `unsafe`, has release risk `block`, app verdict `NOT_RUN` and coverage `NONE`, and the gate adds a failed `swipium: not tested` workflow (code `NOT_TESTED`, or the blocker's code), so the job fails where it used to pass. A run that reached the app but exercised no workflow (for example a launch that ended `blocked` on `BLANK_SCREEN`, or a launch and a screenshot plus blocked notes) is `caution` with coverage `NOT_COVERED`, and fails the gate too, with the blocked note's code. Only a launch of the app under test that reached the foreground, or a `qa_screenshot` taken while the app under test was in front, counts as reaching the app (a home-screen screenshot, a launch of another bundle or a failed launch doesn't). Reaching is not exercising: that takes a Swipium outcome (smoke, flows, explore, audit), an exploration, an action taken while the app under test was in front (not on SpringBoard or another app, not a press home or a `qa_visual` tap), or a finding. An agent's `qa_note {outcome:"pass"}` counts only on top of that: a pass note on a launch or screenshot alone is an unverified claim (risk `caution`, app `UNVERIFIED`, gate fails with `NOT_TESTED`), and JUnit shows it as a skipped "unverified manual claim", not a passing testcase. The not-tested verdict is saved on the session, so a later `qa_report` keeps it and its code (`METRO_REQUIRED` stays `METRO_REQUIRED`) until the app is retested: a Swipium outcome or exploration, or an agent outcome note together with an app-in-front action after it. A run that tested nothing after a refused consent gates with the refusal's code (`CONSENT_CANCELLED`, `CONSENT_DECLINED` or `CONSENT_REFUSED`) instead of `NOT_TESTED`. To only warn, add the code to `warnOn` ([Release-gate policy](docs/ci-reports.md#release-gate-policy)).
12. **You (CI):** an invalid `.swipium/policy.json` (not JSON, not an object, or a list field that isn't an array of strings) now makes `swipium report` exit 2 with `INVALID_ARGUMENT`, instead of crashing with exit 1 or silently blocking everything. On persistent runners, add `--max-age <minutes>` so a stale report from an earlier job is refused (exit 2).
13. **You (CI parsers):** JUnit always has two suites (the findings suite is empty when there are none), the GitHub summary's gate line says `❌ BLOCK` instead of `❌ FAIL` and lists evidence as `swipium://` code spans instead of links, and SARIF reports a Swipium limitation (`mcp_limitation`) as `note` instead of `error`. A `WDA_UNREACHABLE` finding is a tool or environment item: JUnit `<skipped>` named `tool/wda_unreachable` instead of a `<failure>`, SARIF `note` with `properties.layer:"tool"`, and in the GitHub summary a separate `· N tool/environment` count instead of `1 high`; it still fails the gate. An unverified `qa_note` pass claim is a JUnit and Playwright `skipped` case and reads `pass (unverified)=1` in the summary tally. The JUnit `swipium.releaseGate` property is still `pass` or `fail`.
14. **You (scripts reading results):** a budget stop is now `{ok:false, stopped:true, performed:false, failureCode:"BUDGET_EXHAUSTED"}` instead of `ok:true`, so a skipped tap, type or screenshot no longer looks done.
15. **You (agents relaying consent):** a re-call with `approve:false` now returns `CONSENT_DECLINED` (ledgered as refused) instead of a fresh challenge, and a re-call without `approve` leaves the challenge pending instead of using it up. Every tool, not only `qa_test_this`, explains a replaced id in `consentNote` with `previousConsentId`.
16. **You (shared runners, or several emulators and simulators):** set `SWIPIUM_DEVICE` (an adb serial, AVD name, or simulator UDID or exact name; case-insensitive in every tool, never a substring) in the server env to pin the server to one device. Pre-approval is otherwise not tied to a device. With the pin, plans, auto-binding and `qa_ios boot` use only that device, and a request for another one, including `qa_ios` `install`, `privacy_reset` and `erase`, `qa_wda` `build`, `start`, `setup` and `attach`, and `qa_bundletool` install, is refused with the new `DEVICE_PINNED` before any consent prompt, so a pre-approved `erase_device` can't reach another simulator. A pinned simulator name that several simulators share is refused with `MULTIPLE_DEVICES`: pin by UDID. `qa_wda {device}` takes a simulator name too (resolved to its UDID; an unknown or ambiguous name is `INVALID_ARGUMENT`), and `qa_ios` actions other than `boot` and `erase` refuse a `device` that isn't the session's simulator instead of ignoring it.
17. **You (flows):** a flow given by path must be a `.yaml`, `.yml` or `.json` file under the project root; anything else is refused with `UNSAFE_ACTION_REFUSED`. `qa_flow_check` now fails (`INVALID_FLOW`, `valid:false`, `lintErrors`) on lint errors it used to list under `warnings`, including `ci:true` on a mutating step without a `ciAllowMutations` policy (`restartApp` is always allowed in CI, see item 28). Negative or non-numeric waits are schema errors.
18. **You (scripts calling the CLI):** `swipium scan` exits 1 on `BLOCKED` and 2 on a bad path or option (it exited 0). `swipium init` exits 2 on an unknown or incomplete option or a missing `--cwd`, and 1 when an apply fails or Claude Code already has a different registration. `swipium verify` exits 1 on Node.js older than 22.12. Flags before a subcommand (`swipium -y init claude`) exit 2 instead of starting a server. `swipium suite compile` keeps a flow you edited by hand (new output in `<slug>.yaml.new`; `--force` overwrites), `suite lint --strict` fails on warnings, and an option a `suite` subcommand doesn't take (a typo such as `--stirct`) exits 2. `swipium init flows` exits 2 on registration flags such as `--scope`.
19. **You (project roots):** `projectRoot`, `SWIPIUM_PROJECT_ROOT` or `CLAUDE_PROJECT_DIR` set to `/` or your home directory is refused with `PROJECT_ROOT_UNRESOLVED` (the variables are skipped) instead of searching the whole disk. An explicit `projectRoot` that is a shared system or user folder (`/tmp`, `/Users`, `/Applications`, `/Library`, `~/Library`, `~/Downloads`, `~/Desktop`, and similar; [list](docs/concepts.md#project-root)) is refused the same way, at once instead of after a long scan; pass the app's own directory.
20. **Automatic:** a run uses a device you asked for, or none. `qa_test_this` honours the session's bound device, a requested simulator or AVD is booted or bound and never replaced by another one (`NO_DEVICE` when it can't be found), `qa_report` and `qa_first_run` never bind a device, and no device is auto-bound while an iOS Simulator is booted. Consent prompts name the device (`adb -s <serial> install …`, `xcrun simctl install <udid> …`).
21. **You (iOS, firewalls and scripts that expect port 8100):** a managed WebDriverAgent no longer defaults to `127.0.0.1:8100`. Without an explicit URL, `qa_wda setup` and `start` run each simulator's WDA on its own port (a stable port in 8101 to 8900 derived from the UDID, else the next free one), and use 8100 only when the WDA already there runs in that simulator; a custom port in `ios.wda.url` is kept. Its control port listens on loopback only (`127.0.0.1`), but its MJPEG screen stream, now on WDA port + 1000 (9101 to 9900), listens on every network interface, because WDA can't restrict it: use a firewall on untrusted networks. A WDA that belongs to another simulator is never reused or attached (`STALE_WDA_DEVICE`), a start that loses its port to another simulator's WDA fails with `WDA_PORT_CONFLICT` (retry), and later `qa_wda` and `qa_wait` calls default to the session's WDA and simulator. `qa_test_this`, `qa_prepare_ios_target`, `qa_wait {for:"wda_ready"}` and `qa_doctor` find a simulator's WDA on its own port. A WDA whose owner can't be checked (`lsof` failed) is treated like another simulator's (`unverified`). A fixed custom port in `ios.wda.url` serves one simulator at a time. A non-loopback WDA approval is single-use: every `attach`, `setup`, `build` or `start` on it asks again. `respectSystemAlerts:true` is a new default WDA setting, so system permission alerts appear in snapshots.
22. **Automatic:** `swipium scan` merges its results into `.swipium/config.json` and keeps your keys instead of rewriting the file. It also stores `scanAppId` (the id it detected), so an `appId` you edit by hand is kept even with a scan `appIdSource` left in place; a config from an older scan prints a `replaced appId …` line instead of replacing it silently. The newest `SWIPIUM_RETENTION_KEEP` sessions are kept only for projects whose root still exists, and the startup prune runs for at most 2 s per start, so old sessions of deleted temp roots finally age out. `~/.swipium` is `0700` and its `registry.json`, `projects.json` and `processes.json` are `0600`.
23. **Automatic:** the default session budget is 30 minutes, 60 actions and 40 screenshots (it was 8 minutes, 20 actions and 8 screenshots), so `qa_test_this` with exploration and saved-flow replays fits in one session. Existing sessions keep the budget they were created with, and `profile` still sets the minutes. A budget stop during a saved-flow replay is a `skipped` workflow with `BUDGET_EXHAUSTED`, not automation drift, and a budget-stopped `qa_explore` ends `blocked` with `BUDGET_EXHAUSTED`, never `completed`. An exploration cut by its time budget (`maxDurationMs`) ends `blocked` too (`time budget reached (…)`; the report is then at most `caution`), and its back, relaunch and alert-close steps count against `maxActions` and the session's action budget, so explore uses the budget a bit faster.
24. **You (scripts and agents calling `qa_act type`):** a typed value is now verified. When the typed field doesn't read back the typed text (reordered, cut off by leftover text, or not cleared), the call returns `ok:false` with the new `TEXT_INPUT_MISMATCH` instead of `ok:true` with a warning, and replace mode needs an exact match (case and whitespace ignored). That holds for a field targeted by ref and, in replace mode, for any target kind, coordinates included (the focused field under the tap). The field's value is compared, not a Compose label after it. Before failing, a replace-mode miss on a field that still has focus is cleared and retyped once (on Android in careful mode: 8-character bursts 250 ms apart, read back every 5), and a result that needed it has `retyped:true`. The error is retry-safe only in replace mode: after a failed append, retry the whole value with `mode:"replace"` instead of repeating the append. A reformatted value (an input mask) is still a warning, and so is a value cut short when a retype cuts it at the same length again (a max length) or when focus moved on (an OTP box); a cut that changes on the retype is a mismatch. On iOS, typing by a native `selector` is read back from WDA's element value too. Flow `inputText` steps with `into` read the field back, retry once, and fail the same way.
25. **You (apps whose first screen has no accessibility nodes, and React Native debug builds):** an app that shows no UI tree for about 15 s after launch (up to 30 s while Metro is serving a cold bundle), or is still on its own splash or loading screen when the wait ends, is now `blocked` with `BLANK_SCREEN` ("launch not verified") in `qa_smoke`, `qa_test_this` and `qa_mobile_audit` (as the check's `failureCode`), instead of passing, and `qa_test_this` stops there. A Metro banner still up at the end is the same `blocked` `BLANK_SCREEN`, not a `fail`. That includes pure canvas or game screens and opaque WebViews: check those with `qa_visual`.
26. **Automatic:** on shutdown, a server restores airplane mode only for changes it made itself (each change records its owner). Another server's session, even one this server read with `qa_snapshot`, is never restored by whichever server exits next. A change left by a server that crashed is not restored automatically: `qa_status` and `qa_network status` warn about it (`warnings`, `orphanedBySessions`), and `qa_network restore` on any session bound to that device, or `qa_report` on the original session, restores it.
27. **You (suite and report consumers):** exploration no longer marks features `pass`. A feature exploration reached is a `not_run` case until real steps run, a feature only seen as a label on some screen has the new coverage status `observed` (not covered), and `qa_suite_lint` flags a `pass` with only placeholder steps and no evidence as `unproven_pass`. A visual-only smoke now gives the app verdict `UNVERIFIED` (risk at most `caution`), and a run that never reached the app reports health `not checked` instead of `OK`.
28. **Automatic (CI):** `restartApp` is allowed in CI without a `ciAllowMutations` entry, so generated flows that start with it pass `qa_flow_check {ci:true}`. It still needs the `flow_mutation_run` consent in `qa_flow_run`. Unknown keys in `.swipium/policy.json` are ignored with a warning (stderr in the CLI, a line in the `qa_report` summary) instead of silently.
29. **You (scripts reading `qa_clear_overlay`):** `auto` with nothing detected does nothing (outcome `nothing_to_clear`, no blind tap outside), and `auto` on a permission or native dialog only reports it with the new outcome `needs_decision` (call `allow_permission` or `deny_permission`); it used to say `cleared`.
30. **You (suite consumers):** screens with the same title now share one page object (`AlarmsPage`, not `AlarmsPage` plus `Alarms2Page`), `qa_generate {target:"testcases"}` marks a case `automation.status: candidate` (no `test`) until its test file exists, and a caller-supplied case `id` in `qa_suite_update` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (`INVALID_ARGUMENT` otherwise; omit it to get an allocated id). A given id that isn't used (the case merged into an existing one, or the id is taken) is listed in `idsIgnored`. A stored id in `test-suite.json` that is unsafe as a file name, or a duplicate, is renamed when the suite is read (`loadRepairs` in `qa_suite_read`, `update` and `export`, an `unsafe_id` error in `qa_suite_lint`), so `duplicate_id` no longer fires for a suite read from disk.
31. **You (scripts reading results):** `qa_smoke` counts a flow it skipped for lack of consent as `skipped:true` in `flowsSkipped`, not in `flowsTotal`; `qa_device_info` logs apply `lines` after the `package` and `grep` filters (`truncated` and `matchedTotal` when more matched); a blocked `qa_test_feature` job is `status:"done"` with `result.state:"blocked"` instead of `failed`; and `qa_mobile_audit {mode:"execute"}` records a `mobile_audit: <profile>` outcome that `qa_report` counts (blocked checks make it `caution`, a blocking audit `block`).
32. **You (scripts matching failure codes):** the new `DEVICE_UNRESPONSIVE` (environment) is returned when an Android device doesn't answer adb in time: an `input text` or launch that timed out (flows used to report it as `WDA_UNREACHABLE`, `qa_prepare_target` as a raw error) and a UI dump that gets no answer within about 20 s (it used to retry for about 100 s, then `SNAPSHOT_FAILED`). `qa_ios launch` of a bundle other than the session's app no longer changes the app under test: the result adds `appUnderTest`, and start a new session to test the other app.

### Faster

- **Android actions settle one dump sooner.** On the direct Android driver, the first UI dump after an action is accepted when it differs from the pre-action screen and shows no loading marker (progress bars, activity indicators, Lottie views, `indeterminate="true"`, "loading" text, a near-empty tree). Otherwise (and always for a flow `waitForIdle` step, which follows no action) the two-dump confirmation still runs. Tap to settled on an API 36 emulator: 4.2 to 4.5 s down to 2.2 to 2.3 s. `qa_act` results show `settleFast:true` when it applied.
- **Settle ignores ticking UI.** It compares a normalized fingerprint of the screen instead of raw XML: clocks (`12:34`, `1:02:03`), percentages and SeekBar, ProgressBar and RatingBar values are masked and bounds are bucketed, so a running clock no longer keeps a screen unsettled.
- **Fewer repeat dumps.** Flows, text and id target lookups and exploration reuse the snapshot that settle just took (when it is under 2 s old and no action ran since) instead of dumping again. Exploration takes its screenshot alongside the UI dump.
- **Android launch without a fixed sleep.** `qa_prepare_target` and `qa_app_control` (`launch`, `foreground`, `restart`, `fresh_start`) start the resolved launcher activity with `am start -W` (falling back to `monkey`) and return as soon as the app is in the foreground, up to the old 2.5 s cap. `qa_prepare_target` checks the foreground once more 1 s later, so an app that crashes right after its first frame still reports `launchedOk:false`. Settings on an API 36 emulator: `qa_app_control` about 2.8 s down to 0.3 to 0.5 s, `qa_prepare_target`'s launch step about 2.8 s down to 1.3 to 1.5 s. Flow `inputText into` types as soon as the keyboard is up (600 ms cap) instead of after a fixed 600 ms (when the keyboard was already up from another field it still waits 250 ms, as `qa_act` does), and `qa_network` returns as soon as airplane mode reports the new state.
- **Faster emulator boot.** Quick boot from the AVD snapshot (see the upgrade checklist; headless API 36 AVD on an Apple Silicon Mac: about 3.5 s to the launcher instead of 21 to 25 s cold), and boot readiness is checked every 0.5 s instead of every 2 s.
- **iOS page source about 14x faster.** Swipium asks WebDriverAgent to skip the `visible` and `accessible` attributes (`/source?excluded_attributes=visible,accessible`). Settings app on an iOS 26.5 simulator: 1.4 to 1.6 s down to about 0.1 s per snapshot. Elements whose center is off screen, under a navigation bar, tab bar, toolbar, the status bar or the keyboard, or behind an alert or sheet are still treated as not tappable. Set `ios.wda.settings.pageSourceExcludedAttributes` to `""` for the full source.
- **WebDriverAgent settings are applied.** Swipium sends `ios.wda.settings` to WebDriverAgent's settings endpoint after each session it creates, with new defaults: a 1.5 s idle wait (`waitForIdleTimeout`), a 0.5 s animation cool-off (`animationCoolOffTimeout`) and a 20 s `accessibilityDeadline` (WebDriverAgent 16.8 and later). Your own values win.
- **Opt-in persistent Android dumper** (`SWIPIUM_ANDROID_DUMPER=agent`, default off). A 6 KB dex jar pushed to `/data/local/tmp` runs through `app_process` (no APK install), keeps one accessibility connection open and serves dumps over an `adb forward` socket (only to the shell user and root, so apps on the device cannot use it). On an API 36 emulator on a quiet host: 2.0 s down to 0.28 s per dump on a static screen and about 2.9 s down to 0.6 s right after a navigation, with byte-identical XML; on a busy host with other emulators running, snapshots were about 2x to 3x faster. Any failure falls back to `uiautomator dump` for 60 s. The agent exits 120 s after its last dump or when Swipium exits. Swipium removes the jar and its `adb forward` when it stops the agent and when the server shuts down, and logs a warning when it falls back. See Known issues.
- Smaller per-call costs: the Android foreground check filters `dumpsys` on the device (about 250 bytes over adb instead of 30 KB), screenshot coordinate metadata reads size, density and orientation in parallel with one adb call for orientation and a cached density, and the iOS Simulator no longer takes a second screenshot to size the screen.
- Faster repeat starts through the Node.js compile cache.

### More precise

- **Stable refs.** An element keeps its `@eN` across snapshots while it stays on screen and moves at most 64 px (matched by class, resource id, text or label, parent and position among equal siblings; a row labeled by a child view must still show the same label). New and moved elements get new numbers, and numbers only grow until the session's refs are reset (a rebind or `clear_data`).
- **Ref re-check before acting.** When `qa_act` gets a ref from a snapshot older than 1.5 s, or one taken before another action, it takes one fresh dump and finds the same element again. On Android the dump is skipped when no action ran since and one raw screenshot shows the screen unchanged (status bar ignored, up to 60 s). A moved element is tapped at its new center (`refMoved:true`); a vanished one returns `STALE_REF` with up to 3 look-alike `candidates`. A ref that a later snapshot replaced (after another action or a scroll) is looked up among the last 200 replaced refs of the current app and tapped when exactly one element with the same identity and label is on screen, else `STALE_REF` with `candidates`.
- **Auto-wait in flows.** Flow `tap` and `inputText into` wait up to 5 s for their target, and `assertVisible` polls up to 5 s, instead of failing on the first dump.
- **`qa_act` `wait` accepts `for.gone:true`** to wait until a ref, text, id or selector is no longer on screen (a timeout is `ASSERTION_FAILED`).
- **Screenshot fallback for change detection.** A tap on an unlabeled (no text, label or id on the target or inside it), WebView, SurfaceView, canvas or Flutter-like target, or in a visual-fallback session, compares screenshots when the UI tree shows no change. More than 0.5% changed pixels counts as changed (`pixelChanged:true`), so a real visual change is no longer reported as no change and is not retried as a long press.
- **Change checks use the right baseline.** When `qa_act` re-dumps the screen to resolve its target, it compares the result against that dump, so a screen that changed by itself before the tap is not reported as the tap's effect.
- **Password-screen guard re-checks.** `qa_screenshot` and `qa_visual` decide "a password or OTP field is on screen" from the stored snapshot only while no action or screen change happened since it (a `qa_app_control` restart, `qa_clear_overlay`, a visual tap); otherwise a structured backend dumps the screen first.
- `qa_snapshot` and `qa_act` add a `treeHint` suggesting `qa_screenshot` or `qa_visual` when the UI tree looks weak (under 3 elements, a dominant WebView, or more than half of the clickable elements with no text, label or id on themselves or inside them).

### Smaller responses

- **`qa_report`** returns the lean view described in the upgrade checklist: about 4.8 KB of `structuredContent` and 4.7 KB of text in a small test session, down from 11 KB and 14 KB.
- **`report.md`.** Every report also saves an agent-readable summary (`report-<timestamp>-summary.md`, `reportMdUri`). A completed `qa_test_this` run inlines a report head of at most 4 KB (release risk, the three verdicts, top findings and failed or blocked workflows with evidence URIs) in `reportHead` and its text, and `nextRecommendedAction` reads `report.md`.
- **Errors** start with the failure code, keep the next steps as bullets, and carry a JSON block only with the fields the head does not show (no repeated `acceptedParameters`). They are about half the size, complete in `compact` mode too, and capped at 10,000 characters. `structuredContent` is unchanged.
- **Consent and question prompts** show the command once and their JSON block carries only what the prompt text does not.
- **`qa_doctor`** lists only booted simulators (plus `simulatorCount`), drops the duplicated `checksByPlatform` (each check has a `platform` field), shows the stale-client paragraph only on a schema-hash mismatch, and suggests updating `adb` or the emulator below version 36.
- **`qa_status`** orientation lists capability groups by name and purpose only.
- **`qa_snapshot diff:true`** on the same screen returns only `diff: {added, removed, changed, counts, bigChange:false}` plus the header fields, with no `elements`. After a navigation (more than half the elements new) it returns the full list with `diff.bigChange:true`.
- **Shorter element lines** (see the upgrade checklist), and `qa_inspect` returns in `attrs` only the attributes that are not already top-level fields (all of them in `verbose`).
- `state.json` and `~/.swipium/registry.json` are written without indentation, and `state.json` keeps the newest 500 artifacts, findings and notes plus total counts.

### Agent workflow

- **`qa_test_this` and `qa_test_feature` default to `mode:"execute"`.** The server instructions, `qa_status` and the prompts now lead with `qa_test_this {waitForCompletion:true}`, poll `qa_job_status` only while the state is `running`, then read `report.md`. The "read the app map, then `qa_test_feature`" detour was removed from the instructions.
- **`SWIPIUM_MAX_WAIT_MS`** sets how long one `qa_job_status` long-poll or `qa_test_this {waitForCompletion:true}` may block: 1000 to 230000 ms, default 50000. The default `waitForCompletion` window is that cap minus 5 s. `swipium init claude` writes `110000`. `qa_wait` follows the same cap; `qa_act` keeps its 50000 ms cap.
- **Progress notifications.** `qa_job_status` and `qa_test_this {waitForCompletion:true}` send MCP `notifications/progress` while a job runs, when the request carries a `progressToken` (at most one per second, only when the progress line changes).
- **`qa_continue_from_blocker` resumes the run itself** on a prepared session when the re-run needs no new consent, and returns `resumed:true` with the new `jobId`. A re-run that needs consent still returns the `qa_test_this` call as `nextAction`. Credential answers include a tip to set `SWIPIUM_TEST_EMAIL` and `SWIPIUM_TEST_PASSWORD` in the server env, and the login question recommends the same, so the password never enters the chat.
- **`qa_wda {action:"setup"}`**: one consent and one background job (`wda_setup`) that reuses a running WebDriverAgent, or builds it if needed, and starts it (iPhone SE simulator: about 50 s with a build, 5 s from an existing build, 0.1 s when one is running). A build and start runs without a prompt only when `SWIPIUM_CONSENT_PREAPPROVE` lists both `wda_build` and `wda_start`. `qa_wda build` reuses an existing build (a matching `.xctestrun` under the derived data folder) with no consent and no xcodebuild (`reused:true`); `rebuild:true` forces build-for-testing.
- **Adopted WebDriverAgent.** `qa_wda stop` (and the duplicate-start guard) in a new session finds the managed WebDriverAgent of the session's simulator after the session that started it expired, including one another Swipium server started or adopted, matched by the simulator UDID it was started for (never by URL alone, so another simulator's WDA is safe). A server that adopted one now records its own start time, so a second Swipium server started later no longer treats it as orphaned and takes it over (or stops it while in use).
- **`qa_screenshot inline:true`** also returns the image. Inline images from `qa_screenshot` and `qa_get_artifact` are downscaled on macOS to a JPEG with a 1568 px long edge, state the scale factor in the text so taps map back, carry `_meta["codex/imageDetail"]="auto"`, and come without `structuredContent` so Codex shows them.
- **swipium-qa agent skill.** `skills/swipium-qa/SKILL.md` ships in the npm package. `swipium init claude --apply` installs it to `~/.claude/skills` (user scope, or `$CLAUDE_CONFIG_DIR/skills`) or `.claude/skills` (local and project scope), and `swipium init codex --apply` to `.agents/skills`; `--no-skill` skips it. It teaches the loop, batching known steps with `qa_flow_run {flowYaml}`, credentials via env, the app-control shortcuts and the CI CLI. The server also serves it as the MCP resource `skill://swipium-qa/SKILL.md`.
- **Prompts.** `swipium_full_smoke`, `swipium_bug_repro` and `swipium_setup_check` (plan mode) now go through `qa_test_this`. New `swipium_test_feature {feature, projectRoot?}` and `swipium_generate_suite {projectRoot?}`. There are 7 prompts.
- **Guidance.** The instructions, skill, prompts and `qa_act` description suggest one `qa_flow_run {flowYaml}` call for 3 or more known steps, and `qa_app_control` and `qa_act open_url` instead of raw adb for setup.
- **`swipium init claude --trust-local`** (local or user scope only; refused with `--scope project` and for other clients) writes `SWIPIUM_CONSENT_PREAPPROVE` with every consent action that runs no project or model-chosen code, except destructive UI taps (`destructive_ui_candidate`, which act on the app's backend). Builds, Metro, WebDriverAgent, seed scripts, OCR commands and destructive UI taps still prompt.
- **Claude Code plugin** in `plugin/` (the server with `SWIPIUM_MAX_WAIT_MS=110000`, plus the skill; it never pre-approves consent), listed in a plugin marketplace at the repository root: `/plugin marketplace add GeroPalombo/swipium`, then `/plugin install swipium@swipium`.
- **MCP Registry.** `server.json` and `mcpName` (`io.github.GeroPalombo/swipium`) in `package.json`; tagged releases publish to the registry.
- **`SWIPIUM_TOOLS=core`** lists only the core tools (the set `swipium init codex` suggests for `enabled_tools`). Calling a hidden tool returns `INVALID_ARGUMENT` that names it and `SWIPIUM_TOOLS=all`.
- `qa_test_this`, `qa_status`, `qa_act` and `qa_snapshot` carry `_meta["anthropic/alwaysLoad"]` for clients with tool search, and `qa_act`, `qa_snapshot`, `qa_job_status` and `qa_test_this` declare a permissive `outputSchema`.
- Tool descriptions lead with what each tool does and when to use it, so tool search finds the right one, and every description is at most 400 characters (`qa_wda` and `qa_continue_from_blocker` were longer).
- Client name detection works on MCP 2026-07-28 connections (from the request `_meta` when there was no `initialize`).

### Architecture and cleanup

- Swipium no longer goes through the SDK's `registerTool` and keeps its own tool table behind the public request handlers. The tools capability no longer advertises `listChanged`, and tools no longer carry `execution: {taskSupport:"forbidden"}` (the spec default).
- Tool calls with more than 10,000 argument elements are rejected with `INVALID_ARGUMENT` before validation.
- MCP roots are asked once per connection and refreshed on `notifications/roots/list_changed`.
- One shared stable hash for argument digests, flow and suite hashes and profile consent.
- Removed dead code: the parked pre-1.5 tool modules in `src/tools/deferred/` (never public), unused automation helpers, the WebView helper, the unused flow pack runner (`swipium init flows` still writes a starter `.swipium/packs/smoke.yaml`, but no tool runs packs), and the pre-6.0 WebDriverAgent tap fallback.
- The consent actions `permission_grant`, `permission_revoke` and `seed_state` were removed (no tool asked for them). Old names in `SWIPIUM_CONSENT_PREAPPROVE` are ignored with a startup warning.
- `swipium init codex` also forwards `SWIPIUM_MAX_WAIT_MS`, `SWIPIUM_TOOLS`, `SWIPIUM_ANDROID_DUMPER`, `SWIPIUM_EMULATOR_GPU` and `SWIPIUM_EMULATOR_COLD_BOOT` in `env_vars`.
- `engines` is `>=22.12`; CI runs Node 22, 24 and 26 and releases on Node 24. `qa_doctor`'s Node check requires 22.12 (it compares the minor version too).
- Dependencies: TypeScript 6.0, vitest 4.1.11, ESLint 10.12, typescript-eslint 8.71.1, Prettier 3.9.10, fast-xml-parser 5.11.2, yaml 2.9.1, zod 4.6.5. `npm audit` reports 0 vulnerabilities.
- The release workflow pins `mcp-publisher` v1.8.1 and checks its SHA-256 before publishing to the MCP Registry. The registry step waits for npm to serve the new version, retries transient failures, and runs on a re-run when the registry does not list the version yet.

### Fixed before release

Pre-release testing on Android emulators and iOS Simulators found the following. All of it is fixed in 2.3.0 unless Known issues says otherwise.

**Device selection**

- `qa_report` (and the report a failed run writes) adopted the lone online emulator, even for an iOS project, and dumped its UI. Reports and `qa_first_run` never bind a device now, and auto-binding skips the lone Android emulator while an iOS Simulator is booted (`MULTIPLE_DEVICES`).
- `qa_test_this` ignored the session's bound device and took the first online emulator; a requested but shut-down simulator was swapped for any booted one. The plan now takes the explicit `device`, then the session's device, then `SWIPIUM_DEVICE`, and boots a requested simulator or fails with `NO_DEVICE`. `targetChoice.reason` names the devices that were not chosen.
- `qa_prepare_target {avd}` bound whatever single device was online. An explicit `avd` now binds the emulator already running it or boots it; an unknown AVD is `NO_DEVICE` with the AVDs that exist. An offline session emulator is re-booted as its own AVD, never `avds[0]`.
- The Expo Android build ran with no device and could install on any emulator: it now runs `npx expo run:android --device <AVD>`, and the consented command matches what runs.
- `qa_metro` on an iOS session bound an unrelated Android emulator and ran `adb reverse` and logcat there. It now handles iOS sessions itself: no `adb reverse`, the simulator log instead of logcat, and RedBox detection through WDA. `qa_wait {for:"metro_ready"}` works on iOS.
- `qa_prepare_target` with an explicit `appId` and no APK asked to install the project's unrelated APK; it now fails before consent with `NO_ARTIFACT` and a "did you mean" package, also finds APKs in Gradle outputs, and no longer lists an install for a preinstalled app.
- `qa_prepare_ios_target` and `qa_ios install` asked for consent before checking the artifact; a `.ipa`, a device build or a missing path is now refused before the prompt. Device builds are detected from Xcode's binary `Info.plist` too.
- `qa_prepare_ios_target` warns when another session in the same server already drives the simulator.
- Planning read the installed apps of a lone online emulator while the session was bound to another device; it only reads the session's device now. An emulator bound by serial is remembered with its AVD, like one bound by `avd`.
- `qa_wait {for:"device_online"}` was satisfied by any adb device; on a session bound to an Android device it now waits for that device (or its AVD booted again) and times out with `DEVICE_NOT_READY`. `qa_status` didn't notice a device that went away and kept recommending `qa_smoke`; it now reports `deviceOnline:false` and recommends preparing the device again.
- The Android pipeline built the Expo app before booting the target AVD, so the build booted one itself, sometimes with a window. It now boots the AVD first (headless, same consent), then builds. Consent prompts show the real emulator command line (`emulator -avd <AVD> -no-audio -no-snapshot-save -no-boot-anim -gpu auto -no-window`).
- `qa_metro status` bound the lone emulator even while iOS Simulators were booted; `status` never binds now, and `start`, `stop` and `diagnose` use the same device guard as other tools.
- A bad `SWIPIUM_DEVICE` gave a generic "no emulator online" message; the plan names the pin and says to fix or unset it. `qa_prepare_target` checks the pin before the APK lookup, and `qa_prepare_ios_target` before the consent prompt (a pin that matches no simulator is `NO_DEVICE` naming `SWIPIUM_DEVICE`). A `platform` the pin overrode in `qa_test_this` was silently ignored; it is noted in `targetPlan.reason`.
- The pin matched a simulator name case-sensitively in some places and as a substring in others, and didn't cover `qa_ios boot`, `install`, `privacy_reset` or `erase` or `qa_wda`, so a pre-approved `erase_device` could wipe another simulator. The pin now matches serial, AVD, UDID or exact name ignoring case everywhere, and covers those actions (upgrade checklist item 16). After that, a wrong-case pin still worked in `qa_prepare_ios_target` but was `NO_DEVICE` in `qa_test_this`, and a simulator name two simulators share silently took the first; both tools now resolve the pin the same way and refuse an ambiguous name with `MULTIPLE_DEVICES`. `qa_wda {device:"<name>"}` skipped the pin check and passed the name to `xcodebuild -destination id=`, `qa_ios` `launch`, `install` and `privacy_reset` ignored `device`, and `qa_bundletool {install:true, device}` ignored the pin; all three resolve and check the device now. `qa_wait {for:"device_online"}` on an iOS session or an unbound pinned session was satisfied by any device; it waits for the session's simulator or the pinned device.
- A server that only read another server's live session (for example with `qa_snapshot`) restored that session's airplane mode when it exited (upgrade checklist item 26). Reading a session in a second server also took over its registry ownership; it no longer does while the owner is alive.
- `qa_job_cancel` and shutdown left Gradle and other build grandchildren running; builds run in their own process group, and the whole group is stopped.
- A session dropped out of `registry.json` after 200 newer sessions (`Unknown sessionId`). The registry now evicts the least recently used sessions, never one a running server owns, and an evicted session is reloaded from its `runs/` directory while retention keeps it.
- The remaining "No device attached" errors had code `UNKNOWN`; they are `NO_DEVICE`.

**Verdicts**

- A session that tested nothing, or a `qa_test_this` run that stopped on a build, Metro or launch blocker, reported SHIP with app PASS, and `--fail-on-gate` passed with "all required flows passed". See upgrade checklist item 11; the empty-gate reason now reads `no failures recorded (0 workflows run)`.
- `qa_test_feature` with 0 executed cases reported COVERED and SHIP; it is now `NOT_COVERED` and `caution`, and points at `report.md`. It also used up the 40-screenshot budget after about 5 actions, because exploration saved a screenshot on every look at a screen; it saves one per distinct screen now, and a budget stop says `BUDGET_EXHAUSTED`.
- A generated flow failing on a locator step was filed as an app bug (app BLOCKED); it is now automation drift (coverage BLOCKED, risk caution). A flow missing test data is `blocked` (`missing_test_data`), not failed.
- `goal:"test_login"` recorded no login outcome; it always records one now. `goal:"reproduce_bug"` echoes `goalText` and records a "not verified" outcome for the agent to settle. The terminal result adds `releaseRisk` and `goalText`.
- `qa_visual {mode:"assert"}` answered "✅ PASS" as if Swipium had checked the image. It now says the assertion is agent-asserted and the screenshot was not checked (`evidenceKind:"agent_assertion"`, `checkedBySwipium:false`, `passDefaulted`), and the report counts it as manual review.
- `qa_mobile_audit` asked for network consent on iOS and left a stale network flag that broke every later report; iOS now skips the network checks without consent, and a failed network restore no longer fails the report. Store-compliance items not visible on the inspected screen are `blocked` (not verified), not `fail`.
- The report merged taps from a fatal error screen into the canonical suite, and suite cases from exploration claimed `pass` for features that were never found and defaulted to `android`. Error screens add no cases, not-found features get no case, and cases take the platform the run used.
- `qa_report`: `reportLinks` is always present (`null` without a baseline), `counts.artifacts` matches the summary, and the new `counts.testCatalog` holds the test-catalog counts.
- Exports: the GitHub summary neutralizes `@mentions` and URLs from run text, and SARIF no longer anchors results inside build products such as `*.app/Info.plist`.
- A later `qa_report` call on a run that never reached the app turned it into CAUTION with app PASS once a `blocked` note existed, and counted the report's own exports as evidence. Notes never upgrade an untested run now (see upgrade checklist item 11).
- Any `qa_screenshot`, even of the home screen, turned a Metro-blocked run into CAUTION with a passing gate, and a later `qa_report` replaced the blocker's code (`METRO_REQUIRED`) with `NOT_TESTED`. Only a screenshot taken while the app under test is in front counts now, and the not-tested verdict and its code are kept on the session for later reports.
- A run that reached the app but then got blocked (for example `BLANK_SCREEN`) passed `--fail-on-gate` once `qa_report` was called again, and a bare `qa_note {outcome:"pass"}` with no device and no evidence gave SHIP and a passing gate. Both fail the gate now (upgrade checklist item 11).
- After a `release_gate` audit with blocked checks, `qa_report` still said SHIP and COVERED: the audit recorded nothing on the session. It records a `mobile_audit: <profile>` outcome now (upgrade checklist item 31).
- A failed `qa_flow_run` left `qa_report` at SHIP and COVERED, because only its artifacts showed the failure. A flow run now records its outcome on the session, filed like a saved flow in `qa_smoke`: locator drift in a generated flow is `caution`, an app failure is `block`. A run where exploration was blocked (for example only unsafe actions left) said SHIP next to Coverage BLOCKED, and a run whose saved flows were all skipped by the session budget said SHIP and COVERED with 0 flows run. Both are `caution` now; budget-skipped flows make coverage `PARTIAL` and are named in the report.
- A blocked note with category `other` (Metro not serving, a blank launch) was bucketed as a Swipium limitation; it counts as `environment`. A WDA that died mid-run was filed as `launch_smoke: app_bug`; it is `blocked` with `WDA_UNREACHABLE`.
- The Markdown export kept ANSI and NUL characters and raw HTML from run text, and a `|` in a note broke the Workflows table; `report.md` kept control characters too. Control characters are stripped, `<` is escaped outside code blocks, and table cells are escaped. The PR summary of a not-tested run listed Swipium's own exports as evidence; it says `Evidence: none recorded`.
- `qa_report` described the `automation_candidate` QA level as "a POM automation suite was generated" when only recorded actions existed; it says the recorded actions are enough to generate one.
- A visual-only smoke over a RedBox ended SHIP with app PASS; it is app `UNVERIFIED` ("check the screenshot") and at most `caution`. A not-tested report said health `OK`; it says `not checked`, and `qa_test_this` takes its `health` from the report.
- The gate said "all required flows passed" for a smoke-only run. The reason now says what ran: `no failures recorded (launch smoke only, 0 flows run)`, or `N of M workflow(s) passed; the rest were blocked or skipped`.
- Environment gates (`METRO_REQUIRED`, `METRO_WRONG_PROJECT`, `MULTIPLE_DEVICES`, `DEVICE_PINNED`, project-root and artifact-choice refusals) made the tool status `DEGRADED`; they are counted in `environmentCount` and no longer degrade it.
- The GitHub summary printed `unknown` and `device` placeholders, listed report exports as evidence, and passed raw ANSI escapes through; SARIF anchored results to a `package.json` that didn't exist. See [ci-reports.md](docs/ci-reports.md#what-each-file-contains) for the new anchor order.
- Exploration cases claimed `pass` for features that were only reached, or only seen as a label (see upgrade checklist item 27).
- A pass `qa_note` after a launch onto a RedBox gave SHIP and a passing gate, because a launch counted as backing for the claim; it is an unverified claim now (upgrade checklist item 11). A `qa_act` after a blocked run (even a press home) cleared the not-tested marker, a launch of any bundle (Safari) or a launch that never reached the foreground counted as reaching the app, and `qa_ios launch` of another bundle made it the app under test, so its screens counted as coverage. Only actions taken with the app under test in front count now, the marker clears only on a real retest, only a launch of the app under test that reached the foreground counts, and `qa_ios launch` keeps the app under test (`appUnderTest` in the result). First-run actions count only when the app under test was in front.
- A refused consent gated as `NOT_TESTED`; it gates with the refusal's `CONSENT_*` code. A WDA that stopped answering was exported as a high app finding (JUnit failure, SARIF error, "1 high" in the summary, and "high-severity finding" in the risk reasons); it is a tool or environment item now that still fails the gate (upgrade checklist item 13). An unverified pass note was a passing JUnit testcase and `pass=1` next to BLOCK.
- A tool call that threw a raw error (an `adb … monkey` launch timeout) left the tool status at PASS; a thrown, uncoded error counts as a tool-side failure (`DEGRADED`), and `qa_prepare_target` returns that launch timeout as `DEVICE_UNRESPONSIVE` (else `APP_LAUNCH_FAILED`) with next steps.
- `qa_issue_log` ignored an explicit `severity` for unclassified observations and kept trailing numbers in the identity; the severity is kept (or `severityOverride` says why not), and "coupon 42" and "coupon" are one issue. `qa_explain_blocker` echoed registered secrets in `context`; it redacts them.


**React Native and Metro**

- `qa_metro start` failed with a raw ENOENT after already applying `adb reverse` (it opened the wrong log path), and a missing `npx` could crash the server. It now opens the right log and returns `METRO_FAILED` on any spawn failure.
- Any Metro on port 8081 counted as ready, even one serving another project. The new `METRO_WRONG_PROJECT` is returned by `qa_wait`, `qa_prepare_target`, `qa_test_this` and `qa_metro start`, and `qa_metro status` shows the other project's root.
- iOS debug builds never produced `METRO_REQUIRED`: `qa_prepare_ios_target` now gates a React Native `.app` without an embedded bundle on Metro (`allowLaunchWithoutMetro` overrides), and the iOS RedBox wording and ids, `EarlyJsError`, and the Expo dev-client launcher are recognized. A Metro RedBox ends the run `blocked` with `METRO_REQUIRED` and `nextRecommendedAction` `qa_metro {action:"start"}` (it was `null`), and is filed as an environment issue, not an app bug.
- Smoke judged the screen while it still showed "Bundling 47%"; it now waits (bounded) for the app to render, and a banner that never goes away is `blocked` `BLANK_SCREEN` (a slow cold bundle is not an app bug), not an app readiness failure. A visual-only baseline's app health is `unverified`, not `ok`.
- With a cold Metro bundle, `qa_test_this` passed (and said SHIP) on the app's own JavaScript loading screen ("Looking for your plane in the sky…") while `qa_smoke` correctly blocked. The app's splash or loading screen (a `splash` id, or a lone "Loading…"-style caption on a screen with at most 2 controls) now counts as not rendered, more Metro banners are recognized (`Bundling…`, `Loading from localhost…`, `Building JavaScript bundle`), and the blank bound grows from 15 s to 30 s while Metro is listening, so both tools give the same verdict. `qa_smoke {launch:false}` skipped the render wait; it runs whenever the session has an app.
- The render wait returned "rendered" when its first UI dump failed, and its last dump was thrown away and taken again; it keeps polling until a tree is read (else the launch health is `unverified`), and the smoke's baseline reuses the wait's last dump. `qa_mobile_audit` returned no `BLANK_SCREEN` code; its launch check carries `failureCode:"BLANK_SCREEN"`.
- The render wait passed an iOS splash (the app's root node always carries its name) and ran to its timeout on an animated screen that was already rendered. The root no longer counts as content, a blank tree after about 15 s is `BLANK_SCREEN` (upgrade checklist item 25), and a screen with real content counts as rendered at once, so an animated screen costs 1 or 2 dumps instead of about 13 s. Exploration, first-run and `qa_mobile_audit` (which read a splash as "no interactive controls") use the same wait.
- Expo's fatal "App entry not found" / "main has not been registered" screen wasn't recognized, so smoke replayed every saved flow into it and blamed locator drift. It is a high `REDBOX` finding, and after a fatal launch screen the saved flows are noted `blocked` without running.
- When this project's Metro was serving but the Expo dev client wasn't connected, the blocker still said "start Metro" (and `qa_metro start` looped). It now says Metro is serving and gives the dev-client deep link to open, also for an `app.config.ts` project (the slug is read from it, else from the installed iOS app's `exp+` URL scheme).
- On iOS a wrong-project Metro was reported as `METRO_REQUIRED`, and the Metro check ran after the install and only when `app` was passed. It is `METRO_WRONG_PROJECT`, runs before the install, and also covers an installed app passed by `bundleId`.

- The Metro gate and `adb reverse` applied to any `appId` launched from an RN project root, system apps included; they now apply only to the project's own app.
- A Metro listening only on `::1` (IPv6 `localhost`) while the dev client connects to `127.0.0.1` was reported as "Start Metro" by `qa_test_this` and `qa_metro diagnose`; both now say Metro is serving on `::1` only and to restart it listening on all interfaces.
- The loading-screen check took any short "Looking for…", "Fetching…" or "Preparing…" caption for a loading screen, so a rendered pairing screen ("Looking for nearby devices…") was `BLANK_SCREEN`. Those captions count only when they are the whole screen.
- A launch onto a RedBox (for example with `allowLaunchWithoutMetro`) still answered "ready" in `qa_prepare_ios_target` and `qa_prepare_target`, and a `qa_screenshot` of the RedBox counted as reaching the app. A WDA-structured iOS prepare, and an Android prepare of a debug React Native build, now read the screen once after the launch: a RedBox that says the bundle could not be loaded, or the Expo dev-client launcher, fails the call with `METRO_REQUIRED` and keeps the session not tested until a Swipium outcome runs; a JavaScript error RedBox is recorded as an app finding and the result says "not ready to test" (`ready:false`, `appError`). `qa_screenshot` checks the tree it already reads for its secure-field guard, reports `appError` with a warning line, and doesn't count such a screenshot as reaching the app. A visual-only iOS prepare has no tree, so it isn't checked.

**iOS and WebDriverAgent**

- Every simulator's WDA used `127.0.0.1:8100`, so `qa_wda setup` reused, and `attach` drove, another simulator's WDA, launching the app on the wrong simulator. See upgrade checklist item 21.
- A managed WDA's control port listened on every network interface; it now binds loopback (`USE_IP`), and its build cache directory is added to `.gitignore`. Its MJPEG screen stream still listens on every interface (WDA has no setting for it), and every simulator's stream used port 9100; it now follows the WDA port (+1000). See upgrade checklist item 21.
- Two concurrent `qa_wda setup` calls for two simulators could pick the same port, and the loser reported the winner's WDA as ready. Managed WDAs now always get the simulator's own port, ports other simulators' WDAs hold count as taken, and a start checks who owns the listener before it reports ready (`WDA_PORT_CONFLICT` otherwise). `qa_prepare_ios_target` and `qa_wda attach` find the simulator's own WDA when the configured URL's WDA is not this simulator's.
- `qa_wda stop` by port could stop another simulator's adopted WDA, and in a new session couldn't stop a WDA another server had adopted. It now matches the simulator UDID only (see Agent workflow).
- After its runner was killed, a managed WDA's `xcodebuild` kept `start` refusing with "already running" for 20 s or more; a stale WDA is now replaced. The startup sweep reaped a WDA that was busy launching an app (its `/status` probe timed out) and interrupted its build; a busy WDA is adopted now.
- `qa_prepare_ios_target {sessionId}` with no `app` or `bundleId` returned ok with `launched:false`; it installs the project's simulator `.app` (consent-gated), like the Android path. `qa_doctor` without a project root reported the server's working directory as the WDA project root; those fields are `null` now.
- Screenshots were withheld on the iOS home screen and in Settings because a "Passwords" app icon or row counted as a secure field. Only password fields, and input fields whose id or label names a secret, are secure now.

- A dead WDA showed up as `SNAPSHOT_FAILED` "fetch failed" and pushed the session toward visual-fallback; it is `WDA_UNREACHABLE` with `qa_wda start` and `attach` as next steps, and a shut-down simulator is `NO_DEVICE`. Every launch failure used to be `BUNDLE_ID_NOT_FOUND`: a launch that times out or is refused is now `APP_LAUNCH_FAILED` (the stuck `simctl launch` is killed), with a concrete `qa_ios` next step from `qa_test_this`.
- `qa_wda attach` returned the whole diagnostic payload and ran Xcode and simulator probes first; it is lean and faster now (details are in `status`).
- `qa_doctor` and `qa_wda status` missed an Appium-installed WebDriverAgent that `setup` would use.
- `.ipa` and device-build errors told users to connect a real device; they now say to build a simulator `.app`.
- `qa_test_this` and `qa_prepare_ios_target` recorded a simulator boot even when it was already booted.
- After the per-simulator port change, `qa_test_this` still probed only `ios.wda.url` (default 8100): goals that need WDA failed with `WDA_UNREACHABLE` although setup, attach and `qa_wait {for:"wda_ready"}` succeeded, and `release_gate` and the no-goal run silently skipped exploration and reported a "visual-only" smoke. It resolves the simulator's own WDA like `qa_prepare_ios_target`, `qa_wait {for:"wda_ready"}` and `qa_doctor`'s `wda-server` row do now too, and its `qa_wda` next steps carry `device`.
- WDA hung on the app's splash after a cold simulator boot: the smoke waited 140 to 300 s, replayed every saved flow into it, and filed an app bug. It re-probes once, then blocks the launch with `WDA_UNREACHABLE` (a tool or environment failure), notes the flows `blocked`, and `qa_test_this` stops with restart advice. The settle counts against the 30 s render bound, so the verdict comes about 35 s after the launch (30 s plus one 5 s re-probe), and nothing calls WDA after it: health is built without WDA, the screenshot comes from `simctl`, and the report skips its UI dump. The note says how long WDA was silent, and `nextRecommendedAction` is `qa_wda {action:"stop"}` (it was `null`).
- A WDA that hung at session creation (WDA's own 60 s timeout) fell back to visual-only, so `qa_test_this` reported a screenshot-only launch pass and replayed flows against the simulator backend. Session creation for a launched app is capped at 15 s, a timeout with `/status` also silent is a hung WDA (the run ends `blocked` with `WDA_UNREACHABLE`, flows `blocked`), and `qa_act` and `qa_snapshot` on a visual-only session whose recorded WDA stopped answering return `WDA_UNREACHABLE` instead of `BACKEND_UNSUPPORTED`. When this simulator's own WDA hung, `WDA_UNREACHABLE` named another simulator's WDA on 8100; it names the hung one and says to stop it.
- A screenshot right after a visual-only `qa_prepare_ios_target` caught the launch animation; the prepare waits (up to about 4 s) for a stable frame first.
- When `lsof` or `ps` couldn't identify the process behind a WDA port, setup and attach still reused it (possibly another simulator's); it is `unverified` now and never reused or attached. A custom `ios.wda.url` port kept the start race between two simulators; a second simulator moves to its own port. A free port is picked only when its stream port (+1000) is free too. `qa_wda stop` unregistered WDAs it failed to stop. A setup job that had to move off the approved port after consent didn't say so; `portMovedFrom` and the ledger do. A remote WDA approved once was treated as approved for every later attach or start (upgrade checklist item 21). A WDA request that timed out mid-way was reported as "connection refused; nothing was sent".
- A server's startup sweep could take over another live server's WDA entry in `~/.swipium/processes.json` (its `serverPid` was rewritten) when `ps` failed to read the owner's start time. An owner whose pid is alive but whose start time or command can't be read now counts as alive, so only entries of dead servers are adopted or reaped.
- `qa_wda attach` after `qa_wda setup {device}` failed with `MULTIPLE_DEVICES`; the session remembers the simulator. `qa_wda status` said "blocked" for a ready WDA when no bundle id was set; that is a warning now.
- `swipium verify` (and `init --apply`) started a server whose startup sweep adopted an orphaned managed WDA; that server skips the sweep now.
- Tapping "Don't Allow" on a system location alert failed with `OVERLAY_OBSTRUCTION`, blamed on the alert's own scroll indicator. Scroll indicators and scroll positions (`0 %`) are no longer labels, a non-clickable element inside the same alert doesn't obstruct its buttons, and `qa_clear_overlay` checks the target the same way `qa_act` does.
- `press home` on iOS took 28 to 36 s at times and, without a session app, named the previous app as the foreground; it returns within a few seconds and waits for SpringBoard. `qa_prepare_ios_target {bundleId, launch:false}` left the session without an app; it sets it. `qa_status` on a shut-down simulator still recommended `qa_generate` or `qa_report`; it recommends preparing the simulator again. The `BUNDLE_LOSS_REFUSED` text on iOS talked about `pm clear` and APKs.
- iOS snapshots listed chevrons, class or asset names (`PageFormatMenuButton`) and nested identical scroll views; they are dropped (the name stays the element's `#id`), and nested unnamed scrollables with the same bounds collapse into one on Android too. Settings rows still listed a `[text] "chevron"` when the chevron was in the node's value or on another non-control type; any non-control chevron is dropped now, and a chevron name is never used as an id.

- `qa_prepare_ios_target` said "ready" while a SpringBoard alert ("Sign in to your Apple Account") covered the app; a WDA-structured prepare now names an iOS alert on top of the app (`alert`, with a `qa_clear_overlay` hint).
- `qa_wda stop` labelled a WDA found in the process registry "(started by another server run)" even when this server started it for another session; it says "registered by this server for another session" or "registered by another Swipium server".
- `~/.swipium/processes.json` kept a dead WDA's entry for as long as the server that owned (or adopted) it lived; dead entries are dropped on the next registration or stop.

**Snapshot and act**

- System permission alerts were missing from iOS snapshots while the controls they cover looked tappable; see upgrade checklist item 21. `qa_clear_overlay` reported `cleared` while a permission dialog was still up, and `allow_permission` could tap the dialog's message instead of its button.
- iOS rows were listed four or five times (cell, button, icon, chevron, text) and keyboard keys were not tappable. Rows are listed once, images and icons are not tap targets, and a clickable row without a name of its own carries its child title on Android too.
- A text field lost its ref after typing on iOS (`STALE_REF` on the second `type`), and an unlabeled element could keep the ref of a different element on a new screen.
- A `text` target matched the first substring in screen order (a dialog's message before its "Allow" button); exact and clickable matches now win.
- Long text typed with adb could arrive scrambled in Compose fields, and replace mode left anything past 120 characters of old text in the field. Long text is now typed in verified pieces of about 40 characters (read back after every 2 pieces, and the unverified pieces resent once if characters were lost), replace mode clears the whole field (select all and delete on Android 13 and later, else a length-aware delete on both sides of the caret, so multi-line fields and coordinate targets are emptied too), and a field that doesn't read back the typed value fails with `TEXT_INPUT_MISMATCH` (upgrade checklist item 24). Typed non-secret text is no longer shown as `«redacted»`, so it can appear in the field's element line ([Threat Model](THREAT_MODEL.md#secret-handling-and-redaction)).
- Correct text typed into a labeled Jetpack Compose field failed with `TEXT_INPUT_MISMATCH`, and long text there still scrambled, because the read-back compared `"<value>, <label>"`. The value is compared now. Replace-mode typing by coordinates left most of a long old value in the field and returned `ok:true`; it clears fully and fails on leftovers. A failed append was marked retry-safe, which would type the landed part twice. Long text into a max-length or masked field threw instead of warning like short text. Flow `inputText` had no read-back; with `into` it has one.
- A ref to a text field went `STALE_REF` after typing into it (its label follows its value); it is found again by class and id when exactly one such field is on screen. Snapshot text showed raw `&#10;` entities.
- `qa_clear_overlay {strategy:"hide_keyboard"}` with no keyboard up said `cleared`; it says `nothing_to_clear`. `auto` reported `cleared` for a permission dialog it only reported, and tapped outside on a screen with no overlay (upgrade checklist item 29). On Android a permission dialog's snapshot used the dialog's window as the screen size, and an element `wait` overshot its deadline by a whole UI dump.
- iOS snapshots listed sibling duplicates (two "Dictate" buttons) and image labels such as `chevron`; exact duplicates of any listed element and lowercase symbol names on images are dropped. A `scroll` whose `untilVisible` target was already on screen counted as a no-change action.
- Crash logs were read from the last 800 lines of the default buffers, where the stack had often scrolled away and Swipium's own `uiautomator` start lines got in. The crash buffer is read first and only the app's own block is kept. Settings opened from inside the app's task was reported as a wrong foreground app.
- `qa_device_info` logs: `lines` was per buffer, a `package` that had just crashed was an error, and unknown keys were ignored. `lines` is an overall cap applied after the filters (so neither `package` nor `since` with `grep` loses a crash behind busy noise), a package is matched by its current and crashed pids, unknown keys and a sensitive session are refused before the device lookup, and the new `since` and `context` options read from a point in time and keep lines after each `grep` match. A crash's log excerpt could start with another process's lines; it starts at the crash and keeps the crashed process's lines, and `qa_check_health` returns its `logUri`. A crashed app's ledger issue was titled after the launcher that replaced it; it names the app.
- `uiautomator dump` on a screen that never goes idle retried for about 60 s per call; it gives up after one attempt (about 12 s) and suggests `SWIPIUM_ANDROID_DUMPER=agent`. On a stalled emulator a snapshot took about 100 s (5 attempts of 20 s); a dump that gets no adb answer at all stops after one attempt with `DEVICE_UNRESPONSIVE`, without switching to visual-fallback.
- Long text typed into a labeled Compose field could still arrive scrambled: the app reset its caret to the start while keys arrived, a dump failure turned the per-piece check off, and the documented retry only ran on a driver error. A failed read-back now gets one clear and careful retype (upgrade checklist item 24). A short replace into Compose sometimes kept old text because Ctrl+A came right after the focusing tap; the clear waits until the tap is about 0.9 s old. A dropped last character was accepted as a max-length cut; a cut must repeat on the retype. The Compose label strip applied to any field whose text equals its description; it uses the label read before typing. iOS typing by native selector had no read-back; it has one. A straight apostrophe in a `text` target didn't match a curly one (`Don't allow` vs `Don’t allow`); quotes are folded in every text match. An adb timeout while typing in a flow was reported as `WDA_UNREACHABLE`; it is `DEVICE_UNRESPONSIVE`.
- A crash finding in the `qa_act` right after a `qa_check_health` had no `logUri`, because the 30 s excerpt dedupe dropped the repeat; repeats in the window link the same excerpt. A medium "different app in front" finding was filed as a Swipium limitation; it is an app bug (medium).

- `press home` on iOS waited on a stale page source and counted as a no-change action.
- A device that disappeared mid-session was treated as a snapshot failure (and, in `qa_act`, as a change); it is `NO_DEVICE` everywhere, with the iOS tool named in next steps on iOS sessions.
- Health treated every `com.android.*` app, Chrome and Settings included, as a harmless system surface, and called a crashed app healthy. Other apps are `wrong_foreground_app`, high with "possible crash" when the app's process is gone, and crash and ANR findings save a logcat excerpt. `qa_app_control restart` and the flow `restartApp` step now clear another app's activity left on top of the app's task.
- `qa_clear_overlay` on a visual-only iOS session returned `SNAPSHOT_FAILED`; it is `BACKEND_UNSUPPORTED`. A malformed ref is `INVALID_ARGUMENT`, and `removed` lists element lines.
- New: `qa_device_info {logs:{…}}` captures filtered Android logcat to an artifact, and log artifacts are scrubbed of credential-looking values that were never registered.

**Flows and suites**

- `qa_flow_check` and `qa_flow_run` read any file path, including files outside the project; see upgrade checklist item 17.
- `swipium suite compile`, `qa_flow_compile` and suite generation overwrote hand-edited flows; they keep them and write `<slug>.yaml.new` (`force` overwrites).
- A generated flow started from whatever screen was up, had no final check, and selected text fields by their placeholder. It now starts with `restartApp` when the recording did, ends with an assertion on the last screen, and uses field ids. Flake triage adds `wrong_start_state`.
- `suite lint` ignored POM tests, unresolved references and coordinate taps, and swallowed YAML errors. It now lints tests too (`UNRESOLVED_REFERENCE`, `COORDINATE_ONLY`, `YAML_PARSE_ERROR` with line and column), `qa_suite_lint` adds `no_steps`, `placeholder_steps`, `duplicate_steps` and `unproven_pass`, and the POM file layout and exit codes are documented ([POM suites](docs/flows.md#pom-suites)).
- `qa_suite_update` crashed with a raw TypeError on loosely shaped cases and merged `{}` into an existing case; cases are validated (`INVALID_ARGUMENT` with paths) and plain-string steps are accepted. The `qa_suite_*` tools resolve the project root like every other tool, and `qa_suite_read` returns `suitePath`.
- The suite summary advertised a `swipium suite run` command that doesn't exist; it lists the `qa_flow_run` calls instead.
- `qa_flow_repair` proposed any element when nothing on screen resembled the selector, and then proposed nothing for "Sign in" renamed to "Log in". It ranks same-role controls with a few common UI synonyms now, never proposes an opposite action ("Sign out" for "Sign in", on and off, lock and unlock, and negations: "Don't allow", "Do not allow" or "Don’t allow" for "Allow"), and auto-applies a medium-confidence match only when both labels have the same words up to case, punctuation, camelCase and plurals (it once turned "Book now" into "OK"). Whole-word containment was enough before, so "Delete" could be auto-repaired to "Delete account" and "Cancel" to "Cancel subscription"; a label that adds words is now a low-confidence proposal that is never applied.
- `qa_suite_update` used a caller-supplied case `id` as a file name, so `../..` wrote outside the suite folder and a long id failed; ids are validated (upgrade checklist item 30). A `../..` id stored in a committed `test-suite.json` still reached `qa_suite_export {format:"yaml", save:true}`, which wrote outside the project; stored ids are renamed on read and the export skips any path outside its folder. `qa_suite_update` on a hand-written case without `featureId` failed as `ARTIFACT_PATH_UNWRITABLE` ("reading 'trim'"); loaded cases are filled out to the suite's shape, and a non-disk error is `INVALID_ARGUMENT`. An explicit id was dropped silently when the case merged; `idsIgnored` says so. A screen seen in two states got a second page object (`Alarms2Page`), and test cases pointed at test files that were never written (item 30). `qa_smoke` counted a flow skipped for consent as failed and blamed a CI policy (item 31). On iOS, flows with `id=` selectors were reported as unsupported. Exploration tapped links that left the app and counted the other app's screens.
- Generated Appium projects: the Python `conftest.py` needed pytest for unittest suites, WebdriverIO waits were mistyped, the Appium port setting was ignored (the Python suite now reads `APPIUM_URL`, else `APPIUM_HOST` and `APPIUM_PORT`), and the README skipped installing a driver. They now depend on Appium 3 (`appium ^3.0.0`) and wait for any activity of the app unless `ANDROID_APP_ACTIVITY` is set.
- A second `qa_generate {target:"suite"}` overwrote the shared page objects and `suites/smoke.yaml`; they are merged now. Page objects claimed both platforms and flagged Android text selectors with an iOS code; they claim the recorded platform, and Android gets `ANDROID_MISSING_RESOURCE_ID`.
- A 300-character feature title crashed every later suite save and export (a directory name over 255 bytes). Names derived from titles are capped at 80 characters plus a hash, and a disk error is `ARTIFACT_PATH_UNWRITABLE`.
- `swipium suite lint` and `compile` numbered steps from 0 and ignored unknown flags (see upgrade checklist item 18). Writing a compiled flow left an older `<slug>.yaml.new` behind; it is removed now.
- Generated flows that start with `restartApp` failed `qa_flow_check {ci:true}` without a policy file (see upgrade checklist item 28). A generated flow's header now says its final assertion is a navigation check and lists up to 3 recorded outcomes to assert.
- Exploration stopped at an optional "Sign in to your Apple Account" row, and with `stopOnAuth:false` still stopped at an auth wall. Auth wording now needs a login form (or a screen with few other controls) to count as a wall, and `stopOnAuth:false` keeps exploring the public screens. "Dismiss" and other state-changing controls are no longer treated as safe, tabs rank above overflow menus, and a control that already led to a screen isn't re-tapped from every other screen.
- On iOS the explorer pressed back on a screen where back did nothing until the 6-minute budget ran out, then reported the run `completed` (and `release_gate` said SHIP). A back is now checked like any action and counts against the budgets, a screen that back can't leave gets an in-app back control, then a relaunch (at most 2), then the run stops, and a time-budget stop is `blocked` (upgrade checklist item 23).
- First-run tapped "Sign up with Apple" as the submit button, read the system alert that followed as the home screen (its "Settings" button), and the explorer then tapped "Settings" into iOS Settings and mapped it; the generated flow started with the Apple tap. Third-party and OS sign-in controls are never tapped and are left out of generated flows, alerts are closed with their cancel button and never explored or classified as a screen, and another app's screens always count as leaving the app.
- An empty `SWIPIUM_TEST_*` value counted as provided; it counts as unset (`MISSING_TEST_DATA`).
- A project flow for an app that isn't installed on the device (for example on a session for another app) failed with an unclassified `monkey … exited 252` error and was counted as a Swipium limitation (Tool status `BLOCKED`). Its launch step now fails with `BUNDLE_ID_NOT_FOUND`, and the flow is filed `blocked` as a setup problem, with "install the app or fix the flow's appId" as the next step.


**CLI and setup**

- `swipium scan` overwrote `.swipium/config.json`, losing WDA, OCR and `appId` settings; it now merges. It also reported `BLOCKED` (with exit 0) for a buildable project with no artifact yet; that is `PARTIAL` ("will build from source") now. See upgrade checklist item 18 for the exit codes.
- Retention and `swipium gc` deleted nothing on machines with many temporary project roots, and the startup prune scanned every session on every start.
- Swipium ran silently on Node.js 20, and `verify` said OK; the server warns and `verify` fails, listing every failed `qa_doctor` check.
- `init claude` re-runs failed with a misleading command and exit 0; `init gemini` exited 0 having registered nothing (it now writes the settings file itself); `init codex` appended to a malformed `config.toml` and didn't flag a different `cwd` or missing timeouts; `--scope=project` and unknown flags were ignored; `init claude --cwd <missing dir>` registered the shell's directory.
- `qa_test_this {mode:"plan"}` wrote the app map and `.gitignore` despite being side-effect free, and later still created an empty `.swipium/` for the app-map lock; it creates nothing now.
- `swipium scan` replaced an `appId` you had set in `config.json` with the detected one; it keeps yours (an `appId` with no `appIdSource`, or `appIdSource:"config.json"`) and says how to switch, and still refreshes one an earlier scan wrote. `swipium gc` overwrote a corrupt `projects.json` with an empty registry; it leaves it unchanged and says so. The MCP server still replaced a corrupt `projects.json` silently on its next write; it moves the file aside (`projects.json.corrupt-<time>`) and logs a warning first. A hand-edited `appId` that kept a scan's `appIdSource` was still replaced silently; scan now stores `scanAppId` to tell (upgrade checklist item 22).
- `init gemini` pinned the shell's directory as `cwd` in the user-wide `~/.gemini/settings.json` and set no timeout; user scope writes no `cwd`, and `gemini mcp add` gets `--timeout 600000`. `init codex` accepted a `config.toml` with an unterminated string or a duplicate key or table, and later one with a bare value that isn't a boolean, number or date, an invalid escape, or a table redefined through a dotted key or `[[array]]`; it refuses those too (it is still a conservative check, not a full TOML parser). That check then refused valid configs with quoted table names containing `/`, `@`, `:` or non-ASCII characters, which Codex itself writes for trusted folders and plugins (`[projects."/Users/me/app"]`, `[plugins."x@y"]`); quoted names and keys take any characters now, and an unpaired `[a]]` or `[[a]` is refused. `init <client> --cwd <missing>` without `--apply` printed a registration; it exits 2. "Did you mean" suggestions kept flags the subcommand doesn't take.
- A directory holding only a prebuilt `.app` or `.apk` was `NOT_MOBILE_PROJECT`; it is tested as that artifact now, when the artifact is at most 2 directories below the root and the root is not a shared system directory such as `/tmp` or `/private` (those stay `NOT_MOBILE_PROJECT`). Only that near-root artifact is installed (a deeper build could be picked before), WebDriverAgent and XCTest runner bundles never count as the app (`~/Library` planned `WebDriverAgentRunner-Runner.app`), and a `projectRoot` ending in `/` or `..` no longer reports files inside it as outside the root.
- The npm package now ships the files the docs link to (`android-agent/README.md`, `plugin/README.md`, `SECURITY.md`, `SUPPORT.md`, `CONTRIBUTING.md`) and no longer ships source maps.

**Tool contract**

- `projectRoot:"/"` walked the whole disk, and `/Applications` or `/Users` were scanned for 70 to 90 s before being refused; see upgrade checklist item 19. The artifact search also stops after 20,000 directories or 10 s (checked per entry, so a folder of hundreds of apps can't overrun it), with a warning. The `PROJECT_ROOT_UNRESOLVED` hint says which variable was skipped and why, and `qa_doctor` has a `project-root` row.
- Consent: see upgrade checklist item 15. Under a client that auto-answers prompts, the refusal says outright that only the operator setting helps, and every refusal carries the `sessionId` the call used or created.
- `SWIPIUM_TOOLS=core` still reported 55 tools in `qa_start_session`, `qa_doctor` and `qa_status`, and pointed at hidden tools; counts and guidance now follow the listed set.
- Success results echoed caller strings at any length; echoed input is capped at 2,000 characters and summaries at 20,000. `qa_note` echoed registered secrets in its response; it is redacted now.
- `qa_test_this {waitForCompletion:true}` could exceed `SWIPIUM_MAX_WAIT_MS` by the time spent planning; the cap covers the whole call. `qa_wait` now follows `SWIPIUM_MAX_WAIT_MS` instead of a fixed 50000, `qa_job_status` notes a clamped `waitMs`, and an unparseable `SWIPIUM_MAX_WAIT_MS`, `SWIPIUM_TOOLS` or `SWIPIUM_LOG_LEVEL` logs a startup warning.
- Many argument and precondition errors were `UNKNOWN`; they are `INVALID_ARGUMENT`, `NO_DEVICE`, `FLOW_NOT_FOUND`, `INVALID_FLOW` or `NO_ARTIFACT`. An empty project directory is `PROJECT_ROOT_EMPTY`.
- `qa_issue_log` accepted `swipium://session` evidence URIs that resolve to nothing; they are refused. Ledger entries from runs have descriptive titles and evidence links.
- `qa_get_artifact` reads project app-map URIs, so clients without MCP resources can read the full map; `mode:"metadata"` on one returns its size and path instead of the content. `qa_bundletool` with a missing `aab` started a job that failed later; it is refused up front with `NO_BUILD_ARTIFACT` (a path that isn't an `.aab` with `INVALID_ARGUMENT`), and a relative `aab` is resolved against the project root.
- `qa_issue_log`: re-logging an issue without `severity` reset it to `low`; the stored severity and category are kept. A manual log with no category that no rule recognizes is filed as `mcp_limitation`, and the result says so in `categoryNote`. `qa_screenshot`, `qa_device_info {logs}`, `qa_screen_record start` and `qa_visual` on a sensitive session without a device said `NO_DEVICE` instead of refusing; all four check sensitive mode first. Shutdown left cancelled build processes that ignored SIGTERM running; it kills their process groups after 2 s.
- `qa_doctor`'s structured `summary` now includes the readiness sentence. `qa_test_this {waitForCompletion:true}` could return 1 to 2 s past the cap on a loaded machine; it keeps 10% of the cap (at most 2 s) for building the response.
- `STALE_CLIENT` said old tools were removed in the running version; it says 2.0.0.

**Release gate, devices and reliability**

- **Release gate:** only Swipium checks that read the UI and found it healthy count as testing the app (a smoke whose oracle ruled out RedBox and blank screens, a flow pass, or an exploration that reached a real app screen). `qa_note` and `qa_visual` assert verdicts, launches, raw actions and findings never count, and never clear a not-tested marker such as `METRO_REQUIRED`. App-in-front checks match the exact package or bundle id (`com.example.app` no longer matches `com.example.app2`).
- **Device selection:** every device argument is an exact UDID or a unique exact name; anything else is `INVALID_ARGUMENT`, a shared name `MULTIPLE_DEVICES`, never the first booted simulator. With `SWIPIUM_DEVICE` set, only the pinned device is a candidate on every platform (`qa_prepare_target`, `qa_test_feature`, `qa_wda stop`), and a pinned name shared by several simulators pins none. `qa_ios erase` resolves to a UDID and the consent prompt shows it. `qa_ios boot` with no device and several booted simulators is `MULTIPLE_DEVICES`.
- **release_gate relaunch audit:** waits for render before the health check; a WDA timeout there is a tool block (WARN at most), not a high app bug.
- **Android crash logs:** a second crash within 30 s links its own log excerpt, not the first one's.
- **Android typing:** one UI dump timeout no longer switches off read-back verification of long text; a Compose replace retry clears by length instead of repeating Ctrl+A.
- **iOS prepare:** a WDA already hung before prepare is detected (no visual-only pass, no flow replay); `qa_prepare_ios_target` waits for render before `ready`; a native-selector miss is `ELEMENT_NOT_FOUND`.
- **Suites:** suite writes under `.swipium/` refuse symlinks; a generated suite records the explorer's relaunch as `restartApp`.
- **Other:** `test_login` on a sign-up chooser taps "Sign In"; explorer stops that tested nothing end `blocked`, not `completed`; `qa_act wait` with `target` instead of `for` is `INVALID_ARGUMENT`; `logs.since` uses the device clock; `init codex` recognizes quoted, spaced and dotted swipium tables.

### Known issues

- An interactive `qa_act` on an Android ref from a snapshot older than 1.5 s first takes one raw screenshot (about 0.15 s). It pays one extra UI dump (about 2 s on a slow emulator) only when the screen changed since the snapshot, the snapshot is older than 60 s, or the screenshot fails.
- `SWIPIUM_ANDROID_DUMPER=agent` holds the device's single UiAutomation slot while it runs (up to 120 s after its last dump): Appium UiAutomator2, Maestro and `uiautomator dump` started outside Swipium fail with "UiAutomationService already registered" in that window. Wait two minutes or unset the variable. Pushing its jar to the device is gated only by the opt-in variable, not by a consent prompt yet. A server killed with SIGKILL leaves the jar and its `adb forward` behind (harmless). On a screen that never goes idle it returns a dump after at most 2 s where `uiautomator dump` would fail.
- `-gpu auto` was boot-tested headless on macOS (it picks a software renderer there) but not on GPU-less Linux CI. If an emulator fails to start headless or screenshots are black, set `SWIPIUM_EMULATOR_GPU=swiftshader_indirect`.
- With the lean iOS page source, a row that is mostly hidden under a navigation bar can be marked not tappable where WebDriverAgent's own `visible` would say it is.
- With the lean iOS page source, content an app hides without removing it (for example the Settings list while its search is open) stays listed as tappable. Set `ios.wda.settings.pageSourceExcludedAttributes` to `""` for WebDriverAgent's own verdict.
- The report manifest does not list `report.md` (it is built first); `reportMdUri` and the artifact list do.
- With several emulators online and nothing bound or pinned, `qa_test_this` still picks the first one (naming the others in `targetChoice.reason`) rather than asking. Pass `device`, or set `SWIPIUM_DEVICE`.
- Only a second session on the same iOS Simulator in the same server is detected (a warning). Two sessions on one Android device, or sessions in two Swipium servers, are not; use one session per device or pin each server with `SWIPIUM_DEVICE`.
- The WebDriverAgent build cache is per project (`<project>/.swipium/cache/wda-derived-data`, about 200 MB), so each project builds WDA once. `ios.wda.derivedDataPath` can point several projects at one cache.
- Expo dev-client builds are detected (the launcher screen is `METRO_REQUIRED`) but not connected to Metro automatically. When this project's Metro is serving, the blocker gives the deep link to open (`xcrun simctl openurl …` or `adb … am start …`); Swipium doesn't open it for you.
- Crash logs are captured automatically on Android only; on iOS use `qa_ios {action:"logs"}`.
- The release gate still fails on a Swipium-generated flow that broke on a locator step (the report calls it automation drift); list its code in `warnOn` to only warn.
- The JUnit `swipium.releaseGate` property stays `pass`/`fail` while the other formats say `block`.
- A managed WebDriverAgent's MJPEG screen stream listens on every network interface (WDA has no bind-address setting for it). Use a firewall on untrusted networks and stop WDA when you're done.
- Verified Android typing reads the field back after every 2 pieces of about 40 characters: roughly 1 s per piece with `uiautomator dump`, much less with `SWIPIUM_ANDROID_DUMPER=agent`. Short text (40 characters or fewer) is unchanged. Each replace-mode clear first probes once per device for key-combination support; on Android 12 and older it takes one extra UI dump to read the field's length. On Android 13 and later a replace clear waits up to about 0.4 s more (until the focusing tap is 0.9 s old), and a failed read-back costs one clear, a careful retype (8 characters every 250 ms) and another settle.
- A Compose field that resets its caret while keys arrive can still scramble long text, even in careful mode; the call then fails with `TEXT_INPUT_MISMATCH` instead of passing. Typing it atomically would need a set-text command in the opt-in Android agent, which it doesn't have yet. An unlabeled Compose field whose old value equals the leftover label suffix can't be told apart from a labeled empty field.
- After a prepare that found WDA hung, a standalone `qa_smoke` still runs visual-only (the prepare result says to restart WDA); `qa_test_this` blocks correctly. A `qa_test_this` job that ends `blocked` or `unsafe` is still `status:"failed"`, while `qa_test_feature` and `qa_explore` end `done` with `result.state:"blocked"`.
- A not-tested run blocked by the environment (a hung WDA, Metro not serving) has release risk `block`, like any run that tested nothing, not `caution`.
- The "different app in front" observation before a crash and the crash itself still share one issue id in the ledger (their fingerprint has no kind token; adding one would change every existing fingerprint).
- `allowLaunchWithoutMetro` also skips the check for another project's Metro (`METRO_WRONG_PROJECT`), not only the "Metro not serving" one.
- `report-*-summary.md` keeps raw HTML from run text (it is the agent-readable copy); the Markdown export escapes it.
- `qa_wda setup` over a frozen WDA (one that stopped answering, for example a stopped process) starts a second WebDriverAgent for the same simulator on the next free port instead of reporting or replacing the hung one. Run `qa_wda stop` first.
- An exploration may relaunch the app (terminate and launch) up to twice per run to get off a screen that back can't leave.
- A field that completes text inline as you type (`app` becoming `apple`) reads back as `TEXT_INPUT_MISMATCH`, because in replace mode that looks the same as old text left behind.
- On an Android screen that never goes idle (a looping animation), `uiautomator dump` fails after one attempt of about 12 s and Swipium doesn't switch to the agent dumper on its own (it pushes a jar to the device, so it stays opt-in). Set `SWIPIUM_ANDROID_DUMPER=agent` for such apps.
- A network change left by a Swipium server that crashed is not restored automatically; `qa_status` and `qa_network status` warn about it, and `qa_network restore` takes it back. Changes recorded before this version have no owner and are neither restored on shutdown nor flagged.
- A `qa_wda setup` job can move to another free port after consent when the approved one was taken while it built; `portMovedFrom` and the ledger say so, but the consent named the old port.
- A render wait on a visual-only iOS screen (no WDA) still never returns a verdict, so a blank visual-only launch is not reported as `BLANK_SCREEN`.
- `restartApp` still needs the `flow_mutation_run` consent in `qa_flow_run`, so `qa_smoke` skips generated flows that contain it (`flowsSkipped`), including a flow generated from an exploration that relaunched the app.
- A non-secret value typed with `qa_act` (including a non-secret `${SWIPIUM_*}` value such as `SWIPIUM_TEST_EMAIL`) shows up in the field's element line in the response, as screen state. Use secret-named variables for credentials.

- Suite writes under `.swipium/` refuse symlinks, but the issue ledger doesn't yet: a committed symlink at `.swipium/issues-log.jsonl` makes `qa_issue_log` append outside the project. Check a cloned repo's `.swipium/` for symlinks before running Swipium on it ([Threat Model](THREAT_MODEL.md)).
- First run and exploration still answer iOS permission prompts with "Don't Allow"; the result now says so and how to undo it (`qa_ios privacy_reset`).

## 2.2.0 - 2026-10-05

Swipium 2.2.0 moves to the MCP TypeScript SDK v2, adds the MCP 2026-07-28 protocol revision next to the 2025 ones, and changes the shape of element lists in `structuredContent` for every client. It also makes Swipium usable from headless and non-Claude clients (`codex exec`, `claude -p`, Codex in general), keeps waits under common client tool timeouts, and makes cancellation actually stop work. No tools were added or removed (still 55). Work through the upgrade checklist before upgrading.

### Upgrade checklist

Items tagged **You** need an action from you. Items tagged **Automatic** happen on their own and are listed so they don't surprise you.

1. **You:** restart your MCP client so it reloads the server instructions and tool list. The schema hash changed (descriptions were trimmed and `qa_wait` gained `wda_ready` and `simulator_booted`), so update any `qa_doctor { expectedSchemaHash }` check.
2. **You (scripts reading results):** `structuredContent.elements` from `qa_snapshot` and `qa_act` are now `@eN` strings, not objects. Pass `responseMode: "verbose"` to keep the objects, or parse the lines (see Breaking changes).
3. **You (Codex):** Codex passes MCP servers only a small whitelist of environment variables. Add the `env_vars = [...]` line that `swipium init codex` prints under `[mcp_servers.swipium]`, or `SWIPIUM_TEST_*`, `ANDROID_HOME` and `JAVA_HOME` exported in your shell never reach Swipium. Keep `tool_timeout_sec = 600`: some synchronous steps can still take longer than Codex's 60 s default (a large `qa_ios install`, `qa_flow_run`, `qa_smoke`, `qa_mobile_audit`, `qa_generate { target:"appium" }`). `qa_doctor` checks the env part when it runs under Codex.
4. **You (headless runs):** `codex exec` and `claude -p` answer consent prompts automatically, so boots, installs and builds were always refused there. To allow specific actions without a prompt, list them in `SWIPIUM_CONSENT_PREAPPROVE` in the MCP server env (see Added). For Codex, set it literally in the `env = { ... }` table: `init` deliberately doesn't forward it from your shell.
5. **You (iOS automation):** `qa_wda build` now returns a `jobId` right away (poll `qa_job_status`), `qa_wda start` can return `status:"starting"` after 45 s (poll `qa_wait { for:"wda_ready" }`), `qa_ios boot` can return `status:"booting"` after 40 s (poll `qa_wait { for:"simulator_booted" }`), and `qa_prepare_ios_target` can hand a slow boot to a job (poll `qa_job_status`). Agents that waited on one long call need the extra poll.
6. **You (resource clients):** reading a missing `swipium://` resource now fails with `-32602` instead of `-32603`, and `qa_get_artifact` returns `INVALID_ARGUMENT` for an unknown URI.
7. **Automatic:** waits and long-polls end within about 50 s. `qa_job_status` long-polls at most 50 s (was 120 s, recommended `waitMs` is now 45000), and larger `timeoutMs` values on `qa_wait`, `qa_act` and `qa_test_this` are clamped to 50000 with a note instead of being rejected.
8. **Automatic:** Claude Code 2.1.285 and later connect on MCP 2026-07-28. Consent prompts look the same, but Swipium no longer asks those clients for MCP roots; Claude Code sets `CLAUDE_PROJECT_DIR`, so the project root still resolves to the open project.

### Breaking changes

- **Element lists are compact lines, for every client.** `qa_snapshot` and `qa_act` return `structuredContent.elements` as one-line strings, the same lines as the text block, instead of one JSON object per element. For example: `@e3 [button] "Log in" #login_btn [40,200][1040,245] (focused)`. That's about 40% smaller, and it's what Claude Code and Codex show the model. Lines carry bounds, the text when it differs from the label, and a `secure` flag; names are JSON-escaped and capped at 80 characters after redaction. Programmatic readers that expect objects should pass `responseMode: "verbose"`, which still returns them, or parse the lines ([format](docs/tools.md#element-lines)).
- **`qa_wda build` is a job, and `qa_wda start` doesn't wait for WebDriverAgent forever.** `build` returns a `jobId` at once (the xcodebuild timeout goes from 3 to 10 minutes). `start` waits at most 45 s, then returns `ok` with `status:"starting"` while WebDriverAgent keeps booting.
- **Shorter waits.** `qa_job_status` `waitMs` is capped at 50000 (was 120000). `qa_wait` `timeoutMs` defaults to 45000 (was 60000, or 180000 for `device_online`) and `qa_test_this` `waitForCompletion` `timeoutMs` to 45000 (was 120000). Values above 50000 on those two and on `qa_act` are clamped with a note. Negative values, and non-integers on `qa_wait` and `qa_test_this`, return `INVALID_ARGUMENT`.
- **Missing resources.** Reading a `swipium://` URI that matches a template but names nothing that exists returns JSON-RPC `-32602` with the URI in `error.data.uri`, in every protocol era. 2.0.1 sent `-32603` (internal error). Clients should also accept the older `-32002`.

### Added

- **MCP 2026-07-28 (dual-era stdio).** Swipium answers `server/discover` for 2026-07-28 clients and `initialize` for 2025-06-18 and 2025-11-25 clients; the client's first message picks the era for the whole connection. Claude Code probes 2026-07-28 from 2.1.285 (verified on 2.1.289); Codex 0.146 stays on 2025-06-18. On a 2026-07-28 connection:
  - Consent prompts travel as an `InputRequiredResult` (the same one-checkbox form) and the answer comes back on the client's retry of the tool call. The `requestState` is a single-use server-side handle bound to the tool, its arguments and the session: a forged, reused or re-targeted one fails with `-32602` and nothing runs.
  - `tools/list` is sorted by name, and list results carry cache hints: `ttlMs: 3600000`, `cacheScope: "public"` for tools, prompts, resource templates and `server/discover`; `ttlMs: 0`, `cacheScope: "private"` for `resources/list` and `resources/read`.
  - MCP roots are never requested (roots are deprecated in that revision). The project root comes from `projectRoot`, `SWIPIUM_PROJECT_ROOT`, `CLAUDE_PROJECT_DIR` or the working directory.
- **Operator consent pre-approval** for headless clients. `SWIPIUM_CONSENT_PREAPPROVE` is a comma-separated list of exact consent action names (for example `prepare_plan,install_app`) approved without a prompt, on any client and in both protocol eras.
  - It's read only from the server process environment, never from `.swipium/` or any repository file. No wildcards; unknown names are ignored with a startup warning that suggests the closest valid name.
  - Actions that run repository- or model-chosen code (`build_from_source`, `flow_mutation_run`, `ocr_run`, `seed_state`, `start_metro`, `suite_fresh_state_replay`, `wda_build`, `wda_start`) also need `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1`. Pre-approving `test_this_plan` doesn't cover a plan with a build step unless `build_from_source` is pre-approved that way too.
  - `wda_non_loopback` can never be pre-approved; use `SWIPIUM_ALLOW_REMOTE_WDA`.
  - Approvals stay single-use and session-bound, are recorded in the mutation ledger as `operator-policy`, and each one is logged at `warn` with the action and its exact command.
- `qa_wait { for:"wda_ready" }` polls the session's WebDriverAgent `/status`, and `qa_wait { for:"simulator_booted" }` polls the session's bound iOS Simulator after a boot that returned `status:"booting"`.
- `SWIPIUM_LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`; unknown values fall back to `info`). At `debug`, one stderr line per tool call with the tool, session, duration, error code and whether it was cancelled, plus the protocol era of each connection. Argument values are never logged.
- **Codex setup.** `swipium init codex` writes an `env_vars` line covering every variable Swipium and its toolchains read, except the approval grants (`SWIPIUM_CONSENT_PREAPPROVE`, `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE`, `SWIPIUM_ALLOW_REMOTE_WDA`), plus a commented `enabled_tools` core profile that includes every tool the server instructions point to. It honours `CODEX_HOME`, detects an existing `[mcp_servers.swipium]` or `[mcp_servers."swipium"]` table, and then prints only the missing `env_vars` line.
- `qa_doctor` adds `codex-env` and `codex-tool-timeout` rows when the client is Codex (or `client:"codex"`). `codex-env` lists the Swipium variables the server can see and warns when no Android SDK or JDK is found.
- A device-driving tool called while a background job is still driving the same device gets a note that the two may interleave.

### Changed

- **MCP SDK v2.** Swipium moved from `@modelcontextprotocol/sdk` 1.x to `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.3.1, and zod is `^4.2.0` (was `^3.25`). A production install goes from 100 packages to 21, and picks up the SDK's UriTemplate ReDoS fix ([GHSA-cqwc-fm46-7fff](https://github.com/advisories/GHSA-cqwc-fm46-7fff), CVE-2026-0621; 2.0.1 allowed SDK versions below the 1.25.2 fix). For 2025-era clients the move itself is invisible: tool results are byte-identical, and so is `tools/list` apart from `qa_act`'s `for.selector`, which is now inlined instead of a `$ref`.
- Argument validation, unknown-argument rejection and stale-client mapping no longer patch private SDK internals. Swipium answers `tools/list` and `tools/call` through the public request-handler API and validates each call against one strict schema per tool.
- Successful results carry the summary headline and next steps in `structuredContent` (`summary`, `next`). Claude Code and Codex show the model `structuredContent` instead of the text block, so hints such as "call qa_report" were invisible before. `next` lists only real tool calls and is left out when the payload already has next-step fields.
- Consent declines and cancels include `action`, `answeredInMs` and `likelyAutomatic` (answered in under 1.5 s). Only when `likelyAutomatic` is true does the error name `SWIPIUM_CONSENT_PREAPPROVE` and tell the agent not to re-call in a loop; a real human decline is never nudged toward pre-approval. A prompt that failed (timeout, transport error, aborted call) reports `likelyAutomatic: false` and an `elicitationFailure` reason.
- `qa_get_artifact` defaults to metadata for every non-text artifact (recordings included, not only images), never decodes binaries as text, applies the same size caps as `resources/read`, and returns `INVALID_ARGUMENT` for an unknown URI.
- Missing, wrong-typed or out-of-range arguments return the typed `INVALID_ARGUMENT` envelope with per-field `invalidArguments` instead of a raw validation dump.
- Server instructions are 1,900 characters (were 2,518), under Claude Code's 2,048-character limit, and their first 512 characters stand alone. They recommend `waitMs: 45000`.
- `tools/list` is about 9% smaller (63.5 KB, was 69.6 KB): descriptions were trimmed, and no parameters were removed.
- `swipium init` writes a `node` path that survives a Homebrew upgrade (`/opt/homebrew/opt/<formula>/bin/node` instead of the versioned `Cellar` path).
- MCP roots requests (2025-era connections) time out after 5 s instead of 60 s.

### Fixed

- **Simulator boots no longer block a call.** `qa_ios { action:"boot" }` waits at most 40 s; a slower cold boot returns ok `status:"booting"` (`udid`, `name`, `elapsedMs`, `next`) with the simulator already bound, and the new `qa_wait { for:"simulator_booted" }` polls until it is up. `qa_prepare_ios_target` waits at most 30 s for a boot, then returns `status:"booting"` with a `jobId`: a `prepare_ios` job finishes boot, install, launch and the WDA check under the consent already given. `qa_test_feature` (execute without `sessionId`) now boots, installs and launches inside its job, so the call returns at once.
- A Metro bundler started through `npx` is now reaped after a server crash. Under load, Swipium could record it during the brief moment `npx` titles itself a bare `npm`, so the startup sweep could never verify it and left it holding port 8081.
- Cancelling a call now stops its work. `qa_wait`, the `qa_job_status` long-poll, element waits in `qa_act` and flows, UI settling, emulator boot and appear waits, WebDriverAgent startup and UI dump retries used to keep running until their deadline.
- Cancelled smoke runs and mobile audits are no longer recorded as failures, findings or issues, and a cancelled mobile audit restores the device network instead of leaving it offline.
- The server exits when the client closes stdin, even during a long call. Before, it lingered until the call finished. On shutdown, running jobs are cancelled before device network state is restored.
- `resources/read` caps what it returns: text over 1 MB comes back as the head (the tail for logs) with a marker naming the local file, binaries over 8 MB are not inlined, non-text files are returned as blobs instead of being decoded as text, and a cut never splits a UTF-8 character.
- Errors no longer echo unbounded caller input. A multi-MB argument (or argument name) used to produce an error larger than a client's read buffer, and the client dropped the connection. Names and paths are cut at 100 characters, and long messages keep both their start and their end, where the deciding line of a command failure usually is.

## 2.0.1 - 2026-09-30

A small maintenance release. No behavior changes for agents or flows.

### Fixed

- SARIF exports (`qa_report format:"sarif"`) link the tool to the real repository, `https://github.com/GeroPalombo/swipium`. The old link pointed at a GitHub account that doesn't exist, which code-scanning pages show to users.

### Changed

- Test fixtures no longer contain paths from a developer's machine.

## 2.0.0 - 2026-09-30

Swipium 2.0.0 fixes the typing, gesture, and secret-handling defects in the core test loop, makes iOS Simulator sessions and background jobs more reliable, adds CI report exports and one visual tool, and narrows the public surface from 60 to 55 tools (6 removed, `qa_visual` added). **It removes and renames public tools and tightens several defaults.** Work through the upgrade checklist before upgrading.

### Upgrade checklist

Items tagged **You** need an action from you. Items tagged **Automatic** happen on their own and are listed so they don't surprise you.

1. **You:** restart your MCP client (or reload its server list) after upgrading. A client still holding the 1.5.x tool list gets `STALE_CLIENT` errors that name the replacement call.
2. **You:** rename the environment variables your flows and `.swipium/fixtures.json` read through `${VAR}` so they start with `SWIPIUM_`. Other names no longer resolve from the server environment. See [README.md](README.md#configuration--environment-variables).
3. **You:** in CI, install the app yourself (for example `adb install -r -g app.apk`) before the agent step. Every Swipium install now asks for consent, and nobody can approve it in CI. [docs/ci-reports.md](docs/ci-reports.md#github-actions-recipe-android) has a complete recipe.
4. **You:** replace calls to removed tools using the [migration table](#migrating-from-150), and remove arguments a tool does not declare. They are now rejected with `INVALID_ARGUMENT` instead of being ignored.
5. **You:** if you use a remote (non-loopback) WebDriverAgent, `ios.wda.allowNonLoopbackUrls` in `.swipium/config.json` no longer pre-approves it. Pass `allowNonLoopback: true` and approve the consent prompt, or set `SWIPIUM_ALLOW_REMOTE_WDA` to the exact URL in the MCP server environment.
6. **You:** scripts that call `swipium <word>` with a word that is not a subcommand now exit with status `2` instead of starting a server. Use `swipium` or `swipium serve`.
7. **You:** stop any Metro bundler or WebDriverAgent that a 1.5.x server started and left running. 2.0 only cleans up processes it recorded with a start-time and command fingerprint, and 1.5.x recorded none.
8. **Automatic:** when a call has no `projectRoot`, no MCP roots, and no `SWIPIUM_PROJECT_ROOT` or `CLAUDE_PROJECT_DIR`, the server's working directory becomes the project root if it contains a project marker (see Breaking changes).
9. **Automatic:** old session folders under `~/.swipium/runs` are pruned (see Added). Set `SWIPIUM_RETENTION_DAYS=off` to keep them.

### Breaking changes

- **Removed and renamed tools.** See the migration table below (also at the end of `docs/tools.md`). A client still running a pre-upgrade server, or a saved prompt that calls a removed tool, gets a typed `STALE_CLIENT` error that names the replacement.
- **Environment variables in flows and fixtures.** Flows and `.swipium/fixtures.json` resolve `${VAR}` from the server environment only for names starting with `SWIPIUM_`. Explicit `variables` and inputs stored in the session still work. Generated flows and suites use `SWIPIUM_TEST_*` for stored inputs and `SWIPIUM_SECRET_N` for other secrets. `swipium init flows` templates use `SWIPIUM_TEST_EMAIL`, `SWIPIUM_TEST_PASSWORD` and `SWIPIUM_TEST_DEEP_LINK` (was `TEST_DEEP_LINK`). Rename any other variables your flows read from the environment.
- **Every app install asks for consent**, including an APK inside the project (Android now matches iOS). Only an app already installed on a running emulator skips the prompt.
- **Unknown tool arguments are rejected** with `INVALID_ARGUMENT`, which lists the accepted parameters, and nothing runs. They used to be ignored silently, so a call such as `qa_app_control {appId:"other.app"}` ran against the session's app.
- **Remote WebDriverAgent.** A repository config can no longer pre-approve a non-loopback WDA: `ios.wda.allowNonLoopbackUrls` is ignored as an approval. Use `allowNonLoopback: true` with consent, or the user-level `SWIPIUM_ALLOW_REMOTE_WDA`.
- **Project root from the server's working directory.** 1.5.0 never used the working directory: without `projectRoot` or MCP roots it asked for a path. 2.0 falls back to `SWIPIUM_PROJECT_ROOT`, then `CLAUDE_PROJECT_DIR`, then the working directory when it is not `/` or `$HOME` and contains a project marker. A server launched inside an app directory now works in that directory without asking. The result's `rootSource` says which one was used.
- **Physical devices.** A single USB phone is no longer bound automatically, and `preferRealDevice: true` or an iOS build that installs only on real hardware returns `PHYSICAL_DEVICE_UNSUPPORTED` (was `BACKEND_UNSUPPORTED`). `qa_resolve_target` no longer plans a real device. See [docs/physical-devices.md](docs/physical-devices.md).
- **Consent risk of source builds.** `build_from_source` is `high` risk (was `medium`), and `start_metro` is `medium` (was `low`). Prompts and the mutation ledger show the new level, and an executed high-risk build lowers the report's readiness score.
- **CLI:** an unknown subcommand prints usage and exits `2` instead of starting the server. Unknown `--flags` (such as `--stdio`) still start the server, with a warning.

### Migrating from 1.5.0

| 1.5.0 call | Now |
| --- | --- |
| `qa_agent_brief`, `qa_capabilities` | Server `instructions` (sent at connect), or `qa_status` without `sessionId` |
| `qa_next_best_action {sessionId, goal}` | `qa_status {sessionId, goal}` (always returns `nextBestAction`) |
| `qa_detect_context` | `qa_resolve_target {include:["context"]}` |
| `qa_plan {sessionId}` | `qa_resolve_target {sessionId, include:["plan"]}` |
| `qa_assert_visual` | `qa_visual {mode:"assert", assertion, pass}` |
| `qa_ios action:"wda_status"` / `"wda_attach"` | `qa_wda action:"status"` / `"attach"` |
| `qa_ios action:"screenshot"` | `qa_screenshot` |
| `qa_wait {for:"job_done"}` | `qa_job_status {jobId, waitMs}` |
| `qa_wda {udid}` | `qa_wda {device}` (`udid` still accepted) |
| `qa_suite_generate {creativityLevel}` | `qa_suite_generate {creativity}` (`creativityLevel` still accepted) |
| `qa_mobile_audit {waitForCompletion}` | removed; passing it returns `INVALID_ARGUMENT` |

### Added

- `qa_visual`: one screenshot-based tool with `mode:"assert"|"baseline"|"diff"|"find_text"|"find_image"`. Because it needs only screenshots, it also works on an iOS Simulator without WebDriverAgent, where `qa_snapshot` and `qa_act` are unavailable. `find_text` and `find_image` return tappable device coordinates (points on iOS) and can tap them (`tap:true`, through `idb` on a simulator without WebDriverAgent). Those taps are recorded and budgeted like `qa_act` taps. `find_text` is consent-gated and needs a local OCR command (`SWIPIUM_OCR_CMD` or `ocrCommand` in `.swipium/config.json`). Without one it returns `OCR_NOT_CONFIGURED` with the provider contract and a tesseract example.
- `qa_issue_log` lifecycle: `mode:"history"` (default, the 1.5.0 behavior), `"log"`, `"mark_fixed"` (`fixedInCommit`, `fixedInVersion`, `howFixed`), `"verify_fixed"` (`evidenceUris`), `"suppress"` (`suppressionScope`, a `suppressedUntil` expiry, and `unsuppress:true`), and `"metrics"` (`groupBy`). A manually logged issue is identified by its title, category and platform, and a title with no identifying words returns `ISSUE_LOG_TOO_VAGUE`. Lifecycle errors are typed: `ISSUE_NOT_FOUND`, `ISSUE_STATE_INVALID`, `ISSUE_EVIDENCE_REQUIRED`. An issue marked fixed and seen again is classified as a regression.
- CI exports: `qa_report format:"junit"|"sarif"|"github-summary"`, and a `swipium report` CLI (`--latest --format … --out … --fail-on-gate`) that renders the last saved report and exits `1` when the `.swipium/policy.json` release gate blocks. SARIF results point at real repository files so GitHub code scanning shows them. `docs/ci-reports.md` has a complete GitHub Actions recipe (Android emulator, headless Claude Code, report, SARIF upload, JUnit).
- `qa_act observe:"diff"|"full"|"none"`, and `warnings[]` in `qa_act` results.
- `qa_job_status waitMs` long-polls until the job leaves `running` (up to 120 s). `qa_status` accepts `goal` to bias `nextBestAction`.
- `qa_test_this`: `responseMode`, and a compact report summary in the terminal result.
- `qa_explain_blocker` accepts `sessionId`, so `qa_status` moves past the blocker it explained.
- `qa_app_control` results carry `changedState`, which is `false` when the call failed before changing anything.
- MCP tool annotations on every tool. Read-only tools carry `readOnlyHint: true` and `openWorldHint: false`; every other tool also sets `destructiveHint` and `idempotentHint`. Clients can use them to auto-approve read-only calls. The server also sends `instructions` with the operating guide.
- MCP resource listing for session artifacts and app-map sections, scoped to the current project and excluding sensitive-mode sessions.
- Consent through MCP elicitation: on clients that support it, privileged actions are approved in a real user prompt. A declined prompt returns `CONSENT_DECLINED`, and the mutation ledger records how each action was approved (`elicitation`, `client-assertion`, or `policy`). `SWIPIUM_REQUIRE_ELICITATION=1` refuses every consent-gated action on clients without elicitation (`CONSENT_REFUSED`).
- CLI: `swipium --help`, `--version`, `swipium serve`, `swipium init cursor`, `swipium init vscode`, and `init --cwd <dir>`.
- Disk retention: when the session registry is first loaded, Swipium prunes, in the background, `~/.swipium/runs` session folders older than 30 days that are not in the session registry and are not among the newest 20 of their project. `SWIPIUM_RETENTION_DAYS=0|off` disables the prune, and `SWIPIUM_RETENTION_KEEP` sets how many recent sessions per project are kept. If `~/.swipium/registry.json` cannot be read, nothing is deleted. `swipium gc [--dry-run] [--days N] [--keep N]` reclaims space on demand, and `~/.swipium/projects.json` drops entries for deleted projects.
- `qa_device_info` on iOS Simulators returns name, runtime, state, and screen size. `qa_resolve_target include:["context"]` lists booted and available iOS Simulators.
- `qa_wda build` and `start` find an Appium-installed WebDriverAgent project (under `$APPIUM_HOME`, `~/.appium`, or the global npm roots) when `wdaProjectPath` is not given.

### Changed

- Project root resolution: explicit `projectRoot` > MCP roots > `SWIPIUM_PROJECT_ROOT` > `CLAUDE_PROJECT_DIR` > the server's working directory, which is used only when it is not `/` or `$HOME` and contains a project marker (`package.json`, `app.json`, `pubspec.yaml`, Gradle or Xcode files, `Podfile`, `android/`, `ios/`). Results report where the root came from (`rootSource`). An unresolved root fails with `PROJECT_ROOT_UNRESOLVED`. `qa_flow_check` and `qa_flow_run mode:"plan"` resolve the root the same way. See [docs/concepts.md](docs/concepts.md#project-root).
- **`qa_status`** without `sessionId` returns first-call orientation instead of an error. With a session, it follows the last job: after a finished run it recommends that run's next action (read the report, explain the blocker, answer the question) instead of `qa_smoke` again, and it stops repeating advice that was already followed.
- **`qa_test_this`:**
  - It never installs on a physical phone. With a phone connected it waits for the emulator it planned to boot; when a phone is the only option it returns `PHYSICAL_DEVICE_UNSUPPORTED`.
  - `needs_input` is a terminal job state. A credentials question found during a run is returned instead of dropped.
  - On iOS without WebDriverAgent it no longer blocks by default. It skips suite generation and exploration and runs a visual-only smoke. It still blocks when you explicitly ask for work that needs WebDriverAgent.
- **Response format in normal mode:** the JSON block in the text channel is compact and omits keys the text above it already shows; `renderedAbove` lists the omitted keys (a 32-element `qa_snapshot` is under half its 1.5.0 size). `responseMode: "verbose"` restores every key, and `structuredContent` always carries the full payload. `qa_act` returns only the elements that changed once a snapshot exists (`observe:"diff"`), and falls back to the full list when most of the screen changed.
- Consent challenges (`consentId`) expire after 30 minutes, and at most 200 are pending at once. See [docs/concepts.md](docs/concepts.md#consent).
- An unknown `sessionId` returns `INVALID_ARGUMENT`.
- `qa_prepare_target` with several devices online and no `device` returns `MULTIPLE_DEVICES`.
- `qa_network` on an iOS Simulator returns `BACKEND_UNSUPPORTED` (airplane-mode control is Android-only). A toggle that fails on the device leaves no restore record behind.
- Flow and fixture variables whose names contain `code` (such as `SWIPIUM_VERIFICATION_CODE`) are treated as secrets, like names containing `pass`, `secret`, `token`, `otp`, `pin`, `cvv` or `key`.
- `swipium init` writes a portable `npx -y swipium` command for project-scoped registrations (shared `.mcp.json`, Gemini project settings, Cursor, VS Code). Absolute paths are used only for user or local scope. Codex registrations include `startup_timeout_sec = 30` and `tool_timeout_sec = 600`.
- `adb` and `emulator` are found through `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the OS default SDK location when they are not on `PATH` (useful for GUI-launched clients). See [docs/mcp-server.md](docs/mcp-server.md#requirements).
- `qa_doctor` checks both platforms by default on macOS, and checks the Node version against `engines`.
- `qa_mobile_audit` `resilience` and `release_gate` profiles ask for network-change consent before toggling airplane mode, and restore its original state afterwards.
- `qa_continue_from_blocker` returns `ignored[]` for answers the resumed tool cannot use, and replays the goal and flags of the interrupted `qa_test_this` call.
- `qa_flow_repair` proposes elements of the same kind ranked by text similarity and refuses to apply low-confidence repairs. A failed `qa_flow_run` points to it.
- `qa_report` merges identical findings into one with a count, and reports `DEGRADED` tool status when tools failed during the run. Cancelled calls, unknown sessions, invalid app IDs, and deliberate refusals do not count as tool errors.
- `qa_generate` returns `NO_RECORDED_ACTIONS` for every target when the session has recorded no actions.
- Errors that returned `UNKNOWN` now carry typed codes (`INVALID_ARGUMENT`, `FLOW_NOT_FOUND`, `KEYBOARD_NOT_DISMISSIBLE`, `CAPTURE_WITHHELD_SECURE`, `SENSITIVE_MODE_REFUSED`, `NO_DEVICE`, `CANCELLED`).
- Fewer device round trips per action: adaptive settle interval, bounded screen-dump timeouts, a cheaper foreground and health check, longer-lived screen-size caches, and one keyboard lookup per action.

### Fixed

**Android**

- Typing escapes every shell metacharacter (including `{ } [ ]`), types a literal `%s` correctly, and treats empty text as a no-op. Characters `adb input text` cannot deliver fail with `TEXT_INPUT_UNSUPPORTED`, and replace-mode typing refuses them before clearing the field.
- Deep links and launch extras containing `&`, spaces, or `;` reach the app intact.
- An emulator that is still booting is no longer bound automatically (`DEVICE_NOT_READY`). Network-attached emulators (such as `localhost:5555`) are accepted. A missing `adb` returns `ADB_NOT_FOUND`.
- Snapshots skip rows Android reports as scrolled off the list or that lie off-screen, so `scroll untilVisible` no longer reports an off-screen row as found and taps no longer land on the list edge.
- Apps whose package name contains `debug` or `alert` no longer show false banner or snackbar overlays.

**Gestures and actions (both platforms)**

- Swipe and scroll geometry comes from the live screen size, accounts for rotation, and keeps clear of screen edges. The old fixed 1080×2400 coordinates were off-screen on iOS.
- Scrolls start inside the scrollable list rather than the screen center, a plain `scroll` performs one swipe, and `changed` also reflects content that moved. `scroll untilVisible` checks before the first swipe and reports `endOfList` only when the list stopped moving.
- Tapping a control hidden under the soft keyboard no longer types into the field. When the keyboard covers the target, Swipium hides the keyboard, finds the target again, and returns `KEYBOARD_OBSTRUCTION` if it is still covered. When the keyboard area is unknown, it taps and returns a warning.
- Tapping a switch or checkbox is detected as a change instead of being retried and toggled back.
- Navigation bars, list rows, and text fields are no longer reported as banner or snackbar overlays. A password field's show/hide button keeps its label in snapshots; only secure values are masked.
- Flow `clearOverlay` no longer presses BACK on a plain screen (which could leave the app). It dismisses dialogs, sheets, and dev overlays (iOS alerts through the alert API) and reports when there was nothing to clear.

**iOS**

- A resumed iOS session is rebound to its own simulator (through WebDriverAgent when it was attached), never to another device, and reuses the running app instead of relaunching it.
- A managed WebDriverAgent started by a previous server run is adopted at startup when it is healthy and less than 12 hours old, so a resumed session keeps structured automation. It is recognized even though Xcode's `xcodebuild` shim re-executes under its full path, and `qa_wda stop` can stop it, including when its registry entry was lost.
- Recovery from an expired WebDriverAgent session no longer relaunches or terminates the app, every WebDriverAgent call has a request timeout, and a brief outage while resuming no longer downgrades the session permanently.
- A session that fell back to visual-only on one slow screen returns to structured mode once screen dumps work again. `qa_status` reports a simulator session without WebDriverAgent as `visual-only`.
- `qa_ios launch` and `terminate` work while WebDriverAgent is attached. `qa_app_control background` waits for the home screen and reports the real foreground app, or `unknown` when WebDriverAgent cannot tell.
- `press key:"back"` taps the navigation bar's back button or swipes from the left edge. It reuses the last settled screen dump only for 3 s, and never after the screen changed, so it does not press a back button that is no longer there.
- Snapshots include accessibility identifiers and search and text fields, so typed values can be read back. Keyboard detection works through WebDriverAgent.
- After `qa_ios boot`, next steps point at iOS tools, and target plans count simulators.

**Sessions and jobs**

- Cancelling one call no longer cancels another: each tool call and background job carries its own cancel signal. Cancelled calls and jobs return `CANCELLED` and are never recorded as tool errors or findings.
- App-map and session state writes are atomic and locked. A stale lock is taken over safely (the lock can no longer spin forever and block startup), long app-map scans run outside the lock, and a corrupt `app-map.json` is restored from history.
- Fixtures are reloaded from `.swipium/fixtures.json` on resume instead of being replayed as `«redacted»` after a restart.
- Monorepos: answering the "which app?" question selects that app instead of being treated as a device ID, and the question is not asked again.
- An orphaned Metro started through `npx` is cleaned up after a crash, including on Linux when it was recorded while its `#!/usr/bin/env node` launcher was still starting. A child process that exits before reading its stdin can no longer crash the server.

**Generation**

- Generated Appium suites perform real scroll and swipe gestures, and a scroll recorded without a target replays in the right direction. Steps that cannot be generated fail with `UNEMITTABLE_STEP` instead of producing no-op code.
- Generated JavaScript suites contain no TypeScript-only syntax, and JavaScript and Python suites compile when element labels are keywords, start with digits, or contain quotes or backslashes. The Python generator passes its own validation.
- Generated suites default to the session's platform (iOS sessions get XCUITest), and `qa_visual mode:"assert"` steps become marked manual checks.
- Common-word passwords ("test", "password") no longer rewrite selectors or block generation on template text.
- Suite files from `qa_test_this generateSuite:true` are fetchable `swipium://` artifacts.

**Reports and issues**

- JUnit exports are always well-formed XML, and failures the release-gate policy ignores are reported as skipped. GitHub step summaries stay below GitHub's 1 MiB limit.
- The issue ledger is locked across processes, and issues recorded by 1.5.x keep their identity.
- The documented tesseract OCR setup works: the provider runs from the project root, a crashing provider returns `OCR_PROVIDER_FAILED`, and screenshots are written where macOS tesseract can read them.

**CLI**

- `swipium scan` writes nothing when it cannot identify a project, and the docs and CLI no longer mention the nonexistent `swipium plan` and `swipium ci` commands.

### Security

- A consent prompt the user dismisses or leaves unanswered is a refusal (`CONSENT_CANCELLED`); the agent cannot approve that action itself, and an open prompt cannot be bypassed with `approve:true`. Consent prompts strip control characters and are bound to the session that requested them.
- A cloned repository is treated as untrusted input. Flows and `.swipium/fixtures.json` cannot read server environment variables outside `SWIPIUM_*`, and values read from the environment are treated as secrets. An `openUrl` containing a variable is consent-gated. Consent shows the exact commands of flow seed steps and of repository-configured OCR and mask commands, labelled as unreviewed. A repository config can no longer pre-approve a non-loopback WebDriverAgent (the user can set `SWIPIUM_ALLOW_REMOTE_WDA` to allow specific URLs).
- Secrets never appear in error messages: a failed `adb input text` no longer echoes the typed value, and `qa_act` and flow errors are redacted.
- Values typed into secure fields (passwords, PINs, OTPs, CVVs) are redacted regardless of length with whole-token matching. JSON and XML artifacts are redacted structurally so they stay valid. Secrets shorter than 3 characters are reported as not redacted instead of blanking unrelated text, and a session resumed after a restart is flagged `redactionDegraded` in `qa_report`.
- Report exports (JUnit, SARIF, GitHub summary, Markdown, JSON) are redacted field by field before rendering, so escaping cannot defeat redaction.
- A value typed through a native selector into a secure field, or a registered secret typed into an ordinary field, is recorded as a secret (generated flows use `${SWIPIUM_TEST_PASSWORD}` instead of the plaintext), and every generator checks its output against the session's secrets: generation fails with `SECRET_IN_GENERATED_OUTPUT` and writes nothing rather than emit one. `state.json`, `test-suite.json`, and test cases no longer store secret values.
- `qa_visual` baseline names and template paths are confined to the project (`VISUAL_PATH_REFUSED`), and artifact names cannot escape the session directory. On screens Swipium cannot inspect, OCR results that look like credentials are withheld.
- Orphan-process cleanup only signals a process whose recorded start time and command still match, so a reused process ID can no longer be killed.
- App IDs are validated and quoted for the device shell. Sensitive mode suppresses screenshots in flows and smoke runs. `qa_issue_log` redacts session secrets before writing the ledger. Session folders and files are private (`0700` / `0600`), and OCR temp files live in private per-call directories.
- `THREAT_MODEL.md` documents the limits of the re-call consent convention and the stronger elicitation path.
- GitHub Actions in this repository's workflows are pinned to commit SHAs. Production dependencies are updated for advisories in transitive MCP SDK dependencies (`fast-uri`, `hono`, `@hono/node-server`, `body-parser`).

### Known issues

- The first time an iOS session from a pre-2.0 WebDriverAgent run is rebound after upgrading, the app may be relaunched once.
- Stale-client hints (`STALE_CLIENT` for removed tools) depend on an internal of the MCP SDK. If a future SDK changes it, Swipium logs a warning and those calls get the SDK's plain "tool not found" error instead. (Resolved in 2.2.0: stale-client mapping runs in Swipium's own `tools/call` handler through the public SDK API.)
- Fixtures passed inline to `qa_start_session` come back without their values after a server restart. Fixtures in `.swipium/fixtures.json` are reloaded.
- On slow emulators a tap that navigates to a new screen can take several seconds, most of it spent on screen dumps.

### Removed

- The tools listed in the migration table.
- Unregistered pre-1.5.0 tool modules that still shipped in `dist/`. `qa_seed`, `qa_permissions`, `qa_screen_info`, and `qa_locator_suggest` moved to `src/tools/deferred/`, which is excluded from the build and the npm package.

## 1.5.0 - 2026-07-03

Swipium 1.5.0 is the production consolidation release. It narrows the MCP surface from 95 to 60 public tools, keeps the main simulator QA workflows, and moves lower-level/internal helpers out of the public contract so agents have fewer overlapping choices.

### Highlights

- `qa_generate` is now the single generator for flow YAML, page objects, per-run suites, test-case docs, and Appium code.
- `qa_first_run` replaces the first-run plan/continue split with `mode:"plan"` and `mode:"continue"`.
- Planning/execution patterns are standardized: `qa_build` uses `mode:"plan"|"run"` (default `plan`), and `qa_flow_run` uses `mode:"plan"|"run"` (default `run`).
- Durable suite tools now use the shorter `qa_suite_*` names, and generated POM suites compile through `qa_flow_compile`.
- `qa_app_map_feature_scope`, `qa_test_feature`, `qa_mobile_audit`, `qa_report`, and the suite/reporting tools remain the supported public paths for feature, audit, evidence, and release-gate workflows.

### Compatibility Notes

- Public tool count is now 60. Tools removed from public registration were merged into canonical tools or deferred from the public v1 surface.
- Main migrations: generation tools move to `qa_generate target:"flow"|"pom"|"suite"|"testcases"|"appium"`; `qa_feature_scope` moves to `qa_app_map_feature_scope`; `qa_feature_test_plan` moves to `qa_test_feature mode:"plan"`; first-run twins move to `qa_first_run`; build/flow plan twins move to `qa_build mode:"plan"` and `qa_flow_run mode:"plan"`.
- `qa_build` without `mode` now returns a build plan. Use `qa_build mode:"run"` to start the consent-gated build job.
- `qa_act` now requires structured selector objects instead of free-form selector strings.
- Timing fields are normalized to milliseconds (`*Ms`), and snapshot/action element lists are capped with an `elementsOmitted` count plus filtering support.

### Reliability and Release Readiness

- Added hermetic coverage for the core happy path, `qa_doctor`, docs/version consistency, and every public tool's structured error envelope.
- Every `qaError` now includes a `failureCode`, with `UNKNOWN` as the fallback.
- Release checks now run typecheck, lint, format check, tests, production audit, clean build, and pack dry-run.
- `npm run build` cleans `dist/` before compiling so stale removed tools cannot ship.
- File-lock timeouts now fail instead of falling back to unlocked writes.
- Added the published threat model documenting local trust boundaries, consent gates, and secret redaction.

## 1.4.0 - 2026-06-04

This release expands the public tool surface from 91 to 95 tools, completing the simulator-local agent and app-map helpers. It is a minor release: the additions are backward compatible, existing tools and input schemas are unchanged, and clients on 1.3.0 keep working and gain the new tools after a restart. Scope stays simulator-local with no external service integrations, real-device execution, or remote AI.

### Added

- `qa_inspect` returns the full attributes (class, resource-id, content-desc, text, bounds, flags) of a single `@eN` element from the latest snapshot, with secret redaction and secure-field masking.
- `qa_next_best_action` returns a deterministic recommendation of the single best next tool to call (with args) and why, optionally biased by a goal.
- `qa_app_map_update` applies targeted, provenance-tracked updates to the app map (note, test cases, automation suite, environment, feature coverage) without a full rebuild.
- `qa_app_map_diff` compares two app-map snapshots and reports screen, coverage, locator-readiness, and stale-test changes plus new untested code areas.

### Changed

- `qa_capabilities` lists the new app-map, drive, and start tools.

## 1.3.0 - 2026-06-03

This release expands the public tool surface from 83 to 91 tools, adding feature-focused testing and local build/artifact resolution. It is a minor release: the additions are backward compatible, existing tools and input schemas are unchanged, and clients on 1.2.0 keep working and gain the new tools after a restart. Scope stays simulator-local with no external service integrations, real-device execution, or remote AI.

### Added

- Feature-focused testing backed by the app knowledge map: `qa_feature_scope` maps a natural-language feature to code, screens, routes, runtime, and tests; `qa_feature_test_plan` produces a full test plan with generated cases, fixtures, and automation readiness; `qa_test_feature` runs a focused test toward a named feature and updates the map and report.
- Local build and artifact resolution: `qa_resolve_target` picks the best device or simulator, `qa_resolve_artifact` finds the best installable artifact, `qa_build_plan` proposes exact build commands, `qa_build` builds from source as a consent-gated job, and `qa_bundletool` converts an `.aab` to an installable APK.

### Changed

- `qa_capabilities` adds build and feature groups and lists the new tools.

## 1.2.0 - 2026-06-02

This release expands the public tool surface from 59 to 83 tools, advancing the roadmap's repeatable-flow, failure-taxonomy, and reporting phases plus durable QA memory. It is a minor release: the additions are backward compatible, existing tools and input schemas are unchanged, and clients on 1.1.0 keep working and gain the new tools after a restart. Scope stays simulator-local with no external service integrations, real-device execution, or remote AI.

### Added

- Durable issue memory: `qa_issue_log`, `qa_issue_history`, `qa_issue_mark_fixed`, `qa_issue_triage`, `qa_issue_suppress`, `qa_issue_verify_fixed`, and `qa_issue_metrics` over a per-project ledger (`.swipium/issues-log.jsonl`). Fingerprints let later runs detect regressions of previously fixed issues; suppressed noise stays visible as known-noise rather than hidden.
- Executable mobile-QA audit: `qa_mobile_audit` plans or runs named profiles (smoke, account_cycle, store_compliance, resilience, release_gate); execution records issues and evidence.
- Persistent test suite: `qa_test_suite_read`, `qa_test_suite_update`, `qa_test_suite_generate`, `qa_test_suite_export`, and `qa_test_suite_lint` maintain a canonical suite that grows across runs.
- Flow system and suite quality: `qa_flow_plan` (feasibility against backend capabilities), `qa_flow_repair` (stronger locator for a failed step), `qa_suite_lint`, and `qa_pom_generate`.
- Maestro interop: `qa_maestro_import` and `qa_maestro_export` exchange flows with Maestro YAML, with portability grades on export.
- Agent-efficiency helpers: `qa_locator_suggest`, `qa_input_capabilities`, `qa_wait`, `qa_idling_status`, and `qa_job_cancel`.

### Changed

- `qa_capabilities` adds test-suite, interop, and issues groups, and lists the new flow, suite, and agent-efficiency tools.

## 1.1.0 - 2026-06-01

This release expands the public tool surface from 42 to 59 tools, advancing the roadmap's device-parity, visual-intelligence, seeded-state, and reporting phases. It is a minor release: the additions are backward compatible, existing tools and input schemas are unchanged, and clients on 1.0.1 keep working and gain the new tools after a restart.

### Added

- Device and app environment parity tools so common setup no longer needs raw `adb` or `simctl`: `qa_device_info`, `qa_permissions`, `qa_orientation`, `qa_geolocation`, `qa_network`, `qa_metro`, `qa_app_control`, `qa_screen_info`, and `qa_screen_record`. Mutating actions are consent-gated and recorded as environment changes; network changes are auto-restored at report end.
- Local-first visual intelligence: `qa_visual` for baseline capture, regression diff, image-target matching with tappable coordinates, and optional OCR; `qa_visual_find_text` for OCR text location with coordinate-space conversion.
- Seeded state so a blocked precondition can be created and verified instead of only reported: `qa_seed`, `qa_state_prepare`, `qa_state_verify`, and `qa_state_teardown`. All mutating actions are consent-gated.
- Report history tools: `qa_report_compare` to diff a run against a baseline report, and `qa_run_history` for pass rate, failures, flaky flows, and confidence calibration across local runs.
- New MCP prompt `swipium_guardrail_validation` that drives a non-destructive check confirming Swipium refuses bundle-loss actions on debug RN/Expo builds.

### Fixed

- Fixed default iOS text entry so replace-mode typing clears focused fields with current WebDriverAgent attributes and falls back to keyboard deletion when needed.
- Fixed `qa_test_this` build handling so successful Expo iOS builds are not reported as app build failures when artifact resolution needs follow-up.
- Fixed `qa_prepare_ios_target` so structured iOS mode is reported only after a WebDriverAgent session is created and attached to the run.
- Fixed report verdicts so Swipium tool limitations do not block the app status; they are reported under coverage and tool status.
- `qa_metro` stop now signals the entire detached process group, so the Metro bundler holding port 8081 is terminated rather than only its `npx` launcher, and it only signals a PID still confirmed to belong to a Metro/Node process. Any Swipium-started Metro is also stopped on server shutdown so a budget stop or crash does not leave a bundler running.
- `qa_screen_record` status now reports an Android time-limit recording that has stopped on its own as auto-stopped instead of implying it is still capturing, while retaining the entry so the video can still be saved.

### Changed

- Added exploration diagnostics for visible action-like text that is not exposed as clickable or editable.
- Improved app-map queries by indexing visible copy from source files.
- Improved generated POM suites by segmenting recorded actions by screen identity.

## 1.0.1 - 2026-06-01

### Fixed

- Updated iOS WDA point taps to use the current `/wda/tap` route with legacy fallback.
- Added focused typing fallback through `/wda/keys` for iOS WDA sessions.
- Made overlay clearing tolerate unsupported driver probes and use native WDA alert actions.

### Changed

- Added platform-specific `qa_doctor` readiness for Android Emulator and iOS Simulator.
- Clarified Expo Android local run planning for `npx expo run:android --variant debug`.
- Split report output into app status and coverage status.

## 1.0.0 - 2026-05-31

### Added

- Initial public release of Swipium.
- Limited v1 MCP tool surface focused on Android Emulator and iOS Simulator workflows.
- Core mobile QA flow: prepare a simulator target, observe the app, act on the UI, run smoke checks, capture evidence, and generate reports.
- Durable app knowledge map for storing tested screens, flows, findings, and generated test assets.
- Flow and test-suite generation from recorded or explored behavior.
- Consent gates for mutating actions and sensitive automation steps.
- Secret redaction in reports, artifacts, and generated automation.

### Security

- Latest-version-only security support.
- Production dependency audit included in the release check.
- Public security contact: hi@swipium.com.

### Not In Scope For v1

- Real-device certification.
- Jira or external tracker integration.
- Broad public support for every internal or experimental tool.
