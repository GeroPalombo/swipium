# Support

## Where to get help

Open a [GitHub issue](https://github.com/GeroPalombo/swipium/issues) for:

- Bugs.
- Emulator, simulator, or client setup problems you can reproduce.
- Documentation gaps.
- Focused feature requests.

Email hi@swipium.com for:

- Security vulnerabilities (see [SECURITY.md](SECURITY.md)).
- Anything that should not be public.

Never post vulnerabilities, credentials, or private project data in a public issue.

Before opening an issue, check [Troubleshooting](README.md#troubleshooting) in the README. Many setup problems are solved by restarting the MCP client after an upgrade, or by setting `SWIPIUM_PROJECT_ROOT` or `ANDROID_HOME` in the server's `env` block.

## What to include

- **Swipium version:** the output of `swipium --version` (or `npx -y swipium --version`).
- **Node.js version:** `node --version`.
- **Host OS and version:** macOS, Linux, or Windows.
- **MCP client and version:** Claude Code, Codex, Gemini CLI, Cursor, VS Code, Claude Desktop, Windsurf, or another.
- **Target:** Android Emulator (API level, AVD) or iOS Simulator (iOS version, device), and for iOS whether WebDriverAgent was running.
- **`qa_doctor` output**, run from your client (or the output of `swipium verify` if the tools don't load).
- **The failing tool call or command** and its `failureCode`, if the result has one.
- **Steps to reproduce**, as small as you can make them.
- Redacted logs or screenshots when they help.

Remove real credentials, production tokens, private app binaries, customer data, and confidential screenshots first. Screenshots are never redacted automatically.

## Support scope

Supported: the public Swipium tool surface on Android Emulators (macOS and Linux) and iOS Simulators (macOS). Windows is experimental.

Physical devices are out of scope and are refused by design (see [docs/physical-devices.md](docs/physical-devices.md)). Questions about them, or about debugging a specific private app, are welcome but not guaranteed an answer.
