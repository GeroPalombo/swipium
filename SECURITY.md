# Security Policy

## Supported versions

Security fixes go into the latest release only. Currently that is the 2.0.x line. Older lines,
including 1.5.x, receive no fixes, so upgrade to the latest release.

| Version | Supported |
| --- | --- |
| 2.0.x (latest) | Yes |
| 1.5.x and older | No |

## Reporting a vulnerability

Report security issues privately to hi@swipium.com. Do not open a public GitHub issue for a
suspected vulnerability.

Please include:

- The Swipium version (`swipium --version`).
- Your operating system, and the emulator or simulator platform.
- A clear reproduction path.
- Expected and actual behavior.
- The security impact.
- Relevant logs, with secrets, tokens, credentials, app binaries and customer data removed.

We aim to acknowledge reports within 7 days. When a fix ships depends on severity, reproduction
quality and release risk.

## Scope

A report is in scope when it involves Swipium code, the published package, generated artifacts,
command execution, secret handling, evidence storage, or MCP tool behavior.

Report problems in third-party tools, the apps under test, emulators and simulators, Appium,
WebDriverAgent, Xcode, Android Studio or the operating system to the relevant upstream project,
unless Swipium introduces the vulnerability.

## Security properties at a glance

Swipium is a local stdio MCP server for Android Emulators and iOS Simulators. `THREAT_MODEL.md`
describes the full model, including its residual risks. In short:

- **Consent for privileged actions.** Builds, Metro, emulator and simulator boots, app installs,
  data wipes, seeds, recordings, network changes, OCR and non-loopback WebDriverAgent all need
  consent. Each consent is single-use, bound to the exact action, target and session, and expires
  after 30 minutes. See [docs/concepts.md](docs/concepts.md#consent).
- **Real user prompts where possible.** If your MCP client supports elicitation, Swipium asks you
  directly, and only an explicit approval runs the action. On other clients the agent relays the
  approval. Set `SWIPIUM_REQUIRE_ELICITATION=1` to refuse every consent-gated action unless the
  client can show you the prompt.
- **Cloned repositories are untrusted.** Every command from `.swipium/` is shown verbatim in its
  consent prompt. Flows and fixtures read only `SWIPIUM_*` environment variables. The repository
  cannot pre-approve a remote WebDriverAgent; only your own `SWIPIUM_ALLOW_REMOTE_WDA` can. An
  approved script still runs with your privileges, and the refusal to run `git` guards against
  accidents. It is not a sandbox.
- **Redaction.** Registered secrets of 3 or more characters are redacted from text artifacts,
  reports, state and generated code. Shorter ones are not, and the artifact is marked
  `redaction: "partial"`. Screenshots and recordings are pixels and are never redacted, so a
  screenshot with a secure field on screen is refused (`CAPTURE_WITHHELD_SECURE`) unless the call
  passes `force: true`. Use sensitive mode (`qa_start_session { sensitive: true }`) to refuse all
  pixel and log capture. See [docs/concepts.md](docs/concepts.md#secrets-and-redaction).
- **Local only.** Session data lives under `~/.swipium/runs/` with owner-only permissions on POSIX.
  Swipium opens no network listener.
- **No physical devices.** Swipium never acts on a phone. When a phone is the only option or is
  explicitly requested, it returns `PHYSICAL_DEVICE_UNSUPPORTED`. See `docs/physical-devices.md`.

## Handling sensitive data

Do not send real credentials, production tokens, private app binaries, customer data or
confidential screenshots in a report. Use minimal reproductions and redacted evidence.

Swipium is built for local QA automation. You are responsible for choosing safe test accounts,
emulator and simulator targets, and non-production environments.
