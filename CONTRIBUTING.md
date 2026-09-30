# Contributing

Contributions are welcome. Every change is reviewed and approved by the maintainer before it is merged.

## Before you start

Open an issue first for large changes, changes to public tool behavior, new dependencies, or anything that widens the scope (for example real-device or cloud support). Small fixes, tests, documentation improvements, and clear bug reports can go straight to a pull request.

## Development setup

You need Node.js 20 or newer and npm. Android Studio or Xcode is needed only to try changes against a real emulator or simulator; the test suite runs without either.

```bash
npm ci
npm run build          # compile to dist/
npm test               # vitest, no devices needed
```

Other scripts:

| Script | What it runs |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config, typescript-eslint) |
| `npm run format` / `format:check` | Prettier (`.prettierrc`: single quotes, 140 columns) |
| `npm run audit:prod` | `npm audit --omit=dev --audit-level=moderate` |
| `npm run verify` | Build, then `swipium verify` against `dist/` |
| `npm run inspector` | Build, then open the MCP Inspector on the server |
| `npm run release:check` | `typecheck`, `lint`, `format:check`, `test`, `audit:prod`, then `npm pack --dry-run` |

Run `npm run release:check` before opening a pull request. CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, the production audit, and the build on every push and pull request to `main`.

To try the CLI from source, run `npm run build` and then `node dist/index.js --help`. Never test `swipium init --apply` against your real client configs: use `--cwd` with a scratch directory and a throwaway `HOME`.

## Architecture

Swipium is a stdio MCP server (`src/index.ts` → `src/server.ts`). The CLI lives in `src/cli/` (`main.ts` parses arguments; `init`, `verify`, `scan`, `suite`, `report`, and `gc` each have a module). Because stdout carries JSON-RPC, server code logs only to stderr through `src/lib/logger.ts`.

| Path | What lives there |
| --- | --- |
| `src/tools/` | One module per tool family, each exporting `register…(server, sessions)`. `server.ts` imports every module here. |
| `src/tools/deferred/` | Former public tools kept for possible revival. Excluded from the build (see its [README](src/tools/deferred/README.md)). |
| `src/services/` | Logic shared by several tools and by `qa_test_this` (build, prepare Android/iOS, smoke, report, flow/suite/automation generation), so both paths run the same code. |
| `src/orchestration/` | The `qa_test_this` pipeline (`testThis/`: plan, execute, terminal states) and its result envelope. |
| `src/drivers/` | The `Driver` interface and its backends: `DirectDriver` (Android via `adb`), `SimctlDriver` (iOS Simulator, visual and lifecycle only), and `WdaDriver` (iOS through WebDriverAgent). |
| `src/session/` | The session, job, and artifact store (persisted under `~/.swipium/runs`), device attachment, the managed-process registry (Metro, WebDriverAgent, recorders), and retention. |
| `src/snapshot/` | UI-tree parsing, overlay detection, settling, and compact presentation. |
| `src/report/` | Report building blocks: coverage, evidence, findings, the release-gate policy, and CI exports (JUnit, SARIF, GitHub summary). |
| `src/flows/` | The flow schema, runner, linter, repair, generation, and seed execution. |
| `src/suite/`, `src/automationGen/`, `src/testSuite/` | Page-object suites and their compiler, generated Appium code (JS/Python), and the repo-level test suite (`.swipium/test-suite.json`). |
| `src/consent/` | The consent state machine and MCP elicitation routing. |
| `src/oracle/` | The failure catalog (`failures.ts`), health checks, and locator scoring. |
| `src/lib/` | Shared helpers: result envelopes, spawning, locking, redaction, cancellation, tool annotations, Android SDK and `simctl` wrappers, WebDriverAgent config. |
| Others | `src/appMap/` (the app knowledge map), `src/explore/`, `src/firstRun/`, `src/featureTesting/`, `src/issues/`, `src/mobileAudit/`, `src/visual/` (OCR and masking providers), `src/context/` (project detection and root resolution), `src/core/` (target planning and capability groups), `src/fixtures/`, `src/state/`, `src/prompts/`. |

### The public tool surface moves in lockstep

Adding, removing, or renaming a tool means updating all of these in the same change:

1. `TOOL_NAMES` in `src/version.ts`, the single source of truth.
2. The registration in a `src/tools/` module imported by `src/server.ts`. At startup, `assertToolSurface()` fails if the registered tools differ from `TOOL_NAMES`.
3. Exactly one group in `CAPABILITY_GROUPS` (`src/core/capabilityGroups.ts`).
4. An entry in `src/lib/toolAnnotations.ts`. The table is keyed by tool name, so a missing entry is a compile error.
5. Exactly one table row in `docs/tools.md`, plus its stated tool count.
6. For a removed tool: an entry in `REMOVED_TOOLS` (`src/version.ts`) with its replacement, and a row in the migration table in `docs/tools.md` and `CHANGELOG.md`.

