// qa_generate target:"flow" core. Two pure pieces:
//   - recordableTap: at qa_act time, turn a resolved tap target into a replayable descriptor +
//     exportability tag (translating an @ref into its visible text/label where possible; the
//     key durability insight: a ref is run-time-only, but its label survives).
//   - generateFlow: serialize the recorded action IR into a durable flow YAML + a durability
//     grade and the brittle steps that need a testID/accessibilityLabel.

import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import type { Point, Target } from '../core/target.js';
import type { Exportability, RecordedAction, SelectorProvenance, Session } from '../session/store.js';
import { waitForVisibleGuard } from './waitGuards.js';
import { isThirdPartySignIn } from '../explore/policy.js';
import { secretSafeActions, secretVarName, type InputBinding } from '../suite/secretGuard.js';

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
  return createHash('sha1')
    .update([...sigs].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
}

function bucketBounds(bounds?: [number, number, number, number], point?: Point): string | undefined {
  const b = bounds ?? (point ? ([point.x, point.y, point.x, point.y] as [number, number, number, number]) : undefined);
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
  if (target?.x != null)
    return {
      x: point.x,
      y: point.y,
      selectorKind: 'coords',
      exportability: 'coordinate',
      provenance: provenance(session, { selectorKind: 'coords', point }),
    };
  if (target?.id) {
    const selectorKind = session.driver?.kind === 'wda' ? 'accessibility_id' : 'resource_id';
    return {
      selector: target.id,
      selectorKind,
      exportability: 'semantic',
      provenance: provenance(session, { selectorKind, selectorValue: target.id, point }),
    };
  }

  const node = point.ref
    ? session.lastSnapshot?.fullByRef.get(point.ref)
    : target?.ref
      ? session.lastSnapshot?.fullByRef.get(target.ref)
      : undefined;
  if (session.driver?.kind === 'wda' && node?.id)
    return {
      selector: node.id,
      selectorKind: 'accessibility_id',
      exportability: 'semantic',
      provenance: provenance(session, { selectorKind: 'accessibility_id', selectorValue: node.id, point }),
    };

  let label: string | undefined;
  if (target?.text) label = target.text;
  else label = node?.text || node?.desc || undefined;
  if (label) {
    const warning =
      session.driver?.kind === 'wda'
        ? `iOS label/name selector "${label}" is usable, but add an accessibilityIdentifier for CI-stable replay`
        : undefined;
    return {
      selector: label,
      selectorKind: 'text',
      exportability: 'semantic',
      warning,
      provenance: provenance(session, { selectorKind: 'text', selectorValue: label, point }),
    };
  }
  return {
    x: point.x,
    y: point.y,
    selectorKind: 'coords',
    exportability: 'coordinate',
    provenance: provenance(session, { selectorKind: 'coords', point }),
  };
}

