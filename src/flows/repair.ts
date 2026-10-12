import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withinRootOrNull } from './paths.js';
import { parse as parseYaml, stringify } from 'yaml';
import { suggestLocator, type LocatorPlatform, type LocatorSuggestion } from '../oracle/locator.js';
import { signature } from '../snapshot/parse.js';
import { parseFlow, type Flow, type FlowStep } from './schema.js';
import type { SnapshotElement } from '../drivers/Driver.js';
import type { FailureCode } from '../oracle/failures.js';

export type FlowRepairDriftCode =
  'screen_mismatch' | 'resource_id_missing' | 'duplicate_candidate' | 'text_or_label_drift' | 'role_changed';

export interface FlowRepairDriftFinding {
  code: FlowRepairDriftCode;
  message: string;
}

export interface FlowRepairSuggestion {
  failedStep: number;
  phase: 'setup' | 'steps' | 'teardown';
  phaseIndex: number;
  kind: string;
  originalSelector?: string;
  replacementSelector?: string;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  appCodeSuggestion?: string;
  platform?: LocatorPlatform;
  failureCode?: FailureCode;
  visualProvenanceRequired?: string[];
  driftFindings?: FlowRepairDriftFinding[];
  provenance?: {
    found: boolean;
    originalScreenSignature?: string;
    currentScreenSignature?: string;
    selectorKind?: string;
    selectorValue?: string;
  };
}

export interface FlowRepairResult {
  source: string;
  flow: string;
  suggestions: FlowRepairSuggestion[];
  proposedYaml?: string;
  patched?: boolean;
  /** True only when the source flow file was rewritten (apply at high/medium confidence). */
  applied?: boolean;
  notes?: string[];
  proposal?: FlowRepairProposal;
}

export interface FlowRepairProposal {
  kind: 'swipium.repair_proposal.v1';
  source: string;
  flow: string;
  failedStep: number;
  reviewRequired: true;
  beforeYaml: string;
  afterYaml?: string;
  unifiedDiff?: string;
  suggestions: FlowRepairSuggestion[];
  policy: {
    sourceFlowMutated: boolean;
    autoApplyRequested: boolean;
    humanReview: 'required_before_committing';
  };
}

export function resolveFlowSource(
  root: string,
  flow?: string,
  flowYaml?: string,
): { source: string; yaml: string; writable: boolean } | { error: string; errorCode?: 'PATH_OUTSIDE_ROOT' | 'FLOW_NOT_FOUND' } {
  if (flowYaml && flowYaml.trim()) return { source: 'inline', yaml: flowYaml, writable: false };
  if (!flow) return { error: 'Provide flow or flowYaml.' };
  // Confined to the project root (realpath + within-root): `apply` writes this file, so an
  // absolute path or ../ escape must never let a repair overwrite YAML elsewhere on disk.
  const raw = [flow, join('.swipium', 'flows', `${flow}.yaml`), join('.swipium', 'flows', `${flow}.yml`), join('.swipium', 'flows', flow)];
  const candidates = raw.map((p) => withinRootOrNull(root, p));
  if (candidates.every((p) => p === null) || candidates[0] === null)
    return {
      error: `Flow path "${flow}" resolves outside the project root (${root}). qa_flow_repair only reads and patches flows under the project root.`,
      errorCode: 'PATH_OUTSIDE_ROOT',
    };
  const path = candidates.find((p): p is string => !!p && existsSync(p));
  return path
    ? { source: path, yaml: readFileSync(path, 'utf8'), writable: true }
    : { error: `Flow not found: ${flow}`, errorCode: 'FLOW_NOT_FOUND' };
}

function stepAt(flow: Flow, failedStep: number): { phase: FlowRepairSuggestion['phase']; phaseIndex: number; step: FlowStep } | null {
  const setupEnd = flow.setup.length;
  const stepsEnd = setupEnd + flow.steps.length;
  if (failedStep < setupEnd) return { phase: 'setup', phaseIndex: failedStep, step: flow.setup[failedStep] };
  if (failedStep < stepsEnd) return { phase: 'steps', phaseIndex: failedStep - setupEnd, step: flow.steps[failedStep - setupEnd] };
  const ti = failedStep - stepsEnd;
  return ti >= 0 && ti < flow.teardown.length ? { phase: 'teardown', phaseIndex: ti, step: flow.teardown[ti] } : null;
}

