// Swipium flow format v2 (Flow System V2). A readable YAML authoring surface that
// compiles to a normalized step list (the action IR). v2 adds: selector-bound inputText, visual
// steps (image/diff/visual), device-relative gestures, waits, overlay/network/lifecycle/seed/note
// steps, a structured|visual|auto mode, and setup/teardown. One parse, shared by check + run.

import { isMap, isScalar, parseDocument, visit, type Document } from 'yaml';
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

/** Lower-case word segments of a name, split on `_` / `-` / digits / spaces and camelCase:
 *  SWIPIUM_TEST_PASSWORD > [swipium, test, password], apiKey > [api, key], OTP2 > [otp]. */
export function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((seg) => seg.toLowerCase());
}

/** Words that are credential-like wherever they appear inside a segment (CLIENTSECRET, AUTHTOKEN). */
export const STRONG_SECRET_WORDS = ['password', 'passwd', 'passcode', 'passphrase', 'secret', 'token', 'apikey'];
/** Short words that only count as a whole segment: PIN yes, SHIPPING no; KEY yes, KEYWORD no. */
const WEAK_SECRET_WORDS = new Set(['pass', 'pwd', 'otp', 'totp', 'pin', 'cvv', 'cvc', 'key', 'code']);
/** Run-together forms of the short words seen in env names (SWIPIUM_OTPCODE, SWIPIUM_PINCODE). */
const SECRET_COMPOUNDS = new Set([
  'otpcode',
  'pincode',
  'pinnumber',
  'smscode',
  'authcode',
  'mfacode',
  'verificationcode',
  'verifycode',
  'securitycode',
  'onetimecode',
  'confirmationcode',
  'accesskey',
  'authkey',
  'secretkey',
  'privatekey',
]);

function secretSegment(seg: string): boolean {
  const singular = seg.length > 3 && seg.endsWith('s') ? seg.slice(0, -1) : seg;
  return (
    WEAK_SECRET_WORDS.has(seg) ||
    WEAK_SECRET_WORDS.has(singular) ||
    SECRET_COMPOUNDS.has(seg) ||
    STRONG_SECRET_WORDS.some((w) => seg.includes(w))
  );
}

/** True for a credential-like variable name (password, secret, token, OTP, PIN, CVV, key, code),
 *  matched per name segment so SHIPPING (pin) or KEYWORD (key) are not secrets. */
export function isSecretVarName(name: string): boolean {
  return nameSegments(name).some(secretSegment);
}

/** Credential-like variable names whose resolved values are registered as session secrets. The
 *  ONE shared definition: qa_act placeholder expansion, flow parsing/running and
 *  qa_continue_from_blocker all use it (`code` covers OTP vars like SWIPIUM_VERIFICATION_CODE).
 *  Kept as a `{ test }` matcher so callers read like the regex it replaced. */
export const SECRET_VAR_NAME: { test(name: string): boolean } = { test: isSecretVarName };
const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const AREAS = ['center', 'top', 'bottom', 'left', 'right'] as const;
const KEYS = ['back', 'home', 'enter'] as const;
const OUTCOMES = ['pass', 'fail', 'blocked', 'skipped', 'not_applicable'] as const;
const BARE = new Set(['prepareTarget', 'restartApp', 'waitForIdle', 'clearOverlay', 'networkOffline', 'networkOnline']);

