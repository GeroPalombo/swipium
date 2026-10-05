// Portable consent state machine. Works WITHOUT client elicitation:
// a privileged action returns { requiresConsent, consentId, ... }; the agent surfaces
// it, the user approves, and the same tool is re-called with { consentId, approve:true }.
//
// THREAT_MODEL: the re-call is made by the client, so a compromised client can self-approve.
// When the connected client advertises the MCP elicitation capability, server.ts installs an
// elicitation provider here and routes each pending consent through a REAL out-of-band user
// prompt (requestConsentDecision) before the envelope ever reaches the model. On such clients a
// declined, dismissed (`cancel`), timed-out or failed prompt is a REFUSAL. It never falls back
// to the model-mediated re-call. Which path decided an action is tagged as its
// ApprovalMechanism and lands in the mutation ledger.
//
// Protocol 2026-07-28 has no server-to-client requests: the same prompt rides inside an
// InputRequiredResult and the answer arrives on the client's retry of the tool call, correlated by
// a single-use server-side handle (issueConsentPrompt / redeemConsentPrompt below). The decision
// phases and outcomes are shared with the 2025 path; the ledger tags both 'elicitation'.
//
// Operator pre-approval (SWIPIUM_CONSENT_PREAPPROVE): headless clients (codex exec, claude -p)
// advertise elicitation but answer every prompt automatically (decline / cancel), so no gated
// action can ever run there. The OPERATOR can pre-approve exact action names in the server
// process environment (whatever the MCP client passes, e.g. its config `env`). It is read ONLY
// from process.env, never from the repo (.swipium/config.json etc.), so neither the model nor a
// checked-out project can grant it. No wildcards: each action must be named. Code-level tiers
// (CONSENT_ACTION_TIERS) narrow what a name can grant:
//  - runsCode actions execute repo- or model-chosen code/commands; they are pre-approvable only
//    when SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1 is ALSO set (under codex exec that lets the model
//    run code outside the client's sandbox);
//  - never-pre-approvable actions (wda_non_loopback, which has its own exact-URL opt-in) are
//    ignored;
//  - test_this_plan covers its bundled sub-steps only when every runsCode sub-step (e.g. a
//    build_from_source step) is itself pre-approvable.
// A pre-approved challenge is still session-bound and single-use; it is ledgered as
// 'operator-policy' and logged at warn with the exact command.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { log } from '../lib/logger.js';

export type Risk = 'low' | 'medium' | 'high';

export interface ConsentRequest {
  action: string; // install_toolchain | build_from_source | destructive_ui | write_path | run_on_prod | boot_emulator | install_app ...
  risk: Risk;
  exactCommand?: string;
  affects?: Record<string, unknown>;
  explain: string;
}

interface PendingConsent {
  req: ConsentRequest;
  createdAt: number;
  /** The session the challenge was minted in (when the minting call carried one): it can only be
   *  consumed by a call in the SAME session. A consent minted in A is useless in B. */
  sessionId?: string;
}

// The calling tool invocation's sessionId, set once per call by the server's tool wrapper
// (src/server.ts) so every consent-gated tool is session-bound with zero per-tool changes.
const consentScope = new AsyncLocalStorage<{ sessionId?: string }>();

/** Run `fn` as part of a tool call made in `sessionId` (undefined = no session). */
export function runWithConsentScope<T>(sessionId: string | undefined, fn: () => T): T {
  return consentScope.run({ sessionId: typeof sessionId === 'string' && sessionId ? sessionId : undefined }, fn);
}

function currentConsentSession(): string | undefined {
  return consentScope.getStore()?.sessionId;
}

// Pending challenges are bounded (review §4): a consent that is never resumed must not live
// forever, and a client minting challenges in a loop must not grow the map without limit.
// TTL comfortably exceeds the elicitation timeout below so an in-flight prompt never expires.
export const CONSENT_TTL_MS = 30 * 60_000;
export const CONSENT_PENDING_CAP = 200;
const pending = new Map<string, PendingConsent>();

