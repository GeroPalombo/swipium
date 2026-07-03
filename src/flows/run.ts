// Flow runner v2 (NEXT-PLAN: Flow System V2). Drives a parsed Flow step-by-step using core
// primitives + the driver directly, WITHOUT re-entering through the model. Fail-fast, never
// auto-retries (DESIGN §6). v2 adds: setup/teardown phases (teardown always runs), selector-bound
// inputText, visual steps (image match / diff / visual evidence), device-relative gestures,
// overlay/network/lifecycle/seed/note steps, and typed per-step failure codes. On failure it
// captures a screenshot + health so the result stands alone.

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSnapshot, signature } from '../snapshot/parse.js';
import { settle } from '../snapshot/settle.js';
import { checkHealth } from '../oracle/health.js';
import { recordHealthFindings } from '../oracle/record.js';
import { boundsBucket, resolveTarget, resourceIdMatches, type Target } from '../core/target.js';
import { imageDiff, findTemplate } from '../lib/image.js';
import { captureCoordinateSpace, toDevicePoint } from '../lib/coordSpace.js';
import { executeSeed } from './seedExec.js';
import { resolveVars, type Flow, type FlowProvenanceEntry, type FlowStep, type SwipeArea } from './schema.js';
import { configuredOcrCommand, findOcrRegion, runOcr } from '../visual/ocr.js';
import { makeRedactor } from '../lib/redact.js';
import type { FailureCode } from '../oracle/failures.js';
import type { Driver, NativeSelectorStrategy } from '../drivers/Driver.js';
import type { MutationRecord, Session, SessionStore } from '../session/store.js';

export interface FlowStepResult {
  index: number;
  phase: 'setup' | 'main' | 'teardown';
  kind: string;
  summary: string;
  ok: boolean;
  durationMs?: number;
  detail?: string;
  failureCode?: FailureCode;
  screenshotUri?: string;
}

export interface FlowRunResult {
  name: string;
  appId?: string;
  passed: boolean;
  failedAtStep?: number;
  reason?: string;
  failureCode?: FailureCode;
  steps: FlowStepResult[];
  nativeHealth?: string;
  appHealth?: string;
  durationMs: number;
  counters: Session['counters'];
}

const FALLBACK_SWIPE: Record<string, [number, number, number, number]> = {
  up: [540, 1500, 540, 600],
  down: [540, 600, 540, 1500],
  left: [800, 1100, 200, 1100],
  right: [200, 1100, 800, 1100],
};
const AREA_ANCHOR: Record<SwipeArea, [number, number]> = {
  center: [0.5, 0.5],
  top: [0.5, 0.3],
  bottom: [0.5, 0.7],
  left: [0.3, 0.5],
  right: [0.7, 0.5],
};
const SECRET_VAR_NAME = /pass|secret|token|otp|pin|cvv|key/i;

/** Device-relative swipe vector (fractions of the screen), falling back to fixed coords if no size. */
function swipeVector(
  size: { width: number; height: number } | null,
  dir: 'up' | 'down' | 'left' | 'right',
  area: SwipeArea = 'center',
  distance = 0.6,
): [number, number, number, number] {
  if (!size) return FALLBACK_SWIPE[dir];
  const [ax, ay] = AREA_ANCHOR[area];
  const cx = size.width * ax;
  const cy = size.height * ay;
  const vd = (size.height * distance) / 2;
  const hd = (size.width * distance) / 2;
  const clampX = (x: number) => Math.max(1, Math.min(size.width - 1, Math.round(x)));
  const clampY = (y: number) => Math.max(1, Math.min(size.height - 1, Math.round(y)));
  const v = {
    up: [cx, cy + vd, cx, cy - vd],
    down: [cx, cy - vd, cx, cy + vd],
    left: [cx + hd, cy, cx - hd, cy],
    right: [cx - hd, cy, cx + hd, cy],
  }[dir];
  return [clampX(v[0]), clampY(v[1]), clampX(v[2]), clampY(v[3])];
}

function describe(step: FlowStep): string {
  switch (step.kind) {
    case 'tap':
      return `tap ${step.selector}`;
    case 'tapAt':
      return `tapAt ${step.x},${step.y}`;
    case 'tapImage':
      return `tapImage ${step.template}`;
    case 'tapOcrText':
      return `tapOcrText ${JSON.stringify(step.query)}`;
    case 'inputText':
      return `inputText${step.into ? ` into "${step.into}"` : ''} ${step.secret ? '«secret»' : JSON.stringify(step.value)}`;
    case 'assertVisible':
      return `assertVisible ${JSON.stringify(step.query)}`;
    case 'assertNotVisible':
      return `assertNotVisible ${JSON.stringify(step.query)}`;
    case 'assertImage':
      return `assertImage ${step.template}`;
    case 'assertOcrText':
      return `assertOcrText ${JSON.stringify(step.query)}`;
    case 'assertVisual':
      return `assertVisual ${JSON.stringify(step.description)}`;
    case 'assertDiff':
      return `assertDiff ${step.baseline}`;
    case 'swipe':
      return `swipe ${step.direction}${step.area ? `@${step.area}` : ''}`;
    case 'scrollTo':
      return `scrollTo ${JSON.stringify(step.query)}`;
    case 'press':
      return `press ${step.key}`;
    case 'openUrl':
      return `openUrl ${step.url}`;
    case 'wait':
      return step.ms != null ? `wait ${step.ms}ms` : `wait for ${JSON.stringify(step.query)}`;
    case 'waitForIdle':
      return 'waitForIdle';
    case 'waitForVisible':
      return `waitForVisible ${JSON.stringify(step.query)}`;
    case 'clearOverlay':
      return 'clearOverlay';
    case 'networkOffline':
      return 'networkOffline';
    case 'networkOnline':
      return 'networkOnline';
    case 'restartApp':
      return 'restartApp';
    case 'seed':
      return `seed ${step.fixture}`;
    case 'note':
      return `note(${step.outcome}) ${JSON.stringify(step.reason)}`;
    case 'screenshot':
      return 'screenshot';
    case 'prepareTarget':
      return 'prepareTarget';
  }
}

