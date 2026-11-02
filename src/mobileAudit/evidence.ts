// Evidence + observation helpers for the executable mobile audit.
//
// Thin wrappers over the Driver + SessionStore so audit checks can capture a screenshot, read the
// current screen's visible text, and run a health check without each check duplicating that plumbing.
// Capture-guard aware (no pixels when session.sensitive or a secure field is on screen). Best-effort, never throws.

import { parseSnapshot, type RawNode } from '../snapshot/parse.js';
import { SNAPSHOT_REUSE_MS } from '../snapshot/fresh.js';
import { checkHealth, type HealthResult } from '../oracle/health.js';
import { canCaptureScreenshot } from '../lib/captureGuard.js';
import type { Driver } from '../drivers/Driver.js';
import type { Session, SessionStore } from '../session/store.js';

export interface AuditEvidenceCtx {
  sessions: SessionStore;
  session: Session;
  driver: Driver;
  appId?: string;
  /** Notes for evidence screenshots the capture guard withheld (sensitive session / secure field). */
  withheldCaptures?: string[];
}

// The UI tree the last snapshotText / health(xml) call read for this check context, handed to the
// next captureScreenshot (checks capture right after reading the screen). Only while young: an
// older read (an earlier check, a tap since) leaves the decision to the guard's own dump.
const lastTree = new WeakMap<AuditEvidenceCtx, { at: number; nodes: RawNode[] }>();
const TREE_REUSE_MS = SNAPSHOT_REUSE_MS;

/** Capture an evidence screenshot (sensitive-mode and secure-field aware). Returns the artifact URI,
 *  or undefined (a withheld capture is noted on ctx.withheldCaptures). */
export async function captureScreenshot(ctx: AuditEvidenceCtx, label: string): Promise<string | undefined> {
  // The tree a check just read (snapshotText / health) decides, so the guard adds no dump.
  const seen = lastTree.get(ctx);
  lastTree.delete(ctx);
  const nodes = seen && Date.now() - seen.at <= TREE_REUSE_MS ? seen.nodes : undefined;
  const verdict = await canCaptureScreenshot(ctx.session, ctx.driver, { nodes });
  if (!verdict.ok) {
    (ctx.withheldCaptures ??= []).push(`${label}: ${verdict.note}`);
    return undefined;
  }
  try {
    // capture-guard: guarded by canCaptureScreenshot above
    const png = await ctx.driver.screenshot();
    return ctx.sessions.saveArtifact(ctx.session, 'screenshot', `audit-${Date.now()}.png`, png, 'image/png', label);
  } catch {
    return undefined;
  }
}

/** Read the current screen's visible text (lowercased, joined). Best-effort: '' on failure. */
export async function snapshotText(ctx: AuditEvidenceCtx): Promise<string> {
  try {
    const xml = await ctx.driver.dumpXml();
    if (!xml) return '';
    const nodes = parseSnapshot(xml).allNodes;
    lastTree.set(ctx, { at: Date.now(), nodes });
    return nodes
      .map((n) => `${n.text ?? ''} ${n.desc ?? ''} ${n.id ?? ''}`)
      .join('  ')
      .toLowerCase();
  } catch {
    return '';
  }
}

/** Run a health check on the current screen (on `xml` when the caller already dumped it). */
export async function health(ctx: AuditEvidenceCtx, xml?: string): Promise<HealthResult> {
  if (xml) {
    try {
      lastTree.set(ctx, { at: Date.now(), nodes: parseSnapshot(xml).allNodes });
    } catch {
      lastTree.delete(ctx);
    }
  }
  return checkHealth(ctx.driver, ctx.appId, xml || undefined);
}

/** Current foreground app/owner. Best-effort: 'unknown'. */
export async function foreground(ctx: AuditEvidenceCtx): Promise<string> {
  try {
    return await ctx.driver.foregroundOwner();
  } catch {
    return 'unknown';
  }
}
