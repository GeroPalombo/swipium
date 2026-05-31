// qa_flow_generate core (PHASE3-PLAN §4.1 / DESIGN §8). Two pure pieces:
//   - recordableTap: at qa_act time, turn a resolved tap target into a replayable descriptor +
//     exportability tag (translating an @ref into its visible text/label where possible — the
//     key durability insight: a ref is run-time-only, but its label survives).
//   - generateFlow: serialize the recorded action IR into a durable flow YAML + a durability
//     grade and the brittle steps that need a testID/accessibilityLabel.

import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import type { Point, Target } from '../core/target.js';
import type { Exportability, RecordedAction, SelectorProvenance, Session } from '../session/store.js';
import { waitForVisibleGuard } from './waitGuards.js';

export interface RecordableTarget {
  selector?: string;
  selectorKind: 'text' | 'accessibility_id' | 'resource_id' | 'name' | 'predicate' | 'class_chain' | 'coords';
  x?: number;
  y?: number;
  exportability: Exportability;
  warning?: string;
  provenance?: SelectorProvenance;
}

function currentScreenSignature(session: Session): string | undefined {
  const sigs = session.lastSnapshot?.signatures;
  if (!sigs?.size) return undefined;
  return createHash('sha1').update([...sigs].sort().join('\n')).digest('hex').slice(0, 16);
}

function bucketBounds(bounds?: [number, number, number, number], point?: Point): string | undefined {
  const b = bounds ?? (point ? [point.x, point.y, point.x, point.y] as [number, number, number, number] : undefined);
  if (!b) return undefined;
  const bucket = (n: number) => Math.floor(n / 50) * 50;
  return `${bucket(b[0])},${bucket(b[1])},${bucket(b[2])},${bucket(b[3])}`;
}

function provenance(
  session: Session,
  opts: { selectorKind?: string; selectorValue?: string; point?: Point },
): SelectorProvenance | undefined {
  const node = opts.point?.ref ? session.lastSnapshot?.fullByRef.get(opts.point.ref) : undefined;
  const out: SelectorProvenance = {
    originalScreenSignature: currentScreenSignature(session),
    elementRole: node?.cls?.split('.').pop(),
    className: node?.cls,
    text: node?.text || undefined,
    accessibilityLabel: node?.desc || undefined,
    resourceId: node?.id || undefined,
    boundsBucket: bucketBounds(node?.bounds, opts.point),
    screenshotUri: session.artifacts?.filter((a) => a.kind === 'screenshot').at(-1)?.uri,
    selectorKind: opts.selectorKind,
    selectorValue: opts.selectorValue,
  };
  return Object.values(out).some((v) => v != null) ? out : undefined;
}

/** Map a resolved tap to a replayable descriptor. Prefers a visible text/label (durable);
 *  falls back to coordinates (brittle) when the element exposes no human-readable handle. */
export function recordableTap(session: Session, target: Target | undefined, point: Point): RecordableTarget {
  if (target?.x != null) return { x: point.x, y: point.y, selectorKind: 'coords', exportability: 'coordinate', provenance: provenance(session, { selectorKind: 'coords', point }) };
  if (target?.id) {
    const selectorKind = session.driver?.kind === 'wda' ? 'accessibility_id' : 'resource_id';
    return { selector: target.id, selectorKind, exportability: 'semantic', provenance: provenance(session, { selectorKind, selectorValue: target.id, point }) };
  }

  const node = point.ref ? session.lastSnapshot?.fullByRef.get(point.ref) : target?.ref ? session.lastSnapshot?.fullByRef.get(target.ref) : undefined;
  if (session.driver?.kind === 'wda' && node?.id) return { selector: node.id, selectorKind: 'accessibility_id', exportability: 'semantic', provenance: provenance(session, { selectorKind: 'accessibility_id', selectorValue: node.id, point }) };

  let label: string | undefined;
  if (target?.text) label = target.text;
  else label = node?.text || node?.desc || undefined;
  if (label) {
    const warning = session.driver?.kind === 'wda'
      ? `iOS label/name selector "${label}" is usable, but add an accessibilityIdentifier for CI-stable replay`
      : undefined;
    return { selector: label, selectorKind: 'text', exportability: 'semantic', warning, provenance: provenance(session, { selectorKind: 'text', selectorValue: label, point }) };
  }
  return { x: point.x, y: point.y, selectorKind: 'coords', exportability: 'coordinate', provenance: provenance(session, { selectorKind: 'coords', point }) };
}

