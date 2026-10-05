// App Knowledge Map MCP tools. Public v1 reads, builds, queries, and scopes the
// durable `.swipium/app-map.json`. Large map data is returned by RESOURCE
// URI (swipium://project/<id>/app-map…) rather than flooded into the text channel; compact,
// structured data is returned inline. All heavy logic lives in src/appMap/*; these are thin.

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { qaNeedsInput } from '../lib/needsInput.js';
import { resolveProjectRoot, unresolvedProjectRootError } from '../context/projectRoot.js';
import { buildAppMap, summarizeMap, type BuildMode } from '../appMap/build.js';
import { queryAppMap } from '../appMap/query.js';
import {
  loadAppMap,
  loadCodeIndex,
  saveAppMap,
  saveIndexes,
  withAppMapLock,
  appMapResourceUri,
  appMapPath,
  projectId,
} from '../appMap/store.js';
import { addProvenance, makeProvenance, recomputeConfidence } from '../appMap/provenance.js';
import { rememberProject, lookupRoot } from '../appMap/projectRegistry.js';
import { resolveFeatureContext } from './featureTesting.js';
import { detectFramework } from '../context/detect.js';
import type { AppKnowledgeMap, ProjectIdentity } from '../appMap/schema.js';
import type { SerializedGraph } from '../explore/graph.js';
import { encodeUriSegment, type Session, type SessionStore } from '../session/store.js';

// projectId(root) is a one-way hash, so resource reads need a reverse lookup. We remember every root
// touched this session (in-memory) AND in a DURABLE registry (~/.swipium/projects.json, Fix 8) so a
// resource URI stays resolvable across server restarts. The resource handler also falls back to live
// sessions for roots that predate the durable registry.
const projectRegistry = new Map<string, string>();
function remember(root: string): void {
  projectRegistry.set(projectId(root), root);
  rememberProject(root, { framework: detectFramework(root) });
}

