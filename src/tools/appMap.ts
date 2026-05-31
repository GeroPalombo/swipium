// App Knowledge Map MCP tools. Public v1 reads, builds, queries, scopes, and validates the
// durable `.swipium/app-map.json`. Large map data is returned by RESOURCE
// URI (swipium://project/<id>/app-map…) rather than flooded into the text channel; compact,
// structured data is returned inline. All heavy logic lives in src/appMap/*; these are thin.

import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import { buildAppMap, summarizeMap, type BuildMode } from '../appMap/build.js';
import { queryAppMap } from '../appMap/query.js';
import { loadAppMap, loadCodeIndex, validateAppMap, appMapResourceUri, appMapPath, projectId } from '../appMap/store.js';
import { rememberProject, lookupRoot } from '../appMap/projectRegistry.js';
import { detectFramework } from '../context/detect.js';
import type { AppKnowledgeMap, ProjectIdentity } from '../appMap/schema.js';
import type { SerializedGraph } from '../explore/graph.js';
import type { Session, SessionStore } from '../session/store.js';

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
async function rootFor(server: McpServer, sessions: SessionStore, args: { projectRoot?: string; sessionId?: string }): Promise<{ root?: string; session?: Session; hint?: string }> {
  if (args.sessionId) {
    const s = sessions.get(args.sessionId);
    if (!s) return { hint: `Unknown sessionId ${args.sessionId}` };
    return { root: s.root, session: s };
  }
  const resolved = await resolveProjectRoot(server, args.projectRoot);
  if (!resolved.root) return { hint: resolved.hint };
  return { root: resolved.root };
}

