// Pre-launch finding (MED): toolHealth recorded every qaError without a failureCode as UNKNOWN and
// any recorded error flipped the TOOL status to DEGRADED — so deliberate refusals (≈72 uncoded sites)
// and agent-probing misses (ELEMENT_NOT_FOUND / STALE_REF / AMBIGUOUS_SELECTOR / INVALID_ARGUMENT)
// made a healthy run read "Tool status: DEGRADED". Also the RN/Expo pm-clear bundle-loss refusal in
// qa_app_control carried no code (now BUNDLE_LOSS_REFUSED, an unsafe_refused guardrail).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolVerdictFor, toolErrorFromResult, isDegradingToolError } from '../src/report/toolHealth.js';
import { qaError } from '../src/lib/result.js';

const err = (failureCode: string, at = 1) => ({ at, tool: 'qa_act', failureCode, message: 'x' });

describe('tool verdict buckets', () => {
  it('uncoded errors alone do not degrade (counted in a separate bucket)', () => {
    const v = toolVerdictFor([], [err('UNKNOWN'), err('UNKNOWN', 2)]);
    expect(v.status).toBe('PASS');
    expect(v.uncodedCount).toBe(2);
    expect(v.degradingCount).toBe(0);
    expect(v.toolErrorCount).toBe(2);
    expect(v.summary).toMatch(/uncoded/);
  });

  it('agent-probing codes alone do not degrade', () => {
    const v = toolVerdictFor(
      [],
      ['ELEMENT_NOT_FOUND', 'STALE_REF', 'AMBIGUOUS_SELECTOR', 'INVALID_ARGUMENT'].map((c) => err(c)),
    );
    expect(v.status).toBe('PASS');
    expect(v.probingCount).toBe(4);
  });

  it('a typed tool-side failure still degrades (with uncoded ones alongside)', () => {
    const v = toolVerdictFor([], [err('WDA_SESSION_FAILED'), err('UNKNOWN')]);
    expect(v.status).toBe('DEGRADED');
    expect(v.degradingCount).toBe(1);
    expect(v.uncodedCount).toBe(1);
  });

  it('refusal buckets never degrade and are not recorded', () => {
    expect(isDegradingToolError('BUNDLE_LOSS_REFUSED')).toBe(false);
    const refused = qaError({
      what: 'Refusing clear',
      changedState: false,
      retrySafe: true,
      nextSteps: [],
      failureCode: 'BUNDLE_LOSS_REFUSED',
    });
    expect(toolErrorFromResult('qa_app_control', refused)).toBeUndefined();
  });

  it('qa_app_control RN/Expo bundle-loss refusal carries BUNDLE_LOSS_REFUSED', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'tools', 'appControl.ts'), 'utf8');
    const block = src.slice(src.indexOf('Refusing ${action}: ${fw} is an RN/Expo build'));
    expect(block.slice(0, 1500)).toContain("failureCode: 'BUNDLE_LOSS_REFUSED'");
  });
});