export function resolveAppMapRoot(id: string, sessions: SessionStore): string | undefined {
  const known = projectRegistry.get(id);
  if (known) return known;
  // Durable registry survives restarts (Fix 8).
  const durable = lookupRoot(id);
  if (durable && existsSync(appMapPath(durable.root))) return durable.root;
  for (const s of sessions.list()) {
    if (projectId(s.root) === id) return s.root;
  }
  return durable?.root;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Resolve a project root from an explicit arg or a session. */
async function rootFor(
  server: McpServer,
  sessions: SessionStore,
  args: { projectRoot?: string; sessionId?: string },
): Promise<{ root?: string; session?: Session; hint?: string; error?: CallToolResult }> {
  if (args.sessionId) {
    const s = sessions.get(args.sessionId);
    if (!s) return { error: unknownSessionError(args.sessionId) };
    return { root: s.root, session: s };
  }
  const resolved = await resolveProjectRoot(server, args.projectRoot);
  if (!resolved.root) return { hint: resolved.hint };
  return { root: resolved.root };
}

function fallbackProject(root: string): ProjectIdentity {
  const fw = detectFramework(root);
  return {
    root,
    gitRemote: null,
    packageName: null,
    workspaceTarget: null,
    framework: fw,
    platforms: fw === 'native-android' ? ['android'] : fw === 'native-ios' ? ['ios'] : ['android', 'ios'],
  };
}

/** Read an existing map WITHOUT rescanning. Returns null when no map file exists yet. */
function readExistingMap(root: string): AppKnowledgeMap | null {
  return loadAppMap(root, fallbackProject(root), nowIso()).map;
}

/** Pull the latest serialized explore graph for a session (for runtime_merge). */
function latestExploreGraph(sessions: SessionStore, session: Session | undefined): SerializedGraph | null {
  if (!session?.exploration?.graphUri) return null;
  const found = sessions.findArtifact(session.exploration.graphUri);
  if (!found) return null;
  try {
    return JSON.parse(readFileSync(found.rec.path, 'utf8')) as SerializedGraph;
  } catch {
    return null;
  }
}

export function registerAppMap(server: McpServer, sessions: SessionStore): void {
  // ------------------------------------------------------------------ build
  server.registerTool(
    'qa_app_map_build',
    {
      title: 'Build / update the app knowledge map',
      description:
        'Build or update .swipium/app-map.json: a static scan of routes and screens (Expo Router, React Navigation, Android, ' +
        'SwiftUI/UIKit, Flutter), plus the latest exploration graph when sessionId is given.',
      inputSchema: {
        projectRoot: z.string().optional().describe('Default: the session or resolved project root.'),
        sessionId: z.string().optional().describe('Adds its latest exploration graph.'),
        mode: z.enum(['static_only', 'runtime_merge', 'full']).optional().describe('static_only | runtime_merge | full (default).'),
        includeCodeIndex: z.boolean().optional().describe('Persist a code symbol index (default true).'),
        forceRescan: z.boolean().optional().describe('Re-scan even if the map is current.'),
      },
      // NOTE: no outputSchema. A declared (closed) output schema makes strict MCP clients
      // reject BOTH the rich qaOk payload and the qaError envelope as "additional properties"
      // (caught by test/errorContract.test.ts). structuredContent stays self-describing.
    },
    async ({ projectRoot, sessionId, mode, includeCodeIndex, forceRescan }) => {
      const { root, session, hint, error } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return error ?? unresolvedProjectRootError({ source: 'none', hint });
      remember(root);
      const m = (mode ?? 'full') as BuildMode;
      const exploreGraph = m === 'static_only' ? null : latestExploreGraph(sessions, session);
      try {
        const res = buildAppMap(root, { mode: m, at: nowIso(), includeCodeIndex, forceRescan, sessionId, exploreGraph, persist: true });
        const summary = summarizeMap(res.map);
        const merge = res.mergeResult;
        const text =
          `🗺️ app map built (${m}) for ${root}\n` +
          `framework=${res.map.project.framework} router=${res.map.staticTopology.router ?? 'none'} · static screens=${res.map.staticTopology.screens.length} · runtime screens=${res.map.runtimeTopology.screens.length}\n` +
          (merge
            ? `merge: +${merge.newRuntimeScreens} new, ~${merge.updatedRuntimeScreens} updated, ${merge.linkedScreens} linked, ${merge.unmappedRuntimeScreens} unmapped\n`
            : '') +
          `confidence=${res.map.confidence.overall} · features=${res.map.features.length}\n` +
          (Array.isArray(summary.topGaps) && summary.topGaps.length ? `gaps: ${(summary.topGaps as string[]).join('; ')}\n` : '') +
          `appMapUri: ${res.save?.resourceUri}`;
        return qaOk(
          {
            appMapUri: res.save?.resourceUri,
            appMapPath: res.save?.path,
            mode: m,
            rescanned: res.rescanned,
            staticScreens: res.map.staticTopology.screens.length,
            runtimeScreens: res.map.runtimeTopology.screens.length,
            mergeResult: merge ?? null,
            migration: res.migration
              ? {
                  migratedFrom: res.migration.migratedFrom,
                  applied: res.migration.applied,
                  recoveredFrom: res.migration.recoveredFrom ?? null,
                }
              : null,
            summary,
          },
          text,
        );
      } catch (e) {
        return qaError({
          what: `App map build failed: ${String(e)}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Check the project root is a supported mobile project.'],
        });
      }
    },
  );

  // ------------------------------------------------------------------- read
  server.registerTool(
    'qa_app_map_read',
    {
      title: 'Read the app knowledge map',
      description:
        'Read a compact app-map section: summary (default) | screens | features | auth | automation | testSuite | full; ' +
        'featureId or screenId drills into one node. Large sections come back as a resource URI.',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        section: z.enum(['summary', 'screens', 'features', 'auth', 'automation', 'testSuite', 'full']).optional(),
        featureId: z.string().optional(),
        screenId: z.string().optional(),
      },
    },
    async ({ projectRoot, sessionId, section, featureId, screenId }) => {
      const { root, hint, error } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return error ?? unresolvedProjectRootError({ source: 'none', hint });
      remember(root);
      const map = readExistingMap(root);
      if (!map)
        return qaError({
          what: 'No app map yet',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Run qa_app_map_build first.'],
          failureCode: 'NO_APP_MAP',
        });
      const uri = appMapResourceUri(root);
      const sec = section ?? 'summary';

      if (featureId) {
        const f = map.features.find((x) => x.id === featureId);
        if (!f)
          return qaError({
            what: `Unknown featureId ${featureId}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_app_map_read { section:"features" } to list ids.'],
          });
        return qaOk(
          { appMapUri: uri, section: 'feature', feature: f, featureResourceUri: `${uri}/feature/${featureId}` },
          `feature ${f.title}: ${f.testCoverage} coverage, ${f.status}, confidence ${f.confidence}`,
        );
      }
      if (screenId) {
        const s = map.staticTopology.screens.find((x) => x.id === screenId);
        const r = map.runtimeTopology.screens.find((x) => x.id === screenId);
        if (!s && !r)
          return qaError({
            what: `Unknown screenId ${screenId}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_app_map_read { section:"screens" } to list ids.'],
          });
        return qaOk(
          {
            appMapUri: uri,
            section: 'screen',
            staticScreen: s ?? null,
            runtimeScreen: r ?? null,
            screenResourceUri: `${uri}/screen/${screenId}`,
          },
          `screen ${screenId}`,
        );
      }

      switch (sec) {
        case 'summary':
          return qaOk(
            { appMapUri: uri, section: sec, summary: summarizeMap(map) },
            `app map summary (${map.staticTopology.screens.length} static / ${map.runtimeTopology.screens.length} runtime screens). Full map: ${uri}`,
          );
        case 'screens':
          return qaOk(
            {
              appMapUri: uri,
              section: sec,
              staticScreens: map.staticTopology.screens.map((s) => ({
                id: s.id,
                name: s.name,
                route: s.route,
                kind: s.kind,
                confidence: s.confidence,
              })),
              runtimeScreens: map.runtimeTopology.screens.map((r) => ({
                id: r.id,
                title: r.title,
                visits: r.visits,
                linkedStaticScreenId: r.linkedStaticScreenId,
                unmapped: r.unmapped,
                locatorReadiness: r.locatorReadiness,
              })),
              unvisitedStaticScreens: map.runtimeTopology.unvisitedStaticScreens,
            },
            `${map.staticTopology.screens.length} static / ${map.runtimeTopology.screens.length} runtime screens; ${map.runtimeTopology.unvisitedStaticScreens.length} unvisited`,
          );
        case 'features':
          return qaOk({ appMapUri: uri, section: sec, features: map.features }, `${map.features.length} features`);
        case 'auth':
          return qaOk(
            { appMapUri: uri, section: sec, auth: map.auth, onboarding: map.onboarding, paywalls: map.paywalls },
            `auth=${map.auth.hasAuth} onboarding=${!!map.onboarding} paywalls=${map.paywalls.length}`,
          );
        case 'automation':
          return qaOk(
            { appMapUri: uri, section: sec, automation: map.automation },
            `${map.automation.suites.length} suite(s), ${map.automation.flows.length} flow(s)`,
          );
        case 'testSuite':
          return qaOk({ appMapUri: uri, section: sec, testSuite: map.testSuite }, `${map.testSuite.cases.length} test case(s)`);
        case 'full':
        default:
          // Protect context: point at the resource instead of inlining the whole map.
          return qaOk(
            {
              appMapUri: uri,
              section: 'full',
              summary: summarizeMap(map),
              note: 'Full map omitted from text to protect context. Read the appMapUri resource for everything.',
            },
            `Full map at resource: ${uri}`,
          );
      }
    },
  );
  // ------------------------------------------------------------------ query
  server.registerTool(
    'qa_app_map_query',
    {
      title: 'Query the app knowledge map',
      description:
        'Search the app map (features, screens, code, tests) with a natural-language query. Returns ranked results with ' +
        'sources and the suggested next tool call.',
      inputSchema: {
        query: z.string(),
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        intent: z.enum(['feature', 'screen', 'code', 'test', 'freeform']).optional(),
        limit: z.number().optional(),
      },
    },
    async ({ query, projectRoot, sessionId, intent, limit }) => {
      const { root, hint, error } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return error ?? unresolvedProjectRootError({ source: 'none', hint });
      remember(root);
      const map = readExistingMap(root);
      if (!map)
        return qaError({
          what: 'No app map yet',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Run qa_app_map_build first.'],
          failureCode: 'NO_APP_MAP',
        });
      const codeIndex = loadCodeIndex(root);
      const out = queryAppMap(map, codeIndex, { query, intent, limit });
      const top = out.results
        .slice(0, 5)
        .map(
          (r, i) =>
            `  ${i + 1}. [${r.type}] ${r.title} (score ${r.score}${r.confidence !== undefined ? `, conf ${r.confidence}` : ''}) > ${r.recommendedNextTool.tool}`,
        )
        .join('\n');
      return qaOk({ ...out, appMapUri: appMapResourceUri(root) }, `🔎 "${query}": ${out.total} result(s)\n${top || '  (no matches)'}`);
    },
  );
  // ----------------------------------------------------------- feature_scope
  server.registerTool(
    'qa_app_map_feature_scope',
    {
      title: 'Scope testing to a feature',
      description:
        'Resolve a feature (featureId, or a query like "checkout") to a test scope: code, screens, existing tests, coverage ' +
        'gaps, strategy, ranked candidates. Works without a map (code scan). Read-only.',
      inputSchema: {
        projectRoot: z.string().optional().describe('Project root when no session exists.'),
        sessionId: z.string().optional().describe('Adds runtime screen-graph evidence.'),
        featureId: z.string().optional().describe('Exact map feature id (or use query).'),
        query: z.string().optional().describe('e.g. "checkout flow".'),
        platform: z.enum(['android', 'ios']).optional(),
        includeCode: z.boolean().optional().describe('query: scan source code (default true).'),
        limit: z.number().optional().describe('Max items per list (default 8).'),
      },
    },
    async ({ projectRoot, sessionId, featureId, query, platform, includeCode, limit }) => {
      if (!featureId && !query) {
        return qaError({
          what: 'Provide one of: featureId or query',
          failureCode: 'INVALID_ARGUMENT',
          changedState: false,
          retrySafe: true,
          nextSteps: ['e.g. qa_app_map_feature_scope { query:"login" }'],
        });
      }

      // Free-text QUERY path: full feature scoping (app-map-first, code-index + runtime-graph
      // fallback, objective model, candidate disambiguation). Works without an existing map.
      if (!featureId) {
        const r = await resolveFeatureContext(server, sessions, { sessionId, projectRoot, feature: query!, platform, includeCode, limit });
        if (!r.ok) return r.result;
        remember(r.ctx.root);
        const { scopeResult, objective, index } = r.ctx;
        const scope = scopeResult.primary;

        if (!scopeResult.found) {
          return qaOk(
            {
              sessionId: sessionId ?? null,
              query,
              found: false,
              scope,
              searched: scopeResult.searched,
              nextRecommendedAction: {
                tool: 'qa_test_this',
                args: { ...(sessionId ? { sessionId } : { projectRoot: r.ctx.root }), goal: 'explore' },
                why: 'Grow the map with an initial run, then re-scope the feature',
              },
            },
            `🔎 No feature matched "${query}". Searched ${scopeResult.searched.symbols} symbols, ${scopeResult.searched.routes} routes, ${scopeResult.searched.files} files, ${scopeResult.searched.runtimeScreens} runtime screens with terms: ${scopeResult.searched.terms.slice(0, 12).join(', ')}. Run qa_test_this/qa_explore to grow coverage, or refine the feature name.`,
          );
        }

        if (scopeResult.needsInput) {
          return qaNeedsInput(
            {
              needsInput: true,
              kind: 'monorepo_target',
              question: scopeResult.needsInput.question,
              fields: [{ name: 'query', description: 'The exact feature to test', example: scopeResult.candidates[0]?.title }],
              fallbackOptions: scopeResult.needsInput.options,
              resume: { tool: 'qa_app_map_feature_scope', args: {} },
              attempted: [`scoped "${query}" matched ${scopeResult.candidates.length} distinct candidates that tie`],
              ifDeclined: 'Swipium scopes the highest-confidence candidate and records the others as alternatives.',
            },
            { sessionId: sessionId ?? undefined, candidates: scopeResult.candidates },
          );
        }

        const nextRecommendedAction =
          scope.recommendedStrategy === 'manual_blocked'
            ? {
                tool: 'qa_test_feature',
                args: { ...(sessionId ? { sessionId } : { projectRoot: r.ctx.root }), feature: query, mode: 'plan' },
                why: 'Review the plan + setup needed before any automated execution',
              }
            : {
                tool: 'qa_test_feature',
                args: { sessionId: sessionId ?? '${sessionId}', feature: query, mode: 'execute' },
                why: 'Run a focused test of this feature',
              };

        return qaOk(
          {
            sessionId: sessionId ?? null,
            query,
            found: true,
            featureId: scope.featureId,
            scope,
            objective,
            appMapUri: r.ctx.appMapUri,
            mapFeatureId: scopeResult.mapFeatureId ?? null,
            ticketRefs: scopeResult.ticketRefs,
            runtimeSource: scopeResult.runtimeSource,
            candidates: scopeResult.candidates,
            searched: scopeResult.searched,
            codeIndex: { scannedFiles: index.scannedFiles, truncated: index.truncated },
            nextRecommendedAction,
          },
          `🔎 ${scope.title} (confidence ${Math.round(scope.confidence * 100)}%, strategy ${scope.recommendedStrategy}): ` +
            `${scope.staticScreens.length} static screen(s), ${scope.runtimeScreens.length} runtime screen(s), ${scope.functions.length} symbol(s), ${scope.existingTests.length} existing test(s).` +
            (scopeResult.candidates.length > 1 ? ` ${scopeResult.candidates.length} candidate(s).` : ''),
        );
      }

      // FEATURE-ID path: exact map lookup (requires an existing map).
      const { root, hint, error } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return error ?? unresolvedProjectRootError({ source: 'none', hint });
      remember(root);
      const map = readExistingMap(root);
      if (!map)
        return qaError({
          what: 'No app map yet',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Run qa_app_map_build first, or pass query= for map-free scoping.'],
          failureCode: 'NO_APP_MAP',
        });

      const features = map.features.filter((f) => f.id === featureId);
      if (!features.length)
        return qaError({
          what: `Unknown featureId ${featureId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['List ids with qa_app_map_read { section:"features" }, or pass query= for free-text scoping.'],
        });

      const scope = features.map((f) => {
        const staticScreens = f.staticScreens
          .map((id) => map.staticTopology.screens.find((s) => s.id === id))
          .filter(Boolean)
          .map((s) => ({ id: s!.id, name: s!.name, route: s!.route, sourceFiles: s!.sourceFiles }));
        const needsCreds = f.id === 'feature:auth' || f.blockers.some((b) => /credential/i.test(b));
        const recommendedGoal = f.id === 'feature:auth' ? 'test_login' : 'reproduce_bug';
        return {
          featureId: f.id,
          title: f.title,
          objective: f.objective,
          status: f.status,
          confidence: f.confidence,
          riskLevel: f.riskLevel,
          testCoverage: f.testCoverage,
          sourceFiles: f.sourceFiles.slice(0, 12),
          staticScreens,
          runtimeScreens: f.runtimeScreens,
          blockers: f.blockers,
          recommendedPlan: {
            tool: 'qa_test_this',
            args: {
              mode: 'execute',
              goal: recommendedGoal,
              goalText: f.title,
              explore: true,
              ...(needsCreds ? { stopOnNeedsInput: true } : {}),
            },
            why: needsCreds
              ? `Drive "${f.title}"; will stop for test credentials (fixture); ${f.testCoverage} coverage today`
              : `Drive "${f.title}" with focused exploration; ${f.testCoverage} coverage today`,
          },
        };
      });

      const text =
        `scope: ${scope.length} feature(s)\n` +
        scope
          .map(
            (s) =>
              `  • ${s.title} [${s.testCoverage}]: ${s.staticScreens.length} screen(s), ${s.sourceFiles.length} file(s)${s.blockers.length ? ` · blockers: ${s.blockers.join(', ')}` : ''}\n    > ${s.recommendedPlan.tool} ${JSON.stringify(s.recommendedPlan.args)}`,
          )
          .join('\n');
      return qaOk({ appMapUri: appMapResourceUri(root), featureId: scope[0]?.featureId, scope }, text);
    },
  );

  // ----------------------------------------------------------------- update
  server.registerTool(
    'qa_app_map_update',
    {
      title: 'Update the app knowledge map',
      description:
        'Targeted app-map edits without a rebuild: add a note, register test cases, link an automation suite, set the ' +
        "environment, or override a feature's coverage. A matching id/path is overwritten.",
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        note: z.string().optional().describe('A free-text user note added with user_note provenance.'),
        testCases: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              featureId: z.string().optional(),
              screenId: z.string().optional(),
              status: z.string().optional(),
              source: z.string().optional(),
              stale: z.boolean().optional(),
            }),
          )
          .optional(),
        automationSuite: z
          .object({
            name: z.string(),
            path: z.string(),
            framework: z.string().optional(),
            linkedFeatureIds: z.array(z.string()).optional(),
            linkedScreenIds: z.array(z.string()).optional(),
          })
          .optional(),
        environment: z.string().optional().describe("App environment, e.g. 'test' | 'staging'."),
        featureCoverage: z.object({ featureId: z.string(), coverage: z.enum(['none', 'partial', 'covered']) }).optional(),
      },
    },
    async ({ projectRoot, sessionId, note, testCases, automationSuite, environment, featureCoverage }) => {
      const { root, hint, error } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return error ?? unresolvedProjectRootError({ source: 'none', hint });
      remember(root);
      // Synchronous load > mutate > save cycle, held under the cross-process app-map lock (see store.ts).
      return withAppMapLock(root, () => {
        const map = readExistingMap(root);
        if (!map)
          return qaError({
            what: 'No app map yet',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Run qa_app_map_build first.'],
            failureCode: 'NO_APP_MAP',
          });
        const at = nowIso();
        const applied: string[] = [];

        if (note) {
          addProvenance(map, makeProvenance('user_note', at, note, { targetType: 'map' }));
          applied.push('note');
        }
        if (testCases?.length) {
          for (const c of testCases) {
            const existing = map.testSuite.cases.find((x) => x.id === c.id);
            if (existing) Object.assign(existing, c);
            else map.testSuite.cases.push(c);
          }
          addProvenance(map, makeProvenance('test_case', at, `${testCases.length} test case(s) registered`, { targetType: 'test' }));
          applied.push(`testCases(${testCases.length})`);
        }
        if (automationSuite) {
          const existing = map.automation.suites.find((s) => s.path === automationSuite.path);
          if (existing) Object.assign(existing, automationSuite);
          else map.automation.suites.push(automationSuite);
          addProvenance(
            map,
            makeProvenance('test_case', at, `Automation suite ${automationSuite.name} linked`, {
              targetType: 'test',
              refs: [automationSuite.path],
            }),
          );
          applied.push('automationSuite');
        }
        if (environment) {
          map.appIdentity.environment = environment;
          applied.push('environment');
        }
        if (featureCoverage) {
          const f = map.features.find((x) => x.id === featureCoverage.featureId);
          if (!f)
            return qaError({
              what: `Unknown featureId ${featureCoverage.featureId}`,
              changedState: false,
              retrySafe: true,
              nextSteps: ['List ids with qa_app_map_read { section:"features" }.'],
            });
          f.testCoverage = featureCoverage.coverage;
          addProvenance(
            map,
            makeProvenance('user_note', at, `coverage(${f.id})=${featureCoverage.coverage}`, { targetType: 'feature', targetId: f.id }),
          );
          applied.push('featureCoverage');
        }

        if (!applied.length)
          return qaError({
            what: 'No update fields provided',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Pass at least one of: note, testCases, automationSuite, environment, featureCoverage.'],
          });

        map.updatedAt = at;
        map.coverage.staleTests = map.testSuite.cases.filter((c) => c.stale).length;
        recomputeConfidence(map);
        const save = saveAppMap(root, map);
        saveIndexes(root, loadCodeIndex(root), map.features);
        return qaOk({ appMapUri: save.resourceUri, applied }, `app map updated: ${applied.join(', ')}\nappMapUri: ${save.resourceUri}`);
      });
    },
  );
}