export function recordableNativeSelector(session: Session, selectorKind: string, selectorValue: string): Pick<RecordableTarget, 'provenance'> {
  return { provenance: provenance(session, { selectorKind, selectorValue }) };
}

export type Grade = 'A' | 'B' | 'C';
export interface GenerateResult {
  yaml: string;
  stepCount: number;
  durability: { grade: Grade; semanticPct: number; semantic: number; coordinate: number; needsHumanData: number };
  brittleSteps: Array<{ index: number; reason: string }>;
  variables: string[];
}

function actionSelector(a: RecordedAction): string | null {
  if (!a.selector || !['text', 'accessibility_id', 'resource_id', 'name', 'predicate', 'class_chain'].includes(a.selectorKind ?? '')) return null;
  return a.selectorKind === 'accessibility_id'
    ? `accessibility id=${a.selector}`
    : a.selectorKind === 'resource_id'
      ? `id=${a.selector}` // Flow V2 runner resolves `id=<resource-id>` via resolveTarget({ id })
    : a.selectorKind === 'name'
      ? `name=${a.selector}`
    : a.selectorKind === 'predicate'
      ? `predicate string=${a.selector}`
      : a.selectorKind === 'class_chain'
        ? `class chain=${a.selector}`
        : a.selector;
}

function addProvenance(
  entries: Array<Record<string, unknown>>,
  a: RecordedAction,
  actionIndex: number,
  generatedStepIndex: number,
  generatedKind: string,
  selector?: string | null,
): void {
  if (!a.provenance) return;
  entries.push({ actionIndex, generatedStepIndex, generatedKind, action: a.action, selector: selector ?? a.selector, ...a.provenance });
}

function pushSelectorAction(
  steps: Array<string | Record<string, unknown>>,
  provenanceEntries: Array<Record<string, unknown>>,
  a: RecordedAction,
  actionIndex: number,
  selector: string,
  action: Record<string, unknown>,
  generatedKind: string,
): void {
  const waitIndex = steps.length + 1;
  const actionStepIndex = steps.length + 2;
  steps.push(waitForVisibleGuard(selector), action);
  addProvenance(provenanceEntries, a, actionIndex, waitIndex, 'waitForVisible', selector);
  addProvenance(provenanceEntries, a, actionIndex, actionStepIndex, generatedKind, selector);
}

