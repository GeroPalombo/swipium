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

Run `npm run release:check` before opening a pull request. It's the same gate the release workflow runs. CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, the production audit, and the build on every push and pull request to `main`; it skips `format:check` and `npm pack --dry-run`, so run those locally.

Two environment notes:

- `vitest.config.ts` excludes `.claude/**`, because agent worktrees under `.claude/worktrees/` hold other checkouts of this repo. Keep it that way if you touch the config. ESLint and Prettier ignore `.claude/` too.
- Keep the checkout out of folders a sync service manages (for example a macOS Desktop or Documents folder synced to iCloud Drive). Sync can evict files or leave conflict copies such as `server 2.ts`, which break the build and the tests in confusing ways.

To try the CLI from source, run `npm run build` and then `node dist/index.js --help`. Never test `swipium init --apply` against your real client configs: use `--cwd` with a scratch directory and a throwaway `HOME`.

## Architecture

Swipium is a stdio MCP server (`src/index.ts` > `src/server.ts`). The CLI lives in `src/cli/` (`main.ts` parses arguments; `init`, `verify`, `scan`, `suite`, `report`, and `gc` each have a module). Because stdout carries JSON-RPC, server code logs only to stderr through `src/lib/logger.ts`.

| Path | What lives there |
| --- | --- |
| `src/tools/` | One module per tool family, each exporting a `register…` function that `server.ts` imports and calls. Most take `(server, sessions)`; `registerDoctor(server)` takes only the server. MCP prompts are registered separately by `registerPrompts(server)` in `src/prompts/`. |
| `src/tools/deferred/` | Former public tools kept for possible revival. Excluded from the build (see its [README](src/tools/deferred/README.md)). |
| `src/services/` | Logic shared by several tools and by `qa_test_this` (build, prepare Android/iOS, smoke, report, flow/suite/automation generation), so both paths run the same code. |
| `src/orchestration/` | The `qa_test_this` pipeline (`testThis/`: plan, execute, terminal states) and its result envelope. |
| `src/drivers/` | The `Driver` interface and its backends: `DirectDriver` (Android via `adb`), `SimctlDriver` (iOS Simulator, visual and lifecycle only), and `WdaDriver` (iOS through WebDriverAgent). |
| `src/session/` | The session, job, and artifact store (persisted under `~/.swipium/runs`), device attachment, the managed-process registry (Metro, WebDriverAgent, recorders), and retention. |
| `src/snapshot/` | UI-tree parsing, overlay detection, settling, and compact presentation. |
| `src/report/` | Report building blocks: coverage, evidence, findings, the release-gate policy, and CI exports (JUnit, SARIF, GitHub summary). |
| `src/flows/` | The flow schema, runner, linter, repair, generation, and seed execution. |
| `src/suite/`, `src/automationGen/`, `src/testSuite/` | Page-object suites and their compiler, generated Appium code (JS/Python), and the repo-level test suite (`.swipium/test-suite.json`). |
| `src/consent/` | The consent state machine (`consent.ts`): challenges, single-use approval bound to action and target, session binding, operator pre-approval and its tiers (`CONSENT_ACTION_TIERS`), and the single-use `requestState` handles of the 2026-07-28 prompt (`issueConsentPrompt`, `redeemConsentPrompt`). Prompt routing for both protocol eras (`routePendingConsent`, `resumeConsentPrompt`) lives in `src/server.ts`. |
| `src/oracle/` | The failure catalog (`failures.ts`), health checks, and locator scoring. |
| `src/lib/` | Shared helpers: result envelopes, spawning, locking, redaction, cancellation, tool annotations, Android SDK and `simctl` wrappers, WebDriverAgent config. |
| Others | `src/appMap/` (the app knowledge map), `src/explore/`, `src/firstRun/`, `src/featureTesting/`, `src/issues/`, `src/mobileAudit/`, `src/visual/` (OCR and masking providers), `src/context/` (project detection and root resolution), `src/core/` (target planning and capability groups), `src/fixtures/`, `src/state/`, `src/prompts/`. |

To find where a tool is registered, search for its quoted name: `grep -rn "'qa_status'" src/tools`. Module names don't always match tool names; for example `qa_status`, `qa_explain_blocker`, and `qa_continue_from_blocker` all live in `src/tools/agent.ts`.