function prunePending(now = Date.now()): void {
  for (const [id, p] of pending) {
    if (now - p.createdAt > CONSENT_TTL_MS) forget(id);
  }
  // Map iteration order is insertion order, so the first keys are the oldest challenges.
  while (pending.size > CONSENT_PENDING_CAP) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    forget(oldest);
  }
}

function forget(consentId: string): void {
  pending.delete(consentId);
  elicitationApproved.delete(consentId);
  operatorApproved.delete(consentId);
  awaitingElicitation.delete(consentId);
  const token = promptTokenByConsent.get(consentId);
  if (token !== undefined) promptHandles.delete(token);
  promptTokenByConsent.delete(consentId);
}

/** Every ConsentRequest.action a tool can mint (test/consentPreapprove.test.ts keeps this in sync
 *  with the requireConsent call sites). SWIPIUM_CONSENT_PREAPPROVE accepts only these names. */
export const CONSENT_ACTIONS = [
  'app_clear_data',
  'app_fresh_start',
  'automation_project_write',
  'build_from_source',
  'destructive_ui_candidate',
  'erase_device',
  'flow_mutation_run',
  'geo_set',
  'install_app',
  'network_change',
  'ocr_run',
  'permission_grant',
  'permission_revoke',
  'prepare_plan',
  'privacy_reset',
  'screen_record',
  'seed_state',
  'start_metro',
  'suite_fresh_state_replay',
  'test_this_plan',
  'wda_build',
  'wda_non_loopback',
  'wda_start',
] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
const CONSENT_ACTION_SET: ReadonlySet<string> = new Set(CONSENT_ACTIONS);

export interface ConsentActionTier {
  /** Executes repo- or model-chosen code/commands (build scripts, xcodebuild on a model-chosen
   *  project, fixture seed scripts, a repo-configured OCR/mask command, the project's Metro
   *  config). Pre-approvable only with SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE=1. */
  runsCode: boolean;
  /** Set when the action can never be pre-approved by name: why, and what to use instead. */
  notPreapprovable?: string;
}

/** Code-level risk tier per consent action (every action must be classified). */
export const CONSENT_ACTION_TIERS: Readonly<Record<ConsentAction, ConsentActionTier>> = {
  app_clear_data: { runsCode: false },
  app_fresh_start: { runsCode: false },
  automation_project_write: { runsCode: false }, // writes generated files, never runs them
  build_from_source: { runsCode: true }, // repo build scripts (gradle / xcodebuild / npm)
  destructive_ui_candidate: { runsCode: false },
  erase_device: { runsCode: false },
  flow_mutation_run: { runsCode: true }, // seed scripts from repo fixtures, external OCR, openUrl with variables
  geo_set: { runsCode: false },
  install_app: { runsCode: false },
  network_change: { runsCode: false },
  ocr_run: { runsCode: true }, // repo-configured OCR / visual mask command
  permission_grant: { runsCode: false },
  permission_revoke: { runsCode: false },
  prepare_plan: { runsCode: false },
  privacy_reset: { runsCode: false },
  screen_record: { runsCode: false },
  seed_state: { runsCode: true }, // fixture seed scripts from the repo
  start_metro: { runsCode: true }, // npx expo/react-native start loads the project's Metro/Babel config
  suite_fresh_state_replay: { runsCode: true }, // state-profile prepare/teardown can run seed scripts
  test_this_plan: { runsCode: false }, // bundled sub-steps are checked separately (planRunsCodeSteps)
  wda_build: { runsCode: true }, // xcodebuild on a model-chosen wdaProjectPath
  wda_non_loopback: {
    runsCode: false,
    notPreapprovable: 'use SWIPIUM_ALLOW_REMOTE_WDA=<exact URL> (the exact-URL pre-approval for remote WDA)',
  },
  wda_start: { runsCode: true }, // xcodebuild on a model-chosen wdaProjectPath
};

export const PREAPPROVE_ENV = 'SWIPIUM_CONSENT_PREAPPROVE';
export const PREAPPROVE_RUN_CODE_ENV = 'SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE';

