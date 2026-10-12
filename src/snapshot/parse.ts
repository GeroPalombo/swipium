// Parse a uiautomator dump into @eN-referenced elements + a snapshotQuality verdict.
// The dump is the Android accessibility tree, so quality is a property
// of the target app. We measure it rather than pretend a weak tree is strong.

import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { SnapshotElement } from '../drivers/Driver.js';
import { isSecureNode } from '../lib/redact.js';

export interface RawNode {
  cls: string;
  text: string;
  desc: string; // content-desc
  id: string; // resource-id
  bounds: [number, number, number, number];
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  focusable: boolean;
  focused: boolean;
  enabled: boolean;
  isLeaf: boolean;
  attrs: Record<string, string>;
  dfs: number; // pre-order index (later = drawn on top)
  subtreeEnd: number; // max dfs within this node's subtree (descendant range = (dfs, subtreeEnd])
  drawingOrder: number; // uiautomator drawing-order attr (per-parent), -1 if absent
  /** Structural identity for stable refs: class + resource-id + text/desc + parent key + ordinal
   *  among equal siblings (text fields leave their text out, so typing keeps the key). */
  key?: string;
  /** Surfaced nodes only: subtreeLabel(), the text a list row shows through its child views. */
  label?: string;
  /** Surfaced clickable nodes without their own text/desc only: the first text/desc in their
   *  subtree (never an id), shown as the element's name (a list row labeled by its child title). */
  childLabel?: string;
}

export interface SnapshotQuality {
  verdict: 'good' | 'partial' | 'poor';
  reasons: string[];
  signals: {
    nodeCount: number;
    clickableCount: number;
    unidentifiedClickableRatio: number;
    idCoverage: number;
    webviewDominance: number;
    composeNoTestTag: boolean;
  };
}

export interface ParsedSnapshot {
  elements: SnapshotElement[];
  fullByRef: Map<string, RawNode>;
  allNodes: RawNode[]; // full flattened tree in DFS order (for overlay/obstruction analysis)
  quality: SnapshotQuality;
  screen: [number, number];
  total: number;
}

const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;
const WEBVIEW_RE = /WebView|SurfaceView|GLSurfaceView|TextureView/i;
const COMPOSE_RE = /compose/i;
/** Editable text inputs on both platforms: Android EditText (+ AutoCompleteTextView subclasses)
 * and iOS XCUIElementType TextField / SecureTextField / SearchField / TextView (WDA source). */
export const TEXT_FIELD_CLASS_RE =
  /EditText|AutoCompleteTextView|XCUIElementType(?:Secure)?TextField\b|XCUIElementTypeSearchField\b|XCUIElementTypeTextView\b/;

/** Is this node an editable text field (either platform)? */
export function isTextFieldClass(cls: string): boolean {
  return TEXT_FIELD_CLASS_RE.test(cls);
}

function bool(v: unknown): boolean {
  return v === 'true' || v === true;
}

