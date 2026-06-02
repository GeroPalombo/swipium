import { readFileSync } from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionStore } from './session/store.js';
import { registerDoctor } from './tools/doctor.js';
import { registerCapabilities } from './tools/capabilities.js';
import { registerStartSession } from './tools/startSession.js';
import { registerDetectContext } from './tools/detectContext.js';
import { registerPlan } from './tools/plan.js';
import { registerPrepareTarget } from './tools/prepareTarget.js';
import { registerScreenshot } from './tools/screenshot.js';
import { registerSnapshot } from './tools/snapshot.js';
import { registerAct } from './tools/act.js';
import { registerCheckHealth } from './tools/health.js';
import { registerNetwork, restoreAllNetwork } from './tools/network.js';
import { registerScreenRecord, stopAllRecordings } from './tools/screenRecord.js';
import { registerDevice } from './tools/device.js';
import { registerPermissions } from './tools/permissions.js';
import { registerMetro, stopAllMetro } from './tools/metro.js';
import { registerAppControl } from './tools/appControl.js';
import { registerScreenInfo } from './tools/screenInfo.js';
import { registerVisual } from './tools/visual.js';
import { registerVisualText } from './tools/visualText.js';
import { registerSeed } from './tools/seed.js';
import { registerState } from './tools/state.js';
import { registerHistory } from './tools/history.js';
import { registerIos } from './tools/ios.js';
import { registerWda } from './tools/wda.js';
import { registerClearOverlay } from './tools/clearOverlay.js';
import { registerJobs } from './tools/jobs.js';
import { registerGetArtifact } from './tools/getArtifact.js';
import { registerNote } from './tools/note.js';
import { registerAssertVisual } from './tools/assertVisual.js';
import { registerFlow } from './tools/flow.js';
import { registerFlowGenerate } from './tools/flowGenerate.js';
import { registerSmoke } from './tools/smoke.js';
import { registerReport } from './tools/report.js';
import { registerTestThis } from './tools/testThis.js';
import { registerPrepareIosTarget } from './tools/prepareIosTarget.js';
import { registerSuite } from './tools/suite.js';
import { registerExplore } from './tools/explore.js';
import { registerFirstRun } from './tools/firstRun.js';
import { registerAutomationGenerate } from './tools/automationGenerate.js';
import { registerAgentTools } from './tools/agent.js';
import { registerAppMap, resolveAppMapRoot, readAppMapResource } from './tools/appMap.js';
import { registerPrompts } from './prompts/index.js';
import { log } from './lib/logger.js';
import { runWithResponseMode } from './lib/result.js';
import { computeSchemaHash, describeZodField, setSchemaHash, type ToolSurfaceEntry } from './lib/schemaHash.js';
import { SWIPIUM_VERSION, TOOL_COUNT, TOOL_NAME_SET } from './version.js';

export interface ServerContext {
  server: McpServer;
  sessions: SessionStore;
}

/**
 * Wrap every tool handler so it runs inside the calling session's response mode
 * (PHASE3-PLAN §2.1). Resolved once, centrally — individual tools stay mode-agnostic.
 * `compact` shrinks the text channel; `structuredContent` is always full.
 */
function installResponseModeWrapper(server: McpServer, sessions: SessionStore, surface: ToolSurfaceEntry[]): void {
  const orig = server.registerTool.bind(server) as (name: string, config: unknown, handler: (...a: unknown[]) => unknown) => unknown;
  const valid = (m: unknown): m is 'compact' | 'normal' | 'verbose' => m === 'compact' || m === 'normal' || m === 'verbose';
  (server as unknown as { registerTool: typeof orig }).registerTool = (name, config, handler) => {
    if (!TOOL_NAME_SET.has(name)) return undefined;
    // Capture the tool surface (name + description + per-field type descriptors) for the schema hash
    // (3.3 A/§5). Encoding each field's zod shape catches nested enum/type/optionality changes.
    const cfg = config as { description?: string; inputSchema?: Record<string, unknown> } | undefined;
    const inputKeys = Object.entries(cfg?.inputSchema ?? {}).map(([k, v]) => `${k}:${describeZodField(v)}`);
    surface.push({ name, description: cfg?.description ?? '', inputKeys });
    return orig(name, config, (...a: unknown[]) => {
      const first = a[0] as { sessionId?: string; responseMode?: unknown } | undefined;
      // Prefer the existing session's mode; fall back to a directly-passed responseMode so the
      // session-CREATING call (qa_start_session, no sessionId yet) also honors compact.
      const fromSession = first?.sessionId ? sessions.get(first.sessionId)?.responseMode : undefined;
      const mode = fromSession ?? (valid(first?.responseMode) ? first!.responseMode : 'normal');
      return runWithResponseMode(mode as 'compact' | 'normal' | 'verbose', () => handler(...a));
    });
  };
}

