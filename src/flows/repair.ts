import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
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
): { source: string; yaml: string; writable: boolean } | { error: string } {
  if (flowYaml && flowYaml.trim()) return { source: 'inline', yaml: flowYaml, writable: false };
  if (!flow) return { error: 'Provide flow or flowYaml.' };
  const candidates = isAbsolute(flow)
    ? [flow]
    : [
        join(root, flow),
        join(root, '.swipium', 'flows', `${flow}.yaml`),
        join(root, '.swipium', 'flows', `${flow}.yml`),
        join(root, '.swipium', 'flows', flow),
      ];
  const path = candidates.find((p) => existsSync(p));
  return path ? { source: path, yaml: readFileSync(path, 'utf8'), writable: true } : { error: `Flow not found: ${flow}` };
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

function chooseReplacement(
  selector: string | undefined,
  elements: SnapshotElement[],
  platform: LocatorPlatform,
): { element?: SnapshotElement; suggestion?: LocatorSuggestion; confidence: FlowRepairSuggestion['confidence'] } {
  const scored = elements.map((el) => ({ el, suggestion: suggestLocator(el, { platform }) }));
  if (selector) {
    const n = norm(selector);
    const exact = scored.find(({ el }) => [el.id, el.label, el.text].some((v) => v && norm(v) === n));
    if (exact) return { ...exact, confidence: 'high' };
    const contains = scored.find(({ el }) => [el.id, el.label, el.text].some((v) => v && (norm(v).includes(n) || n.includes(norm(v)))));
    if (contains) return { ...contains, confidence: 'medium' };
  }
  const durable = scored.find(
    ({ suggestion }) => suggestion.locator && (suggestion.tier === 'accessibility' || suggestion.tier === 'resource_id'),
  );
  if (durable) return { ...durable, confidence: 'low' };
  return { ...scored[0], confidence: 'low' };
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
}): FlowRepairResult | { error: string } {
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
  const picked = chooseReplacement(originalSelector, opts.elements, platform);
  const replacementSelector = selectorForSuggestion(picked.suggestion, picked.element, platform);
  const provenance = provenanceForStep(src.yaml, opts.failedStep, originalSelector);
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
  if (replacementSelector) {
    proposedYaml = applyReplacement(src.yaml, at.phase, at.phaseIndex, at.step, replacementSelector) ?? undefined;
    if (opts.apply && proposedYaml && src.writable) {
      writeFileSync(src.source, proposedYaml);
      patched = true;
    }
  }
  const suggestions = [suggestion];
  return {
    source: src.source,
    flow: parsed.flow.name,
    suggestions,
    proposedYaml,
    patched,
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
