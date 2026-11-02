// report.html stops decoding screenshots once the image budget is spent, and never decodes the
// same failed or over-budget image twice.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const calls = vi.hoisted(() => ({ downscale: 0 }));
vi.mock('../src/lib/png.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/png.js')>();
  return {
    ...real,
    downscalePng: (png: Buffer, w: number) => {
      calls.downscale++;
      return real.downscalePng(png, w);
    },
  };
});

const { renderReportHtml } = await import('../src/report/html.js');
type ReportData = import('../src/report/export.js').ReportData;

const IOS_PNG = join(__dirname, 'fixtures', 'png', 'ios-simctl-redbox-1206x2622.png');
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function report(over: Partial<ReportData>): ReportData {
  return {
    sessionId: 's1',
    coverage: 'smoke',
    executiveSummary: { risk: 'ship', reasons: [], nextAction: '' },
    nativeHealth: 'OK',
    appHealth: 'OK',
    findings: [],
    highSeverityCount: 0,
    testOutcomes: [],
    outcomeTally: {},
    environmentChanges: [],
    guardrailOverrides: [],
    finalNetwork: 'online',
    networkRestore: 'unchanged',
    authState: 'unknown',
    artifacts: [],
    ...over,
  } as ReportData;
}

describe('report.html image budget', () => {
  it('decodes at most one image once the budget is spent, and each URI at most once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swipium-html-budget-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'screenshots'));
    const M = 6;
    const arts = Array.from({ length: M }, (_, k) => {
      copyFileSync(IOS_PNG, join(dir, 'screenshots', `s${k}.png`));
      return { uri: `swipium://session/s1/screenshot/s${k}.png`, kind: 'screenshot', path: `screenshots/s${k}.png` };
    });
    writeFileSync(join(dir, 'screenshots', 'junk.png'), 'not a png');
    const junk = { uri: 'swipium://session/s1/screenshot/junk.png', kind: 'screenshot', path: 'screenshots/junk.png' };
    // Every image mentioned twice: once as outcome evidence, once on a timeline step.
    const all = [junk, ...arts];
    const r = report({
      testOutcomes: all.map((a, k) => ({ workflow: `W${k}`, outcome: 'pass' as const, evidence: [a.uri] })),
      steps: all.map((a, k) => ({
        i: k + 1,
        at: k,
        durationMs: 1,
        source: 'act' as const,
        action: 'tap',
        result: 'ok' as const,
        screenshotUri: a.uri,
      })),
      artifacts: all,
    });
    calls.downscale = 0;
    const html = await renderReportHtml(r, { sessionDir: dir, imageBudgetBytes: 10 });
    // junk (fails once) + the first real image (over budget); the other M-1 are never decoded.
    expect(calls.downscale).toBe(2);
    expect(html).not.toContain('<img ');
    expect(html).toContain(`${M} image(s) were not embedded`);
    expect(html.match(/screenshots\/junk\.png<\/code> \(could not embed this image\)/g)?.length).toBe(2);
    expect(html.match(/screenshots\/s5\.png<\/code> \(not embedded: report image budget/g)?.length).toBe(2);
  });
});
