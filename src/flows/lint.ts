import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow, type Flow, type FlowStep } from './schema.js';
import { ciMutationAllowed, loadPolicy, type Policy } from '../report/policy.js';

export type FlowLintSeverity = 'warn' | 'error';

export interface FlowLintFinding {
  file: string;
  flow?: string;
  step?: number;
  severity: FlowLintSeverity;
  code: string;
  message: string;
}

export interface FlowLintResult {
  files: number;
  findings: FlowLintFinding[];
}

export type FlowLintPlatform = 'android' | 'ios' | 'cross-platform';

export interface FlowLintOptions {
  platform?: FlowLintPlatform;
}

const MUTATING = new Set<FlowStep['kind']>(['networkOffline', 'networkOnline', 'seed', 'restartApp']);
const SECRET_LITERAL = /password|passwd|secret|token|otp|api[_-]?key/i;

function stepText(step: FlowStep): string {
  switch (step.kind) {
    case 'tap':
      return step.selector;
    case 'inputText':
      return step.value;
    case 'assertVisible':
    case 'assertNotVisible':
    case 'waitForVisible':
    case 'wait':
    case 'scrollTo':
      return 'query' in step && typeof step.query === 'string' ? step.query : '';
    default:
      return '';
  }
}

function mutatingPolicyMessage(step: FlowStep, policy: Policy | null | undefined): string | null {
  if (!MUTATING.has(step.kind)) return null;
  if (policy === undefined) return null;
  if (ciMutationAllowed(policy, step.kind)) return null;
  return policy
    ? `${step.kind} changes device/app/test state but is not allowed by .swipium/policy.json ciAllowMutations.`
    : `${step.kind} changes device/app/test state but no .swipium/policy.json ciAllowMutations policy was found.`;
}

export function lintFlowObject(file: string, flow: Flow, policy?: Policy | null): FlowLintFinding[] {
  return lintFlowObjectWithOptions(file, flow, { policy });
}

export function lintFlowObjectWithOptions(
  file: string,
  flow: Flow,
  opts: FlowLintOptions & { policy?: Policy | null } = {},
): FlowLintFinding[] {
  const findings: FlowLintFinding[] = [];
  const all = [...flow.setup, ...flow.steps, ...flow.teardown];
  const setupHasMutation = flow.setup.some((step) => MUTATING.has(step.kind));
  if (setupHasMutation && !flow.teardown.length) {
    findings.push({
      file,
      flow: flow.name,
      severity: 'warn',
      code: 'MUTATING_SETUP_WITHOUT_TEARDOWN',
      message:
        'Setup mutates device/app/test state but the flow has no teardown; add cleanup/restore steps or document why state reuse is safe.',
    });
  }
  for (let i = 0; i < all.length; i++) {
    const step = all[i];
    const stepNo = i + 1;
    const text = stepText(step);
    if (step.kind === 'tapAt') {
      findings.push({
        file,
        flow: flow.name,
        step: stepNo,
        severity: 'warn',
        code: 'COORDINATE_ONLY',
        message: 'Coordinate-only tap is brittle; prefer an accessibility id or stable text locator.',
      });
    }
    if (/xpath=|^\/\//i.test(text)) {
      findings.push({
        file,
        flow: flow.name,
        step: stepNo,
        severity: 'warn',
        code: 'XPATH_LOCATOR',
        message:
          'XPath locators are brittle and slow; prefer accessibility id/name, predicate/class-chain on iOS, or resource id on Android.',
      });
    }
    if (
      (opts.platform === 'cross-platform' || (!opts.platform && flow.mode === 'auto')) &&
      /(resource-id=|uiautomator|android\.|accessibility id=|name=|class chain|predicate string|XCUIElementType)/i.test(text)
    ) {
      findings.push({
        file,
        flow: flow.name,
        step: stepNo,
        severity: 'warn',
        code: 'PLATFORM_SPECIFIC_LOCATOR',
        message:
          'Platform-specific locator in an auto/cross-platform flow; prefer shared text/testID/accessibility labels or split into platform-specific flows.',
      });
    }
    if (opts.platform === 'ios' && /resource-id=|uiautomator|android\./i.test(text)) {
      findings.push({
        file,
        flow: flow.name,
        step: stepNo,
        severity: 'warn',
        code: 'ANDROID_LOCATOR_IN_IOS_FLOW',
        message: 'Android-specific locator in an iOS flow; prefer accessibilityIdentifier/name/label, predicate string, or class chain.',
      });
    }
    if (opts.platform === 'android' && /class chain|predicate string|XCUIElementType|accessibility id=|name=/i.test(text)) {
      findings.push({
        file,
        flow: flow.name,
        step: stepNo,
        severity: 'warn',
        code: 'IOS_LOCATOR_IN_ANDROID_FLOW',
        message: 'iOS-specific locator in an Android flow; prefer resource-id, content-desc, or stable text.',
      });
    }
    if (step.kind === 'inputText' && !/\$\{[^}]+}/.test(step.value) && (step.secret || SECRET_LITERAL.test(step.value))) {
      findings.push({
        file,
        flow: flow.name,
        step: stepNo,
        severity: 'error',
        code: 'INLINE_SECRET',
        message: 'Secret-looking input is inline; use ${ENV_VAR} from CI secrets instead.',
      });
    }
    if ((step.kind === 'assertVisible' || step.kind === 'assertNotVisible') && i > 0) {
      const prev = all[i - 1];
      if (!['wait', 'waitForVisible', 'waitForIdle', 'assertVisible', 'assertNotVisible'].includes(prev.kind)) {
        findings.push({
          file,
          flow: flow.name,
          step: stepNo,
          severity: 'warn',
          code: 'ASSERT_WITHOUT_WAIT',
          message: 'Assertion follows an action without an explicit wait; add waitForVisible/waitForIdle for CI stability.',
        });
      }
    }
    if (MUTATING.has(step.kind)) {
      findings.push({
        file,
        flow: flow.name,
        step: stepNo,
        severity: 'warn',
        code: 'MUTATING_STEP',
        message: 'Mutating step requires explicit CI policy allowance and should have teardown where applicable.',
      });
      const policyMessage = mutatingPolicyMessage(step, opts.policy);
      if (policyMessage) {
        findings.push({
          file,
          flow: flow.name,
          step: stepNo,
          severity: 'error',
          code: 'MUTATING_STEP_WITHOUT_POLICY',
          message: policyMessage,
        });
      }
    }
  }
  return findings;
}

export function lintFlowFiles(root: string, opts: FlowLintOptions = {}): FlowLintResult {
  const dir = join(root, '.swipium', 'flows');
  if (!existsSync(dir))
    return { files: 0, findings: [{ file: dir, severity: 'error', code: 'NO_FLOWS_DIR', message: 'No .swipium/flows directory found.' }] };
  const policy = loadPolicy(root);
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => join(dir, f));
  const findings: FlowLintFinding[] = [];
  for (const file of files) {
    const { flow, errors } = parseFlow(readFileSync(file, 'utf8'));
    if (errors.length || !flow) {
      findings.push({ file, severity: 'error', code: 'INVALID_FLOW', message: errors.join('; ') || 'Invalid flow.' });
      continue;
    }
    findings.push(...lintFlowObjectWithOptions(file, flow, { ...opts, policy }));
  }
  return { files: files.length, findings };
}
