// Automation Kernel V2 — Workstream 9: Automation Readiness Output. Turns an AutomationPlan into one
// consistent response shape with natural-language messages a coding agent can repeat verbatim to the
// user. The canonical phrases below match the plan's required wording for each backend/fallback case.

import type { ActionKind, AutomationBackend, AutomationPlan, AutomationReadinessResponse, AutomationStatus, PlanStep } from './types.js';
import { isVisualStrategy } from './types.js';

// Canonical phrases (plan Workstream 9 — "Required phrases").
const PHRASE = {
  iosRawSimulator:
    'I can launch and inspect the app in the iOS simulator, but this backend cannot run structured taps. Attach WDA or Appium for selector-based automation.',
  androidDirect:
    'I can run this on Android using resource-id/accessibility/text selectors. Unicode text input needs a stronger backend or fixture adjustment.',
  appiumRequired:
    'This flow needs an Appium backend because it uses a WebView context or gesture that the current backend cannot perform.',
  visualFallback:
    'I can continue with visual/OCR evidence, but that is candidate-level evidence and not a structured locator proof.',
} as const;

// Structured interaction/assertion kinds — the ones that produce structured-locator proof. Lifecycle
// and control steps (openUrl, pressKey, waitForIdle, lifecycle) do NOT make a flow "ready" on their own.
const STRUCTURED_PROOF_KINDS = new Set<ActionKind>([
  'tap', 'longPress', 'doubleTap', 'inputText', 'clearText', 'scrollUntilVisible',
  'swipe', 'drag', 'pinch', 'waitForVisible', 'waitForNotVisible', 'assertVisible',
]);

function providesStructuredProof(step: PlanStep): boolean {
  if (step.support !== 'native' && step.support !== 'supported_with_fallback') return false;
  if (!STRUCTURED_PROOF_KINDS.has(step.action.kind)) return false;
  const sel = step.action.selector;
  if (sel && (isVisualStrategy(sel.strategy) || sel.strategy === 'coordinate')) return false;
  return true;
}

function statusFor(plan: AutomationPlan): AutomationStatus {
  if (!plan.executable) return 'blocked';
  const hasStructured = plan.steps.some(providesStructuredProof);
  const hasVisualOnly = plan.steps.some((s) => s.support === 'visual_only');
  if (!hasStructured && hasVisualOnly) return 'candidate';
  return 'ready';
}

function fallbackUsed(plan: AutomationPlan): AutomationReadinessResponse['fallbackUsed'] {
  if (plan.backend === 'ios-raw-simulator' && statusFor(plan) !== 'ready') return 'ios-raw-simulator';
  if (plan.blockers.some((b) => /appium|webview|context/i.test(`${b.detail} ${b.nextStep}`))) return 'appium-required';
  if (plan.steps.some((s) => s.support === 'visual_only')) return 'visual-only';
  return 'none';
}

function headlineFor(status: AutomationStatus, backend: AutomationBackend): string {
  const label = status === 'ready' ? 'Ready' : status === 'candidate' ? 'Candidate-only' : 'Blocked';
  return `${label} on ${backend}`;
}

/** Build the natural-language agent message, preferring the plan's required canonical phrasing. */
function agentMessageFor(plan: AutomationPlan, status: AutomationStatus): string {
  const fallback = fallbackUsed(plan);
  const parts: string[] = [plan.agentMessage];

  if (plan.backend === 'ios-raw-simulator' && status !== 'ready') parts.push(PHRASE.iosRawSimulator);
  if (plan.backend === 'android-direct') parts.push(PHRASE.androidDirect);
  if (fallback === 'appium-required') parts.push(PHRASE.appiumRequired);
  if (fallback === 'visual-only' || status === 'candidate') parts.push(PHRASE.visualFallback);

  // De-duplicate while preserving order.
  return [...new Set(parts.filter(Boolean))].join(' ');
}

export function buildReadiness(plan: AutomationPlan): AutomationReadinessResponse {
  const status = statusFor(plan);
  const supportedSteps = plan.steps.filter((s) => s.support !== 'unsupported').length;
  const unsupportedSteps = plan.steps.filter((s) => s.support === 'unsupported').length;
  return {
    status,
    headline: headlineFor(status, plan.backend),
    agentMessage: agentMessageFor(plan, status),
    developerMessage: plan.developerMessage,
    backend: plan.backend,
    supportedSteps,
    unsupportedSteps,
    blockers: plan.blockers,
    warnings: plan.warnings,
    fallbackUsed: fallbackUsed(plan),
  };
}

export { PHRASE as READINESS_PHRASES };
