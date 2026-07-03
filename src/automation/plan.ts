// Automation Kernel V2 — Workstream 3: the Action Compiler. Compiles a Flow V2 file into Action IR,
// then into a backend-specific automation plan WITHOUT touching a device. Every step is classified
// before execution (native / supported_with_fallback / visual_only / unsupported) and unsupported
// steps name the exact missing capability and a concrete next step. This is the pure core behind the
// qa_flow_run mode:"plan" preview; it does not execute or mutate anything.

import type { Flow, FlowStep } from '../flows/schema.js';
import type { BackendCapabilities } from './capabilities.js';
import { selectorSupported } from './capabilities.js';
import { checkSelectorBackend, parseSelector, selectorForCoordinate, selectorForVisual } from './selectors.js';
import { gestureSupport } from './gestures.js';
import type { ActionIR, AutomationPlan, GestureIR, PlanDiagnostic, PlanStep, StepSupport } from './types.js';
import { isVisualStrategy } from './types.js';

/** Compile a single Flow V2 step into Action IR. Returns null for steps with no automation action. */
export function compileStep(step: FlowStep): ActionIR | null {
  switch (step.kind) {
    case 'tap':
      return { kind: 'tap', selector: parseSelector(step.selector), expectedChange: 'unknown', note: step.selector };
    case 'tapAt':
      return {
        kind: 'tap',
        selector: selectorForCoordinate(`${step.x},${step.y}`),
        expectedChange: 'unknown',
        note: `tapAt ${step.x},${step.y}`,
      };
    case 'tapImage':
      return {
        kind: 'tap',
        selector: selectorForVisual('image', step.template),
        expectedChange: 'unknown',
        note: `tapImage ${step.template}`,
      };
    case 'tapOcrText':
      return {
        kind: 'tap',
        selector: selectorForVisual('ocr_text', step.query),
        expectedChange: 'unknown',
        note: `tapOcrText ${step.query}`,
      };
    case 'inputText':
      return {
        kind: 'inputText',
        selector: step.into ? parseSelector(step.into) : undefined,
        text: step.value,
        note: step.into ?? '(focused field)',
      };
    case 'assertVisible':
      return { kind: 'assertVisible', selector: parseSelector(step.query), note: step.query };
    case 'assertNotVisible':
      return { kind: 'waitForNotVisible', selector: parseSelector(step.query), note: step.query };
    case 'assertImage':
      return { kind: 'assertVisual', selector: selectorForVisual('image', step.template), note: `assertImage ${step.template}` };
    case 'assertOcrText':
      return { kind: 'assertVisual', selector: selectorForVisual('ocr_text', step.query), note: `assertOcrText ${step.query}` };
    case 'assertVisual':
      return { kind: 'assertVisual', note: step.description };
    case 'assertDiff':
      return { kind: 'assertVisual', note: `assertDiff ${step.baseline}` };
    case 'swipe': {
      const gesture: GestureIR = { kind: 'swipe', direction: step.direction, area: step.area };
      return { kind: 'swipe', gesture, note: `swipe ${step.direction}` };
    }
    case 'scrollTo': {
      const selector = parseSelector(step.query);
      const gesture: GestureIR = { kind: 'scroll', target: selector, direction: 'down', visibilityPercentage: 100 };
      return { kind: 'scrollUntilVisible', selector, gesture, note: step.query };
    }
    case 'press':
      return { kind: 'pressKey', text: step.key, note: `press ${step.key}` };
    case 'openUrl':
      return { kind: 'openUrl', text: step.url, note: step.url };
    case 'waitForVisible':
      return { kind: 'waitForVisible', selector: parseSelector(step.query), timeoutMs: step.timeoutMs, note: step.query };
    case 'wait':
      return step.query
        ? { kind: 'waitForVisible', selector: parseSelector(step.query), note: step.query }
        : { kind: 'waitForIdle', idleSource: 'heuristic', timeoutMs: step.ms, note: step.ms != null ? `wait ${step.ms}ms` : 'wait' };
    case 'waitForIdle':
      return { kind: 'waitForIdle', idleSource: 'heuristic', timeoutMs: step.timeoutMs, note: 'waitForIdle' };
    // Lifecycle / environment / meta steps — modeled but not selector-targeted.
    case 'prepareTarget':
    case 'restartApp':
    case 'clearOverlay':
    case 'networkOffline':
    case 'networkOnline':
    case 'seed':
    case 'note':
    case 'screenshot':
      return { kind: 'lifecycle', note: step.kind };
    default:
      return null;
  }
}

