# Security Policy

## Supported Versions

Only the latest public version of Swipium receives security fixes.

| Version | Supported |
| --- | --- |
| Latest | Yes |
| Older versions | No |

## Reporting a Vulnerability

Report security issues privately to hi@swipium.com.

Do not open a public GitHub issue for a suspected vulnerability.

Please include:

- Swipium version.
- Operating system and simulator platform.
- A clear reproduction path.
- Expected and actual behavior.
- Security impact.
- Relevant logs with secrets, tokens, credentials, app binaries, and customer data removed.

We aim to acknowledge reports within 7 days. Fix timing depends on severity, reproduction quality, and release risk.

## Scope

Security reports are in scope when they involve Swipium code, published packages, generated artifacts, command execution, secret handling, evidence storage, or MCP tool behavior.

Reports about third-party tools, mobile apps under test, simulators, Appium, Xcode, Android Studio, or operating system behavior should be reported to the relevant upstream project unless Swipium introduces the vulnerability.

## Consent Hardening

Privileged actions (building from source, starting Metro, installing apps, wiping app data, running seeds, and similar) always need consent. If your MCP client supports elicitation, Swipium asks you directly. Only an explicit approval counts: dismissing the prompt, leaving it unanswered for 10 minutes, or a connection error is treated as a refusal. To forbid the model-relayed approval fallback on clients without elicitation, set `SWIPIUM_REQUIRE_ELICITATION=1`. A consent is bound to the session it was issued in and cannot be replayed in another session. Every consent-gated action is then refused unless the client can show you the prompt. See `THREAT_MODEL.md`.

Treat a cloned repository's `.swipium/` directory (config, flows, fixtures) as untrusted input. Swipium shows the exact repo-supplied command in each consent prompt, resolves only `SWIPIUM_*` environment variables in flows, and requires consent for a non-loopback WebDriverAgent URL (the repository config cannot pre-approve one; only your own `SWIPIUM_ALLOW_REMOTE_WDA` environment variable can), but an approved script runs with your privileges. The refusal of `git` in seeds and provider commands guards against accidents; it is not a sandbox. Secret redaction covers registered values of 3 or more characters; shorter ones are not redacted and the artifact is marked `redaction: "partial"`. Screenshots and recordings are pixels and are never redacted.

## Handling Sensitive Data

Do not send real credentials, production tokens, private app binaries, customer data, or confidential screenshots in a report. Use minimal reproductions and redacted evidence.

Swipium is designed for local QA automation. Users are responsible for choosing safe test accounts, simulator targets, and non-production environments.
