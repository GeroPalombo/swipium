# Changelog

All notable public changes to Swipium are documented here.

## Unreleased

### Fixed

- Fixed default iOS text entry so replace-mode typing clears focused fields with current WebDriverAgent attributes and falls back to keyboard deletion when needed.
- Fixed `qa_test_this` build handling so successful Expo iOS builds are not reported as app build failures when artifact resolution needs follow-up.
- Fixed `qa_prepare_ios_target` so structured iOS mode is reported only after a WebDriverAgent session is created and attached to the run.
- Fixed report verdicts so Swipium tool limitations do not block the app status; they are reported under coverage and tool status.

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
