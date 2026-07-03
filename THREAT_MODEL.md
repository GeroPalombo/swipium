# Swipium Threat Model

Last updated: 2026-07-03 (Swipium 1.5.0)

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

- Malicious or compromised MCP client / prompt injection: a client (or a poisoned tool description in another server) tries to trigger a destructive or exfiltrating action. Mitigation: server-side consent state machine for all destructive/privileged actions; exact command and effect are shown before execution; consent is per-action and not satisfiable by client assertion alone. Tool descriptions are linted (`test/toolMetadata.test.ts`) to stay honest and non-manipulative.
- Untrusted app content: the app renders attacker-controlled text (deep links, usernames, server responses) that could carry injection payloads into the transcript. Mitigation: snapshots and logs are structured and redacted; Swipium does not execute app-derived text as commands.
- Accidental data loss: a data wipe (`clear_data`, `fresh_start`) on a debug RN/Expo build removes the cached JS bundle and breaks the app. Mitigation: these actions are consent-gated high and additionally require `acknowledgeBundleRisk:true`; `qa_plan` surfaces `fresh_start` as UNSAFE with reason `bundle_cache_loss`.
- Environment left dirty: a run changes network state or leaves a recorder or Metro bundler running. Mitigation: network changes record the original state and auto-restore at report end, on `restore`, and on server shutdown; screen recordings and Metro bundlers are stopped on shutdown.
- Secret leakage into artifacts/reports: credentials or tokens entered during testing get written to logs, dumps, or reports. Mitigation: secret values provided via `qa_continue_from_blocker` are registered for redaction; known secret shapes are redacted from snapshots and reports; sensitive mode withholds screenshots and visual OCR on password/OTP screens.
- Sensitive-screen capture: screen recording or OCR captures a password/payment screen. Mitigation: recording and visual OCR are consent-gated, refuse sensitive sessions, and visual text/diff ops are withheld when a secure field is on screen unless explicitly forced.
- Untrusted seed/fixture execution: a fixture seed runs a local script or API call. Mitigation: all seed/state mutations are consent-gated with risk scaled by type (`script` high), git commands are refused, and seed failures are reported as setup failures, not app bugs.
- Stale client after upgrade: an MCP client keeps an old server process after an upgrade, exposing a stale tool surface. Mitigation: version and tool-count are reported on start and by `qa_doctor`; a stale-client hint is shown.

## Controls Summary

- Server-side consent state machine with exact command/effect display and project-root boundary.
- Destructive-action guardrails (bundle-loss refusal) that the client cannot override.
- Secret redaction and sensitive-screen mode.
- Network restore and recorder/Metro shutdown hooks.
- External artifact handling within the project root; no writes outside without approval.
- Tool metadata lint and public tool-surface lockstep tests.
- Coordinate-space metadata on all visual results.

## Explicit Non-Goals (Current Scope)

Swipium is simulator-local. The following are intentionally out of scope until a dedicated design and threat model exist for each:

- Remote or HTTP transport, authentication, and multi-tenant operation.
- Real-device execution.
- External service integrations (for example issue trackers or CI back-ends that send data off the machine).
- Remote AI vision that sends screenshots to a third-party service by default.

Adding any of these requires extending this document first.

## Reporting

Security issues should be reported per `SECURITY.md`.
