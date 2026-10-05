// qa_start_session: resolve projectRoot (src/context/projectRoot.ts) and open a session.

import { z } from 'zod';
import { loadProjectFixtures } from '../fixtures/load.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { resolveProjectRoot, unresolvedProjectRootError } from '../context/projectRoot.js';
import { loadProjectConfig } from '../cli/scan.js';
import { SWIPIUM_VERSION, TOOL_COUNT } from '../version.js';
import { getSchemaHash } from '../lib/schemaHash.js';
import { BUDGET_PROFILES, type Fixture, type SessionStore } from '../session/store.js';

/** Full fixture shape. The tool's inputSchema advertises only `{ name, …passthrough }` (the nested
 *  seed/cleanup/fields schema tripled the tool's size in tools/list); fixtures are validated
 *  against this schema in the handler and rejected with INVALID_ARGUMENT, so nothing is lost. */
export const FIXTURE_SCHEMA = z.object({
  name: z.string(),
  description: z.string().optional(),
  requiredState: z.string().optional(),
  recommendedSetup: z.string().optional(),
  testAccount: z.string().optional(),
  apkPath: z.string().optional(),
  value: z.string().optional().describe('Non-secret safe test input (e.g. flight number/search term) for exploration text entry.'),
  disposable: z.boolean().optional().describe('True only for disposable accounts/data that destructive QA may mutate or delete.'),
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
});

// Moved to src/fixtures/load.ts (store.ts re-reads it on rehydrate); re-exported for callers.
export { loadProjectFixtures } from '../fixtures/load.js';

export function registerStartSession(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_start_session',
    {
      title: 'Start a QA session',
      description:
        'Open a QA session for the low-level tools (qa_test_this makes its own). projectRoot defaults to MCP roots > ' +
        'SWIPIUM_PROJECT_ROOT > CLAUDE_PROJECT_DIR > a project-like cwd. Default budget: 8 min / 20 actions / 8 screenshots ' +
        '(profile or budget changes it). fixtures declare preconditions so unmet ones report blocked, not failed.',
      inputSchema: {
        projectRoot: z.string().optional().describe('Absolute app path.'),
        responseMode: z
          .enum(['compact', 'normal', 'verbose'])
          .optional()
          .describe('Output detail: compact (summary + URIs), normal (default, + JSON), verbose (all JSON, element objects).'),
        sensitive: z.boolean().optional().describe('Refuse all screenshots, recordings, and on-screen evidence.'),
        profile: z.enum(['guardrail', 'login_smoke', 'full_smoke', 'install_smoke']).optional().describe('Budget class.'),
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
          .array(z.object({ name: z.string() }).passthrough())
          .optional()
          .describe('Preconditions, merged with .swipium/fixtures.json: {name, requiredState?, ...} (docs/tools.md#qa_start_session).'),
      },
    },
    async ({ projectRoot, profile, budget, fixtures, responseMode, sensitive }) => {
      const parsedFixtures = z.array(FIXTURE_SCHEMA).optional().safeParse(fixtures);
      if (!parsedFixtures.success)
        return qaError({
          what: `Invalid fixtures: ${parsedFixtures.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          changedState: false,
          retrySafe: true,
          failureCode: 'INVALID_ARGUMENT',
          nextSteps: ['Fix the fixture shape (see docs/tools.md#qa_start_session) and re-call qa_start_session.'],
        });
      const resolved = await resolveProjectRoot(server, projectRoot);
      if (!resolved.root) {
        return unresolvedProjectRootError(resolved);
      }

      // Budget profile sets recommended minutes; explicit profile sets the budget unless the
      // caller also gave maxMinutes. Warn when the resulting time budget is below the class min.
      const profileMinutes = profile ? BUDGET_PROFILES[profile] : undefined;
      const effBudget = { ...(budget ?? {}) };
      if (profileMinutes != null && effBudget.maxMinutes == null) effBudget.maxMinutes = profileMinutes;
      const warnings: string[] = [];
      if (profileMinutes != null && effBudget.maxMinutes != null && effBudget.maxMinutes < profileMinutes) {
        warnings.push(
          `Requested ${effBudget.maxMinutes}m is below the ${profile} class (${profileMinutes}m), likely too short; consider raising maxMinutes.`,
        );
      }

      // Surface a prior `swipium scan` (.swipium/config.json) so the agent knows the
      // recommended profile / appId without re-scanning. Informational only, never auto-overrides
      // an explicit profile choice.
      const projectConfig = loadProjectConfig(resolved.root);
      if (projectConfig && !profile && typeof projectConfig.recommendedProfile === 'string') {
        warnings.push(`swipium scan recommends profile "${projectConfig.recommendedProfile}" for this project (pass profile= to apply).`);
      }

      // Merge declared fixtures: project file first, then the call arg (arg can override by name).
      const fileFixtures = loadProjectFixtures(resolved.root);
      const byName = new Map<string, Fixture>();
      for (const f of fileFixtures) byName.set(f.name, f);
      for (const f of parsedFixtures.data ?? []) byName.set(f.name, f as Fixture);
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
        `Session ${session.id} started (Swipium v${SWIPIUM_VERSION}, ${TOOL_COUNT} tools; if your client lists fewer, restart it).\n` +
          `projectRoot: ${session.root} (via ${resolved.source})\n` +
          `budget: ${JSON.stringify(session.budget)}${profile ? ` (profile=${profile})` : ''}\n` +
          (mergedFixtures.length ? `preconditions declared: ${mergedFixtures.map((f) => f.name).join(', ')}\n` : '') +
          (warnings.length ? `⚠ ${warnings.join(' ')}` : ''),
      );
    },
  );
}
