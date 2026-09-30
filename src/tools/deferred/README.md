# Deferred tools (not part of the public surface)

These modules were public tools before 1.5.0. They are kept in case one is revived, but they do not ship.

| Module | Former tool | What covers it now |
| --- | --- | --- |
| `seed.ts` | `qa_seed` (run a fixture's `seed` spec as its own tool) | The `seed` step in flows (`src/flows/seedExec.ts`), and state profiles in `qa_flow_compile` fresh-state replay (`src/state/profile.ts`). |
| `permissions.ts` | `qa_permissions` (list, grant, or revoke Android runtime permissions) | State profiles (`permissions` in `src/state/profile.ts`), `qa_ios` `privacy_reset` on iOS, and `qa_app_control` `clear_data` / `fresh_start`, which reset permissions along with app data. |
| `screenInfo.ts` | `qa_screen_info` (screen size, density, orientation) | `qa_device_info`, and the `coordinateSpace` metadata on `qa_visual` results. |
| `locator.ts` | `qa_locator_suggest` (score locators and grade automation readiness) | `qa_flow_repair` and the locator audits in generation (`src/oracle/locator.ts`, `swipium suite lint`). |

## How they are kept out

- `tsconfig.json` excludes `src/tools/deferred`, so these files are not type-checked or compiled and never reach `dist/` or the npm package. ESLint still lints them.
- `src/server.ts` does not import them, and their names are not in `TOOL_NAMES` (`src/version.ts`).
- `test/publicSurface.test.ts` lists their tool names as forbidden, and requires every `.ts` file directly under `src/tools/` (not this directory) to be imported by `server.ts`.
- `test/failureCatalog.test.ts` skips this directory when it checks failure codes.

## Reviving one

Because these files are not compiled, they may no longer build against the current code. Before reviving one:

1. Move it back to `src/tools/`, fix its imports, and register it in `src/server.ts`.
2. Recheck it against current policy: consent gating (`requireConsent` / `consumeConsent` action names and `affects`, see `src/consent/consent.ts`), sensitive mode, cancellation (`src/lib/abortScope.ts`), and error envelopes (every error needs a `failureCode` from `src/oracle/failures.ts`). `THREAT_MODEL.md` describes the policy.
3. Update the whole tool surface together: `TOOL_NAMES`, `CAPABILITY_GROUPS`, `src/lib/toolAnnotations.ts`, `docs/tools.md` (row and count), and remove the name from the forbidden list in `test/publicSurface.test.ts`. See "The public tool surface moves in lockstep" in `CONTRIBUTING.md`.