async function snapshot(session: Session, d: Driver) {
  const parsed = parseSnapshot(await d.dumpXml());
  session.lastSnapshot = { fullByRef: parsed.fullByRef, signatures: new Set(parsed.elements.map(signature)), allNodes: parsed.allNodes };
  return parsed;
}
function visible(parsed: { allNodes: { text: string; desc: string; id: string }[] }, query: string): boolean {
  const q = query.toLowerCase();
  return parsed.allNodes.some(
    (n) => n.text?.toLowerCase().includes(q) || n.desc?.toLowerCase().includes(q) || n.id?.toLowerCase().includes(q),
  );
}

interface NativeSelector {
  using: NativeSelectorStrategy;
  value: string;
}

function nativeSelectorFor(selector: string): NativeSelector | null {
  const m = selector.match(/^(accessibility id|name|predicate string|class chain)\s*=\s*(.+)$/i);
  if (!m) return null;
  return { using: m[1].toLowerCase() as NativeSelectorStrategy, value: m[2] };
}

function resourceIdSelector(selector: string): string | null {
  return selector.match(/^id\s*=\s*(.+)$/i)?.[1] ?? null;
}

function provenanceForStep(flow: Flow, stepIndex: number, kind: string): FlowProvenanceEntry | undefined {
  const oneBased = stepIndex + 1;
  return (flow.provenance ?? []).find(
    (entry) =>
      entry.generatedStepIndex === oneBased &&
      (!entry.generatedKind || entry.generatedKind === kind || (kind === 'wait' && entry.generatedKind === 'waitForVisible')),
  );
}

function targetHintsFromProvenance(provenance?: FlowProvenanceEntry): Partial<Target> {
  if (!provenance) return {};
  return {
    packageName: provenance.resourceId?.includes(':id/')
      ? provenance.resourceId.slice(0, provenance.resourceId.indexOf(':id/'))
      : undefined,
    className: provenance.className ?? provenance.elementRole,
    textHint: provenance.text ?? provenance.accessibilityLabel,
    boundsHint: provenance.boundsBucket,
    screenSignature: provenance.originalScreenSignature,
  };
}

function targetForTapSelector(selector: string, provenance?: FlowProvenanceEntry): Target {
  const m = selector.match(/^id\s*=\s*(.+)$/i);
  if (m) return { id: m[1], ...targetHintsFromProvenance(provenance) };
  const native = nativeSelectorFor(selector);
  if (native?.using === 'accessibility id') return { id: native.value };
  if (native?.using === 'name') return { text: native.value };
  return selector.startsWith('@') ? { ref: selector } : { text: selector };
}

async function nativeVisible(d: Driver, selector: string): Promise<boolean | null> {
  const native = nativeSelectorFor(selector);
  if (!native) return null;
  if (!d.existsBySelector) {
    if (native.using !== 'accessibility id' && native.using !== 'name')
      throw new Error(`${native.using} selectors require backend-native selector support`);
    return null;
  }
  return d.existsBySelector(native.using, native.value);
}

function fallbackVisibleQuery(selector: string): string {
  const native = nativeSelectorFor(selector);
  const id = selector.match(/^id\s*=\s*(.+)$/i)?.[1];
  if (id) return id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return native && (native.using === 'accessibility id' || native.using === 'name') ? native.value : selector;
}

function flowScreenSignature(parsed: Awaited<ReturnType<typeof snapshot>>): string | undefined {
  const sigs = parsed.elements.map(signature);
  if (!sigs.length) return undefined;
  return createHash('sha1').update(sigs.sort().join('\n')).digest('hex').slice(0, 16);
}

function narrowRawResourceMatches<
  T extends { cls: string; text: string; desc: string; bounds: [number, number, number, number]; attrs?: Record<string, string> },
