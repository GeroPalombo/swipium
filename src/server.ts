import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { SessionStore, decodeUriSegment, encodeUriSegment, isWithinRoot, type Session } from './session/store.js';
import {
  AUTO_ANSWER_MS,
  burnConsent,
  peekConsent,
  preapproveHint,
  requestConsentDecision,
  runWithConsentScope,
  setElicitationProvider,
  warnIgnoredPreapprovals,
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
import { registerGetArtifact, readArtifactResource } from './tools/getArtifact.js';
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
import { log, logEnabled } from './lib/logger.js';
import { qaAnnotate, qaError, runWithResponseMode } from './lib/result.js';
import { recordToolErrorFromResult } from './report/toolHealth.js';
import { computeSchemaHash, describeZodField, setSchemaHash, type ToolSurfaceEntry } from './lib/schemaHash.js';
import { REMOVED_TOOLS, STALE_CLIENT_HINT, SWIPIUM_VERSION, TOOL_COUNT, TOOL_NAMES, TOOL_NAME_SET, type ToolName } from './version.js';
import { toolAnnotations } from './lib/toolAnnotations.js';
import {
  MAX_ECHOED_KEYS,
  checkToolArgs,
  echoKey,
  strictToolSchema,
  toolInputJsonSchema,
  type ToolArgIssue,
  type ToolInputSchema,
  type ToolInputShape,
} from './lib/toolSchema.js';
import { CAPABILITY_GROUPS } from './core/capabilityGroups.js';
import { ensureAndroidToolsOnPath } from './lib/android.js';
import { annotateRootSource, withRootResolutionRecording } from './context/projectRoot.js';
import { reapOrphanedProcesses } from './session/processRegistry.js';
import { runWithSignal } from './lib/abortScope.js';

export interface ServerContext {
  server: McpServer;
  sessions: SessionStore;
}

/** How long a consent prompt may stay open before it counts as unanswered (> refusal).
 * Explicit, because the SDK's default request timeout (60 s) is far too short for a human. */
export const ELICITATION_TIMEOUT_MS = 10 * 60_000;

/**
 * Elicitation provider (consent.ts header, THREAT_MODEL "compromised client self-approval"):
 * asks the connected client's HUMAN to decide a consent via the MCP elicitation capability
 * (`elicitation/create` with a flat one-boolean-field schema, per spec). Capabilities are only
 * known after `initialize` (and tools are registered before connect), so the capability check
 * happens lazily on every call, never at construction. Only a client that does NOT advertise
 * form elicitation yields 'unavailable' (portable re-call fallback). Once the prompt is sent,
 * `cancel`, a timeout, an aborted tool call or a transport error all reject/return 'cancelled',
 * which is a refusal (MCP spec: cancel = dismissed without an explicit choice, never consent).
 */
/** Consent-prompt field hygiene: the explain / command strings interpolate repo-derived values
 * (flow names, queries, URLs, configured argv). Strip control characters (incl. newlines, which
 * could fake a second "Will run:" line), bidi overrides and zero-width characters, collapse
 * whitespace, and cap the length. The caller then QUOTES the result. Exported for tests. */
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
    return 'cancelled'; // 'cancel': dismissed without answering > refusal, never a self-approval fallback
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
 *  - elicitation approved > re-invoke the SAME handler exactly once with the consent attached
 *    (the approval was recorded, so consumeConsent tags mechanism 'elicitation');
 *  - elicitation declined > CONSENT_DECLINED; cancelled/timed out/transport error >
 *    CONSENT_CANCELLED (retry-safe: a re-call issues a fresh prompt). Either way the challenge
 *    is burned (no approve:true self-approval afterwards) and a `refused` ledger row is written;
 *  - operator-policy (action listed in SWIPIUM_CONSENT_PREAPPROVE and allowed by its tier, see
 *    consent.ts operatorPolicyCovers) > re-invoke exactly like an elicitation approval, without
 *    prompting (consumeConsent tags it 'operator-policy');
 *  - refused (SWIPIUM_REQUIRE_ELICITATION=1 and no elicitation support) > CONSENT_REFUSED;
 *  - client-assertion (client does not advertise elicitation) > the portable envelope unchanged.
 * The re-invocation's result is never routed again, so this cannot loop; if it asks for a NEW
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
  if (decision.mechanism === 'elicitation' || decision.mechanism === 'operator-policy') {
    if (!decision.approved) {
      // A failed elicitation (timeout, transport error, aborted call) is not an answer: ledger it
      // as 'transport/abort' and never flag it as likely automatic.
      const failed = decision.failure !== undefined;
      recordConsentRefusal(
        ledger.sessions,
        ledger.tool,
        first.sessionId,
        consentId,
        req,
        'elicitation',
        failed ? `transport/abort: ${decision.reason}` : decision.reason,
      );
      // Headless clients (codex exec, claude -p) answer prompts automatically: a near-instant
      // answer is flagged as likely automatic and only then carries the pre-approve hint (a real
      // human decline must not be nudged toward disabling consent).
      const action = req?.action ?? 'unknown';
      const likelyAutomatic = !failed && decision.elapsedMs < AUTO_ANSWER_MS;
      const extra = failed
        ? { action, answeredInMs: decision.elapsedMs, likelyAutomatic: false, elicitationFailure: decision.failure }
        : { action, answeredInMs: decision.elapsedMs, likelyAutomatic };
      const hint = likelyAutomatic ? [preapproveHint(action, req)] : [];
      if (decision.outcome === 'cancelled') {
        return qaError(
          {
            what: decision.reason,
            changedState: false,
            retrySafe: true,
            failureCode: 'CONSENT_CANCELLED',
            nextSteps: [
              failed
                ? 'Nothing ran. The consent prompt failed (timeout, transport error or cancelled call) before anyone answered: re-call the tool (without consentId) to prompt again, or ask the user first.'
                : likelyAutomatic
                  ? 'Nothing ran. The prompt was answered too fast for a human: do not re-call in a loop, ask the user first.'
                  : 'Nothing ran. Re-call the tool (without consentId) to show the user a fresh consent prompt, or ask them first.',
              ...hint,
            ],
          },
          extra,
        );
      }
      return qaError(
        {
          what: likelyAutomatic
            ? `The client declined "${action}" in ${decision.elapsedMs} ms, likely automatically without showing the user`
            : 'User declined via elicitation prompt',
          changedState: false,
          retrySafe: false,
          failureCode: 'CONSENT_DECLINED',
          nextSteps: ['Do not retry this action; ask the user before attempting it again.', ...hint],
        },
        extra,
      );
    }
    const out = await reinvoke([{ ...first, consentId, approve: true }, ...args.slice(1)]);
    const again = pendingConsentId(out);
    if (again) {
      burnConsent(again);
      burnConsent(consentId);
      return qaError({
        what: 'The action changed while the user was deciding, so the approval no longer matches it. Nothing ran.',
        changedState: false,
        retrySafe: true,
        failureCode: 'CONSENT_CANCELLED',
        nextSteps: ['Re-call the tool (without consentId) to prompt the user for the current action.'],
      });
    }
    return out;
  }
  return result; // 'client-assertion': portable path (the model relays the consent envelope)
}