function selectorOf(step: FlowStep): string | undefined {
  switch (step.kind) {
    case 'tap':
      return step.selector;
    case 'inputText':
      return step.into;
    case 'assertVisible':
    case 'assertNotVisible':
    case 'waitForVisible':
    case 'scrollTo':
      return step.query;
    case 'wait':
      return step.query;
    case 'tapImage':
    case 'assertImage':
      return step.template;
    case 'tapOcrText':
    case 'assertOcrText':
      return step.query;
    case 'assertDiff':
      return step.baseline;
    case 'assertVisual':
      return step.description;
    default:
      return undefined;
  }
}

function isVisualStep(step: FlowStep): boolean {
  return ['tapImage', 'tapOcrText', 'assertImage', 'assertOcrText', 'assertDiff', 'assertVisual'].includes(step.kind);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function currentScreenSignature(elements: SnapshotElement[]): string | undefined {
  if (!elements.length) return undefined;
  return createHash('sha1').update(elements.map(signature).sort().join('\n')).digest('hex').slice(0, 16);
}

interface FlowProvenanceEntry {
  generatedStepIndex?: number;
  stepIndex?: number;
  actionIndex?: number;
  generatedKind?: string;
  action?: string;
  selector?: string;
  selectorKind?: string;
  selectorValue?: string;
  originalScreenSignature?: string;
  elementRole?: string;
  className?: string;
  text?: string;
  accessibilityLabel?: string;
  resourceId?: string;
  boundsBucket?: string;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function provenanceEntries(yamlText: string): FlowProvenanceEntry[] {
  try {
    const doc = parseYaml(yamlText) as { provenance?: unknown };
    if (!Array.isArray(doc?.provenance)) return [];
    return doc.provenance
      .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw))
      .map((raw) => ({
        generatedStepIndex: numberField(raw.generatedStepIndex),
        stepIndex: numberField(raw.stepIndex),
        actionIndex: numberField(raw.actionIndex),
        generatedKind: stringField(raw.generatedKind),
        action: stringField(raw.action),
        selector: stringField(raw.selector),
        selectorKind: stringField(raw.selectorKind),
        selectorValue: stringField(raw.selectorValue),
        originalScreenSignature: stringField(raw.originalScreenSignature),
        elementRole: stringField(raw.elementRole),
        className: stringField(raw.className),
        text: stringField(raw.text),
        accessibilityLabel: stringField(raw.accessibilityLabel),
        resourceId: stringField(raw.resourceId),
        boundsBucket: stringField(raw.boundsBucket),
      }));
  } catch {
    return [];
  }
}

function provenanceForStep(yamlText: string, failedStep: number, originalSelector: string | undefined): FlowProvenanceEntry | undefined {
  const oneBased = failedStep + 1;
  const entries = provenanceEntries(yamlText);
  return (
    entries.find((e) => e.generatedStepIndex === oneBased) ??
    entries.find((e) => e.stepIndex === oneBased) ??
    (originalSelector
      ? entries.find((e) =>
          [e.selector, e.selectorValue, e.resourceId, e.text, e.accessibilityLabel].some((v) => v && norm(v) === norm(originalSelector)),
        )
      : undefined) ??
    (originalSelector
      ? entries.find((e) =>
          [e.selector, e.selectorValue, e.resourceId, e.text, e.accessibilityLabel].some(
            (v) => v && (norm(v).includes(norm(originalSelector)) || norm(originalSelector).includes(norm(v))),
          ),
        )
      : undefined)
  );
}

function byNorm(values: Array<string | undefined>, target: string | undefined): boolean {
  return !!target && values.some((v) => !!v && norm(v) === norm(target));
}

function containsNorm(values: Array<string | undefined>, target: string | undefined): boolean {
  return !!target && values.some((v) => !!v && (norm(v).includes(norm(target)) || norm(target).includes(norm(v))));
}

