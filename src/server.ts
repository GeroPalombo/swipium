import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SessionStore, decodeUriSegment, encodeUriSegment, isWithinRoot, type Session } from './session/store.js';
import {
  burnConsent,
  peekConsent,
  requestConsentDecision,
  runWithConsentScope,
  setElicitationProvider,
  type ApprovalMechanism,
  type ConsentRequest,
  type ElicitationProvider,
} from './consent/consent.js';
import { registerDoctor } from './tools/doctor.js';
import { registerStartSession } from './tools/startSession.js';
import { registerPrepareTarget } from './tools/prepareTarget.js';
import { registerScreenshot } from './tools/screenshot.js';
import { registerSnapshot } from './tools/snapshot.js';
import { registerAct } from './tools/act.js';
import { registerCheckHealth } from './tools/health.js';
import { registerNetwork, restoreAllNetwork } from './tools/network.js';
import { registerScreenRecord, stopAllRecordings } from './tools/screenRecord.js';
import { registerDevice } from './tools/device.js';
import { registerMetro, stopAllMetro } from './tools/metro.js';
import { registerAppControl } from './tools/appControl.js';
import { registerIos } from './tools/ios.js';
import { registerWda } from './tools/wda.js';
import { registerClearOverlay } from './tools/clearOverlay.js';
import { registerJobs } from './tools/jobs.js';
import { registerGetArtifact } from './tools/getArtifact.js';
import { registerNote } from './tools/note.js';
import { registerVisual } from './tools/visual.js';
import { registerFlow } from './tools/flow.js';
import { registerGenerate } from './tools/generate.js';
import { registerSmoke } from './tools/smoke.js';
import { registerReport } from './tools/report.js';
import { registerTestThis } from './tools/testThis.js';
import { registerPrepareIosTarget } from './tools/prepareIosTarget.js';
import { registerSuite } from './tools/suite.js';
import { registerExplore } from './tools/explore.js';
import { registerFirstRun } from './tools/firstRun.js';
import { registerAgentTools, SERVER_INSTRUCTIONS } from './tools/agent.js';
import { registerAppMap, resolveAppMapRoot, readAppMapResource, listAppMapResources, type ListedAppMapResource } from './tools/appMap.js';
import { appMapPath } from './appMap/store.js';
import { registerIssues } from './tools/issues.js';
import { registerTestSuite } from './tools/testSuite.js';
import { registerFlowRepair } from './tools/flowRepair.js';
import { registerWait } from './tools/wait.js';
import { registerMobileAudit } from './tools/mobileAudit.js';
import { registerFeatureTesting } from './tools/featureTesting.js';
import { registerResolveArtifact } from './tools/resolveArtifact.js';
import { registerResolveTarget } from './tools/resolveTarget.js';
import { registerBuild } from './tools/build.js';
import { registerBundletool } from './tools/bundletool.js';
import { registerPrompts } from './prompts/index.js';
import { log } from './lib/logger.js';
import { qaError, runWithResponseMode } from './lib/result.js';
import { recordToolErrorFromResult } from './report/toolHealth.js';
import { computeSchemaHash, describeZodField, setSchemaHash, type ToolSurfaceEntry } from './lib/schemaHash.js';
import { REMOVED_TOOLS, STALE_CLIENT_HINT, SWIPIUM_VERSION, TOOL_COUNT, TOOL_NAMES, TOOL_NAME_SET, type ToolName } from './version.js';
import { toolAnnotations } from './lib/toolAnnotations.js';
import { CAPABILITY_GROUPS } from './core/capabilityGroups.js';
import { ensureAndroidToolsOnPath } from './lib/android.js';
import { annotateRootSource, withRootResolutionRecording } from './context/projectRoot.js';
import { reapOrphanedProcesses } from './session/processRegistry.js';
import { runWithSignal } from './lib/abortScope.js';

export interface ServerContext {
  server: McpServer;
  sessions: SessionStore;
}

/** How long a consent prompt may stay open before it counts as unanswered (→ refusal).
 * Explicit, because the SDK's default request timeout (60 s) is far too short for a human. */
export const ELICITATION_TIMEOUT_MS = 10 * 60_000;

