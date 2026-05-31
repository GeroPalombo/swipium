// Portable consent state machine (DESIGN §10.2). Works WITHOUT client elicitation:
// a privileged action returns { requiresConsent, consentId, ... }; the agent surfaces
// it, the user approves, and the same tool is re-called with { consentId, approve:true }.

import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type Risk = 'low' | 'medium' | 'high';

export interface ConsentRequest {
  action: string; // install_toolchain | build_from_source | destructive_ui | write_path | run_on_prod | boot_emulator | install_app ...
  risk: Risk;
  exactCommand?: string;
  affects?: Record<string, unknown>;
  explain: string;
}

const pending = new Map<string, ConsentRequest>();

/** Build the tool result that asks for consent. */
export function requireConsent(req: ConsentRequest): CallToolResult {
  const consentId = randomUUID().slice(0, 8);
  pending.set(consentId, req);
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

export interface ConsentOutcome {
  approved: boolean;
  req?: ConsentRequest;
  reason?: string;
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
  const req = pending.get(consentId);
  if (!req) return { approved: false, reason: 'unknown or already-used consentId' };
  // Bind to the exact action/affects BEFORE consuming, so a mismatched id stays valid
  // for its real use rather than being silently burned.
  if (expected?.action && req.action !== expected.action) {
    return { approved: false, req, reason: `consent is for "${req.action}", not "${expected.action}"` };
  }
  if (expected?.affects && JSON.stringify(req.affects ?? {}) !== JSON.stringify(expected.affects)) {
    return { approved: false, req, reason: 'consent does not match the affected target' };
  }
  pending.delete(consentId);
  if (!approve) return { approved: false, req, reason: 'user did not approve' };
  return { approved: true, req };
}