/** Compile all of a flow's setup + main + teardown steps into Action IR. */
export function compileActions(flow: Flow): ActionIR[] {
  return [...flow.setup, ...flow.steps, ...flow.teardown].map(compileStep).filter((a): a is ActionIR => a != null);
}

const STRUCTURED_ACTIONS = new Set<ActionIR['kind']>([
  'tap',
  'longPress',
  'doubleTap',
  'inputText',
  'clearText',
  'scrollUntilVisible',
  'waitForVisible',
  'waitForNotVisible',
  'assertVisible',
]);

interface Classification {
  support: StepSupport;
  reason: string;
  requiredCapability?: string;
}

function hasNonAscii(text?: string): boolean {
  if (!text) return false;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) return true;
  return false;
}

/**
 * Classify a text-input action's backend support. Returns a blocking Classification, or null when the
 * input is fine. ASCII needs textInputAscii; literal non-ASCII text (e.g. "José") additionally needs
 * textInputUnicode — adb `input text` cannot type Unicode reliably, so Android direct is blocked.
 */
function inputTextSupport(action: ActionIR, caps: BackendCapabilities): Classification | null {
  if (!caps.textInputAscii)
    return { support: 'unsupported', reason: `text input is unsupported on ${caps.backend}.`, requiredCapability: 'textInputAscii' };
  if (hasNonAscii(action.text) && !caps.textInputUnicode) {
    return {
      support: 'unsupported',
      reason: `text "${action.text}" contains non-ASCII characters; ${caps.backend} cannot input Unicode reliably.`,
      requiredCapability: 'textInputUnicode',
    };
  }
  return null;
}

