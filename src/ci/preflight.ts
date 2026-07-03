import { ciMutationAllowed, type Policy } from '../report/policy.js';
import type { Flow, FlowStep } from '../flows/schema.js';
import type { Pack } from '../flows/pack.js';

const MUTATING_CI_STEPS = new Set<FlowStep['kind']>(['networkOffline', 'networkOnline', 'seed', 'restartApp']);

export interface CiPreflightViolation {
  flow: string;
  step: number;
  kind: string;
  reason: string;
}

export interface CiMutationPreflight {
  ok: boolean;
  violations: CiPreflightViolation[];
}

export interface CiMissingVariable {
  flow: string;
  step: number;
  kind: string;
  variable: string;
  reason: string;
}

export interface CiVariablePreflight {
  ok: boolean;
  missing: CiMissingVariable[];
}

export interface CiParallelPreflight {
  ok: boolean;
  violations: string[];
}

const VAR_REF = /\$\{([^}]+)\}/g;

function variableBearingValues(step: FlowStep): string[] {
  switch (step.kind) {
    case 'tap':
      return [step.selector];
    case 'tapOcrText':
    case 'assertVisible':
    case 'assertNotVisible':
    case 'assertOcrText':
    case 'scrollTo':
    case 'waitForVisible':
      return [step.query];
    case 'wait':
      return step.query ? [step.query] : [];
    case 'inputText':
      return [step.value, step.into].filter((v): v is string => !!v);
    case 'openUrl':
      return [step.url];
    case 'assertVisual':
      return [step.description];
    default:
      return [];
  }
}

export function ciMutatingSteps(flow: Flow): CiPreflightViolation[] {
  const all = [...flow.setup, ...flow.steps, ...flow.teardown];
  const out: CiPreflightViolation[] = [];
  all.forEach((step, i) => {
    if (!MUTATING_CI_STEPS.has(step.kind)) return;
    out.push({
      flow: flow.name,
      step: i + 1,
      kind: step.kind,
      reason: `${step.kind} changes device/app/test state and requires .swipium/policy.json ciAllowMutations`,
    });
  });
  return out;
}

export function validateCiMutationPolicy(flows: Flow[], policy: Policy | null): CiMutationPreflight {
  const violations = flows.flatMap((flow) => ciMutatingSteps(flow).filter((v) => !ciMutationAllowed(policy, v.kind)));
  return { ok: violations.length === 0, violations };
}

export function ciRequiredVariables(flow: Flow): CiMissingVariable[] {
  const all = [...flow.setup, ...flow.steps, ...flow.teardown];
  const out: CiMissingVariable[] = [];
  all.forEach((step, i) => {
    for (const value of variableBearingValues(step)) {
      for (const match of value.matchAll(VAR_REF)) {
        out.push({
          flow: flow.name,
          step: i + 1,
          kind: step.kind,
          variable: match[1],
          reason: `${step.kind} references \${${match[1]}}; set it in the CI environment before running Swipium.`,
        });
      }
    }
  });
  return out;
}

export function validateCiVariables(
  flows: Flow[],
  env: NodeJS.ProcessEnv = process.env,
  variables: Record<string, string> = {},
): CiVariablePreflight {
  const missing = flows
    .flatMap((flow) => ciRequiredVariables(flow))
    .filter((v) => {
      const explicit = variables[v.variable];
      if (explicit != null && explicit !== '') return false;
      return env[v.variable] == null || env[v.variable] === '';
    });
  return { ok: missing.length === 0, missing };
}

export function validateCiParallelPack(pack: Pack): CiParallelPreflight {
  if (!pack.parallel) return { ok: true, violations: [] };
  return {
    ok: false,
    violations: [
      `pack "${pack.name}" sets parallel:true, but CI pack execution currently uses one shared device/session/artifacts directory. Use parallel:false or run a device matrix with isolated simulator UDID, WDA port, artifacts dir, session id, and logs.`,
    ],
  };
}
