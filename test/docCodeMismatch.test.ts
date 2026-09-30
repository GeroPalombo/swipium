// Regressions for code/doc mismatches fixed before 2.0.0:
//  - qa_generate: every target returns failureCode NO_RECORDED_ACTIONS on an empty session
//    (flow/pom/suite/testcases used to fall through to UNKNOWN; only appium was coded).
//  - the deep-link flow template's placeholder is SWIPIUM_-prefixed (a bare ${TEST_DEEP_LINK} can
//    never resolve from the environment under the SWIPIUM_-only rule).
//  - the policy.ts example token `error_boundary` really matches ERROR_BOUNDARY.
//  - qa_issue_log / qa_mobile_audit no longer return a `resourceUri` (swipium://project/<id>/issues)
//    that no resource template serves and qa_get_artifact cannot read.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDriver, buttonScreen, harness, structured } from './actFixFake.js';
import { flowTemplateFiles } from '../src/flows/templates.js';
import { applyPolicy } from '../src/report/policy.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('doc-code-mismatch');
});
afterAll(async () => {
  await h.close();
});

describe('qa_generate with no recorded actions', () => {
  for (const target of ['flow', 'pom', 'suite', 'testcases', 'appium'] as const) {
    it(`target:"${target}" returns failureCode NO_RECORDED_ACTIONS`, async () => {
      const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
      const extra = target === 'appium' ? { bootstrap: false } : {};
      const res = await h.call('qa_generate', { target, sessionId: id, ...extra });
      expect(res.isError).toBe(true);
      const s = structured(res);
      expect(s.failureCode).toBe('NO_RECORDED_ACTIONS');
      expect(s.retrySafe).toBe(true);
    }, 20_000);
  }
});

describe('flow templates', () => {
  it('every ${VAR} placeholder is SWIPIUM_-prefixed (resolvable from the environment)', () => {
    const root = mkdtempSync(join(tmpdir(), 'swipium-templates-'));
    try {
      const vars = flowTemplateFiles(root).flatMap((f) => [...f.content.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]));
      expect(vars).toContain('SWIPIUM_TEST_DEEP_LINK');
      for (const v of vars) expect(v, `${v} must start with SWIPIUM_`).toMatch(/^SWIPIUM_/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release-gate policy example tokens', () => {
  it('"error_boundary" (the documented example) blocks an ERROR_BOUNDARY failure', () => {
    const d = applyPolicy([{ flow: 'home', passed: false, failureCode: 'ERROR_BOUNDARY' }], {
      blockOn: ['native_crash', 'error_boundary'],
      warnOn: [],
      ignoreKnown: [],
      ciAllowMutations: [],
    });
    expect(d.block).toBe(true);
    expect(d.blocked).toEqual(['home: ERROR_BOUNDARY']);
  });
});

describe('issue ledger results carry no unreadable resourceUri', () => {
  const OBS = {
    title: 'Avatar renders blank',
    summary: 'Avatar image renders blank on profile',
    category: 'app_bug',
    severity: 'high',
    platform: 'android',
  };

  it('qa_issue_log (log, history, metrics) and qa_mobile_audit plan omit resourceUri', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'swipium-issue-uri-'));
    try {
      const results = [
        await h.call('qa_issue_log', { projectRoot, mode: 'log', ...OBS }),
        await h.call('qa_issue_log', { projectRoot, mode: 'history' }),
        await h.call('qa_issue_log', { projectRoot, mode: 'metrics' }),
        await h.call('qa_mobile_audit', { projectRoot, profile: 'smoke' }),
      ];
      for (const res of results) {
        const s = structured(res);
        expect(s.ok, JSON.stringify(res.content)).toBe(true);
        expect(s).not.toHaveProperty('resourceUri');
        expect(JSON.stringify(res)).not.toMatch(/swipium:\/\/project\/[^"]*\/issues/);
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('qa_metro typed errors', () => {
  it('every qaError in src/tools/metro.ts carries a failureCode', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/tools/metro.ts', import.meta.url), 'utf8');
    const blocks = src
      .split('qaError({')
      .slice(1)
      .map((b) => b.slice(0, b.indexOf('});')));
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b).toMatch(/failureCode:/);
  });
});