export function generateFlow(actions: RecordedAction[], opts: { name: string; appId?: string; budgetProfile?: string }): GenerateResult {
  const steps: Array<string | Record<string, unknown>> = ['prepareTarget'];
  const brittleSteps: Array<{ index: number; reason: string }> = [];
  const variables: string[] = [];
  const provenanceEntries: Array<Record<string, unknown>> = [];
  let semantic = 0;
  let coordinate = 0;
  let needsHumanData = 0;
  let secretCount = 0;

  actions.forEach((a, i) => {
    const actionIndex = i + 1;
    switch (a.action) {
      case 'tap':
        {
          const selector = actionSelector(a);
          if (selector) {
            pushSelectorAction(steps, provenanceEntries, a, actionIndex, selector, { tap: selector }, 'tap');
            semantic++;
            if (a.warning) brittleSteps.push({ index: i, reason: a.warning });
          } else {
            addProvenance(provenanceEntries, a, actionIndex, steps.length + 1, 'tapAt');
            steps.push({ tapAt: [a.x ?? 0, a.y ?? 0] });
            coordinate++;
            brittleSteps.push({ index: i, reason: `tapped by coordinates (${a.x},${a.y})${a.screen ? ` on ${a.screen}` : ''} — add a testID/accessibilityLabel for a durable selector` });
          }
        }
        break;
      case 'clear': {
        const selector = actionSelector(a);
        if (selector) {
          pushSelectorAction(steps, provenanceEntries, a, actionIndex, selector, { inputText: { into: selector, text: '' } }, 'inputText');
          semantic++;
        } else {
          addProvenance(provenanceEntries, a, actionIndex, steps.length + 1, 'tapAt');
          steps.push({ tapAt: [a.x ?? 0, a.y ?? 0] }, { inputText: '' });
          coordinate++;
          brittleSteps.push({ index: i, reason: `cleared by coordinates (${a.x},${a.y})${a.screen ? ` on ${a.screen}` : ''} — add a testID/accessibilityLabel for a durable selector` });
        }
        break;
      }
      case 'type':
        {
          const selector = actionSelector(a);
          const text = a.secret ? `\${SECRET_${++secretCount}}` : a.text ?? '';
          if (a.secret) {
            variables.push(`SECRET_${secretCount}`);
            needsHumanData++;
          } else {
            semantic++;
          }
          if (selector) pushSelectorAction(steps, provenanceEntries, a, actionIndex, selector, { inputText: { into: selector, text } }, 'inputText');
          else {
            addProvenance(provenanceEntries, a, actionIndex, steps.length + 1, 'inputText');
            steps.push({ inputText: text });
          }
        }
        break;
      case 'swipe':
        steps.push({ swipe: a.direction ?? 'up' });
        coordinate++;
        break;
      case 'scroll':
        if (a.selector) {
          addProvenance(provenanceEntries, a, actionIndex, steps.length + 1, 'scrollTo', a.selector);
          steps.push({ scrollTo: a.selector });
          semantic++;
        } else {
          steps.push({ swipe: a.direction ?? 'up' });
          coordinate++;
        }
        break;
      case 'press':
        steps.push({ press: a.key ?? 'back' });
        semantic++;
        break;
      case 'open_url':
        steps.push({ openUrl: a.url ?? '' });
        semantic++;
        break;
      case 'assert_visual':
        addProvenance(provenanceEntries, a, actionIndex, steps.length + 1, 'assertVisual', a.assertion ?? a.selector ?? 'visual checkpoint');
        steps.push({ assertVisual: a.assertion ?? a.selector ?? 'visual checkpoint' });
        semantic++;
        break;
    }
  });

  const total = semantic + coordinate + needsHumanData;
  const semanticPct = total ? Math.round((semantic / total) * 100) : 100;
  const grade: Grade = semanticPct >= 90 ? 'A' : semanticPct >= 70 ? 'B' : 'C';

  const flowObj: Record<string, unknown> = { name: opts.name };
  if (opts.appId) flowObj.appId = opts.appId;
  if (opts.budgetProfile) flowObj.budgetProfile = opts.budgetProfile;
  if (provenanceEntries.length) flowObj.provenance = provenanceEntries;
  flowObj.steps = steps;

  const header = [
    `# Generated by Swipium qa_flow_generate — review before committing.`,
    `# durability: ${grade} (${semanticPct}% semantic; ${coordinate} coordinate, ${needsHumanData} needs-human-data)`,
    ...(variables.length ? [`# variables — provide via qa_flow_run { variables }: ${variables.join(', ')}`] : []),
    ...brittleSteps.map((b) => `# WARNING step ${b.index}: ${b.reason}`),
  ].join('\n');

  return {
    yaml: `${header}\n${stringify(flowObj)}`,
    stepCount: steps.length,
    durability: { grade, semanticPct, semantic, coordinate, needsHumanData },
    brittleSteps,
    variables,
  };
}