/**
 * Wrap every tool handler so it runs inside the calling session's response mode.
 * Resolved once, centrally. Individual tools stay mode-agnostic.
 * `compact` shrinks the text channel; `structuredContent` always carries every field (element
 * lists are one-line @eN strings outside `verbose`, see snapshot/present.ts).
 * The same wrapper also routes requiresConsent envelopes through out-of-band elicitation
 * (routePendingConsent), so every consent-gated tool inherits it with zero per-tool changes.
 */
// Job kinds that never touch the device (host-side build / conversion); everything else a job
// runs (test_this, explore, test_feature, boot+install) drives the session's device.
const HOST_ONLY_JOB_PREFIXES = ['build:', 'bundletool:'];
/** Tools that DRIVE the device or the app on it (tap/type/swipe, install/launch/stop, boot/erase,
 * orientation/location/network, recorder, WDA/Metro wiring, or start a job that does). Explicit
 * allowlist: the readOnlyHint test also warned for tools that never touch the device (qa_note,
 * qa_generate, qa_suite_*, qa_app_map_*, qa_issue_log, qa_build...). Observation-only device
 * tools (qa_snapshot, qa_screenshot, qa_device_info, qa_check_health, qa_flow_repair) are left
 * out: they do not change what the job sees. Exported for tests. */
