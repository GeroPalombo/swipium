// qa_clear_overlay: clear common overlays so a covered CTA becomes tappable (Phase 2 CR5).
// Strategies: auto | hide_keyboard | press_back | tap_outside | minimize_logbox |
// dismiss_logbox | allow_permission | deny_permission | dismiss_toast_if_possible.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { blockedDeviceResult, getDriver, prepareFirstStep } from '../session/attach.js';
import { parseSnapshot, boundsContain, type RawNode } from '../snapshot/parse.js';
import { detectTreeOverlays, classifyForeground, obstructionAt, type Overlay } from '../snapshot/overlays.js';
import type { Driver } from '../drivers/Driver.js';
import { classifyFlowDriverError } from '../flows/run.js';
import type { SessionStore } from '../session/store.js';
import { noteScreenMutation } from '../snapshot/fresh.js';

const STRATEGIES = [
  'auto',
  'hide_keyboard',
  'press_back',
  'tap_outside',
  'minimize_logbox',
  'dismiss_logbox',
  'allow_permission',
  'deny_permission',
  'dismiss_toast_if_possible',
] as const;

const center = (b: [number, number, number, number]) => ({ x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) });

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Tap the best node matching `re`: a node whose whole text/desc matches `exact` (or whose id
 *  matches `idRe`) first, clickable before static text (AND-13: "allow" picked the dialog's
 *  message "Allow Contacts to send you notifications?" over the Allow button). */