/** Construct the server and register all tools + the artifact resource. Exported for tests. */
export function createServer(): ServerContext {
  const server = new McpServer({ name: 'swipium', version: SWIPIUM_VERSION });
  const sessions = new SessionStore();
  const surface: ToolSurfaceEntry[] = [];
  installResponseModeWrapper(server, sessions, surface);

  // Setup / context
  registerDoctor(server);
  registerCapabilities(server, sessions);
  registerStartSession(server, sessions);
  registerDetectContext(server, sessions);
  registerPlan(server, sessions);
  registerPrepareTarget(server, sessions);
  registerIos(server, sessions);
  registerWda(server, sessions);
  // Device / app environment parity (Phase 5)
  registerDevice(server, sessions);
  registerPermissions(server, sessions);
  registerNetwork(server, sessions);
  registerMetro(server, sessions);
  registerAppControl(server, sessions);
  registerScreenInfo(server, sessions);
  registerScreenRecord(server, sessions);
  // Observation / action / oracle
  registerScreenshot(server, sessions);
  registerSnapshot(server, sessions);
  registerAct(server, sessions);
  registerClearOverlay(server, sessions);
  registerCheckHealth(server, sessions);
  // Visual intelligence (Phase 8, local-first)
  registerVisual(server, sessions);
  registerVisualText(server, sessions);
  // Seeded state (Phase 9)
  registerSeed(server, sessions);
  registerState(server, sessions);
  // Jobs / artifacts / reporting (M6)
  registerJobs(server, sessions);
  registerGetArtifact(server, sessions);
  registerNote(server, sessions);
  registerAssertVisual(server, sessions);
  registerFlow(server, sessions);
  registerFlowGenerate(server, sessions);
  registerSmoke(server, sessions);
  registerReport(server, sessions);
  // Report 2.0: history + comparison (Phase 10)
  registerHistory(server, sessions);
  registerTestThis(server, sessions);
  registerPrepareIosTarget(server, sessions);
  registerSuite(server, sessions);
  registerExplore(server, sessions);
  registerFirstRun(server, sessions);
  registerAutomationGenerate(server, sessions);
  registerAgentTools(server, sessions);
  registerAppMap(server, sessions);

  // Tool surface is now fully registered. Freeze its content fingerprint.
  setSchemaHash(computeSchemaHash(surface));

  // Reusable workflow templates (MCP prompts capability) — thin orchestration of the tools above.
  registerPrompts(server);

  // Artifacts as MCP resources (clients that support them); qa_get_artifact is the fallback.
  server.registerResource(
    'qa-artifact',
    new ResourceTemplate('swipium://session/{sessionId}/{kind}/{name}', { list: undefined }),
    { title: 'QA artifact', description: 'Session artifacts: screenshots, dumps, reports, logs.' },
    async (uri) => {
      const found = sessions.findArtifact(uri.href);
      if (!found) throw new Error(`Unknown artifact ${uri.href}`);
      const { rec } = found;
      if (rec.mime.startsWith('image/')) {
        return { contents: [{ uri: uri.href, mimeType: rec.mime, blob: readFileSync(rec.path).toString('base64') }] };
      }
      return { contents: [{ uri: uri.href, mimeType: rec.mime, text: readFileSync(rec.path, 'utf8') }] };
    },
  );

  // App Knowledge Map as MCP resources (SWIPIUM-REQ-01) — full map + per-feature / per-screen /
  // test-suite sections, so large map data is read by URI instead of flooding a tool's text result.
  server.registerResource(
    'qa-app-map',
    new ResourceTemplate('swipium://project/{projectId}/app-map/{kind}/{id}', { list: undefined }),
    { title: 'App knowledge map', description: 'Durable app map: full map, or a feature/screen/test-suite section.' },
    async (uri, vars) => {
      const root = resolveAppMapRoot(String(vars.projectId), sessions);
      if (!root) throw new Error(`Unknown project ${String(vars.projectId)} (build the map first)`);
      const kind = vars.kind ? String(vars.kind) : undefined;
      const res = readAppMapResource(root, { kind, id: vars.id ? String(vars.id) : undefined });
      if (!res) throw new Error(`No app-map resource for ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: res.mimeType, text: res.text }] };
    },
  );
  // Bare full-map URI: swipium://project/{projectId}/app-map (no trailing section).
  server.registerResource(
    'qa-app-map-full',
    new ResourceTemplate('swipium://project/{projectId}/app-map', { list: undefined }),
    { title: 'App knowledge map (full)', description: 'The complete durable app map JSON.' },
    async (uri, vars) => {
      const root = resolveAppMapRoot(String(vars.projectId), sessions);
      if (!root) throw new Error(`Unknown project ${String(vars.projectId)} (build the map first)`);
      const res = readAppMapResource(root, {});
      if (!res) throw new Error(`No app map for ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: res.mimeType, text: res.text }] };
    },
  );

  return { server, sessions };
}

export async function startServer(): Promise<void> {
  const { server, sessions } = createServer();
  const transport = new StdioServerTransport();

  // Best-effort: restore any network state Swipium changed, on shutdown / client disconnect
  // (so a budget-stop or crash mid-offline doesn't leave the emulator offline). Idempotent.
  let restoring = false;
  const restoreThenExit = async (code: number, why: string) => {
    if (restoring) return;
    restoring = true;
    const changed = sessions.list().filter((s) => s.network?.changed).length;
    log('info', 'shutdown: restoring network', { why, changed });
    try {
      await restoreAllNetwork(sessions);
      await stopAllRecordings(); // don't leave a device screen-recording after we exit
      await stopAllMetro(sessions); // don't leave a node bundler holding :8081 after we exit
      log('info', 'shutdown: restore done');
    } catch (e) {
      log('warn', 'shutdown: restore failed', { err: String(e) });
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void restoreThenExit(130, "SIGINT"));
  process.once('SIGTERM', () => void restoreThenExit(143, "SIGTERM"));

  // Startup banner (P1.8): version + tool count on stderr so a stale build is obvious in logs.
  log('info', 'swipium starting', { version: SWIPIUM_VERSION, tools: TOOL_COUNT });

  await server.connect(transport);
  // Chain AFTER connect — server.connect() sets its own transport.onclose, so we must wrap
  // it rather than assign before (which gets overwritten). stdin EOF = client disconnected.
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    sdkOnClose?.();
    void restoreThenExit(0, "transport-close");
  };
  log('info', 'swipium connected over stdio');
}
