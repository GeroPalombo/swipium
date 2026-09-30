# Swipium Docs

Public documentation for the Swipium MCP server. Start with the top-level [README](../README.md) for requirements, installation, client setup, configuration, the CLI, and troubleshooting.

## Reference

- [Tool Reference](tools.md): every public MCP tool, grouped by capability, with parameters, consent behavior, and the 1.5.0 migration table. This is the authoritative tool list.
- [MCP Server](mcp-server.md): the server command, project-root resolution, per-client setup, verification, artifacts, and consent.
- [CI Reports](ci-reports.md): `swipium report` output formats (JUnit, SARIF, GitHub summary, Markdown, JSON), a GitHub Actions recipe, and the release-gate policy.
- [Physical Devices](physical-devices.md): why real devices are refused today (`PHYSICAL_DEVICE_UNSUPPORTED`) and what supporting them would require.

## Elsewhere in the repository

- Environment variables and host-OS support: [README](../README.md#configuration--environment-variables).
- Security: [Threat Model](../THREAT_MODEL.md) and [Security Policy](../SECURITY.md).
- Release history: [CHANGELOG](../CHANGELOG.md). Upgrading from 1.x: [Migrating from 1.5.0](../CHANGELOG.md#migrating-from-150).
- Development: [Contributing](../CONTRIBUTING.md). Getting help: [Support](../SUPPORT.md).

## Scope

Swipium is a local stdio MCP server for emulators and simulators:

- Android Emulator on macOS and Linux (Windows is experimental).
- iOS Simulator on macOS.
- Evidence, app maps, flows, and test suites stored locally.

Real devices and cloud execution are outside the current scope.