function tierOf(action: string): ConsentActionTier | undefined {
  return CONSENT_ACTION_SET.has(action) ? CONSENT_ACTION_TIERS[action as ConsentAction] : undefined;
}

/** True when the action executes repo- or model-chosen code (see ConsentActionTier.runsCode). */
export function actionRunsCode(action: string): boolean {
  return tierOf(action)?.runsCode === true;
}

export interface ParsedPreapproval {
  /** Names that are honoured (pre-approved). */
  actions: Set<string>;
  /** Unknown names, wildcards, risk thresholds: never honoured. */
  ignored: string[];
  /** Known names that are NOT honoured, with the reason (runsCode without the opt-in, or never
   *  pre-approvable). */
  blocked: { name: string; reason: string }[];
}

/** Parse SWIPIUM_CONSENT_PREAPPROVE: comma-separated exact action names. Anything else (unknown
 *  names, `*`, `risk<=x`) is NOT honoured and is returned in `ignored`. Known names whose tier
 *  forbids pre-approval are returned in `blocked`. `runCode` is SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE. */
export function parseConsentPreapproval(raw: string | undefined, runCode?: string): ParsedPreapproval {
  const actions = new Set<string>();
  const ignored: string[] = [];
  const blocked: { name: string; reason: string }[] = [];
  const runCodeOptIn = runCode?.trim() === '1';
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim();
    if (!name) continue;
    const tier = tierOf(name);
    if (!tier) ignored.push(name);
    else if (tier.notPreapprovable) blocked.push({ name, reason: `never pre-approvable: ${tier.notPreapprovable}` });
    else if (tier.runsCode && !runCodeOptIn)
      blocked.push({
        name,
        reason: `runs repo- or model-chosen code: also set ${PREAPPROVE_RUN_CODE_ENV}=1 to pre-approve it`,
      });
    else actions.add(name);
  }
  return { actions, ignored, blocked };
}

function currentPreapproval(): ParsedPreapproval {
  return parseConsentPreapproval(process.env[PREAPPROVE_ENV], process.env[PREAPPROVE_RUN_CODE_ENV]);
}

/** True when the operator pre-approved `action` in the server's own environment (and its tier
 *  allows it). Read per call from process.env only (never repo config). */
export function isOperatorPreapproved(action: string): boolean {
  return currentPreapproval().actions.has(action);
}

/** test_this_plan bundles sub-steps; return the kinds of the ones that run code. Read from the
 *  structured `affects.steps[].kind` (src/services/preflight.ts) AND the `exactCommand` bullet
 *  lines ("• <kind>: <cmd>"), so a malformed payload fails closed rather than open. */
export function planRunsCodeSteps(req: ConsentRequest): string[] {
  const kinds = new Set<string>();
  const steps = (req.affects as { steps?: unknown } | undefined)?.steps;
  if (Array.isArray(steps)) {
    for (const st of steps) {
      const kind = (st as { kind?: unknown } | null)?.kind;
      if (typeof kind === 'string') kinds.add(kind);
    }
  }
  for (const line of (req.exactCommand ?? '').split('\n')) {
    const m = /^\s*(?:•\s*)?([a-z_]+)\s*(?::|$)/.exec(line);
    if (m) kinds.add(m[1]);
  }
  return [...kinds].filter((k) => actionRunsCode(k)).sort();
}

export type OperatorPolicyCheck = { approved: true } | { approved: false; reason?: string };

/** Does the operator policy approve this exact request? Unlike isOperatorPreapproved, this also
 *  applies the test_this_plan sub-step rule. `reason` is set when the action is listed but the
 *  policy still does not cover it. */