function looksSecret(value: string): boolean {
  for (const m of value.matchAll(/\$\{([^}]+)\}/g)) if (SECRET_VAR_NAME.test(m[1])) return true;
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
  // An optional 0..1 option (minScore, minConfidence, threshold): absent is fine, anything else
  // that is present must be a number in range. A typo must not silently fall back to the default.
  const BAD = Symbol('bad');
  const fraction = (o: Record<string, unknown>, key: string, opts: { exclusiveMin?: boolean } = {}): number | undefined | typeof BAD => {
    const x = o[key];
    if (x == null) return undefined;
    const lowOk = typeof x === 'number' && (opts.exclusiveMin ? x > 0 : x >= 0);
    if (typeof x === 'number' && Number.isFinite(x) && lowOk && x <= 1) return x;
    errors.push(
      `step ${i}: ${k} ${key} must be a number ${opts.exclusiveMin ? 'greater than 0 and at most 1' : 'from 0 to 1'} (got ${JSON.stringify(x)}).`,
    );
    return BAD;
  };

  switch (k) {
    case 'prepareTarget':
      return { kind: 'prepareTarget' };
    case 'restartApp':
      return { kind: 'restartApp' };
    case 'clearOverlay':
      return { kind: 'clearOverlay' };
    case 'waitForIdle':
      if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))
        return err('waitForIdle takes an optional non-negative timeout in ms (or no value).');
      return { kind: 'waitForIdle', timeoutMs: typeof v === 'number' ? v : undefined };
    case 'tap':
      return str(v) ? { kind: 'tap', selector: v } : err('tap needs a string selector.');
    case 'tapAt':
      return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')
        ? { kind: 'tapAt', x: v[0] as number, y: v[1] as number }
        : err('tapAt needs [x, y].');
    case 'tapImage':
      if (str(v)) return { kind: 'tapImage', template: v };
      if (obj(v) && str(v.template)) {
        const minScore = fraction(v, 'minScore');
        return minScore === BAD ? null : { kind: 'tapImage', template: v.template, minScore };
      }
      return err('tapImage needs a template path (or { template, minScore }).');
    case 'tapOcrText':
      if (str(v)) return { kind: 'tapOcrText', query: v };
      if (obj(v) && str(v.text)) {
        const minConfidence = fraction(v, 'minConfidence');
        return minConfidence === BAD ? null : { kind: 'tapOcrText', query: v.text, minConfidence };
      }
      return err('tapOcrText needs text, or { text, minConfidence }.');
    case 'inputText':
      if (str(v)) return { kind: 'inputText', value: v, secret: looksSecret(v) };
      if (obj(v) && str(v.text)) {
        if (v.secret != null && typeof v.secret !== 'boolean') return err('inputText secret must be true or false.');
        if (v.into != null && !str(v.into)) return err('inputText into must be a selector string.');
        return {
          kind: 'inputText',
          value: v.text,
          secret: typeof v.secret === 'boolean' ? v.secret : looksSecret(v.text),
          into: str(v.into) ? v.into : undefined,
        };
      }
      return err('inputText needs a string, or { into, text, secret? }.');
    case 'assertVisible':
      return str(v) ? { kind: 'assertVisible', query: v } : err('assertVisible needs a string.');
    case 'assertNotVisible':
      return str(v) ? { kind: 'assertNotVisible', query: v } : err('assertNotVisible needs a string.');
    case 'assertImage':
      if (str(v)) return { kind: 'assertImage', template: v };
      if (obj(v) && str(v.template)) {
        const minScore = fraction(v, 'minScore');
        return minScore === BAD ? null : { kind: 'assertImage', template: v.template, minScore };
      }
      return err('assertImage needs a template path (or { template, minScore }).');
    case 'assertOcrText':
      if (str(v)) return { kind: 'assertOcrText', query: v };
      if (obj(v) && str(v.text)) {
        const minConfidence = fraction(v, 'minConfidence');
        return minConfidence === BAD ? null : { kind: 'assertOcrText', query: v.text, minConfidence };
      }
      return err('assertOcrText needs text, or { text, minConfidence }.');
    case 'assertVisual':
      return str(v) ? { kind: 'assertVisual', description: v } : err('assertVisual needs a description string.');
    case 'assertDiff':
      if (str(v)) return { kind: 'assertDiff', baseline: v };
      if (obj(v) && str(v.baseline)) {
        const threshold = fraction(v, 'threshold');
        return threshold === BAD ? null : { kind: 'assertDiff', baseline: v.baseline, threshold };
      }
      return err('assertDiff needs a baseline name (or { baseline, threshold }).');
    case 'swipe':
      if (DIRECTIONS.includes(v as never)) return { kind: 'swipe', direction: v as 'up' };
      if (obj(v) && DIRECTIONS.includes(v.direction as never)) {
        if (v.area != null && !AREAS.includes(v.area as never))
          return err(`swipe area must be one of ${AREAS.join('/')} (got ${JSON.stringify(v.area)}).`);
        const distance = fraction(v, 'distance', { exclusiveMin: true });
        if (distance === BAD) return null;
        return { kind: 'swipe', direction: v.direction as 'up', area: v.area as SwipeArea | undefined, distance };
      }
      return err(`swipe needs a direction (${DIRECTIONS.join('/')}) or { direction, area?, distance? }.`);
    case 'scrollTo':
      return str(v) ? { kind: 'scrollTo', query: v } : err('scrollTo needs a string.');
    case 'press':
      return KEYS.includes(v as never) ? { kind: 'press', key: v as 'back' } : err(`press needs one of ${KEYS.join('/')}.`);
    case 'openUrl':
      return str(v) ? { kind: 'openUrl', url: v } : err('openUrl needs a string url.');
    case 'waitForVisible':
      if (str(v)) return { kind: 'waitForVisible', query: v };
      if (obj(v) && v.timeoutMs != null && (typeof v.timeoutMs !== 'number' || !(v.timeoutMs >= 0)))
        return err('waitForVisible timeoutMs must be a non-negative number of ms.');
      if (obj(v) && (str(v.text) || str(v.id) || str(v['accessibility id'])))
        return {
          kind: 'waitForVisible',
          query: (v.text ?? (v.id ? `id=${v.id}` : `accessibility id=${v['accessibility id']}`)) as string,
          timeoutMs: typeof v.timeoutMs === 'number' ? v.timeoutMs : undefined,
        };
      return err('waitForVisible needs a string (or { text|id|"accessibility id", timeoutMs }).');
    case 'wait':
      if (typeof v === 'number')
        return Number.isFinite(v) && v >= 0 ? { kind: 'wait', ms: v } : err('wait ms must be a non-negative number.');
      if (obj(v) && (str(v.text) || str(v.id))) return { kind: 'wait', query: (v.text ?? v.id) as string };
      return err('wait needs ms (number) or { text|id }.');
    case 'networkOffline':
      return { kind: 'networkOffline' };
    case 'networkOnline':
      return { kind: 'networkOnline' };
    case 'seed':
      return str(v) ? { kind: 'seed', fixture: v } : err('seed needs a fixture name.');
    case 'note':
      if (str(v)) return { kind: 'note', outcome: 'pass', reason: v };
      if (obj(v) && str(v.reason)) {
        if (v.outcome != null && !OUTCOMES.includes(v.outcome as never))
          return err(`note outcome must be one of ${OUTCOMES.join('/')} (got ${JSON.stringify(v.outcome)}).`);
        return { kind: 'note', outcome: (v.outcome as NoteOutcome | undefined) ?? 'pass', reason: v.reason };
      }
      return err('note needs a string, or { outcome?, reason }.');
    case 'screenshot':
      return { kind: 'screenshot', reason: str(v) ? v : undefined };
    default:
      return err(`unknown action "${k}".`);
  }
}