function fallbackProject(root: string): ProjectIdentity {
  const fw = detectFramework(root);
  return { root, gitRemote: null, packageName: null, workspaceTarget: null, framework: fw, platforms: fw === 'native-android' ? ['android'] : fw === 'native-ios' ? ['ios'] : ['android', 'ios'] };
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
        'Build or incrementally update the durable App Knowledge Map at .swipium/app-map.json. Runs the framework-aware STATIC scan (Expo Router / React Navigation / native Android manifest / SwiftUI+UIKit / Flutter routes), loads + migrates any existing map, and (with a sessionId in runtime_merge/full mode) MERGES the latest exploration screen graph into runtime topology — linking runtime screens to static screens. Returns a compact summary + the map resource URI; the full map is read via qa_app_map_read or the resource. Does NOT commit the file.',
      inputSchema: {
        projectRoot: z.string().optional().describe('Absolute project root. Omit to use a session root or the MCP workspace root.'),
        sessionId: z.string().optional().describe('Reuse a session (its root + latest exploration graph).'),
        mode: z.enum(['static_only', 'runtime_merge', 'full']).optional().describe('static_only: code scan only; runtime_merge: merge the session exploration graph only; full (default): both.'),
        includeCodeIndex: z.boolean().optional().describe('Persist a code symbol index for queries (default true).'),
        forceRescan: z.boolean().optional().describe('Re-run the static scan even if an up-to-date map exists (default false).'),
      },
      outputSchema: { ok: z.boolean(), appMapUri: z.string().optional(), staticScreens: z.number().optional(), runtimeScreens: z.number().optional() },
    },
    async ({ projectRoot, sessionId, mode, includeCodeIndex, forceRescan }) => {
      const { root, session, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot="/abs/path" or a valid sessionId.'], clientHint: hint });
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
          (merge ? `merge: +${merge.newRuntimeScreens} new, ~${merge.updatedRuntimeScreens} updated, ${merge.linkedScreens} linked, ${merge.unmappedRuntimeScreens} unmapped\n` : '') +
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
            migration: res.migration ? { migratedFrom: res.migration.migratedFrom, applied: res.migration.applied } : null,
            summary,
          },
          text,
        );
      } catch (e) {
        return qaError({ what: `App map build failed: ${String(e)}`, changedState: false, retrySafe: true, nextSteps: ['Check the project root is a supported mobile project.'] });
      }
    },
  );

  // ------------------------------------------------------------------- read
  server.registerTool(
    'qa_app_map_read',
    {
      title: 'Read the app knowledge map',
      description:
        'Return a COMPACT section of the app map (default summary). Sections: summary | screens | features | auth | automation | testSuite | full. Pass featureId or screenId to drill into one node. The full map and large sections are returned by resource URI to protect context — fetch it with qa_get_artifact / the resource when you need everything.',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        section: z.enum(['summary', 'screens', 'features', 'auth', 'automation', 'testSuite', 'full']).optional(),
        featureId: z.string().optional(),
        screenId: z.string().optional(),
      },
      outputSchema: { ok: z.boolean(), appMapUri: z.string().optional(), section: z.string().optional() },
    },
    async ({ projectRoot, sessionId, section, featureId, screenId }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      remember(root);
      const map = readExistingMap(root);
      if (!map) return qaError({ what: 'No app map yet', changedState: false, retrySafe: true, nextSteps: ['Run qa_app_map_build first.'], failureCode: 'NO_APP_MAP' });
      const uri = appMapResourceUri(root);
      const sec = section ?? 'summary';

      if (featureId) {
        const f = map.features.find((x) => x.id === featureId);
        if (!f) return qaError({ what: `Unknown featureId ${featureId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_app_map_read { section:"features" } to list ids.'] });
        return qaOk({ appMapUri: uri, section: 'feature', feature: f, featureResourceUri: `${uri}/feature/${featureId}` }, `feature ${f.title} — ${f.testCoverage} coverage, ${f.status}, confidence ${f.confidence}`);
      }
      if (screenId) {
        const s = map.staticTopology.screens.find((x) => x.id === screenId);
        const r = map.runtimeTopology.screens.find((x) => x.id === screenId);
        if (!s && !r) return qaError({ what: `Unknown screenId ${screenId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_app_map_read { section:"screens" } to list ids.'] });
        return qaOk({ appMapUri: uri, section: 'screen', staticScreen: s ?? null, runtimeScreen: r ?? null, screenResourceUri: `${uri}/screen/${screenId}` }, `screen ${screenId}`);
      }

      switch (sec) {
        case 'summary':
          return qaOk({ appMapUri: uri, section: sec, summary: summarizeMap(map) }, `app map summary (${map.staticTopology.screens.length} static / ${map.runtimeTopology.screens.length} runtime screens). Full map: ${uri}`);
        case 'screens':
          return qaOk(
            {
              appMapUri: uri,
              section: sec,
              staticScreens: map.staticTopology.screens.map((s) => ({ id: s.id, name: s.name, route: s.route, kind: s.kind, confidence: s.confidence })),
              runtimeScreens: map.runtimeTopology.screens.map((r) => ({ id: r.id, title: r.title, visits: r.visits, linkedStaticScreenId: r.linkedStaticScreenId, unmapped: r.unmapped, locatorReadiness: r.locatorReadiness })),
              unvisitedStaticScreens: map.runtimeTopology.unvisitedStaticScreens,
            },
            `${map.staticTopology.screens.length} static / ${map.runtimeTopology.screens.length} runtime screens; ${map.runtimeTopology.unvisitedStaticScreens.length} unvisited`,
          );
        case 'features':
          return qaOk({ appMapUri: uri, section: sec, features: map.features }, `${map.features.length} features`);
        case 'auth':
          return qaOk({ appMapUri: uri, section: sec, auth: map.auth, onboarding: map.onboarding, paywalls: map.paywalls }, `auth=${map.auth.hasAuth} onboarding=${!!map.onboarding} paywalls=${map.paywalls.length}`);
        case 'automation':
          return qaOk({ appMapUri: uri, section: sec, automation: map.automation }, `${map.automation.suites.length} suite(s), ${map.automation.flows.length} flow(s)`);
        case 'testSuite':
          return qaOk({ appMapUri: uri, section: sec, testSuite: map.testSuite }, `${map.testSuite.cases.length} test case(s)`);
        case 'full':
        default:
          // Protect context: point at the resource instead of inlining the whole map.
          return qaOk({ appMapUri: uri, section: 'full', summary: summarizeMap(map), note: 'Full map omitted from text to protect context — read the appMapUri resource for everything.' }, `Full map at resource: ${uri}`);
      }
    },
  );
  // ------------------------------------------------------------------ query
  server.registerTool(
    'qa_app_map_query',
    {
      title: 'Query the app knowledge map',
      description:
        'Search the feature index, static topology, runtime graph, and tests for a natural-language query (e.g. "checkout flow"). Returns ranked results with provenance, confidence, source files, screens, and the recommended next Swipium tool call for each. Pass intent to bias the search.',
      inputSchema: {
        query: z.string(),
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        intent: z.enum(['feature', 'screen', 'code', 'test', 'freeform']).optional(),
        limit: z.number().optional(),
      },
      outputSchema: { ok: z.boolean(), total: z.number().optional() },
    },
    async ({ query, projectRoot, sessionId, intent, limit }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      remember(root);
      const map = readExistingMap(root);
      if (!map) return qaError({ what: 'No app map yet', changedState: false, retrySafe: true, nextSteps: ['Run qa_app_map_build first.'], failureCode: 'NO_APP_MAP' });
      const codeIndex = loadCodeIndex(root);
      const out = queryAppMap(map, codeIndex, { query, intent, limit });
      const top = out.results.slice(0, 5).map((r, i) => `  ${i + 1}. [${r.type}] ${r.title} (score ${r.score}${r.confidence !== undefined ? `, conf ${r.confidence}` : ''}) → ${r.recommendedNextTool.tool}`).join('\n');
      return qaOk({ ...out, appMapUri: appMapResourceUri(root) }, `🔎 "${query}" — ${out.total} result(s)\n${top || '  (no matches)'}`);
    },
  );
  // ----------------------------------------------------------- feature_scope
  server.registerTool(
    'qa_app_map_feature_scope',
    {
      title: 'Scope testing to a feature',
      description:
        'Resolve a feature (by featureId or free-text query) to a focused test scope: its source files, static + runtime screens, current coverage, blockers, and a recommended Swipium plan.',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        featureId: z.string().optional(),
        query: z.string().optional().describe('Free-text feature description, e.g. "checkout flow".'),
      },
      outputSchema: { ok: z.boolean(), featureId: z.string().optional() },
    },
    async ({ projectRoot, sessionId, featureId, query }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      remember(root);
      const map = readExistingMap(root);
      if (!map) return qaError({ what: 'No app map yet', changedState: false, retrySafe: true, nextSteps: ['Run qa_app_map_build first.'], failureCode: 'NO_APP_MAP' });

      let features = map.features;
      if (featureId) {
        features = map.features.filter((f) => f.id === featureId);
        if (!features.length) return qaError({ what: `Unknown featureId ${featureId}`, changedState: false, retrySafe: true, nextSteps: ['List ids with qa_app_map_read { section:"features" }.'] });
      } else if (query) {
        const out = queryAppMap(map, loadCodeIndex(root), { query, intent: 'feature', limit: 5 });
        const ids = new Set(out.results.filter((r) => r.type === 'feature').map((r) => r.id));
        features = map.features.filter((f) => ids.has(f.id));
        if (!features.length) return qaError({ what: `No feature matched "${query}"`, changedState: false, retrySafe: true, nextSteps: ['Try qa_app_map_query for broader matches, or qa_app_map_build to refresh.'] });
      } else {
        return qaError({ what: 'Provide one of: featureId or query', changedState: false, retrySafe: true, nextSteps: ['e.g. qa_app_map_feature_scope { query:"login" }'] });
      }

      const scope = features.map((f) => {
        const staticScreens = f.staticScreens.map((id) => map.staticTopology.screens.find((s) => s.id === id)).filter(Boolean).map((s) => ({ id: s!.id, name: s!.name, route: s!.route, sourceFiles: s!.sourceFiles }));
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
            args: { mode: 'execute', goal: recommendedGoal, goalText: f.title, explore: true, ...(needsCreds ? { stopOnNeedsInput: true } : {}) },
            why: needsCreds ? `Drive "${f.title}"; will stop for test credentials (fixture) — ${f.testCoverage} coverage today` : `Drive "${f.title}" with focused exploration — ${f.testCoverage} coverage today`,
          },
        };
      });

      const text =
        `scope: ${scope.length} feature(s)\n` +
        scope.map((s) => `  • ${s.title} [${s.testCoverage}] — ${s.staticScreens.length} screen(s), ${s.sourceFiles.length} file(s)${s.blockers.length ? ` · blockers: ${s.blockers.join(', ')}` : ''}\n    → ${s.recommendedPlan.tool} ${JSON.stringify(s.recommendedPlan.args)}`).join('\n');
      return qaOk({ appMapUri: appMapResourceUri(root), featureId: scope[0]?.featureId, scope }, text);
    },
  );

  // --------------------------------------------------------------- validate
  server.registerTool(
    'qa_app_map_validate',
    {
      title: 'Validate the app knowledge map',
      description:
        'Validate the app map: schema version, provenance completeness, missing/dangling links, duplicate ids, impossible states (e.g. covered-without-runtime), and (optionally) stale source fingerprints. Returns errors + warnings with codes. Use before trusting an old map for feature-focused testing.',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        checkFingerprint: z.boolean().optional().describe('Also re-hash fingerprinted source files to detect a stale map (default false).'),
      },
      outputSchema: { ok: z.boolean(), valid: z.boolean().optional(), errors: z.number().optional(), warnings: z.number().optional() },
    },
    async ({ projectRoot, sessionId, checkFingerprint }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      remember(root);
      const map = readExistingMap(root);
      if (!map) return qaError({ what: 'No app map yet', changedState: false, retrySafe: true, nextSteps: ['Run qa_app_map_build first.'], failureCode: 'NO_APP_MAP' });
      const v = validateAppMap(map, { checkFingerprint, root });
      const text =
        `${v.ok ? '✅' : '❌'} app map ${v.ok ? 'valid' : 'INVALID'} — ${v.errors} error(s), ${v.warnings} warning(s)\n` +
        v.issues.slice(0, 12).map((i) => `  ${i.severity === 'error' ? '✗' : '⚠'} ${i.code}: ${i.detail}`).join('\n');
      return qaOk({ valid: v.ok, errors: v.errors, warnings: v.warnings, issues: v.issues, appMapUri: appMapResourceUri(root) }, text);
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
