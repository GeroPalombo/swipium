// Automation Kernel V2, Workstream 5: Gesture Engine V2. First-class mobile gestures (longPress,
// doubleTap, scrollUntilVisible, drag, pinch) modeled as backend-checked operations. Pinch is
// capability-gated and is NEVER silently converted to a swipe. The scrollUntilVisible loop is a pure,
// driver-agnostic executor so it can be unit-tested without a device and reused by the runner.

import type { BackendCapabilities } from './capabilities.js';
import type { GestureIR, GestureKind } from './types.js';

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