/** `tap: 1` / `inputText: 123456` / `inputText: { text: 0042 }`: a plain YAML number where the
 *  step takes text is the text the author wrote. Keep its source spelling (YAML would turn 0042
 *  into 42 and 1.50 into 1.5, typing the wrong value) as a string. */
const TEXT_STEP_KEYS = new Set(['tap', 'inputText']);
function keepTypedTextAsWritten(doc: Document): void {
  const asWritten = (node: unknown): void => {
    if (isScalar(node) && typeof node.value === 'number' && typeof node.source === 'string') node.value = node.source;
  };
  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || !TEXT_STEP_KEYS.has(pair.key.value as string)) return;
      asWritten(pair.value);
      if (pair.key.value === 'inputText' && isMap(pair.value)) asWritten(pair.value.get('text', true));
    },
  });
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
  const screenshotCrop =
    crop && typeof crop === 'object' && !Array.isArray(crop)
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
    const parsed = parseDocument(yamlText);
    if (parsed.errors.length) throw parsed.errors[0];
    keepTypedTextAsWritten(parsed);
    doc = parsed.toJS();
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
  if (d.mode != null && !['structured', 'visual', 'auto'].includes(d.mode as string))
    errors.push('`mode` must be structured | visual | auto.');

  const setup = normalizeStepList(d.setup, 'setup', errors);
  const teardown = normalizeStepList(d.teardown, 'teardown', errors);
  const steps = normalizeStepList(d.steps, 'steps', errors);
  if (d.fixtures != null && (!Array.isArray(d.fixtures) || d.fixtures.some((f) => typeof f !== 'string')))
    errors.push('`fixtures` must be a list of fixture names.');
  const fixtures = Array.isArray(d.fixtures) ? d.fixtures.filter((f): f is string => typeof f === 'string') : [];
  const provenance = normalizeProvenance(d.provenance);

  if (errors.length) return { errors };
  return {
    flow: {
      name: d.name as string,
      appId: d.appId as string | undefined,
      budgetProfile: d.budgetProfile as string | undefined,
      mode,
      fixtures,
      setup,
      teardown,
      steps,
      provenance,
    },
    errors: [],
  };
}

