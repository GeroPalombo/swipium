// qa_clear_overlay — clear common overlays so a covered CTA becomes tappable (Phase 2 CR5).
// Strategies: auto | hide_keyboard | press_back | tap_outside | minimize_logbox |
// dismiss_logbox | allow_permission | deny_permission | dismiss_toast_if_possible.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { getDriver } from '../session/attach.js';
import { parseSnapshot, boundsContain, type RawNode } from '../snapshot/parse.js';
import { detectTreeOverlays, classifyForeground, obstructionAt } from '../snapshot/overlays.js';
import type { Driver } from '../drivers/Driver.js';
import type { SessionStore } from '../session/store.js';

const STRATEGIES = ['auto', 'hide_keyboard', 'press_back', 'tap_outside', 'minimize_logbox', 'dismiss_logbox', 'allow_permission', 'deny_permission', 'dismiss_toast_if_possible'] as const;

const center = (b: [number, number, number, number]) => ({ x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) });

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function tapByText(d: Driver, nodes: RawNode[], re: RegExp): Promise<boolean> {
  const n = nodes.find((x) => re.test(x.text) || re.test(x.desc));
  if (!n) return false;
  const c = center(n.bounds);
  await d.pressXY(c.x, c.y, 100);
  return true;
}

async function handleNativeAlert(d: Driver, action: 'accept' | 'dismiss'): Promise<boolean> {
  const fn = action === 'accept' ? d.acceptAlert : d.dismissAlert;
  if (!fn) return false;
  try {
    await fn.call(d);
    return true;
  } catch {
    return false;
  }
}

