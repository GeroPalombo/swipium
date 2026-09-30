// Shared screen-relative gesture geometry. qa_act and the flow runner derive
// swipe/scroll vectors the SAME way: anchored as fractions of the real screen size and
// clamped on-screen, with fixed legacy coordinates ONLY as the fallback when the driver
// cannot report a size. WDA swipes are in POINTS (a modern iPhone is ≤~440pt wide), so any
// fixed pixel constant is off-screen there.

export type SwipeDirection = 'up' | 'down' | 'left' | 'right';
/** Structurally identical to flows/schema.ts SwipeArea (schema owns the YAML enum). */
export type SwipeArea = 'center' | 'top' | 'bottom' | 'left' | 'right';
export type SwipeVec = [number, number, number, number];

/** ~8% edge inset used by qa_act gestures — stays clear of the iOS system-gesture zones
 * (home indicator, notification/control-center edges). Flow replay keeps inset 0 so
 * existing recorded flows keep their historical [1, size-1] clamp. */
export const GESTURE_EDGE_INSET = 0.08;

/** Legacy fixed-coordinate vectors — used ONLY when screenSize() is unknown. */
export const FALLBACK_SWIPE: Record<SwipeDirection, SwipeVec> = {
  up: [540, 1500, 540, 600],
  down: [540, 600, 540, 1500],
  left: [800, 1100, 200, 1100],
  right: [200, 1100, 800, 1100],
};
export const AREA_ANCHOR: Record<SwipeArea, [number, number]> = {
  center: [0.5, 0.5],
  top: [0.5, 0.3],
  bottom: [0.5, 0.7],
  left: [0.3, 0.5],
  right: [0.7, 0.5],
};
/** Legacy swipe travel in px when the screen size is unknown (the old qa_act constant). */
const FALLBACK_DISTANCE = 800;

function clamper(size: { width: number; height: number }, insetFrac: number) {
  const insetX = Math.max(1, Math.round(size.width * insetFrac));
  const insetY = Math.max(1, Math.round(size.height * insetFrac));
  return {
    x: (x: number) => Math.max(insetX, Math.min(size.width - insetX, Math.round(x))),
    y: (y: number) => Math.max(insetY, Math.min(size.height - insetY, Math.round(y))),
  };
}

/** Device-relative swipe vector (fractions of the screen), falling back to fixed coords if no size.
 * insetFrac keeps every endpoint at least that fraction of the screen away from each edge;
 * the default 0 preserves the flow runner's historical [1, size-1] clamp. */
export function swipeVector(
  size: { width: number; height: number } | null,
  dir: SwipeDirection,
  area: SwipeArea = 'center',
  distance = 0.6,
  insetFrac = 0,
): SwipeVec {
  if (!size) return FALLBACK_SWIPE[dir];
  const [ax, ay] = AREA_ANCHOR[area];
  const cx = size.width * ax;
  const cy = size.height * ay;
  const vd = (size.height * distance) / 2;
  const hd = (size.width * distance) / 2;
  const clamp = clamper(size, insetFrac);
  const v = {
    up: [cx, cy + vd, cx, cy - vd],
    down: [cx, cy - vd, cx, cy + vd],
    left: [cx + hd, cy, cx - hd, cy],
    right: [cx - hd, cy, cx + hd, cy],
  }[dir];
  return [clamp.x(v[0]), clamp.y(v[1]), clamp.x(v[2]), clamp.y(v[3])];
}

/** Swipe starting at an explicit point (a resolved qa_act target). The start is used
 * VERBATIM — it is a real element the caller asked to swipe from, and 0 is a legitimate
 * coordinate — while the derived end point is clamped on-screen. */
export function swipeFromPoint(
  size: { width: number; height: number } | null,
  from: { x: number; y: number },
  dir: SwipeDirection,
  distance = 0.5,
  insetFrac = 0,
): SwipeVec {
  const dist = size ? (dir === 'up' || dir === 'down' ? size.height : size.width) * distance : FALLBACK_DISTANCE;
  const to = {
    up: { x: from.x, y: from.y - dist },
    down: { x: from.x, y: from.y + dist },
    left: { x: from.x - dist, y: from.y },
    right: { x: from.x + dist, y: from.y },
  }[dir];
  if (!size) return [from.x, from.y, Math.round(to.x), Math.round(to.y)];
  const clamp = clamper(size, insetFrac);
  return [from.x, from.y, clamp.x(to.x), clamp.y(to.y)];
}

