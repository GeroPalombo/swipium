// Release-gate policy (Reporting V3 / P1 release gate). A project can declare
// .swipium/policy.json to decide what blocks a release, what only warns, and which known issues
// to suppress. Consumed by the CI mutation gate: `qa_flow_check` with `ci:true` (src/tools/flow.ts),
// the CI preflight (src/ci/preflight.ts), and flow lint (src/flows/lint.ts) all consult
// `ciAllowMutations` via loadPolicy/ciMutationAllowed. `applyPolicy` is the release-gate
// helper (blockOn/warnOn/ignoreKnown > pass/fail) for reports/CI.
//
//   {
//     "blockOn":   ["native_crash", "error_boundary", "failed_required_flow"],
//     "warnOn":    ["visual_diff", "missing_test_data"],
//     "ignoreKnown": ["REVENUECAT_BILLING_UNAVAILABLE_ON_EMULATOR"]
//   }
//
// Tokens are matched case-insensitively against failure codes (e.g. NATIVE_CRASH and "native_crash")
// and a few synonyms; `failed_required_flow` matches any failed flow regardless of code, and
// `visual_diff` matches only a failed visual-template / OCR / screenshot-diff check (FlowVerdict.visual),
// never a structured assertion such as assertVisible or waitForVisible.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Policy {
  blockOn: string[];
  warnOn: string[];
  ignoreKnown: string[];
  ciAllowMutations: string[];
}

const POLICY_LISTS = ['blockOn', 'warnOn', 'ignoreKnown', 'ciAllowMutations'] as const;

type ParsedPolicy = { policy: Policy; problem?: undefined } | { policy?: undefined; problem: string };

function parsePolicyFile(p: string): ParsedPolicy {
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { problem: `is not valid JSON (${String((e as Error).message ?? e)})` };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { problem: 'must be a JSON object such as {"blockOn": ["native_crash"], "warnOn": ["missing_test_data"]}' };
  }
  const rec = j as Record<string, unknown>;
  for (const k of POLICY_LISTS) {
    const v = rec[k];
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
      return { problem: `"${k}" must be an array of strings (got ${JSON.stringify(v)})` };
    }
  }
  const list = (k: (typeof POLICY_LISTS)[number]) => (rec[k] as string[] | undefined) ?? [];
  return {
    policy: {
      blockOn: list('blockOn'),
      warnOn: list('warnOn'),
      ignoreKnown: list('ignoreKnown'),
      ciAllowMutations: list('ciAllowMutations'),
    },
  };
}

/** The policy, or null when there is none OR it is invalid (unparseable, not an object, or a list
 *  field that is not an array of strings): an invalid policy never crashes the gate, it falls back
 *  to "every failure blocks". Use policyFileProblem() to tell the user why it was ignored. */
export function loadPolicy(root: string): Policy | null {
  const p = join(root, '.swipium', 'policy.json');
  if (!existsSync(p)) return null;
  return parsePolicyFile(p).policy ?? null;
}

/** Why an existing .swipium/policy.json is invalid, or null when it is absent or valid. */
export function policyFileProblem(root: string): string | null {
  const p = join(root, '.swipium', 'policy.json');
  if (!existsSync(p)) return null;
  return parsePolicyFile(p).problem ?? null;
}

/** Top-level keys of a valid .swipium/policy.json that the gate does not know (a typo such as
 *  "warnon" is otherwise silently ignored). `$schema` is allowed. Empty when absent/invalid. */
export function policyUnknownKeys(root: string): string[] {
  const p = join(root, '.swipium', 'policy.json');
  if (!existsSync(p) || !parsePolicyFile(p).policy) return [];
  const rec = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  const known = new Set<string>([...POLICY_LISTS, '$schema']);
  return Object.keys(rec).filter((k) => !known.has(k));
}

