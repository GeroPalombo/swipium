// qa_act — the single consolidated action tool (DESIGN §3 locked schema).
// Resolves a target (ref | selector | coords), performs the action, waits for the screen
// to settle, then returns the post-action snapshot + a deterministic health check. So one
// call both acts AND observes the result.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaOk, qaError, qaStop } from '../lib/result.js';
import { parseSnapshot, signature } from '../snapshot/parse.js';
import { presentElements } from '../snapshot/present.js';
import { obstructionAt } from '../snapshot/overlays.js';
import { settle } from '../snapshot/settle.js';
import { checkHealth } from '../oracle/health.js';
import { recordHealthFindings } from '../oracle/record.js';
import { isSecureNode, makeRedactor } from '../lib/redact.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import { adbInputTextChunks, escapeAdbInputText } from '../drivers/DirectDriver.js';
import {
  GESTURE_EDGE_INSET,
  SCROLL_CONTAINER_INSET,
  largestScrollableRect,
  swipeFromPoint,
  swipeInRect,
  swipeVector,
  type SwipeVec,
} from '../lib/gestures.js';
import { center, resolveTarget, setsEqual, type Point } from '../core/target.js';
import { recordableNativeSelector, recordableTap } from '../flows/generate.js';
import { classifyFlowDriverError } from '../flows/run.js';
import { structuredSignature } from '../explore/signatures.js';
import type { RecordedAction, Session, SessionStore } from '../session/store.js';
import type { RawNode } from '../snapshot/parse.js';
import type { Driver, NativeSelectorStrategy, SnapshotElement } from '../drivers/Driver.js';
import type { FailureCode } from '../oracle/failures.js';

interface NativeSelector {
  using: NativeSelectorStrategy;
  value: string;
}

/** Drop the (already-handled) native selector before generic ref/text/id/coords resolution. */
function stripSelector<T extends { selector?: NativeSelector }>(t?: T): Omit<T, 'selector'> | undefined {
  if (!t) return undefined;
  const { selector: _selector, ...rest } = t;
  return rest;
}

/** Discriminated native-selector schema (1.5.0: replaces the free-form "strategy=value" string). */
const nativeSelectorSchema = z.object({
  using: z
    .enum(['accessibility id', 'name', 'predicate string', 'class chain'])
    .describe('"accessibility id" = accessibilityIdentifier/testID; predicate string = NSPredicate; class chain = XCUITest.'),
  value: z.string(),
});

/** SWIP-18: after the focus tap, wait for the soft keyboard instead of a fixed sleep — poll
 * imeShown() in ~100ms steps up to capMs (the old sleep), proceeding as soon as it's up.
 * The tap stays a REAL touch (RN ignores synthetic focus, so tap-then-type is required);
 * backends whose imeShown() throws get the original fixed sleep. */
async function awaitIme(d: Driver, capMs: number, floorMs = 0): Promise<void> {
  const started = Date.now();
  const deadline = started + capMs;
  try {
    while (Date.now() < deadline) {
      if (await d.imeShown()) {
        // Field hop: the IME was ALREADY up before the tap, so "shown" says nothing about the
        // new field having focus yet — give RN a floor to move focus before typing.
        const rest = floorMs - (Date.now() - started);
        if (rest > 0) await new Promise((r) => setTimeout(r, rest));
        return;
      }
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
  } catch {
    // imeShown unsupported here — preserve the original fixed-sleep behavior
    await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())));
  }
}

/** Values to scrub from driver error text: session secrets + the value just typed, in raw AND
 * adb-escaped form (escaping would otherwise defeat plain-substring redaction — H2). */
function errorSecrets(session: Session, typed?: string): string[] {
  const out = [...session.secrets];
  for (const v of [...session.secrets, ...(typed ? [typed] : [])]) {
    out.push(v);
    for (const chunk of adbInputTextChunks(v)) out.push(escapeAdbInputText(chunk));
  }
  return out;
}

/** A typed value that IS — or contains — a value already registered as a session secret (typed
 * into a secure field earlier, or provided as a secret input) must be recorded exactly like a
 * secure-field value: `secret:true`, no plaintext (→ a ${SECRET_n} variable at generate time),
 * even when the field it goes into is an ordinary text field. Containment needs >= 3 chars so a
 * 1–2 char secret can't mark every value that happens to include it. */
export function matchesSessionSecret(secrets: Iterable<string>, text: string): boolean {
  if (!text) return false;
  for (const s of secrets) {
    if (!s) continue;
    if (text === s || (s.length >= 3 && text.includes(s))) return true;
  }
  return false;
}

/** How many elements (DFS order) enter the positional change fingerprint. */
const POSITION_FINGERPRINT_ELEMENTS = 80;

/** Positional fingerprint of a screen: identity + bounds of its first N surfaced elements. The
 * presence-only signature set misses a scroll that moved content without adding/removing any
 * element (WDA keeps off-screen cells in its tree) — bounds catch it. */
export function positionalFingerprint(byRef: Map<string, RawNode> | undefined): string | undefined {
  if (!byRef?.size) return undefined;
  return [...byRef.values()]
    .slice(0, POSITION_FINGERPRINT_ELEMENTS)
    .map((n) => `${n.cls}|${n.id}|${n.desc}|${n.text}@${n.bounds.join(',')}`)
    .join('\n');
}

/** Typed failure code for a resolveTarget() error message. */
function targetErrorCode(error: string): FailureCode {
  if (/^AMBIGUOUS_SELECTOR/.test(error)) return 'AMBIGUOUS_SELECTOR';
  if (/^No target provided/.test(error)) return 'INVALID_ARGUMENT';
  if (/^No @e\d+ in the latest snapshot|no longer on screen/.test(error)) return 'STALE_REF';
  if (/^No element matched/.test(error)) return 'ELEMENT_NOT_FOUND';
  return 'UNKNOWN';
}

/** Minimum wait after a focus tap when the keyboard was already shown (field hop). */
export const IME_HOP_FLOOR_MS = 250;
/** A reported IME frame taller than this fraction of the screen is not a keyboard rect (older
 * builds size the IME window near full-screen; accessory bars/suggestion strips can inflate it)
 * — it is treated as UNKNOWN rather than as "the keyboard covers everything". */