function driftFindings(
  provenance: FlowProvenanceEntry | undefined,
  elements: SnapshotElement[],
  picked: { element?: SnapshotElement },
): FlowRepairDriftFinding[] {
  if (!provenance) return [];
  const findings: FlowRepairDriftFinding[] = [];
  const currentSig = currentScreenSignature(elements);
  if (provenance.originalScreenSignature && currentSig && provenance.originalScreenSignature !== currentSig) {
    findings.push({
      code: 'screen_mismatch',
      message: `Recorded screen signature ${provenance.originalScreenSignature} differs from current screen ${currentSig}. Navigation may have failed before this step.`,
    });
  }
  if (provenance.resourceId) {
    const idMatches = elements.filter((e) => byNorm([e.id], provenance.resourceId));
    if (idMatches.length === 0) {
      findings.push({
        code: 'resource_id_missing',
        message: `Recorded resource id "${provenance.resourceId}" is not present on the current screen.`,
      });
    } else if (idMatches.length > 1) {
      findings.push({
        code: 'duplicate_candidate',
        message: `Recorded resource id "${provenance.resourceId}" now matches ${idMatches.length} elements; add a more specific testID/accessibilityIdentifier.`,
      });
    }
  }
  const oldLabel = provenance.accessibilityLabel ?? provenance.text;
  if (
    oldLabel &&
    !elements.some((e) => byNorm([e.label, e.text], oldLabel)) &&
    elements.some((e) => containsNorm([e.label, e.text], oldLabel))
  ) {
    findings.push({
      code: 'text_or_label_drift',
      message: `Recorded text/label "${oldLabel}" changed but a similar current label exists.`,
    });
  } else if (oldLabel && picked.element && !byNorm([picked.element.label, picked.element.text], oldLabel)) {
    findings.push({
      code: 'text_or_label_drift',
      message: `Recorded text/label "${oldLabel}" no longer identifies the proposed replacement.`,
    });
  }
  const oldRole = provenance.elementRole ?? provenance.className?.split('.').pop();
  if (oldRole && picked.element && norm(picked.element.role) !== norm(oldRole) && !norm(picked.element.role).endsWith(norm(oldRole))) {
    findings.push({
      code: 'role_changed',
      message: `Recorded element role "${oldRole}" differs from current candidate role "${picked.element.role}".`,
    });
  }
  return findings;
}

function driftRationale(findings: FlowRepairDriftFinding[]): string {
  if (!findings.length) return '';
  return ` Drift analysis: ${findings.map((f) => `${f.code}: ${f.message}`).join(' ')}`;
}

function desiredId(label: string, role: string): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'target';
  const suffix = /field|text/i.test(role) ? 'field' : /button|cell|link/i.test(role) ? 'button' : 'control';
  return `${base}_${suffix}`;
}

type RoleClass = 'field' | 'button' | 'text' | 'other';

/** Coarse role class so a repair never swaps a button for a text field (or vice versa). */
function roleClass(role: string | undefined, clickable?: boolean): RoleClass {
  const r = role ?? '';
  if (/EditText|text-?field|SearchField|TextInput|AutoComplete|Input/i.test(r)) return 'field';
  if (/Button|Link|Cell|Switch|CheckBox|Checkbox|RadioButton|Toggle|MenuItem|Tab/i.test(r)) return 'button';
  if (clickable) return 'button';
  if (/TextView|StaticText|Text|Label/i.test(r)) return 'text';
  return 'other';
}

/** Role class the failed step targeted: recorded provenance first, else implied by the step kind. */
function expectedRoleClass(step: FlowStep, provenance: FlowProvenanceEntry | undefined): RoleClass | undefined {
  const recorded = provenance?.elementRole ?? provenance?.className;
  if (recorded) return roleClass(recorded);
  if (step.kind === 'tap') return 'button';
  if (step.kind === 'inputText') return 'field';
  return undefined;
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Text similarity in [0,1] (Dice coefficient over character bigrams of normalized text). */
export function textSimilarity(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  if (!bx.length || !by.length) return 0;
  const pool = [...by];
  let hits = 0;
  for (const g of bx) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hits++;
      pool.splice(i, 1);
    }
  }
  return (2 * hits) / (bx.length + by.length);
}