/**
 * Elicitation provider (consent.ts header, THREAT_MODEL "compromised client self-approval"):
 * asks the connected client's HUMAN to decide a consent via the MCP elicitation capability
 * (`elicitation/create` with a flat one-boolean-field schema, per spec). Capabilities are only
 * known after `initialize` — and tools are registered before connect — so the capability check
 * happens lazily on every call, never at construction. Only a client that does NOT advertise
 * form elicitation yields 'unavailable' (portable re-call fallback). Once the prompt is sent,
 * `cancel`, a timeout, an aborted tool call or a transport error all reject/return 'cancelled'
 * — a refusal (MCP spec: cancel = dismissed without an explicit choice, never consent).
 */
/** Consent-prompt field hygiene: the explain / command strings interpolate repo-derived values
 * (flow names, queries, URLs, configured argv). Strip control characters (incl. newlines, which
 * could fake a second "Will run:" line), bidi overrides and zero-width characters, collapse
 * whitespace, and cap the length — the caller then QUOTES the result. Exported for tests. */
export function sanitizePromptField(value: unknown, max = 300): string {
  const flat = String(value ?? '')
    .replace(/[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The out-of-band consent prompt text. Every interpolated field is sanitised and quoted
 * (JSON-style), the command is shown one quoted line per step, and the whole message is capped. */
export function buildConsentPromptMessage(req: ConsentRequest): string {
  const q = (v: unknown, max?: number) => JSON.stringify(sanitizePromptField(v, max));
  const lines = [`Swipium requests consent (risk: ${q(req.risk, 20)}) for action ${q(req.action, 60)}.`, `Details: ${q(req.explain, 600)}`];
  if (req.exactCommand) {
    const steps = String(req.exactCommand)
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(0, 4);
    lines.push(steps.length > 1 ? 'Will run:' : `Will run: ${q(steps[0], 500)}`);
    if (steps.length > 1) for (const step of steps) lines.push(`  ${q(step, 500)}`);
  }
  const msg = lines.join('\n');
  return msg.length > 2000 ? `${msg.slice(0, 1999)}…` : msg;
}

function makeElicitationProvider(server: McpServer): ElicitationProvider {
  return async (req, ctx) => {
    // The SDK normalises a bare `elicitation: {}` capability to `{ form: {} }`.
    if (!server.server.getClientCapabilities()?.elicitation?.form) return 'unavailable';
    const answer = await server.server.elicitInput(
      {
        message: buildConsentPromptMessage(req),
        requestedSchema: {
          type: 'object',
          properties: {
            approve: { type: 'boolean', title: 'Approve', description: 'Allow Swipium to perform this action.' },
          },
          required: ['approve'],
        },
      },
      {
        timeout: ELICITATION_TIMEOUT_MS,
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
        ...(ctx?.relatedRequestId !== undefined ? { relatedRequestId: ctx.relatedRequestId } : {}),
      },
    );
    if (answer.action === 'accept') return answer.content?.approve === true ? 'approved' : 'declined';
    if (answer.action === 'decline') return 'declined';
    return 'cancelled'; // 'cancel': dismissed without answering → refusal, never a self-approval fallback
  };
}

/** Ledger a consent that was decided WITHOUT the tool running (declined / cancelled / refused by
 * policy), so the audit trail shows the refusal next to the tool's own `requested` row. */
function recordConsentRefusal(
  sessions: SessionStore,
  tool: string,
  sessionId: unknown,
  consentId: string,
  req: ConsentRequest | undefined,
  mechanism: ApprovalMechanism,
  detail: string,
): void {
  if (!req || typeof sessionId !== 'string') return;
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    sessions.recordMutation(session, {
      tool,
      action: req.action,
      risk: req.risk,
      target: req.affects ?? {},
      consent: { required: true, consentId, approved: false, approvalMechanism: mechanism },
      status: 'refused',
      detail,
    });
  } catch (e) {
    log('warn', 'failed to ledger a consent refusal', { tool, consentId, err: String(e) });
  }
}

function pendingConsentId(result: unknown): string | undefined {
  const sc = (result as CallToolResult | null | undefined)?.structuredContent as Record<string, unknown> | undefined;
  return sc?.requiresConsent === true && typeof sc.consentId === 'string' ? sc.consentId : undefined;
}

/**
 * Consent routing (consent.ts header): when a tool handler returns a requiresConsent envelope,
 * route the pending consent through a REAL out-of-band user prompt before the envelope ever
 * reaches the model. Outcomes:
 *  - elicitation approved → re-invoke the SAME handler exactly once with the consent attached
 *    (the approval was recorded, so consumeConsent tags mechanism 'elicitation');
 *  - elicitation declined → CONSENT_DECLINED; cancelled/timed out/transport error →
 *    CONSENT_CANCELLED (retry-safe: a re-call issues a fresh prompt). Either way the challenge
 *    is burned (no approve:true self-approval afterwards) and a `refused` ledger row is written;
 *  - refused (SWIPIUM_REQUIRE_ELICITATION=1 and no elicitation support) → CONSENT_REFUSED;
 *  - client-assertion (client does not advertise elicitation) → the portable envelope unchanged.
 * The re-invocation's result is never routed again — so this cannot loop; if it asks for a NEW
 * consent (the target changed under the prompt) that challenge is burned and CONSENT_CANCELLED
 * returned, so the model never receives a self-approvable envelope on an elicitation client.
 */
async function routePendingConsent(
  result: unknown,
  args: unknown[],
  reinvoke: (args: unknown[]) => unknown,
  ledger: { sessions: SessionStore; tool: string },
): Promise<unknown> {
  const consentId = pendingConsentId(result);
  if (!consentId) return result;
  const first = (args[0] ?? {}) as Record<string, unknown>;
  const extra = args[1] as { signal?: AbortSignal; requestId?: string | number } | undefined;
  const req = peekConsent(consentId);
  const decision = await requestConsentDecision(consentId, { signal: extra?.signal, relatedRequestId: extra?.requestId });
  if (decision.mechanism === 'refused') {
    recordConsentRefusal(ledger.sessions, ledger.tool, first.sessionId, consentId, req, 'policy', decision.reason);
    return qaError({
      what: decision.reason,
      changedState: false,
      retrySafe: false,
      failureCode: 'CONSENT_REFUSED',
      nextSteps: ['Connect with an MCP client that supports elicitation, or unset SWIPIUM_REQUIRE_ELICITATION.'],
    });
  }
  if (decision.mechanism === 'elicitation') {
    if (!decision.approved) {
      recordConsentRefusal(ledger.sessions, ledger.tool, first.sessionId, consentId, req, 'elicitation', decision.reason);
      if (decision.outcome === 'cancelled') {
        return qaError({
          what: decision.reason,
          changedState: false,
          retrySafe: true,
          failureCode: 'CONSENT_CANCELLED',
          nextSteps: ['Nothing ran. Re-call the tool (without consentId) to show the user a fresh consent prompt, or ask them first.'],
        });
      }
      return qaError({
        what: 'User declined via elicitation prompt',
        changedState: false,
        retrySafe: false,
        failureCode: 'CONSENT_DECLINED',
        nextSteps: ['Do not retry this action; ask the user before attempting it again.'],
      });
    }
    const out = await reinvoke([{ ...first, consentId, approve: true }, ...args.slice(1)]);
    const again = pendingConsentId(out);
    if (again) {
      burnConsent(again);
      burnConsent(consentId);
      return qaError({
        what: 'The action changed while the user was deciding, so the approval no longer matches it — nothing ran.',
        changedState: false,
        retrySafe: true,
        failureCode: 'CONSENT_CANCELLED',
        nextSteps: ['Re-call the tool (without consentId) to prompt the user for the current action.'],
      });
    }
    return out;
  }
  return result; // 'client-assertion': portable path — the model relays the consent envelope
}

/**
 * Wrap every tool handler so it runs inside the calling session's response mode
 * (PHASE3-PLAN §2.1). Resolved once, centrally — individual tools stay mode-agnostic.
 * `compact` shrinks the text channel; `structuredContent` is always full.
 * The same wrapper also routes requiresConsent envelopes through out-of-band elicitation
 * (routePendingConsent), so every consent-gated tool inherits it with zero per-tool changes.
 */
function installResponseModeWrapper(server: McpServer, sessions: SessionStore, surface: ToolSurfaceEntry[], attempted: Set<string>): void {
  const orig = server.registerTool.bind(server) as (name: string, config: unknown, handler: (...a: unknown[]) => unknown) => unknown;
  const valid = (m: unknown): m is 'compact' | 'normal' | 'verbose' => m === 'compact' || m === 'normal' || m === 'verbose';
  (server as unknown as { registerTool: typeof orig }).registerTool = (name, config, handler) => {
    attempted.add(name);
    if (!TOOL_NAME_SET.has(name)) return undefined; // assertToolSurface() makes this drop loud at startup
    // Capture the tool surface (name + description + per-field type descriptors) for the schema hash
    // (3.3 A/§5). Encoding each field's zod shape catches nested enum/type/optionality changes.
    const cfg = config as { description?: string; inputSchema?: Record<string, unknown> } | undefined;
    const inputKeys = Object.entries(cfg?.inputSchema ?? {}).map(([k, v]) => `${k}:${describeZodField(v)}`);
    surface.push({ name, description: cfg?.description ?? '', inputKeys });
    // MCP annotations for every tool, from one reviewed table (src/lib/toolAnnotations.ts).
    const annotated = { ...(config as Record<string, unknown>), annotations: toolAnnotations(name as ToolName) };
    return orig(name, annotated, async (...a: unknown[]) => {
      const first = a[0] as { sessionId?: string; responseMode?: unknown } | undefined;
      // Prefer the existing session's mode; fall back to a directly-passed responseMode so the
      // session-CREATING call (qa_start_session, no sessionId yet) also honors compact.
      const fromSession = first?.sessionId ? sessions.get(first.sessionId)?.responseMode : undefined;
      const mode = (fromSession ?? (valid(first?.responseMode) ? first!.responseMode : 'normal')) as 'compact' | 'normal' | 'verbose';
      // Every call records the project root it resolves (if any) so the result carries
      // `rootSource` (+ a note when the root was only guessed from the server cwd).
      // Consents minted/consumed during this call are bound to its sessionId (consent.ts).
      // Cancellation: the call's MCP signal (extra.signal, the handler's last argument) is scoped
      // to THIS call (abortScope) — driver adb/WDA calls made by the tool abort with it, and a
      // background job's signal (bound by the job itself) never leaks into or out of it.
      const extra = a[a.length - 1] as { signal?: unknown } | undefined;
      const callSignal = extra?.signal instanceof AbortSignal ? extra.signal : undefined;
      const run = async (callArgs: unknown[]) => {
        const { value, resolved } = await runWithSignal(callSignal, () =>
          withRootResolutionRecording(async () =>
            runWithConsentScope(first?.sessionId, () => runWithResponseMode(mode, () => handler(...callArgs))),
          ),
        );
        return annotateRootSource(value, resolved);
      };
      const result = await run(a);
      const out = await routePendingConsent(result, a, run, { sessions, tool: name });
      recordToolErrorFromResult(sessions, name, a[0], out); // qa_report tool status (report/toolHealth.ts)
      return out;
    });
  };
}

/** Legacy (≤ 1.5) call shapes that a client spawned before the upgrade may still send, mapped to
 * the 2.0 replacement. Returned as a typed STALE_CLIENT error instead of a raw "Tool not found" /
 * zod validation message, WITHOUT polluting the current schemas/descriptions. Exported for tests. */
export function staleClientReplacement(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!TOOL_NAME_SET.has(name)) return REMOVED_TOOLS[name];
  const action = args?.action;
  if (name === 'qa_ios' && typeof action === 'string') {
    if (action === 'screenshot') return 'qa_screenshot { sessionId }';
    if (action.startsWith('wda_')) return `qa_wda { sessionId, action: "${action.slice(4) || 'status'}" }`;
  }
  if (name === 'qa_wait' && args?.for === 'job_done') return 'qa_job_status { sessionId, jobId, waitMs }';
  return undefined;
}

function staleClientError(name: string, replacement: string): CallToolResult {
  return qaError(
    {
      what: `${name} (this call shape) was removed in Swipium v${SWIPIUM_VERSION}; use ${replacement}`,
      changedState: false,
      retrySafe: true,
      failureCode: 'STALE_CLIENT',
      nextSteps: [`Call ${replacement} instead.`, 'Restart the MCP client so it reloads the current tool list.'],
      clientHint: STALE_CLIENT_HINT,
    },
    { removedCall: name, replacement },
  );
}

type RawHandler = (request: { params?: Record<string, unknown> }, extra: unknown) => Promise<unknown>;

/** The SDK stores handlers per method; wrapping the stored (already SDK-wrapped) function keeps
 * the SDK's own request/result validation intact. */
function wrapRequestHandler(server: McpServer, method: string, wrap: (orig: RawHandler) => RawHandler): void {
  const map = (server.server as unknown as { _requestHandlers?: Map<string, RawHandler> })._requestHandlers;
  const orig = map?.get(method);
  if (!map || !orig) {
    log('warn', 'could not wrap MCP request handler (SDK internals changed?)', { method });
    return;
  }
  map.set(method, wrap(orig));
}

/** Drop the per-schema `$schema` dialect key (~2.8 KB of repetition across the tool list). */
export function stripSchemaDialect(result: unknown): unknown {
  const tools = (result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools;
  if (!Array.isArray(tools)) return result;
  for (const t of tools) {
    for (const k of ['inputSchema', 'outputSchema'] as const) {
      const sch = t[k] as Record<string, unknown> | undefined;
      if (sch && typeof sch === 'object' && '$schema' in sch) delete sch.$schema;
    }
  }
  return result;
}

/** tools/call: unknown removed-tool names and legacy call shapes → STALE_CLIENT (with the
 * replacement + stale-client hint); tools/list: strip `$schema`. */
function installProtocolShims(server: McpServer): void {
  wrapRequestHandler(server, 'tools/call', (orig) => async (request, extra) => {
    const name = String(request?.params?.name ?? '');
    const args = request?.params?.arguments as Record<string, unknown> | undefined;
    const replacement = staleClientReplacement(name, args);
    if (replacement && !TOOL_NAME_SET.has(name)) return staleClientError(name, replacement);
    const result = (await orig(request, extra)) as CallToolResult;
    // Legacy enum values fail the CURRENT schema's validation → rewrite that raw error only.
    if (replacement && result?.isError && !result.structuredContent)
      return staleClientError(`${name} ${JSON.stringify(args?.action ?? args?.for)}`, replacement);
    return result;
  });
  wrapRequestHandler(server, 'tools/list', (orig) => async (request, extra) => stripSchemaDialect(await orig(request, extra)));
}

/** Startup assertion (P0 §2 "silent tool-drop gate"): every registerTool() call must be
 * allowlisted in TOOL_NAMES, and every TOOL_NAMES entry must actually get registered.
 * Without this, a tool missing from the allowlist is silently discarded by the wrapper
 * above, and a stale TOOL_NAMES entry silently over-reports the surface. Fail LOUDLY. */
function assertToolSurface(attempted: ReadonlySet<string>): void {
  const missing = TOOL_NAMES.filter((n) => !attempted.has(n));
  const extra = [...attempted].filter((n) => !TOOL_NAME_SET.has(n));
  // Every tool sits in exactly one capability group (qa_status orientation + docs/tools.md layout).
  const grouped = CAPABILITY_GROUPS.flatMap((g) => g.tools);
  const ungrouped = TOOL_NAMES.filter((n) => grouped.filter((t) => t === n).length !== 1);
  if (ungrouped.length)
    throw new Error(`CAPABILITY_GROUPS (src/core/capabilityGroups.ts) must list each tool exactly once: ${ungrouped.join(', ')}`);
  if (missing.length === 0 && extra.length === 0 && attempted.size === TOOL_NAMES.length) return;
  throw new Error(
    `Tool surface mismatch: ${attempted.size} tools registered vs ${TOOL_NAMES.length} in TOOL_NAMES (src/version.ts).` +
      (missing.length ? `\n  Missing (allowlisted but never registered): ${missing.join(', ')}` : '') +
      (extra.length ? `\n  Extra (registered but not in TOOL_NAMES — they would be silently dropped): ${extra.join(', ')}` : '') +
      '\nFix: add/remove the tool in TOOL_NAMES and CAPABILITY_GROUPS, or register it in createServer().',
  );
}

/** resources/list size cap (OPP-02). The SDK aggregates every template's list callback into one
 * un-paginated resources/list response, so each listing stays bounded. */
const RESOURCE_LIST_CAP = 100;

/** Cap a resources/list result and DISCLOSE the truncation on the final entry's description —
 * silent truncation is forbidden. Clients read anything omitted here directly by URI
 * (qa_get_artifact / qa_app_map_read always cover the full set). */
function capResourceListing<T extends { description?: string }>(all: T[], cap = RESOURCE_LIST_CAP): T[] {
  if (all.length <= cap) return all;
  const shown = all.slice(0, cap);
  const last = shown[shown.length - 1];
  last.description = `${last.description ? `${last.description} — ` : ''}[listing capped: showing ${cap} of ${all.length}; the rest remain readable by URI]`;
  return shown;
}

/** Project roots the CURRENT client works in: its MCP roots (when it advertises the capability)
 * plus the roots of sessions created or used in this server process. resources/list is scoped to
 * these so one client never browses another project's artifacts from the machine-wide registry. */
async function currentProjectRoots(server: McpServer, sessions: SessionStore): Promise<string[]> {
  const roots = new Set(sessions.activeRoots());
  try {
    if (server.server.getClientCapabilities()?.roots) {
      const res = await server.server.listRoots(undefined, { timeout: 5_000 });
      for (const r of res.roots ?? []) if (typeof r.uri === 'string' && r.uri.startsWith('file://')) roots.add(fileURLToPath(r.uri));
    }
  } catch {
    // roots/list failed — fall back to the process-local roots only
  }
  return [...roots];
}

/** Sessions whose artifacts/maps may be LISTED: inside a current project root. */
function sessionsInRoots(sessions: SessionStore, roots: string[]): Session[] {
  return sessions.list().filter((s) => roots.some((r) => isWithinRoot(s.root, r)));
}

/** Re-encode a stored artifact URI so every segment matches the qa-artifact template (older
 * records stored raw names; a raw `/` inside the name spans several segments). */
function listedArtifactUri(uri: string): string {
  const prefix = 'swipium://session/';
  if (!uri.startsWith(prefix)) return uri;
  const [id = '', kind = '', ...rest] = uri.slice(prefix.length).split('/');
  const seg = (x: string) => encodeUriSegment(decodeUriSegment(x));
  return `${prefix}${seg(id)}/${seg(kind)}/${seg(rest.map(decodeUriSegment).join('/'))}`;
}

/** App-map listings load every map JSON — cache per scope, keyed on each root's map mtime.
 * The short TTL also covers roots known only to src/tools/appMap.ts's in-process registry. */
const APP_MAP_LIST_TTL_MS = 10_000;
function makeAppMapLister(sessions: SessionStore) {
  const cache = new Map<string, { key: string; at: number; value: ListedAppMapResource[] }>();
  return (roots: string[], which: 'full' | 'sections'): ListedAppMapResource[] => {
    const scoped = sessionsInRoots(sessions, roots);
    const scopedRoots = [...new Set([...scoped.map((s) => s.root), ...roots])].sort();
    const key = scopedRoots
      .map((r) => {
        try {
          return `${r}@${statSync(appMapPath(r)).mtimeMs}`;
        } catch {
          return `${r}@-`;
        }
      })
      .join('|');
    const hit = cache.get(which);
    if (hit && hit.key === key && Date.now() - hit.at < APP_MAP_LIST_TTL_MS) return hit.value;
    // listAppMapResources enumerates roots via store.list(); hand it only the in-scope roots.
    const scopedStore = { list: () => scopedRoots.map((root) => ({ root })) } as unknown as SessionStore;
    const value = listAppMapResources(scopedStore, which);
    cache.set(which, { key, at: Date.now(), value });
    return value;
  };
}

/** Construct the server and register all tools + the artifact resource. Exported for tests. */
export function createServer(): ServerContext {
  const server = new McpServer({ name: 'swipium', version: SWIPIUM_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  // Out-of-band consent (consent.ts header): when the connected client supports MCP
  // elicitation, pending consents are decided by a real user prompt instead of a
  // model-mediated re-call. The provider checks client capabilities lazily per call,
  // since they are only known after `initialize` (long after tool registration).
  setElicitationProvider(makeElicitationProvider(server));
  const sessions = new SessionStore();
  const surface: ToolSurfaceEntry[] = [];
  const attemptedToolNames = new Set<string>();
  installResponseModeWrapper(server, sessions, surface, attemptedToolNames);

  // Setup / context
  registerDoctor(server);
  registerStartSession(server, sessions);
  registerPrepareTarget(server, sessions);
  registerIos(server, sessions);
  registerWda(server, sessions);
  // Device / app environment parity (Phase 5)
  registerDevice(server, sessions);
  registerNetwork(server, sessions);
  registerMetro(server, sessions);
  registerAppControl(server, sessions);
  registerScreenRecord(server, sessions);
  // Observation / action / oracle
  registerScreenshot(server, sessions);
  registerSnapshot(server, sessions);
  registerAct(server, sessions);
  registerClearOverlay(server, sessions);
  registerCheckHealth(server, sessions);
  // Jobs / artifacts / reporting (M6)
  registerJobs(server, sessions);
  registerGetArtifact(server, sessions);
  registerNote(server, sessions);
  registerVisual(server, sessions);
  registerFlow(server, sessions);
  registerGenerate(server, sessions);
  registerSmoke(server, sessions);
  registerReport(server, sessions);
  registerTestThis(server, sessions);
  registerPrepareIosTarget(server, sessions);
  registerSuite(server, sessions);
  registerExplore(server, sessions);
  registerFirstRun(server, sessions);
  registerAgentTools(server, sessions);
  registerAppMap(server, sessions);
  // Durable QA memory + repeatable assets
  registerIssues(server, sessions);
  registerMobileAudit(server, sessions);
  registerTestSuite(server, sessions);
  registerFlowRepair(server, sessions);
  // Feature-focused testing + local build/artifact resolution (v4)
  registerFeatureTesting(server, sessions);
  registerResolveArtifact(server, sessions);
  registerResolveTarget(server, sessions);
  registerBuild(server, sessions);
  registerBundletool(server, sessions);
  // Agent-efficiency helpers (v3)
  registerWait(server, sessions);

  // Tool surface is now fully registered. Fail loudly on any allowlist mismatch, then
  // freeze the surface's content fingerprint.
  assertToolSurface(attemptedToolNames);
  setSchemaHash(computeSchemaHash(surface));
  installProtocolShims(server);

  // Reusable workflow templates (MCP prompts capability) — thin orchestration of the tools above.
  registerPrompts(server);

  // Artifacts as MCP resources (clients that support them); qa_get_artifact is the fallback.
  // The list callback (OPP-02) lets resource-aware clients BROWSE artifacts instead of mining
  // URIs out of tool text: newest RESOURCE_LIST_CAP across the sessions of the CURRENT project
  // root(s) (currentProjectRoots), straight from the in-memory ledger — no device calls.
  // Sensitive-mode sessions are never listed (their artifacts stay readable by exact URI only).
  // ArtifactRecord carries no byte size, so the description is kind + label; sizes come from
  // qa_get_artifact { mode: "metadata" }.
  server.registerResource(
    'qa-artifact',
    new ResourceTemplate('swipium://session/{sessionId}/{kind}/{name}', {
      list: async () => {
        const roots = await currentProjectRoots(server, sessions);
        const all = sessionsInRoots(sessions, roots)
          .filter((s) => !s.sensitive)
          .flatMap((s) => s.artifacts)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((rec) => ({
            uri: listedArtifactUri(rec.uri),
            name: basename(rec.path),
            mimeType: rec.mime,
            description: rec.label ? `${rec.kind} — ${rec.label}` : rec.kind,
          }));
        return { resources: capResourceListing(all) };
      },
    }),
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
  // Both app-map templates list what is ACTUALLY readable right now (OPP-02): section/full URIs
  // for every project root known to this run that has a map on disk; no map → empty list, never
  // an error. Enumeration is a local JSON load (listAppMapResources), scoped to the current project
  // root(s) and cached on map mtime (makeAppMapLister) — no device calls. Listed section ids are
  // percent-encoded by listAppMapResources; the read handlers decode template variables.
  const listAppMaps = makeAppMapLister(sessions);
  server.registerResource(
    'qa-app-map',
    new ResourceTemplate('swipium://project/{projectId}/app-map/{kind}/{id}', {
      list: async () => ({ resources: capResourceListing(listAppMaps(await currentProjectRoots(server, sessions), 'sections')) }),
    }),
    { title: 'App knowledge map', description: 'Durable app map: full map, or a feature/screen/test-suite section.' },
    async (uri, vars) => {
      const projectId = decodeUriSegment(String(vars.projectId));
      const root = resolveAppMapRoot(projectId, sessions);
      if (!root) throw new Error(`Unknown project ${projectId} (build the map first)`);
      const kind = vars.kind ? decodeUriSegment(String(vars.kind)) : undefined;
      const res = readAppMapResource(root, { kind, id: vars.id ? decodeUriSegment(String(vars.id)) : undefined });
      if (!res) throw new Error(`No app-map resource for ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: res.mimeType, text: res.text }] };
    },
  );
  // Bare full-map URI: swipium://project/{projectId}/app-map (no trailing section).
  server.registerResource(
    'qa-app-map-full',
    new ResourceTemplate('swipium://project/{projectId}/app-map', {
      list: async () => ({ resources: capResourceListing(listAppMaps(await currentProjectRoots(server, sessions), 'full')) }),
    }),
    { title: 'App knowledge map (full)', description: 'The complete durable app map JSON.' },
    async (uri, vars) => {
      const projectId = decodeUriSegment(String(vars.projectId));
      const root = resolveAppMapRoot(projectId, sessions);
      if (!root) throw new Error(`Unknown project ${projectId} (build the map first)`);
      const res = readAppMapResource(root, {});
      if (!res) throw new Error(`No app map for ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: res.mimeType, text: res.text }] };
    },
  );

  return { server, sessions };
}

export async function startServer(): Promise<void> {
  // GUI MCP clients don't inherit the shell PATH: APPEND the Android SDK's platform-tools/ and
  // emulator/ to PATH — only for a tool (adb / emulator) that is not already resolvable on PATH,
  // so the user's own copy is never shadowed. Idempotent (the CLI entry already calls it); done
  // here too so embedders that call startServer() directly get it.
  try {
    ensureAndroidToolsOnPath();
  } catch (e) {
    log('warn', 'android sdk path setup failed', { err: String(e) });
  }
  const { server, sessions } = createServer();
  const transport = new StdioServerTransport();

  // Persistence is debounced (SessionStore.persist) — make sure a graceful exit never
  // loses the trailing write. 'exit' handlers must be synchronous; flushAll is.
  process.once('exit', () => sessions.flushAll());

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
      // Managed WDA is NOT stopped: the next server adopts it if healthy and < 12 h old
      // (processRegistry.reapOrphanedProcesses), else reaps it. `qa_wda stop` stops it explicitly.
      log('info', 'shutdown: restore done');
    } catch (e) {
      log('warn', 'shutdown: restore failed', { err: String(e) });
    }
    sessions.flushAll(); // write any debounced session state before exiting
    process.exit(code);
  };
  process.once('SIGINT', () => void restoreThenExit(130, 'SIGINT'));
  process.once('SIGTERM', () => void restoreThenExit(143, 'SIGTERM'));

  // Startup banner (P1.8): version + tool count on stderr so a stale build is obvious in logs.
  log('info', 'swipium starting', { version: SWIPIUM_VERSION, tools: TOOL_COUNT });

  await server.connect(transport);
  // Chain AFTER connect — server.connect() sets its own transport.onclose, so we must wrap
  // it rather than assign before (which gets overwritten). stdin EOF = client disconnected.
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    sdkOnClose?.();
    void restoreThenExit(0, 'transport-close');
  };
  log('info', 'swipium connected over stdio');
  // Reap long-lived children (Metro, managed WDA, recorders) left behind by a crashed previous
  // server run — AFTER connect and in the background, so a slow sweep (lock wait, WDA /status
  // probes) never delays the server becoming ready. Ownership + start-time/command fingerprint
  // checks make this safe next to a live concurrent instance and against recycled PIDs. A managed
  // WDA < 12 h old whose /status is healthy is ADOPTED instead (re-owned by this server) so a
  // resumed iOS session keeps its WDA — shutdown intentionally leaves managed WDA running.
  void startOrphanSweep();
}

/** Background orphan sweep; never rejects. Exported for tests. */
export async function startOrphanSweep(reap: () => Promise<void> = reapOrphanedProcesses): Promise<void> {
  try {
    await reap();
  } catch (e) {
    log('warn', 'orphaned-process sweep failed', { err: String(e) });
  }
}
