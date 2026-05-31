// Overlay detection + tap-obstruction analysis (Phase 2 CR4). Works from a single-window
// uiautomator dump (allNodes, DFS-ordered). Toasts are NOT in the dump (separate windows);
// keyboard + foreground-owner are detected by the caller via the driver and merged in.

import { boundsContain, type RawNode } from './parse.js';

export type OverlayType =
  | 'rn_logbox'
  | 'rn_redbox'
  | 'native_dialog'
  | 'snackbar'
  | 'banner'
  | 'toast'
  | 'keyboard'
  | 'permission_dialog'
  | 'account_picker'
  | 'foreign_app'
  | 'unknown';

export interface Overlay {
  type: OverlayType;
  detail: string;
  bounds?: [number, number, number, number];
  dismissible?: boolean; // best-effort: does it carry a close/dismiss affordance?
}

const LOGBOX_RE = /open debugger|view warnings|LogBox|\b\d+ (warning|error)s?\b/i;
const REDBOX_RE = /unhandled (js|javascript) exception|render error|reload\b.*\bdismiss/i;

/** Overlays visible in the current window's UI tree (not toasts/IME/foreign — see callers). */
const DISMISS_RE = /close|dismiss|got it|ok\b|minimize|×|✕|✖/i;

/**
 * Heuristic detector for persistent in-app debug banners / snackbars / toast-like RN views
 * (RevenueCat debug banner, custom error toasts, etc.) that the id/class detectors miss.
 * A banner is a wide, short, edge-pinned content block that is NOT the full screen.
 */
function detectBanners(allNodes: RawNode[], screen?: [number, number]): Overlay[] {
  if (!screen) return [];
  const [sw, sh] = screen;
  if (!sw || !sh) return [];
  const out: Overlay[] = [];
  for (const n of allNodes) {
    const [x1, y1, x2, y2] = n.bounds;
    const w = x2 - x1;
    const h = y2 - y1;
    if (!(n.text || n.desc) || w <= 0 || h <= 0) continue;
    const wideEnough = w >= sw * 0.6;
    const shortEnough = h <= sh * 0.22 && h >= sh * 0.02;
    const atTop = y1 <= sh * 0.16;
    const atBottom = y2 >= sh * 0.82;
    const fullScreen = h >= sh * 0.85;
    if (!wideEnough || !shortEnough || fullScreen || (!atTop && !atBottom)) continue;
    const sub = allNodes.filter((m) => m.dfs >= n.dfs && m.dfs <= n.subtreeEnd);
    const dismissible = sub.some((m) => (m.clickable || m.cls.includes('Button')) && DISMISS_RE.test(`${m.text} ${m.desc}`));
    const label = (n.text || n.desc).trim().slice(0, 60);
    out.push({ type: atBottom ? 'snackbar' : 'banner', detail: `${atBottom ? 'bottom snackbar/banner' : 'top banner'}: "${label}"`, bounds: n.bounds, dismissible });
  }
  const dedupe = (band: OverlayType) => {
    const inBand = out.filter((o) => o.type === band);
    return inBand.length ? [inBand[inBand.length - 1]] : [];
  };
  return [...dedupe('banner'), ...dedupe('snackbar')];
}

export function detectTreeOverlays(allNodes: RawNode[], screen?: [number, number]): Overlay[] {
  const out: Overlay[] = [];
  const text = (n: RawNode) => `${n.text} ${n.desc}`;
  const joined = allNodes.map(text).join('  ');

  if (REDBOX_RE.test(joined)) {
    out.push({ type: 'rn_redbox', detail: 'React Native redbox (fatal JS error) overlay' });
  } else if (LOGBOX_RE.test(joined)) {
    const node = allNodes.find((n) => LOGBOX_RE.test(text(n)));
    out.push({ type: 'rn_logbox', detail: 'React Native LogBox warning/error overlay', bounds: node?.bounds });
  }

  // Native AlertDialog (incl. the standard button ids).
  const dlg = allNodes.find((n) => /AlertDialog|android:id\/(button1|alertTitle)/.test(`${n.cls} ${n.id}`));
  if (dlg) out.push({ type: 'native_dialog', detail: `native dialog (${dlg.cls.split('.').pop()})`, bounds: dlg.bounds });

  // Material Snackbar (in-tree, by id).
  const snack = allNodes.find((n) => /snackbar_text|snackbar_action/.test(n.id));
  if (snack) out.push({ type: 'snackbar', detail: 'Material snackbar', bounds: snack.bounds });

  // Heuristic banners/snackbars the id/class checks miss (RN debug banners etc.), de-duped
  // against the explicit detections above.
  const haveSnack = out.some((o) => o.type === 'snackbar');
  const haveRn = out.some((o) => o.type === 'rn_logbox' || o.type === 'rn_redbox');
  for (const b of detectBanners(allNodes, screen)) {
    if (b.type === 'snackbar' && haveSnack) continue;
    if (b.type === 'banner' && haveRn) continue; // likely the LogBox banner already reported
    out.push(b);
  }

  return out;
}

