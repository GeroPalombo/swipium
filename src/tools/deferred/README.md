# Deferred tools (not part of the public surface)

These modules are pre-1.5.0 public-surface tools kept for potential revival:

- `seed.ts` — `qa_seed` (declared fixture seeding as its own tool; seeding now runs through state profiles and flows).
- `permissions.ts` — `qa_permissions` (runtime-permission list/grant/revoke; now covered by state profiles and `qa_app_control` workflows).
- `screenInfo.ts` — `qa_screen_info` (screen metrics; now folded into `qa_device_info` / coordinate-space metadata on visual results).
- `locator.ts` — `qa_locator_suggest` (locator scoring; now covered by `qa_flow_repair` and the generation audits).

They are **excluded from the build** (`tsconfig.json` `exclude`; eslint still parses them syntactically), are not imported by
`src/server.ts`, must not appear in `TOOL_NAMES` (`src/version.ts`), and do not ship in `dist/` or the npm tarball.
`test/publicSurface.test.ts` enforces all of this: their tool names are on the forbidden-tools denylist, and every
`.ts` file directly under `src/tools/` (this directory excluded) must be imported by `server.ts`.

Before reviving one: its consent/policy assumptions may be stale — re-check the consent gating (`requireConsent`/
`consumeConsent` action names and `affects` payloads), sensitive-mode behavior, and error envelopes (`failureCode`
is now mandatory) against the current policy in `THREAT_MODEL.md` and `src/consent/consent.ts`, then add the tool
back to `TOOL_NAMES`, `CAPABILITY_GROUPS`, `src/server.ts`, `docs/tools.md`, and the lockstep tests.
