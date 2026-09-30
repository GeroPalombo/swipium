// Shared gesture geometry (SWIP-02/SWIP-08): swipe/scroll vectors are derived from the real
// screen size and clamped on-screen; legacy fixed coordinates survive only as the fallback
// for screenSize()===null; a supplied start point is used verbatim (0 is legitimate).

import { describe, expect, it } from 'vitest';
import { AREA_ANCHOR, FALLBACK_SWIPE, GESTURE_EDGE_INSET, swipeFromPoint, swipeVector } from '../src/lib/gestures.js';

const DIRS = ['up', 'down', 'left', 'right'] as const;
// Android px sizes plus an iOS points size (393×852) — WDA coordinates are points.
const SIZES = [
  { width: 720, height: 1280 },
  { width: 1080, height: 2400 },
  { width: 1440, height: 3120 },
  { width: 393, height: 852 },
];

function expectWithin(vec: [number, number, number, number], size: { width: number; height: number }, insetFrac: number): void {
  const insetX = Math.max(1, Math.round(size.width * insetFrac));
  const insetY = Math.max(1, Math.round(size.height * insetFrac));
  for (const x of [vec[0], vec[2]]) {
    expect(x).toBeGreaterThanOrEqual(insetX);
    expect(x).toBeLessThanOrEqual(size.width - insetX);
  }
  for (const y of [vec[1], vec[3]]) {
    expect(y).toBeGreaterThanOrEqual(insetY);
    expect(y).toBeLessThanOrEqual(size.height - insetY);
  }
}

describe('swipeVector (shared by qa_act and the flow runner)', () => {
  it('keeps swipe endpoints within the inset frame for all sizes and directions', () => {
    for (const size of SIZES) {
      for (const dir of DIRS) {
        // qa_act swipe geometry (distance 0.5) and scroll geometry (distance 0.6)
        expectWithin(swipeVector(size, dir, 'center', 0.5, GESTURE_EDGE_INSET), size, GESTURE_EDGE_INSET);
        expectWithin(swipeVector(size, dir, 'center', 0.6, GESTURE_EDGE_INSET), size, GESTURE_EDGE_INSET);
        // an oversized distance must clamp, never leave the frame
        expectWithin(swipeVector(size, dir, 'center', 1.5, GESTURE_EDGE_INSET), size, GESTURE_EDGE_INSET);
      }
    }
  });

  it('preserves the flow runner contract: default inset clamps to [1, size-1]', () => {
    const size = { width: 1080, height: 2400 };
    const v = swipeVector(size, 'up', 'center', 1.5); // forces clamping on both ends
    expect(v).toEqual([540, 2399, 540, 1]);
  });

  it('is deterministic and direction-correct (finger moves opposite the reveal)', () => {
    const v = swipeVector({ width: 1080, height: 1920 }, 'up', 'center', 0.5, GESTURE_EDGE_INSET);
    expect(v).toEqual([540, 1440, 540, 480]); // starts below center, ends above
  });

  it('anchors by area fractions', () => {
    const size = { width: 1000, height: 2000 };
    const [ax, ay] = AREA_ANCHOR.bottom;
    const v = swipeVector(size, 'left', 'bottom', 0.4);
    expect(v[1]).toBe(Math.round(size.height * ay));
    expect(v[0]).toBe(Math.round(size.width * ax + (size.width * 0.4) / 2));
  });

  it('falls back to the legacy fixed vectors when the screen size is unknown', () => {
    for (const dir of DIRS) {
      expect(swipeVector(null, dir)).toEqual(FALLBACK_SWIPE[dir]);
      expect(swipeVector(null, dir, 'center', 0.5, GESTURE_EDGE_INSET)).toEqual(FALLBACK_SWIPE[dir]);
    }
  });
});

describe('swipeFromPoint (qa_act swipe with a resolved target)', () => {
  it('uses the supplied start point verbatim — including 0 coordinates (SWIP-08)', () => {
    const size = { width: 1080, height: 1920 };
    const v = swipeFromPoint(size, { x: 0, y: 500 }, 'down', 0.5, GESTURE_EDGE_INSET);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(500);
    // …while the derived end point is clamped inside the inset frame
    const insetX = Math.round(size.width * GESTURE_EDGE_INSET);
    expect(v[2]).toBe(insetX);
    expect(v[3]).toBe(500 + 1920 * 0.5);
  });

  it('clamps the end point for every direction', () => {
    for (const size of SIZES) {
      for (const dir of DIRS) {
        const v = swipeFromPoint(size, { x: size.width - 2, y: size.height - 2 }, dir, 0.9, GESTURE_EDGE_INSET);
        const insetX = Math.max(1, Math.round(size.width * GESTURE_EDGE_INSET));
        const insetY = Math.max(1, Math.round(size.height * GESTURE_EDGE_INSET));
        expect(v[2]).toBeGreaterThanOrEqual(insetX);
        expect(v[2]).toBeLessThanOrEqual(size.width - insetX);
        expect(v[3]).toBeGreaterThanOrEqual(insetY);
        expect(v[3]).toBeLessThanOrEqual(size.height - insetY);
      }
    }
  });

  it('uses the legacy 800px travel when the screen size is unknown', () => {
    expect(swipeFromPoint(null, { x: 540, y: 1200 }, 'up')).toEqual([540, 1200, 540, 400]);
    expect(swipeFromPoint(null, { x: 0, y: 500 }, 'down')).toEqual([0, 500, 0, 1300]);
  });
});