/** Resolve a feature/screen/test-suite/full app-map resource read for the MCP resource handler.
 *  Routes through loadAppMap() so an older on-disk shape is MIGRATED before it is served (Fix 8). */
export function readAppMapResource(root: string, sub: { kind?: string; id?: string }): { mimeType: string; text: string } | null {
  const path = appMapPath(root);
  if (!existsSync(path)) return null;
  const loaded = loadAppMap(root, fallbackProject(root), nowIso());
  const map = loaded.map;
  if (!map) return null;
  if (!sub.kind) return { mimeType: 'application/json', text: JSON.stringify(map, null, 2) };
  if (sub.kind === 'feature') {
    const f = map.features.find((x) => x.id === sub.id || x.id === `feature:${sub.id}`);
    return f ? { mimeType: 'application/json', text: JSON.stringify(f, null, 2) } : null;
  }
  if (sub.kind === 'screen') {
    const s = map.staticTopology.screens.find((x) => x.id === sub.id) ?? map.runtimeTopology.screens.find((x) => x.id === sub.id);
    return s ? { mimeType: 'application/json', text: JSON.stringify(s, null, 2) } : null;
  }
  if (sub.kind === 'test-suite') {
    return { mimeType: 'application/json', text: JSON.stringify(map.testSuite, null, 2) };
  }
  return null;
}