async function tapByText(d: Driver, nodes: RawNode[], re: RegExp, exact?: RegExp, idRe?: RegExp): Promise<boolean> {
  const matches = nodes.filter((x) => re.test(x.text) || re.test(x.desc) || (!!idRe && idRe.test(x.id)));
  const rank = (x: RawNode) =>
    (idRe?.test(x.id) ? 4 : 0) +
    (exact && (exact.test(x.text.trim()) || exact.test(x.desc.trim())) ? 2 : 0) +
    (x.clickable || x.longClickable ? 1 : 0);
  const n = matches.reduce<RawNode | undefined>((best, x) => (!best || rank(x) > rank(best) ? x : best), undefined);
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

/** Overlay types on screen: tree overlays, the keyboard, a classified foreground surface (deduped). */
function overlayTypes(tree: Overlay[], ime: boolean, fg: Overlay | null): string[] {
  const out = tree.map((o) => o.type as string);
  if (ime) out.push('keyboard');
  // An iOS system alert makes SpringBoard the foreground; the tree already reports the dialog.
  if (fg && !(fg.type === 'foreign_app' && out.includes('permission_dialog'))) out.push(fg.type);
  return [...new Set(out)];
}

export function registerClearOverlay(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_clear_overlay',
    {
      title: 'Clear an overlay',
      description:
        'Clear what blocks the screen (keyboard, LogBox, permission dialog, toast); strategy "auto" handles the topmost. ' +
        'targetRef checks whether that element is still obstructed. Returns what was cleared and what remains.',
      inputSchema: {
        sessionId: z.string(),
        strategy: z.enum(STRATEGIES).optional().describe('default "auto"'),
        targetRef: z.string().optional().describe('@eN to check obstruction before/after'),
      },
    },
    async ({ sessionId, strategy = 'auto', targetRef }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver: d, blocked } = await getDriver(session);
      if (!session || !d) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE',
            nextSteps: [prepareFirstStep(session)],
          })
        );
      }

      // IOS-15: the visual-only iOS simulator backend can't press, tap or read the tree. Same
      // contract as qa_snapshot / qa_act: BACKEND_UNSUPPORTED, nothing changed.
      if (d.kind === 'simulator') {
        return qaError({
          what: 'Clearing overlays is not available on the visual-only iOS simulator backend; nothing was changed.',
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: [
            'Attach WebDriverAgent with qa_wda for structured interaction, or dismiss the overlay with qa_visual (mode:"find_text", tap:true).',
          ],
        });
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
        // re-resolve the target in the FRESH tree by id, structural key or exact bounds. The first
        // node containing the center is usually the window, an ancestor of everything, which
        // would never count as obstructed and disagree with qa_act (IOS R3 NEW-8).
        const sameBounds = (x: RawNode) => x.bounds.every((v, i) => v === node.bounds[i]);
        const fresh =
          parsed.allNodes.find((x) => x.id && node.id && x.id === node.id) ??
          parsed.allNodes.find((x) => x.key && x.key === node.key) ??
          [...parsed.allNodes].reverse().find(sameBounds) ??
          parsed.allNodes.find((x) => boundsContain(x.bounds, c.x, c.y));
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
      const fgOverlay = classifyForeground(session.appId, fg);
      // What blocks the screen before acting: tree overlays plus the keyboard and a system surface in
      // front (AND-13/AND-18: a permission dialog / keyboard the strategy then acted on was missing).
      const overlaysBefore = overlayTypes(treeOverlays, ime, fgOverlay);

      // Set when the keyboard is up and could not be dismissed: typed KEYBOARD_NOT_DISMISSIBLE.
      let keyboardStuck: string | undefined;
      const doHideKeyboard = async () => {
        if (await safe(() => d.imeShown(), false)) {
          // Backend-native hide first (WDA /wda/keyboard/dismiss; adb BACK-if-shown). A BACK
          // fallback only where BACK is a real key (Android). On iOS it is not a keyboard dismiss.
          let hid: boolean;
          let why = '';
          try {
            hid = d.hideKeyboard ? await d.hideKeyboard() : (await d.pressKey('back'), true);
          } catch (e) {
            hid = false;
            why = String((e as Error)?.message ?? e);
          }
          if (hid) cleared.push({ type: 'keyboard', action: 'hidden' });
          else keyboardStuck = why || 'the backend has no generic way to dismiss this keyboard';
        } else {
          cleared.push({ type: 'keyboard', action: 'not_visible_or_unsupported' });
        }
      };
      const doTapOutside = async () => {
        const sz = await safe(() => d.screenSize(), null);
        const x = Math.round((sz?.width ?? 1080) * 0.5);
        const y = Math.round((sz?.height ?? 2000) * 0.08);
        await d.pressXY(x, y, 80);
        cleared.push({ type: 'unknown', action: 'tap_outside' });
      };
      const doMinimizeLogbox = async () => {
        const ok = await tapByText(d, nodes, /minimize/i);
        cleared.push({ type: 'rn_logbox', action: ok ? 'minimized' : 'minimize_not_found' });
      };
      const doDismissLogbox = async () => {
        const ok = await tapByText(d, nodes, /dismiss/i);
        cleared.push({ type: 'rn_logbox', action: ok ? 'dismissed' : 'dismiss_not_found' });
      };
      const doAllowPermission = async () => {
        if (await handleNativeAlert(d, 'accept')) {
          cleared.push({ type: 'permission_dialog', action: 'allowed_native_alert' });
          return;
        }
        const ok = await tapByText(
          d,
          nodes,
          /allow|while using/i,
          /^(allow|allow (once|all|all the time)|(allow )?(only )?while using( the)? app)$/i,
          /permission_allow(_foreground_only|_one_time)?_button$/,
        );
        cleared.push({ type: 'permission_dialog', action: ok ? 'allowed' : 'allow_not_found' });
      };
      const doDenyPermission = async () => {
        if (await handleNativeAlert(d, 'dismiss')) {
          cleared.push({ type: 'permission_dialog', action: 'denied_native_alert' });
          return;
        }
        const ok = await tapByText(
          d,
          nodes,
          /deny|don.?t allow/i,
          /^(deny|don.?t allow|deny (&|and) don.?t ask again)$/i,
          /permission_deny(_and_dont_ask_again)?_button$/,
        );
        cleared.push({ type: 'permission_dialog', action: ok ? 'denied' : 'deny_not_found' });
      };

      try {
        switch (strategy) {
          case 'hide_keyboard':
            await doHideKeyboard();
            break;
          case 'press_back':
            await d.pressKey('back');
            cleared.push({ type: 'unknown', action: 'press_back' });
            break;
          case 'tap_outside':
            await doTapOutside();
            break;
          case 'minimize_logbox':
            await doMinimizeLogbox();
            break;
          case 'dismiss_logbox':
            await doDismissLogbox();
            break;
          case 'allow_permission':
            await doAllowPermission();
            break;
          case 'deny_permission':
            await doDenyPermission();
            break;
          case 'dismiss_toast_if_possible':
            cleared.push({ type: 'toast', action: 'cannot_target (toasts are separate windows; wait it out)' });
            break;
          case 'auto':
          default:
            if (ime) await doHideKeyboard();
            else if (treeOverlays.some((o) => o.type === 'rn_logbox' || o.type === 'rn_redbox')) await doMinimizeLogbox();
            else if (fgOverlay?.type === 'permission_dialog' || treeOverlays.some((o) => o.type === 'permission_dialog'))
              cleared.push({ type: 'permission_dialog', action: 'present; call allow_permission/deny_permission deliberately' });
            else if (treeOverlays.some((o) => o.type === 'native_dialog'))
              cleared.push({ type: 'native_dialog', action: 'present; handle via qa_act (e.g. tap a dialog button)' });
            // Tap outside only when something blocks (an unclassified overlay, or the target is
            // obstructed): with nothing there a blind tap lands on the app and changes its state.
            else if (overlaysBefore.length || before) await doTapOutside();
            break;
        }
      } catch (e) {
        noteScreenMutation(session); // the strategy may have partly run (changedState:true)
        const msg = String((e as Error)?.message ?? e);
        return qaError({
          what: `clear_overlay "${strategy}" failed: ${msg}`,
          changedState: true,
          retrySafe: true,
          failureCode: /BACKEND_UNSUPPORTED|not supported by the WDA backend/.test(msg)
            ? 'BACKEND_UNSUPPORTED'
            : classifyFlowDriverError(e),
          nextSteps: ['Re-snapshot and inspect the overlay.'],
        });
      }

      if (keyboardStuck) {
        return qaError(
          {
            what: `The soft keyboard is up and could not be dismissed (${keyboardStuck.slice(0, 240)}). Nothing was changed.`,
            changedState: false,
            retrySafe: false,
            failureCode: 'KEYBOARD_NOT_DISMISSIBLE',
            nextSteps: [
              'Submit the field with qa_act action:"press" key:"enter", or tap the app\'s own Done/Return button.',
              'Or tap a non-input area (qa_clear_overlay strategy:"tap_outside"), then re-snapshot.',
            ],
          },
          { strategy, cleared },
        );
      }

      if (cleared.length) noteScreenMutation(session); // a < 2 s snapshot no longer describes the screen
      await new Promise((r) => setTimeout(r, 500));
      const after = (await obstructionFor()).obstructed;
      let parsedAfter: ReturnType<typeof parseSnapshot> | undefined;
      try {
        const afterXml = await safe(() => d.dumpXml(), '');
        if (afterXml) parsedAfter = parseSnapshot(afterXml);
      } catch {
        /* keep undefined */
      }
      const afterOverlays = parsedAfter ? detectTreeOverlays(parsedAfter.allNodes, parsedAfter.screen) : [];
      // Verify, don't assume (AND-13): the keyboard / a foreground permission dialog count when still there.
      const [imeAfter, fgAfter] = await Promise.all([safe(() => d.imeShown(), false), safe(() => d.foregroundOwner(), 'unknown')]);
      const remaining = overlayTypes(afterOverlays, imeAfter, classifyForeground(session.appId, fgAfter));

      // Outcome (Phase 2.2): distinguish cleared / reappeared (persistent) / not_dismissible /
      // still_obstructing_target so the agent (and report) know whether the overlay is real noise.
      // Only the overlay types this call acted on decide it: an unrelated banner that was there
      // before and stays (IOS-4) does not make a dismissed alert "reappeared".
      const attemptedTypes = new Set(cleared.map((c) => c.type));
      const sameTypeRemains = remaining.some((t) => attemptedTypes.has(t));
      const triedDismiss = cleared.some((c) => /minimized|dismissed|hidden|allowed|denied|tap_outside|press_back/.test(c.action));
      let outcome: 'cleared' | 'reappeared' | 'not_dismissible' | 'still_obstructing_target' | 'nothing_to_clear' | 'needs_decision';
      if (targetRef && after) outcome = 'still_obstructing_target';
      // auto only reported a dialog it leaves for the caller to answer (allow vs deny): nothing was cleared.
      else if (cleared.length && cleared.every((c) => c.action.startsWith('present;'))) outcome = 'needs_decision';
      // A hide_keyboard with no keyboard up acted on nothing (AND-18).
      else if (!cleared.some((c) => c.action !== 'not_visible_or_unsupported')) outcome = 'nothing_to_clear';
      else if (sameTypeRemains && triedDismiss)
        outcome = overlaysBefore.length && remaining.length >= overlaysBefore.length ? 'reappeared' : 'not_dismissible';
      else outcome = 'cleared';

      return qaOk(
        {
          strategy,
          outcome,
          cleared,
          overlaysBefore,
          remaining,
          ...(targetRef ? { targetObstructedBefore: before, targetObstructedAfter: after } : {}),
        },
        `outcome: ${outcome}\ncleared: ${cleared.map((c) => `${c.type}:${c.action}`).join(', ') || '(none)'}${targetRef ? `\ntarget ${targetRef} obstructed: ${before} > ${after}` : ''}${remaining.length ? `\nremaining overlays: ${remaining.join(', ')}` : ''}`,
      );
    },
  );
}
