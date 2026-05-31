// Swipium flow format v2 (NEXT-PLAN: Flow System V2). A readable YAML authoring surface that
// compiles to a normalized step list (the action IR). v2 adds: selector-bound inputText, visual
// steps (image/diff/visual), device-relative gestures, waits, overlay/network/lifecycle/seed/note
// steps, a structured|visual|auto mode, and setup/teardown. One parse, shared by check + run.

import { parse as parseYaml } from 'yaml';
import type { SelectorProvenance } from '../session/store.js';

export type FlowMode = 'structured' | 'visual' | 'auto';
export type SwipeArea = 'center' | 'top' | 'bottom' | 'left' | 'right';
export type NoteOutcome = 'pass' | 'fail' | 'blocked' | 'skipped' | 'not_applicable';

export type FlowStep =
  | { kind: 'prepareTarget' }
  | { kind: 'restartApp' }
  | { kind: 'tap'; selector: string }
  | { kind: 'tapAt'; x: number; y: number }
  | { kind: 'tapImage'; template: string; minScore?: number }
  | { kind: 'tapOcrText'; query: string; minConfidence?: number }
  | { kind: 'inputText'; value: string; secret: boolean; into?: string } // into = field selector to focus first
  | { kind: 'assertVisible'; query: string }
  | { kind: 'assertNotVisible'; query: string }
  | { kind: 'assertImage'; template: string; minScore?: number }
  | { kind: 'assertOcrText'; query: string; minConfidence?: number }
  | { kind: 'assertVisual'; description: string } // captures evidence; passes (human-readable record)
  | { kind: 'assertDiff'; baseline: string; threshold?: number }
  | { kind: 'swipe'; direction: 'up' | 'down' | 'left' | 'right'; area?: SwipeArea; distance?: number }
  | { kind: 'scrollTo'; query: string }
  | { kind: 'press'; key: 'back' | 'home' | 'enter' }
  | { kind: 'openUrl'; url: string }
  | { kind: 'wait'; ms?: number; query?: string }
  | { kind: 'waitForIdle'; timeoutMs?: number }
  | { kind: 'waitForVisible'; query: string; timeoutMs?: number }
  | { kind: 'clearOverlay' }
  | { kind: 'networkOffline' }
  | { kind: 'networkOnline' }
  | { kind: 'seed'; fixture: string }
  | { kind: 'note'; outcome: NoteOutcome; reason: string }
  | { kind: 'screenshot'; reason?: string };

export interface Flow {
  name: string;
  appId?: string;
  budgetProfile?: string;
  mode: FlowMode;
  fixtures: string[];
  setup: FlowStep[];
  teardown: FlowStep[];
  steps: FlowStep[];
  provenance: FlowProvenanceEntry[];
}

export interface FlowProvenanceEntry extends SelectorProvenance {
  actionIndex?: number;
  generatedStepIndex?: number;
  generatedKind?: string;
  action?: string;
  selector?: string;
}

export interface ParseResult {
  flow?: Flow;
  errors: string[];
}

const SECRET_VAR = /pass|secret|token|otp|pin|cvv|key/i;
const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const AREAS = ['center', 'top', 'bottom', 'left', 'right'] as const;
const KEYS = ['back', 'home', 'enter'] as const;
const OUTCOMES = ['pass', 'fail', 'blocked', 'skipped', 'not_applicable'] as const;
const BARE = new Set(['prepareTarget', 'restartApp', 'waitForIdle', 'clearOverlay', 'networkOffline', 'networkOnline']);

function looksSecret(value: string): boolean {
  for (const m of value.matchAll(/\$\{([^}]+)\}/g)) if (SECRET_VAR.test(m[1])) return true;
  return false;
}

