// SWIPIUM-REQ-08 — evidence + observation helpers for the executable mobile audit.
//
// Thin wrappers over the Driver + SessionStore so audit checks can capture a screenshot, read the
// current screen's visible text, and run a health check without each check duplicating that plumbing.
// Sensitive-mode aware (no pixels when session.sensitive). Best-effort — never throws.

import { parseSnapshot } from '../snapshot/parse.js';
import { checkHealth, type HealthResult } from '../oracle/health.js';
import type { Driver } from '../drivers/Driver.js';
import type { Session, SessionStore } from '../session/store.js';

export interface AuditEvidenceCtx {
  sessions: SessionStore;
  session: Session;
  driver: Driver;
  appId?: string;
}

/** Capture an evidence screenshot (sensitive-mode aware). Returns the artifact URI or undefined. */
export async function captureScreenshot(ctx: AuditEvidenceCtx, label: string): Promise<string | undefined> {
  if (ctx.session.sensitive) return undefined;
  try {
    const png = await ctx.driver.screenshot();
    return ctx.sessions.saveArtifact(ctx.session, 'screenshot', `audit-${Date.now()}.png`, png, 'image/png', label);
  } catch {
    return undefined;
  }
}

/** Read the current screen's visible text (lowercased, joined). Best-effort → '' on failure. */
export async function snapshotText(ctx: AuditEvidenceCtx): Promise<string> {
  try {
    const xml = await ctx.driver.dumpXml();
    if (!xml) return '';
    const nodes = parseSnapshot(xml).allNodes;
    return nodes
      .map((n) => `${n.text ?? ''} ${n.desc ?? ''} ${n.id ?? ''}`)
      .join('  ')
      .toLowerCase();
  } catch {
    return '';
  }
}

/** Run a health check on the current screen. */
export async function health(ctx: AuditEvidenceCtx): Promise<HealthResult> {
  return checkHealth(ctx.driver, ctx.appId);
}

/** Current foreground app/owner. Best-effort → 'unknown'. */
export async function foreground(ctx: AuditEvidenceCtx): Promise<string> {
  try {
    return await ctx.driver.foregroundOwner();
  } catch {
    return 'unknown';
  }
}