export const IME_MAX_HEIGHT_FRACTION = 0.55;
/** Warning attached when the keyboard is up but its area could not be determined. */
export const IME_UNKNOWN_AREA_WARNING = 'keyboard is up; could not determine its area — tapped without hiding it';

/** Warning attached to a qa_act result when the WDA session had to be re-created (after an
 * invalid-session error). The recovery sends forceAppLaunch:false + shouldTerminateApp:false, but
 * WDA can still have lost the app (e.g. it crashed / WDA restarted), so this does not promise it. */
export const WDA_SESSION_RECOVERED_WARNING = 'WDA session was re-created (requested without relaunching the app) — verify the screen state';

type Rect = [number, number, number, number];

/** Keyboard state for the obstruction check: shown? and, when KNOWN, where. `rect` is absent
 * when the backend cannot report a plausible frame — callers must not guess (a bottom-40%
 * guess hid the keyboard for targets that were actually above it: accessory bars, chips). */
async function keyboardArea(d: Driver): Promise<{ shown: boolean; rect?: Rect }> {
  if (!(await d.imeShown().catch(() => false))) return { shown: false };
  const frame = d.imeFrame ? await d.imeFrame().catch(() => null) : null;
  if (!frame) return { shown: true };
  const size = await d.screenSize().catch(() => null);
  if (size && frame[3] - frame[1] > size.height * IME_MAX_HEIGHT_FRACTION) return { shown: true };
  return { shown: true, rect: frame };
}

function inRect(r: Rect | undefined, x: number, y: number): boolean {
  return !!r && x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
}

/** After the keyboard hid, the layout may shift and refs renumber: re-find the SAME node
 * (class/id/text/desc, nearest to its old position) in a fresh dump. */
async function reresolveAfterKeyboard(
  session: Session,
  d: Driver,
  t: Point,
  target: Parameters<typeof resolveTarget>[1],
): Promise<Point | { error: string }> {
  if (!t.ref || !target?.ref) return resolveTarget(session, target); // text/id re-dump + re-match
  const old = session.lastSnapshot?.fullByRef.get(t.ref);
  const parsed = parseSnapshot(await d.dumpXml());
  session.lastSnapshot = { fullByRef: parsed.fullByRef, signatures: new Set(parsed.elements.map(signature)), allNodes: parsed.allNodes };
  if (!old) return { error: `${t.ref} is no longer on screen after hiding the keyboard — re-run qa_snapshot.` };
  let best: { ref: string; node: RawNode; dist: number } | undefined;
  for (const [ref, node] of parsed.fullByRef) {
    if (node.cls !== old.cls || node.id !== old.id || node.text !== old.text || node.desc !== old.desc) continue;
    const c = center(node.bounds);
    const dist = Math.abs(c.x - t.x) + Math.abs(c.y - t.y);
    if (!best || dist < best.dist) best = { ref, node, dist };
  }
  if (!best) return { error: `${t.ref} is no longer on screen after hiding the keyboard — re-run qa_snapshot.` };
  return { ...center(best.node.bounds), via: best.ref, ref: best.ref, textLen: best.node.text.length, secure: isSecureNode(best.node) };
}

/** H5: a tap on a point under the soft keyboard lands on a KEY (typing a stray character).
 * Only when a KNOWN keyboard frame contains the target's center: hide the keyboard (never a
 * blind BACK), re-resolve the target, and proceed when it is uncovered — else
 * KEYBOARD_OBSTRUCTION. When the frame is UNKNOWN (no/implausible frame) the keyboard is NOT
 * hidden: the tap proceeds with a warning. Returns the (possibly re-resolved) point, whether the
 * IME is up at tap time, and an optional warning for the result. */
async function guardKeyboard(
  session: Session,
  d: Driver,
  t: Point,
  target: Parameters<typeof resolveTarget>[1],
): Promise<{ t: Point; imeUp: boolean; warning?: string; hidKeyboard?: boolean } | { result: CallToolResult }> {
  const kb = await keyboardArea(d);
  if (!kb.shown) return { t, imeUp: false };
  if (!kb.rect) return { t, imeUp: true, warning: IME_UNKNOWN_AREA_WARNING };
  if (!inRect(kb.rect, t.x, t.y)) return { t, imeUp: true };
  const hid = d.hideKeyboard ? await d.hideKeyboard().catch(() => false) : false;
  if (!hid) {
    return {
      result: qaError(
        {
          what: `Target at (${t.x},${t.y}) is covered by the soft keyboard and this backend could not hide it — nothing was tapped.`,
          changedState: false,
          retrySafe: true,
          failureCode: 'KEYBOARD_OBSTRUCTION',
          nextSteps: [
            'Dismiss the keyboard (qa_clear_overlay strategy:"hide_keyboard", or press enter to submit), scroll the target above it, then retry.',
          ],
        },
        { blockedByOverlay: true, obstructedBy: { type: 'keyboard', bounds: kb.rect } },
      ),
    };
  }
  await new Promise((r) => setTimeout(r, 300)); // let the layout reflow after the IME hides
  const again = await reresolveAfterKeyboard(session, d, t, target);
  if ('error' in again)
    return {
      result: qaError(
        {
          what: `The soft keyboard was hidden (it covered the target), but ${again.error} Nothing was tapped.`,
          changedState: true,
          retrySafe: true,
          failureCode: 'KEYBOARD_OBSTRUCTION',
          nextSteps: ['Run qa_snapshot to see the screen with the keyboard hidden, then retry.'],
        },
        { keyboardHidden: true },
      ),
    };
  const after = await keyboardArea(d);
  if (after.shown && after.rect && inRect(after.rect, again.x, again.y)) {
    return {
      result: qaError(
        {
          what: `The soft keyboard was hidden, but the target at (${again.x},${again.y}) is still covered by it — nothing was tapped.`,
          changedState: true,
          retrySafe: true,
          failureCode: 'KEYBOARD_OBSTRUCTION',
          nextSteps: [
            'Dismiss the keyboard (qa_clear_overlay strategy:"hide_keyboard", or press enter to submit), scroll the target above it, then retry.',
          ],
        },
        { blockedByOverlay: true, keyboardHidden: true, obstructedBy: { type: 'keyboard', bounds: after.rect } },
      ),
    };
  }
  return {
    t: again,
    imeUp: after.shown,
    hidKeyboard: true,
    ...(after.shown && !after.rect ? { warning: IME_UNKNOWN_AREA_WARNING } : {}),
  };
}

