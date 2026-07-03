// Automation Kernel V2 — Workstream 5: Gesture Engine V2. First-class mobile gestures (longPress,
// doubleTap, scrollUntilVisible, drag, pinch) modeled as backend-checked operations. Pinch is
// capability-gated and is NEVER silently converted to a swipe. The scrollUntilVisible loop is a pure,
// driver-agnostic executor so it can be unit-tested without a device and reused by the runner.

import type { BackendCapabilities } from './capabilities.js';
import type { GestureIR, GestureKind, SelectorIR } from './types.js';

export interface GestureSupport {
  supported: boolean;
  requiredCapability?: string;
  reason: string;
  /** A gesture the caller may NOT silently substitute (e.g. pinch must not become swipe). */
  noSilentFallback?: boolean;
}

function capabilityForGesture(kind: GestureKind): keyof BackendCapabilities | null {
  switch (kind) {
    case 'longPress':
      return 'longPress';
    case 'doubleTap':
      return 'doubleTap';
    case 'scroll':
      return 'scrollUntilVisible';
    case 'pinch':
      return 'pinch';
    case 'drag':
      return 'drag';
    case 'tap':
    case 'swipe':
      return null; // available on any backend that can tap/swipe by coordinate
    default:
      return null;
  }
}

export function gestureSupport(gesture: GestureIR, caps: BackendCapabilities): GestureSupport {
  const capKey = capabilityForGesture(gesture.kind);
  if (gesture.kind === 'pinch') {
    if (caps.pinch) return { supported: true, reason: `pinch is supported on ${caps.backend}.` };
    return {
      supported: false,
      requiredCapability: 'pinch',
      reason: `pinch is not supported on ${caps.backend}; attach Appium UiAutomator2/XCUITest or replace it with a swipe/scroll. It will not be silently converted to a swipe.`,
      noSilentFallback: true,
    };
  }
  if (capKey && !caps[capKey]) {
    return { supported: false, requiredCapability: String(capKey), reason: `${gesture.kind} is not supported on ${caps.backend}.` };
  }
  if ((gesture.kind === 'tap' || gesture.kind === 'swipe') && !caps.screenshot && !caps.structuredTree) {
    return {
      supported: false,
      requiredCapability: 'screenshot',
      reason: `${gesture.kind} needs at least coordinate/screenshot support on ${caps.backend}.`,
    };
  }
  return { supported: true, reason: `${gesture.kind} is supported on ${caps.backend}.` };
}

/** Build a longPress gesture: a same-point press for `durationMs`. */
export function longPressGesture(target: SelectorIR | undefined, durationMs = 800): GestureIR {
  return { kind: 'longPress', target, durationMs };
}

export function doubleTapGesture(target: SelectorIR | undefined): GestureIR {
  return { kind: 'doubleTap', target };
}

/** Build a scrollUntilVisible gesture with Maestro-parity options. */
export function scrollUntilVisibleGesture(
  target: SelectorIR,
  opts: { direction?: GestureIR['direction']; speed?: number; visibilityPercentage?: number; centerElement?: boolean } = {},
): GestureIR {
  return {
    kind: 'scroll',
    target,
    direction: opts.direction ?? 'down',
    speed: opts.speed,
    visibilityPercentage: opts.visibilityPercentage ?? 100,
    centerElement: opts.centerElement ?? false,
  };
}

export interface ScrollUntilVisibleOptions {
  direction: 'up' | 'down' | 'left' | 'right';
  maxScrolls?: number;
  /** Called before each visibility check; resolves to true once the target is visible enough. */
  isVisible: () => Promise<boolean> | boolean;
  /** Performs one scroll step in `direction`. */
  scrollOnce: () => Promise<void> | void;
  /** Captures the current screen signature for failure provenance. */
  screenSignature?: () => Promise<string | undefined> | string | undefined;
}

export interface ScrollUntilVisibleResult {
  visible: boolean;
  attempts: number;
  direction: 'up' | 'down' | 'left' | 'right';
  lastScreenSignature?: string;
  /** Provenance of the selector we were scrolling toward (set by callers for failure messages). */
  selector?: SelectorIR;
}

/**
 * Pure scrollUntilVisible executor. Checks visibility BEFORE scrolling (so it exits immediately if
 * already visible) and stops the moment the target appears. On timeout it returns the direction,
 * attempt count, and last screen signature so callers can build a diagnosable failure.
 */
export async function runScrollUntilVisible(opts: ScrollUntilVisibleOptions): Promise<ScrollUntilVisibleResult> {
  const max = Math.max(0, opts.maxScrolls ?? 20);
  let attempts = 0;
  const sig = async (): Promise<string | undefined> => (opts.screenSignature ? await opts.screenSignature() : undefined);

  if (await opts.isVisible()) {
    return { visible: true, attempts: 0, direction: opts.direction, lastScreenSignature: await sig() };
  }
  while (attempts < max) {
    await opts.scrollOnce();
    attempts += 1;
    if (await opts.isVisible()) {
      return { visible: true, attempts, direction: opts.direction, lastScreenSignature: await sig() };
    }
  }
  return { visible: false, attempts, direction: opts.direction, lastScreenSignature: await sig() };
}

/** Build a human/diagnostic failure detail for an exhausted scrollUntilVisible. */
export function scrollFailureDetail(result: ScrollUntilVisibleResult, selector?: SelectorIR): string {
  const target = selector ?? result.selector;
  const parts = [
    `scrollUntilVisible exhausted after ${result.attempts} scroll(s) ${result.direction}`,
    target ? `looking for ${target.strategy}=${target.value}` : undefined,
    result.lastScreenSignature ? `last screen signature ${result.lastScreenSignature}` : undefined,
    target?.hints?.screenSignature ? `selector was recorded on screen ${target.hints.screenSignature}` : undefined,
  ].filter(Boolean);
  return parts.join('; ') + '.';
}
