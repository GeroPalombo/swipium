# Swipium Threat Model

Last updated: 2026-09-28 (Swipium 2.0.0)

This document describes Swipium's trust boundaries, the threats it defends against, and the controls that enforce those defenses. It follows the MCP security guidance: validate inputs, use least privilege, obtain explicit consent for sensitive operations, protect secrets, and do not over-trust tool metadata.

## What Swipium Is

Swipium is a local stdio MCP server that lets an AI agent run mobile QA against an Android Emulator or iOS Simulator on the developer's own machine. It is not a remote service. It has no network listener, no authentication surface, and no multi-tenant state.

## Trust Boundaries

1. MCP client to Swipium: the client (Claude, Gemini, Codex, or another MCP host) sends tool calls over stdio. Swipium trusts the transport but not the semantic intent: destructive actions require explicit, server-side consent regardless of what the client requests.
2. Swipium to local toolchain: Swipium shells out to `adb`, `emulator`, `xcrun`/`simctl`, Gradle, and Metro. These run with the developer's own privileges. Swipium does not escalate privileges.
3. Swipium to the project: Swipium reads and writes within the resolved project root and `.swipium/`. It does not write outside the project root without explicit approval.
4. App under test to Swipium: screenshots, UI dumps, and logs from the app can contain sensitive data. Swipium treats this data as untrusted and redacts known secret shapes before surfacing it.

## Assets

- Developer machine integrity and the local toolchain.
- The project source tree and `.swipium/` state (config, app map, flows, issue ledger, run history).
- Secrets the agent handles during testing (credentials, OTPs, tokens).
- App data on the emulator/simulator.

## Adversaries and Threats

- Malicious or compromised MCP client / prompt injection: a client (or a poisoned tool description in another server) tries to trigger a destructive or exfiltrating action. Mitigation: server-side consent state machine for all destructive/privileged actions. Each consent is a server-issued, single-use challenge bound to the exact action and affected scope, and the exact command and effect are shown before execution — so a destructive call always requires an explicit, auditable second call that names precisely what will run. Honest limitation: the second call is made by the client, so a fully compromised or prompt-injected client can self-approve without a human in the loop; the residual control against that adversary is the human reading the transcript (the consent prompt and the approving call are both visible) and the mutation ledger, which records how each privileged action was approved. On clients that support MCP elicitation, consent is additionally routed through a real out-of-band user prompt before the model ever sees a consent envelope. On those clients only an explicit accept approves: a decline (`CONSENT_DECLINED`), a dismissed prompt (MCP `cancel`), a prompt left unanswered for 10 minutes, an aborted tool call, or a transport error while the prompt is open (`CONSENT_CANCELLED`, retry-safe — a re-call shows a fresh prompt) is a refusal. The challenge is burned, a `refused` row is written to the mutation ledger, and a later `approve:true` re-call cannot revive it. The model-mediated re-call is used only when the client does not advertise elicitation. Setting `SWIPIUM_REQUIRE_ELICITATION=1` removes that fallback for every consent-gated action (builds from source, Metro, installs, bundletool, data wipes, seeds and state profiles, recordings, network changes), not only high-risk ones: without elicitation they fail with `CONSENT_REFUSED`. Pending challenges expire after 30 minutes, are capped in number, and are bound to the session that minted them (a challenge issued in session A cannot approve a call in session B). The elicitation prompt quotes repository-derived strings and strips control characters/newlines from them, so a flow name or URL cannot forge extra prompt lines. Tool descriptions are linted (`test/toolMetadata.test.ts`) to stay honest and non-manipulative.
- Untrusted app content: the app renders attacker-controlled text (deep links, usernames, server responses) that could carry injection payloads into the transcript. Mitigation: snapshots and logs are structured and redacted; Swipium does not execute app-derived text as commands.
- Accidental data loss: a data wipe (`clear_data`, `fresh_start`) on a debug RN/Expo build removes the cached JS bundle and breaks the app. Mitigation: these actions are consent-gated high and additionally require `acknowledgeBundleRisk:true`; `qa_resolve_target include:["plan"]` surfaces `fresh_start` as UNSAFE with reason `bundle_cache_loss`.
- Environment left dirty: a run changes network state or leaves a recorder or Metro bundler running. Mitigation: network changes record the original state and auto-restore at report end, on `restore`, and on server shutdown; screen recordings and Metro bundlers are stopped on shutdown.
- Secret leakage into artifacts/reports: credentials or tokens entered during testing get written to logs, dumps, or reports. Mitigation: values typed into secure fields and secrets provided via `qa_continue_from_blocker` are registered for redaction. Values of 4 or more characters are scrubbed wherever they appear as substrings. 3-character values, and PINs/OTPs/CVVs of up to 7 digits, are scrubbed as whole tokens, so a 3-digit CVV is still redacted while a PIN of `2026` does not blank `20260928`. XML- and JSON-escaped spellings are scrubbed too. Honest limitation: secrets shorter than 3 characters are not redacted (they would blank ordinary text); an artifact written while such a secret is registered is marked `redaction: "partial"` instead of `applied`. Known secret shapes are redacted from snapshots and reports; session artifact names are sanitized so they can never be written outside the session directory; `resources/list` shows only the current project's sessions and never lists sensitive-mode sessions; sensitive mode withholds screenshots and visual OCR on password/OTP screens.
- Sensitive-screen capture: screen recording or OCR captures a password/payment screen. Mitigation: recording and visual OCR are consent-gated, refuse sensitive sessions, and visual text/diff ops are withheld when a secure field is on screen unless explicitly forced.
- Untrusted seed/fixture execution: a fixture seed runs a local script or API call. Mitigation: all seed/state mutations are consent-gated with risk scaled by type (`script` high), git commands are refused, and seed failures are reported as setup failures, not app bugs.
- Malicious cloned repository: a developer clones an untrusted repo and points Swipium at it. Everything under the project root is attacker-controlled: `.swipium/config.json` (OCR/visual-mask commands, WDA settings, policy), `.swipium/flows/*.yaml`, `.swipium/fixtures.json` (seed scripts and API calls), and build/Metro commands. Mitigations: every repo-supplied command that Swipium would execute (seed scripts, build commands, `ocrCommand`/`visualMaskCommand`) is consent-gated, and the consent prompt shows the exact argv so the human sees what the repo asked to run before it runs; flows resolve `${VAR}` references only for `SWIPIUM_`-prefixed environment variables, so a flow cannot read unrelated secrets such as cloud credentials; a non-loopback WebDriverAgent URL requires explicit per-call consent and cannot be pre-approved by the repo's config (`ios.wda.allowNonLoopbackUrls` is ignored as a pre-approval; only the user-level `SWIPIUM_ALLOW_REMOTE_WDA` exact-URL list is honoured), and iOS preparation never auto-connects to a non-loopback configured WDA URL; the OCR consent discloses the `visualMaskCommand` argv alongside the `ocrCommand`, each labelled with its provenance ("configured by the repository (.swipium/config.json) — unreviewed"). The refusal of `git` executables in seeds and provider commands is a policy speed-bump against accidental repo mutation, not a security boundary: a consented script can still run anything the developer can. Treat approving a cloned repo's commands like running its `npm install` scripts.
  - Flow-level controls: an `openUrl` step that interpolates a `${VAR}` counts as mutating (consent-gated, never run by `qa_smoke`), so a resolved value cannot silently leave the machine in a URL; the `qa_flow_run` seed consent lists each seed's exact argv/URL labelled repo-supplied and unreviewed; image templates, visual baselines, and `qa_flow_repair` targets are confined to the project root (realpath check), and repair never auto-applies a low-confidence guess.