function classifyAction(action: ActionIR, caps: BackendCapabilities): Classification {
  // Lifecycle / control actions: available wherever lifecycle is (launch is our proxy).
  if (action.kind === 'lifecycle' || action.kind === 'openUrl' || action.kind === 'pressKey') {
    if (action.kind === 'openUrl' && !caps.openUrl) {
      return { support: 'unsupported', reason: `openUrl is not supported on ${caps.backend}.`, requiredCapability: 'openUrl' };
    }
    return { support: 'native', reason: `${action.note ?? action.kind} runs as a lifecycle/control step on ${caps.backend}.` };
  }

  if (action.kind === 'waitForIdle') {
    if (action.idleSource === 'app_declared' && !caps.appDeclaredIdling) {
      return {
        support: 'supported_with_fallback',
        reason: `app-declared idling is unavailable on ${caps.backend}; will fall back to heuristic settling (not app proof).`,
      };
    }
    return { support: 'native', reason: `waitForIdle uses ${caps.wdaIdling ? 'backend' : 'heuristic'} settling on ${caps.backend}.` };
  }

  if (action.kind === 'waitForAnimationToEnd') {
    return { support: 'native', reason: `animation wait is honored heuristically on ${caps.backend}.` };
  }

  if (action.kind === 'swipe' && action.gesture) {
    const g = gestureSupport(action.gesture, caps);
    return g.supported
      ? { support: 'native', reason: g.reason }
      : { support: 'unsupported', reason: g.reason, requiredCapability: g.requiredCapability };
  }

  if (action.kind === 'pinch' || action.kind === 'drag' || action.kind === 'longPress' || action.kind === 'doubleTap') {
    const g = gestureSupport(
      action.gesture ?? {
        kind: action.kind === 'pinch' ? 'pinch' : action.kind === 'drag' ? 'drag' : action.kind === 'longPress' ? 'longPress' : 'doubleTap',
      },
      caps,
    );
    if (!g.supported && (STRUCTURED_ACTIONS.has(action.kind) || action.kind === 'pinch' || action.kind === 'drag')) {
      return { support: 'unsupported', reason: g.reason, requiredCapability: g.requiredCapability };
    }
  }

  const selector = action.selector;

  // Visual-strategy targets are candidate evidence only.
  if (selector && isVisualStrategy(selector.strategy)) {
    const ok = selectorSupported(caps, selector.strategy);
    return ok
      ? {
          support: 'visual_only',
          reason: `${action.kind} uses a ${selector.strategy} target — visual/OCR candidate evidence, not a structured locator proof.`,
        }
      : {
          support: 'unsupported',
          reason: `${selector.strategy} fallback is unavailable on ${caps.backend}.`,
          requiredCapability: selector.strategy,
        };
  }

  // assertVisual with no selector is always visual-only candidate evidence.
  if (action.kind === 'assertVisual') {
    return { support: 'visual_only', reason: 'assertVisual records visual candidate evidence; it is not a structured assertion.' };
  }

  // Coordinate targets work anywhere we can screenshot, but are a fallback (brittle).
  if (selector && selector.strategy === 'coordinate') {
    return selectorSupported(caps, 'coordinate')
      ? {
          support: 'supported_with_fallback',
          reason: `${action.kind} by coordinate is a brittle fallback on ${caps.backend}; prefer a durable selector.`,
        }
      : {
          support: 'unsupported',
          reason: `coordinate targeting needs screenshot support on ${caps.backend}.`,
          requiredCapability: 'screenshot',
        };
  }

  // Structured selector actions: the backend must support the selector strategy.
  if (selector && STRUCTURED_ACTIONS.has(action.kind)) {
    const check = checkSelectorBackend(selector, caps);
    if (!check.supported) {
      // If the backend has no structured tree at all (e.g. iOS raw sim), surface the structural blocker.
      if (!caps.structuredTree) {
        return {
          support: 'unsupported',
          reason: `${caps.backend} cannot run structured ${action.kind}; ${check.detail}`,
          requiredCapability: 'structuredTree',
        };
      }
      return {
        support: 'unsupported',
        reason: check.detail ?? `${selector.strategy} unsupported on ${caps.backend}.`,
        requiredCapability: selector.strategy,
      };
    }
    // Text input also needs the right input capability (ASCII, and Unicode for non-ASCII text).
    if (action.kind === 'inputText') {
      const t = inputTextSupport(action, caps);
      if (t) return t;
    }
    return { support: 'native', reason: `${action.kind} via ${selector.strategy} is native on ${caps.backend}.` };
  }

  // inputText into the focused field (no selector).
  if (action.kind === 'inputText') {
    const t = inputTextSupport(action, caps);
    if (t) return t;
    return { support: 'native', reason: `text input into the focused field is native on ${caps.backend}.` };
  }

  return { support: 'native', reason: `${action.kind} is supported on ${caps.backend}.` };
}

function nextStepForRequirement(requiredCapability: string | undefined, backend: string): string {
  switch (requiredCapability) {
    case 'structuredTree':
      return 'Attach WDA or Appium for structured selectors, or rewrite the step as a visual/OCR check.';
    case 'pinch':
      return 'Attach Appium UiAutomator2/XCUITest, or replace the pinch with a swipe/scroll.';
    case 'textInputAscii':
      return 'Use a backend that supports text input (WDA/Appium), or drive the field another way.';
    case 'textInputUnicode':
      return 'Use WDA or Appium for Unicode text, or change the fixture value to ASCII (adb input text cannot type Unicode reliably).';
    case 'accessibility_id':
    case 'resource_id':
      return 'Attach a structured backend, or add a durable accessibility id / resource id.';
    case 'ios_predicate':
    case 'ios_class_chain':
      return 'Use iOS WDA or Appium XCUITest, or replace it with an accessibility id.';
    case 'ocr_text':
    case 'image':
      return 'Enable visual/OCR fallback, or attach a structured backend.';
    default:
      return `Attach a backend on which this step is supported (current: ${backend}).`;
  }
}