/** Common UI wording that a rename swaps freely. Each word/phrase maps to one canonical token. */
const UI_SYNONYMS: Array<[string[], string]> = [
  [['sign in', 'signin', 'log in', 'login', 'logon', 'log on'], 'login'],
  [['sign out', 'signout', 'log out', 'logout', 'log off'], 'logout'],
  [['sign up', 'signup', 'register', 'create account'], 'signup'],
  [['apps', 'app', 'applications', 'application'], 'apps'],
  [['delete', 'remove', 'trash'], 'delete'],
  [['close', 'dismiss'], 'close'],
  [['ok', 'okay'], 'ok'],
  [['next', 'continue', 'proceed'], 'next'],
  [['back', 'previous', 'prev'], 'back'],
  [['search', 'find'], 'search'],
  [['settings', 'preferences', 'options'], 'settings'],
  [['edit', 'modify'], 'edit'],
  // Deliberately not folded (too broad, R3 code review): new/add/create, change, apply/save,
  // join/signup, account/profile. "New message" is not "Add contact".
];
/** Opposite actions: a candidate that swaps one side for the other is never proposed
 *  ("Sign out" missing because the user is logged out must not become "Sign in"). */
const ANTONYMS: Array<[string, string]> = [
  ['login', 'logout'],
  ['on', 'off'],
  ['enable', 'disable'],
  ['next', 'back'],
  ['open', 'close'],
  ['show', 'hide'],
  ['start', 'stop'],
  ['yes', 'no'],
  ['allow', 'deny'],
  ['accept', 'decline'],
  ['add', 'delete'],
  ['play', 'pause'],
  ['expand', 'collapse'],
  ['increase', 'decrease'],
];
const STOP_WORDS = new Set(['and', 'the', 'a', 'an', 'of', 'to', 'your', 'my', 'for', 'in', 'on']);
/** Words that say little about which control it is ("Display settings" vs "Search Settings"). */
const GENERIC_WORDS = new Set(['settings', 'button', 'menu', 'page', 'screen', 'tab', 'item', 'view']);

function canonicalTokens(s: string): string[] {
  let t = ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
  for (const [forms, canon] of UI_SYNONYMS) {
    for (const f of forms) t = t.split(` ${f} `).join(` ${canon} `);
  }
  return t
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .map((w) => UI_SYNONYMS.find(([forms]) => forms.includes(w))?.[1] ?? w);
}

/** Weighted word overlap in [0,1] after synonym folding and plural stripping. */
function wordSimilarity(a: string, b: string): number {
  const x = new Set(canonicalTokens(a));
  const y = new Set(canonicalTokens(b));
  if (!x.size || !y.size) return 0;
  const w = (t: string) => (GENERIC_WORDS.has(t) || GENERIC_WORDS.has(`${t}s`) ? 0.3 : 1);
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += w(t);
  const total = [...x].reduce((s, t) => s + w(t), 0) + [...y].reduce((s, t) => s + w(t), 0);
  return total ? (2 * shared) / total : 0;
}

const isGeneric = (t: string) => GENERIC_WORDS.has(t) || GENERIC_WORDS.has(`${t}s`);

