import { parse as parseYaml, stringify } from 'yaml';
import { parseFlow, type FlowStep } from '../flows/schema.js';

export interface MaestroConversion {
  flowYaml: string;
  maestroYaml: string;
  unsupported: Array<{ command: string; reason: string }>;
  grades: Array<{ step: number; grade: 'portable' | 'maestro_supported' | 'swipium_only' | 'manual_review_required'; reason: string }>;
}

function selectorToFlow(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id === 'string') return `id=${v.id}`;
  if (typeof v.text === 'string') return v.text;
  if (typeof v.label === 'string') return `accessibility id=${v.label}`;
  if (typeof v['accessibility id'] === 'string') return `accessibility id=${v['accessibility id']}`;
  return null;
}

export function importMaestro(maestroYaml: string, opts: { name?: string; appId?: string } = {}): MaestroConversion {
  const doc = parseYaml(maestroYaml) as unknown;
  const rawSteps = Array.isArray(doc) ? doc : Array.isArray((doc as { commands?: unknown })?.commands) ? (doc as { commands: unknown[] }).commands : [];
  const unsupported: MaestroConversion['unsupported'] = [];
  const grades: MaestroConversion['grades'] = [];
  const steps: unknown[] = [];

  const addUnsupported = (step: number, command: string, reason: string) => {
    unsupported.push({ command, reason });
    grades.push({ step, grade: 'manual_review_required', reason });
  };

  rawSteps.forEach((raw, rawIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      addUnsupported(rawIndex, String(raw), 'Maestro command must be a single-key object');
      return;
    }
    const [cmd, value] = Object.entries(raw as Record<string, unknown>)[0] ?? [];
    switch (cmd) {
      case 'tapOn': {
        const sel = selectorToFlow(value);
        if (sel) {
          steps.push({ tap: sel });
          grades.push({ step: rawIndex, grade: 'portable', reason: 'tapOn selector maps to Swipium tap' });
        } else {
          addUnsupported(rawIndex, cmd, 'tapOn selector is not in the supported text/id/accessibility subset');
        }
        break;
      }
      case 'inputText':
        if (typeof value === 'string') {
          steps.push({ inputText: value });
          grades.push({ step: rawIndex, grade: 'portable', reason: 'inputText maps directly' });
        } else {
          addUnsupported(rawIndex, cmd, 'object-form inputText can carry variables/options that need manual Swipium fixture mapping');
        }
        break;
      case 'clearState':
        steps.push({ note: { outcome: 'blocked', reason: 'Maestro clearState maps to Swipium state profiles; create .swipium/state/*.yaml for reproducible reset.' } });
        addUnsupported(rawIndex, cmd, 'clearState is semantic-lossy; model it as a Swipium state profile with reset policy and consent');
        break;
      case 'launchApp':
        if (value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length) {
          addUnsupported(rawIndex, cmd, 'launchApp object options may include clearState/permissions/arguments and require a Swipium state profile');
        } else {
          steps.push('prepareTarget');
          grades.push({ step: rawIndex, grade: 'maestro_supported', reason: 'launchApp without options maps to prepareTarget' });
        }
        break;
      case 'assertVisible': {
        const sel = selectorToFlow(value);
        if (sel) {
          steps.push({ assertVisible: sel });
          grades.push({ step: rawIndex, grade: 'portable', reason: 'assertVisible maps directly' });
        } else {
          addUnsupported(rawIndex, cmd, 'assertVisible selector is not in the supported text/id/accessibility subset');
        }
        break;
      }
      case 'scrollUntilVisible': {
        const visible = (value as { visible?: unknown })?.visible ?? value;
        const sel = selectorToFlow(visible);
        if (sel) {
          steps.push({ scrollTo: sel }, { waitForVisible: sel });
          grades.push({ step: rawIndex, grade: 'maestro_supported', reason: 'scrollUntilVisible maps to scrollTo plus waitForVisible' });
        } else {
          addUnsupported(rawIndex, cmd, 'scrollUntilVisible needs a visible text/id/accessibility selector');
        }
        break;
      }
      default:
        addUnsupported(rawIndex, cmd ?? 'unknown', 'command not supported by Swipium Maestro import subset');
    }
  });
  const flow = { name: opts.name ?? 'maestro-import', ...(opts.appId ? { appId: opts.appId } : {}), mode: 'auto', steps };
  const flowYaml = stringify(flow);
  return { flowYaml, maestroYaml, unsupported, grades };
}

function selectorToMaestro(selector: string): string | Record<string, string> {
  const id = selector.match(/^id\s*=\s*(.+)$/i)?.[1];
  if (id) return { id };
  const a11y = selector.match(/^accessibility id\s*=\s*(.+)$/i)?.[1];
  if (a11y) return { label: a11y };
  return selector;
}

export function exportMaestro(flowYaml: string): MaestroConversion {
  const parsed = parseFlow(flowYaml);
  const unsupported: MaestroConversion['unsupported'] = parsed.errors.map((e) => ({ command: 'parse', reason: e }));
  const commands: unknown[] = [];
  const grades: MaestroConversion['grades'] = [];
  if (parsed.flow) {
    parsed.flow.steps.forEach((step: FlowStep, i) => {
      switch (step.kind) {
        case 'tap':
          commands.push({ tapOn: selectorToMaestro(step.selector) });
          grades.push({ step: i, grade: 'portable', reason: 'tap selector maps to Maestro tapOn' });
          break;
        case 'inputText':
          commands.push({ inputText: step.value });
          grades.push({ step: i, grade: 'portable', reason: 'inputText maps directly' });
          break;
        case 'assertVisible':
          commands.push({ assertVisible: selectorToMaestro(step.query) });
          grades.push({ step: i, grade: 'portable', reason: 'assertVisible maps directly' });
          break;
        case 'scrollTo':
          commands.push({ scrollUntilVisible: { visible: selectorToMaestro(step.query) } });
          grades.push({ step: i, grade: 'maestro_supported', reason: 'scrollTo maps to scrollUntilVisible' });
          break;
        case 'prepareTarget':
          commands.push({ launchApp: {} });
          grades.push({ step: i, grade: 'maestro_supported', reason: 'launch maps to Maestro launchApp' });
          break;
        case 'restartApp':
          commands.push({ launchApp: {} });
          unsupported.push({ command: step.kind, reason: 'restartApp loses stop/restart semantics in Maestro export; review manually' });
          grades.push({ step: i, grade: 'manual_review_required', reason: 'restart intent is stronger than Maestro launchApp export' });
          break;
        default:
          commands.push({ '# swipium': `${step.kind} requires Swipium` });
          unsupported.push({ command: step.kind, reason: 'no portable Maestro equivalent' });
          grades.push({ step: i, grade: 'swipium_only', reason: 'no portable Maestro equivalent' });
      }
    });
  }
  return { flowYaml, maestroYaml: stringify(commands), unsupported, grades };
}
