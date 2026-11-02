// qa_act: the single consolidated action tool (locked schema).
// Resolves a target (ref | selector | coords), performs the action, waits for the screen
// to settle, then returns the post-action snapshot + a deterministic health check. So one
// call both acts AND observes the result.

import { z } from 'zod';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { qaOk, qaError, qaStop, qaAnnotate, unknownSessionError, cancelledResult } from '../lib/result.js';
import {
  boundsContain,
  isTextFieldClass,
  parseSnapshot,
  signature,
  subtreeLabel,
  toElement,
  weakTreeHint,
  type ParsedSnapshot,
} from '../snapshot/parse.js';
import { adoptSnapshot, noteScreenMutation, preActionFingerprint, snapshotNow } from '../snapshot/fresh.js';
import { awaitIme, IME_HOP_FLOOR_MS } from '../core/ime.js';
import { imageDiff } from '../lib/image.js';
import { presentElements } from '../snapshot/present.js';
import { obstructionAt } from '../snapshot/overlays.js';
import { settle } from '../snapshot/settle.js';
import { checkHealth } from '../oracle/health.js';
import { recordHealthFindings } from '../oracle/record.js';
import { isSecureNode, makeRedactor } from '../lib/redact.js';
import { blockedDeviceResult, getDriver, lostWdaResult, prepareFirstStep } from '../session/attach.js';
import { adbInputTextChunks, adbTextPieces, escapeAdbInputText } from '../drivers/DirectDriver.js';
import { composeLabelOf, fieldReadBack, typedReadBack } from '../core/readBack.js';
import {
  GESTURE_EDGE_INSET,
  SCROLL_CONTAINER_INSET,
  largestScrollableRect,
  swipeFromPoint,
  swipeInRect,
  swipeVector,
  type SwipeVec,
} from '../lib/gestures.js';
import { center, foldText, reresolveRef, resolveTarget, sameIdentity, setsEqual, type Point, type ResolveError } from '../core/target.js';
import { recordableNativeSelector, recordableTap } from '../flows/generate.js';
import { classifyFlowDriverError } from '../flows/run.js';
import { deviceGoneNextSteps, isDeviceGoneError } from '../lib/deviceGone.js';
import { diagnoseIosOutage } from '../lib/iosOutage.js';
import { structuredSignature } from '../explore/signatures.js';
import type { RecordedAction, Session, SessionStore } from '../session/store.js';
import type { RawNode } from '../snapshot/parse.js';
import type { Driver, NativeSelectorStrategy, SnapshotElement } from '../drivers/Driver.js';
import type { FailureCode } from '../oracle/failures.js';
import { isAbortError, runWithSignal, sleepOrCancel, throwIfCancelled } from '../lib/abortScope.js';
import { SECRET_VAR_NAME } from '../flows/schema.js';
import { withWdaCall } from '../lib/wda.js';
import { captureFailedStepEvidence, currentScreenTitle, screenTitleFromNodes } from '../lib/steps.js';
import { isForegroundOf } from '../lib/launchWait.js';

/** The iOS home screen's bundle id, as WDA's active app info reports it. */
const IOS_SPRINGBOARD = 'com.apple.springboard';

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

/** PURE: moved to core/readBack.ts (shared with the flow runner); re-exported here. */
export { typedReadBack } from '../core/readBack.js';

/** Values to scrub from driver error text: session secrets + the value just typed, in raw AND
 * adb-escaped form (escaping would otherwise defeat plain-substring redaction, H2). */
function errorSecrets(session: Session, typed?: string): string[] {
  const out = [...session.secrets];
  for (const v of [...session.secrets, ...(typed ? [typed] : [])]) {
    out.push(v);
    for (const chunk of [...adbInputTextChunks(v), ...adbTextPieces(v)]) out.push(escapeAdbInputText(chunk));
  }
  return out;
}

/** A typed value that IS (or contains) a value already registered as a session secret (typed
 * into a secure field earlier, or provided as a secret input) must be recorded exactly like a
 * secure-field value: `secret:true`, no plaintext (> a ${SECRET_n} variable at generate time),
 * even when the field it goes into is an ordinary text field. Containment needs >= 3 chars so a
 * 1-2 char secret can't mark every value that happens to include it. */
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
 * element (WDA keeps off-screen cells in its tree). Bounds catch it. */
export function positionalFingerprint(byRef: Map<string, RawNode> | undefined): string | undefined {
  if (!byRef?.size) return undefined;
  return [...byRef.values()]
    .slice(0, POSITION_FINGERPRINT_ELEMENTS)
    .map((n) => `${n.cls}|${n.id}|${n.desc}|${n.text}@${n.bounds.join(',')}`)
    .join('\n');
}

/** Per-node toggle/selection state (Android checked/selected, a `value` attr where a backend
 * exposes one), keyed by identity (class|id|desc|text, with a #n suffix for repeats). */
export function stateByIdentity(byRef: Map<string, RawNode> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!byRef) return out;
  const seen = new Map<string, number>();
  for (const n of byRef.values()) {
    const base = `${n.cls}|${n.id}|${n.desc}|${n.text}`;
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    out.set(k > 1 ? `${base}#${k}` : base, `${n.attrs.checked ?? ''}/${n.attrs.selected ?? ''}/${n.attrs.value ?? ''}`);
  }
  return out;
}

/** Refs (in `post`) whose checked/selected/value state differs from `pre` for the SAME identity:
 * a Switch/Checkbox toggle, a tab selection. The presence-only signature misses these, so a real
 * toggle looked like "no change" and the press retry toggled it straight back. */
export function stateChangedRefs(pre: Map<string, string>, postByRef: Map<string, RawNode>): string[] {
  if (!pre.size) return [];
  const post = stateByIdentity(postByRef);
  const keys = [...post.keys()];
  const refs = [...postByRef.keys()];
  const out: string[] = [];
  keys.forEach((k, i) => {
    const before = pre.get(k);
    if (before !== undefined && before !== post.get(k)) out.push(refs[i]);
  });
  return out;
}

/** Human form of a node's toggle state for the diff line. */
function stateLabel(n: RawNode): string {
  const parts: string[] = [];
  if (n.attrs.checkable === 'true' || n.attrs.checked === 'true') parts.push(`checked=${n.attrs.checked === 'true'}`);
  if (n.attrs.selected === 'true' || !parts.length) parts.push(`selected=${n.attrs.selected === 'true'}`);
  if (n.attrs.value) parts.push(`value=${JSON.stringify(n.attrs.value)}`);
  return parts.join(' ');
}

/** Share of post-action elements that are new before observe:"diff" falls back to the full list
 * (after a navigation "diff" = every new element + every old one listed as removed, larger
 * than "full"). */
export const DIFF_FULL_FALLBACK_RATIO = 0.5;

/** qa_act timeoutMs ceiling (wait / settle cap); larger values are clamped with a note. */
export const ACT_TIMEOUT_MAX_MS = 50_000;

/** Only `${SWIPIUM_*}` placeholders are expanded in typed text (anything else stays literal). */
const INPUT_PLACEHOLDER_RE = /\$\{(SWIPIUM_[A-Z0-9_]+)\}/g;
/** Env-sourced placeholder values whose NAME looks secret join the redaction set. Uses the shared
 *  SECRET_VAR_NAME (flows/schema.ts), so `code` (SWIPIUM_VERIFICATION_CODE) counts here too. */
const SECRET_VAR_NAME_RE = SECRET_VAR_NAME;

/** Expand `${SWIPIUM_*}` placeholders from session inputs (qa_continue_from_blocker values), else the server
 * env. Returns the expanded text, the variable names used, which of them are secret, and any
 * that could not be resolved. PURE apart from reading `env`. */
export function expandInputPlaceholders(
  text: string,
  inputs: { values: Map<string, string>; secretVars: Set<string> },
  env: NodeJS.ProcessEnv = process.env,
): { text: string; vars: string[]; secretValues: string[]; missing: string[] } {
  const vars: string[] = [];
  const missing: string[] = [];
  const secretValues: string[] = [];
  const out = text.replace(INPUT_PLACEHOLDER_RE, (whole, name: string) => {
    const fromSession = inputs.values.get(name);
    const value = fromSession ?? env[name];
    if (value === undefined) {
      missing.push(name);
      return whole;
    }
    if (!vars.includes(name)) vars.push(name);
    if (fromSession !== undefined ? inputs.secretVars.has(name) : SECRET_VAR_NAME_RE.test(name)) secretValues.push(value);
    return value;
  });
  return { text: out, vars, secretValues, missing };
}