function parseBounds(s: string): [number, number, number, number] {
  const m = typeof s === 'string' ? s.match(BOUNDS_RE) : null;
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** fast-xml-parser decodes only the named XML entities; numeric character references (uiautomator
 *  writes a newline in a multi-line field as `&#10;`) stayed raw in labels. */
function decodeCharRefs(s: string): string {
  if (!s.includes('&#')) return s;
  return s.replace(/&#(x[0-9a-f]+|\d+);/gi, (m, c: string) => {
    const cp = c[0] === 'x' || c[0] === 'X' ? parseInt(c.slice(1), 16) : parseInt(c, 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

function toRaw(n: Record<string, unknown>): RawNode {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === 'node') continue;
    attrs[k] = String(v ?? '');
  }
  const kids = n.node;
  return {
    cls: String(n['class'] ?? ''),
    text: decodeCharRefs(String(n['text'] ?? '')).trim(),
    desc: decodeCharRefs(String(n['content-desc'] ?? '')).trim(),
    id: String(n['resource-id'] ?? '').trim(),
    bounds: parseBounds(String(n['bounds'] ?? '')),
    clickable: bool(n['clickable']),
    longClickable: bool(n['long-clickable']),
    scrollable: bool(n['scrollable']),
    focusable: bool(n['focusable']),
    focused: bool(n['focused']),
    enabled: bool(n['enabled']),
    isLeaf: !Array.isArray(kids) || kids.length === 0,
    attrs,
    dfs: 0, // set during walk
    subtreeEnd: 0,
    drawingOrder: n['drawing-order'] != null ? Number(n['drawing-order']) : -1,
  };
}

/** Does a node's bounds contain a point? */
export function boundsContain(b: [number, number, number, number], x: number, y: number): boolean {
  return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
}

function role(n: RawNode): string {
  if (isTextFieldClass(n.cls)) return 'text-field';
  if (n.scrollable) return 'scrollable';
  if (n.clickable || n.longClickable) return 'button';
  if (/ImageView/.test(n.cls)) return 'image';
  if (n.text || /TextView/.test(n.cls)) return 'text';
  return n.cls.split('.').pop() || 'node';
}

function isSurfaced(n: RawNode): boolean {
  // A text field is always surfaced. An iOS SearchField has child nodes (magnifier, clear
  // button) and must not be dropped for not being a leaf.
  if (n.clickable || n.longClickable || n.scrollable || isTextFieldClass(n.cls)) return true;
  return n.isLeaf && (n.text.length > 0 || n.desc.length > 0);
}

/** False for nodes the user cannot see: uiautomator reports rows clipped off a scrolled list with
 * empty or inverted bounds (e.g. `[210,315][646,247]`), and some nodes lie wholly off-screen.
 * Surfacing them lets untilVisible "find" off-screen rows and taps land on the list edge. */
function isOnScreen(b: [number, number, number, number], screen: [number, number]): boolean {
  const [x1, y1, x2, y2] = b;
  if (x1 === 0 && y1 === 0 && x2 === 0 && y2 === 0) return true; // no bounds attribute: unknown, keep
  if (x2 <= x1 || y2 <= y1) return false;
  if (screen[0] <= 0 || screen[1] <= 0) return true; // screen size unknown, keep the node
  return x2 > 0 && y2 > 0 && x1 < screen[0] && y1 < screen[1];
}

function shortId(id: string): string {
  const i = id.indexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

function computeQuality(all: RawNode[], screen: [number, number]): SnapshotQuality {
  const nodeCount = all.length;
  const clickables = all.filter((n) => n.clickable || n.longClickable);
  const clickableCount = clickables.length;
  // A clickable row labeled by a child text view counts as labeled (same rule as weakTreeHint).
  const unidentified = clickables.filter((n) => !subtreeLabel(n, all)).length;
  const withId = clickables.filter((n) => n.id).length;
  const unidentifiedClickableRatio = clickableCount ? unidentified / clickableCount : 0;
  const idCoverage = clickableCount ? withId / clickableCount : 1;

  const screenArea = Math.max(1, screen[0] * screen[1]);
  let webviewDominance = 0;
  let opaqueWebview = false;
  for (const n of all) {
    if (!WEBVIEW_RE.test(n.cls)) continue;
    const area = Math.max(0, n.bounds[2] - n.bounds[0]) * Math.max(0, n.bounds[3] - n.bounds[1]);
    const dom = area / screenArea;
    if (dom > webviewDominance) {
      webviewDominance = dom;
      // semantic descendants = surfaced nodes whose bounds sit inside this node
      const kids = all.filter(
        (o) =>
          o !== n &&
          o.bounds[0] >= n.bounds[0] &&
          o.bounds[1] >= n.bounds[1] &&
          o.bounds[2] <= n.bounds[2] &&
          o.bounds[3] <= n.bounds[3] &&
          (o.text || o.desc || o.id),
      ).length;
      opaqueWebview = dom > 0.6 && kids < 3;
    }
  }

  const composeNodes = all.filter((n) => COMPOSE_RE.test(n.cls)).length;
  const composeNoTestTag = composeNodes > 0 && idCoverage < 0.1;

  const reasons: string[] = [];
  let verdict: SnapshotQuality['verdict'] = 'partial';

  if (nodeCount < 5 || opaqueWebview || unidentifiedClickableRatio > 0.6 || (composeNoTestTag && idCoverage < 0.1)) {
    verdict = 'poor';
    if (nodeCount < 5) reasons.push(`only ${nodeCount} nodes (likely splash/canvas/not-rendered)`);
    if (opaqueWebview)
      reasons.push(`a single WebView/SurfaceView covers ${(webviewDominance * 100) | 0}% of screen with no semantic children`);
    if (unidentifiedClickableRatio > 0.6)
      reasons.push(`${(unidentifiedClickableRatio * 100) | 0}% of clickable nodes have no id/label/text`);
    if (composeNoTestTag) reasons.push('Compose UI without testTagsAsResourceId (no stable ids)');
  } else if (nodeCount >= 15 && unidentifiedClickableRatio < 0.2 && idCoverage > 0.5 && webviewDominance < 0.4) {
    verdict = 'good';
    reasons.push('rich tree with good id coverage');
  } else {
    reasons.push(`partial: idCoverage=${idCoverage.toFixed(2)}, unidentifiedClickable=${unidentifiedClickableRatio.toFixed(2)}`);
  }

  return {
    verdict,
    reasons,
    signals: {
      nodeCount,
      clickableCount,
      unidentifiedClickableRatio: Number(unidentifiedClickableRatio.toFixed(3)),
      idCoverage: Number(idCoverage.toFixed(3)),
      webviewDominance: Number(webviewDominance.toFixed(3)),
      composeNoTestTag,
    },
  };
}

/** The element a surfaced node becomes under `ref`. */
export function toElement(ref: string, n: RawNode): SnapshotElement {
  return {
    ref,
    role: role(n),
    // A clickable row without its own text/desc is named by its child title (childLabel).
    label: n.desc || (!n.text && n.childLabel) || undefined,
    id: n.id ? shortId(n.id) : undefined,
    text: n.text || undefined,
    bounds: n.bounds,
    clickable: n.clickable || n.longClickable,
    focused: n.focused || undefined,
    secure: isSecureNode(n) || undefined,
  };
}

/** opts.screen: the display size, when the caller knows it. The dump root is used otherwise, which is
 * wrong when a dialog window is the root. */
export function parseSnapshot(xml: string, opts: { interactiveOnly?: boolean; screen?: [number, number] } = {}): ParsedSnapshot {
  const interactiveOnly = opts.interactiveOnly ?? true;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => name === 'node',
  });
  const doc = parser.parse(xml);
  const hierarchy = doc?.hierarchy ?? {};
  const roots = Array.isArray(hierarchy.node) ? hierarchy.node : hierarchy.node ? [hierarchy.node] : [];

  const all: RawNode[] = [];
  let counter = 0;
  const walk = (n: Record<string, unknown>, parentKey: string, seen: Map<string, number>) => {
    const raw = toRaw(n);
    raw.dfs = counter++;
    const own = `${raw.cls}|${raw.id}|${isTextFieldClass(raw.cls) ? '' : raw.text}|${raw.desc}`;
    const ordinal = seen.get(own) ?? 0;
    seen.set(own, ordinal + 1);
    raw.key = createHash('sha1').update(`${parentKey}>${own}#${ordinal}`).digest('hex').slice(0, 16);
    all.push(raw);
    const kids = n.node;
    const kidSeen = new Map<string, number>();
    if (Array.isArray(kids)) for (const k of kids) walk(k as Record<string, unknown>, raw.key, kidSeen);
    raw.subtreeEnd = counter - 1; // last dfs assigned within this subtree
  };
  const rootSeen = new Map<string, number>();
  for (const r of roots) walk(r as Record<string, unknown>, '', rootSeen);

  const screen: [number, number] =
    opts.screen && opts.screen[0] > 0 && opts.screen[1] > 0 ? opts.screen : all.length ? [all[0].bounds[2], all[0].bounds[3]] : [0, 0];

  const elements: SnapshotElement[] = [];
  const fullByRef = new Map<string, RawNode>();
  const kept: RawNode[] = [];
  let i = 0;
  for (const n of all) {
    if (interactiveOnly && !isSurfaced(n)) continue;
    if (!interactiveOnly && !isSurfaced(n)) continue;
    if (!isOnScreen(n.bounds, screen)) continue;
    if (redundantNode(n, all, kept, screen)) continue;
    kept.push(n);
    const ref = `@e${++i}`;
    n.label = subtreeLabel(n, all);
    if ((n.clickable || n.longClickable) && !n.text && !n.desc && !isTextFieldClass(n.cls)) {
      const child = childText(n, all);
      if (child) n.childLabel = child;
    }
    fullByRef.set(ref, n);
    elements.push(toElement(ref, n));
  }

  return { elements, fullByRef, allNodes: all, quality: computeQuality(all, screen), screen, total: all.length };
}

/** A hint for a weak tree (most clickables unlabeled, a WebView/canvas covering the screen, or
 *  fewer than 3 elements): the tree alone may not show what is on screen. */
export function weakTreeHint(parsed: Pick<ParsedSnapshot, 'elements' | 'quality'> & { allNodes?: RawNode[] }): string | undefined {
  const s = parsed.quality.signals;
  const unlabeled = parsed.allNodes ? unlabeledClickableRatio(parsed.allNodes) : s.unidentifiedClickableRatio;
  const why =
    parsed.elements.length < 3
      ? `only ${parsed.elements.length} element(s)`
      : s.webviewDominance >= 0.6
        ? 'a WebView/canvas covers most of the screen'
        : s.clickableCount > 0 && unlabeled > 0.5
          ? `${Math.round(unlabeled * 100)}% of clickable nodes have no text/label/id`
          : undefined;
  return why ? `Weak UI tree (${why}): use qa_screenshot or qa_visual to see the screen; tap by coordinates if needed.` : undefined;
}

/** Share of clickable nodes whose whole subtree carries no text/desc/id. A clickable row whose label
 *  sits in a child TextView (the usual Android list row) counts as labeled. `all` is in dfs order. */
function unlabeledClickableRatio(all: RawNode[]): number {
  const clickables = all.filter((n) => n.clickable || n.longClickable);
  if (!clickables.length) return 0;
  return clickables.filter((n) => !subtreeLabel(n, all)).length / clickables.length;
}

/** What labels a node: the first text / desc in its subtree (the node itself first), else the
 *  first resource-id there, '' when there is none. `all` is the dfs-ordered tree the node came from. */
export function subtreeLabel(n: RawNode, all: RawNode[]): string {
  if (all[n.dfs] !== n) return n.text || n.desc || n.id;
  let id = '';
  for (let i = n.dfs; i <= n.subtreeEnd && i < all.length; i++) {
    const v = all[i].text || all[i].desc;
    if (v) return v;
    id ||= all[i].id;
  }
  return id;
}

/** The first text / desc below a node (never an id), '' when there is none. A nested clickable
 *  element is its own target, so its subtree never names the outer one; a field's value never does. */
function childText(n: RawNode, all: RawNode[]): string {
  if (all[n.dfs] !== n) return '';
  for (let i = n.dfs + 1; i <= n.subtreeEnd && i < all.length; i++) {
    if (all[i].clickable || all[i].longClickable || isTextFieldClass(all[i].cls) || isSecureNode(all[i])) {
      i = all[i].subtreeEnd;
      continue;
    }
    const v = all[i].text || all[i].desc;
    if (v) return v;
  }
  return '';
}

/** Every side within `tol` px. */
function nearBounds(a: [number, number, number, number], b: [number, number, number, number], tol: number): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

/**
 * A surfaced node that would only repeat an element already listed (an iOS table row came
 * out as 4-5 elements and the cap hid real targets). Dropped from the element list only; allNodes
 * (overlay / obstruction analysis) keeps it.
 *  - an exact duplicate of a listed node, ancestor or not (same role, text, desc, id and bounds; iOS
 *    lists e.g. the Dictate button twice, as siblings);
 *  - non-clickable text that repeats the name of the listed clickable element it sits in;
 *  - an unlabeled, id-less clickable container around a clickable element with (nearly) its bounds
 *    (the inner element is the same tap target and carries the name).
 * `kept` holds the nodes listed so far (dfs order).
 */
function redundantNode(n: RawNode, all: RawNode[], kept: RawNode[], screen: [number, number]): boolean {
  if (isTextFieldClass(n.cls)) return false;
  // Nested unnamed scrollables with the same bounds (iOS web views stack 4 full-screen ones) are
  // one scroll area: keep the outer one.
  if (n.scrollable)
    return (
      !n.text &&
      !n.desc &&
      !n.id &&
      kept.some((a) => a.scrollable && a.dfs < n.dfs && a.subtreeEnd >= n.dfs && nearBounds(a.bounds, n.bounds, 0))
    );
  const clickable = n.clickable || n.longClickable;
  const ancestors = kept.filter((a) => a.dfs < n.dfs && a.subtreeEnd >= n.dfs);
  if (kept.some((a) => a.text === n.text && a.desc === n.desc && a.id === n.id && role(a) === role(n) && nearBounds(a.bounds, n.bounds, 0)))
    return true;
  const name = n.text || n.desc;
  if (!clickable && n.isLeaf && name) {
    const owner = [...ancestors].reverse().find((a) => a.clickable || a.longClickable);
    if (owner && !isTextFieldClass(owner.cls) && (owner.desc === name || owner.text === name || owner.childLabel === name)) return true;
  }
  if (clickable && !n.text && !n.desc && !n.id && all[n.dfs] === n) {
    for (let i = n.dfs + 1; i <= n.subtreeEnd && i < all.length; i++) {
      const m = all[i];
      if ((m.clickable || m.longClickable) && nearBounds(m.bounds, n.bounds, 8) && isOnScreen(m.bounds, screen)) return true;
    }
  }
  return false;
}

/** Stable identity for diffing across snapshots (ignores minor bounds shifts). */
export function signature(el: SnapshotElement): string {
  return `${el.role}|${el.label ?? ''}|${el.id ?? ''}|${el.text ?? ''}`;
}

/** Longest label / text an element line carries; longer values are cut with "...". Applied after
 * redaction, so a cut can never split a secret out of the redactor's reach. */
export const ELEMENT_LINE_MAX_LABEL_CHARS = 80;

/** JSON-quoted (escapes quotes, backslashes, newlines, control chars) and capped by code point. */
function quoteCapped(s: string): string {
  if (s.length > ELEMENT_LINE_MAX_LABEL_CHARS) {
    const cps = [...s];
    if (cps.length > ELEMENT_LINE_MAX_LABEL_CHARS) s = `${cps.slice(0, ELEMENT_LINE_MAX_LABEL_CHARS).join('')}...`;
  }
  return JSON.stringify(s);
}

/** Ids are emitted bare when they are a plain token, else quoted (iOS accessibility ids can hold spaces). */
const BARE_ID = /^[\w.:/-]+$/;

/**
 * One element as a single line, the form both channels carry (structuredContent `elements` outside
 * verbose mode, and the text block):
 *
 *   @e3 [button] "Log in" #login_btn text="Sign in" [40,200][1040,245] (focused,secure) -
 *
 * ref, [role], the name (label, else text; left out when neither), #id when present, text="..."
 * only when it differs from the label, bounds as [x1,y1][x2,y2] (left out when unknown), flags in
 * parentheses when any apply, then a trailing " -" when the element is not clickable. Pass the elements through presentElements first: it masks secure
 * values and scrubs known secrets; this function only formats.
 */
export function renderElementLine(e: SnapshotElement): string {
  const name = e.label ?? e.text ?? '';
  const parts = [`${e.ref} [${e.role}]`];
  if (name) parts.push(quoteCapped(name));
  if (e.id) parts.push(`#${BARE_ID.test(e.id) ? e.id : JSON.stringify(e.id)}`);
  if (e.label !== undefined && e.text !== undefined && e.text !== e.label) parts.push(`text=${quoteCapped(e.text)}`);
  const b = e.bounds;
  if (b && (b[0] || b[1] || b[2] || b[3])) parts.push(`[${b[0]},${b[1]}][${b[2]},${b[3]}]`);
  const flags = [e.focused ? 'focused' : '', e.secure ? 'secure' : ''].filter(Boolean);
  if (flags.length) parts.push(`(${flags.join(',')})`);
  if (!e.clickable) parts.push('-');
  return parts.join(' ');
}

/** One element line decoded back into fields (the inverse of renderElementLine). */
export interface DecodedElementLine {
  ref: string;
  role: string;
  /** The rendered name: the label, else the text ("" when the line carries none). */
  name: string;
  id?: string;
  /** Only present when the line carries text="..." (text differing from the label). */
  text?: string;
  bounds?: [number, number, number, number];
  clickable: boolean;
  focused: boolean;
  secure: boolean;
}

const Q = '"(?:[^"\\\\]|\\\\.)*"';
const ELEMENT_LINE_RE = new RegExp(
  `^(@e\\d+) \\[([^\\]]*)\\](?: (${Q}))?(?: #(${Q}|\\S+))?(?: text=(${Q}))?(?: \\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\])?(?: \\(([^)]*)\\))?( -)?$`,
);

/** Decode a renderElementLine string; undefined when it is not one. For clients and tests that
 * want fields back without asking for responseMode "verbose". */
export function parseElementLine(line: string): DecodedElementLine | undefined {
  const m = ELEMENT_LINE_RE.exec(line);
  if (!m) return undefined;
  const flags = new Set((m[10] ?? '').split(',').filter(Boolean));
  const id = m[4] === undefined ? undefined : m[4].startsWith('"') ? (JSON.parse(m[4]) as string) : m[4];
  return {
    ref: m[1],
    role: m[2],
    name: m[3] === undefined ? '' : (JSON.parse(m[3]) as string),
    ...(id !== undefined ? { id } : {}),
    ...(m[5] !== undefined ? { text: JSON.parse(m[5]) as string } : {}),
    ...(m[6] !== undefined ? { bounds: [Number(m[6]), Number(m[7]), Number(m[8]), Number(m[9])] as [number, number, number, number] } : {}),
    clickable: m[11] === undefined && !flags.has('non-clickable'),
    focused: flags.has('focused'),
    secure: flags.has('secure'),
  };
}
