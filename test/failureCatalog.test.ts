// The failure catalog (src/oracle/failures.ts) is what qa_explain_blocker explains and what
// reports classify by. Every failureCode a tool can return must be in it — otherwise an agent that
// follows the "relay the failureCode, call qa_explain_blocker" rule hits "Unknown failure code".
// Static scan: every `failureCode: 'X'` and `qaFail('X'` literal under src/ (deferred modules
// excluded), plus the ledger / generator error codes that tools forward as failureCode.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAILURES } from '../src/oracle/failures.js';

const SRC = join(import.meta.dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'deferred' ? [] : tsFiles(join(dir, e.name));
    return e.name.endsWith('.ts') ? [join(dir, e.name)] : [];
  });
}

describe('failure catalog completeness', () => {
  it('every failure code returned by a tool is in FAILURES', () => {
    const used = new Set<string>();
    const re = /(?:failureCode:\s*|qaFail\(\s*)'([A-Z][A-Z0-9_]{3,})'/g;
    for (const f of tsFiles(SRC))
      for (const m of readFileSync(f, 'utf8')
        .replace(/^\s*\/\/.*$/gm, '')
        .matchAll(re))
        used.add(m[1]);
    expect(used.size).toBeGreaterThan(20);
    // Forwarded as failureCode by qa_issue_log (LedgerErrorCode) and qa_generate (UnemittableStepError / suite plan).
    for (const c of ['ISSUE_NOT_FOUND', 'ISSUE_STATE_INVALID', 'ISSUE_EVIDENCE_REQUIRED', 'UNEMITTABLE_STEP', 'NO_RECORDED_ACTIONS'])
      used.add(c);
    const missing = [...used].filter((c) => !(c in FAILURES)).sort();
    expect(missing, `add these to src/oracle/failures.ts: ${missing.join(', ')}`).toEqual([]);
  });
});