export function registerClearOverlay(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_clear_overlay',
    {
      title: 'Clear an overlay',
      description:
        'Clear common overlays blocking the screen: auto (detect + clear the topmost), hide_keyboard, press_back, tap_outside, minimize_logbox / dismiss_logbox (RN), allow_permission / deny_permission, dismiss_toast_if_possible. Optional targetRef: reports whether that element was obstructed before/after. Returns what was cleared and what remains.',
      inputSchema: {
        sessionId: z.string(),
        strategy: z.enum(STRATEGIES).optional().describe('default "auto"'),
        targetRef: z.string().optional().describe('@eN to check obstruction before/after'),
      },
    },
    async ({ sessionId, strategy = 'auto', targetRef }) => {
      const session = sessions.get(sessionId);
      const { driver: d } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !d) {
        return qaError({ what: 'No device attached', changedState: false, retrySafe: true, nextSteps: ['Call qa_prepare_target first.'] });
      }

      const obstructionFor = async (): Promise<{ obstructed: boolean; node?: RawNode }> => {
        if (!targetRef) return { obstructed: false };
        let xml = '';
        try {
          xml = await d.dumpXml();
        } catch {
          return { obstructed: false };
        }
        const parsed = parseSnapshot(xml);
        const node = session.lastSnapshot?.fullByRef.get(targetRef);
        if (!node) return { obstructed: false };
        const c = center(node.bounds);
        // re-resolve the target in the FRESH tree by matching bounds/id
        const fresh = parsed.allNodes.find((x) => x.id && node.id && x.id === node.id) ?? parsed.allNodes.find((x) => boundsContain(x.bounds, c.x, c.y));
        return { obstructed: obstructionAt(parsed.allNodes, fresh, c.x, c.y).obstructed, node: fresh };
      };

      const before = (await obstructionFor()).obstructed;
      const cleared: Array<{ type: string; action: string }> = [];

      // gather context
      const ime = await safe(() => d.imeShown(), false);
      const fg = await safe(() => d.foregroundOwner(), 'unknown');
      const xml = await safe(() => d.dumpXml(), '');
      const parsedBefore = xml ? parseSnapshot(xml) : undefined;
      const nodes = parsedBefore?.allNodes ?? [];
      const treeOverlays = detectTreeOverlays(nodes, parsedBefore?.screen);
      const overlaysBefore = treeOverlays.map((o) => o.type);
      const fgOverlay = classifyForeground(session.appId, fg);

      const doHideKeyboard = async () => {
        if (await safe(() => d.imeShown(), false)) {
          await d.pressKey('back');
          cleared.push({ type: 'keyboard', action: 'hidden' });
        } else {
          cleared.push({ type: 'keyboard', action: 'not_visible_or_unsupported' });
        }
      };
      const doTapOutside = async () => { const sz = await safe(() => d.screenSize(), null); const x = Math.round((sz?.width ?? 1080) * 0.5); const y = Math.round((sz?.height ?? 2000) * 0.08); await d.pressXY(x, y, 80); cleared.push({ type: 'unknown', action: 'tap_outside' }); };
      const doMinimizeLogbox = async () => { const ok = await tapByText(d, nodes, /minimize/i); cleared.push({ type: 'rn_logbox', action: ok ? 'minimized' : 'minimize_not_found' }); };
      const doDismissLogbox = async () => { const ok = await tapByText(d, nodes, /dismiss/i); cleared.push({ type: 'rn_logbox', action: ok ? 'dismissed' : 'dismiss_not_found' }); };
      const doAllowPermission = async () => {
        if (await handleNativeAlert(d, 'accept')) {
          cleared.push({ type: 'permission_dialog', action: 'allowed_native_alert' });
          return;
        }
        const ok = await tapByText(d, nodes, /allow|while using/i);
        cleared.push({ type: 'permission_dialog', action: ok ? 'allowed' : 'allow_not_found' });
      };
      const doDenyPermission = async () => {
        if (await handleNativeAlert(d, 'dismiss')) {
          cleared.push({ type: 'permission_dialog', action: 'denied_native_alert' });
          return;
        }
        const ok = await tapByText(d, nodes, /deny|don.?t allow/i);
        cleared.push({ type: 'permission_dialog', action: ok ? 'denied' : 'deny_not_found' });
      };

      try {
        switch (strategy) {
          case 'hide_keyboard': await doHideKeyboard(); break;
          case 'press_back': await d.pressKey('back'); cleared.push({ type: 'unknown', action: 'press_back' }); break;
          case 'tap_outside': await doTapOutside(); break;
          case 'minimize_logbox': await doMinimizeLogbox(); break;
          case 'dismiss_logbox': await doDismissLogbox(); break;
          case 'allow_permission': await doAllowPermission(); break;
          case 'deny_permission': await doDenyPermission(); break;
          case 'dismiss_toast_if_possible': cleared.push({ type: 'toast', action: 'cannot_target (toasts are separate windows; wait it out)' }); break;
          case 'auto':
          default:
            if (ime) await doHideKeyboard();
            else if (treeOverlays.some((o) => o.type === 'rn_logbox' || o.type === 'rn_redbox')) await doMinimizeLogbox();
            else if (fgOverlay?.type === 'permission_dialog') cleared.push({ type: 'permission_dialog', action: 'present — call allow_permission/deny_permission deliberately' });
            else if (treeOverlays.some((o) => o.type === 'native_dialog')) cleared.push({ type: 'native_dialog', action: 'present — handle via qa_act (e.g. tap a dialog button)' });
            else await doTapOutside();
            break;
        }
      } catch (e) {
        return qaError({ what: `clear_overlay "${strategy}" failed: ${String(e)}`, changedState: true, retrySafe: true, nextSteps: ['Re-snapshot and inspect the overlay.'] });
      }

      await new Promise((r) => setTimeout(r, 500));
      const after = (await obstructionFor()).obstructed;
      let parsedAfter: ReturnType<typeof parseSnapshot> | undefined;
      try {
        const afterXml = await safe(() => d.dumpXml(), '');
        if (afterXml) parsedAfter = parseSnapshot(afterXml);
      } catch { /* keep undefined */ }
      const afterOverlays = parsedAfter ? detectTreeOverlays(parsedAfter.allNodes, parsedAfter.screen) : [];
      const remaining = afterOverlays.map((o) => o.type);

      // Outcome (Phase 2.2): distinguish cleared / reappeared (persistent) / not_dismissible /
      // still_obstructing_target so the agent (and report) know whether the overlay is real noise.
      const attemptedTypes = new Set(cleared.map((c) => c.type));
      const sameTypeRemains = remaining.some((t) => attemptedTypes.has(t) || overlaysBefore.includes(t));
      const triedDismiss = cleared.some((c) => /minimized|dismissed|hidden|allowed|denied|tap_outside|press_back/.test(c.action));
      let outcome: 'cleared' | 'reappeared' | 'not_dismissible' | 'still_obstructing_target' | 'nothing_to_clear';
      if (targetRef && after) outcome = 'still_obstructing_target';
      else if (!cleared.length) outcome = 'nothing_to_clear';
      else if (sameTypeRemains && triedDismiss) outcome = overlaysBefore.length && remaining.length >= overlaysBefore.length ? 'reappeared' : 'not_dismissible';
      else outcome = 'cleared';

      return qaOk(
        { strategy, outcome, cleared, overlaysBefore, remaining, ...(targetRef ? { targetObstructedBefore: before, targetObstructedAfter: after } : {}) },
        `outcome: ${outcome}\ncleared: ${cleared.map((c) => `${c.type}:${c.action}`).join(', ') || '(none)'}${targetRef ? `\ntarget ${targetRef} obstructed: ${before} → ${after}` : ''}${remaining.length ? `\nremaining overlays: ${remaining.join(', ')}` : ''}`,
      );
    },
  );
}