// OPP-06 (per-action schema contract) feasibility note: SDK ^1.19 registerTool DOES accept an
// arbitrary ZodType (AnySchema) as inputSchema, and validateToolInput parses unions correctly —
// but the tools/list serializer goes through normalizeObjectSchema(), which only understands
// plain object schemas / raw shapes and silently falls back to an EMPTY object schema for a
// root z.discriminatedUnion (verified empirically: the tool lists as {"type":"object",
// "properties":{}}, so the model would see NO fields at all). The strongest contract the SDK
// permits is therefore a flat ZodRawShape whose field descriptions name the action(s) they
// belong to, with the cross-field requirements enforced by this single table + validator
// (replacing the scattered per-case fail('X requires Y') calls).
const REQUIRED_BY_ACTION: Partial<Record<string, readonly ('text' | 'direction' | 'key' | 'url')[]>> = {
  type: ['text'],
  swipe: ['direction'],
  scroll: ['direction'],
  press: ['key'],
  open_url: ['url'],
};

/** OPP-06: the ONE cross-field validation layer — names both the action and the missing field. */
function missingRequiredField(action: string, args: Record<string, unknown>): CallToolResult | undefined {
  for (const field of REQUIRED_BY_ACTION[action] ?? []) {
    // `text` may legitimately be '' (typing nothing in replace mode); the other fields may not.
    if (args[field] == null || (field !== 'text' && args[field] === '')) {
      return qaError({
        what: `Action "${action}" requires \`${field}\`.`,
        changedState: false,
        retrySafe: true,
        failureCode: 'INVALID_ARGUMENT',
        nextSteps: [`Re-call qa_act with action:"${action}" and \`${field}\` set (see the ${field} parameter description).`],
      });
    }
  }
  return undefined;
}

function screenTitleFromNodes(nodes: RawNode[]): string | undefined {
  if (!nodes.length) return undefined;
  const height = nodes[0].bounds[3] || 0;
  const topBand = height ? height * 0.28 : Number.POSITIVE_INFINITY;
  const candidates = nodes
    .filter((n) => n.text && n.text.trim().length >= 2 && n.text.trim().length <= 40 && !n.clickable)
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
  const header = candidates.find((n) => n.bounds[1] <= topBand) ?? candidates[0];
  return header?.text?.trim() || undefined;
}

function recordingScreenContext(session: Session): { screen?: string; screenSig?: string } {
  const nodes = session.lastSnapshot?.allNodes;
  if (!nodes?.length) return {};
  const els = nodes.map((n) => ({ id: n.id, label: n.desc, text: n.text }) as unknown as SnapshotElement);
  return { screen: screenTitleFromNodes(nodes), screenSig: structuredSignature(els) };
}

function recordableNativeTarget(
  session: Parameters<typeof recordableNativeSelector>[0],
  native: NativeSelector,
): Omit<RecordedAction, 'at' | 'action'> {
  const selectorKind =
    native.using === 'accessibility id'
      ? 'accessibility_id'
      : native.using === 'name'
        ? 'name'
        : native.using === 'predicate string'
          ? 'predicate'
          : 'class_chain';
  return {
    selector: native.value,
    selectorKind,
    exportability: 'semantic',
    ...recordableNativeSelector(session, selectorKind, native.value),
  };
}