/** Environment variables a flow may read implicitly. A flow file can come from an untrusted
 *  (cloned) repo, so `${NAME}` falls back to process.env ONLY for names with this prefix, never
 *  arbitrary server secrets like DATABASE_URL / AWS_SECRET_ACCESS_KEY (THREAT_MODEL). Explicit
 *  qa_flow_run `variables` and the session's stored inputs are not restricted. */
export const FLOW_ENV_PREFIX = 'SWIPIUM_';
const FLOW_ENV_NAME = /^SWIPIUM_/;

/** True when `${name}` may be read from process.env. */
export function flowEnvAllowed(name: string): boolean {
  return FLOW_ENV_NAME.test(name);
}

/** Value of `${name}`: explicit vars first, then process.env for SWIPIUM_* names only. An empty env
 *  value counts as missing: MCP configs often carry a blank placeholder ("SWIPIUM_TEST_PASSWORD": ""),
 *  which must block as missing test data rather than type "" and pass. */
export function lookupFlowVar(name: string, vars: Record<string, string>): string | undefined {
  const v = vars[name];
  if (v != null) return v;
  const env = flowEnvAllowed(name) ? process.env[name] : undefined;
  return env === '' ? undefined : env;
}

/** True when a string references at least one `${VAR}`. */
export function hasFlowVariable(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}

/** Steps that change app/device/test state (consent-gated; never run implicitly by qa_smoke).
 *  An `openUrl` that interpolates a `${VAR}` counts: the resolved value leaves the machine in the
 *  URL (deep link / browser), so it must be shown and approved. */
export function isMutatingFlowStep(step: FlowStep): boolean {
  if (step.kind === 'networkOffline' || step.kind === 'networkOnline' || step.kind === 'seed' || step.kind === 'restartApp') return true;
  return step.kind === 'openUrl' && hasFlowVariable(step.url);
}

/** Human-readable reason for a missing variable (says which env names are readable), e.g.
 *  "Variables not available: HOME (flows only read SWIPIUM_* environment variables; pass it via
 *  qa_flow_run { variables } or rename it SWIPIUM_HOME)". */
export function missingVarMessage(missing: string[]): string {
  const names = [...new Set(missing)];
  const it = names.length === 1 ? 'it' : 'them';
  const renamable = names.filter((n) => !flowEnvAllowed(n));
  const rename = renamable.length
    ? ` or rename ${renamable.length === 1 ? 'it' : 'them'} ${renamable.map((n) => `${FLOW_ENV_PREFIX}${n}`).join(', ')}`
    : ` or set ${it} in the Swipium server's environment`;
  return (
    `Variables not available: ${names.join(', ')} (flows only read ${FLOW_ENV_PREFIX}* environment variables; ` +
    `pass ${it} via qa_flow_run { variables }${rename})`
  );
}

/** Resolve ${VAR} from a variables map (then process.env, SWIPIUM_* names only). Returns the value + any missing names. */
export function resolveVars(value: string, vars: Record<string, string>): { out: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const v = lookupFlowVar(name, vars);
    if (v == null) {
      missing.push(name);
      return '';
    }
    return v;
  });
  return { out, missing };
}