const NEGATIONS = new Set(['not', 'no', 'never', 'dont', 'doesnt', 'didnt', 'cannot', 'cant', 'wont', 'isnt', 'without']);
/** "Don't", "Do not", "Not now", "No": straight or curly apostrophes. */
function hasNegation(s: string): boolean {
  return s
    .toLowerCase()
    .replace(/['‘’ʼ`]/g, '')
    .split(/[^a-z0-9]+/)
    .some((w) => NEGATIONS.has(w));
}

/** True when one label is the opposite action of the other (login/logout, lock/unlock, ...). */
export function isAntonymPair(a: string, b: string): boolean {
  // Raw words too: "on" is a stop word for ranking but matters here ("Turn on" vs "Turn off").
  const raw = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  const x = new Set([...canonicalTokens(a), ...raw(a)]);
  const y = new Set([...canonicalTokens(b), ...raw(b)]);
  const swaps = (p: string, q: string) => x.has(p) && !x.has(q) && y.has(q) && !y.has(p);
  // A negated label is the opposite of the bare one ("Don't allow" vs "Allow", "Do not save").
  if (hasNegation(a) !== hasNegation(b)) return true;
  for (const [p, q] of ANTONYMS) if (swaps(p, q) || swaps(q, p)) return true;
  for (const t of x) for (const pre of ['un', 'dis']) if (swaps(t, `${pre}${t}`)) return true;
  for (const t of y) for (const pre of ['un', 'dis']) if (swaps(`${pre}${t}`, t)) return true;
  return false;
}

/** True when the two labels share a word (after synonym folding) that is not a generic one. */
function sharesKeyToken(a: string, b: string): boolean {
  const y = new Set(canonicalTokens(b));
  return canonicalTokens(a).some((t) => y.has(t) && !isGeneric(t));
}

/** Character similarity with the generic words dropped, so a shared "settings" alone does not
 *  make "Battery settings" look like "Search Settings". */
function coreTextSimilarity(a: string, b: string): number {
  const core = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !isGeneric(w))
      .join(' ');
  return textSimilarity(core(a) || a, core(b) || b);
}

/** A low-confidence guess also needs real evidence: a shared non-generic word or synonym, or a high
 *  character similarity on the non-generic text (LOG-17: "Logout" > "Google", "Purchase history" >
 *  "Storage" share only a few bigrams). Opposite actions never qualify. */
function plausibleRename(value: string, selector: string): boolean {
  if (isAntonymPair(value, selector)) return false;
  return sharesKeyToken(value, selector) || coreTextSimilarity(value, selector) >= 0.5;
}

/** Lowercase words, camelCase split, plural-insensitive ("Notification" = "Notifications"). */
function containmentWords(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

/** Word-boundary containment with a 4-char minimum for the shorter side: "OK" is not inside
 *  "Book now", and "Go" or "On" do not match half the screen. */
function containsAsWords(a: string, b: string): boolean {
  const [x, y] = [containmentWords(a), containmentWords(b)];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (norm(short).length < 4) return false;
  return ` ${long} `.includes(` ${short} `);
}

/** Same words up to case, punctuation, camelCase and plurals: the only containment safe to auto-apply. */
function sameWords(a: string, b: string): boolean {
  const x = containmentWords(a);
  return !!x && x === containmentWords(b);
}

/** Repair ranking score: character similarity plus word/synonym overlap, so "Sign in" > "Log in"
 *  and "Applications" > "Apps" rank above look-alike strings ("Notifications"). */
function candidateSimilarity(value: string | undefined, selector: string | undefined): number {
  if (!value || !selector) return 0;
  return 0.5 * textSimilarity(value, selector) + 0.5 * wordSimilarity(value, selector);
}

/** Below this score a no-text-match guess is unrelated and is not proposed (LOG-17). Sits between
 *  real renames ("Sign in" > "Log in" ~0.6) and noise ("Network and internet" > "Clear text" ~0.04). */
const MIN_GUESS_SIMILARITY = 0.15;

function boundsCenterOfBucket(bucket: string | undefined): { x: number; y: number } | undefined {
  const n = bucket?.split(',').map(Number);
  if (!n || n.length !== 4 || n.some((v) => !Number.isFinite(v))) return undefined;
  return { x: (n[0] + n[2]) / 2, y: (n[1] + n[3]) / 2 };
}

function chooseReplacement(
  selector: string | undefined,
  elements: SnapshotElement[],
  platform: LocatorPlatform,
  expected?: RoleClass,
  recordedBounds?: string,
): {
  element?: SnapshotElement;
  suggestion?: LocatorSuggestion;
  confidence: FlowRepairSuggestion['confidence'];
  /** A word-containment match with extra words: related, but maybe a different action. */
  partial?: boolean;
} {
  const scored = elements.map((el) => ({ el, suggestion: suggestLocator(el, { platform }) }));
  const compatible = (el: SnapshotElement): boolean => {
    if (!expected) return true;
    const c = roleClass(el.role, el.clickable);
    // A tap target may be a clickable text/label; a field target must be a field.
    if (expected === 'button') return c === 'button';
    if (expected === 'field') return c === 'field';
    return c === expected;
  };
  if (selector) {
    const n = norm(selector);
    const exact = scored.find(({ el }) => [el.id, el.label, el.text].some((v) => v && norm(v) === n));
    if (exact) return { element: exact.el, suggestion: exact.suggestion, confidence: 'high' };
    // Medium confidence is auto-applied, so only a same-words match (case, punctuation, plural:
    // "Notification" > "Notifications") gets it. Containment with extra words changes what the
    // control does ("Delete" > "Delete account", "Settings" > "Search Settings", "Turn on X" > "X"),
    // so it is a low-confidence proposal only, and only with real evidence. Opposites never qualify.
    const same = scored.find(
      ({ el }) => compatible(el) && [el.id, el.label, el.text].some((v) => v && sameWords(v, selector) && !isAntonymPair(v, selector)),
    );
    if (same) return { element: same.el, suggestion: same.suggestion, confidence: 'medium' };
    const contains = scored.find(
      ({ el }) =>
        compatible(el) && [el.id, el.label, el.text].some((v) => v && containsAsWords(v, selector) && plausibleRename(v, selector)),
    );
    if (contains) return { element: contains.el, suggestion: contains.suggestion, confidence: 'low', partial: true };
  }
  // No text match: rank same-role candidates by text similarity to the failed selector, then
  // durability. Never fall back to "first stable element" of an unrelated role (a renamed
  // "Sign in" button must not become the "Email" field).
  const durable = (s: LocatorSuggestion) => !!s.locator && (s.tier === 'accessibility' || s.tier === 'resource_id');
  const pool = scored.filter(({ el }) => compatible(el));
  // Position is a small tie-breaker only (it never lifts an unrelated control over the cutoff):
  // a renamed control usually stays where it was recorded.
  const anchor = boundsCenterOfBucket(recordedBounds);
  const nearness = (el: SnapshotElement): number => {
    if (!anchor || !el.bounds) return 0;
    const dx = (el.bounds[0] + el.bounds[2]) / 2 - anchor.x;
    const dy = (el.bounds[1] + el.bounds[3]) / 2 - anchor.y;
    return 0.05 / (1 + Math.hypot(dx, dy) / 200);
  };
  const ranked = pool
    .map((c, i) => {
      const sim = Math.max(
        0,
        ...[c.el.id, c.el.label, c.el.text].map((v) =>
          v && selector && !plausibleRename(v, selector) ? 0 : candidateSimilarity(v, selector),
        ),
      );
      return { ...c, i, sim, rank: sim + nearness(c.el) };
    })
    .sort((a, b) => b.rank - a.rank || Number(durable(b.suggestion)) - Number(durable(a.suggestion)) || a.i - b.i);
  const best = ranked[0];
  // With a failed selector to compare against, a candidate with negligible text similarity is
  // noise ("Network and internet" -> "Clear text"): propose nothing rather than an unrelated element.
  if (best && selector && best.sim < MIN_GUESS_SIMILARITY) return { confidence: 'low' };
  if (best) return { element: best.el, suggestion: best.suggestion, confidence: 'low' };
  return { confidence: 'low' };
}

function selectorForSuggestion(
  suggestion: LocatorSuggestion | undefined,
  element: SnapshotElement | undefined,
  platform: LocatorPlatform,
): string | undefined {
  if (!suggestion?.locator) return element?.text ?? element?.label ?? element?.id;
  if (platform === 'ios') {
    if (suggestion.locatorKind === 'accessibility_identifier') return `accessibility id=${suggestion.locator}`;
    if (suggestion.locatorKind === 'visible_text' || suggestion.locatorKind === 'accessibility_label') return suggestion.locator;
  }
  return suggestion.locator;
}

function applyReplacement(
  yamlText: string,
  phase: FlowRepairSuggestion['phase'],
  phaseIndex: number,
  step: FlowStep,
  replacement: string,
): string | null {
  const doc = parseYaml(yamlText) as Record<string, unknown>;
  const key = phase === 'steps' ? 'steps' : phase;
  const list = doc[key];
  if (!Array.isArray(list) || !list[phaseIndex]) return null;
  const raw = list[phaseIndex] as Record<string, unknown>;
  switch (step.kind) {
    case 'tap':
      list[phaseIndex] = { tap: replacement };
      break;
    case 'inputText': {
      const v = raw.inputText;
      list[phaseIndex] = {
        inputText:
          typeof v === 'object' && v
            ? { ...(v as Record<string, unknown>), into: replacement }
            : { into: replacement, text: step.value, secret: step.secret },
      };
      break;
    }
    case 'assertVisible':
      list[phaseIndex] = { assertVisible: replacement };
      break;
    case 'assertNotVisible':
      list[phaseIndex] = { assertNotVisible: replacement };
      break;
    case 'waitForVisible':
      list[phaseIndex] = { waitForVisible: replacement };
      break;
    case 'scrollTo':
      list[phaseIndex] = { scrollTo: replacement };
      break;
    default:
      return null;
  }
  return stringify(doc);
}

function unifiedDiff(before: string, after: string, source: string): string {
  const beforeLines = before.replace(/\n$/, '').split('\n');
  const afterLines = after.replace(/\n$/, '').split('\n');
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start++;
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
    endBefore--;
    endAfter--;
  }
  const removed = beforeLines.slice(start, endBefore + 1);
  const added = afterLines.slice(start, endAfter + 1);
  const beforeStart = start + 1;
  const afterStart = start + 1;
  return [
    `--- ${source}`,
    `+++ ${source} (repair proposal)`,
    `@@ -${beforeStart},${removed.length} +${afterStart},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function makeProposal(opts: {
  source: string;
  flow: string;
  failedStep: number;
  beforeYaml: string;
  afterYaml?: string;
  suggestions: FlowRepairSuggestion[];
  applyRequested: boolean;
  patched: boolean;
}): FlowRepairProposal {
  return {
    kind: 'swipium.repair_proposal.v1',
    source: opts.source,
    flow: opts.flow,
    failedStep: opts.failedStep,
    reviewRequired: true,
    beforeYaml: opts.beforeYaml,
    afterYaml: opts.afterYaml,
    unifiedDiff: opts.afterYaml ? unifiedDiff(opts.beforeYaml, opts.afterYaml, opts.source) : undefined,
    suggestions: opts.suggestions,
    policy: {
      sourceFlowMutated: opts.patched,
      autoApplyRequested: opts.applyRequested,
      humanReview: 'required_before_committing',
    },
  };
}

export function repairFlow(opts: {
  root: string;
  flow?: string;
  flowYaml?: string;
  failedStep: number;
  elements: SnapshotElement[];
  apply?: boolean;
  platform?: LocatorPlatform;
}): FlowRepairResult | { error: string; errorCode?: 'PATH_OUTSIDE_ROOT' | 'FLOW_NOT_FOUND' } {
  const src = resolveFlowSource(opts.root, opts.flow, opts.flowYaml);
  if ('error' in src) return src;
  const parsed = parseFlow(src.yaml);
  if (parsed.errors.length || !parsed.flow) return { error: `Flow is invalid: ${parsed.errors.join('; ')}` };
  const at = stepAt(parsed.flow, opts.failedStep);
  if (!at) return { error: `failedStep ${opts.failedStep} is outside the flow step range.` };
  const platform = opts.platform ?? 'generic';
  const originalSelector = selectorOf(at.step);
  const currentSig = currentScreenSignature(opts.elements);
  if (isVisualStep(at.step)) {
    const fallback = chooseReplacement(undefined, opts.elements, platform);
    const replacementSelector = selectorForSuggestion(fallback.suggestion, fallback.element, platform);
    const suggestions: FlowRepairSuggestion[] = [
      {
        failedStep: opts.failedStep,
        phase: at.phase,
        phaseIndex: at.phaseIndex,
        kind: at.step.kind,
        originalSelector,
        replacementSelector,
        confidence: replacementSelector ? 'low' : 'medium',
        rationale: replacementSelector
          ? 'Visual/OCR locator drift suspected. Refresh the visual evidence and consider this structured fallback locator.'
          : 'Visual/OCR locator drift suspected. Refresh the screenshot crop/OCR text, confidence threshold, locale/theme/density/orientation metadata, and rerun.',
        appCodeSuggestion: replacementSelector
          ? undefined
          : 'Expose a stable accessibilityIdentifier/testID near this visual target so replay can fall back to structure.',
        platform,
        failureCode: 'VISUAL_LOCATOR_DRIFT',
        visualProvenanceRequired: [
          'screenshot crop',
          'OCR text/confidence',
          'locale',
          'theme',
          'density',
          'orientation',
          'fallback structured locator',
        ],
        provenance: { found: false, currentScreenSignature: currentSig },
      },
    ];
    return {
      source: src.source,
      flow: parsed.flow.name,
      suggestions,
      proposal: makeProposal({
        source: src.source,
        flow: parsed.flow.name,
        failedStep: opts.failedStep,
        beforeYaml: src.yaml,
        suggestions,
        applyRequested: Boolean(opts.apply),
        patched: false,
      }),
    };
  }
  const provenance = provenanceForStep(src.yaml, opts.failedStep, originalSelector);
  const picked = chooseReplacement(
    originalSelector,
    opts.elements,
    platform,
    expectedRoleClass(at.step, provenance),
    provenance?.boundsBucket,
  );
  const replacementSelector = selectorForSuggestion(picked.suggestion, picked.element, platform);
  const drift = driftFindings(provenance, opts.elements, picked);
  const label = picked.element?.label ?? picked.element?.text ?? originalSelector ?? 'target';
  const appCodeSuggestion =
    picked.suggestion?.needsTestId || !picked.suggestion?.locator
      ? `Add accessibilityIdentifier/testID "${desiredId(label, picked.element?.role ?? at.step.kind)}" to this ${picked.element?.role ?? 'control'}.`
      : undefined;
  const suggestion: FlowRepairSuggestion = {
    failedStep: opts.failedStep,
    phase: at.phase,
    phaseIndex: at.phaseIndex,
    kind: at.step.kind,
    originalSelector,
    replacementSelector,
    confidence: picked.confidence,
    rationale: replacementSelector
      ? `Replace the failed selector with a ${picked.suggestion?.tier ?? 'visible'} locator from the current ${platform} screen.${driftRationale(drift)}`
      : originalSelector && !picked.element
        ? `No element on the current screen resembles "${originalSelector}"; no replacement proposed (is the app on the right screen?).${driftRationale(drift)}`
        : `No durable locator was available on the current screen.${driftRationale(drift)}`,
    appCodeSuggestion,
    platform,
    driftFindings: drift.length ? drift : undefined,
    provenance: {
      found: !!provenance,
      originalScreenSignature: provenance?.originalScreenSignature,
      currentScreenSignature: currentSig,
      selectorKind: provenance?.selectorKind,
      selectorValue:
        provenance?.selectorValue ?? provenance?.selector ?? provenance?.resourceId ?? provenance?.text ?? provenance?.accessibilityLabel,
    },
  };
  let proposedYaml: string | undefined;
  let patched = false;
  const notes: string[] = [];
  if (replacementSelector) {
    proposedYaml = applyReplacement(src.yaml, at.phase, at.phaseIndex, at.step, replacementSelector) ?? undefined;
    if (opts.apply && proposedYaml && src.writable) {
      // Never auto-apply a guess: low confidence means no exact-words match to the failed selector.
      if (picked.confidence === 'low')
        notes.push(
          picked.partial
            ? `apply refused: the proposal only contains "${originalSelector ?? 'target'}" with extra words, so it may be a different action. Review proposedYaml and apply it manually if correct.`
            : `apply refused: the proposal is low confidence (no text match for "${originalSelector ?? 'target'}"). Review proposedYaml and apply it manually if correct.`,
        );
      else {
        writeFileSync(src.source, proposedYaml);
        patched = true;
      }
    }
  }
  if (opts.apply && !src.writable) notes.push('apply ignored: inline flowYaml has no file to patch.');
  const suggestions = [suggestion];
  return {
    source: src.source,
    flow: parsed.flow.name,
    suggestions,
    proposedYaml,
    patched,
    applied: patched,
    ...(notes.length ? { notes } : {}),
    proposal: makeProposal({
      source: src.source,
      flow: parsed.flow.name,
      failedStep: opts.failedStep,
      beforeYaml: src.yaml,
      afterYaml: proposedYaml,
      suggestions,
      applyRequested: Boolean(opts.apply),
      patched,
    }),
  };
}