/** What to RECORD for a typed value: the placeholder template when the agent typed one, else
 * `${VAR}` when the value equals a stored session input (email/username included), else the
 * literal. Keeps provided test data out of generated flows as literals. */
export function recordableTypedText(template: string, typed: string, vars: string[], inputs: Map<string, string>): string {
  if (vars.length) return template;
  if (typed) for (const [name, value] of inputs) if (value && value === typed) return `\${${name}}`;
  return typed;
}

/** Typed failure code for a resolveTarget() error message. */
function targetErrorCode(error: string): FailureCode {
  if (/^AMBIGUOUS_SELECTOR/.test(error)) return 'AMBIGUOUS_SELECTOR';
  if (/^No target provided/.test(error)) return 'INVALID_ARGUMENT';
  if (/^No @e\d+ in the latest snapshot|no longer on screen/.test(error)) return 'STALE_REF';
  if (/^No element matched/.test(error)) return 'ELEMENT_NOT_FOUND';
  return 'UNKNOWN';
}

/** A reported IME frame taller than this fraction of the screen is not a keyboard rect (older
 * builds size the IME window near full-screen; accessory bars/suggestion strips can inflate it),
 * so it is treated as UNKNOWN rather than as "the keyboard covers everything". */
export const IME_MAX_HEIGHT_FRACTION = 0.55;
/** Warning attached when the keyboard is up but its area could not be determined. */
export const IME_UNKNOWN_AREA_WARNING = 'keyboard is up; could not determine its area; tapped without hiding it';

/** Warning attached to a qa_act result when the WDA session had to be re-created (after an
 * invalid-session error). The recovery sends forceAppLaunch:false + shouldTerminateApp:false, but
 * WDA can still have lost the app (e.g. it crashed / WDA restarted), so this does not promise it. */
export const WDA_SESSION_RECOVERED_WARNING = 'WDA session was re-created (requested without relaunching the app); verify the screen state';

type Rect = [number, number, number, number];

/** Keyboard state for the obstruction check: shown? and, when KNOWN, where. `rect` is absent
 * when the backend cannot report a plausible frame. Callers must not guess (a bottom-40%
 * guess hid the keyboard for targets that were actually above it: accessory bars, chips). */
async function keyboardArea(d: Driver): Promise<{ shown: boolean; rect?: Rect }> {
  let frame: Rect | null;
  if (d.imeState) {
    // One round trip for shown + frame (Android: one adb shell; WDA: one keyboard lookup).
    const st = await d.imeState().catch(() => ({ shown: false, frame: null }));
    if (!st.shown) return { shown: false };
    frame = st.frame;
  } else {
    if (!(await d.imeShown().catch(() => false))) return { shown: false };
    frame = d.imeFrame ? await d.imeFrame().catch(() => null) : null;
  }
  if (!frame) return { shown: true };
  const size = await d.screenSize().catch(() => null);
  if (size && frame[3] - frame[1] > size.height * IME_MAX_HEIGHT_FRACTION) return { shown: true };
  return { shown: true, rect: frame };
}

/** Classes whose content the UI tree does not describe (web, canvas, game / Flutter surfaces). */
const OPAQUE_CLASS_RE = /WebView|SurfaceView|TextureView|GLSurfaceView|Canvas|Flutter/i;
/** X5: pixel share above which pre/post screenshots count as "changed". */
export const PIXEL_CHANGE_RATIO = 0.005;

/** X5: would the hierarchy alone miss this tap's effect? Visual session, a target without
 * text/desc/id on it or inside it, or a point inside a WebView/canvas-like node. */
export function needsPixelCheck(session: Session, t: Point): boolean {
  if (session.mode === 'visual-fallback') return true;
  const snap = session.lastSnapshot;
  if (!snap) return true;
  const under = snap.allNodes.filter((n) => n.bounds[0] <= t.x && t.x <= n.bounds[2] && n.bounds[1] <= t.y && t.y <= n.bounds[3]);
  if (under.some((n) => OPAQUE_CLASS_RE.test(n.cls))) return true;
  const node = t.ref ? snap.fullByRef.get(t.ref) : under[under.length - 1];
  return !node || !subtreeLabel(node, snap.allNodes); // a row labeled by a child TextView counts as labeled
}

/** X5: do two screenshots differ by more than PIXEL_CHANGE_RATIO? Not comparable / undecodable = no. */
export function pixelsDiffer(a: Buffer, b: Buffer): boolean {
  try {
    const r = imageDiff(a, b);
    return r.comparable && r.ratio > PIXEL_CHANGE_RATIO;
  } catch {
    return false;
  }
}

function inRect(r: Rect | undefined, x: number, y: number): boolean {
  return !!r && x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
}

/** After the keyboard hid, the layout may shift: re-find the SAME node (class/id/text/desc,
 * nearest to its old position) in a fresh dump (core/target.ts reresolveRef). */
async function reresolveAfterKeyboard(
  session: Session,
  t: Point,
  target: Parameters<typeof resolveTarget>[1],
): Promise<Point | ResolveError> {
  noteScreenMutation(session); // the keyboard hid: the stored snapshot is stale
  if (!t.ref || !target?.ref) return resolveTarget(session, target); // text/id re-dump + re-match
  const old = session.lastSnapshot?.fullByRef.get(t.ref);
  if (!old) {
    await snapshotNow(session, session.driver!);
    return { error: `${t.ref} is no longer on screen after hiding the keyboard; re-run qa_snapshot.` };
  }
  return reresolveRef(session, t.ref, old, { context: ' after hiding the keyboard' });
}

/** Is the resolved target a key of the on-screen keyboard (WDA: an XCUIElementTypeKey, or any
 *  node inside the XCUIElementTypeKeyboard)? Such a tap is deliberate typing, not an obstruction. */
export function isKeyboardKey(session: Session, t: Point): boolean {
  const snap = session.lastSnapshot;
  const node = t.ref ? snap?.fullByRef.get(t.ref) : undefined;
  if (!snap || !node) return false;
  if (/^XCUIElementType(?:Key|Keyboard)$/.test(node.cls)) return true;
  return snap.allNodes.some((m) => m.cls === 'XCUIElementTypeKeyboard' && m.dfs < node.dfs && m.subtreeEnd >= node.dfs);
}

/** H5: a tap on a point under the soft keyboard lands on a KEY (typing a stray character).
 * Only when a KNOWN keyboard frame contains the target's center: hide the keyboard (never a
 * blind BACK), re-resolve the target, and proceed when it is uncovered, else
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
          what: `Target at (${t.x},${t.y}) is covered by the soft keyboard and this backend could not hide it. Nothing was tapped.`,
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
  const again = await reresolveAfterKeyboard(session, t, target);
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
          what: `The soft keyboard was hidden, but the target at (${again.x},${again.y}) is still covered by it. Nothing was tapped.`,
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

// Per-action schema contract feasibility note: SDK ^1.19 registerTool DOES accept an
// arbitrary ZodType (AnySchema) as inputSchema, and validateToolInput parses unions correctly,
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

/** The ONE cross-field validation layer. Names both the action and the missing field. */
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

/** What qa_act learned along the way that its timeline step needs (filled as the call runs). */
interface ActStepCtx {
  target?: string;
  driver?: Driver;
  /** The latest tree / raw XML qa_act holds (post-action settle, scroll probe, wait dump). */
  nodes?: RawNode[];
  xml?: string;
}

type ActStepArgs = {
  sessionId: string;
  action: string;
  target?: { ref?: string; text?: string; id?: string; selector?: { using: string; value: string }; x?: number; y?: number };
  direction?: string;
  untilVisible?: { text?: string; id?: string };
  key?: string;
  url?: string;
  for?: { settled?: boolean; ref?: string; text?: string; id?: string; selector?: { using: string; value: string }; gone?: boolean };
};