export function registerAct(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_act',
    {
      title: 'Act on the screen',
      description:
        'Perform one UI action, wait for the screen to settle, and observe: changed/settled, snapshot quality, a health check, and ' +
        'post-action elements per observe. action: tap, type, clear, swipe, scroll, press, open_url, wait (each param names its ' +
        'actions). Target @eN refs from qa_snapshot (invalid after navigation), text, id, a native selector (WDA iOS), or x/y. A field ' +
        'hidden under the keyboard is handled (hide + re-resolve; KEYBOARD_OBSTRUCTION if still covered). See docs/tools.md#qa_act.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['tap', 'type', 'clear', 'swipe', 'scroll', 'press', 'open_url', 'wait']),
        target: z
          .object({
            ref: z.string().optional(),
            text: z.string().optional(),
            id: z.string().optional(),
            selector: nativeSelectorSchema.optional(),
            index: z.number().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
          })
          .optional()
          .describe('tap/type/clear (required); swipe: optional start point.'),
        text: z.string().optional().describe('type (required)'),
        mode: z.enum(['replace', 'append']).optional().describe('type: replace (default) clears first.'),
        submit: z.boolean().optional().describe('type: press enter after.'),
        direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('swipe/scroll (required)'),
        untilVisible: z
          .object({ text: z.string().optional(), id: z.string().optional() })
          .optional()
          .describe('scroll: stop once visible (checked before the first swipe).'),
        maxScrolls: z.number().optional().describe('scroll: max swipes (default 8).'),
        key: z.enum(['back', 'home', 'enter']).optional().describe('press (required)'),
        url: z.string().optional().describe('open_url (required)'),
        durationMs: z.number().optional().describe('tap: press duration (coordinate taps default ~100ms).'),
        ignoreOverlay: z.boolean().optional().describe('tap: tap even if an overlay/keyboard covers the target.'),
        for: z
          .object({
            settled: z.boolean().optional(),
            ref: z.string().optional(),
            text: z.string().optional(),
            id: z.string().optional(),
            selector: nativeSelectorSchema.optional(),
          })
          .optional()
          .describe('wait: {settled:true} (default) or an element.'),
        timeoutMs: z.number().optional().describe('wait: max ms (default 8000); others: settle-wait cap.'),
        observe: z
          .enum(['diff', 'full', 'none'])
          .optional()
          .describe('diff (default after a snapshot): elements added/removed; full: capped list; none: verdicts only.'),
      },
    },
    async (args) => {
      const { sessionId, action } = args;
      // Single validation layer for the per-action field contract (see REQUIRED_BY_ACTION).
      const invalid = missingRequiredField(action, args);
      if (invalid) return invalid;
      const session = sessions.get(sessionId);
      const { driver: d, blocked } = session ? await getDriver(session) : { driver: undefined, blocked: undefined };
      if (!session || !d) {
        // H6: a device is online but refused (physical) or not ready (still booting).
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: session ? 'No device attached to this session' : `Unknown session ${sessionId}`,
            changedState: false,
            retrySafe: true,
            failureCode: session ? 'NO_DEVICE' : 'INVALID_ARGUMENT',
            nextSteps: [session ? 'Call qa_prepare_target first.' : 'Call qa_start_session and use the returned sessionId.'],
          })
        );
      }
      if (d.kind === 'simulator') {
        return qaError({
          what: 'Structured interaction (tap/type/swipe) is not available on the iOS simulator backend',
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: [
            'Attach WebDriverAgent with qa_wda for structured tap/type/snapshot. Without WDA, locate targets with qa_visual (mode:"find_text" OCR or mode:"find_image" return tappable device coordinates; tap:true taps via idb when installed), navigate via qa_ios deep links, and verify with qa_visual mode:"assert" or mode:"diff".',
          ],
        });
      }
      // Budget gate (review §4.1 / Rec 4): refuse new work once the session budget is spent.
      // `wait` is exempt from the action/screenshot caps (it's synchronization, not an
      // action), but it is NOT exempt from the TIME budget — otherwise repeated waits could
      // burn the clock indefinitely.
      const stopReason = sessions.budgetStop(session);
      if (stopReason && (action !== 'wait' || /time budget/.test(stopReason))) {
        return qaStop(stopReason, { counters: session.counters, mode: session.mode });
      }
      const fail = (what: string, changedState: boolean) =>
        qaError({
          what,
          changedState,
          retrySafe: true,
          failureCode: targetErrorCode(what),
          nextSteps: ['Run qa_snapshot to see the current screen, then retry.'],
        });

      // ---- wait is its own path (no settle/health afterward) ----
      if (action === 'wait') {
        const timeoutMs = args.timeoutMs ?? 8000;
        if (args.for?.settled || !args.for) {
          const s = await settle(d, { timeoutMs });
          const post = parseSnapshot(s.xml);
          session.lastSnapshot = { fullByRef: post.fullByRef, signatures: new Set(post.elements.map(signature)), allNodes: post.allNodes };
          const { elements: shown, rendered, omitted } = presentElements(post.elements, makeRedactor(session.secrets));
          return qaOk(
            { action, settled: s.settled, quality: post.quality.verdict, elementsOmitted: omitted, elements: shown },
            `wait(settled)=${s.settled}\n\n${rendered}`,
          );
        }
        const deadline = Date.now() + timeoutMs;
        const want = args.for;
        const native: NativeSelector | null = want?.selector ?? null;
        if (native) {
          if (!d.existsBySelector)
            return qaError({
              what: `${native.using} waits require backend-native selector support`,
              changedState: false,
              retrySafe: false,
              failureCode: 'BACKEND_UNSUPPORTED',
              nextSteps: ['Use a WDA-backed iOS session, or wait by text/id/ref on this backend.'],
            });
          while (Date.now() < deadline) {
            if (await d.existsBySelector(native.using, native.value)) {
              return qaOk(
                { action, found: true, selector: want?.selector, via: 'native-selector' },
                `wait: found ${native.using}=${native.value}`,
              );
            }
            await new Promise((r) => setTimeout(r, 400));
          }
          return qaError({
            what: `wait timed out (${timeoutMs}ms) for ${JSON.stringify(want)}`,
            changedState: false,
            retrySafe: true,
            failureCode: 'ELEMENT_NOT_FOUND',
            nextSteps: ['Re-check the native selector value, or run qa_snapshot to inspect the current screen.'],
          });
        }
        while (Date.now() < deadline) {
          const parsed = parseSnapshot(await d.dumpXml());
          session.lastSnapshot = {
            fullByRef: parsed.fullByRef,
            signatures: new Set(parsed.elements.map(signature)),
            allNodes: parsed.allNodes,
          };
          const hit = parsed.elements.find(
            (e) =>
              (want.ref && e.ref === want.ref) ||
              (want.id && e.id === want.id) ||
              (want.text &&
                (e.text?.toLowerCase().includes(want.text.toLowerCase()) || e.label?.toLowerCase().includes(want.text.toLowerCase()))),
          );
          if (hit) return qaOk({ action, found: true, ref: hit.ref }, `wait: found ${hit.ref}`);
          await new Promise((r) => setTimeout(r, 400));
        }
        return qaError({
          what: `wait timed out (${timeoutMs}ms) for ${JSON.stringify(want)}`,
          changedState: false,
          retrySafe: true,
          failureCode: 'ELEMENT_NOT_FOUND',
          nextSteps: ['Re-snapshot; the element may use different text/id.'],
        });
      }

      // Phase timing (P1.6): mark the first real action so the report can split setup vs active.
      sessions.milestone(session, 'first_action');

      const preSigs = session.lastSnapshot?.signatures ?? new Set<string>();
      // F: positions too — a scroll/swipe can move content without adding/removing elements.
      const prePositions = positionalFingerprint(session.lastSnapshot?.fullByRef);
      // I: set when the soft keyboard was hidden because it covered the target.
      let keyboardHidden = false;
      // OPP-07: observation mode is fixed at action start — diff needs a pre-action baseline.
      const observe: 'diff' | 'full' | 'none' = args.observe ?? (session.lastSnapshot ? 'diff' : 'full');
      let meta: Record<string, unknown> = {};
      // remembered so a no-change tap can be retried as a longer press (RN tap quirk)
      // imeUp: the soft keyboard was shown at tap time — a re-press could hit a key (H5).
      let tapRetry: { x: number; y: number; instant: boolean; imeUp: boolean } | undefined;
      // action-IR step to record once the action succeeds (built here while lastSnapshot is
      // still the PRE-navigation screen, so a tapped @ref still resolves to its label).
      let toRecord: Omit<RecordedAction, 'at'> | undefined;
      // Non-fatal caveats for the result (unknown keyboard area, recovered WDA session, …).
      const warnings: string[] = [];

      try {
        switch (action) {
          case 'tap': {
            const native: NativeSelector | null = args.target?.selector ?? null;
            if (native) {
              if (!d.tapBySelector)
                return qaError({
                  what: `${native.using} selectors require backend-native selector support`,
                  changedState: false,
                  retrySafe: false,
                  failureCode: 'BACKEND_UNSUPPORTED',
                  nextSteps: ['Use a WDA-backed iOS session, or target by ref/text/id/coordinates on this backend.'],
                });
              await d.tapBySelector(native.using, native.value);
              meta = { selector: args.target?.selector, via: 'native-selector' };
              toRecord = { action: 'tap', ...recordableNativeTarget(session, native) };
              break;
            }
            const resolved = await resolveTarget(session, stripSelector(args.target));
            if ('error' in resolved) return fail(resolved.error, false);
            let t = resolved;
            // H5: keyboard obstruction (the IME window is not in the app's UI dump, so the
            // overlay check below can't see it). Coordinate taps are taken as deliberate.
            let imeUp = false;
            if (!args.ignoreOverlay && t.via !== 'coords') {
              const g = await guardKeyboard(session, d, t, stripSelector(args.target));
              if ('result' in g) return g.result;
              t = g.t;
              imeUp = g.imeUp;
              if (g.warning) warnings.push(g.warning);
              if (g.hidKeyboard) keyboardHidden = true;
            } else {
              imeUp = await d.imeShown().catch(() => false);
            }
            // Overlay obstruction check (CR4): if another element is drawn over the target
            // point, return a structured blockedByOverlay instead of tapping blindly.
            if (!args.ignoreOverlay && t.via !== 'coords' && session.lastSnapshot?.allNodes) {
              // works for ref AND selector taps — t.ref is the resolved @eN in either case
              const node = t.ref ? session.lastSnapshot.fullByRef.get(t.ref) : undefined;
              const obs = obstructionAt(session.lastSnapshot.allNodes, node, t.x, t.y);
              if (obs.obstructed) {
                return qaError(
                  {
                    what: `Target at (${t.x},${t.y}) is obstructed by ${obs.by?.cls?.split('.').pop()}${obs.by?.text ? ` "${obs.by.text}"` : ''}`,
                    changedState: false,
                    retrySafe: true,
                    failureCode: 'OVERLAY_OBSTRUCTION',
                    nextSteps: [
                      'Call qa_clear_overlay (auto, or hide_keyboard/minimize_logbox), then retry — or pass ignoreOverlay:true to tap anyway.',
                    ],
                  },
                  { blockedByOverlay: true, obstructedBy: obs.by },
                );
              }
            }
            // Coordinate taps default to a short press (RN often ignores instant taps);
            // ref/selector taps stay instant unless durationMs is given.
            const isCoord = t.via === 'coords';
            const durationMs = args.durationMs ?? (isCoord ? 100 : undefined);
            if (durationMs) await d.pressXY(t.x, t.y, durationMs);
            else await d.tapXY(t.x, t.y);
            tapRetry = { x: t.x, y: t.y, instant: !durationMs, imeUp };
            meta = { tappedAt: [t.x, t.y], via: t.via, ...(durationMs ? { durationMs } : {}) };
            toRecord = { action: 'tap', ...recordableTap(session, stripSelector(args.target), t) };
            break;
          }
          case 'type': {
            const text = args.text!; // presence enforced by missingRequiredField (OPP-06)
            // D: validate deliverability BEFORE any focus tap / clear — a refused value must
            // leave the field (and the device) exactly as it was.
            const deliverable = d.canDeliverText?.(text);
            if (deliverable && !deliverable.ok) {
              return qaError({
                what: `${deliverable.reason} Nothing was tapped or cleared.`,
                changedState: false,
                retrySafe: false,
                failureCode: 'TEXT_INPUT_UNSUPPORTED',
                nextSteps: ['Use ASCII-safe text on this backend (adb `input text`), or type it on a Unicode-safe backend.'],
              });
            }
            // A: a value that is/contains a registered secret is recorded as secret even when the
            // target field is not a secure one (checked before this call can register it).
            const knownSecret = matchesSessionSecret(session.secrets, text);
            const native: NativeSelector | null = args.target?.selector ?? null;
            if (native) {
              if (!d.typeBySelector)
                return qaError({
                  what: `${native.using} selectors require backend-native selector support`,
                  changedState: false,
                  retrySafe: false,
                  failureCode: 'BACKEND_UNSUPPORTED',
                  nextSteps: ['Use a WDA-backed iOS session, or target by ref/text/id/coordinates on this backend.'],
                });
              const replace = (args.mode ?? 'replace') === 'replace';
              if (replace && !d.clearBySelector)
                return qaError({
                  what: `replace-mode typing by ${native.using} requires backend-native clear support`,
                  changedState: false,
                  retrySafe: false,
                  failureCode: 'BACKEND_UNSUPPORTED',
                  nextSteps: ['Use append mode, or attach a WDA backend that supports element clear.'],
                });
              // SWIP-03: this path must capture secrets exactly like the generic path below, or a
              // password typed by native selector is recorded VERBATIM into generated flows.
              // Heuristic first (selector value looks secret — same SECRET_RE the generic
              // resolver applies to ids), then the real signal: probe the resolved element's
              // type (XCUIElementTypeSecureTextField). A failing probe keeps the heuristic verdict.
              let secure = isSecureNode({ id: native.value, desc: '', attrs: {} });
              if (!secure && d.isSecureBySelector) {
                try {
                  secure = await d.isSecureBySelector(native.using, native.value);
                } catch {
                  // probe unavailable (older WDA / element churn) — heuristic alone decides
                }
              }
              if (secure) {
                session.secrets.add(text);
                sessions.markAuth(session, { loginPerformed: true, loginPerformedAt: Date.now() });
                sessions.milestone(session, 'login_performed');
              }
              if (replace) await d.clearBySelector!(native.using, native.value);
              await d.typeBySelector(native.using, native.value, text);
              const recordSecret = secure || knownSecret;
              meta = {
                typedChars: text.length,
                redacted: true, // the response never echoes the value…
                ...(recordSecret ? { secret: true } : {}), // …and a secure value is registered for scrubbing
                mode: args.mode ?? 'replace',
                via: 'native-selector',
                selector: args.target?.selector,
                submit: !!args.submit,
              };
              // Never store a secret's value in the IR — secrets become a ${VAR} at generate time.
              {
                const nativeTarget = recordableNativeTarget(session, native);
                toRecord = {
                  action: 'type',
                  ...nativeTarget,
                  secret: recordSecret,
                  text: recordSecret ? undefined : text,
                  exportability: recordSecret ? 'needs-human-data' : nativeTarget.exportability,
                };
              }
              if (args.submit) await d.pressKey('enter');
              break;
            }
            const resolved = await resolveTarget(session, stripSelector(args.target));
            if ('error' in resolved) return fail(resolved.error, false);
            let t = resolved;
            // H5: focusing a field hidden under the keyboard would type a stray key character.
            const g = await guardKeyboard(session, d, t, stripSelector(args.target));
            if ('result' in g) return g.result;
            t = g.t;
            if (g.warning) warnings.push(g.warning);
            if (g.hidKeyboard) keyboardHidden = true;
            // Typing into a secure field → remember the value so it's scrubbed everywhere, and
            // record that a login was performed (auth-state reporting, P1.5).
            if (t.secure) {
              session.secrets.add(text);
              sessions.markAuth(session, { loginPerformed: true, loginPerformedAt: Date.now() });
              sessions.milestone(session, 'login_performed');
            }
            await d.tapXY(t.x, t.y); // focus + raise IME (real touch)
            await awaitIme(d, 700, g.imeUp ? IME_HOP_FLOOR_MS : 0);
            if ((args.mode ?? 'replace') === 'replace') await d.clearFocusedText(t.textLen);
            await d.inputText(text);
            if (args.submit) await d.pressKey('enter');
            // Never echo the typed value — it may be a password/OTP/email/token and would
            // leak into the agent transcript + artifacts (DESIGN §9.7 sensitive-mode).
            const recordSecret = !!t.secure || knownSecret;
            meta = {
              typedChars: text.length,
              redacted: true,
              ...(recordSecret ? { secret: true } : {}),
              mode: args.mode ?? 'replace',
              via: t.via,
              submit: !!args.submit,
            };
            // Never store a secret's value in the IR — secrets become a ${VAR} at generate time.
            {
              const targetRecord = recordableTap(session, stripSelector(args.target), t);
              toRecord = {
                action: 'type',
                selector: targetRecord.selector,
                selectorKind: targetRecord.selectorKind,
                secret: recordSecret,
                text: recordSecret ? undefined : text,
                exportability: recordSecret ? 'needs-human-data' : targetRecord.exportability,
                provenance: targetRecord.provenance,
              };
            }
            break;
          }
          case 'clear': {
            const native: NativeSelector | null = args.target?.selector ?? null;
            if (native) {
              if (!d.clearBySelector)
                return qaError({
                  what: `${native.using} selectors require backend-native clear support`,
                  changedState: false,
                  retrySafe: false,
                  failureCode: 'BACKEND_UNSUPPORTED',
                  nextSteps: ['Use a WDA-backed iOS session, or target by ref/text/id/coordinates on this backend.'],
                });
              await d.clearBySelector(native.using, native.value);
              meta = { cleared: true, via: 'native-selector', selector: args.target?.selector };
              toRecord = { action: 'clear', ...recordableNativeTarget(session, native) };
              break;
            }
            const resolved = await resolveTarget(session, stripSelector(args.target));
            if ('error' in resolved) return fail(resolved.error, false);
            const g = await guardKeyboard(session, d, resolved, stripSelector(args.target));
            if ('result' in g) return g.result;
            const t = g.t;
            if (g.warning) warnings.push(g.warning);
            if (g.hidKeyboard) keyboardHidden = true;
            await d.tapXY(t.x, t.y); // focus + raise IME (real touch)
            await awaitIme(d, 400, g.imeUp ? IME_HOP_FLOOR_MS : 0);
            await d.clearFocusedText(t.textLen);
            meta = { cleared: true, via: t.via };
            toRecord = { action: 'clear', ...recordableTap(session, stripSelector(args.target), t) };
            break;
          }
          case 'swipe': {
            const direction = args.direction!; // presence enforced by missingRequiredField (OPP-06)
            // SWIP-02: derive the gesture from the real screen size — WDA swipes are in POINTS
            // (≤~440pt wide), so the old fixed 540/1200 constants were off-screen on iOS; the
            // legacy constants survive only inside the shared fallback for screenSize()===null.
            // SWIP-08: a supplied target that fails to resolve is a structured error (not a
            // silent default swipe), and a resolved point is used verbatim — 0 is a legitimate
            // coordinate. Endpoints keep an ~8% inset clear of iOS system-gesture zones.
            const size = await d.screenSize().catch(() => null);
            let vec: SwipeVec;
            if (args.target) {
              const start = await resolveTarget(session, stripSelector(args.target));
              if ('error' in start) return fail(start.error, false);
              vec = swipeFromPoint(size, { x: start.x, y: start.y }, direction, 0.5, GESTURE_EDGE_INSET);
            } else {
              vec = swipeVector(size, direction, 'center', 0.5, GESTURE_EDGE_INSET);
            }
            await d.swipe(vec[0], vec[1], vec[2], vec[3], 300);
            meta = { direction };
            toRecord = { action: 'swipe', direction, exportability: 'coordinate' };
            break;
          }
          case 'scroll': {
            const max = args.maxScrolls ?? 8;
            // scroll down = FINGER swipes up (same for the other directions where finger ==
            // content axis). SWIP-02: screen-relative + clamped vector, size fetched once.
            const finger = { down: 'up', up: 'down', left: 'left', right: 'right' } as const;
            const size = await d.screenSize().catch(() => null);
            const dir = args.direction!; // presence enforced by missingRequiredField (OPP-06)
            const u = args.untilVisible;
            const probe = async () => {
              const parsed = parseSnapshot(await d.dumpXml());
              const hit = parsed.elements.some(
                (e) =>
                  (u?.id && e.id === u.id) ||
                  (u?.text &&
                    (e.text?.toLowerCase().includes(u.text.toLowerCase()) || e.label?.toLowerCase().includes(u.text.toLowerCase()))),
              );
              // Positions are part of the signature: a list that moved but still shows the same
              // labels is not at its end (the label-only signature reported endOfList mid-list).
              const sig = parsed.elements
                .map((e) => `${signature(e)}@${e.bounds.join(',')}`)
                .sort()
                .join('\n');
              return { hit, sig, nodes: parsed.allNodes };
            };
            // B: anchor the swipe INSIDE the largest scrollable container (a swipe that starts on
            // a sticky app bar moves nothing); screen center only when no container is known.
            let anchorNodes: RawNode[] | undefined = session.lastSnapshot?.allNodes;
            if (!anchorNodes && !u)
              anchorNodes = await d.dumpXml().then(
                (x) => parseSnapshot(x).allNodes,
                () => undefined,
              );
            let anchoredIn: 'scrollable' | 'screen' = 'screen';
            const nextVec = (): SwipeVec => {
              const rect = largestScrollableRect(anchorNodes, size);
              anchoredIn = rect ? 'scrollable' : 'screen';
              return rect
                ? swipeInRect(rect, finger[dir], size, 0.6, SCROLL_CONTAINER_INSET, GESTURE_EDGE_INSET)
                : swipeVector(size, finger[dir], 'center', 0.6, GESTURE_EDGE_INSET);
            };
            let found = false;
            let endOfList = false;
            let swipes = 0;
            let prevSig: string | undefined;
            // Already visible? Then don't swipe at all (it could scroll the target away).
            if (u) {
              const first = await probe();
              found = first.hit;
              prevSig = first.sig;
              anchorNodes = first.nodes;
            }
            // C: a plain scroll is exactly ONE swipe; only untilVisible loops (up to maxScrolls).
            const limit = u ? max : 1;
            for (let i = 0; i < limit && !found; i++) {
              const vec = nextVec();
              await d.swipe(vec[0], vec[1], vec[2], vec[3], 300);
              swipes++;
              if (u) {
                await new Promise((r) => setTimeout(r, 400));
                const now = await probe();
                anchorNodes = now.nodes;
                found = now.hit;
                if (found) break;
                // Screen identical after a swipe → end of the list; more swipes can't help.
                if (now.sig === prevSig) {
                  endOfList = true;
                  break;
                }
                prevSig = now.sig;
              }
            }
            meta = {
              direction: dir,
              swipes,
              ...(swipes ? { anchoredIn } : {}),
              untilVisibleFound: u ? found : undefined,
              ...(endOfList ? { endOfList: true } : {}),
            };
            toRecord = {
              action: 'scroll',
              direction: dir,
              selector: args.untilVisible?.text,
              exportability: args.untilVisible?.text ? 'semantic' : 'coordinate',
            };
            break;
          }
          case 'press': {
            const key = args.key!; // presence enforced by missingRequiredField (OPP-06)
            await d.pressKey(key);
            meta = { key };
            // iOS has no back key: WdaDriver taps the nav-bar back button or edge-swipes — say which.
            if (key === 'back' && d.kind === 'wda') {
              const via = (d as { lastBackVia?: string }).lastBackVia;
              if (via) meta.backVia = via;
            }
            toRecord = { action: 'press', key, exportability: 'semantic' };
            break;
          }
          case 'open_url': {
            const url = args.url!; // presence enforced by missingRequiredField (OPP-06)
            await d.openUrl(url);
            meta = { url };
            toRecord = { action: 'open_url', url, exportability: 'semantic' };
            break;
          }
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const failureCode: FailureCode = /BACKEND_UNSUPPORTED|not supported by the WDA backend/.test(msg)
          ? 'BACKEND_UNSUPPORTED'
          : classifyFlowDriverError(e);
        // H2: driver errors can echo argv/stderr — scrub known secrets AND the value just typed.
        const redactErr = makeRedactor(errorSecrets(session, action === 'type' ? args.text : undefined));
        return qaError({
          what: `Action "${action}" failed: ${redactErr(String(e)) ?? ''}`,
          changedState: true,
          retrySafe: !['WDA_SESSION_FAILED', 'UNKNOWN'].includes(failureCode),
          failureCode,
          nextSteps:
            failureCode === 'UNKNOWN'
              ? ['Confirm the device is online and re-snapshot.']
              : ['Use the failureCode to choose recovery, then re-snapshot before retrying.'],
        });
      }

      // count this as an action (wait already returned earlier)
      sessions.bump(session, 'actions');
      // Record the action into the IR for qa_generate target:"flow" (the action definitely happened here;
      // recorded now so a later post-snapshot failure doesn't lose the step).
      if (toRecord) {
        const sc = recordingScreenContext(session);
        sessions.addRecordedAction(session, { at: Date.now(), ...sc, ...toRecord });
      }

      // Post-action observation is wrapped so a settle/dump/parse failure (e.g. the
      // looping-animation case) returns a Swipium-shaped result, never a raw MCP error.
      try {
        // settle → observe → health
        let s = await settle(d, { timeoutMs: args.timeoutMs ?? 8000 });
        let post = parseSnapshot(s.xml);
        let postSigs = new Set(post.elements.map(signature));
        // F: for gestures that move content, a bounds shift counts as a change too.
        const positional = action === 'scroll' || action === 'swipe';
        const movedContent = () => positional && prePositions !== undefined && prePositions !== positionalFingerprint(post.fullByRef);
        let changed = !setsEqual(preSigs, postSigs) || movedContent();

        // No-change retry (review §4.5/§4.7): an instant tap that did nothing is often the RN
        // tap quirk — retry ONCE as a longer press before believing it's blocked.
        let retriedAsPress = false;
        // Never when the keyboard was up at tap time: the retry would re-press a point the IME
        // may own and type a second stray character (H5).
        if (!changed && action === 'tap' && tapRetry?.instant && !tapRetry.imeUp) {
          await d.pressXY(tapRetry.x, tapRetry.y, 120);
          retriedAsPress = true;
          s = await settle(d, { timeoutMs: args.timeoutMs ?? 8000 });
          post = parseSnapshot(s.xml);
          postSigs = new Set(post.elements.map(signature));
          changed = !setsEqual(preSigs, postSigs) || movedContent();
        }

        session.lastSnapshot = { fullByRef: post.fullByRef, signatures: postSigs, allNodes: post.allNodes };
        const health = await checkHealth(d, session.appId, s.xml);

        // Track no-change actions for the budget / no-op-loop detector.
        if (!changed && (action === 'tap' || action === 'swipe' || action === 'scroll' || action === 'press')) {
          sessions.bump(session, 'noChangeActions');
        }
        const budgetReached = sessions.budgetStop(session);

        // Sensitive-mode present: mask secure fields + scrub known secrets AND the just-typed
        // value (covers non-secure fields like email for this immediate response).
        const redact = makeRedactor([...session.secrets, ...(action === 'type' && args.text ? [args.text] : [])]);

        // Record non-info findings for qa_report (deterministic bug trail) + app-error screenshot.
        await recordHealthFindings(sessions, session, health.findings, d, health.foreground);

        const banner =
          `${action} ${JSON.stringify(meta)} → changed=${changed}${retriedAsPress ? ' (retried as press)' : ''} ` +
          `settled=${s.settled} quality=${post.quality.verdict} native=${health.nativeHealthy ? 'ok' : health.nativeStatus} app=${health.appStatus}` +
          (budgetReached ? `\n⏹ budget reached: ${budgetReached} — call qa_report.` : '') +
          (!changed && retriedAsPress
            ? `\nNo change even after a press retry — likely wrong coords / disabled element / overlay / auth wall.`
            : '');
        const findings = health.findings.length
          ? '\n' +
            health.findings
              .map((f) => `[${f.severity}] ${f.layer ?? '?'}/${f.kind}: ${f.detail}${f.evidence ? ` — "${f.evidence}"` : ''}`)
              .join('\n')
          : '';

        // OPP-07: `observe` changes ONLY the element presentation below — everything above
        // (lastSnapshot bookkeeping, press retry, health recording, counters, budget lines)
        // is identical in all modes.
        let elementPayload: Record<string, unknown> = {};
        let elementsText = '';
        if (observe === 'diff') {
          const added = post.elements.filter((e) => !preSigs.has(signature(e)));
          const removed = [...preSigs].filter((sig) => !postSigs.has(sig)).map((sig) => redact(sig) ?? sig);
          const { elements: addedShown, rendered: renderedAdded, omitted } = presentElements(added, redact);
          const unchangedElements = post.elements.length - added.length;
          const hint = `${unchangedElements} unchanged element(s) not shown — pass observe:"full" to see the whole screen.`;
          elementPayload = { elementsOmitted: omitted, elements: addedShown, removed, unchangedElements, hint };
          elementsText =
            `\n\nDIFF vs pre-action: +${added.length} / -${removed.length}` +
            (added.length ? `\n${renderedAdded}` : '') +
            (removed.length ? `\nremoved: ${removed.join(' | ')}` : '') +
            `\n${hint}`;
        } else if (observe === 'full') {
          const { elements: outElements, rendered, omitted } = presentElements(post.elements, redact);
          elementPayload = { elementsOmitted: omitted, elements: outElements };
          elementsText = `\n\n${rendered}`;
        } else {
          const hint = `${post.elements.length} element(s) not shown (observe:"none") — pass observe:"full" or run qa_snapshot to see the screen.`;
          elementPayload = { hint };
          elementsText = `\n\n${hint}`;
        }

        // The WDA driver transparently re-creates a reaped session (without relaunching the app);
        // the agent must know the screen may not be where it left it.
        if (d.consumeSessionRecovered?.()) warnings.push(WDA_SESSION_RECOVERED_WARNING);

        return qaOk(
          {
            action,
            ...meta,
            ...(keyboardHidden ? { keyboardHidden: true } : {}),
            changed,
            retriedAsPress,
            settled: s.settled,
            quality: post.quality.verdict,
            health,
            counters: session.counters,
            ...(budgetReached ? { budgetReached } : {}),
            observe,
            ...elementPayload,
            ...(warnings.length ? { warnings } : {}),
          },
          `${banner}${keyboardHidden ? '\nNote: the soft keyboard covered the target and was hidden first (keyboardHidden:true).' : ''}` +
            `${findings}${warnings.map((w) => `\n⚠ ${w}`).join('')}${elementsText}`,
        );
      } catch (e) {
        // The action ran; observing the result failed (often a UI that never reaches idle).
        const idle = /idle|dump|hierarchy/i.test(String(e));
        if (idle) sessions.setMode(session, 'visual-fallback');
        const redactErr = makeRedactor(errorSecrets(session, action === 'type' ? args.text : undefined));
        return qaError({
          what: `Action "${action}" ran, but observing the result failed: ${redactErr(String(e)) ?? ''}`,
          changedState: true,
          retrySafe: false,
          failureCode: classifyFlowDriverError(e, 'SNAPSHOT_FAILED'),
          nextSteps: idle
            ? ['Switched to visual-fallback. Use qa_screenshot; qa_check_health still works.']
            : ['Re-check the device is online, then qa_screenshot / qa_check_health.'],
        });
      }
    },
  );
}
