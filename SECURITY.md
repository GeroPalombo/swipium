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

## Handling Sensitive Data

Do not send real credentials, production tokens, private app binaries, customer data, or confidential screenshots in a report. Use minimal reproductions and redacted evidence.

Swipium is designed for local QA automation. Users are responsible for choosing safe test accounts, simulator targets, and non-production environments.
