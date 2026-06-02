// Automation Kernel V2 — Workstream 8: Maestro Interop V2 at the Action IR level. The existing
// src/interop/maestro.ts maps a shallow subset to Flow V2 YAML; this module imports/exports the
// richer Maestro automation semantics (tapOn repeat/delay/retryTapIfNoChange/settle timeout,
// longPressOn, scrollUntilVisible full options, waitForAnimationToEnd, assertNotVisible, eraseText)
// into Action IR WITHOUT semantic loss, grading every command with an exact reason and the suggested
// Swipium equivalent. Pure: parse in, IR out.

import { parse as parseYaml, stringify } from 'yaml';
import type { ActionIR, GestureIR } from './types.js';
import { selectorFromMaestro, selectorToAppium } from './selectors.js';

export type MaestroGrade = 'portable' | 'maestro_supported' | 'swipium_only' | 'manual_review_required';

export interface MaestroCommandGrade {
  index: number;
  command: string;
  grade: MaestroGrade;
  reason: string;
  swipiumEquivalent?: string;
}

export interface MaestroImportResult {
  actions: ActionIR[];
  grades: MaestroCommandGrade[];
  unsupported: Array<{ command: string; reason: string }>;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Import a Maestro flow into Action IR, preserving retry/repeat/settle/scroll semantics. */
export function importMaestroActions(maestroYaml: string): MaestroImportResult {
  const doc = parseYaml(maestroYaml) as unknown;
  const raw = Array.isArray(doc) ? doc : Array.isArray((doc as { commands?: unknown })?.commands) ? (doc as { commands: unknown[] }).commands : [];
  const actions: ActionIR[] = [];
  const grades: MaestroCommandGrade[] = [];
  const unsupported: MaestroImportResult['unsupported'] = [];

  const grade = (index: number, command: string, g: MaestroGrade, reason: string, swipiumEquivalent?: string) =>
    grades.push({ index, command, grade: g, reason, swipiumEquivalent });
  const unsupp = (index: number, command: string, reason: string, swipiumEquivalent?: string) => {
    unsupported.push({ command, reason });
    grade(index, command, 'manual_review_required', reason, swipiumEquivalent);
  };

  raw.forEach((entry, index) => {
    const o = obj(entry);
    if (!o) {
      unsupp(index, String(entry), 'Maestro command must be a single-key object.');
      return;
    }
    const [cmd, value] = Object.entries(o)[0] ?? [];
    const v = obj(value);
    switch (cmd) {
      case 'tapOn': {
        const sel = selectorFromMaestro(v?.selector ?? value);
        const action: ActionIR = { kind: 'tap', expectedChange: 'unknown', note: 'tapOn' };
        if (sel) action.selector = sel;
        // Explicit automation semantics — never hidden.
        if (v) {
          if (v.retryTapIfNoChange === true) action.retryIfNoChange = true;
          const repeat = num(v.repeat);
          if (repeat != null) action.repeat = repeat;
          const settle = num(v.waitToSettleTimeoutMs);
          if (settle != null) action.timeoutMs = settle;
          if (v.point != null && !sel) action.selector = { strategy: 'coordinate', value: String(v.point), source: 'maestro_import', risk: 'high', portable: false };
        }
        actions.push(action);
        const carried = [action.retryIfNoChange ? 'retryTapIfNoChange' : null, action.repeat != null ? `repeat=${action.repeat}` : null, action.timeoutMs != null ? `settle=${action.timeoutMs}ms` : null].filter(Boolean);
        grade(index, cmd, sel ? 'portable' : 'manual_review_required', sel ? `tapOn → tap${carried.length ? ` (${carried.join(', ')})` : ''}` : 'tapOn point/selector not in supported subset; review.', 'tap');
        break;
      }
      case 'longPressOn': {
        const sel = selectorFromMaestro(v?.selector ?? value);
        const gesture: GestureIR = { kind: 'longPress', target: sel ?? undefined, durationMs: num(v?.duration) ?? 800 };
        actions.push({ kind: 'longPress', selector: sel ?? undefined, gesture, note: 'longPressOn' });
        grade(index, cmd, sel ? 'maestro_supported' : 'manual_review_required', 'longPressOn → longPress gesture', 'longPress');
        break;
      }
      case 'scrollUntilVisible': {
        const inner = v?.element ?? v?.visible ?? value;
        const sel = selectorFromMaestro(inner);
        if (!sel) {
          unsupp(index, cmd, 'scrollUntilVisible needs a text/id/accessibility element selector.', 'scrollUntilVisible');
          break;
        }
        const direction = (typeof v?.direction === 'string' ? v.direction.toLowerCase() : 'down') as GestureIR['direction'];
        const gesture: GestureIR = {
          kind: 'scroll',
          target: sel,
          direction,
          speed: num(v?.speed),
          visibilityPercentage: num(v?.visibilityPercentage) ?? 100,
          centerElement: v?.centerElement === true,
        };
        actions.push({ kind: 'scrollUntilVisible', selector: sel, gesture, timeoutMs: num(v?.timeout), note: 'scrollUntilVisible' });
        grade(index, cmd, 'maestro_supported', `scrollUntilVisible → scrollUntilVisible (direction=${direction}, visibility=${gesture.visibilityPercentage}%${gesture.centerElement ? ', center' : ''})`, 'scrollUntilVisible');
        break;
      }
      case 'waitForAnimationToEnd':
        actions.push({ kind: 'waitForAnimationToEnd', timeoutMs: num(v?.timeout), note: 'waitForAnimationToEnd' });
        grade(index, cmd, 'maestro_supported', 'waitForAnimationToEnd → animation wait (pass-with-warning on timeout)', 'waitForAnimationToEnd');
        break;
      case 'assertVisible': {
        const sel = selectorFromMaestro(value);
        if (!sel) { unsupp(index, cmd, 'assertVisible selector not in supported subset.', 'assertVisible'); break; }
        actions.push({ kind: 'assertVisible', selector: sel, note: 'assertVisible' });
        grade(index, cmd, 'portable', 'assertVisible → assertVisible (acts as a condition wait)', 'assertVisible');
        break;
      }
      case 'assertNotVisible': {
        const sel = selectorFromMaestro(value);
        if (!sel) { unsupp(index, cmd, 'assertNotVisible selector not in supported subset.', 'assertNotVisible'); break; }
        actions.push({ kind: 'waitForNotVisible', selector: sel, note: 'assertNotVisible' });
        grade(index, cmd, 'portable', 'assertNotVisible → waitForNotVisible', 'assertNotVisible');
        break;
      }
      case 'inputText': {
        const text = typeof value === 'string' ? value : typeof v?.text === 'string' ? (v.text as string) : undefined;
        if (text == null) { unsupp(index, cmd, 'inputText needs a string (object-form variables need a Swipium fixture).', 'inputText'); break; }
        actions.push({ kind: 'inputText', text, note: 'inputText' });
        grade(index, cmd, 'portable', 'inputText → inputText', 'inputText');
        break;
      }
      case 'eraseText':
        actions.push({ kind: 'clearText', note: 'eraseText' });
        grade(index, cmd, 'maestro_supported', 'eraseText → clearText', 'clearText (inputText into a cleared field)');
        break;
      case 'launchApp':
        if (v && Object.keys(v).length) {
          unsupp(index, cmd, 'launchApp options (clearState/permissions/arguments) need a Swipium state profile.', 'state profile + prepareTarget');
        } else {
          actions.push({ kind: 'lifecycle', note: 'launchApp' });
          grade(index, cmd, 'maestro_supported', 'launchApp (no options) → prepareTarget', 'prepareTarget');
        }
        break;
      case 'openLink':
        actions.push({ kind: 'openUrl', text: typeof value === 'string' ? value : String(v?.link ?? ''), note: 'openLink' });
        grade(index, cmd, 'portable', 'openLink → openUrl', 'openUrl');
        break;
      case 'clearState':
        unsupp(index, cmd, 'clearState is semantic-lossy; model it as a Swipium state profile with reset policy and consent.', 'state profile');
        break;
      case 'repeat':
        unsupp(index, cmd, 'Maestro repeat loops must be bounded, deterministic, and non-mutating in Swipium; review and unroll explicitly.', 'explicit repeated steps');
        break;
      default:
        unsupp(index, cmd ?? 'unknown', 'command not supported by the Swipium Maestro import subset.');
    }
  });

  return { actions, grades, unsupported };
}

export interface MaestroExportResult {
  maestroYaml: string;
  commands: unknown[];
  grades: MaestroCommandGrade[];
  unsupported: Array<{ command: string; reason: string }>;
}

/**
 * Export Action IR back to Maestro YAML. Native selectors map to Maestro selector blocks (never
 * XPath); Appium/WDA/WebView/visual-only steps that have no portable Maestro form are emitted as an
 * explicit `manualReview` entry and graded manual_review_required — not a silent comment.
 */
export function exportMaestroActions(actions: ActionIR[]): MaestroExportResult {
  const commands: unknown[] = [];
  const grades: MaestroCommandGrade[] = [];
  const unsupported: MaestroExportResult['unsupported'] = [];

  const pushManual = (index: number, command: string, reason: string) => {
    commands.push({ manualReview: reason });
    unsupported.push({ command, reason });
    grades.push({ index, command, grade: 'manual_review_required', reason });
  };

  // Resolve a selector to a Maestro selector block (or plain text). iOS predicate/class-chain and
  // visual/coordinate selectors have NO portable Maestro form — they are flagged for manual review,
  // never silently downgraded to a text matcher (which would be semantic loss graded "portable").
  const exportSelector = (action: ActionIR): { value?: string | Record<string, string>; manualReason?: string } => {
    const sel = action.selector;
    if (!sel) return {};
    if (sel.strategy === 'ios_predicate' || sel.strategy === 'ios_class_chain') {
      return { manualReason: `${sel.strategy} ("${sel.value}") has no portable Maestro selector; export needs manual review (use an accessibility id, or keep the native Appium/WDA selector).` };
    }
    const loc = selectorToAppium(sel);
    if (!loc) {
      return { manualReason: `${sel.strategy} ("${sel.value}") is visual/coordinate-only and has no portable Maestro selector; export needs manual review.` };
    }
    if (loc.using === 'id') return { value: { id: loc.value } };
    if (loc.using === 'accessibility id') return { value: { label: loc.value } };
    return { value: sel.value }; // text → Maestro text matcher (a genuine, portable Maestro form)
  };

  actions.forEach((action, index) => {
    switch (action.kind) {
      case 'tap': {
        const { value, manualReason } = exportSelector(action);
        if (manualReason) { pushManual(index, 'tap', manualReason); break; }
        const tapOn: Record<string, unknown> = value ? (typeof value === 'string' ? { text: value } : value) : {};
        if (action.retryIfNoChange) tapOn.retryTapIfNoChange = true;
        if (action.repeat != null) tapOn.repeat = action.repeat;
        if (action.timeoutMs != null) tapOn.waitToSettleTimeoutMs = action.timeoutMs;
        commands.push({ tapOn });
        grades.push({ index, command: 'tap', grade: 'portable', reason: 'tap → tapOn' });
        break;
      }
      case 'longPress': {
        const { value, manualReason } = exportSelector(action);
        if (manualReason) { pushManual(index, 'longPress', manualReason); break; }
        commands.push({ longPressOn: value ?? {} });
        grades.push({ index, command: 'longPress', grade: 'maestro_supported', reason: 'longPress → longPressOn' });
        break;
      }
      case 'scrollUntilVisible': {
        const { value, manualReason } = exportSelector(action);
        if (manualReason) { pushManual(index, 'scrollUntilVisible', manualReason); break; }
        const g = action.gesture;
        commands.push({
          scrollUntilVisible: {
            element: value ?? action.selector?.value,
            direction: (g?.direction ?? 'down').toUpperCase(),
            ...(g?.visibilityPercentage != null ? { visibilityPercentage: g.visibilityPercentage } : {}),
            ...(g?.centerElement ? { centerElement: true } : {}),
            ...(action.timeoutMs != null ? { timeout: action.timeoutMs } : {}),
          },
        });
        grades.push({ index, command: 'scrollUntilVisible', grade: 'maestro_supported', reason: 'scrollUntilVisible → scrollUntilVisible (fields preserved)' });
        break;
      }
      case 'waitForNotVisible': {
        const { value, manualReason } = exportSelector(action);
        if (manualReason) { pushManual(index, 'waitForNotVisible', manualReason); break; }
        commands.push({ assertNotVisible: value ?? action.selector?.value });
        grades.push({ index, command: 'waitForNotVisible', grade: 'portable', reason: 'waitForNotVisible → assertNotVisible' });
        break;
      }
      case 'assertVisible': {
        const { value, manualReason } = exportSelector(action);
        if (manualReason) { pushManual(index, 'assertVisible', manualReason); break; }
        commands.push({ assertVisible: value ?? action.selector?.value });
        grades.push({ index, command: 'assertVisible', grade: 'portable', reason: 'assertVisible → assertVisible' });
        break;
      }
      case 'inputText':
        commands.push({ inputText: action.text ?? '' });
        grades.push({ index, command: 'inputText', grade: 'portable', reason: 'inputText → inputText' });
        break;
      case 'clearText':
        commands.push({ eraseText: true });
        grades.push({ index, command: 'clearText', grade: 'maestro_supported', reason: 'clearText → eraseText' });
        break;
      case 'waitForAnimationToEnd':
        commands.push({ waitForAnimationToEnd: action.timeoutMs != null ? { timeout: action.timeoutMs } : {} });
        grades.push({ index, command: 'waitForAnimationToEnd', grade: 'maestro_supported', reason: 'waitForAnimationToEnd → waitForAnimationToEnd' });
        break;
      case 'openUrl':
        commands.push({ openLink: action.text ?? '' });
        grades.push({ index, command: 'openUrl', grade: 'portable', reason: 'openUrl → openLink' });
        break;
      case 'lifecycle':
        if (action.note === 'launchApp' || action.note === 'prepareTarget') {
          commands.push({ launchApp: {} });
          grades.push({ index, command: 'lifecycle', grade: 'maestro_supported', reason: `${action.note} → launchApp` });
        } else {
          pushManual(index, action.note ?? 'lifecycle', `${action.note ?? 'lifecycle'} has no portable Maestro form; review manually.`);
        }
        break;
      default:
        pushManual(index, action.kind, `${action.note ?? action.kind} requires Swipium/Appium/WDA and has no portable Maestro form; review manually.`);
    }
  });

  return { maestroYaml: stringify(commands), commands, grades, unsupported };
}