/** One-line note for an ignored policy file or ignored policy keys, or null when it is clean. */
export function policyNotice(root: string): string | null {
  const problem = policyFileProblem(root);
  if (problem) return `.swipium/policy.json ${problem}: it was ignored, so every failure blocks`;
  const unknown = policyUnknownKeys(root);
  if (unknown.length)
    return `.swipium/policy.json: unknown key(s) ${unknown.map((k) => JSON.stringify(k)).join(', ')} ignored (known: ${POLICY_LISTS.join(', ')})`;
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// Map policy synonyms > the normalized failure-code form.
const SYNONYMS: Record<string, string> = {
  appbug: 'assertionfailed',
  crash: 'nativecrash',
  errorboundary: 'errorboundary',
};

/** A single flow's failure, as seen by the policy. */
export interface FlowVerdict {
  flow: string;
  passed: boolean;
  failureCode?: string;
  /** The recorded outcome when known: a blocked/skipped workflow is not a failure, but not a pass either. */
  outcome?: string;
  /** The failure is a Swipium visual comparison (image template, OCR text, screenshot diff): the
   *  only kind of failure the `visual_diff` token matches. */
  visual?: boolean;
}

export interface PolicyDecision {
  block: boolean;
  blocked: string[]; // "flow: CODE" entries that block
  warned: string[];
  suppressed: string[]; // failures matched by ignoreKnown
  reason: string;
}

/** Decide pass/fail for a set of flow verdicts under a policy. With no policy, ANY failure blocks. */
export function applyPolicy(verdicts: FlowVerdict[], policy: Policy | null): PolicyDecision {
  const blocked: string[] = [];
  const warned: string[] = [];
  const suppressed: string[] = [];

  const inList = (list: string[], code: string, v: FlowVerdict) => {
    const c = norm(code);
    return list.some((tok) => {
      const t = norm(tok);
      if (t === 'visualdiff') return v.visual === true;
      return t === c || SYNONYMS[t] === c || t === 'failedrequiredflow';
    });
  };

  for (const v of verdicts) {
    if (v.passed) continue;
    const code = v.failureCode ?? 'UNKNOWN';
    if (!policy) {
      blocked.push(`${v.flow}: ${code}`);
      continue;
    }
    if (policy.ignoreKnown.some((k) => norm(k) === norm(code))) {
      suppressed.push(`${v.flow}: ${code}`);
      continue;
    }
    // failed_required_flow blocks any failure; otherwise match the specific code.
    if (policy.blockOn.length === 0 || inList(policy.blockOn, code, v)) blocked.push(`${v.flow}: ${code}`);
    else if (inList(policy.warnOn, code, v)) warned.push(`${v.flow}: ${code}`);
    else blocked.push(`${v.flow}: ${code}`); // default: an unclassified failure blocks
  }

  const block = blocked.length > 0;
  // The built-in launch smoke and finding checks are not flows. A smoke-only run must not
  // read as "all required flows passed".
  const flowVerdicts = verdicts.filter((v) => v.flow !== 'launch_smoke' && !v.flow.startsWith('finding:'));
  const flowsPassed = flowVerdicts.filter((v) => v.outcome === undefined || v.outcome === 'pass').length;
  const reason = block
    ? `release blocked: ${blocked.join(', ')}`
    : warned.length
      ? `passed with warnings: ${warned.join(', ')}`
      : suppressed.length
        ? `passed (suppressed known issues: ${suppressed.join(', ')})`
        : flowsPassed && flowsPassed === flowVerdicts.length
          ? 'all required flows passed'
          : flowVerdicts.length
            ? `no failures recorded (${flowsPassed} of ${flowVerdicts.length} workflow(s) passed; the rest were blocked or skipped)`
            : verdicts.length
              ? 'no failures recorded (launch smoke only, 0 flows run)'
              : 'no failures recorded (0 workflows run)';
  return { block, blocked, warned, suppressed, reason };
}

/** Step kinds CI allows without a policy entry: restartApp only relaunches the app under test
 *  (no data, device or network change), and generated flows start with it. */
const CI_ALLOWED_BY_DEFAULT = new Set(['restartapp']);

export function ciMutationAllowed(policy: Policy | null, stepKind: string): boolean {
  if (CI_ALLOWED_BY_DEFAULT.has(norm(stepKind))) return true;
  if (!policy) return false;
  const allowed = policy.ciAllowMutations.map(norm);
  const requested = norm(stepKind);
  const aliases: Record<string, string[]> = {
    networkoffline: ['network', 'networktoggle', 'connectivity'],
    networkonline: ['network', 'networktoggle', 'connectivity'],
    seed: ['seeds', 'fixtures', 'fixtureseed'],
    restartapp: ['restart', 'lifecycle', 'appcontrol'],
    cleardata: ['clearappdata', 'freshstart', 'appcontrol', 'destructiveappstate'],
    freshstart: ['cleardata', 'clearappdata', 'appcontrol', 'destructiveappstate'],
    permissiongrant: ['permissions', 'permissionchanges', 'permission'],
    permissionrevoke: ['permissions', 'permissionchanges', 'permission'],
    geolocation: ['location', 'gps', 'mocklocation'],
    iosprivacyreset: ['privacyreset', 'permissions', 'permissionchanges', 'privacy'],
    ioserase: ['simulatorerase', 'erase', 'destructiveappstate'],
  };
  const accepted = new Set([requested, ...(aliases[requested] ?? [])]);
  return (
    allowed.includes('all') ||
    allowed.includes('*') ||
    allowed.includes('mutatingsteps') ||
    [...accepted].some((token) => allowed.includes(token))
  );
}