/** A resources/list entry (MCP `Resource` minus optional annotations). */
export interface ListedAppMapResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Project roots whose app map can be listed RIGHT NOW: roots touched this server run
 *  (in-memory registry) plus live-session roots, filtered to those with an app map on disk.
 *  Deliberately NOT the durable machine-wide registry. Listing every project ever mapped on
 *  this machine into an unrelated client session would be noise, not discovery. */
function appMapRoots(sessions: SessionStore): string[] {
  const roots = new Set<string>(projectRegistry.values());
  for (const s of sessions.list()) roots.add(s.root);
  return [...roots].filter((r) => existsSync(appMapPath(r)));
}

/** Enumerate the actually-readable app-map resource URIs for the MCP resources/list callbacks.
 * `full`: one complete-map URI per known project; `sections`: the per-feature /
 *  per-screen / test-suite section URIs served by readAppMapResource above (same URI shapes
 *  qa_app_map_read emits). Section ids are percent-encoded (encodeUriSegment) so ids containing
 *  `/`, spaces or `(` still match the `{kind}/{id}` template; the read handlers decode them.
 *  Read-only and never throws: an unparseable map is skipped, and an
 *  empty world lists as []. Caller applies any cap. */
export function listAppMapResources(sessions: SessionStore, which: 'full' | 'sections'): ListedAppMapResource[] {
  const out: ListedAppMapResource[] = [];
  for (const root of appMapRoots(sessions)) {
    try {
      const map = loadAppMap(root, fallbackProject(root), nowIso()).map;
      if (!map) continue;
      const base = appMapResourceUri(root);
      const project = map.appIdentity.appName ?? basename(root);
      if (which === 'full') {
        out.push({
          uri: base,
          name: `app-map (${project})`,
          mimeType: 'application/json',
          description: `Complete app knowledge map for ${root}`,
        });
        continue;
      }
      for (const f of map.features) {
        out.push({
          uri: `${base}/feature/${encodeUriSegment(f.id)}`,
          name: f.title,
          mimeType: 'application/json',
          description: `feature section: ${project}`,
        });
      }
      // Static + runtime screens share the /screen/{id} read path; dedupe on id (static wins).
      const screens = new Map<string, string>();
      for (const s of map.staticTopology.screens) screens.set(s.id, s.name);
      for (const r of map.runtimeTopology.screens) if (!screens.has(r.id)) screens.set(r.id, r.title ?? r.id);
      for (const [id, name] of screens) {
        out.push({
          uri: `${base}/screen/${encodeUriSegment(id)}`,
          name,
          mimeType: 'application/json',
          description: `screen section: ${project}`,
        });
      }
      // The read path ignores {id} for test-suite; "cases" is the listed canonical spelling.
      out.push({
        uri: `${base}/test-suite/cases`,
        name: `test-suite (${project})`,
        mimeType: 'application/json',
        description: `test-suite section: ${map.testSuite.cases.length} cases`,
      });
    } catch {
      // Listing must never throw. A broken map is simply not browsable; reads still error loudly.
    }
  }
  return out;
}