export function operatorPolicyCovers(req: ConsentRequest): OperatorPolicyCheck {
  const { actions } = currentPreapproval();
  if (!actions.has(req.action)) return { approved: false };
  if (req.action === 'test_this_plan') {
    const uncovered = planRunsCodeSteps(req).filter((k) => !actions.has(k));
    if (uncovered.length)
      return {
        approved: false,
        reason:
          `test_this_plan includes ${uncovered.join(', ')}, which runs code and is not itself pre-approved ` +
          `(list it in ${PREAPPROVE_ENV} and set ${PREAPPROVE_RUN_CODE_ENV}=1)`,
      };
  }
  return { approved: true };
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Case-insensitive near-miss for an unknown name ("INSTALL-APP" > install_app), or undefined. */
export function suggestConsentAction(name: string): string | undefined {
  const norm = name
    .trim()
    .toLowerCase()
    .replace(/[-\s.]+/g, '_');
  if (!norm || /[*<>=]/.test(norm)) return undefined;
  let best: { name: string; d: number } | undefined;
  for (const a of CONSENT_ACTIONS) {
    const d = levenshtein(norm, a);
    if (!best || d < best.d) best = { name: a, d };
  }
  return best && best.d <= Math.max(1, Math.floor(best.name.length / 4)) ? best.name : undefined;
}

let preapprovalWarned = false;
/** One stderr line at startup for each class of names in SWIPIUM_CONSENT_PREAPPROVE that is ignored. */
export function warnIgnoredPreapprovals(): void {
  if (preapprovalWarned) return;
  const raw = process.env[PREAPPROVE_ENV];
  if (!raw) return;
  preapprovalWarned = true;
  const { actions, ignored, blocked } = currentPreapproval();
  if (ignored.length) {
    const suggestions = ignored
      .map((n) => ({ n, s: suggestConsentAction(n) }))
      .filter((x): x is { n: string; s: string } => !!x.s)
      .map((x) => `"${x.n}": did you mean ${x.s}?`);
    log('warn', `${PREAPPROVE_ENV}: ignoring unknown action names (exact names only, no wildcards)`, {
      ignored,
      ...(suggestions.length ? { suggestions } : {}),
      known: CONSENT_ACTIONS,
    });
  }
  if (blocked.length) log('warn', `${PREAPPROVE_ENV}: ignoring actions that cannot be pre-approved this way`, { blocked });
  if (actions.size) log('info', `${PREAPPROVE_ENV}: operator pre-approved consent actions`, { actions: [...actions] });
}

/** Headless-client hint for a decline / cancel nobody may have seen (only add it when the answer
 *  was likely automatic: a real human decline must not be nudged toward disabling consent). */
export function preapproveHint(action: string, req?: ConsentRequest): string {
  const tier = tierOf(action);
  const lead = 'If this client runs headless (codex exec, claude -p), it answers consent prompts automatically. ';
  if (tier?.notPreapprovable) return `${lead}"${action}" cannot be pre-approved by name: ${tier.notPreapprovable}.`;
  const names = [action, ...(req && action === 'test_this_plan' ? planRunsCodeSteps(req) : [])];
  const needsRunCode = names.some((n) => actionRunsCode(n));
  return (
    lead +
    `An operator can pre-approve this action with ${PREAPPROVE_ENV}=${names.join(',')} in the MCP server env` +
    (needsRunCode
      ? ` plus ${PREAPPROVE_RUN_CODE_ENV}=1, because it runs repository or model-chosen code (under codex exec, outside the client sandbox).`
      : '.')
  );
}

/** Audit line for an approval nobody was asked about: the action plus the exact command(s), or a
 *  short hash and the first 200 chars when the command is long. */
function commandAudit(req: ConsentRequest): Record<string, unknown> {
  const cmd = req.exactCommand ?? '';
  if (!cmd) return { exactCommand: null, affects: JSON.stringify(req.affects ?? {}).slice(0, 200) };
  if (cmd.length <= 200) return { exactCommand: cmd };
  return {
    exactCommandSha256: createHash('sha256').update(cmd).digest('hex').slice(0, 16),
    exactCommandHead: cmd.slice(0, 200),
    exactCommandLength: cmd.length,
  };
}

/** A decline / cancel faster than this was most likely answered by the client, not a human. */
export const AUTO_ANSWER_MS = 1500;

/** How a consent was decided (mutation-ledger audit trail, THREAT_MODEL):
 *  - 'elicitation': a real out-of-band user prompt (MCP elicitation) answered it: an
 *    `elicitation/create` request on 2025-era connections, or the same form carried inside an
 *    InputRequiredResult (multi round-trip request) on protocol 2026-07-28;
 *  - 'client-assertion': the client re-called with { consentId, approve:true } (portable path);
 *  - 'policy': the server refused it without asking (SWIPIUM_REQUIRE_ELICITATION=1);
 *  - 'operator-policy': approved without asking because the operator listed the action in
 *    SWIPIUM_CONSENT_PREAPPROVE (server env). */
export type ApprovalMechanism = 'elicitation' | 'client-assertion' | 'policy' | 'operator-policy';

/** What the out-of-band prompt answered.
 *  - 'unavailable': the client does NOT advertise (form) elicitation; nothing was asked, so
 *    portable re-call fallback.
 *  - 'cancelled': the prompt was dismissed (MCP `cancel`), timed out, or the transport failed
 *    while it was outstanding. The human never approved, so this is a REFUSAL, never a fallback. */
export type ElicitationAnswer = 'approved' | 'declined' | 'cancelled' | 'unavailable';
export interface ElicitationContext {
  /** The originating tool call's abort signal, so a cancelled call withdraws its prompt. */
  signal?: AbortSignal;
  /** The originating tool call's request id (associates the prompt with it on the transport). */
  relatedRequestId?: string | number;
  /** The provider of the server instance serving this call (falls back to the one installed with
   *  setElicitationProvider). */
  provider?: ElicitationProvider;
}
export type ElicitationProvider = (req: ConsentRequest, ctx?: ElicitationContext) => Promise<ElicitationAnswer>;

let elicitationProvider: ElicitationProvider | undefined;

/** Installed once at server construction (src/server.ts); undefined disables elicitation. */
export function setElicitationProvider(provider: ElicitationProvider | undefined): void {
  elicitationProvider = provider;
}

// consentId > mechanism for approvals already consumed, so the mutation ledger can record
// HOW each privileged action was approved even at recording sites far from the gate
// (SessionStore.recordMutation reads this). Bounded like the ledger itself.
const consumedMechanisms = new Map<string, ApprovalMechanism>();
const elicitationApproved = new Set<string>();
// Challenges approved by SWIPIUM_CONSENT_PREAPPROVE (consumed like an elicitation approval).
const operatorApproved = new Set<string>();
// Challenges currently routed to (or decided by) an out-of-band prompt: a client re-call can
// never approve these. Only the elicitation answer can (no approve:true bypass).
const awaitingElicitation = new Set<string>();

// Protocol 2026-07-28 (multi round-trip requests): a consent prompt travels to the client inside
// an InputRequiredResult and its answer comes back on a RETRY of the original tools/call, carrying
// the `requestState` we issued. That requestState is an opaque, unguessable, SINGLE-USE handle
// (32 random bytes); everything it stands for (consentId, tool, digest of the call's arguments,
// sessionId, issue time) stays HERE, server-side, and is never read back from the client. So a
// tampered or invented handle can only fail the lookup, a replayed one is already gone, and a
// handle presented on a different tool / arguments / session does not match its binding.
export interface ConsentPromptBinding {
  tool: string;
  /** sha256 of the canonical JSON of the call's validated arguments (sessionId included). */
  argsDigest: string;
  sessionId?: string;
}
export interface ConsentPromptHandle extends ConsentPromptBinding {
  consentId: string;
  issuedAt: number;
}
const promptHandles = new Map<string, ConsentPromptHandle>(); // token > handle
const promptTokenByConsent = new Map<string, string>(); // consentId > its one live token

/** Mechanism that approved an already-consumed consentId (audit trail for the ledger). */
export function approvalMechanismFor(consentId: string): ApprovalMechanism | undefined {
  return consumedMechanisms.get(consentId);
}

/** The still-pending request behind a consentId (read-only; used to ledger a refusal). */
export function peekConsent(consentId: string): ConsentRequest | undefined {
  const p = pending.get(consentId);
  if (!p || Date.now() - p.createdAt > CONSENT_TTL_MS) return undefined;
  return p.req;
}

/** Burn a pending challenge without approving it (e.g. the routed action changed under a prompt). */
export function burnConsent(consentId: string): void {
  forget(consentId);
}

/** Build the tool result that asks for consent. */
export function requireConsent(req: ConsentRequest): CallToolResult {
  prunePending();
  const consentId = randomUUID().slice(0, 8);
  const sessionId = currentConsentSession();
  pending.set(consentId, { req, createdAt: Date.now(), ...(sessionId ? { sessionId } : {}) });
  // `next` repeats the approval instruction in structuredContent: Claude Code / Codex show the
  // model that JSON, not the text block, for non-error results.
  const payload = {
    requiresConsent: true,
    consentId,
    ...req,
    next: [`To approve, re-call this tool with consentId="${consentId}" and approve=true`],
  };
  const text =
    `🔐 Consent required (${req.risk}): ${req.explain}\n` +
    (req.exactCommand ? `Will run: ${req.exactCommand}\n` : '') +
    `To approve, re-call this tool with consentId="${consentId}" and approve=true.\n\n` +
    '```json\n' +
    JSON.stringify(payload, null, 2) +
    '\n```';
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

export type ConsentDecision =
  | { mechanism: 'elicitation'; approved: true }
  | {
      mechanism: 'elicitation';
      approved: false;
      outcome: 'declined' | 'cancelled';
      reason: string;
      elapsedMs: number;
      /** Set when the elicitation itself failed (timeout, transport error, aborted call) rather
       *  than the client answering: then nobody answered, so it is never "likely automatic". */
      failure?: string;
    }
  | { mechanism: 'operator-policy'; approved: true }
  | { mechanism: 'client-assertion' }
  | { mechanism: 'refused'; reason: string };

/**
 * Ask the connected client's HUMAN to decide a freshly-minted consent via MCP elicitation.
 *  - operator-policy: the action is listed in SWIPIUM_CONSENT_PREAPPROVE, so it is approved
 *    without asking (any client, and even with SWIPIUM_REQUIRE_ELICITATION=1: the operator made
 *    that decision explicitly). consumeConsent tags it 'operator-policy'.
 *  - approved: the caller re-invokes the tool; consumeConsent tags mechanism 'elicitation'.
 *  - declined / cancelled (dismissed, timed out, transport error, aborted call): REFUSAL. The
 *    challenge is burned so the client cannot self-approve it afterwards (a re-call of the tool
 *    mints a fresh challenge and a fresh prompt).
 *  - unavailable (client does not advertise elicitation): portable re-call convention
 *    ('client-assertion'), unless SWIPIUM_REQUIRE_ELICITATION=1, in which case EVERY
 *    consent-gated action (builds, Metro, installs, data wipes, seeds…) is refused outright.
 * Protocol 2026-07-28 connections cannot await an answer inside one request: src/server.ts runs
 * the same phases itself (operatorPolicyDecision, issueConsentPrompt / redeemConsentPrompt,
 * settleConsentAnswer, noPromptDecision), so both eras share every outcome below.
 */
export async function requestConsentDecision(consentId: string, ctx?: ElicitationContext): Promise<ConsentDecision> {
  const req = peekConsent(consentId);
  if (!req) return { mechanism: 'client-assertion' };
  const byPolicy = operatorPolicyDecision(consentId);
  if (byPolicy) return byPolicy;
  const startedAt = Date.now();
  let answer: ElicitationAnswer = 'unavailable';
  let failure: string | undefined;
  const provider = ctx?.provider ?? elicitationProvider;
  if (provider) {
    awaitingElicitation.add(consentId);
    try {
      answer = await provider(req, ctx);
    } catch (e) {
      // The client advertised elicitation, so a throw here is a timeout / transport failure /
      // aborted call / invalid answer while the prompt was outstanding: fail CLOSED.
      answer = 'cancelled';
      failure = e instanceof Error ? e.message : String(e);
    }
    if (answer === 'unavailable') awaitingElicitation.delete(consentId);
  }
  if (answer === 'unavailable') return noPromptDecision(consentId);
  return settleConsentAnswer(consentId, answer, Date.now() - startedAt, failure);
}

/** Phase 1 (both eras): the operator pre-approval (SWIPIUM_CONSENT_PREAPPROVE + its tiers), checked
 *  BEFORE anyone is asked. Returns the approval, or undefined when the user must decide. */
export function operatorPolicyDecision(consentId: string): ConsentDecision | undefined {
  const req = peekConsent(consentId);
  if (!req) return undefined;
  const policy = operatorPolicyCovers(req);
  if (policy.approved) {
    operatorApproved.add(consentId);
    // warn, not info: SWIPIUM_LOG_LEVEL=warn must still show what ran without a prompt.
    log('warn', `consent approved by operator policy (${PREAPPROVE_ENV}), no prompt shown`, {
      action: req.action,
      consentId,
      risk: req.risk,
      ...commandAudit(req),
    });
    return { mechanism: 'operator-policy', approved: true };
  }
  if (policy.reason)
    log('warn', `${PREAPPROVE_ENV} does not cover this request; asking instead`, { action: req.action, consentId, reason: policy.reason });
  return undefined;
}

/** Phase 2 (both eras): record what the out-of-band prompt answered. 'approved' lets the caller
 *  re-invoke the tool (consumeConsent tags it 'elicitation'); anything else burns the challenge. */
export function settleConsentAnswer(
  consentId: string,
  answer: 'approved' | 'declined' | 'cancelled',
  elapsedMs: number,
  failure?: string,
): Extract<ConsentDecision, { mechanism: 'elicitation' }> {
  const action = peekConsent(consentId)?.action ?? 'unknown';
  if (answer === 'approved') {
    elicitationApproved.add(consentId);
    return { mechanism: 'elicitation', approved: true };
  }
  forget(consentId);
  return {
    mechanism: 'elicitation',
    approved: false,
    outcome: answer,
    elapsedMs,
    ...(failure !== undefined ? { failure } : {}),
    reason:
      answer === 'declined'
        ? `User declined "${action}" in the consent prompt`
        : failure !== undefined
          ? `Consent prompt for "${action}" failed before anyone answered (${failure}), treated as a refusal`
          : `Consent prompt for "${action}" was dismissed or not answered, treated as a refusal`,
  };
}

/** Phase 2 when the client cannot show a prompt (no form elicitation): the portable re-call
 *  ('client-assertion'), or a refusal under SWIPIUM_REQUIRE_ELICITATION=1. */
export function noPromptDecision(consentId: string): ConsentDecision {
  const req = peekConsent(consentId);
  if (req && process.env.SWIPIUM_REQUIRE_ELICITATION === '1') {
    forget(consentId);
    return {
      mechanism: 'refused',
      reason:
        `SWIPIUM_REQUIRE_ELICITATION=1: "${req.action}" (risk ${req.risk}) needs an out-of-band user prompt, ` +
        'but the connected client does not support MCP elicitation.',
    };
  }
  return { mechanism: 'client-assertion' };
}

/** Protocol 2026-07-28: open (or re-open) the out-of-band prompt for a pending consent and return
 *  the single-use requestState handle for its InputRequiredResult. From here on only the prompt's
 *  answer can approve the consent (an approve:true re-call is refused, as on 2025 elicitation).
 *  Re-opening replaces the previous handle. Undefined when the consent is no longer pending. */
export function issueConsentPrompt(consentId: string, binding: ConsentPromptBinding): string | undefined {
  if (!peekConsent(consentId)) return undefined;
  const previous = promptTokenByConsent.get(consentId);
  if (previous !== undefined) promptHandles.delete(previous);
  const token = `swp1.${randomBytes(32).toString('base64url')}`;
  promptHandles.set(token, {
    consentId,
    tool: binding.tool,
    argsDigest: binding.argsDigest,
    ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
    issuedAt: Date.now(),
  });
  promptTokenByConsent.set(consentId, token);
  awaitingElicitation.add(consentId);
  return token;
}

/** Protocol 2026-07-28: redeem a requestState handle. SINGLE-USE: the handle is deleted on the
 *  first presentation, whatever happens next. Undefined for an unknown, forged, replayed or
 *  expired handle (the consent behind it is pruned with the challenge, CONSENT_TTL_MS). */
export function redeemConsentPrompt(token: string): ConsentPromptHandle | undefined {
  prunePending();
  const handle = promptHandles.get(token);
  if (!handle) return undefined;
  promptHandles.delete(token);
  if (promptTokenByConsent.get(handle.consentId) === token) promptTokenByConsent.delete(handle.consentId);
  return handle;
}

export interface ConsentOutcome {
  approved: boolean;
  req?: ConsentRequest;
  reason?: string;
  /** Set only on approval: how the user decided (see ApprovalMechanism). */
  mechanism?: ApprovalMechanism;
}

/**
 * Validate a resume call. Consent is single-use AND bound to the exact action:
 * `expected.action`/`expected.affects` must match what was originally requested, so an
 * approval issued for one action can't be replayed against a different one.
 */
export function consumeConsent(
  consentId?: string,
  approve?: boolean,
  expected?: { action?: string; affects?: Record<string, unknown> },
): ConsentOutcome {
  if (!consentId) return { approved: false, reason: 'no consentId supplied' };
  const entry = pending.get(consentId);
  if (entry && Date.now() - entry.createdAt > CONSENT_TTL_MS) {
    forget(consentId);
    return { approved: false, reason: 'consent expired; re-call without consentId for a fresh challenge' };
  }
  const req = entry?.req;
  if (!req) return { approved: false, reason: 'unknown or already-used consentId' };
  // Session binding: checked BEFORE consuming (like the action binding) so a cross-session replay
  // attempt never burns the challenge for its real session.
  if (entry.sessionId !== undefined && entry.sessionId !== currentConsentSession()) {
    return { approved: false, req, reason: 'consent was issued for a different session' };
  }
  // Bind to the exact action/affects BEFORE consuming, so a mismatched id stays valid
  // for its real use rather than being silently burned.
  if (expected?.action && req.action !== expected.action) {
    return { approved: false, req, reason: `consent is for "${req.action}", not "${expected.action}"` };
  }
  if (expected?.affects && JSON.stringify(req.affects ?? {}) !== JSON.stringify(expected.affects)) {
    return { approved: false, req, reason: 'consent does not match the affected target' };
  }
  const wasElicited = elicitationApproved.has(consentId);
  const byOperator = operatorApproved.has(consentId);
  const routed = awaitingElicitation.has(consentId);
  forget(consentId);
  if (!approve) return { approved: false, req, reason: 'user did not approve' };
  // A challenge routed to an out-of-band prompt can only be approved BY that prompt: a client
  // re-call with approve:true (e.g. racing the dialog) must not bypass the human.
  if (routed && !wasElicited) return { approved: false, req, reason: 'consent is awaiting the out-of-band user prompt' };
  const mechanism: ApprovalMechanism = byOperator ? 'operator-policy' : wasElicited ? 'elicitation' : 'client-assertion';
  recordMechanism(consentId, mechanism);
  return { approved: true, req, mechanism };
}

function recordMechanism(consentId: string, mechanism: ApprovalMechanism): void {
  consumedMechanisms.set(consentId, mechanism);
  if (consumedMechanisms.size > 500) {
    const oldest = consumedMechanisms.keys().next().value;
    if (oldest !== undefined) consumedMechanisms.delete(oldest);
  }
}

/** Test/diagnostic view of the pending-challenge map size (bounded by CONSENT_PENDING_CAP). */
export function pendingConsentCount(): number {
  return pending.size;
}