export const DEVICE_DRIVING_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'qa_test_this',
  'qa_continue_from_blocker',
  'qa_prepare_target',
  'qa_prepare_ios_target',
  'qa_ios',
  'qa_wda',
  'qa_orientation',
  'qa_geolocation',
  'qa_network',
  'qa_metro',
  'qa_app_control',
  'qa_screen_record',
  'qa_act',
  'qa_clear_overlay',
  'qa_visual',
  'qa_smoke',
  'qa_explore',
  'qa_test_feature',
  'qa_flow_run',
  'qa_first_run',
  'qa_mobile_audit',
]);

/** Advisory note (never a block) when a device-driving tool is called on a session whose
 * background job is still driving the same device: the two can interleave taps/installs.
 * Exported for tests. */
export function runningJobNote(sessions: SessionStore, tool: string, sessionId: string | undefined): string | undefined {
  if (!sessionId || !DEVICE_DRIVING_TOOLS.has(tool as ToolName)) return undefined;
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  for (const j of s.jobs.values()) {
    if (j.status !== 'running' || HOST_ONLY_JOB_PREFIXES.some((p) => j.kind.startsWith(p))) continue;
    return `job ${j.jobId} is still driving this device; actions may interleave. Poll qa_job_status or qa_job_cancel first.`;
  }
  return undefined;
}

/** qaAnnotate, but keeps any notes the tool already put in structuredContent.notes. */
function annotateKeepingNotes(result: CallToolResult, note: string): CallToolResult {
  const prior = (result.structuredContent as { notes?: unknown } | undefined)?.notes;
  const out = qaAnnotate(result, [note]);
  if (Array.isArray(prior)) out.structuredContent = { ...out.structuredContent, notes: [...prior, note] };
  return out;
}

/** One debug line per tool call (SWIPIUM_LOG_LEVEL=debug). Metadata only: argument values can
 * carry secrets and are never logged. */
function logToolCall(
  tool: string,
  sessionId: string | undefined,
  startedAt: number,
  out: CallToolResult | undefined,
  signal: AbortSignal | undefined,
): void {
  if (!logEnabled('debug')) return;
  const sc = out?.structuredContent as { failureCode?: unknown } | undefined;
  const failureCode = typeof sc?.failureCode === 'string' ? sc.failureCode : undefined;
  log('debug', 'tool call', {
    tool,
    ...(sessionId ? { sessionId } : {}),
    durationMs: Date.now() - startedAt,
    isError: out ? out.isError === true : true,
    ...(out ? {} : { threw: true }),
    ...(failureCode ? { failureCode } : {}),
    cancelled: signal?.aborted === true || failureCode === 'CANCELLED',
  });
}

/** One tool as Swipium serves it. tools/list and tools/call are answered from this table
 * (installToolHandlers), so argument validation, the stale-client mapping and the advertised
 * schemas never depend on SDK internals or SDK-version defaults. */