/** A short label for an element target. Never the value of a text field (it may be what was typed). */
function actTargetLabel(session: Session, t: ActStepArgs['target'] | ActStepArgs['for']): string | undefined {
  if (!t) return undefined;
  if (t.ref) {
    const n = session.lastSnapshot?.fullByRef.get(t.ref);
    if (!n) return t.ref;
    const id = n.id ? n.id.slice(n.id.lastIndexOf('/') + 1) : '';
    const field = isTextFieldClass(n.cls) || isSecureNode(n);
    return (field ? n.desc || n.attrs?.hint || id : n.text || n.desc || id) || t.ref;
  }
  if (t.text) return t.text;
  if (t.id) return t.id;
  if (t.selector) return t.selector.value;
  if ('x' in t && t.x != null && t.y != null) return `(${t.x},${t.y})`;
  return undefined;
}

/** Step target: tap "Sign in", type into "Email" (never the typed text), scroll down, ... */
export function actStepTarget(session: Session, args: ActStepArgs): string {
  const q = (v?: string) => (v ? ` "${v}"` : '');
  switch (args.action) {
    case 'tap':
      return `tap${q(actTargetLabel(session, args.target))}`;
    case 'type':
      return `type into${q(actTargetLabel(session, args.target)) || ' focused field'}`;
    case 'clear':
      return `clear${q(actTargetLabel(session, args.target))}`;
    case 'swipe':
      return `swipe ${args.direction ?? ''}`.trim();
    case 'scroll': {
      const until = args.untilVisible?.text ?? args.untilVisible?.id;
      return `scroll ${args.direction ?? ''}${until ? ` until "${until}"` : ''}`;
    }
    case 'press':
      return `press ${args.key ?? ''}`.trim();
    case 'open_url': {
      // Query strings and fragments can carry tokens: keep scheme, host and path only.
      const url = args.url ?? '';
      return `open_url ${url.split(/[?#]/)[0]}`;
    }
    case 'wait': {
      const label = actTargetLabel(session, args.for);
      if (!label) return 'wait settled';
      return args.for?.gone ? `wait until "${label}" is gone` : `wait for "${label}"`;
    }
    default:
      return args.action;
  }
}