function normalizeStep(raw: unknown, i: number, errors: string[]): FlowStep | null {
  const err = (m: string): null => (errors.push(`step ${i}: ${m}`), null);

  if (typeof raw === 'string') {
    if (BARE.has(raw)) return { kind: raw as 'prepareTarget' };
    return err(`unknown bare action "${raw}" (bare actions: ${[...BARE].join(', ')}).`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return err('must be a string or a single-key map.');
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1) return err(`exactly one action per step (got: ${keys.join(', ') || 'none'}).`);
  const k = keys[0];
  const v = (raw as Record<string, unknown>)[k];
  const str = (x: unknown): x is string => typeof x === 'string';
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

  switch (k) {
    case 'prepareTarget': return { kind: 'prepareTarget' };
    case 'restartApp': return { kind: 'restartApp' };
    case 'clearOverlay': return { kind: 'clearOverlay' };
    case 'waitForIdle': return { kind: 'waitForIdle', timeoutMs: typeof v === 'number' ? v : undefined };
    case 'tap': return str(v) ? { kind: 'tap', selector: v } : err('tap needs a string selector.');
    case 'tapAt':
      return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? { kind: 'tapAt', x: v[0] as number, y: v[1] as number } : err('tapAt needs [x, y].');
    case 'tapImage':
      if (str(v)) return { kind: 'tapImage', template: v };
      if (obj(v) && str(v.template)) return { kind: 'tapImage', template: v.template, minScore: typeof v.minScore === 'number' ? v.minScore : undefined };
      return err('tapImage needs a template path (or { template, minScore }).');
    case 'tapOcrText':
      if (str(v)) return { kind: 'tapOcrText', query: v };
      if (obj(v) && str(v.text)) return { kind: 'tapOcrText', query: v.text, minConfidence: typeof v.minConfidence === 'number' ? v.minConfidence : undefined };
      return err('tapOcrText needs text, or { text, minConfidence }.');
    case 'inputText':
      if (str(v)) return { kind: 'inputText', value: v, secret: looksSecret(v) };
      if (obj(v) && str(v.text)) return { kind: 'inputText', value: v.text, secret: typeof v.secret === 'boolean' ? v.secret : looksSecret(v.text), into: str(v.into) ? v.into : undefined };
      return err('inputText needs a string, or { into, text, secret? }.');
    case 'assertVisible': return str(v) ? { kind: 'assertVisible', query: v } : err('assertVisible needs a string.');
    case 'assertNotVisible': return str(v) ? { kind: 'assertNotVisible', query: v } : err('assertNotVisible needs a string.');
    case 'assertImage':
      if (str(v)) return { kind: 'assertImage', template: v };
      if (obj(v) && str(v.template)) return { kind: 'assertImage', template: v.template, minScore: typeof v.minScore === 'number' ? v.minScore : undefined };
      return err('assertImage needs a template path (or { template, minScore }).');
    case 'assertOcrText':
      if (str(v)) return { kind: 'assertOcrText', query: v };
      if (obj(v) && str(v.text)) return { kind: 'assertOcrText', query: v.text, minConfidence: typeof v.minConfidence === 'number' ? v.minConfidence : undefined };
      return err('assertOcrText needs text, or { text, minConfidence }.');
    case 'assertVisual': return str(v) ? { kind: 'assertVisual', description: v } : err('assertVisual needs a description string.');
    case 'assertDiff':
      if (str(v)) return { kind: 'assertDiff', baseline: v };
      if (obj(v) && str(v.baseline)) return { kind: 'assertDiff', baseline: v.baseline, threshold: typeof v.threshold === 'number' ? v.threshold : undefined };
      return err('assertDiff needs a baseline name (or { baseline, threshold }).');
    case 'swipe':
      if (DIRECTIONS.includes(v as never)) return { kind: 'swipe', direction: v as 'up' };
      if (obj(v) && DIRECTIONS.includes(v.direction as never)) {
        const area = AREAS.includes(v.area as never) ? (v.area as SwipeArea) : undefined;
        const distance = typeof v.distance === 'number' ? v.distance : undefined;
        return { kind: 'swipe', direction: v.direction as 'up', area, distance };
      }
      return err(`swipe needs a direction (${DIRECTIONS.join('/')}) or { direction, area?, distance? }.`);
    case 'scrollTo': return str(v) ? { kind: 'scrollTo', query: v } : err('scrollTo needs a string.');
    case 'press': return KEYS.includes(v as never) ? { kind: 'press', key: v as 'back' } : err(`press needs one of ${KEYS.join('/')}.`);
    case 'openUrl': return str(v) ? { kind: 'openUrl', url: v } : err('openUrl needs a string url.');
    case 'waitForVisible':
      if (str(v)) return { kind: 'waitForVisible', query: v };
      if (obj(v) && (str(v.text) || str(v.id) || str(v['accessibility id']))) return { kind: 'waitForVisible', query: (v.text ?? (v.id ? `id=${v.id}` : `accessibility id=${v['accessibility id']}`)) as string, timeoutMs: typeof v.timeoutMs === 'number' ? v.timeoutMs : undefined };
      return err('waitForVisible needs a string (or { text|id|"accessibility id", timeoutMs }).');
    case 'wait':
      if (typeof v === 'number') return { kind: 'wait', ms: v };
      if (obj(v) && (str(v.text) || str(v.id))) return { kind: 'wait', query: (v.text ?? v.id) as string };
      return err('wait needs ms (number) or { text|id }.');
    case 'networkOffline': return { kind: 'networkOffline' };
    case 'networkOnline': return { kind: 'networkOnline' };
    case 'seed': return str(v) ? { kind: 'seed', fixture: v } : err('seed needs a fixture name.');
    case 'note':
      if (str(v)) return { kind: 'note', outcome: 'pass', reason: v };
      if (obj(v) && str(v.reason)) {
        const outcome = OUTCOMES.includes(v.outcome as never) ? (v.outcome as NoteOutcome) : 'pass';
        return { kind: 'note', outcome, reason: v.reason };
      }
      return err('note needs a string, or { outcome?, reason }.');
    case 'screenshot': return { kind: 'screenshot', reason: str(v) ? v : undefined };
    default: return err(`unknown action "${k}".`);
  }
}

function normalizeStepList(raw: unknown, label: string, errors: string[]): FlowStep[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`\`${label}\` must be a list of steps.`);
    return [];
  }
  const out: FlowStep[] = [];
  raw.forEach((s, i) => {
    const step = normalizeStep(s, i, errors);
    if (step) out.push(step);
  });
  return out;
}

function maybeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeVisualProvenance(raw: unknown): SelectorProvenance['visual'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const crop = v.screenshotCrop;
  const screenshotCrop = crop && typeof crop === 'object' && !Array.isArray(crop)
    ? (() => {
        const c = crop as Record<string, unknown>;
        const x = maybeNumber(c.x);
        const y = maybeNumber(c.y);
        const width = maybeNumber(c.width);
        const height = maybeNumber(c.height);
        return x != null && y != null && width != null && height != null ? { x, y, width, height } : undefined;
      })()
    : undefined;
  const out: NonNullable<SelectorProvenance['visual']> = {
    screenshotCrop,
    ocrText: maybeString(v.ocrText),
    confidence: maybeNumber(v.confidence),
    locale: maybeString(v.locale),
    theme: maybeString(v.theme),
    density: v.density === null ? null : maybeNumber(v.density),
    orientation: maybeString(v.orientation),
    fallbackSelector: maybeString(v.fallbackSelector),
  };
  return Object.values(out).some((value) => value != null) ? out : undefined;
}

function normalizeProvenance(raw: unknown): FlowProvenanceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      actionIndex: maybeNumber(entry.actionIndex),
      generatedStepIndex: maybeNumber(entry.generatedStepIndex),
      generatedKind: maybeString(entry.generatedKind),
      action: maybeString(entry.action),
      selector: maybeString(entry.selector),
      originalScreenSignature: maybeString(entry.originalScreenSignature),
      elementRole: maybeString(entry.elementRole),
      className: maybeString(entry.className),
      text: maybeString(entry.text),
      accessibilityLabel: maybeString(entry.accessibilityLabel),
      resourceId: maybeString(entry.resourceId),
      boundsBucket: maybeString(entry.boundsBucket),
      screenshotUri: maybeString(entry.screenshotUri),
      selectorKind: maybeString(entry.selectorKind),
      selectorValue: maybeString(entry.selectorValue),
      visual: normalizeVisualProvenance(entry.visual),
    }));
}

export function parseFlow(yamlText: string): ParseResult {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (e) {
    return { errors: [`YAML parse error: ${String((e as Error).message ?? e)}`] };
  }
  if (!doc || typeof doc !== 'object') return { errors: ['flow must be a YAML map with name + steps.'] };
  const d = doc as Record<string, unknown>;

  if (typeof d.name !== 'string' || !d.name.trim()) errors.push('flow needs a non-empty `name`.');
  if (!Array.isArray(d.steps) || d.steps.length === 0) errors.push('flow needs a non-empty `steps` list.');
  if (d.appId != null && typeof d.appId !== 'string') errors.push('`appId` must be a string.');
  if (d.budgetProfile != null && typeof d.budgetProfile !== 'string') errors.push('`budgetProfile` must be a string.');
  const mode: FlowMode = d.mode === 'visual' || d.mode === 'auto' ? d.mode : 'structured';
  if (d.mode != null && !['structured', 'visual', 'auto'].includes(d.mode as string)) errors.push('`mode` must be structured | visual | auto.');

  const setup = normalizeStepList(d.setup, 'setup', errors);
  const teardown = normalizeStepList(d.teardown, 'teardown', errors);
  const steps = normalizeStepList(d.steps, 'steps', errors);
  const fixtures = Array.isArray(d.fixtures) ? d.fixtures.filter((f): f is string => typeof f === 'string') : [];
  const provenance = normalizeProvenance(d.provenance);

  if (errors.length) return { errors };
  return {
    flow: { name: d.name as string, appId: d.appId as string | undefined, budgetProfile: d.budgetProfile as string | undefined, mode, fixtures, setup, teardown, steps, provenance },
    errors: [],
  };
}

/** Resolve ${VAR} from a variables map (then process.env). Returns the value + any missing names. */
export function resolveVars(value: string, vars: Record<string, string>): { out: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const v = vars[name] ?? process.env[name];
    if (v == null) {
      missing.push(name);
      return '';
    }
    return v;
  });
  return { out, missing };
}
