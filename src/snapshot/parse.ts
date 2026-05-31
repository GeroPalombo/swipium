// Parse a uiautomator dump into @eN-referenced elements + a snapshotQuality verdict.
// (DESIGN §4, §11.) The dump is the Android accessibility tree, so quality is a property
// of the target app — we measure it rather than pretend a weak tree is strong.

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

function bool(v: unknown): boolean {
  return v === 'true' || v === true;
}

function parseBounds(s: string): [number, number, number, number] {
  const m = typeof s === 'string' ? s.match(BOUNDS_RE) : null;
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
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
    text: String(n['text'] ?? '').trim(),
    desc: String(n['content-desc'] ?? '').trim(),
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
  if (/EditText/.test(n.cls)) return 'text-field';
  if (n.scrollable) return 'scrollable';
  if (n.clickable || n.longClickable) return 'button';
  if (/ImageView/.test(n.cls)) return 'image';
  if (n.text || /TextView/.test(n.cls)) return 'text';
  return n.cls.split('.').pop() || 'node';
}

function isSurfaced(n: RawNode): boolean {
  if (n.clickable || n.longClickable || n.scrollable || /EditText/.test(n.cls)) return true;
  return n.isLeaf && (n.text.length > 0 || n.desc.length > 0);
}

function shortId(id: string): string {
  const i = id.indexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

function computeQuality(all: RawNode[], screen: [number, number]): SnapshotQuality {
  const nodeCount = all.length;
  const clickables = all.filter((n) => n.clickable || n.longClickable);
  const clickableCount = clickables.length;
  const unidentified = clickables.filter((n) => !n.id && !n.desc && !n.text).length;
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

  if (
    nodeCount < 5 ||
    opaqueWebview ||
    unidentifiedClickableRatio > 0.6 ||
    (composeNoTestTag && idCoverage < 0.1)
  ) {
    verdict = 'poor';
    if (nodeCount < 5) reasons.push(`only ${nodeCount} nodes (likely splash/canvas/not-rendered)`);
    if (opaqueWebview) reasons.push(`a single WebView/SurfaceView covers ${(webviewDominance * 100) | 0}% of screen with no semantic children`);
    if (unidentifiedClickableRatio > 0.6)
      reasons.push(`${(unidentifiedClickableRatio * 100) | 0}% of clickable nodes have no id/label/text`);
    if (composeNoTestTag) reasons.push('Compose UI without testTagsAsResourceId (no stable ids)');
  } else if (
    nodeCount >= 15 &&
    unidentifiedClickableRatio < 0.2 &&
    idCoverage > 0.5 &&
    webviewDominance < 0.4
  ) {
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

export function parseSnapshot(xml: string, opts: { interactiveOnly?: boolean } = {}): ParsedSnapshot {
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
  const walk = (n: Record<string, unknown>) => {
    const raw = toRaw(n);
    raw.dfs = counter++;
    all.push(raw);
    const kids = n.node;
    if (Array.isArray(kids)) for (const k of kids) walk(k as Record<string, unknown>);
    raw.subtreeEnd = counter - 1; // last dfs assigned within this subtree
  };
  for (const r of roots) walk(r as Record<string, unknown>);

  const screen: [number, number] = all.length ? [all[0].bounds[2], all[0].bounds[3]] : [0, 0];

  const elements: SnapshotElement[] = [];
  const fullByRef = new Map<string, RawNode>();
  let i = 0;
  for (const n of all) {
    if (interactiveOnly && !isSurfaced(n)) continue;
    if (!interactiveOnly && !isSurfaced(n)) continue;
    const ref = `@e${++i}`;
    fullByRef.set(ref, n);
    elements.push({
      ref,
      role: role(n),
      label: n.desc || undefined,
      id: n.id ? shortId(n.id) : undefined,
      text: n.text || undefined,
      bounds: n.bounds,
      clickable: n.clickable || n.longClickable,
      focused: n.focused || undefined,
      secure: isSecureNode(n) || undefined,
    });
  }

  return { elements, fullByRef, allNodes: all, quality: computeQuality(all, screen), screen, total: all.length };
}

/** Stable identity for diffing across snapshots (ignores minor bounds shifts). */
export function signature(el: SnapshotElement): string {
  return `${el.role}|${el.label ?? ''}|${el.id ?? ''}|${el.text ?? ''}`;
}

/** Compact, token-cheap render of the element list for the model. */
export function renderElements(elements: SnapshotElement[]): string {
  return elements
    .map((e) => {
      const name = e.label ?? e.text ?? '';
      const id = e.id ? `  #${e.id}` : '';
      const flags = [e.focused ? 'focused' : '', e.clickable ? '' : 'non-clickable'].filter(Boolean).join(',');
      return `${e.ref} [${e.role}] ${JSON.stringify(name)}${id}${flags ? `  (${flags})` : ''}`;
    })
    .join('\n');
}