>(matches: T[], provenance?: FlowProvenanceEntry): T[] {
  let narrowed = matches;
  const tryNarrow = (fn: (node: T) => boolean) => {
    const next = narrowed.filter(fn);
    if (next.length) narrowed = next;
  };
  if (provenance?.resourceId?.includes(':id/')) {
    const pkg = provenance.resourceId.slice(0, provenance.resourceId.indexOf(':id/'));
    tryNarrow((node) => node.attrs?.['resource-id']?.startsWith(`${pkg}:id/`) === true);
  }
  const cls = provenance?.className ?? provenance?.elementRole;
  if (cls) {
    const wanted = cls.trim().toLowerCase();
    tryNarrow((node) => {
      const got = node.cls.trim().toLowerCase();
      return got === wanted || got.endsWith(`.${wanted}`);
    });
  }
  const textHint = provenance?.text ?? provenance?.accessibilityLabel;
  if (textHint) {
    const wanted = textHint.trim().toLowerCase();
    tryNarrow((node) => node.text.trim().toLowerCase() === wanted || node.desc.trim().toLowerCase() === wanted);
  }
  if (provenance?.boundsBucket) {
    tryNarrow((node) => boundsBucket(node.bounds) === provenance.boundsBucket);
  }
  return narrowed;
}

async function resourceIdVisibility(
  session: Session,
  d: Driver,
  id: string,
  provenance?: FlowProvenanceEntry,
): Promise<{ visible: boolean; ambiguous?: boolean; detail?: string }> {
  const parsed = await snapshot(session, d);
  const matches = parsed.allNodes.filter((node) => resourceIdMatches(undefined, node.id, id));
  const screenMismatch = provenance?.originalScreenSignature && flowScreenSignature(parsed) !== provenance.originalScreenSignature;
  if (!matches.length)
    return {
      visible: false,
      detail: `resource-id "${id}" not visible${screenMismatch ? ' (recorded screen signature differs from current screen)' : ''}`,
    };
  const narrowed = matches.length > 1 ? narrowRawResourceMatches(matches, provenance) : matches;
  if (narrowed.length > 1) {
    const labels = narrowed.map((node, index) => `${index + 1}:${node.cls}:${node.text || node.desc || node.id || 'unlabeled'}`).join(', ');
    return {
      visible: true,
      ambiguous: true,
      detail: `AMBIGUOUS_SELECTOR: resource-id ${id} matched ${narrowed.length} visible nodes (${labels}); add text/class/bounds hints or a unique testID${screenMismatch ? ' (recorded screen signature differs from current screen)' : ''}.`,
    };
  }
  const node = narrowed[0];
  return { visible: node.enabled !== false && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1] };
}

interface StepOutcome {
  ok: boolean;
  detail?: string;
  failureCode?: FailureCode;
}

export function classifyFlowDriverError(error: unknown, fallback: FailureCode = 'UNKNOWN'): FailureCode {
  const msg = String((error as Error)?.message ?? error);
  if (/not hittable|not hit.?point|not visible.*hittable|is not enabled|element.*obscured|other element.*would receive/i.test(msg))
    return 'ELEMENT_NOT_HITTABLE';
  if (/stale element|stale.*reference|element.*no longer|invalid element/i.test(msg)) return 'STALE_REF';
  if (
    /invalid selector|invalid locator|unsupported locator|unsupported selector|locator strategy.*(invalid|unsupported)|selector strategy.*(invalid|unsupported)|predicate.*parse|class chain.*parse/i.test(
      msg,
    )
  )
    return 'INVALID_SELECTOR';
  if (/AMBIGUOUS_SELECTOR|ambiguous selector|matched \d+ elements/i.test(msg)) return 'AMBIGUOUS_SELECTOR';
  if (/keyboard.*cover|keyboard.*obstruct|covered by keyboard/i.test(msg)) return 'KEYBOARD_OBSTRUCTION';
  if (/animation.*idle|idle.*animation|cannot become idle because of animation/i.test(msg)) return 'ANIMATION_IDLE_BLOCKED';
  if (/timed out waiting.*idle|wait.*idle.*timed out|not idle/i.test(msg)) return 'UI_IDLE_TIMEOUT';
  if (/wda.*not idle|xctest.*idle|app.*not idle/i.test(msg)) return 'WDA_APP_NOT_IDLE';
  if (/xpath/i.test(msg)) return 'WDA_XPATH_REFUSED';
  if (/main thread|event loop.*blocked/i.test(msg)) return 'WDA_MAIN_THREAD_BUSY';
  if (/hierarchy.*(large|too deep)|snapshot.*too deep|snapshot.*exceeded.*depth|depth.*snapshot|exceeded.*snapshot/i.test(msg))
    return 'WDA_HIERARCHY_TOO_LARGE';
  if (/source.*slow|page source.*slow/i.test(msg)) return 'WDA_SOURCE_SLOW';
  if (/snapshot|source|dump|hierarchy/i.test(msg)) return 'SNAPSHOT_FAILED';
  if (/webview|web view|context unavailable/i.test(msg)) return 'WEBVIEW_UNAVAILABLE';
  if (/no such element|element.*not found|could not resolve element|unable to locate|not visible/i.test(msg)) return 'ELEMENT_NOT_FOUND';
  if (/WDA HTTP|session not created|invalid session|did not return a sessionId|failed to create.*session/i.test(msg))
    return 'WDA_SESSION_FAILED';
  if (/ECONNREFUSED|fetch failed|timed out|aborted|network|socket|unreachable/i.test(msg)) return 'WDA_UNREACHABLE';
  return fallback;
}

