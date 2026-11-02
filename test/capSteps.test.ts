// The step cap: oldest passing steps go first; once only failures are left the first failure stays
// and the oldest of the others is dropped.

import { describe, expect, it } from 'vitest';
import { capSteps, type StepRecord } from '../src/session/store.js';

const st = (i: number, result: StepRecord['result']): StepRecord => ({ i, at: i, durationMs: 1, source: 'act', action: 'tap', result });

describe('capSteps', () => {
  it('drops the oldest passing steps first', () => {
    const out = capSteps([st(0, 'failed'), st(1, 'ok'), st(2, 'ok'), st(3, 'failed')], 3);
    expect(out.map((s) => s.i)).toEqual([0, 2, 3]);
  });

  it('with only failures left, keeps the first failure and drops the second-oldest', () => {
    const out = capSteps([st(0, 'failed'), st(1, 'failed'), st(2, 'failed'), st(3, 'failed')], 3);
    expect(out.map((s) => s.i)).toEqual([0, 2, 3]);
    expect(capSteps(out, 2).map((s) => s.i)).toEqual([0, 3]);
  });
});
