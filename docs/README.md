# Swipium Docs

Public documentation for the Swipium MCP server. Start with the top-level [README](../README.md): what Swipium does, requirements, quickstart, environment variables, the CLI, and troubleshooting.

## Guides

- [Concepts](concepts.md): sessions, jobs and cancellation, project root, consent (prompts, the `requiresConsent` re-call, operator pre-approval for headless runs), secrets and redaction, iOS modes (visual-only vs WebDriverAgent), devices, and a glossary of terms such as app map, flow, POM suite, and `@eN` refs.
- [Flows](flows.md): writing, running, and repairing replayable flows, with an example, variables, and CI policy.
- [MCP Server](mcp-server.md): the server command, per-client setup (Claude Code, Codex, Gemini CLI, Cursor, VS Code, Claude Desktop, Windsurf, headless runs), protocol versions (2025-06-18, 2025-11-25 and 2026-07-28), what the model sees, server behavior, verification, debugging, and troubleshooting.
- [CI Reports](ci-reports.md): `swipium report` output formats (JUnit, SARIF, GitHub summary, Markdown, JSON), a GitHub Actions recipe with a headless agent step, pre-approving consents in CI, and the release-gate policy.

## Reference

- [Tool Reference](tools.md): every public MCP tool, grouped by capability, with parameters, consent behavior, the [failure-code catalog](tools.md#failure-codes), and the [1.5.0 migration table](tools.md#migrating-from-150). This is the authoritative tool list.
- [Environment variables](../README.md#configuration--environment-variables): the complete list lives in the README.
- [Physical Devices](physical-devices.md): why real devices are refused today (`PHYSICAL_DEVICE_UNSUPPORTED`) and what supporting them would require.

## Elsewhere in the repository

- Upgrading: the [README section](../README.md#upgrading) links the per-release checklists; from 1.5, also see the [migration table in the CHANGELOG](../CHANGELOG.md#migrating-from-150).
- Security: [Threat Model](../THREAT_MODEL.md) and [Security Policy](../SECURITY.md).
- Release history: [CHANGELOG](../CHANGELOG.md).
- Development: [Contributing](../CONTRIBUTING.md). Getting help: [Support](../SUPPORT.md).

## Scope

Swipium is a local stdio MCP server for emulators and simulators:

- Android Emulator on macOS and Linux (Windows is experimental and untested).
- iOS Simulator on macOS.
- Evidence, app maps, flows, and test suites stored locally.

Real devices and cloud execution are outside the current scope.