export function recordableNativeSelector(
  session: Session,
  selectorKind: string,
  selectorValue: string,
): Pick<RecordableTarget, 'provenance'> {
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
  if (!a.selector || !['text', 'accessibility_id', 'resource_id', 'name', 'predicate', 'class_chain'].includes(a.selectorKind ?? ''))
    return null;
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

/** Text-entry controls whose visible text is a placeholder or the current value. */
const FIELD_CLASS = /EditText|TextField|SearchField|SecureTextField|TextInput|AutoCompleteTextView|SearchView|XCUIElementTypeTextView/i;

/** A text selector on a text field is fragile: the visible text is the placeholder (or the typed
 *  value), which changes as soon as the field has a value. Prefer the field's resource-id /
 *  accessibility identifier when the recording captured one; otherwise flag it. */
function fieldSafeSelector(a: RecordedAction, selector: string): { selector: string; fragile: boolean } {
  if (a.selectorKind !== 'text') return { selector, fragile: false };
  const cls = `${a.provenance?.className ?? ''} ${a.provenance?.elementRole ?? ''}`;
  if (!FIELD_CLASS.test(cls)) return { selector, fragile: false };
  const id = a.provenance?.resourceId;
  if (id) return { selector: `id=${id}`, fragile: false };
  return { selector, fragile: true };
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

export function generateFlow(
  actions: RecordedAction[],
  opts: {
    name: string;
    appId?: string;
    budgetProfile?: string;
    /** Registered session secrets (see suite/secretGuard.ts). */ secrets?: Iterable<string>;
    /** Stored session inputs (secretGuard.inputBindings): typed text equal to one becomes its ${VAR}. */
    inputs?: InputBinding[];
    /** The recording began from a restarted app (qa_app_control restart/fresh_start before the
     *  first action): start the flow with restartApp so a replay starts from the same clean state. */
    resetAtStart?: boolean;
    /** Stable text seen on the screen the recording ended on; emitted as a final assertion. */
    finalAssertions?: string[];
    /** Recorded qa_note outcomes ("add_alarm: alarm added via FAB"), named in the header so the
     *  reviewer can turn them into the real assertion. */
    recordedOutcomes?: string[];
  },
): GenerateResult {
  // Defense in depth: a registered secret recorded as a literal (non-secure field) becomes a ${VAR}
  // (same naming as the POM/suite generator: secretVarName), and typed text equal to a stored
  // session input becomes that input's ${SWIPIUM_TEST_*} placeholder.
  actions = secretSafeActions(actions, opts.secrets, opts.inputs).actions;
  // A tap on a third-party / OS sign-in ("Sign up with Apple") opens an account flow
  // outside the app; a replay would fire it again. Drop it and say so in the header.
  const droppedSignIns: string[] = [];
  actions = actions.filter((a) => {
    if (a.action !== 'tap' || !a.selector || !isThirdPartySignIn({ label: a.selector, id: a.selector })) return true;
    droppedSignIns.push(a.selector);
    return false;
  });
  const steps: Array<string | Record<string, unknown>> = [opts.resetAtStart ? 'restartApp' : 'prepareTarget'];
  const brittleSteps: Array<{ index: number; reason: string }> = [];
  let fragile = 0;
  /** Field-safe selector + bookkeeping: a placeholder/value text selector counts against durability. */
  const fieldSelector = (a: RecordedAction, i: number, selector: string): string => {
    const f = fieldSafeSelector(a, selector);
    if (f.fragile) {
      fragile++;
      brittleSteps.push({
        index: i,
        reason: `text field matched by its visible text "${selector}" (a placeholder or value that changes once the field has text). Add a testID/accessibilityIdentifier`,
      });
    }
    return f.selector;
  };
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
          const raw = actionSelector(a);
          const selector = raw ? fieldSelector(a, i, raw) : null;
          if (selector) {
            pushSelectorAction(steps, provenanceEntries, a, actionIndex, selector, { tap: selector }, 'tap');
            semantic++;
            if (a.warning) brittleSteps.push({ index: i, reason: a.warning });
          } else {
            addProvenance(provenanceEntries, a, actionIndex, steps.length + 1, 'tapAt');
            steps.push({ tapAt: [a.x ?? 0, a.y ?? 0] });
            coordinate++;
            brittleSteps.push({
              index: i,
              reason: `tapped by coordinates (${a.x},${a.y})${a.screen ? ` on ${a.screen}` : ''}. Add a testID/accessibilityLabel for a durable selector`,
            });
          }
        }
        break;
      case 'clear': {
        const raw = actionSelector(a);
        const selector = raw ? fieldSelector(a, i, raw) : null;
        if (selector) {
          pushSelectorAction(steps, provenanceEntries, a, actionIndex, selector, { inputText: { into: selector, text: '' } }, 'inputText');
          semantic++;
        } else {
          addProvenance(provenanceEntries, a, actionIndex, steps.length + 1, 'tapAt');
          steps.push({ tapAt: [a.x ?? 0, a.y ?? 0] }, { inputText: '' });
          coordinate++;
          brittleSteps.push({
            index: i,
            reason: `cleared by coordinates (${a.x},${a.y})${a.screen ? ` on ${a.screen}` : ''}. Add a testID/accessibilityLabel for a durable selector`,
          });
        }
        break;
      }
      case 'type':
        {
          const raw = actionSelector(a);
          const selector = raw ? fieldSelector(a, i, raw) : null;
          const varName = a.secret ? secretVarName(a, ++secretCount) : undefined;
          const text = varName ? `\${${varName}}` : (a.text ?? '');
          if (varName) {
            variables.push(varName);
            needsHumanData++;
          } else {
            // A non-secret templated value (e.g. ${SWIPIUM_TEST_EMAIL}) is a variable too.
            for (const m of text.matchAll(/\$\{([^}]+)\}/g)) variables.push(m[1]);
            semantic++;
          }
          if (selector)
            pushSelectorAction(steps, provenanceEntries, a, actionIndex, selector, { inputText: { into: selector, text } }, 'inputText');
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
      case 'restart_app':
        // The recording relaunched the app here (the explorer's recovery when back did nothing).
        steps.push('restartApp');
        break;
      case 'assert_visual':
        addProvenance(
          provenanceEntries,
          a,
          actionIndex,
          steps.length + 1,
          'assertVisual',
          a.assertion ?? a.selector ?? 'visual checkpoint',
        );
        steps.push({ assertVisual: a.assertion ?? a.selector ?? 'visual checkpoint' });
        semantic++;
        break;
    }
  });

  // End with an assertion on the screen the recording reached, so a replay that only finds
  // its locators does not "pass" without checking the outcome.
  const finalAssertions = [...new Set((opts.finalAssertions ?? []).filter((t) => t && t.trim()))].slice(0, 2);
  for (const text of finalAssertions) steps.push(waitForVisibleGuard(text), { assertVisible: text });

  const uniqueVars = [...new Set(variables)];
  // A fragile field selector was counted as semantic; move it out so the grade reflects it.
  semantic = Math.max(0, semantic - fragile);
  const total = semantic + coordinate + needsHumanData + fragile;
  const semanticPct = total ? Math.round((semantic / total) * 100) : 100;
  const grade: Grade = semanticPct >= 90 ? 'A' : semanticPct >= 70 ? 'B' : 'C';

  const flowObj: Record<string, unknown> = { name: opts.name };
  if (opts.appId) flowObj.appId = opts.appId;
  if (opts.budgetProfile) flowObj.budgetProfile = opts.budgetProfile;
  if (provenanceEntries.length) flowObj.provenance = provenanceEntries;
  flowObj.steps = steps;

  const header = [
    `# Generated by Swipium qa_generate target:"flow". Review before committing.`,
    `# durability: ${grade} (${semanticPct}% semantic; ${coordinate} coordinate, ${needsHumanData} needs-human-data${fragile ? `, ${fragile} fragile text-field` : ''})`,
    opts.resetAtStart
      ? '# starts with restartApp: the recording began from a restarted app (replays need flow_mutation_run consent; CI allows restartApp by default)'
      : '# starts with prepareTarget (launch / bring to front, no reset): replay from the screen the recording started on',
    ...(finalAssertions.length
      ? [
          `# final assertion(s) from the last observed screen: ${finalAssertions.join(', ')}. This is a NAVIGATION check (the screen the recording ended on), not the outcome: replace it with text that proves the result`,
        ]
      : ['# TODO: add an assertVisible for the expected outcome; this flow only checks that its locators exist']),
    ...(opts.recordedOutcomes ?? []).slice(0, 3).map((o) => `# recorded outcome to assert: ${o.replace(/\s+/g, ' ').slice(0, 160)}`),
    ...(uniqueVars.length ? [`# variables: provide via qa_flow_run { variables }: ${uniqueVars.join(', ')}`] : []),
    ...(droppedSignIns.length
      ? [
          `# left out: tap(s) on a third-party / OS sign-in (${[...new Set(droppedSignIns)].join(', ')}): it leaves the app and can't be replayed`,
        ]
      : []),
    ...brittleSteps.map((b) => `# WARNING step ${b.index}: ${b.reason}`),
  ].join('\n');

  return {
    yaml: `${header}\n${stringify(flowObj)}`,
    stepCount: steps.length,
    durability: { grade, semanticPct, semantic, coordinate, needsHumanData },
    brittleSteps,
    variables: uniqueVars,
  };
}