const UNABLE_TO_LOAD_RE = /unable to load script|loadJSBundleFromAssets|index\.android\.bundle|could not connect to development server/i;

/** Detect the RN red-box and whether it's the fatal "unable to load JS bundle" variant. */
export function detectRedBox(allNodes: RawNode[]): { present: boolean; unableToLoadScript: boolean } {
  const joined = allNodes.map((n) => `${n.text} ${n.desc}`).join('  ');
  const present = REDBOX_RE.test(joined) || UNABLE_TO_LOAD_RE.test(joined);
  return { present, unableToLoadScript: UNABLE_TO_LOAD_RE.test(joined) };
}

/** Classify the foreground owner string into an overlay class (system/foreign surfaces). */
export function classifyForeground(appId: string | undefined, foreground: string): Overlay | null {
  if (appId && foreground.startsWith(appId)) return null;
  if (/permissioncontroller/i.test(foreground)) return { type: 'permission_dialog', detail: foreground };
  if (/accountpicker|account\.|gms/i.test(foreground)) return { type: 'account_picker', detail: foreground };
  if (/launcher/i.test(foreground)) return null; // not an overlay — handled by health
  if (/inputmethod/i.test(foreground)) return { type: 'keyboard', detail: foreground };
  if (foreground && foreground !== 'unknown') return { type: 'foreign_app', detail: foreground };
  return null;
}

export interface Obstruction {
  obstructed: boolean;
  by?: { cls: string; id?: string; text?: string; bounds: [number, number, number, number] };
}

/**
 * Is the point (x,y) — typically the center of the intended target — covered by content
 * drawn ON TOP of the target's subtree? Topmost = greatest DFS index among nodes containing
 * the point; an obstruction is a topmost node OUTSIDE the target's subtree that carries
 * visible content (text/desc/clickable or a known overlay class).
 */
export function obstructionAt(allNodes: RawNode[], target: RawNode | undefined, x: number, y: number): Obstruction {
  const containing = allNodes.filter((n) => boundsContain(n.bounds, x, y));
  if (containing.length === 0) return { obstructed: false };
  // Topmost = greatest DFS (pre-order) index among containing nodes. `drawing-order` is only
  // meaningful among SIBLINGS (per-parent); comparing it globally across unrelated branches
  // misclassifies, so we use DFS order as the safe global signal (later DFS = drawn later).
  const topmost = containing.reduce((a, b) => (b.dfs > a.dfs ? b : a));
  if (!target) {
    // no known target → only flag if the topmost is clearly an overlay-ish content node
    const looksOverlay = !!(topmost.text || topmost.desc) && topmost.isLeaf;
    return looksOverlay ? { obstructed: false } : { obstructed: false };
  }
  const withinTarget = topmost.dfs >= target.dfs && topmost.dfs <= target.subtreeEnd;
  const isAncestor = topmost.dfs <= target.dfs && topmost.subtreeEnd >= target.subtreeEnd;
  if (withinTarget || isAncestor) return { obstructed: false };
  // topmost is outside the target subtree and on top → only an obstruction if it's real content
  const realContent = !!(topmost.text || topmost.desc) || topmost.clickable;
  if (!realContent) return { obstructed: false };
  return {
    obstructed: true,
    by: { cls: topmost.cls, id: topmost.id || undefined, text: (topmost.text || topmost.desc) || undefined, bounds: topmost.bounds },
  };
}