/** Write qa_act's one timeline step for this call (and failure evidence). Never throws. */
async function recordActStep(
  sessions: SessionStore,
  args: ActStepArgs,
  res: CallToolResult | undefined,
  started: number,
  ctx: ActStepCtx,
): Promise<void> {
  try {
    const session = sessions.get(args.sessionId);
    if (!session) return;
    const sc = (res?.structuredContent ?? {}) as Record<string, unknown>;
    const failed = !res || res.isError === true || sc.ok === false;
    const failureCode = failed ? (typeof sc.failureCode === 'string' ? sc.failureCode : 'UNKNOWN') : undefined;
    // A satisfied untilVisible is a success even when nothing moved.
    const result = failed ? 'failed' : sc.changed === false && sc.untilVisibleFound !== true ? 'no_change' : 'ok';
    const step = sessions.addStep(session, {
      source: 'act',
      action: args.action,
      target: ctx.target ?? actStepTarget(session, args),
      result,
      ...(failureCode ? { failureCode } : {}),
      durationMs: Date.now() - started,
      screen: screenTitleFromNodes(ctx.nodes) ?? currentScreenTitle(session),
    });
    // No result means the handler threw: record the step but touch no device, so the error
    // propagates at once instead of after a screenshot timeout.
    if (failed && res)
      await captureFailedStepEvidence(sessions, session, ctx.driver, step.i, {
        failureCode,
        nodes: ctx.nodes,
        xml: ctx.xml,
        label: `qa_act failed: ${step.target ?? args.action}`,
      });
  } catch {
    /* the timeline never breaks the action */
  }
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
        'Tap, type, clear, swipe, scroll, press a key, open a URL or wait: one UI step, then it waits for the screen to settle and ' +
        'reports changed/settled, snapshot quality, health, new elements. Target: an @eN ref from qa_snapshot, text, id, a native ' +
        'selector (WDA iOS), or x/y. For 3+ known steps, batch them in one qa_flow_run {flowYaml}. Details: docs/tools.md#qa_act.',
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
            gone: z.boolean().optional(),
          })
          .optional()
          .describe(
            'wait: {settled:true} (default), or until an element (ref/text/id/selector) is visible; gone:true waits until it is not.',
          ),
        timeoutMs: z
          .number()
          .min(0)
          .optional()
          .describe('wait: max ms (default 8000, max 50000; larger values are clamped); others: settle-wait cap.'),
        observe: z
          .enum(['diff', 'full', 'none'])
          .optional()
          .describe('diff (default after a snapshot): elements added/removed; full: capped list; none: verdicts only.'),
      },
    },
    // Cancellation (MCP notifications/cancelled): the call's signal is scoped to THIS call
    // (abortScope): an in-flight adb child / WDA request is aborted without touching a
    // concurrently running job's own cancellation.
    async (rawArgs, ctx) => {
      // timeoutMs is clamped (not rejected) like qa_job_status waitMs, with a note on the result.
      const clampedFrom = rawArgs.timeoutMs != null && rawArgs.timeoutMs > ACT_TIMEOUT_MAX_MS ? rawArgs.timeoutMs : undefined;
      const args = clampedFrom != null ? { ...rawArgs, timeoutMs: ACT_TIMEOUT_MAX_MS } : rawArgs;
      // One timeline step per call, written in `finally` so every early error return records a
      // failed step too. The target label is taken before the action (the pre-action screen).
      const stepStarted = Date.now();
      const stepCtx: ActStepCtx = {};
      let res: CallToolResult | undefined;
      try {
        res = await runWithSignal(ctx?.mcpReq.signal, async (): Promise<CallToolResult> => {
          const { sessionId, action } = args;
          // Single validation layer for the per-action field contract (see REQUIRED_BY_ACTION).
          const invalid = missingRequiredField(action, args);
          if (invalid) return invalid;
          const session = sessions.get(sessionId);
          if (!session) return unknownSessionError(sessionId);
          stepCtx.target = actStepTarget(session, args);
          const { driver: d, blocked } = await getDriver(session);
          stepCtx.driver = d;
          if (!d) {
            // H6: a device is online but refused (physical) or not ready (still booting).
            return (
              blockedDeviceResult(blocked) ??
              qaError({
                what: 'No device attached to this session',
                changedState: false,
                retrySafe: true,
                failureCode: 'NO_DEVICE',
                nextSteps: [prepareFirstStep(session)],
              })
            );
          }
          if (d.kind === 'simulator') {
            const lost = await lostWdaResult(session, 'No structured interaction');
            if (lost) return lost;
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
          // action), but it is NOT exempt from the TIME budget, otherwise repeated waits could
          // burn the clock indefinitely.
          const stopReason = sessions.budgetStop(session);
          if (stopReason && (action !== 'wait' || /time budget/.test(stopReason))) {
            return qaStop(stopReason, { counters: session.counters, mode: session.mode });
          }
          const fail = (what: string, changedState: boolean, r?: ResolveError) =>
            qaError(
              {
                what,
                changedState,
                retrySafe: true,
                failureCode: r?.failureCode ?? targetErrorCode(what),
                nextSteps: ['Run qa_snapshot to see the current screen, then retry.'],
              },
              r?.candidates?.length ? { candidates: r.candidates } : undefined,
            );

          // ---- wait is its own path (no settle/health afterward) ----
          if (action === 'wait') {
            // A wait takes its element in `for`; a `target` would be ignored and the wait would return
            // ok:true for an element that is not there.
            if (args.target && !args.for)
              return qaError({
                what: 'wait takes the element to wait for in `for`, not `target`',
                changedState: false,
                retrySafe: true,
                failureCode: 'INVALID_ARGUMENT',
                nextSteps: [
                  'Retry with for:{text|id|ref|selector} (gone:true to wait until it disappears), or omit target to wait for the screen to settle.',
                ],
              });
            // A cancelled wait (notifications/cancelled) stops polling at once and is not a failure.
            try {
              const timeoutMs = args.timeoutMs ?? 8000;
              if (args.for?.settled || !args.for) {
                const s = await settle(d, { timeoutMs });
                const post = adoptSnapshot(session, s.parsed ?? parseSnapshot(s.xml));
                stepCtx.nodes = post.allNodes;
                stepCtx.xml = s.xml || undefined;
                // observe:"none" returns verdicts only.
                if (args.observe === 'none') {
                  const hint = `${post.elements.length} element(s) not shown (observe:"none"); pass observe:"full" or run qa_snapshot to see the screen.`;
                  return qaOk(
                    { action, settled: s.settled, quality: post.quality.verdict, observe: 'none', hint },
                    `wait(settled)=${s.settled}\n\n${hint}`,
                    { textOmit: ['hint'] },
                  );
                }
                const { payload: shown, rendered, omitted } = presentElements(post.elements, makeRedactor(session.secrets));
                return qaOk(
                  { action, settled: s.settled, quality: post.quality.verdict, elementsOmitted: omitted, elements: shown },
                  `wait(settled)=${s.settled}\n\n${rendered}`,
                  { textOmit: ['elements'] },
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
                  throwIfCancelled();
                  if ((await d.existsBySelector(native.using, native.value)) !== !!want.gone) {
                    return qaOk(
                      want.gone
                        ? { action, gone: true, selector: want?.selector, via: 'native-selector' }
                        : { action, found: true, selector: want?.selector, via: 'native-selector' },
                      `wait: ${want.gone ? 'gone' : 'found'} ${native.using}=${native.value}`,
                    );
                  }
                  await sleepOrCancel(400);
                }
                return qaError({
                  what: `wait timed out (${timeoutMs}ms) for ${JSON.stringify(want)}`,
                  changedState: false,
                  retrySafe: true,
                  failureCode: want.gone ? 'ASSERTION_FAILED' : 'ELEMENT_NOT_FOUND',
                  nextSteps: ['Re-check the native selector value, or run qa_snapshot to inspect the current screen.'],
                });
              }
              // A ref is matched by the node it named when the wait started (refs are stable across dumps).
              const refNode = want.ref ? session.lastSnapshot?.fullByRef.get(want.ref) : undefined;
              // Each dump gets only the time left, so the wait ends near timeoutMs (a dump
              // that runs past the deadline used to add its whole duration).
              while (deadline - Date.now() > 250) {
                throwIfCancelled();
                let parsed: ParsedSnapshot;
                try {
                  parsed = await snapshotNow(session, d, { timeoutMs: deadline - Date.now(), attempts: 2 });
                  stepCtx.nodes = parsed.allNodes;
                } catch (e) {
                  if (isAbortError(e) || deadline - Date.now() > 250) throw e;
                  break; // the dump ran out of the wait's time: report the timeout below
                }
                const hit = parsed.elements.find(
                  (e) =>
                    (want.ref && e.ref === want.ref) ||
                    (want.id && e.id === want.id) ||
                    (want.text &&
                      ((e.text !== undefined && foldText(e.text).includes(foldText(want.text))) ||
                        (e.label !== undefined && foldText(e.label).includes(foldText(want.text))))),
                );
                if (want.gone) {
                  const node = hit && parsed.fullByRef.get(hit.ref);
                  const stillThere = hit && (!refNode || (!!node && sameIdentity(node, refNode)));
                  if (!stillThere) return qaOk({ action, gone: true }, `wait: gone ${JSON.stringify(want)}`);
                } else if (hit) return qaOk({ action, found: true, ref: hit.ref }, `wait: found ${hit.ref}`);
                await sleepOrCancel(Math.max(1, Math.min(400, deadline - Date.now() - 250)));
              }
              return qaError({
                what: `wait timed out (${timeoutMs}ms) for ${JSON.stringify(want)}`,
                changedState: false,
                retrySafe: true,
                failureCode: want.gone ? 'ASSERTION_FAILED' : 'ELEMENT_NOT_FOUND',
                nextSteps: [
                  want.gone
                    ? 'The element is still on screen; re-snapshot to see why.'
                    : 'Re-snapshot; the element may use different text/id.',
                ],
              });
            } catch (e) {
              if (isAbortError(e)) return cancelledResult('wait cancelled: the call was aborted before the condition held');
              throw e;
            }
          }

          // Phase timing: mark the first real action so the report can split setup vs active.
          sessions.milestone(session, 'first_action');

          const preSnap = session.lastSnapshot;
          let preSigs = preSnap?.signatures ?? new Set<string>();
          // The nodes behind preSigs, so removed elements render as element lines.
          let preByRef = preSnap?.fullByRef;
          // F: positions too. A scroll/swipe can move content without adding/removing elements.
          let prePositions = positionalFingerprint(preSnap?.fullByRef);
          // Toggle/selection state of the pre-action screen (a Switch flip changes no signature).
          let preState = stateByIdentity(preSnap?.fullByRef);
          // The value actually typed (after ${SWIPIUM_*} expansion), redacted from results/errors.
          let typedValue: string | undefined;
          // The field typed into (generic type path), for the read-back check.
          // x/y: the focus tap, so a field found by focus that covers it is the typed one.
          let typedField:
            { ref?: string; x: number; y: number; secure: boolean; replace: boolean; label?: string | null; retried: boolean } | undefined;
          // untilVisible's last probe dump. Seeds the post-action settle (no redundant dump).
          let settleSeed: { xml: string; at: number } | undefined;
          // I: set when the soft keyboard was hidden because it covered the target.
          let keyboardHidden = false;
          // Observation mode is fixed at action start; diff needs a pre-action baseline.
          const observe: 'diff' | 'full' | 'none' = args.observe ?? (session.lastSnapshot ? 'diff' : 'full');
          let meta: Record<string, unknown> = {};
          // remembered so a no-change tap can be retried as a longer press (RN tap quirk)
          // imeUp: the soft keyboard was shown at tap time, so a re-press could hit a key (H5).
          let tapRetry: { x: number; y: number; instant: boolean; imeUp: boolean } | undefined;
          // X5: pre-tap screenshot, taken only when the hierarchy alone may not show the tap's effect.
          let prePng: Buffer | undefined;
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
                if ('error' in resolved) return fail(resolved.error, false, resolved);
                let t = resolved;
                // H5: keyboard obstruction (the IME window is not in the app's UI dump, so the
                // overlay check below can't see it). Coordinate taps are taken as deliberate.
                let imeUp = false;
                // A key of the on-screen keyboard is the target itself, never obstructed by it.
                const keyTap = isKeyboardKey(session, t);
                if (keyTap) imeUp = true;
                else if (!args.ignoreOverlay && t.via !== 'coords') {
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
                  // works for ref AND selector taps: t.ref is the resolved @eN in either case
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
                          'Call qa_clear_overlay (auto, or hide_keyboard/minimize_logbox), then retry. Or pass ignoreOverlay:true to tap anyway.',
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
                // X5: a tap on an unlabeled / canvas-like target may change only pixels; keep a pre-shot.
                // capture-guard: pixel-change check, compared in memory and never saved
                if (needsPixelCheck(session, t)) prePng = await d.screenshot().catch(() => undefined);
                if (durationMs) await d.pressXY(t.x, t.y, durationMs);
                else await d.tapXY(t.x, t.y);
                tapRetry = { x: t.x, y: t.y, instant: !durationMs, imeUp };
                meta = {
                  tappedAt: [t.x, t.y],
                  via: t.via,
                  ...(durationMs ? { durationMs } : {}),
                  ...(t.refMoved ? { refMoved: true } : {}),
                };
                toRecord = { action: 'tap', ...recordableTap(session, stripSelector(args.target), t) };
                break;
              }
              case 'type': {
                // presence enforced by missingRequiredField
                // P1: `${SWIPIUM_*}` placeholders expand from session inputs (qa_continue_from_blocker) or the env,
                // so credentials never have to pass through the agent transcript.
                const secretVars = new Set(session.inputs.filter((i) => i.secret).map((i) => i.varName));
                const expanded = expandInputPlaceholders(args.text!, { values: session.inputValues, secretVars });
                if (expanded.missing.length) {
                  return qaError({
                    what: `No value for ${expanded.missing.map((v) => `\${${v}}`).join(', ')}. Nothing was typed.`,
                    changedState: false,
                    retrySafe: true,
                    failureCode: 'MISSING_TEST_DATA',
                    nextSteps: [
                      'Provide it via qa_continue_from_blocker (needs_input credentials) or set the env var for the Swipium server, then retry. Only ${SWIPIUM_*} placeholders are expanded.',
                    ],
                  });
                }
                for (const v of expanded.secretValues) session.secrets.add(v);
                const text = expanded.text;
                typedValue = text;
                const recordText = recordableTypedText(args.text!, text, expanded.vars, session.inputValues);
                // D: validate deliverability BEFORE any focus tap / clear. A refused value must
                // leave the field (and the device) exactly as it was.
                const deliverable = d.canDeliverText?.(text);
                if (deliverable && !deliverable.ok) {
                  return qaError({
                    // The failure line already carries the code; don't repeat it.
                    what: `${deliverable.reason.replace(/^TEXT_INPUT_UNSUPPORTED:\s*/, '')} Nothing was tapped or cleared.`,
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
                  // This path must capture secrets exactly like the generic path below, or a
                  // password typed by native selector is recorded VERBATIM into generated flows.
                  // Heuristic first (selector value looks secret, same SECRET_RE the generic
                  // resolver applies to ids), then the real signal: probe the resolved element's
                  // type (XCUIElementTypeSecureTextField). A failing probe keeps the heuristic verdict.
                  // A type target is an input field: name the class so the input-only rule applies.
                  let secure = isSecureNode({ id: native.value, desc: '', attrs: {}, cls: 'XCUIElementTypeTextField' });
                  if (!secure && d.isSecureBySelector) {
                    try {
                      secure = await d.isSecureBySelector(native.using, native.value);
                    } catch {
                      // probe unavailable (older WDA / element churn): heuristic alone decides
                    }
                  }
                  if (secure) {
                    session.secrets.add(text);
                    sessions.markAuth(session, { loginPerformed: true, loginPerformedAt: Date.now() });
                    sessions.milestone(session, 'login_performed');
                  }
                  if (replace) await d.clearBySelector!(native.using, native.value);
                  await d.typeBySelector(native.using, native.value, text);
                  // Read the element's value back like the generic path (not secure, no submit).
                  // A mismatch fails the call (TEXT_INPUT_MISMATCH, lengths only); an unreadable value skips it.
                  if (!secure && !args.submit && text && d.valueBySelector) {
                    let value: string | undefined;
                    try {
                      value = await d.valueBySelector(native.using, native.value);
                    } catch (e) {
                      if (isAbortError(e)) throw e;
                    }
                    if (value !== undefined) {
                      const verdict = typedReadBack(value, text, replace);
                      const holds = `it holds ${value.length} chars, ${text.length} were typed`;
                      if (verdict === 'mismatch')
                        throw new Error(
                          `TEXT_INPUT_MISMATCH: the field does not read back the typed text (${holds}${replace ? ', replace mode' : ''}): it was reordered, cut or not cleared.`,
                        );
                      if (verdict === 'reformatted') warnings.push(`the field holds the typed text reformatted by the app (${holds})`);
                      else if (verdict === 'truncated')
                        warnings.push(
                          `the field holds only the start of the typed text (${holds}): a max length, or the rest went to the next field`,
                        );
                    }
                  }
                  const recordSecret = secure || knownSecret;
                  meta = {
                    typedChars: text.length,
                    // The response never echoes the value; `redacted`/`secret` flag a value treated as
                    // secret (registered for scrubbing, recorded only as a placeholder).
                    ...(recordSecret ? { redacted: true, secret: true } : {}),
                    ...(expanded.vars.length ? { placeholders: expanded.vars } : {}),
                    mode: args.mode ?? 'replace',
                    via: 'native-selector',
                    selector: args.target?.selector,
                    submit: !!args.submit,
                  };
                  // Never store a secret's value in the IR; secrets become a ${VAR} at generate time.
                  {
                    const nativeTarget = recordableNativeTarget(session, native);
                    toRecord = {
                      action: 'type',
                      ...nativeTarget,
                      secret: recordSecret,
                      // a secret is recorded only as its ${VAR} placeholder (never the value)
                      text: recordSecret ? (recordText !== text ? recordText : undefined) : recordText,
                      exportability: recordSecret ? 'needs-human-data' : nativeTarget.exportability,
                    };
                  }
                  if (args.submit) await d.pressKey('enter');
                  break;
                }
                const resolved = await resolveTarget(session, stripSelector(args.target));
                if ('error' in resolved) return fail(resolved.error, false, resolved);
                let t = resolved;
                // H5: focusing a field hidden under the keyboard would type a stray key character.
                const g = await guardKeyboard(session, d, t, stripSelector(args.target));
                if ('result' in g) return g.result;
                t = g.t;
                if (g.warning) warnings.push(g.warning);
                if (g.hidKeyboard) keyboardHidden = true;
                // Typing into a secure field > remember the value so it's scrubbed everywhere, and
                // record that a login was performed (auth-state reporting).
                if (t.secure) {
                  session.secrets.add(text);
                  sessions.markAuth(session, { loginPerformed: true, loginPerformedAt: Date.now() });
                  sessions.milestone(session, 'login_performed');
                }
                // The field's Compose label, from its node before typing (by ref, else the text
                // field under the tap), so the read-back strips only that label.
                const preNode = t.ref
                  ? session.lastSnapshot?.fullByRef.get(t.ref)
                  : session.lastSnapshot?.allNodes.find((n) => isTextFieldClass(n.cls) && boundsContain(n.bounds, t.x, t.y));
                const label = composeLabelOf(preNode && isTextFieldClass(preNode.cls) ? preNode : undefined);
                await d.tapXY(t.x, t.y); // focus + raise IME (real touch)
                await awaitIme(d, 700, g.imeUp ? IME_HOP_FLOOR_MS : 0);
                const replace = (args.mode ?? 'replace') === 'replace';
                if (replace) await d.clearFocusedText(t.textLen);
                let retried = false;
                try {
                  await d.inputText(text);
                } catch (e) {
                  // Long text that did not read back in order gets ONE retry from a cleared
                  // field (it may hold the old value plus what landed), typed carefully (short paced
                  // bursts on Android). A second miss fails the call.
                  if (!replace || !/TEXT_INPUT_MISMATCH/.test(String(e))) throw e;
                  await d.clearFocusedText((t.textLen ?? 0) + text.length);
                  await d.inputText(text, { careful: true });
                  retried = true;
                }
                if (args.submit) await d.pressKey('enter');
                typedField = { ref: t.ref, x: t.x, y: t.y, secure: !!t.secure, replace, label, retried };
                // Never echo the typed value. It may be a password/OTP/email/token and would
                // leak into the agent transcript + artifacts (sensitive-mode).
                const recordSecret = !!t.secure || knownSecret;
                meta = {
                  typedChars: text.length,
                  ...(recordSecret ? { redacted: true, secret: true } : {}),
                  ...(expanded.vars.length ? { placeholders: expanded.vars } : {}),
                  mode: args.mode ?? 'replace',
                  via: t.via,
                  submit: !!args.submit,
                };
                // Never store a secret's value in the IR; secrets become a ${VAR} at generate time.
                {
                  const targetRecord = recordableTap(session, stripSelector(args.target), t);
                  toRecord = {
                    action: 'type',
                    selector: targetRecord.selector,
                    selectorKind: targetRecord.selectorKind,
                    secret: recordSecret,
                    // a secret is recorded only as its ${VAR} placeholder (never the value)
                    text: recordSecret ? (recordText !== text ? recordText : undefined) : recordText,
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
                if ('error' in resolved) return fail(resolved.error, false, resolved);
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
                const direction = args.direction!; // presence enforced by missingRequiredField
                // Derive the gesture from the real screen size. WDA swipes are in POINTS
                // (≤~440pt wide), so the old fixed 540/1200 constants were off-screen on iOS; the
                // legacy constants survive only inside the shared fallback for screenSize()===null.
                // A supplied target that fails to resolve is a structured error (not a
                // silent default swipe), and a resolved point is used verbatim (0 is a legitimate
                // coordinate). Endpoints keep an ~8% inset clear of iOS system-gesture zones.
                const size = await d.screenSize().catch(() => null);
                let vec: SwipeVec;
                if (args.target) {
                  const start = await resolveTarget(session, stripSelector(args.target));
                  if ('error' in start) return fail(start.error, false, start);
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
                // content axis). Screen-relative + clamped vector, size fetched once.
                const finger = { down: 'up', up: 'down', left: 'left', right: 'right' } as const;
                const size = await d.screenSize().catch(() => null);
                const dir = args.direction!; // presence enforced by missingRequiredField
                const u = args.untilVisible;
                // A match only counts as FOUND when its center is on screen and not under the soft
                // keyboard: a row just crossing the bottom edge is "in the tree" but a center tap on it
                // would land off-screen / on a key, so keep swiping instead.
                const kb = u ? await keyboardArea(d) : undefined;
                const probe = async () => {
                  const xml = await d.dumpXml();
                  const at = Date.now();
                  const parsed = parseSnapshot(xml);
                  const [sw, sh] = size ? [size.width, size.height] : parsed.screen;
                  const hit = parsed.elements.some((e) => {
                    const match =
                      (u?.id && e.id === u.id) ||
                      (u?.text &&
                        ((e.text !== undefined && foldText(e.text).includes(foldText(u.text))) ||
                          (e.label !== undefined && foldText(e.label).includes(foldText(u.text)))));
                    if (!match) return false;
                    const c = center(e.bounds);
                    const onScreen = !(sw > 0 && sh > 0) || (c.x >= 0 && c.y >= 0 && c.x < sw && c.y < sh);
                    return onScreen && !inRect(kb?.rect, c.x, c.y);
                  });
                  // Positions are part of the signature: a list that moved but still shows the same
                  // labels is not at its end (the label-only signature reported endOfList mid-list).
                  const sig = parsed.elements
                    .map((e) => `${signature(e)}@${e.bounds.join(',')}`)
                    .sort()
                    .join('\n');
                  settleSeed = { xml, at };
                  stepCtx.nodes = parsed.allNodes;
                  stepCtx.xml = xml;
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
                    // Screen identical after a swipe > end of the list; more swipes can't help.
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
                const key = args.key!; // presence enforced by missingRequiredField
                await d.pressKey(key);
                meta = { key };
                // iOS has no back key: WdaDriver taps the nav-bar back button or edge-swipes. Say which.
                if (key === 'back' && d.kind === 'wda') {
                  const via = (d as { lastBackVia?: string }).lastBackVia;
                  if (via) meta.backVia = via;
                }
                toRecord = { action: 'press', key, exportability: 'semantic' };
                break;
              }
              case 'open_url': {
                const url = args.url!; // presence enforced by missingRequiredField
                await d.openUrl(url);
                meta = { url };
                toRecord = { action: 'open_url', url, exportability: 'semantic' };
                break;
              }
            }
            // X1/P2: resolving the target may have dumped the screen again (an aged or retired ref, a
            // text/id target, the keyboard re-check). That dump is the real pre-action view, so the
            // change check compares against it, not against the older snapshot the agent read.
            const nowSnap = session.lastSnapshot;
            if (nowSnap && nowSnap !== preSnap) {
              preSigs = nowSnap.signatures;
              preByRef = nowSnap.fullByRef;
              prePositions = positionalFingerprint(nowSnap.fullByRef);
              preState = stateByIdentity(nowSnap.fullByRef);
            }
          } catch (e) {
            noteScreenMutation(session); // the action may have partly run: a stored snapshot is stale
            // Cancelled mid-action: not a driver failure (no WDA_UNREACHABLE / SNAPSHOT_FAILED tool
            // error, no finding). The action may have partly run, so changedState stays true.
            if (isAbortError(e)) return cancelledResult(`Action "${action}" cancelled: the call was aborted before it finished`, true);
            const msg = String((e as Error)?.message ?? e);
            // iOS: a shut-down simulator or a dead WDA gets its own code and the concrete
            // recovery; a refused connection never reached the device.
            const outage = await diagnoseIosOutage(session, e);
            if (outage)
              return qaError({
                what: `Action "${action}" failed: ${outage.what}`,
                changedState: outage.changedState,
                retrySafe: true,
                failureCode: outage.failureCode,
                nextSteps: outage.nextSteps,
              });
            const failureCode: FailureCode = /BACKEND_UNSUPPORTED|not supported by the WDA backend/.test(msg)
              ? 'BACKEND_UNSUPPORTED'
              : classifyFlowDriverError(e);
            // H2: driver errors can echo argv/stderr. Scrub known secrets AND the value just typed.
            const redactErr = makeRedactor(errorSecrets(session, action === 'type' ? (typedValue ?? args.text) : undefined));
            // An append that did not read back left part of the text in the field: repeating it
            // types that part twice.
            // A timed-out adb input (DEVICE_UNRESPONSIVE) may also have typed part of it.
            const appendMismatch =
              (failureCode === 'TEXT_INPUT_MISMATCH' || failureCode === 'DEVICE_UNRESPONSIVE') &&
              action === 'type' &&
              args.mode === 'append';
            return qaError({
              what: `Action "${action}" failed: ${redactErr(String(e)) ?? ''}`,
              // A device that is gone cannot have changed.
              changedState: failureCode !== 'NO_DEVICE',
              retrySafe: !appendMismatch && !['WDA_SESSION_FAILED', 'UNKNOWN', 'NO_DEVICE'].includes(failureCode),
              failureCode,
              nextSteps:
                failureCode === 'NO_DEVICE'
                  ? deviceGoneNextSteps(session.device)
                  : failureCode === 'UNKNOWN'
                    ? ['Confirm the device is online and re-snapshot.']
                    : appendMismatch
                      ? ['Run qa_snapshot to see the field. Do not repeat the append: retry the whole value with mode:"replace".']
                      : failureCode === 'DEVICE_UNRESPONSIVE'
                        ? [
                            'The device did not answer adb in time (a stalled or overloaded emulator). Run qa_screenshot to see what landed; if it stays slow, restart the app or the emulator, then retry.',
                          ]
                        : ['Use the failureCode to choose recovery, then re-snapshot before retrying.'],
            });
          }

          // count this as an action (wait already returned earlier)
          sessions.bump(session, 'actions');
          // Record the action into the IR for qa_generate target:"flow" (the action definitely happened here;
          // recorded now so a later post-snapshot failure doesn't lose the step).
          let recorded: RecordedAction | undefined;
          if (toRecord) {
            const sc = recordingScreenContext(session);
            sessions.addRecordedAction(session, { at: Date.now(), ...sc, ...toRecord });
            recorded = session.recordedActions.at(-1);
          }

          // Post-action observation is wrapped so a settle/dump/parse failure (e.g. the
          // looping-animation case) returns a Swipium-shaped result, never a raw MCP error.
          try {
            // settle > observe > health (seeded with untilVisible's last probe; it was taken after the
            // last swipe, so re-dumping it first would be pure latency)
            // Home on iOS leaves the app. WDA's source still describes the backgrounded app (a
            // stale tree, up to ~28 s per dump), so don't settle on it: report the foreground instead.
            // Never a no-change action (it does not count toward maxNoChangeActions).
            if (action === 'press' && args.key === 'home' && d.kind === 'wda') {
              // WDA's active app lags the home transition by a few hundred ms: poll until the
              // app under test is no longer in front (or, with no app id, until SpringBoard is), up
              // to ~2 s. Each read is capped so a WDA busy settling SpringBoard can't stall the call.
              const inApp = (fg: string) => isForegroundOf(fg, session.appId);
              const onHome = (fg: string) => fg === IOS_SPRINGBOARD;
              const pending = (fg: string) => fg !== 'unknown' && !onHome(fg) && (inApp(fg) || !session.appId);
              const readForeground = () => withWdaCall({ timeoutMs: 1000 }, () => d.foregroundOwner()).catch(() => 'unknown');
              const homeDeadline = Date.now() + 2000;
              let foreground = await readForeground();
              while (pending(foreground) && Date.now() < homeDeadline) {
                await sleepOrCancel(250);
                foreground = await readForeground();
              }
              const left = foreground === 'unknown' || onHome(foreground) || (!!session.appId && !inApp(foreground));
              const budgetReached = sessions.budgetStop(session);
              const hint = 'The app is in the background; run qa_snapshot (or relaunch the app) to see the current screen.';
              return qaOk(
                {
                  action,
                  ...meta,
                  changed: left,
                  retriedAsPress: false,
                  settled: false,
                  foreground,
                  counters: session.counters,
                  ...(budgetReached ? { budgetReached } : {}),
                  observe,
                  hint,
                },
                `${action} ${JSON.stringify(meta)} > changed=${left} foreground=${foreground}` +
                  (budgetReached ? `\n⏹ budget reached: ${budgetReached}, call qa_report.` : '') +
                  `\n\n${hint}`,
                { textOmit: ['hint'] },
              );
            }
            // P1: the pre-action fingerprint enables the Android fast accept (first dump differs, not busy).
            const preFingerprint = preActionFingerprint(session);
            let s = await settle(d, { timeoutMs: args.timeoutMs ?? 8000, preFingerprint, ...(settleSeed ? { seed: settleSeed } : {}) });
            // Cancelled while observing: an empty/aborted dump is not evidence (no WDA_UNREACHABLE
            // health finding, no visual-fallback switch).
            if (isAbortError(undefined))
              return cancelledResult(`Action "${action}" ran, but the call was cancelled before its result was observed`, true);
            // P2/X3: adopted as the session snapshot (stable refs, capture time + action counter).
            let post: ParsedSnapshot = adoptSnapshot(session, s.parsed ?? parseSnapshot(s.xml));
            stepCtx.nodes = post.allNodes;
            stepCtx.xml = s.xml || undefined;
            let postSigs = new Set(post.elements.map(signature));
            // F: for gestures that move content, a bounds shift counts as a change too.
            const positional = action === 'scroll' || action === 'swipe';
            const movedContent = () => positional && prePositions !== undefined && prePositions !== positionalFingerprint(post.fullByRef);
            // Toggle state counts: a Switch/Checkbox flip keeps every signature (role|label|id|text).
            let toggled = stateChangedRefs(preState, post.fullByRef);
            let changed = !setsEqual(preSigs, postSigs) || movedContent() || toggled.length > 0;
            // X5: same hierarchy, but the pixels may say otherwise (canvas / WebView / unlabeled target).
            let pixelChanged = false;
            if (!changed && prePng) {
              // capture-guard: pixel-change check, compared in memory and never saved
              const postPng = await d.screenshot().catch(() => undefined);
              pixelChanged = !!postPng && pixelsDiffer(prePng, postPng);
              changed = pixelChanged;
            }

            // No-change retry (review §4.5/§4.7): an instant tap that did nothing is often the RN
            // tap quirk. Retry ONCE as a longer press before believing it's blocked.
            let retriedAsPress = false;
            // Never when the keyboard was up at tap time: the retry would re-press a point the IME
            // may own and type a second stray character (H5).
            if (!changed && action === 'tap' && tapRetry?.instant && !tapRetry.imeUp) {
              await d.pressXY(tapRetry.x, tapRetry.y, 120);
              retriedAsPress = true;
              s = await settle(d, { timeoutMs: args.timeoutMs ?? 8000 });
              post = adoptSnapshot(session, s.parsed ?? parseSnapshot(s.xml));
              stepCtx.nodes = post.allNodes;
              stepCtx.xml = s.xml || undefined;
              postSigs = new Set(post.elements.map(signature));
              toggled = stateChangedRefs(preState, post.fullByRef);
              changed = !setsEqual(preSigs, postSigs) || movedContent() || toggled.length > 0;
            }

            // Read the field back. Long adb text could land out of order, and a replace could
            // leave old text behind, while the call still "succeeded". The typed field holding other
            // text fails the call (TEXT_INPUT_MISMATCH): found by its ref, or in replace mode the
            // focused field under the focus tap (a coordinate target, or a ref that moved). A
            // reformatted or cut-short value, or a mismatch in another focused field (the screen may
            // have moved on), is a warning. The field's value is compared, not a Compose label after
            // it. Not for secure fields (masked), submitted fields (cleared / navigated) or
            // empty values.
            if (action === 'type' && typedField && typedValue && !typedField.secure && !args.submit) {
              const tf = typedField;
              const typedText = typedValue;
              const readField = () => {
                const byRef = tf.ref ? post.fullByRef.get(tf.ref) : undefined;
                const node = byRef ?? [...post.fullByRef.values()].find((n) => n.focused && isTextFieldClass(n.cls));
                if (!node || !isTextFieldClass(node.cls) || isSecureNode(node)) return undefined;
                const isTyped = node === byRef || (tf.replace && node.focused && boundsContain(node.bounds, tf.x, tf.y));
                return { node, isTyped, ...fieldReadBack(node, typedText, tf.replace, tf.label) };
              };
              let back = readField();
              // A replace that left other text (a select-all the field
              // collapsed, a scramble) or came out cut short is retried ONCE while the field still has
              // focus: clear, retype (carefully after a mismatch), read back again. A cut-short value
              // passes (warning) only when the retype stops at the same length (a max length); a
              // different cut is dropped input and fails. Not when focus moved on (an OTP box handed
              // the rest to the next box).
              let firstCut: number | undefined;
              if (
                back?.isTyped &&
                tf.replace &&
                !tf.retried &&
                back.node.focused &&
                (back.verdict === 'mismatch' || back.verdict === 'truncated')
              ) {
                if (back.verdict === 'truncated') firstCut = back.valueLength;
                try {
                  await d.clearFocusedText(Math.max(back.node.text.length, back.valueLength) + 2, { byLength: true });
                  await d.inputText(typedText, { careful: back.verdict === 'mismatch' });
                } catch (e) {
                  // A careful retype that still scrambles leaves the field as it is: the read-back fails it.
                  if (!/TEXT_INPUT_MISMATCH/.test(String(e))) throw e;
                }
                tf.retried = true;
                meta = { ...meta, retyped: true };
                s = await settle(d, { timeoutMs: args.timeoutMs ?? 8000 });
                post = adoptSnapshot(session, s.parsed ?? parseSnapshot(s.xml));
                stepCtx.nodes = post.allNodes;
                stepCtx.xml = s.xml || undefined;
                postSigs = new Set(post.elements.map(signature));
                back = readField();
              }
              if (back) {
                const { valueLength, isTyped } = back;
                // A cut that a retype did not repeat (or a cut after a scramble) is dropped input.
                const verdict = back.verdict === 'truncated' && tf.retried && firstCut !== valueLength ? 'mismatch' : back.verdict;
                const holds = `it holds ${valueLength} chars, ${typedValue.length} were typed`;
                if (verdict === 'mismatch' && isTyped)
                  return qaError({
                    what: `The field does not read back the typed text (${holds}${typedField.replace ? ', replace mode' : ''}): it was reordered, cut or not cleared.`,
                    changedState: true,
                    // Append mode: the field keeps what landed, so the same append would type it twice.
                    retrySafe: typedField.replace,
                    failureCode: 'TEXT_INPUT_MISMATCH',
                    nextSteps: typedField.replace
                      ? [
                          'Run qa_snapshot to see the field, then retry the type (replace mode clears it first). For long text, type it in shorter parts with mode:"append".',
                        ]
                      : ['Run qa_snapshot to see the field. Do not repeat the append: retry the whole value with mode:"replace".'],
                  });
                if (verdict === 'mismatch')
                  warnings.push(`the focused field does not read back the typed text (${holds}); check the field before relying on it`);
                else if (verdict === 'reformatted') warnings.push(`the field holds the typed text reformatted by the app (${holds})`);
                else if (verdict === 'truncated')
                  warnings.push(
                    `the field holds only the start of the typed text (${holds}): a max length, or the rest went to the next field`,
                  );
              }
            }
            // A structured dump succeeded > a visual-fallback session is structured again (per-screen).
            const modeRecovered = s.xml ? sessions.noteStructuredDump(session) : false;
            const health = await checkHealth(d, session.appId, s.xml, { nodes: post.allNodes });
            if (health.cancelled)
              return cancelledResult(`Action "${action}" ran, but the call was cancelled before its result was observed`, true);
            // qa_report counts a recorded action as device evidence only when the app under test
            // was in front after it (not a tap on SpringBoard / another app, not a press home).
            // Exact package / bundle id (an Android ":process" suffix allowed): `com.example.app` must not
            // match `com.example.app2`.
            if (recorded && session.appId && !health.deviceGone && isForegroundOf(health.foreground, session.appId)) {
              recorded.appForeground = true;
              sessions.persist(session);
            }

            // Track no-change actions for the budget / no-op-loop detector.
            // `press home` leaves the app; it is never a no-op loop step.
            // A satisfied untilVisible is a success even with no swipe.
            const untilVisibleMet = action === 'scroll' && meta.untilVisibleFound === true;
            if (
              !changed &&
              !untilVisibleMet &&
              (action === 'tap' || action === 'swipe' || action === 'scroll' || (action === 'press' && args.key !== 'home'))
            ) {
              sessions.bump(session, 'noChangeActions');
            }
            const budgetReached = sessions.budgetStop(session);

            // Sensitive-mode present: mask secure fields + scrub registered secrets only. A value typed
            // into an ordinary field stays visible: scrubbing it hid the field's value
            // and every search result containing it, while the next qa_snapshot showed it anyway.
            // Secure-field values and secret placeholders were registered in session.secrets above.
            const redact = makeRedactor(session.secrets);

            // Record non-info findings for qa_report (deterministic bug trail) + app-error screenshot.
            await recordHealthFindings(sessions, session, health.findings, d, health.foreground, post?.allNodes);

            const banner =
              `${action} ${JSON.stringify(meta)} > changed=${changed}${retriedAsPress ? ' (retried as press)' : ''}${pixelChanged ? ' (pixels)' : ''} ` +
              `settled=${s.settled} quality=${post.quality.verdict} native=${health.nativeHealthy ? 'ok' : health.nativeStatus} app=${health.appStatus}` +
              (budgetReached ? `\n⏹ budget reached: ${budgetReached}, call qa_report.` : '') +
              (modeRecovered ? '\nmode: structured again (a UI tree dump succeeded; visual-fallback cleared)' : '') +
              (!changed && retriedAsPress
                ? `\nNo change even after a press retry. Likely wrong coords / disabled element / overlay / auth wall.`
                : '');
            const findings = health.findings.length
              ? '\n' +
                health.findings
                  .map((f) => `[${f.severity}] ${f.layer ?? '?'}/${f.kind}: ${f.detail}${f.evidence ? `: "${f.evidence}"` : ''}`)
                  .join('\n')
              : '';

            // `observe` changes ONLY the element presentation below. Everything above
            // (lastSnapshot bookkeeping, press retry, health recording, counters, budget lines)
            // is identical in all modes.
            let elementPayload: Record<string, unknown> = {};
            let elementsText = '';
            const added = observe === 'diff' ? post.elements.filter((e) => !preSigs.has(signature(e))) : [];
            // Mostly-new screen (navigation): a diff would list every new element AND every old one
            // as removed, bigger than the full list. Return the (capped) full list + removedCount.
            const diffAsFull =
              observe === 'diff' && post.elements.length > 0 && added.length > post.elements.length * DIFF_FULL_FALLBACK_RATIO;
            if (observe === 'diff' && !diffAsFull) {
              // Removed elements as element lines (capped like any list), not internal identity keys.
              const removedEls: SnapshotElement[] = [];
              const removedSeen = new Set<string>();
              for (const [ref, n] of preByRef ?? []) {
                const e = toElement(ref, n);
                const sig = signature(e);
                if (!preSigs.has(sig) || postSigs.has(sig) || removedSeen.has(sig)) continue;
                removedSeen.add(sig);
                removedEls.push(e);
              }
              const removed = presentElements(removedEls, redact).lines;
              const { payload: addedShown, rendered: renderedAdded, omitted } = presentElements(added, redact);
              const unchangedElements = post.elements.length - added.length;
              const hint = `${unchangedElements} unchanged element(s) not shown; pass observe:"full" to see the whole screen.`;
              elementPayload = { elementsOmitted: omitted, elements: addedShown, removed, unchangedElements, hint };
              elementsText =
                `\n\nDIFF vs pre-action: +${added.length} / -${removedEls.length}` +
                (added.length ? `\n${renderedAdded}` : '') +
                (removed.length ? `\nremoved: ${removed.join(' | ')}` : '') +
                `\n${hint}`;
            } else if (diffAsFull) {
              const removedCount = [...preSigs].filter((sig) => !postSigs.has(sig)).length;
              const { payload: outElements, rendered, omitted } = presentElements(post.elements, redact);
              elementPayload = {
                diffAsFull: true,
                elementsOmitted: omitted,
                elements: outElements,
                addedCount: added.length,
                removedCount,
              };
              elementsText =
                `\n\nNEW SCREEN (${added.length}/${post.elements.length} elements new, ${removedCount} previous gone), full list:` +
                `\n${rendered}`;
            } else if (observe === 'full') {
              const { payload: outElements, rendered, omitted } = presentElements(post.elements, redact);
              elementPayload = { elementsOmitted: omitted, elements: outElements };
              elementsText = `\n\n${rendered}`;
            } else {
              const hint = `${post.elements.length} element(s) not shown (observe:"none"); pass observe:"full" or run qa_snapshot to see the screen.`;
              elementPayload = { hint };
              elementsText = `\n\n${hint}`;
            }

            if (toggled.length && observe !== 'none') {
              const lines = toggled.map((ref) => {
                const n = post.fullByRef.get(ref)!;
                const name = isSecureNode(n) ? '«secure»' : (redact(n.desc || n.text) ?? '');
                return `${ref} ${JSON.stringify(name)} ${stateLabel(n)}`;
              });
              elementPayload = { ...elementPayload, stateChanged: lines };
              elementsText += `\nstate changed: ${lines.join(' | ')}`;
            }

            // C10: a weak tree may not show what is on screen; point at the visual tools.
            const weakHint = observe !== 'none' ? weakTreeHint(post) : undefined;
            if (weakHint) elementsText += `\n${weakHint}`;

            // The WDA driver transparently re-creates a reaped session (without relaunching the app);
            // the agent must know the screen may not be where it left it.
            if (d.consumeSessionRecovered?.()) warnings.push(WDA_SESSION_RECOVERED_WARNING);

            return qaOk(
              {
                action,
                ...meta,
                ...(keyboardHidden ? { keyboardHidden: true } : {}),
                ...(modeRecovered ? { modeRecovered: true, mode: 'structured' } : {}),
                changed,
                ...(pixelChanged ? { pixelChanged: true } : {}),
                retriedAsPress,
                settled: s.settled,
                ...(s.fastAccepted ? { settleFast: true } : {}),
                ...(weakHint ? { treeHint: weakHint } : {}),
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
              { textOmit: ['elements', 'removed', 'hint', 'stateChanged', 'treeHint'] },
            );
          } catch (e) {
            if (isAbortError(e))
              return cancelledResult(`Action "${action}" ran, but the call was cancelled before its result was observed`, true);
            // The device disappeared (emulator killed): NO_DEVICE, no visual-fallback switch.
            if (isDeviceGoneError(e))
              return qaError({
                what: `Action "${action}" could not be observed: the device is offline: ${String(e)}`,
                changedState: false,
                retrySafe: false,
                failureCode: 'NO_DEVICE',
                nextSteps: deviceGoneNextSteps(session.device),
              });
            // The action ran; observing the result failed (often a UI that never reaches idle).
            // visual-fallback is per-screen: the next successful qa_snapshot / qa_act dump clears it.
            const idle = /idle|dump|hierarchy/i.test(String(e));
            if (idle) sessions.setMode(session, 'visual-fallback');
            const redactErr = makeRedactor(errorSecrets(session, action === 'type' ? (typedValue ?? args.text) : undefined));
            return qaError({
              what: `Action "${action}" ran, but observing the result failed: ${redactErr(String(e)) ?? ''}`,
              changedState: true,
              retrySafe: false,
              failureCode: classifyFlowDriverError(e, 'SNAPSHOT_FAILED'),
              nextSteps: idle
                ? [
                    'Switched to visual-fallback for this screen (cleared by the next successful qa_snapshot / qa_act dump). Use qa_screenshot; qa_check_health still works.',
                  ]
                : ['Re-check the device is online, then qa_screenshot / qa_check_health.'],
            });
          }
        });
        return clampedFrom != null ? qaAnnotate(res, [`timeoutMs ${clampedFrom} clamped to ${ACT_TIMEOUT_MAX_MS}.`]) : res;
      } finally {
        await recordActStep(sessions, args, res, stepStarted, stepCtx);
      }
    },
  );
}