export async function runFlow(
  sessions: SessionStore,
  session: Session,
  d: Driver,
  flow: Flow,
  opts: { variables?: Record<string, string>; mutationConsent?: MutationRecord['consent'] & { payloadHash?: string } } = {},
): Promise<FlowRunResult> {
  const vars = { ...Object.fromEntries(session.inputValues.entries()), ...(opts.variables ?? {}) };
  const started = Date.now();
  const steps: FlowStepResult[] = [];
  const appId = flow.appId ?? session.appId;
  const timeoutMs = 8000;
  // Ensure session.driver is the driver we're running with — core helpers (resolveTarget) read it.
  session.driver = d;
  const screenSize = await d.screenSize().catch(() => null);
  const mutationConsent = opts.mutationConsent ?? { required: false, approved: true };

  const resolveFlowText = (value: string): { out: string; missing: string[] } => {
    const resolved = resolveVars(value, vars);
    for (const m of value.matchAll(/\$\{([^}]+)\}/g)) {
      const name = m[1];
      const v = vars[name] ?? process.env[name];
      if (v != null && SECRET_VAR_NAME.test(name)) session.secrets.add(v);
    }
    return resolved;
  };
  const unresolved = (missing: string[]): StepOutcome => ({
    ok: false,
    detail: `unresolved variable(s): ${missing.join(', ')}`,
    failureCode: 'MISSING_FIXTURE',
  });
  const shown = (value: string): string => makeRedactor(session.secrets)(value) ?? value;

  const recordFlowMutation = (
    action: string,
    risk: MutationRecord['risk'],
    target: Record<string, unknown>,
    status: MutationRecord['status'],
    detail?: string,
  ): void => {
    sessions.recordMutation(session, {
      tool: 'qa_flow_run',
      action,
      risk,
      target: { flow: flow.name, appId: appId ?? null, ...target },
      consent: mutationConsent,
      status,
      detail,
    });
  };

  let passed = true;
  let failedAtStep: number | undefined;
  let reason: string | undefined;
  let failureCode: FailureCode | undefined;

  const tapImageHit = async (template: string, minScore?: number): Promise<{ x: number; y: number } | null> => {
    const tplPath = isAbsolute(template) ? template : join(session.root, template);
    if (!existsSync(tplPath)) return null;
    const png = await d.screenshot();
    const m = findTemplate(png, readFileSync(tplPath), minScore ?? 0.85);
    if (!m.found) return null;
    const cs = await captureCoordinateSpace(d, png);
    return toDevicePoint(cs, m.x, m.y);
  };

  async function execStep(step: FlowStep, stepIndex: number): Promise<StepOutcome> {
    const provenance = provenanceForStep(flow, stepIndex, step.kind);
    switch (step.kind) {
      case 'prepareTarget':
        if (!appId) return { ok: false, detail: 'no appId (set flow.appId or run qa_prepare_target first)', failureCode: 'NO_ARTIFACT' };
        await d.launchApp(appId);
        await settle(d, { timeoutMs });
        return { ok: true };
      case 'restartApp':
        if (!appId) return { ok: false, detail: 'no appId', failureCode: 'NO_ARTIFACT' };
        try {
          await d.terminateApp(appId);
          await d.launchApp(appId);
          await settle(d, { timeoutMs });
          sessions.addEnvChange(session, 'restartApp');
          recordFlowMutation('flow_restart_app', 'low', { stepKind: step.kind }, 'executed');
          return { ok: true };
        } catch (e) {
          recordFlowMutation('flow_restart_app', 'low', { stepKind: step.kind }, 'blocked', String(e));
          throw e;
        }
      case 'tap': {
        const resolved = resolveFlowText(step.selector);
        if (resolved.missing.length) return unresolved(resolved.missing);
        const selector = resolved.out;
        const native = nativeSelectorFor(selector);
        if (native && d.tapBySelector) {
          try {
            await d.tapBySelector(native.using, native.value);
          } catch (e) {
            return { ok: false, detail: String(e), failureCode: classifyFlowDriverError(e, 'ELEMENT_NOT_FOUND') };
          }
          sessions.bump(session, 'actions');
          await settle(d, { timeoutMs });
          return { ok: true };
        }
        if (native && native.using !== 'accessibility id' && native.using !== 'name') {
          return {
            ok: false,
            detail: `${native.using} selectors require backend-native selector support`,
            failureCode: 'BACKEND_UNSUPPORTED',
          };
        }
        const t = await resolveTarget(session, targetForTapSelector(selector, provenance));
        if ('error' in t) return { ok: false, detail: t.error, failureCode: classifyFlowDriverError(t.error, 'ELEMENT_NOT_FOUND') };
        await d.pressXY(t.x, t.y, 100);
        sessions.bump(session, 'actions');
        await settle(d, { timeoutMs });
        return { ok: true };
      }
      case 'tapAt':
        await d.pressXY(step.x, step.y, 100);
        sessions.bump(session, 'actions');
        await settle(d, { timeoutMs });
        return { ok: true };
      case 'tapImage': {
        const pt = await tapImageHit(step.template, step.minScore);
        if (!pt) return { ok: false, detail: `image "${step.template}" not found on screen`, failureCode: 'ELEMENT_NOT_FOUND' };
        await d.pressXY(pt.x, pt.y, 100);
        sessions.bump(session, 'actions');
        await settle(d, { timeoutMs });
        return { ok: true };
      }
      case 'tapOcrText': {
        const resolved = resolveFlowText(step.query);
        if (resolved.missing.length) return unresolved(resolved.missing);
        const query = resolved.out;
        if (session.sensitive)
          return {
            ok: false,
            detail: 'Sensitive mode refuses OCR visual text search because it would pass a screenshot to an external provider',
            failureCode: 'UNSAFE_ACTION_REFUSED',
          };
        const command = configuredOcrCommand(session.root);
        if (!command) return { ok: false, detail: 'OCR command is not configured', failureCode: 'VISUAL_ONLY_SCREEN' };
        const hit = findOcrRegion(await runOcr(d, session.root, command), query, step.minConfidence ?? 0.8);
        if (!hit) return { ok: false, detail: `OCR text "${shown(query)}" not found`, failureCode: 'ELEMENT_NOT_FOUND' };
        await d.pressXY(hit.devicePoint.x, hit.devicePoint.y, 100);
        sessions.bump(session, 'actions');
        await settle(d, { timeoutMs });
        return { ok: true };
      }
      case 'inputText': {
        const { out, missing } = resolveFlowText(step.value);
        if (missing.length) return { ok: false, detail: `unresolved variable(s): ${missing.join(', ')}`, failureCode: 'MISSING_FIXTURE' };
        // eslint-disable-next-line no-control-regex -- intentional: detect non-ASCII (outside \x00-\x7F) before adb text input
        if (d.kind === 'direct' && /[^\x00-\x7F]/.test(out)) {
          return {
            ok: false,
            detail: 'Android DirectDriver text entry is ASCII-safe only for generated replay values',
            failureCode: 'TEXT_INPUT_UNSUPPORTED',
          };
        }
        if (step.into) {
          const into = resolveFlowText(step.into);
          if (into.missing.length) return unresolved(into.missing);
          const native = nativeSelectorFor(into.out);
          if (native && d.typeBySelector) {
            try {
              if (d.clearBySelector) await d.clearBySelector(native.using, native.value);
              await d.typeBySelector(native.using, native.value, out);
            } catch (e) {
              return { ok: false, detail: String(e), failureCode: classifyFlowDriverError(e, 'ELEMENT_NOT_FOUND') };
            }
            if (step.secret && out) session.secrets.add(out);
            sessions.bump(session, 'actions');
            return { ok: true };
          }
          if (native && native.using !== 'accessibility id' && native.using !== 'name') {
            return {
              ok: false,
              detail: `${native.using} selectors require backend-native selector support`,
              failureCode: 'BACKEND_UNSUPPORTED',
            };
          }
          // selector-bound: focus the named field first (no reliance on existing focus)
          const t = await resolveTarget(session, targetForTapSelector(into.out, provenance));
          if ('error' in t)
            return {
              ok: false,
              detail: `field "${shown(into.out)}": ${t.error}`,
              failureCode: classifyFlowDriverError(t.error, 'ELEMENT_NOT_FOUND'),
            };
          await d.tapXY(t.x, t.y);
          await new Promise((r) => setTimeout(r, 600));
          await d.clearFocusedText(t.textLen);
        }
        if (step.secret && out) session.secrets.add(out);
        await d.inputText(out);
        sessions.bump(session, 'actions');
        return { ok: true };
      }
      case 'assertVisible': {
        const resolved = resolveFlowText(step.query);
        if (resolved.missing.length) return unresolved(resolved.missing);
        const query = resolved.out;
        try {
          const native = await nativeVisible(d, query);
          if (native != null)
            return native ? { ok: true } : { ok: false, detail: `"${shown(query)}" not visible`, failureCode: 'ASSERTION_FAILED' };
        } catch (e) {
          return { ok: false, detail: String((e as Error).message ?? e), failureCode: 'BACKEND_UNSUPPORTED' };
        }
        const id = resourceIdSelector(query);
        if (id) {
          const visibleById = await resourceIdVisibility(session, d, id, provenance);
          if (visibleById.ambiguous) return { ok: false, detail: visibleById.detail, failureCode: 'AMBIGUOUS_SELECTOR' };
          return visibleById.visible
            ? { ok: true }
            : { ok: false, detail: visibleById.detail ?? `"${shown(query)}" not visible`, failureCode: 'ASSERTION_FAILED' };
        }
        const ok = visible(await snapshot(session, d), fallbackVisibleQuery(query));
        return ok ? { ok } : { ok, detail: `"${shown(query)}" not visible`, failureCode: 'ASSERTION_FAILED' };
      }
      case 'assertNotVisible': {
        const resolved = resolveFlowText(step.query);
        if (resolved.missing.length) return unresolved(resolved.missing);
        const query = resolved.out;
        try {
          const native = await nativeVisible(d, query);
          if (native != null)
            return !native
              ? { ok: true }
              : { ok: false, detail: `"${shown(query)}" unexpectedly visible`, failureCode: 'ASSERTION_FAILED' };
        } catch (e) {
          return { ok: false, detail: String((e as Error).message ?? e), failureCode: 'BACKEND_UNSUPPORTED' };
        }
        const id = resourceIdSelector(query);
        if (id) {
          const visibleById = await resourceIdVisibility(session, d, id, provenance);
          if (visibleById.ambiguous) return { ok: false, detail: visibleById.detail, failureCode: 'AMBIGUOUS_SELECTOR' };
          return !visibleById.visible
            ? { ok: true }
            : { ok: false, detail: `"${shown(query)}" unexpectedly visible`, failureCode: 'ASSERTION_FAILED' };
        }
        const ok = !visible(await snapshot(session, d), fallbackVisibleQuery(query));
        return ok ? { ok } : { ok, detail: `"${shown(query)}" unexpectedly visible`, failureCode: 'ASSERTION_FAILED' };
      }
      case 'assertImage': {
        const tplPath = isAbsolute(step.template) ? step.template : join(session.root, step.template);
        if (!existsSync(tplPath)) return { ok: false, detail: `template not found: ${tplPath}`, failureCode: 'ASSERTION_FAILED' };
        const m = findTemplate(await d.screenshot(), readFileSync(tplPath), step.minScore ?? 0.85);
        return m.found
          ? { ok: true }
          : { ok: false, detail: `image "${step.template}" not visible (best score ${m.score})`, failureCode: 'ASSERTION_FAILED' };
      }
      case 'assertOcrText': {
        const resolved = resolveFlowText(step.query);
        if (resolved.missing.length) return unresolved(resolved.missing);
        const query = resolved.out;
        if (session.sensitive)
          return {
            ok: false,
            detail: 'Sensitive mode refuses OCR visual text assertion because it would pass a screenshot to an external provider',
            failureCode: 'UNSAFE_ACTION_REFUSED',
          };
        const command = configuredOcrCommand(session.root);
        if (!command) return { ok: false, detail: 'OCR command is not configured', failureCode: 'VISUAL_ONLY_SCREEN' };
        const hit = findOcrRegion(await runOcr(d, session.root, command), query, step.minConfidence ?? 0.8);
        return hit ? { ok: true } : { ok: false, detail: `OCR text "${shown(query)}" not found`, failureCode: 'ASSERTION_FAILED' };
      }
      case 'assertVisual': {
        // human-readable visual checkpoint: capture evidence + record a visual note; passes.
        const png = await d.screenshot();
        const uri = sessions.saveArtifact(
          session,
          'screenshot',
          `flow-visual-${Date.now()}.png`,
          png,
          'image/png',
          `visual checkpoint: ${step.description}`,
        );
        sessions.bump(session, 'screenshots');
        sessions.addNote(session, {
          at: Date.now(),
          workflow: `${flow.name}:visual`,
          outcome: 'pass',
          reason: step.description,
          method: 'visual',
          verifiedVisually: true,
          artifactUris: [uri],
        });
        return { ok: true };
      }
      case 'assertDiff': {
        const basePath = join(session.root, '.swipium', 'baselines', `${step.baseline}.png`);
        if (!existsSync(basePath))
          return { ok: false, detail: `no baseline "${step.baseline}" (create a visual baseline first)`, failureCode: 'MISSING_FIXTURE' };
        const res = imageDiff(readFileSync(basePath), await d.screenshot());
        const tol = step.threshold ?? 0.02;
        return res.comparable && res.ratio <= tol
          ? { ok: true }
          : {
              ok: false,
              detail: res.comparable
                ? `${(res.ratio * 100).toFixed(2)}% changed > ${(tol * 100).toFixed(1)}%`
                : `not comparable: ${res.reason}`,
              failureCode: 'ASSERTION_FAILED',
            };
      }
      case 'swipe': {
        const v = swipeVector(screenSize, step.direction, step.area, step.distance);
        await d.swipe(v[0], v[1], v[2], v[3], 300);
        sessions.bump(session, 'actions');
        await settle(d, { timeoutMs });
        return { ok: true };
      }
      case 'scrollTo': {
        const resolved = resolveFlowText(step.query);
        if (resolved.missing.length) return unresolved(resolved.missing);
        const query = resolved.out;
        for (let n = 0; n < 8; n++) {
          try {
            const native = await nativeVisible(d, query);
            if (native === true) return { ok: true };
            if (native === false) {
              const v = swipeVector(screenSize, 'up');
              await d.swipe(v[0], v[1], v[2], v[3], 300);
              await new Promise((r) => setTimeout(r, 400));
              continue;
            }
          } catch (e) {
            return { ok: false, detail: String((e as Error).message ?? e), failureCode: 'BACKEND_UNSUPPORTED' };
          }
          const id = resourceIdSelector(query);
          if (id) {
            const visibleById = await resourceIdVisibility(session, d, id, provenance);
            if (visibleById.ambiguous) return { ok: false, detail: visibleById.detail, failureCode: 'AMBIGUOUS_SELECTOR' };
            if (visibleById.visible) return { ok: true };
          } else if (visible(await snapshot(session, d), fallbackVisibleQuery(query))) {
            return { ok: true };
          }
          const v = swipeVector(screenSize, 'up');
          await d.swipe(v[0], v[1], v[2], v[3], 300);
          await new Promise((r) => setTimeout(r, 400));
        }
        return { ok: false, detail: `"${shown(query)}" not found after scrolling`, failureCode: 'ELEMENT_NOT_FOUND' };
      }
      case 'press':
        await d.pressKey(step.key);
        sessions.bump(session, 'actions');
        await settle(d, { timeoutMs });
        return { ok: true };
      case 'openUrl': {
        const { out, missing } = resolveFlowText(step.url);
        if (missing.length) return { ok: false, detail: `unresolved variable(s): ${missing.join(', ')}`, failureCode: 'MISSING_FIXTURE' };
        await d.openUrl(out);
        await settle(d, { timeoutMs });
        return { ok: true };
      }
      case 'wait':
        if (step.ms != null) {
          const waitStarted = Date.now();
          await new Promise((r) => setTimeout(r, step.ms));
          sessions.addMilestoneDuration(session, 'wait_ms', Date.now() - waitStarted);
          return { ok: true };
        }
      // falls through to query-wait
      case 'waitForVisible': {
        const rawQuery = step.kind === 'waitForVisible' ? step.query : (step as { query?: string }).query!;
        const resolved = resolveFlowText(rawQuery);
        if (resolved.missing.length) return unresolved(resolved.missing);
        const query = resolved.out;
        const deadline = Date.now() + (step.kind === 'waitForVisible' ? (step.timeoutMs ?? timeoutMs) : timeoutMs);
        const waitStarted = Date.now();
        while (Date.now() < deadline) {
          try {
            const native = await nativeVisible(d, query);
            if (native === true) {
              sessions.addMilestoneDuration(session, 'wait_ms', Date.now() - waitStarted);
              return { ok: true };
            }
            if (native === false) {
              await new Promise((r) => setTimeout(r, 400));
              continue;
            }
          } catch (e) {
            sessions.addMilestoneDuration(session, 'wait_ms', Date.now() - waitStarted);
            return { ok: false, detail: String((e as Error).message ?? e), failureCode: 'BACKEND_UNSUPPORTED' };
          }
          const id = resourceIdSelector(query);
          if (id) {
            const visibleById = await resourceIdVisibility(session, d, id, provenance);
            if (visibleById.ambiguous) {
              sessions.addMilestoneDuration(session, 'wait_ms', Date.now() - waitStarted);
              return { ok: false, detail: visibleById.detail, failureCode: 'AMBIGUOUS_SELECTOR' };
            }
            if (!visibleById.visible) {
              await new Promise((r) => setTimeout(r, 400));
              continue;
            }
          } else if (!visible(await snapshot(session, d), fallbackVisibleQuery(query))) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          {
            sessions.addMilestoneDuration(session, 'wait_ms', Date.now() - waitStarted);
            return { ok: true };
          }
        }
        sessions.addMilestoneDuration(session, 'wait_ms', Date.now() - waitStarted);
        return { ok: false, detail: `timed out waiting for "${shown(query)}"`, failureCode: 'ASSERTION_FAILED' };
      }
      case 'waitForIdle': {
        const waitStarted = Date.now();
        await settle(d, { timeoutMs: step.timeoutMs ?? timeoutMs });
        sessions.addMilestoneDuration(session, 'wait_ms', Date.now() - waitStarted);
        return { ok: true };
      }
      case 'clearOverlay': {
        // best-effort: hide the keyboard / dismiss a dialog with BACK (a flow cleanup, always ok)
        if (await d.imeShown().catch(() => false)) await d.pressKey('back');
        else await d.pressKey('back');
        await settle(d, { timeoutMs });
        return { ok: true };
      }
      case 'networkOffline':
      case 'networkOnline': {
        const offline = step.kind === 'networkOffline';
        const action = offline ? 'flow_network_offline' : 'flow_network_online';
        try {
          if (offline && !session.network) session.network = { changed: true, originalAirplane: await d.airplaneOn().catch(() => false) };
          await d.setAirplane(offline);
          if (session.network) session.network.changed = true;
          sessions.addEnvChange(session, `network ${offline ? 'offline' : 'online'}`);
          sessions.persist(session);
          recordFlowMutation(action, 'medium', { stepKind: step.kind, to: offline ? 'offline' : 'online' }, 'executed');
          return { ok: true };
        } catch (e) {
          recordFlowMutation(action, 'medium', { stepKind: step.kind, to: offline ? 'offline' : 'online' }, 'blocked', String(e));
          throw e;
        }
      }
      case 'seed': {
        const fixture = session.fixtures.find((f) => f.name === step.fixture);
        if (!fixture?.seed) return { ok: false, detail: `fixture "${step.fixture}" has no seed spec`, failureCode: 'SEED_FAILED' };
        const r = await executeSeed(sessions, session, d, step.fixture, fixture.seed);
        const risk: MutationRecord['risk'] = fixture.seed.type === 'script' ? 'high' : fixture.seed.type === 'api' ? 'medium' : 'low';
        if (!r.ok) {
          sessions.addNote(session, {
            at: Date.now(),
            workflow: `seed:${step.fixture}`,
            outcome: 'blocked',
            category: 'missing_test_data',
            reason: `seed failed: ${r.detail}`,
            requiredState: fixture.requiredState,
            recommendedSetup: fixture.recommendedSetup,
          });
          recordFlowMutation(
            'flow_seed_state',
            risk,
            { stepKind: step.kind, fixture: step.fixture, seedType: fixture.seed.type },
            'blocked',
            r.detail,
          );
          return { ok: false, detail: `seed "${step.fixture}" failed: ${r.detail}`, failureCode: 'SEED_FAILED' };
        }
        recordFlowMutation(
          'flow_seed_state',
          risk,
          { stepKind: step.kind, fixture: step.fixture, seedType: fixture.seed.type },
          'executed',
          r.warnings.join(' ') || undefined,
        );
        return { ok: true };
      }
      case 'note':
        sessions.addNote(session, { at: Date.now(), workflow: `${flow.name}:note`, outcome: step.outcome, reason: step.reason });
        return { ok: true };
      case 'screenshot': {
        const png = await d.screenshot();
        sessions.saveArtifact(session, 'screenshot', `flow-shot-${Date.now()}.png`, png, 'image/png', step.reason ?? 'flow screenshot');
        sessions.bump(session, 'screenshots');
        return { ok: true };
      }
    }
  }

  let recordedFlowRuntime = false;
  const finish = (): FlowRunResult => {
    const elapsedMs = Date.now() - started;
    if (!recordedFlowRuntime) {
      sessions.addMilestoneDuration(session, 'flow_runtime_ms', elapsedMs);
      recordedFlowRuntime = true;
    }
    return {
      name: flow.name,
      appId,
      passed,
      failedAtStep,
      reason,
      failureCode,
      steps,
      durationMs: Math.round(elapsedMs),
      counters: session.counters,
    };
  };

  // Run a list of steps; returns the failing global index, or -1 if all passed.
  const runPhase = async (list: FlowStep[], phase: FlowStepResult['phase'], base: number, failFast: boolean): Promise<number> => {
    for (let j = 0; j < list.length; j++) {
      const step = list[j];
      const index = base + j;
      const summary = describe(step);
      const budget = sessions.budgetStop(session);
      if (budget && phase !== 'teardown') {
        steps.push({ index, phase, kind: step.kind, summary, ok: false, durationMs: 0, detail: budget });
        passed = false;
        failedAtStep = index;
        reason = `budget: ${budget}`;
        return index;
      }
      let outcome: StepOutcome;
      const stepStarted = Date.now();
      try {
        outcome = await execStep(step, index);
      } catch (e) {
        outcome = { ok: false, detail: String(e), failureCode: classifyFlowDriverError(e) };
      }
      const rec: FlowStepResult = {
        index,
        phase,
        kind: step.kind,
        summary,
        ok: outcome.ok,
        durationMs: Math.round(Date.now() - stepStarted),
        detail: outcome.detail,
        failureCode: outcome.failureCode,
      };
      steps.push(rec);
      if (!outcome.ok && failFast) {
        passed = false;
        failedAtStep = index;
        reason = outcome.detail ?? 'step failed';
        failureCode = outcome.failureCode;
        try {
          const png = await d.screenshot();
          rec.screenshotUri = sessions.saveArtifact(
            session,
            'screenshot',
            `flow-fail-${index}-${Date.now()}.png`,
            png,
            'image/png',
            `flow ${flow.name} failed at step ${index}: ${summary}`,
          );
        } catch {
          /* best-effort */
        }
        return index;
      }
    }
    return -1;
  };

  // setup → main → teardown (teardown ALWAYS runs, even after a failure).
  let nextBase = 0;
  const setupFail = await runPhase(flow.setup, 'setup', nextBase, true);
  nextBase += flow.setup.length;
  if (setupFail < 0) {
    await runPhase(flow.steps, 'main', nextBase, true);
  }
  nextBase += flow.steps.length;
  await runPhase(flow.teardown, 'teardown', nextBase, false); // teardown failures are noted, not fatal

  // Final health for the record (best-effort).
  try {
    const health = await checkHealth(d, appId);
    await recordHealthFindings(sessions, session, health.findings, d, health.foreground);
    const r = finish();
    r.nativeHealth = health.nativeHealthy ? 'ok' : health.nativeStatus;
    r.appHealth = health.appStatus;
    return r;
  } catch {
    return finish();
  }
}