`test/publicSurface.test.ts` checks the registered tools against `TOOL_NAMES`, the capability groups, the `docs/tools.md` rows and count, the migration table, and a denylist of removed and deferred tool names. It also fails if any module directly under `src/tools/` is not imported by `server.ts`. `test/toolMetadata.test.ts` lints tool descriptions and annotations.

## Conventions

- **Result envelopes.** Return `qaOk(payload, summary)` or `qaError({ what, changedState, retrySafe, failureCode, nextSteps })` from `src/lib/result.ts`. Every error needs a `failureCode` from the catalog in `src/oracle/failures.ts`; `test/failureCatalog.test.ts` scans `src/` and fails on any code that isn't catalogued, and `test/errorContract.test.ts` checks that every tool fails with a well-formed envelope. For an unknown `sessionId`, return `unknownSessionError(sessionId)`.
- **Consent.** Gate side effects with `consumeConsent(consentId, approve, { action, affects })` and, when it isn't approved, return `requireConsent({ action, risk, explain, exactCommand?, affects })` from `src/consent/consent.ts`. Use the same `action` and `affects` in both, because a consent is bound to them. Elicitation routing and session binding are handled for you.
- **Cancellation.** The server wraps every tool call in `runWithSignal(signal, …)` from `src/lib/abortScope.ts`, and background jobs run inside their own job signal. Code that spawns a process or makes a request reads `currentSignal()`; do not store signals on drivers. Use `isAbortError()` so a cancellation returns `CANCELLED` and is never recorded as a failure.
- **Secrets.** Redact output with `src/lib/redact.ts` (`makeRedactor`, `redactDeep`). Generated flows, suites, and code must go through `src/suite/secretGuard.ts`, which assigns `SWIPIUM_*` placeholders (`secretVarName`) and rejects leaked values (`assertNoSecretLeaks`). Never inline secrets in tests, fixtures, or examples.
- **Files.** Shared JSON under `~/.swipium` and `.swipium/` is written with `writeFileAtomicSync` and guarded by `withFileLock` / `withFileLockAsync` from `src/lib/lockfile.ts`.
- **Processes.** Run commands through `run` / `runBinary` in `src/lib/spawn.ts`: argv arrays only (never a shell string), a default timeout, the current cancellation signal, and a refusal to execute `git` (`assertNoGitScope`), because Git operations are outside Swipium's scope. The few long-lived detached children (emulator, Metro, WebDriverAgent, screen recorders) are spawned directly, also with argv arrays, and are tracked in `src/session/processRegistry.ts` so a later server can reap or adopt them safely.
- **Sensitive mode.** Any new pixel, video, or log capture must return `sensitiveRefusal()` (`src/lib/sensitive.ts`) when the session is in sensitive mode.
- **Scope.** Keep emulator and simulator behavior separate from any real-device work; physical devices must keep failing with `PHYSICAL_DEVICE_UNSUPPORTED`.

## Testing

Tests use [Vitest](https://vitest.dev) and never need a device, emulator, or simulator:

- **In-memory server.** Create the server with `createServer()` from `src/server.ts` and connect a client through `InMemoryTransport.createLinkedPair()` from the MCP SDK, then call tools as a real client would (see `test/publicSurface.test.ts`).
- **Fake drivers.** `setDriverFactoryForTests()` (`src/session/attach.ts`) injects a fake `Driver`. `test/actFixFake.ts` is a shared harness with a fake Android driver, a UI-dump builder, and a connected client.
- **Isolation.** Set `SWIPIUM_DISABLE_DEVICE_DISCOVERY=1` so a machine with a running emulator doesn't change results, and point `HOME` at a temporary directory for anything that touches `~/.swipium`.

Add a test for every behavior change and every fixed bug.

## Documentation

Update the public docs in the same pull request as the behavior they describe:

- `docs/tools.md` for any change to a tool's parameters, results, or consent behavior.
- `README.md` for installation, client setup, CLI commands, environment variables, and troubleshooting.
- `CHANGELOG.md` for any user-visible change, with migration notes for renamed or removed tools.
- `THREAT_MODEL.md` and `SECURITY.md` when a trust boundary, consent rule, or redaction rule changes. `THREAT_MODEL.md` states the package version, and `test/docVersion.test.ts` checks it against `package.json`.

Tool descriptions are shown to agents: keep them factual, and never include internal planning labels.

## Pull requests

- Keep changes focused, without unrelated formatting or refactors.
- Include tests for behavior changes.
- Don't commit generated local state, credentials, logs, simulator artifacts, or `.swipium/` data.

The maintainer may request changes, close stale pull requests, or decline work that doesn't fit the current scope.

## Releases (maintainers)

Releases are published by `.github/workflows/release.yml` when a `v*` tag is pushed. The workflow checks that the tag matches the `package.json` version, runs `npm run release:check`, and publishes to npm with provenance (skipping versions that already exist). Pushing a version tag is therefore a release; only maintainers do it, after the version, `CHANGELOG.md`, and `THREAT_MODEL.md` are updated.

## Security

Don't report vulnerabilities in public issues or pull requests. Follow [SECURITY.md](SECURITY.md) and email hi@swipium.com.
