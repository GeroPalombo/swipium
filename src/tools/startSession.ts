// qa_start_session — resolve projectRoot (roots → arg → ask) and open a session.

import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import { loadProjectConfig } from '../cli/scan.js';
import { SWIPIUM_VERSION, TOOL_COUNT } from '../version.js';
import { getSchemaHash } from '../lib/schemaHash.js';
import { BUDGET_PROFILES, type Fixture, type SessionStore } from '../session/store.js';

/** Load declared fixtures from <root>/.swipium/fixtures.json (best-effort, array or {fixtures:[]}). */
export function loadProjectFixtures(root: string): Fixture[] {
  const p = join(root, '.swipium', 'fixtures.json');
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.fixtures) ? raw.fixtures : [];
    return arr.filter((f: unknown) => f && typeof (f as Fixture).name === 'string') as Fixture[];
  } catch {
    return [];
  }
}

export function registerStartSession(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_start_session',
    {
      title: 'Start a QA session',
      description:
        'Resolve the project root and open a QA session. Resolution order: MCP workspace roots → explicit `projectRoot` arg → ask. NEVER uses the server cwd. A session enforces a BUDGET (default: 8 min / 20 actions / 8 screenshots / 3 snapshot-failures / 3 no-change-actions). Pass `profile` to size the time budget to the workflow (guardrail 8m / login_smoke 10m / full_smoke 15m / install_smoke 20m) — Swipium WARNS if your explicit budget is likely too low. Pass `fixtures` (or add .swipium/fixtures.json) to declare preconditions so unmet ones report as blocked-with-setup, not failures. Pass `responseMode` (compact|normal|verbose) to control transcript size: compact drops the duplicated JSON from the text channel (structured data is unchanged) — recommended for long smoke runs. Call this before snapshot/act tools.',
      inputSchema: {
        projectRoot: z.string().optional().describe('Absolute path to the app project. Optional if the client exposes a workspace root.'),
        responseMode: z
          .enum(['compact', 'normal', 'verbose'])
          .optional()
          .describe(
            'Text-channel verbosity for every tool in this session. compact = summary + artifact URIs only (structuredContent stays full); normal (default) = summary + JSON; verbose = everything.',
          ),
        sensitive: z
          .boolean()
          .optional()
          .describe(
            'Sensitive mode: refuse all screenshots, screen recordings, and on-screen-error evidence capture for this session (no pixels leave the device). For privacy-sensitive apps.',
          ),
        profile: z
          .enum(['guardrail', 'login_smoke', 'full_smoke', 'install_smoke'])
          .optional()
          .describe('Budget class — sizes the time budget to the intended workflow.'),
        budget: z
          .object({
            maxMinutes: z.number().optional(),
            maxActions: z.number().optional(),
            maxScreenshots: z.number().optional(),
            maxSnapshotFailures: z.number().optional(),
            maxNoChangeActions: z.number().optional(),
          })
          .optional()
          .describe('Override default budget caps.'),
        fixtures: z
          .array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              requiredState: z.string().optional(),
              recommendedSetup: z.string().optional(),
              testAccount: z.string().optional(),
              apkPath: z.string().optional(),
              value: z
                .string()
                .optional()
                .describe('Non-secret safe test input (e.g. flight number/search term) for exploration text entry.'),
              disposable: z
                .boolean()
                .optional()
                .describe('True only for disposable accounts/data that destructive QA may mutate or delete.'),
              environment: z.string().optional().describe('Environment label. Use "test" for non-production disposable test state.'),
              fields: z
                .record(
                  z.object({
                    value: z.string().optional(),
                    var: z.string().optional().describe('Environment/secure-input variable name to read at runtime.'),
                    secret: z.boolean().optional(),
                    generator: z
                      .enum([
                        'email',
                        'email_address',
                        'person',
                        'person_name',
                        'full_name',
                        'display_name',
                        'number',
                        'numeric',
                        'text',
                        'city',
                        'city_name',
                        'country',
                        'country_name',
                        'color',
                        'phone',
                        'phone_number',
                        'mobile',
                        'date',
                        'date_iso',
                      ])
                      .optional(),
                    role: z.string().optional(),
                    inputType: z.string().optional(),
                  }),
                )
                .optional()
                .describe(
                  'Typed fixture catalog for form entry. Fields match by label/id/role and may use a fixed value, variable, or safe generator.',
                ),
              seed: z
                .object({
                  type: z.enum(['deeplink', 'script', 'api']),
                  url: z.string().optional(),
                  command: z
                    .union([z.string(), z.array(z.string())])
                    .optional()
                    .describe('script: argv array preferred (string is deprecated).'),
                  method: z.string().optional(),
                  body: z.string().optional(),
                  headers: z.record(z.string()).optional(),
                  idempotent: z.boolean().optional().describe('True when re-running this seed safely converges to the same state.'),
                  cleanup: z
                    .object({
                      type: z.enum(['deeplink', 'script', 'api']),
                      url: z.string().optional(),
                      command: z
                        .union([z.string(), z.array(z.string())])
                        .optional()
                        .describe('script: argv array preferred (string is deprecated).'),
                      method: z.string().optional(),
                      body: z.string().optional(),
                      headers: z.record(z.string()).optional(),
                    })
                    .optional()
                    .describe('Optional teardown/rollback action used for state-profile transactions.'),
                })
                .optional()
                .describe('Opt-in, consent-gated way to create this precondition during flows.'),
            }),
          )
          .optional()
          .describe('Declared preconditions/fixtures this run needs (merged with .swipium/fixtures.json).'),
      },
    },
    async ({ projectRoot, profile, budget, fixtures, responseMode, sensitive }) => {
      const resolved = await resolveProjectRoot(server, projectRoot);
      if (!resolved.root) {
        return qaError({
          what: 'Could not resolve a project root',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Re-call qa_start_session with projectRoot="/absolute/path/to/app"'],
          clientHint: resolved.hint,
        });
      }

      // Budget profile → recommended minutes; explicit profile sets the budget unless the
      // caller also gave maxMinutes. Warn when the resulting time budget is below the class min.
      const profileMinutes = profile ? BUDGET_PROFILES[profile] : undefined;
      const effBudget = { ...(budget ?? {}) };
      if (profileMinutes != null && effBudget.maxMinutes == null) effBudget.maxMinutes = profileMinutes;
      const warnings: string[] = [];
      if (profileMinutes != null && effBudget.maxMinutes != null && effBudget.maxMinutes < profileMinutes) {
        warnings.push(
          `Requested ${effBudget.maxMinutes}m is below the ${profile} class (${profileMinutes}m) — likely too short; consider raising maxMinutes.`,
        );
      }

      // Surface a prior `swipium scan` (.swipium/config.json) so the agent knows the
      // recommended profile / appId without re-scanning. Informational — never auto-overrides
      // an explicit profile choice.
      const projectConfig = loadProjectConfig(resolved.root);
      if (projectConfig && !profile && typeof projectConfig.recommendedProfile === 'string') {
        warnings.push(`swipium scan recommends profile "${projectConfig.recommendedProfile}" for this project (pass profile= to apply).`);
      }

      // Merge declared fixtures: project file first, then the call arg (arg can override by name).
      const fileFixtures = loadProjectFixtures(resolved.root);
      const byName = new Map<string, Fixture>();
      for (const f of fileFixtures) byName.set(f.name, f);
      for (const f of fixtures ?? []) byName.set(f.name, f as Fixture);
      const mergedFixtures = [...byName.values()];

      const session = sessions.create(resolved.root, effBudget, {
        fixtures: mergedFixtures,
        budgetProfile: profile,
        responseMode,
        sensitive,
      });
      // Fix 8: durably register this project so its app-map resource URI resolves across restarts.
      try {
        const { rememberProject } = await import('../appMap/projectRegistry.js');
        rememberProject(session.root, { packageName: typeof projectConfig?.appId === 'string' ? projectConfig.appId : null });
      } catch {
        /* best-effort */
      }
      return qaOk(
        {
          sessionId: session.id,
          swipiumVersion: SWIPIUM_VERSION,
          schemaHash: getSchemaHash(),
          toolCount: TOOL_COUNT,
          projectRoot: session.root,
          rootSource: resolved.source,
          artifactsDir: session.dir,
          budget: session.budget,
          budgetProfile: profile ?? null,
          responseMode: session.responseMode,
          sensitive: session.sensitive,
          scan: projectConfig
            ? {
                recommendedProfile: projectConfig.recommendedProfile ?? null,
                appId: projectConfig.appId ?? null,
                readiness: projectConfig.readiness ?? null,
              }
            : null,
          declaredPreconditions: mergedFixtures,
          warnings,
        },
        `Session ${session.id} started (Swipium v${SWIPIUM_VERSION}, ${TOOL_COUNT} tools — if your client lists fewer, restart it).\n` +
          `projectRoot: ${session.root} (via ${resolved.source})\n` +
          `budget: ${JSON.stringify(session.budget)}${profile ? ` (profile=${profile})` : ''}\n` +
          (mergedFixtures.length ? `preconditions declared: ${mergedFixtures.map((f) => f.name).join(', ')}\n` : '') +
          (warnings.length ? `⚠ ${warnings.join(' ')}` : ''),
      );
    },
  );
}