/**
 * Compile a Flow V2 file into a backend-specific automation plan. Pure — no device, no mutation.
 */
export function compileAutomationPlan(flow: Flow, caps: BackendCapabilities): AutomationPlan {
  const actions = compileActions(flow);
  const steps: PlanStep[] = [];
  const blockers: PlanDiagnostic[] = [];
  const warnings: PlanDiagnostic[] = [];

  actions.forEach((action, index) => {
    const cls = classifyAction(action, caps);
    const step: PlanStep = { index, action, support: cls.support, reason: cls.reason, requiredCapability: cls.requiredCapability };
    steps.push(step);

    if (cls.support === 'unsupported') {
      blockers.push({
        code: cls.requiredCapability === 'structuredTree' ? 'BACKEND_UNSUPPORTED' : 'STEP_UNSUPPORTED',
        detail: `step ${index} (${action.note ?? action.kind}): ${cls.reason}`,
        nextStep: nextStepForRequirement(cls.requiredCapability, caps.backend),
      });
    } else if (cls.support === 'visual_only') {
      warnings.push({
        code: 'VISUAL_ONLY',
        detail: `step ${index} (${action.note ?? action.kind}): ${cls.reason}`,
        nextStep: 'This is candidate-level evidence; add a structured selector for CI-grade proof.',
      });
    } else if (cls.support === 'supported_with_fallback') {
      warnings.push({
        code: 'FALLBACK_USED',
        detail: `step ${index} (${action.note ?? action.kind}): ${cls.reason}`,
        nextStep: 'Prefer a durable selector to avoid the fallback.',
      });
    }
  });

  const executable = steps.every((s) => s.support !== 'unsupported');
  const visualOnly = steps.filter((s) => s.support === 'visual_only').length;
  const supported = steps.filter((s) => s.support === 'native' || s.support === 'supported_with_fallback').length;

  const agentMessage = buildAgentMessage(caps.backend, executable, supported, visualOnly, blockers);
  const developerMessage = buildDeveloperMessage(caps, steps, blockers, warnings);

  return { backend: caps.backend, executable, steps, blockers, warnings, agentMessage, developerMessage };
}

function buildAgentMessage(
  backend: string,
  executable: boolean,
  supported: number,
  visualOnly: number,
  blockers: PlanDiagnostic[],
): string {
  if (!executable) {
    const first = blockers[0];
    return `This flow is not runnable on ${backend}: ${first?.detail ?? 'an unsupported step blocks it'}. ${first?.nextStep ?? ''}`.trim();
  }
  if (supported === 0 && visualOnly > 0) {
    return `This flow is candidate-only on ${backend}: ${visualOnly} visual/OCR step(s) and no structured locators. It produces candidate evidence, not structured proof.`;
  }
  const visualPart = visualOnly ? ` and ${visualOnly} visual fallback step(s)` : '';
  return `This flow is runnable on ${backend} with ${supported} structured step(s)${visualPart}.`;
}

function buildDeveloperMessage(
  caps: BackendCapabilities,
  steps: PlanStep[],
  blockers: PlanDiagnostic[],
  warnings: PlanDiagnostic[],
): string {
  const lines = [`Backend: ${caps.backend}. ${steps.length} step(s) planned.`];
  for (const b of blockers) lines.push(`BLOCKER ${b.code}: ${b.detail} → ${b.nextStep}`);
  for (const w of warnings) lines.push(`WARNING ${w.code}: ${w.detail} → ${w.nextStep}`);
  if (caps.notes.length) lines.push(`Backend notes: ${caps.notes.join(' ')}`);
  return lines.join('\n');
}
