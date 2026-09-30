// qa_snapshot — the observation layer.
// Snapshot returns compact @eN refs + a snapshotQuality verdict (+ optional diff).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { parseSnapshot, signature, renderElements } from '../snapshot/parse.js';
import { presentElements } from '../snapshot/present.js';
import { makeRedactor, isSecureNode } from '../lib/redact.js';
import { detectTreeOverlays, classifyForeground } from '../snapshot/overlays.js';
import { detectAuthScreen } from '../oracle/auth.js';
import { dumpRootPackage } from '../oracle/health.js';
import { blockedDeviceResult, getDriver, REHYDRATE_NOTE } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';
import { runWithSignal } from '../lib/abortScope.js';

export function registerSnapshot(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_snapshot',
    {
      title: 'Snapshot the screen',
      description:
        'Capture the screen as compact addressable elements (@e1, @e2 …) with a snapshotQuality verdict. Interactive-only and ' +
        'no screenshot by default; busy screens are capped (use filter for the rest). Use @eN refs with qa_act; re-snapshot ' +
        'after navigation.',
      inputSchema: {
        sessionId: z.string(),
        diff: z.boolean().optional().describe('Only what changed since the previous snapshot.'),
        filter: z.string().optional().describe('Substring match on text/label/id/role (finds capped elements).'),
      },
    },
    async ({ sessionId, diff, filter }, extra) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return unknownSessionError(sessionId);
      }
      const { driver, rehydrated, blocked } = await getDriver(session);
      if (!driver) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE',
            nextSteps: ['Call qa_prepare_target first.'],
          })
        );
      }
      // Cancellation: this call's signal is scoped to the call (abortScope), so aborting it never
      // touches a concurrently running job's adb/WDA calls (and vice versa).
      return runWithSignal(extra?.signal, async () => {
        if (driver.kind === 'simulator') {
          return qaError({
            what: 'A structured UI tree is not available on the iOS simulator backend',
            changedState: false,
            retrySafe: false,
            failureCode: 'BACKEND_UNSUPPORTED',
            nextSteps: [
              'Attach WebDriverAgent with qa_wda for a structured UI tree. Without WDA, use qa_screenshot + qa_visual mode:"assert".',
            ],
          });
        }

        // Already in visual-fallback (uiautomator can't reach idle on this app) → don't keep
        // hammering structured dumps; point the agent at the visual tools immediately.
        if (session.mode === 'visual-fallback') {
          return qaError({
            what: 'Session is in visual-fallback mode — structured snapshots are unavailable on this screen.',
            changedState: false,
            retrySafe: false,
            failureCode: 'VISUAL_ONLY_SCREEN',
            nextSteps: ['Use qa_screenshot, then qa_act with coordinate targets (durationMs press). qa_check_health still works.'],
          });
        }

        let xml: string;
        try {
          xml = await driver.dumpXml();
        } catch (e) {
          // Classify repeated idle-state / dump failures and switch to visual fallback.
          const msg = String(e);
          const idle = /idle|could not get idle|dump/i.test(msg);
          sessions.bump(session, 'snapshotFailures');
          const failures = session.counters.snapshotFailures;
          if (failures >= session.budget.maxSnapshotFailures) {
            sessions.setMode(session, 'visual-fallback');
            return qaError({
              what: `Could not produce a UI tree after ${failures} attempts${idle ? ' (never reached idle)' : ''} — likely a looping animation, dev overlay, web view, or canvas.`,
              changedState: false,
              retrySafe: false,
              failureCode: 'VISUAL_ONLY_SCREEN',
              nextSteps: [
                'Switched session to visual-fallback mode.',
                'Use qa_screenshot, then qa_act with coordinate targets (taps default to a short press).',
                'qa_check_health stays available (crash/ANR/foreground).',
              ],
            });
          }
          return qaError({
            what: `Snapshot (UI tree dump) failed (${failures}/${session.budget.maxSnapshotFailures})${idle ? ' — never reached idle' : ''}: ${msg}`,
            changedState: false,
            retrySafe: true,
            failureCode: 'SNAPSHOT_FAILED',
            nextSteps: [`Retry; after ${session.budget.maxSnapshotFailures} failures Swipium switches to visual-fallback (screenshots).`],
          });
        }

        const parsed = parseSnapshot(xml, { interactiveOnly: true });
        const prev = session.lastSnapshot;
        const newSigs = new Set(parsed.elements.map(signature));
        const redact = makeRedactor(session.secrets);
        const f = filter?.trim().toLowerCase();
        const pool = f
          ? parsed.elements.filter((e) => [e.text, e.label, e.id, e.role].some((v) => v?.toLowerCase().includes(f)))
          : parsed.elements;
        const { elements: shown, rendered, omitted } = presentElements(pool, redact);

        let diffText = '';
        let diffPayload: { added: string[]; removed: string[] } | undefined;
        if (diff && prev) {
          const added = parsed.elements.filter((e) => !prev.signatures.has(signature(e)));
          const removed = [...prev.signatures].filter((s) => !newSigs.has(s));
          const addedShown = presentElements(added, redact).elements;
          diffPayload = { added: addedShown.map((e) => e.ref + ' ' + (e.label ?? e.text ?? e.role)), removed };
          diffText = `\nDIFF vs previous: +${added.length} / -${removed.length}\n` + renderElements(addedShown);
        }

        // persist for inspect + next diff (fullByRef keeps raw nodes; masking happens on emit)
        session.lastSnapshot = { fullByRef: parsed.fullByRef, signatures: newSigs, allNodes: parsed.allNodes };

        // Auth-state awareness (P1.5): note login screens; the FIRST screen seen sets authedAtStart.
        const auth = detectAuthScreen(parsed.allNodes);
        if (session.auth.authedAtStart === undefined) sessions.markAuth(session, { authedAtStart: !auth.isLoginScreen });
        if (auth.isLoginScreen && !session.auth.loginScreenSeen)
          sessions.markAuth(session, { loginScreenSeen: true, loginScreenSeenAt: Date.now() });

        // Overlay awareness (CR4): tree overlays (LogBox/dialog/snackbar) + keyboard + foreground class.
        const overlays = detectTreeOverlays(parsed.allNodes, parsed.screen);
        // IME + foreground in parallel; when the dump's root package IS the app under test, the
        // heavy `dumpsys activity activities` is skipped (classifyForeground returns null for it).
        const rootPkg = dumpRootPackage(parsed.allNodes);
        const [imeUp, foreground] = await Promise.all([
          driver.imeShown().catch(() => false),
          session.appId && rootPkg === session.appId ? Promise.resolve(rootPkg) : driver.foregroundOwner().catch(() => 'unknown'),
        ]);
        if (imeUp) overlays.push({ type: 'keyboard', detail: 'soft keyboard shown' });
        const fgOverlay = classifyForeground(session.appId, foreground);
        if (fgOverlay) overlays.push(fgOverlay);

        const q = parsed.quality;
        const header =
          (rehydrated ? REHYDRATE_NOTE + '\n' : '') +
          `quality=${q.verdict} (${q.reasons.join('; ')})\n` +
          `screen=${parsed.screen[0]}x${parsed.screen[1]} elements=${parsed.elements.length}${f ? ` (filter "${filter}" matched ${pool.length})` : ''} totalNodes=${parsed.total}` +
          (overlays.length ? `\noverlays: ${overlays.map((o) => o.type).join(', ')} (clear with qa_clear_overlay)` : '');

        return qaOk(
          {
            quality: q.verdict,
            qualityReasons: q.reasons,
            qualitySignals: q.signals,
            screen: parsed.screen,
            elementCount: parsed.elements.length,
            ...(f ? { filter, filterMatches: pool.length } : {}),
            elementsOmitted: omitted,
            totalNodes: parsed.total,
            overlays,
            elements: shown,
            ...(diffPayload ? { diff: diffPayload } : {}),
          },
          `${header}\n\n${rendered}${diffText}`,
          { textOmit: ['elements', 'diff'] },
        );
      });
    },
  );

  server.registerTool(
    'qa_inspect',
    {
      title: 'Inspect one element',
      description:
        'Return the full attributes (class, resource-id, content-desc, text, bounds, all flags) of a single @eN ref from the most recent qa_snapshot. Use this instead of dumping the whole tree.',
      inputSchema: { sessionId: z.string(), ref: z.string().describe('e.g. "@e3"') },
    },
    async ({ sessionId, ref }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return unknownSessionError(sessionId);
      }
      const node = session.lastSnapshot?.fullByRef.get(ref);
      if (!node) {
        return qaError({
          what: `No element ${ref} in the latest snapshot`,
          changedState: false,
          retrySafe: true,
          failureCode: 'STALE_REF',
          nextSteps: ['Run qa_snapshot first; refs invalidate after navigation.'],
        });
      }
      // Sensitive-mode: a secure field's value is masked; otherwise scrub known secrets.
      const secure = isSecureNode(node);
      const redact = makeRedactor(session.secrets);
      const m = (v: string) => (secure && v ? '«secure»' : (redact(v) ?? ''));
      const maskedAttrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(node.attrs)) {
        maskedAttrs[k] = k === 'text' || k === 'content-desc' ? m(v) : v;
      }
      return qaOk(
        {
          ref,
          secure,
          class: node.cls,
          id: node.id || null,
          contentDesc: m(node.desc) || null,
          text: m(node.text) || null,
          bounds: node.bounds,
          clickable: node.clickable,
          longClickable: node.longClickable,
          scrollable: node.scrollable,
          focusable: node.focusable,
          focused: node.focused,
          enabled: node.enabled,
          attrs: maskedAttrs,
        },
        `${ref}: ${node.cls} id=${node.id || '∅'}${secure ? ' [secure]' : ''} desc=${JSON.stringify(m(node.desc))} text=${JSON.stringify(m(node.text))} bounds=${JSON.stringify(node.bounds)}`,
      );
    },
  );
}