export interface ToolEntry {
  name: string;
  title?: string;
  description: string;
  annotations: Record<string, unknown>;
  /** z.object(shape).strict(): validates arguments and produces the advertised JSON schema. */
  schema: ToolInputSchema;
  /** Declared top-level parameters, in declaration order. */
  accepted: readonly string[];
  /** The wrapped handler (response mode, consent routing, cancellation scope); takes VALIDATED args. */
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

function installResponseModeWrapper(
  server: McpServer,
  sessions: SessionStore,
  surface: ToolSurfaceEntry[],
  attempted: Set<string>,
  tools: Map<string, ToolEntry>,
): void {
  const orig = server.registerTool.bind(server) as (name: string, config: unknown, handler: (...a: unknown[]) => unknown) => unknown;
  const valid = (m: unknown): m is 'compact' | 'normal' | 'verbose' => m === 'compact' || m === 'normal' || m === 'verbose';
  (server as unknown as { registerTool: typeof orig }).registerTool = (name, config, handler) => {
    attempted.add(name);
    if (!TOOL_NAME_SET.has(name)) return undefined; // assertToolSurface() makes this drop loud at startup
    // Capture the tool surface (name + description + per-field type descriptors) for the schema hash
    // (3.3 A/§5). Encoding each field's zod shape catches nested enum/type/optionality changes.
    const cfg = config as { title?: string; description?: string; inputSchema?: ToolInputShape } | undefined;
    const inputKeys = Object.entries(cfg?.inputSchema ?? {}).map(([k, v]) => `${k}:${describeZodField(v)}`);
    surface.push({ name, description: cfg?.description ?? '', inputKeys });
    // MCP annotations for every tool, from one reviewed table (src/lib/toolAnnotations.ts).
    const annotations = toolAnnotations(name as ToolName) as unknown as Record<string, unknown>;
    const annotated = { ...(config as Record<string, unknown>), annotations };
    const wrapped = async (...a: unknown[]) => {
      const first = a[0] as { sessionId?: string; responseMode?: unknown } | undefined;
      // Prefer the existing session's mode; fall back to a directly-passed responseMode so the
      // session-CREATING call (qa_start_session, no sessionId yet) also honors compact.
      const fromSession = first?.sessionId ? sessions.get(first.sessionId)?.responseMode : undefined;
      const mode = (fromSession ?? (valid(first?.responseMode) ? first!.responseMode : 'normal')) as 'compact' | 'normal' | 'verbose';
      // Every call records the project root it resolves (if any) so the result carries
      // `rootSource` (+ a note when the root was only guessed from the server cwd).
      // Consents minted/consumed during this call are bound to its sessionId (consent.ts).
      // Cancellation: the call's MCP signal (extra.signal, the handler's last argument) is scoped
      // to THIS call (abortScope): driver adb/WDA calls made by the tool abort with it, and a
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
      // Checked BEFORE the call so a tool that starts its own job never warns about itself.
      const jobNote = runningJobNote(sessions, name, first?.sessionId);
      const startedAt = Date.now();
      let out: CallToolResult | undefined;
      try {
        const result = await run(a);
        out = (await routePendingConsent(result, a, run, { sessions, tool: name })) as CallToolResult;
        recordToolErrorFromResult(sessions, name, a[0], out, callSignal); // qa_report tool status (report/toolHealth.ts)
        return jobNote ? annotateKeepingNotes(out, jobNote) : out;
      } finally {
        logToolCall(name, first?.sessionId, startedAt, out, callSignal);
      }
    };
    const schema = strictToolSchema(cfg?.inputSchema);
    tools.set(name, {
      name,
      ...(cfg?.title !== undefined ? { title: cfg.title } : {}),
      description: cfg?.description ?? '',
      annotations,
      schema,
      accepted: Object.keys(cfg?.inputSchema ?? {}),
      handler: (args, extra) => wrapped(args, extra),
    });
    // Also registered with the SDK so McpServer declares the tools capability; its own
    // tools/list + tools/call handlers are replaced by installToolHandlers once all tools exist.
    return orig(name, annotated, wrapped);
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

/** Top-level argument keys a tool's input schema does not declare. The advertised JSON schema
 * says additionalProperties:false, and the tool's strict zod object rejects them too: a call like
 * qa_app_control { action:"force_stop", appId:"other.app" } must never run against the session's
 * app while the caller believes it targeted another. Deprecated aliases that are still declared in
 * the schema are accepted (they are schema properties). Exported for tests. */
export function unknownArgumentKeys(args: Record<string, unknown> | undefined, accepted: readonly string[]): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const known = new Set(accepted);
  return Object.keys(args).filter((k) => !known.has(k));
}

export function unknownArgumentsError(name: string, unknown: string[], accepted: readonly string[]): CallToolResult {
  const shown = unknown.slice(0, MAX_ECHOED_KEYS).map(echoKey);
  const more = unknown.length > shown.length ? ` (+${unknown.length - shown.length} more)` : '';
  const list = (keys: readonly string[]) => keys.map((k) => JSON.stringify(k)).join(', ');
  return qaError(
    {
      what: `${name} does not accept the argument${unknown.length === 1 ? '' : 's'} ${list(shown)}${more}. Nothing was run.`,
      changedState: false,
      retrySafe: true,
      failureCode: 'INVALID_ARGUMENT',
      nextSteps: [
        `Remove ${list(shown)}${more} and re-call. Accepted parameters: ${accepted.length ? list(accepted) : '(none)'}.`,
        'If the tool list looks outdated, restart the MCP client so it reloads the current schemas.',
      ],
    },
    { unknownArguments: shown, ...(more ? { unknownArgumentCount: unknown.length } : {}), acceptedParameters: [...accepted] },
  );
}

/** Typed INVALID_ARGUMENT envelope for schema-validation failures (missing / wrong-typed / bad enum
 * arguments), one `path: message` entry per issue ("sessionId: Required; target.text: Expected
 * string, received number"). `issues` are already capped (checkToolArgs); `total` is the uncapped
 * count. Exported for tests. */
export function invalidArgumentsError(
  name: string,
  issues: ReadonlyArray<ToolArgIssue>,
  total: number,
  accepted: readonly string[],
): CallToolResult {
  const more = total > issues.length ? `; (+${total - issues.length} more)` : '';
  const what = issues.map((i) => `${i.path}: ${i.message}`).join('; ') + more;
  const list = (keys: readonly string[]) => keys.map((k) => JSON.stringify(k)).join(', ');
  return qaError(
    {
      what: `${name}: invalid arguments: ${what}. Nothing was run.`,
      changedState: false,
      retrySafe: true,
      failureCode: 'INVALID_ARGUMENT',
      nextSteps: [
        `Fix the listed argument(s) and re-call. Accepted parameters: ${accepted.length ? list(accepted) : '(none)'}.`,
        'If the tool list looks outdated, restart the MCP client so it reloads the current schemas.',
      ],
    },
    { invalidArguments: [...issues], acceptedParameters: [...accepted] },
  );
}

/** JSON-RPC code for "resource not found" (MCP spec 2025-11-25; the SDK enum has no name for it). */
export const RESOURCE_NOT_FOUND = -32002;

/** resources/read for a URI that matches a template but names nothing that exists: a typed
 * -32002 (with the URI in `data`) instead of the SDK's generic -32603 for a plain Error. */
export function resourceNotFound(uri: string, why: string): McpError {
  return new McpError(RESOURCE_NOT_FOUND, `Resource not found: ${uri}: ${why}`, { uri });
}

/** tools/call result for a tool name nobody registered: the isError text result SDK 1.x has always
 * produced (kept verbatim so clients see the same answer whatever SDK serves them). */
function unknownToolResult(name: string): CallToolResult {
  return { content: [{ type: 'text', text: `MCP error -32602: Tool ${name} not found` }], isError: true };
}

/**
 * tools/list and tools/call, answered from the ToolEntry table through the SDK's public low-level
 * `Server.setRequestHandler` (replacing the handlers McpServer installed at registration):
 *  - tools/list: every tool with its strict-object JSON schema (no `$schema` key), in registration
 *    order, computed once;
 *  - tools/call, in order: removed tool names and legacy call shapes > STALE_CLIENT (with the
 *    replacement + stale-client hint); unknown tool names > the SDK 1.x "Tool not found" isError
 *    result; undeclared top-level arguments > INVALID_ARGUMENT (unknownArguments); schema failures
 *    > INVALID_ARGUMENT (invalidArguments), or STALE_CLIENT when the call is a legacy shape; then
 *    the wrapped handler runs with the validated arguments. A handler that throws becomes an
 *    isError text result, as McpServer does.
 */
function installToolHandlers(server: McpServer, tools: ReadonlyMap<string, ToolEntry>): void {
  let listed: Array<Record<string, unknown>> | undefined;
  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    listed ??= [...tools.values()].map((t) => ({
      name: t.name,
      ...(t.title !== undefined ? { title: t.title } : {}),
      description: t.description,
      inputSchema: toolInputJsonSchema(t.schema),
      annotations: t.annotations,
      execution: { taskSupport: 'forbidden' },
    }));
    return { tools: listed } as ListToolsResult;
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = String(request.params.name);
    const args = request.params.arguments as Record<string, unknown> | undefined;
    const startedAt = Date.now();
    // Envelopes built here never reach the tool wrapper (the handler did not run): still log the
    // debug tool-call line for them. Session ids are caller input here: only a sane string is logged.
    const rejected = (out: CallToolResult): CallToolResult => {
      const sid = typeof args?.sessionId === 'string' && args.sessionId.length <= 64 ? args.sessionId : undefined;
      logToolCall(name.slice(0, 100), sid, startedAt, out, undefined);
      return out;
    };
    const replacement = staleClientReplacement(name, args);
    const tool = tools.get(name);
    if (!tool) return replacement ? rejected(staleClientError(name, replacement)) : unknownToolResult(name);
    if (!replacement) {
      const unknown = unknownArgumentKeys(args, tool.accepted);
      if (unknown.length) return rejected(unknownArgumentsError(name, unknown, tool.accepted));
    }
    const checked = checkToolArgs(tool.schema, args);
    if (!checked.ok) {
      // Legacy enum values fail the CURRENT schema: say what replaced them instead.
      if (replacement) return rejected(staleClientError(`${name} ${JSON.stringify(args?.action ?? args?.for)}`, replacement));
      return rejected(invalidArgumentsError(name, checked.issues, checked.total, tool.accepted));
    }
    try {
      return (await tool.handler(checked.data, extra)) as CallToolResult;
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}

/** Startup assertion: every registerTool() call must be
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
      (extra.length ? `\n  Extra (registered but not in TOOL_NAMES, so they would be silently dropped): ${extra.join(', ')}` : '') +
      '\nFix: add/remove the tool in TOOL_NAMES and CAPABILITY_GROUPS, or register it in createServer().',
  );
}

/** resources/list size cap. The SDK aggregates every template's list callback into one
 * un-paginated resources/list response, so each listing stays bounded. */
const RESOURCE_LIST_CAP = 100;

/** Cap a resources/list result and DISCLOSE the truncation on the final entry's description.
 * Silent truncation is forbidden. Clients read anything omitted here directly by URI
 * (qa_get_artifact / qa_app_map_read always cover the full set). */
function capResourceListing<T extends { description?: string }>(all: T[], cap = RESOURCE_LIST_CAP): T[] {
  if (all.length <= cap) return all;
  const shown = all.slice(0, cap);
  const last = shown[shown.length - 1];
  last.description = `${last.description ? `${last.description} ` : ''}[listing capped: showing ${cap} of ${all.length}; the rest remain readable by URI]`;
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
    // roots/list failed: fall back to the process-local roots only
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

/** App-map listings load every map JSON, so cache per scope, keyed on each root's map mtime.
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
  warnIgnoredPreapprovals(); // SWIPIUM_CONSENT_PREAPPROVE: one stderr line for ignored names
  const sessions = new SessionStore();
  const surface: ToolSurfaceEntry[] = [];
  const attemptedToolNames = new Set<string>();
  const tools = new Map<string, ToolEntry>();
  installResponseModeWrapper(server, sessions, surface, attemptedToolNames, tools);

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
  installToolHandlers(server, tools);

  // Reusable workflow templates (MCP prompts capability): thin orchestration of the tools above.
  registerPrompts(server);

  // Artifacts as MCP resources (clients that support them); qa_get_artifact is the fallback.
  // The list callback lets resource-aware clients BROWSE artifacts instead of mining
  // URIs out of tool text: newest RESOURCE_LIST_CAP across the sessions of the CURRENT project
  // root(s) (currentProjectRoots), straight from the in-memory ledger (no device calls).
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
            description: rec.label ? `${rec.kind}: ${rec.label}` : rec.kind,
          }));
        return { resources: capResourceListing(all) };
      },
    }),
    { title: 'QA artifact', description: 'Session artifacts: screenshots, dumps, reports, logs.' },
    async (uri) => {
      const found = sessions.findArtifact(uri.href);
      if (!found) throw resourceNotFound(uri.href, 'unknown artifact (check the URI, or list artifacts via resources/list or qa_report)');
      try {
        // Size-capped: big text returns head/tail + marker, big binaries are not inlined.
        return readArtifactResource(uri.href, found.rec);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw resourceNotFound(uri.href, 'the artifact file is gone (cleaned up?)');
        throw e;
      }
    },
  );

  // App Knowledge Map as MCP resources: full map + per-feature / per-screen /
  // test-suite sections, so large map data is read by URI instead of flooding a tool's text result.
  // Both app-map templates list what is ACTUALLY readable right now: section/full URIs
  // for every project root known to this run that has a map on disk; no map > empty list, never
  // an error. Enumeration is a local JSON load (listAppMapResources), scoped to the current project
  // root(s) and cached on map mtime (makeAppMapLister), no device calls. Listed section ids are
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
      if (!root) throw resourceNotFound(uri.href, `unknown project ${projectId} (build the map first with qa_app_map_build)`);
      const kind = vars.kind ? decodeUriSegment(String(vars.kind)) : undefined;
      const res = readAppMapResource(root, { kind, id: vars.id ? decodeUriSegment(String(vars.id)) : undefined });
      if (!res) throw resourceNotFound(uri.href, 'no such app-map section (list ids with qa_app_map_read)');
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
      if (!root) throw resourceNotFound(uri.href, `unknown project ${projectId} (build the map first with qa_app_map_build)`);
      const res = readAppMapResource(root, {});
      if (!res) throw resourceNotFound(uri.href, 'no app map on disk for this project (build it with qa_app_map_build)');
      return { contents: [{ uri: uri.href, mimeType: res.mimeType, text: res.text }] };
    },
  );

  return { server, sessions };
}

export async function startServer(): Promise<void> {
  // GUI MCP clients don't inherit the shell PATH: APPEND the Android SDK's platform-tools/ and
  // emulator/ to PATH, but only for a tool (adb / emulator) that is not already resolvable on PATH,
  // so the user's own copy is never shadowed. Idempotent (the CLI entry already calls it); done
  // here too so embedders that call startServer() directly get it.
  try {
    ensureAndroidToolsOnPath();
  } catch (e) {
    log('warn', 'android sdk path setup failed', { err: String(e) });
  }
  const { server, sessions } = createServer();
  const transport = new StdioServerTransport();

  // Persistence is debounced (SessionStore.persist), so make sure a graceful exit never
  // loses the trailing write. 'exit' handlers must be synchronous; flushAll is.
  process.once('exit', () => sessions.flushAll());

  // Best-effort: restore any network state Swipium changed, on shutdown / client disconnect
  // (so a budget-stop or crash mid-offline doesn't leave the emulator offline). Idempotent.
  let restoring = false;
  const restoreThenExit = async (code: number, why: string) => {
    if (restoring) return;
    restoring = true;
    const changed = sessions.list().filter((s) => s.network?.changed).length;
    // Cancel every running job FIRST: a job left running could flip device network state (or
    // anything else) back after the restore below.
    const cancelledJobs = cancelAllRunningJobs(sessions);
    log('info', 'shutdown: restoring network', { why, changed, cancelledJobs });
    try {
      if (cancelledJobs) await new Promise((r) => setImmediate(r)); // let aborted workers unwind
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
  // Chain AFTER connect: server.connect() sets its own transport.onclose, so we must wrap
  // it rather than assign before (which gets overwritten). stdin EOF = client disconnected.
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    sdkOnClose?.();
    void restoreThenExit(0, 'transport-close');
  };
  // The SDK's StdioServerTransport (1.29 to 1.32) never listens for stdin 'end', so onclose above
  // does not fire on EOF and an in-flight call (a 30 s qa_wait, a long job) kept the process
  // alive after the client was gone. Treat EOF as the disconnect it is.
  process.stdin.once('end', () => void restoreThenExit(0, 'stdin-end'));
  log('info', 'swipium connected over stdio');
  // Reap long-lived children (Metro, managed WDA, recorders) left behind by a crashed previous
  // server run. Runs AFTER connect and in the background, so a slow sweep (lock wait, WDA /status
  // probes) never delays the server becoming ready. Ownership + start-time/command fingerprint
  // checks make this safe next to a live concurrent instance and against recycled PIDs. A managed
  // WDA < 12 h old whose /status is healthy is ADOPTED instead (re-owned by this server) so a
  // resumed iOS session keeps its WDA (shutdown intentionally leaves managed WDA running).
  void startOrphanSweep();
}

/** Shutdown: cancel (abort) every running job in every session. Returns how many were cancelled.
 *  Exported for tests. */
export function cancelAllRunningJobs(sessions: Pick<SessionStore, 'list' | 'cancelJob'>): number {
  let n = 0;
  for (const s of sessions.list()) {
    for (const j of [...(s.jobs?.values() ?? [])]) {
      if (j.status !== 'running') continue;
      try {
        if (sessions.cancelJob(s, j.jobId)) n++;
      } catch (e) {
        log('warn', 'shutdown: cancel job failed', { sessionId: s.id, jobId: j.jobId, err: String(e) });
      }
    }
  }
  return n;
}

/** Background orphan sweep; never rejects. Exported for tests. */
export async function startOrphanSweep(reap: () => Promise<void> = reapOrphanedProcesses): Promise<void> {
  try {
    await reap();
  } catch (e) {
    log('warn', 'orphaned-process sweep failed', { err: String(e) });
  }
}
