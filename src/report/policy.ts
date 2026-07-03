// Release-gate policy (NEXT-PLAN: Reporting V3 / P1 release gate). A project can declare
// .swipium/policy.json to decide what blocks a release, what only warns, and which known issues
// to suppress. `swipium test` consults it to compute the final pass/fail.
//
//   {
//     "blockOn":   ["native_crash", "app_error_boundary", "failed_required_flow"],
//     "warnOn":    ["visual_diff", "missing_test_data"],
//     "ignoreKnown": ["REVENUECAT_BILLING_UNAVAILABLE_ON_EMULATOR"]
//   }
//
// Tokens are matched case-insensitively against failure codes (e.g. NATIVE_CRASH ↔ "native_crash")
// and a few synonyms; `failed_required_flow` matches any failed flow regardless of code.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Policy {
  blockOn: string[];
  warnOn: string[];
  ignoreKnown: string[];
  ciAllowMutations: string[];
}

export function loadPolicy(root: string): Policy | null {
  const p = join(root, '.swipium', 'policy.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as Partial<Policy>;
    return {
      blockOn: j.blockOn ?? [],
      warnOn: j.warnOn ?? [],
      ignoreKnown: j.ignoreKnown ?? [],
      ciAllowMutations: j.ciAllowMutations ?? [],
    };
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// Map policy synonyms → the normalized failure-code form.
const SYNONYMS: Record<string, string> = {
  appbug: 'assertionfailed',
  visualdiff: 'assertionfailed',
  crash: 'nativecrash',
  errorboundary: 'errorboundary',
};

/** A single flow's failure, as seen by the policy. */
export interface FlowVerdict {
  flow: string;
  passed: boolean;
  failureCode?: string;
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

  const inList = (list: string[], code: string) => {
    const c = norm(code);
    return list.some((tok) => {
      const t = norm(tok);
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
    if (policy.blockOn.length === 0 || inList(policy.blockOn, code)) blocked.push(`${v.flow}: ${code}`);
    else if (inList(policy.warnOn, code)) warned.push(`${v.flow}: ${code}`);
    else blocked.push(`${v.flow}: ${code}`); // default: an unclassified failure blocks
  }

  const block = blocked.length > 0;
  const reason = block
    ? `release blocked: ${blocked.join(', ')}`
    : warned.length
      ? `passed with warnings: ${warned.join(', ')}`
      : suppressed.length
        ? `passed (suppressed known issues: ${suppressed.join(', ')})`
        : 'all required flows passed';
  return { block, blocked, warned, suppressed, reason };
}

export function ciMutationAllowed(policy: Policy | null, stepKind: string): boolean {
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