### The public tool surface moves in lockstep

Adding, removing, or renaming a tool means updating all of these in the same change (see [Adding a tool](#adding-a-tool) for a walkthrough):

1. `TOOL_NAMES` in `src/version.ts`, the single source of truth.
2. The registration in a `src/tools/` module imported by `src/server.ts`. At startup, `assertToolSurface()` fails if the registered tools differ from `TOOL_NAMES`, or if a tool isn't in exactly one capability group.
3. Exactly one group in `CAPABILITY_GROUPS` (`src/core/capabilityGroups.ts`).
4. An entry in `src/lib/toolAnnotations.ts`. The table is keyed by tool name, so a missing entry is a compile error.
5. Exactly one row in the tool index of `docs/tools.md`, a `### qa_…` section under its group, and the stated tool count.
6. For a removed tool: an entry in `REMOVED_TOOLS` (`src/version.ts`) with its replacement, and a row in the migration table in `docs/tools.md` and `CHANGELOG.md`.

`test/publicSurface.test.ts` checks the registered tools against `TOOL_NAMES`, the capability groups, the `docs/tools.md` rows and count, the migration table, and a denylist of removed and deferred tool names. It also fails if any module directly under `src/tools/` is not imported by `server.ts`. `test/toolMetadata.test.ts` lints tool descriptions and annotations.

The surface also has size budgets, because clients load it into the model's context:

- `test/toolListBudget.test.ts`: each tool description is at most 400 characters, and the serialized `tools/list` stays under a fixed byte budget (66,000 bytes in 2.2.0). Put detail in `docs/tools.md`, not in the description. Raise the budget only on purpose.
- `test/instructionsBudget.test.ts`: `SERVER_INSTRUCTIONS` (`src/tools/agent.ts`) is at most 2,000 characters, and its first 512 characters stand alone (what Swipium is, `qa_test_this`, and the `qa_job_status` poll).
- If the instructions or `qa_status` start pointing at a tool outside the Codex core groups, add it to `CODEX_CORE_EXTRA_TOOLS` in `src/cli/init.ts` (`test/cliInit.test.ts` checks this).

## Conventions

- **Result envelopes.** Return `qaOk(payload, summary, opts?)` or `qaError({ what, changedState, retrySafe, failureCode, nextSteps })` from `src/lib/result.ts`. Every error needs a `failureCode` from the catalog in `src/oracle/failures.ts`; `test/failureCatalog.test.ts` scans `src/` and fails on any code that isn't catalogued, and `test/errorContract.test.ts` checks that every tool fails with a well-formed envelope. For an unknown `sessionId`, return `unknownSessionError(sessionId)`. `qaError` caps every string that can echo caller input, so pass input through it rather than building your own error. `qaOk` copies the summary's first line into `structuredContent.summary` and extracts `Next: qa_…` / `Call qa_…` guidance into `next`, because Claude Code and Codex show the model `structuredContent`, not the text block. Pass `structuredSummary: 'full'` only when later summary lines carry information that isn't in the payload. Element lists go through `presentElements()` (`src/snapshot/present.ts`), which redacts and renders one `@eN` line per element; list the payload key in `textOmit` so the text channel doesn't carry it twice. To add a failure code, extend the `FailureCode` union and the `FAILURES` table in `src/oracle/failures.ts`, and add a row to [Failure codes](docs/tools.md#failure-codes) in `docs/tools.md`. `test/failureCatalog.test.ts` scans only `src/`, so it won't catch a missing doc row.
- **Consent.** Gate side effects with `consumeConsent(consentId, approve, { action, affects })` and, when it isn't approved, return `requireConsent({ action, risk, explain, exactCommand?, affects })` from `src/consent/consent.ts`. Use the same `action` and `affects` in both, because a consent is bound to them. You don't have to handle the user prompt (elicitation on 2025-era clients, `InputRequiredResult` on 2026-07-28, both in `src/server.ts`) or session binding yourself. A new `action` name must be added to `CONSENT_ACTIONS` and classified in `CONSENT_ACTION_TIERS` (the build fails without it, and `test/consentPreapprove.test.ts` checks the list against every `requireConsent` call site). Set `runsCode: true` when the action runs repository- or model-chosen code (a build, a script, a configured command, `xcodebuild` on a model-chosen project): operator pre-approval then also needs `SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1`. If it can be bundled into `test_this_plan`, make sure its step `kind` matches the action name so the plan's sub-step check sees it. Add a row to the consent action table in `docs/concepts.md`.
- **Cancellation.** The server wraps every tool call in `runWithSignal(signal, …)` from `src/lib/abortScope.ts`, and background jobs run inside their own job signal. Code that spawns a process or makes a request reads `currentSignal()`; do not store signals on drivers. Every polling loop calls `throwIfCancelled()` once per iteration and sleeps with `sleepOrCancel(ms)`, never a plain `setTimeout`, so a cancelled call stops at once instead of polling until its deadline (`test/cancelLoops.test.ts`). Use `isAbortError()` so a cancellation returns `CANCELLED` and is never recorded as a failure or an issue.
- **One call stays under 50 s.** Clients time out tool calls (Codex defaults to 60 s), so no call may block longer than 50 s. Anything longer runs as a background job that the agent polls with `qa_job_status` (see [Adding a tool](#1-register-the-tool)). A wait parameter defaults to 45,000 ms and clamps larger values to 50,000 with a note instead of rejecting them, like `qa_wait`, `qa_act` and `qa_test_this` (`MAX_WAIT_TIMEOUT_MS`, `ACT_TIMEOUT_MAX_MS`, `TEST_THIS_WAIT_MAX_MS`, `MAX_JOB_WAIT_MS`).
- **Secrets.** Redact output with `src/lib/redact.ts` (`makeRedactor`, `redactDeep`). Generated flows, suites, and code must go through `src/suite/secretGuard.ts`, which assigns `SWIPIUM_*` placeholders (`secretVarName`) and rejects leaked values (`assertNoSecretLeaks`). Never inline secrets in tests, fixtures, or examples.
- **Files.** Shared JSON under `~/.swipium` and `.swipium/` is written with `writeFileAtomicSync` and guarded by `withFileLock` / `withFileLockAsync` from `src/lib/lockfile.ts`.
- **Processes.** Run commands through `run` / `runBinary` in `src/lib/spawn.ts`: argv arrays only (never a shell string), a default timeout, the current cancellation signal, and a refusal to execute `git` (`assertNoGitScope`), because Git operations are outside Swipium's scope. The few long-lived detached children (emulator, Metro, WebDriverAgent, screen recorders) are spawned directly, also with argv arrays, and are tracked in `src/session/processRegistry.ts` so a later server can reap or adopt them safely.
- **Sensitive mode.** Any new pixel, video, or log capture must return `sensitiveRefusal()` (`src/lib/sensitive.ts`) when the session is in sensitive mode.
- **MCP SDK and schemas.** Swipium uses the MCP SDK v2 packages, `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (2.3.1), and zod 4. Use their public API only: `test/sdkInternalsGate.test.ts` fails on any `._name` member access in `src/` (SDK or zod), and on any mention of the SDK's handler tables. Tool input shapes are zod 4 raw shapes: `z.record(z.string(), value)` (the key schema is required), `z.looseObject({...})` instead of `.passthrough()`, no `_def` or `_zod`. `src/lib/toolSchema.ts` turns each shape into one strict object that both validates the call and produces the advertised JSON, and normalizes that JSON so it stays stable across zod and SDK versions. Check `tools/list` (or `test/toolSchema.test.ts`) when you add an unusual zod type.
- **Environment variables.** Codex passes stdio servers only a small env whitelist plus what `[mcp_servers.swipium]` forwards. A new `process.env` read in `src/` must go into `CODEX_ENV_VARS` in `src/lib/codexEnv.ts` (forwarded by `swipium init codex`) or into the `EXCLUDED` table in `test/codexEnv.test.ts` with a reason; the test fails otherwise. Names that grant approval (`SWIPIUM_CONSENT_PREAPPROVE*`, `SWIPIUM_ALLOW_REMOTE_WDA`) are never forwarded. Document new variables in `README.md`.
- **Scope.** Keep emulator and simulator behavior separate from any real-device work; physical devices must keep failing with `PHYSICAL_DEVICE_UNSUPPORTED`.

## Testing

Tests use [Vitest](https://vitest.dev) and never need a device, emulator, or simulator:

- **In-memory server.** Create the server with `createServer()` from `src/server.ts` and connect a `Client` through `InMemoryTransport.createLinkedPair()` (both from `@modelcontextprotocol/client`), then call tools as a real client would (see `test/publicSurface.test.ts`).
- **Real stdio.** `test/stdioConformance.test.ts` compiles the project into a temp directory (never `./dist`), spawns it as `node <tmp>/dist/index.js` with a fake `adb` on `PATH`, and checks both protocol eras: 2025 through the SDK `Client`, and 2026-07-28 as raw JSON-RPC (`server/discover`, per-request `_meta`, consent via `InputRequiredResult`). It covers stdout purity, stdin EOF shutdown, cancellation and oversized arguments. Extend it when you change anything on the wire.
- **Fake drivers.** `setDriverFactoryForTests()` (`src/session/attach.ts`) injects a fake `Driver`. `test/actFixFake.ts` is a shared harness with a fake Android driver, a UI-dump builder, and a connected client.
- **Isolation.** Set `SWIPIUM_DISABLE_DEVICE_DISCOVERY=1` so a machine with a running emulator doesn't change results, and point `HOME` at a temporary directory for anything that touches `~/.swipium`.

Add a test for every behavior change and every fixed bug.

## Adding a tool

This walkthrough adds a hypothetical `qa_example` tool that reports the foreground app, or relaunches the session's app after the user consents. Read [Conventions](#conventions) first; the skeleton follows them.

### 1. Register the tool

Put it in the `src/tools/` module for its tool family, or in a new module (for example `src/tools/example.ts`):

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { cancelledResult, qaError, qaOk, unknownSessionError } from '../lib/result.js';
import { consumeConsent, requireConsent } from '../consent/consent.js';
import { currentSignal, isAbortError } from '../lib/abortScope.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

export function registerExample(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_example',
    {
      title: 'Foreground check and relaunch',
      description:
        'Report the foreground app (action:"status"), or force-stop and relaunch the session app (action:"relaunch", consent-gated).',
      // A zod raw shape: each key is a top-level parameter.
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['status', 'relaunch']),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId); // typed INVALID_ARGUMENT
      const { driver, blocked } = await getDriver(session);
      if (!driver)
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE', // every code must exist in src/oracle/failures.ts
            nextSteps: ['Call qa_prepare_target first.'],
          })
        );

      if (action === 'status') {
        const foreground = await driver.foregroundOwner();
        return qaOk({ foreground }, `foreground: ${foreground}`);
      }

      const appId = session.appId;
      if (!appId)
        return qaError({
          what: 'This session has no app id to relaunch',
          changedState: false,
          retrySafe: true,
          failureCode: 'INVALID_ARGUMENT',
          nextSteps: ['Call qa_prepare_target (it records the app id), then retry.'],
        });

      // Consent is single-use and bound to action + affects: pass the same values to both calls.
      const affects = { appId };
      const gate = consumeConsent(consentId, approve, { action: 'relaunch_app', affects });
      if (!gate.approved)
        return requireConsent({ action: 'relaunch_app', risk: 'low', affects, explain: `Force-stop and relaunch ${appId}?` });

      try {
        await driver.terminateApp(appId); // drivers read currentSignal() themselves
        if (currentSignal()?.aborted) return cancelledResult(undefined, true);
        await driver.launchApp(appId);
      } catch (e) {
        if (isAbortError(e)) return cancelledResult(undefined, true); // CANCELLED, never a failure
        return qaError({
          what: `Relaunch failed: ${String(e)}`,
          changedState: true,
          retrySafe: true,
          failureCode: 'APP_LAUNCH_FAILED',
          nextSteps: ['Run qa_check_health, then retry.'],
        });
      }
      return qaOk({ relaunched: appId }, `Relaunched ${appId}`);
    },
  );
}
```

Anything that can run past 50 s (a build, an exploration) must start a background job instead, and return its `jobId` at once: see `sessions.createJob` and `runWithSignal(sessions.abortSignal(session, job.jobId), …)` in `src/tools/bundletool.ts`. Side effects on the device or project are also recorded for the report with `sessions.recordMutation` (see `src/tools/network.ts`).

### 2. Make the lockstep edits

In the same change:

1. Add `'qa_example'` to `TOOL_NAMES` in `src/version.ts`, under the group comment it belongs to.
2. Import and call `registerExample(server, sessions)` in `createServer()` in `src/server.ts`, next to its group. A new module directly under `src/tools/` must be imported there, or `test/publicSurface.test.ts` fails.
3. Add the name to exactly one group in `CAPABILITY_GROUPS` (`src/core/capabilityGroups.ts`).
4. Classify it in the `KIND` table in `src/lib/toolAnnotations.ts` (`read`, `write`, `write-idempotent`, or `destructive`; the header explains each). Without an entry, the build fails.
5. In `docs/tools.md`: add one row to the [tool index](docs/tools.md#tool-index) (group, hints, consent, summary), a `### qa_example` section under its group, and update the stated tool count.
6. If you added a failure code, add its row under [Failure codes](docs/tools.md#failure-codes) too.

`test/publicSurface.test.ts` and `test/toolMetadata.test.ts` check most of this. At startup, `assertToolSurface()` in `src/server.ts` refuses to start if a registered tool is missing from `TOOL_NAMES` (or the reverse), or if it isn't in exactly one capability group.

### 3. What the server already does for you

`createServer()` wraps `server.registerTool`, so every tool gets the following without per-tool code:

- **Unknown-argument rejection.** A top-level argument that `inputSchema` doesn't declare returns `INVALID_ARGUMENT` (with `unknownArguments` and `acceptedParameters`) before the handler runs.
- **Argument validation.** Arguments are checked against `z.object(inputSchema).strict()` before the handler runs; a missing, wrong-typed, or out-of-enum argument returns `INVALID_ARGUMENT` with `invalidArguments` (one `path` and `message` per issue). The same strict object produces the advertised `tools/list` schema. Swipium answers `tools/list` and `tools/call` itself through the SDK's public `Server.setRequestHandler`, so never reach into SDK private members (`test/sdkInternalsGate.test.ts` fails on any `._name` access in `src/`).
- **Annotations.** MCP tool annotations come from `toolAnnotations()` in `src/lib/toolAnnotations.ts`.
- **Cancellation scope.** Each call runs inside `runWithSignal(signal, …)` with that call's MCP signal, so `currentSignal()` and `isAbortError()` work anywhere below the handler.
- **Stale-client hints.** Calls to removed tools (`REMOVED_TOOLS`) and legacy call shapes return `STALE_CLIENT` with the replacement call and a restart hint.
- **Project-root note.** When the call resolves a project root through `resolveProjectRoot()`, a successful result gains `rootSource` (and `projectRoot`), plus a text note when the root was only guessed from the server's working directory.
- **Response mode, consent, and tool health.** The session's `compact`/`normal`/`verbose` mode is applied to the text channel, consents minted during the call are bound to its `sessionId`, and tool errors are recorded for `qa_report`. A pending consent is checked against operator pre-approval first, then shown to the user when the client supports form elicitation (`elicitation/create` on 2025-era clients, an `InputRequiredResult` on 2026-07-28), else returned to the model as the portable envelope.

### 4. Test it

Use the shared harness in `test/actFixFake.ts`: `harness()` boots the real server in memory with a fake Android driver, and `start()` opens a session with `appId` set to `com.example.app`.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buttonScreen, FakeDriver, harness, structured } from './actFixFake.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('example');
});
afterAll(async () => {
  await h.close();
});

describe('qa_example', () => {
  it('reports the foreground app', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    const s = structured(await h.call('qa_example', { sessionId: id, action: 'status' }));
    expect(s.foreground).toBe('com.example.app/.MainActivity');
  });

  it('asks for consent before relaunching', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    const first = structured(await h.call('qa_example', { sessionId: id, action: 'relaunch' }));
    expect(first.requiresConsent).toBe(true);
    const second = structured(
      await h.call('qa_example', { sessionId: id, action: 'relaunch', consentId: first.consentId, approve: true }),
    );
    expect(second.relaunched).toBe('com.example.app');
  });

  it('rejects an unknown session with INVALID_ARGUMENT', async () => {
    const s = structured(await h.call('qa_example', { sessionId: 'nope', action: 'status' }));
    expect(s.failureCode).toBe('INVALID_ARGUMENT');
  });
});
```

`harness()` points `HOME` at a temporary directory and sets `SWIPIUM_DISABLE_DEVICE_DISCOVERY=1`, so the test never touches a real device or your `~/.swipium`.

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