export type GestureRect = [number, number, number, number];

/** Fraction of a scrollable container kept clear on each side when a scroll is anchored in it —
 * keeps the finger off sticky headers/footers that sit flush with the container's edges. */
export const SCROLL_CONTAINER_INSET = 0.1;

/** Minimum on-screen extent (px/pt) a scrollable container needs on each axis to anchor a swipe. */
const MIN_SCROLL_CONTAINER = 48;

/** PURE: the visible rect of the LARGEST scrollable node, or null when there is none worth using.
 * Android marks containers `scrollable="true"`; the WDA source normalizer maps
 * ScrollView/Table/CollectionView to the same attribute. A clipped Android node can report
 * inverted bounds (e.g. `[210,315][750,124]` — its visible area is empty): such nodes are
 * ignored, and every rect is clipped to the screen when the size is known. */
export function largestScrollableRect(
  nodes: ReadonlyArray<{ scrollable: boolean; bounds: readonly [number, number, number, number] }> | undefined,
  size: { width: number; height: number } | null,
): GestureRect | null {
  let best: GestureRect | null = null;
  let bestArea = 0;
  for (const n of nodes ?? []) {
    if (!n.scrollable) continue;
    let [x1, y1, x2, y2] = n.bounds;
    if (size) {
      x1 = Math.max(0, x1);
      y1 = Math.max(0, y1);
      x2 = Math.min(size.width, x2);
      y2 = Math.min(size.height, y2);
    }
    // inverted / collapsed after clipping → not visible, can't be a gesture anchor
    if (x2 - x1 < MIN_SCROLL_CONTAINER || y2 - y1 < MIN_SCROLL_CONTAINER) continue;
    const area = (x2 - x1) * (y2 - y1);
    if (area > bestArea) {
      bestArea = area;
      best = [x1, y1, x2, y2];
    }
  }
  return best;
}

/** Swipe vector anchored INSIDE a scrollable container: centered on the container, travel =
 * `distance` × the container's extent on the swipe axis, both endpoints kept `containerInset`
 * inside the container AND (when possible) `screenInset` inside the screen. A swipe that starts
 * on a sticky app bar above the list moves nothing — this is why the container matters. */
export function swipeInRect(
  rect: GestureRect,
  dir: SwipeDirection,
  size: { width: number; height: number } | null,
  distance = 0.6,
  containerInset = SCROLL_CONTAINER_INSET,
  screenInset = 0,
): SwipeVec {
  const [x1, y1, x2, y2] = rect;
  const w = x2 - x1;
  const h = y2 - y1;
  const cx = x1 + w / 2;
  const cy = y1 + h / 2;
  const axisRange = (lo: number, hi: number, extent: number, screen?: number): [number, number] => {
    const inset = Math.max(1, Math.round(extent * containerInset));
    let a = lo + inset;
    let b = hi - inset;
    if (screen != null && screenInset > 0) {
      const si = Math.max(1, Math.round(screen * screenInset));
      const sa = Math.max(a, si);
      const sb = Math.min(b, screen - si);
      if (sb > sa) [a, b] = [sa, sb]; // only when the two insets still leave room
    }
    return [a, b];
  };
  const [minX, maxX] = axisRange(x1, x2, w, size?.width);
  const [minY, maxY] = axisRange(y1, y2, h, size?.height);
  const cX = (x: number) => Math.round(Math.max(minX, Math.min(maxX, x)));
  const cY = (y: number) => Math.round(Math.max(minY, Math.min(maxY, y)));
  const vd = (h * distance) / 2;
  const hd = (w * distance) / 2;
  const v = {
    up: [cx, cy + vd, cx, cy - vd],
    down: [cx, cy - vd, cx, cy + vd],
    left: [cx + hd, cy, cx - hd, cy],
    right: [cx - hd, cy, cx + hd, cy],
  }[dir];
  return [cX(v[0]), cY(v[1]), cX(v[2]), cY(v[3])];
}
