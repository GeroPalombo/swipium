import { ciMutationAllowed, type Policy } from '../report/policy.js';
import { flowEnvAllowed, isMutatingFlowStep, type Flow, type FlowStep } from '../flows/schema.js';
import type { Pack } from '../flows/pack.js';

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
    // Same rule as qa_flow_run consent / qa_smoke: includes an openUrl that interpolates ${VAR}.
    if (!isMutatingFlowStep(step)) return;
    out.push({
      flow: flow.name,
      step: i + 1,
      kind: step.kind,
      reason:
        step.kind === 'openUrl'
          ? 'openUrl interpolates a ${VAR} into a URL that leaves the device and requires .swipium/policy.json ciAllowMutations ("openUrl")'
          : `${step.kind} changes device/app/test state and requires .swipium/policy.json ciAllowMutations`,
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
          reason: flowEnvAllowed(match[1])
            ? `${step.kind} references \${${match[1]}}; set it in the CI environment before running Swipium.`
            : `${step.kind} references \${${match[1]}}; flows read only SWIPIUM_* environment variables. Rename it (e.g. SWIPIUM_${match[1]}) or pass it as an explicit variable.`,
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
      // The flow runner reads the environment only for SWIPIUM_* names, so any other env var
      // does not satisfy the requirement (it would still be missing at run time).
      if (!flowEnvAllowed(v.variable)) return true;
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
