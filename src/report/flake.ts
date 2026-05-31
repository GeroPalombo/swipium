import type { FlowRunResult } from '../flows/run.js';

export type FlakeClassificationKind = 'not_repeated' | 'deterministic-pass' | 'deterministic-fail' | 'flaky';
export type FlakeLikelyCause = 'none' | 'selector_weakness' | 'backend_timing' | 'environment_setup' | 'app_nondeterminism' | 'mixed';

export interface FlakeTriage {
  likelyCause: FlakeLikelyCause;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  nextStep: string;
}

export interface FlakeClassification {
  repeat: number;
  passed: number;
  failed: number;
  passRate: number;
  classification: FlakeClassificationKind;
  triage: FlakeTriage;
}

function bucket(result: FlowRunResult): Exclude<FlakeLikelyCause, 'none' | 'mixed'> {
  const code = String(result.failureCode ?? '').toUpperCase();
  const text = `${result.reason ?? ''} ${result.steps.find((s) => !s.ok)?.detail ?? ''}`.toLowerCase();
  if (/ELEMENT_NOT_FOUND|ELEMENT_NOT_HITTABLE|AMBIGUOUS_SELECTOR|MISSING_DURABLE_LOCATOR|COORDINATE_ONLY_FLOW/.test(code) || /not found|not hittable|ambiguous|coordinate|locator|selector/.test(text)) return 'selector_weakness';
  if (/UI_IDLE_TIMEOUT|SNAPSHOT_FAILED|WDA_UNREACHABLE|DEVICE_NOT_READY|BACKEND_UNSUPPORTED/.test(code) || /timed out|idle|wda|snapshot|not ready|backend|simulator|emulator/.test(text)) return 'backend_timing';
  if (/NO_DEVICE|NO_ARTIFACT|MISSING_FIXTURE|MISSING_SECRET|SEED_FAILED|ARTIFACT_PATH_UNWRITABLE/.test(code) || /fixture|secret|artifact|device|seed|environment|setup/.test(text)) return 'environment_setup';
  return 'app_nondeterminism';
}

function nextStep(cause: FlakeLikelyCause): string {
  if (cause === 'selector_weakness') return 'Replace weak text/coordinate locators with stable testID/accessibilityIdentifier/resource-id selectors and rerun repeat.';
  if (cause === 'backend_timing') return 'Add app-declared idling hooks or explicit wait guards, then check WDA/emulator/device timing evidence.';
  if (cause === 'environment_setup') return 'Stabilize fixtures, secrets, device availability, artifacts, and seed setup before treating this as an app failure.';
  if (cause === 'app_nondeterminism') return 'Inspect app-side async state, backend responses, feature flags, and assertion evidence across passing and failing runs.';
  if (cause === 'mixed') return 'Split the flow or rerun with targeted evidence; multiple failure classes appeared across repeats.';
  return 'No flake triage needed.';
}

export function classifyFlakeResults(results: FlowRunResult[], repeat = 1): FlakeClassification {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const classification: FlakeClassificationKind = repeat <= 1
    ? 'not_repeated'
    : passed === results.length
      ? 'deterministic-pass'
      : passed === 0
        ? 'deterministic-fail'
        : 'flaky';
  const failedResults = results.filter((r) => !r.passed);
  const causeCounts = new Map<Exclude<FlakeLikelyCause, 'none' | 'mixed'>, number>();
  for (const r of failedResults) causeCounts.set(bucket(r), (causeCounts.get(bucket(r)) ?? 0) + 1);
  const causes = [...causeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const likelyCause: FlakeLikelyCause =
    !failedResults.length ? 'none' :
    causes.length > 1 && classification === 'flaky' ? 'mixed' :
    causes[0][0];
  const evidence = failedResults.slice(0, 5).map((r, i) => {
    const code = r.failureCode ? ` ${r.failureCode}` : '';
    return `run ${i + 1} failed${r.failedAtStep != null ? ` at step ${r.failedAtStep}` : ''}${code}: ${r.reason ?? 'unknown failure'}`;
  });
  return {
    repeat,
    passed,
    failed,
    passRate: results.length ? Math.round((passed / results.length) * 100) : 0,
    classification,
    triage: {
      likelyCause,
      confidence: likelyCause === 'none' || failedResults.length > 1 && causes.length === 1 ? 'high' : likelyCause === 'mixed' ? 'medium' : 'low',
      evidence,
      nextStep: nextStep(likelyCause),
    },
  };
}