- Stale client after upgrade: an MCP client keeps an old server process after an upgrade, exposing a stale tool surface. Mitigation: version and tool-count are reported on start and by `qa_doctor`; a stale-client hint is shown.

## Controls Summary

- Server-side consent state machine with exact command/effect display and project-root boundary; on elicitation-capable clients a dismissed, timed-out or failed prompt counts as a refusal; `SWIPIUM_REQUIRE_ELICITATION=1` requires an out-of-band prompt for every consent-gated action.
- Destructive-action guardrails: data wipes on debug RN/Expo builds are refused unless the call explicitly passes `acknowledgeBundleRisk:true` (and still need consent). This is a deliberate speed-bump against accidental bundle loss; a client can pass the acknowledgement, so it is not a boundary against a compromised client.
- Secret redaction (secrets of 3+ characters; shorter ones are reported as `redaction: "partial"`) and sensitive-screen mode.
- Repo-supplied configuration is untrusted: repo commands are shown verbatim in consent, flows see only `SWIPIUM_*` env vars, and non-loopback WDA URLs need per-call consent (or the user-level `SWIPIUM_ALLOW_REMOTE_WDA`).
- Orphan reaping never signals a recycled pid: each managed child's start time and full command are recorded at spawn and must both match; only group leaders Swipium created have their process group signalled.
- Network restore and recorder/Metro shutdown hooks.
- External artifact handling within the project root; no writes outside without approval.
- Tool metadata lint and public tool-surface lockstep tests.
- Coordinate-space metadata on all visual results.

## Explicit Non-Goals (Current Scope)

Swipium is simulator-local. The following are intentionally out of scope until a dedicated design and threat model exist for each:

- Remote or HTTP transport, authentication, and multi-tenant operation.
- Real-device execution. Physical devices are reported as visible-but-refused with the typed
  failure code `PHYSICAL_DEVICE_UNSUPPORTED`; the scoping design for eventual support is
  `docs/physical-devices.md`.
- External service integrations (for example issue trackers or CI back-ends that send data off the machine).
- Remote AI vision that sends screenshots to a third-party service by default.

Adding any of these requires extending this document first.

## Reporting

Security issues should be reported per `SECURITY.md`.
