# Swipium Docs

This directory contains public documentation for the Swipium MCP server.

## Index

- [MCP Server](mcp-server.md): server command, project-root resolution, client setup (Claude Code, Codex, Gemini CLI, Cursor, VS Code, Claude Desktop, Windsurf), and verification.
- [Tool Reference](tools.md): public MCP tools grouped by workflow (the authoritative tool list).
- [CI Reports](ci-reports.md): exporting run reports as JUnit, SARIF, or a GitHub job summary.
- [Physical Devices](physical-devices.md): roadmap and scoping for real-device support (currently refused with `PHYSICAL_DEVICE_UNSUPPORTED`).

Environment variables and host-OS support are covered in the top-level [README](../README.md#configuration--environment-variables).

Security: [Threat Model](../THREAT_MODEL.md) and [Security Policy](../SECURITY.md). Release history: [CHANGELOG](../CHANGELOG.md); upgrading from 1.x, see [Migrating from 1.5.0](../CHANGELOG.md#migrating-from-150) (also mirrored at the end of [tools.md](tools.md)).

## Scope

Swipium is simulator-only:

- Android Emulator (macOS, Linux; Windows experimental).
- iOS Simulator (macOS).
- Local MCP stdio server.
- Local artifacts and app-map memory.

Real devices, cloud execution, and certification are outside the current public scope.
