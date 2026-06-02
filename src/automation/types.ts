// Automation Kernel V2 — shared types (Developer 3 lane). A backend-neutral automation model that
// lets a Flow V2 file be compiled into a deterministic, capability-checked plan *before* a device
// is touched. Everything here is pure data: no I/O, no driver calls. The runner, the planning
// tools, Maestro interop, and the Appium audit all share these types so "the same flow means the
// same thing" regardless of backend.
//
// See SWIPIUM-DEVELOPER-3-AUTOMATION-KERNEL-V2-PLAN-2026-05-29.md (Workstreams 1-5, 9).

export type AutomationBackend =
  | 'android-direct'
  | 'ios-raw-simulator'
  | 'ios-wda'
  | 'appium-uiautomator2'
  | 'appium-xcuitest'
  | 'unknown';

export type SelectorStrategy =
  | 'resource_id'
  | 'accessibility_id'
  | 'text'
  | 'ios_predicate'
  | 'ios_class_chain'
  | 'ocr_text'
  | 'image'
  | 'coordinate';

export type SelectorSource = 'flow' | 'maestro_import' | 'recorded_action' | 'repair' | 'manual';

export interface SelectorHints {
  packageName?: string;
  className?: string;
  textHint?: string;
  boundsBucket?: string;
  screenSignature?: string;
  accessibilityLabel?: string;
}

export interface SelectorIR {
  strategy: SelectorStrategy;
  value: string;
  platform?: 'android' | 'ios' | 'cross_platform';
  source: SelectorSource;
  hints?: SelectorHints;
  risk: 'low' | 'medium' | 'high';
  /** True when the selector concept (not the literal value) is meaningful on more than one backend. */
  portable: boolean;
}

/** Visual selector strategies never claim structured-locator proof; they are candidate evidence only. */
export const VISUAL_STRATEGIES: readonly SelectorStrategy[] = ['ocr_text', 'image'];

export function isVisualStrategy(strategy: SelectorStrategy): boolean {
  return VISUAL_STRATEGIES.includes(strategy);
}

export type GestureKind = 'tap' | 'longPress' | 'doubleTap' | 'swipe' | 'scroll' | 'pinch' | 'drag';

export interface GestureArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GestureIR {
  kind: GestureKind;
  target?: SelectorIR;
  area?: 'center' | 'top' | 'bottom' | 'left' | 'right' | GestureArea;
  direction?: 'up' | 'down' | 'left' | 'right';
  /** 0..1 fraction of the scroll surface to travel per step (Maestro `scrollUntilVisible` parity). */
  percent?: number;
  /** 0..1, slow..fast. */
  speed?: number;
  durationMs?: number;
  /** 0..100 — how much of the target must be on screen to count as visible (Maestro parity). */
  visibilityPercentage?: number;
  centerElement?: boolean;
}

export type WaitSource = 'app_declared' | 'backend' | 'heuristic';

export type ActionKind =
  | 'tap'
  | 'longPress'
  | 'doubleTap'
  | 'inputText'
  | 'clearText'
  | 'scrollUntilVisible'
  | 'swipe'
  | 'pinch'
  | 'drag'
  | 'pressKey'
  | 'openUrl'
  | 'waitForVisible'
  | 'waitForNotVisible'
  | 'waitForIdle'
  | 'waitForAnimationToEnd'
  | 'assertVisible'
  | 'assertVisual'
  // Lifecycle / meta steps that do not target a selector but still belong in the plan.
  | 'lifecycle';

export interface ActionIR {
  kind: ActionKind;
  selector?: SelectorIR;
  text?: string;
  gesture?: GestureIR;
  timeoutMs?: number;
  /** Maestro `retryTapIfNoChange` parity — explicit, never a hidden retry loop. */
  retryIfNoChange?: boolean;
  /** Bounded repeat count (Maestro `repeat`) — only for deterministic, non-mutating actions. */
  repeat?: number;
  /** Source idle classification for waitForIdle steps. */
  idleSource?: WaitSource;
  expectedChange?: 'screen' | 'element' | 'none' | 'unknown';
  /** Human label for messages/evidence (e.g. the original flow selector or note). */
  note?: string;
}

export type StepSupport = 'native' | 'supported_with_fallback' | 'visual_only' | 'unsupported';

export interface PlanStep {
  index: number;
  action: ActionIR;
  support: StepSupport;
  reason: string;
  requiredCapability?: string;
}

export interface PlanDiagnostic {
  code: string;
  detail: string;
  nextStep: string;
}

export interface AutomationPlan {
  backend: AutomationBackend;
  executable: boolean;
  steps: PlanStep[];
  blockers: PlanDiagnostic[];
  warnings: PlanDiagnostic[];
  agentMessage: string;
  developerMessage: string;
}

export type AutomationStatus = 'ready' | 'candidate' | 'blocked';

export interface AutomationReadinessResponse {
  status: AutomationStatus;
  headline: string;
  agentMessage: string;
  developerMessage: string;
  backend: AutomationBackend;
  supportedSteps: number;
  unsupportedSteps: number;
  blockers: PlanDiagnostic[];
  warnings: PlanDiagnostic[];
  fallbackUsed?: 'none' | 'visual-only' | 'ios-raw-simulator' | 'appium-required';
}
