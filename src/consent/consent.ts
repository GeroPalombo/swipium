// Portable consent state machine. Works WITHOUT client elicitation:
// a privileged action returns { requiresConsent, consentId, ... }; the agent surfaces
// it, the user approves, and the same tool is re-called with { consentId, approve:true }.
//
// THREAT_MODEL: the re-call is made by the client, so a compromised client can self-approve.
// When the connected client advertises the MCP elicitation capability, server.ts installs an
// elicitation provider here and routes each pending consent through a REAL out-of-band user
// prompt (requestConsentDecision) before the envelope ever reaches the model. On such clients a
// declined, dismissed (`cancel`), timed-out or failed prompt is a REFUSAL — it never falls back
// to the model-mediated re-call. Which path decided an action is tagged as its
// ApprovalMechanism and lands in the mutation ledger.

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
   *  consumed by a call in the SAME session — a consent minted in A is useless in B. */
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
  // Map iteration order is insertion order → the first keys are the oldest challenges.
  while (pending.size > CONSENT_PENDING_CAP) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    forget(oldest);
  }
}

function forget(consentId: string): void {
  pending.delete(consentId);
  elicitationApproved.delete(consentId);
  awaitingElicitation.delete(consentId);
}

/** How a consent was decided (mutation-ledger audit trail, THREAT_MODEL):
 *  - 'elicitation'      — a real out-of-band user prompt (MCP elicitation) answered it;
 *  - 'client-assertion' — the client re-called with { consentId, approve:true } (portable path);
 *  - 'policy'           — the server refused it without asking (SWIPIUM_REQUIRE_ELICITATION=1). */
export type ApprovalMechanism = 'elicitation' | 'client-assertion' | 'policy';

/** What the out-of-band prompt answered.
 *  - 'unavailable' — the client does NOT advertise (form) elicitation; nothing was asked →
 *    portable re-call fallback.
 *  - 'cancelled'   — the prompt was dismissed (MCP `cancel`), timed out, or the transport failed
 *    while it was outstanding. The human never approved, so this is a REFUSAL, never a fallback. */
export type ElicitationAnswer = 'approved' | 'declined' | 'cancelled' | 'unavailable';
export interface ElicitationContext {
  /** The originating tool call's abort signal, so a cancelled call withdraws its prompt. */
  signal?: AbortSignal;
  /** The originating tool call's request id (associates the prompt with it on the transport). */
  relatedRequestId?: string | number;
}
export type ElicitationProvider = (req: ConsentRequest, ctx?: ElicitationContext) => Promise<ElicitationAnswer>;

let elicitationProvider: ElicitationProvider | undefined;

/** Installed once at server construction (src/server.ts); undefined disables elicitation. */
export function setElicitationProvider(provider: ElicitationProvider | undefined): void {
  elicitationProvider = provider;
}

// consentId → mechanism for approvals already consumed, so the mutation ledger can record
// HOW each privileged action was approved even at recording sites far from the gate
// (SessionStore.recordMutation reads this). Bounded like the ledger itself.
const consumedMechanisms = new Map<string, ApprovalMechanism>();
const elicitationApproved = new Set<string>();
// Challenges currently routed to (or decided by) an out-of-band prompt: a client re-call can
// never approve these — only the elicitation answer can (no approve:true bypass).
const awaitingElicitation = new Set<string>();

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
  const payload = { requiresConsent: true, consentId, ...req };
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
  | { mechanism: 'elicitation'; approved: false; outcome: 'declined' | 'cancelled'; reason: string }
  | { mechanism: 'client-assertion' }
  | { mechanism: 'refused'; reason: string };

/**
 * Ask the connected client's HUMAN to decide a freshly-minted consent via MCP elicitation.
 *  - approved  → the caller re-invokes the tool; consumeConsent tags mechanism 'elicitation'.
 *  - declined / cancelled (dismissed, timed out, transport error, aborted call) → REFUSAL: the
 *    challenge is burned so the client cannot self-approve it afterwards (a re-call of the tool
 *    mints a fresh challenge and a fresh prompt).
 *  - unavailable (client does not advertise elicitation) → portable re-call convention
 *    ('client-assertion') — unless SWIPIUM_REQUIRE_ELICITATION=1, in which case EVERY
 *    consent-gated action (builds, Metro, installs, data wipes, seeds…) is refused outright.
 */
export async function requestConsentDecision(consentId: string, ctx?: ElicitationContext): Promise<ConsentDecision> {
  const req = peekConsent(consentId);
  if (!req) return { mechanism: 'client-assertion' };
  let answer: ElicitationAnswer = 'unavailable';
  let failure: string | undefined;
  if (elicitationProvider) {
    awaitingElicitation.add(consentId);
    try {
      answer = await elicitationProvider(req, ctx);
    } catch (e) {
      // The client advertised elicitation, so a throw here is a timeout / transport failure /
      // aborted call / invalid answer while the prompt was outstanding: fail CLOSED.
      answer = 'cancelled';
      failure = e instanceof Error ? e.message : String(e);
    }
    if (answer === 'unavailable') awaitingElicitation.delete(consentId);
  }
  if (answer === 'approved') {
    elicitationApproved.add(consentId);
    return { mechanism: 'elicitation', approved: true };
  }
  if (answer === 'declined' || answer === 'cancelled') {
    forget(consentId);
    return {
      mechanism: 'elicitation',
      approved: false,
      outcome: answer,
      reason:
        answer === 'declined'
          ? `User declined "${req.action}" in the consent prompt`
          : `Consent prompt for "${req.action}" was dismissed or not answered${failure ? ` (${failure})` : ''} — treated as a refusal`,
    };
  }
  if (process.env.SWIPIUM_REQUIRE_ELICITATION === '1') {
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
    return { approved: false, reason: 'consent expired — re-call without consentId for a fresh challenge' };
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
  const routed = awaitingElicitation.has(consentId);
  forget(consentId);
  if (!approve) return { approved: false, req, reason: 'user did not approve' };
  // A challenge routed to an out-of-band prompt can only be approved BY that prompt: a client
  // re-call with approve:true (e.g. racing the dialog) must not bypass the human.
  if (routed && !wasElicited) return { approved: false, req, reason: 'consent is awaiting the out-of-band user prompt' };
  const mechanism: ApprovalMechanism = wasElicited ? 'elicitation' : 'client-assertion';
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
