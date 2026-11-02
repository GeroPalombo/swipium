// Every guarded capture path, one table: a secure field on screen (or a sensitive session) means no
// screenshot is taken, no image file is written, and the site records why. A clean screen is the
// control: the same site does capture there, so the table can't pass vacuously.
//
// To cover another call site, add a row to SITES: drive the site once and return the withheld note
// it recorded (see CaptureSiteRow in test/helpers/captureHarness.ts).

import { afterAll, describe, expect, it } from 'vitest';
import { CLEAN_SCREEN, SECURE_SCREEN, captureHarness, cleanupCaptureHarnesses, type CaptureSiteRow } from './helpers/captureHarness.js';

const { observeScreen } = await import('../src/firstRun/firstRunRunner.js');
const { recordHealthFindings } = await import('../src/oracle/record.js');
const { captureScreenshot, snapshotText } = await import('../src/mobileAudit/evidence.js');
const { runOcr } = await import('../src/visual/ocr.js');
const { CaptureWithheldError } = await import('../src/lib/captureGuard.js');

afterAll(() => cleanupCaptureHarnesses());

const SITES: CaptureSiteRow[] = [
  {
    site: 'firstRun/firstRunRunner.ts observeScreen',
    run: async (h) => (await observeScreen(h.sessions, h.session, h.driver)).screenshotWithheld,
  },
  {
    site: 'oracle/record.ts recordHealthFindings (app-error evidence)',
    run: async (h) => {
      const r = await recordHealthFindings(
        h.sessions,
        h.session,
        [{ severity: 'high', kind: 'redbox', detail: 'React Native RedBox', layer: 'app' }],
        h.driver,
      );
      // The finding itself is still recorded, just without an image.
      const f = h.session.findings.at(-1)!;
      expect(f.kind).toBe('redbox');
      if (r.screenshotWithheld) expect(f.screenshotUri).toBeUndefined();
      return r.screenshotWithheld;
    },
  },
  {
    site: 'mobileAudit/evidence.ts captureScreenshot',
    run: async (h) => {
      const ctx = { sessions: h.sessions, session: h.session, driver: h.driver };
      const uri = await captureScreenshot(ctx, 'audit launch');
      if (ctx.withheldCaptures?.length) expect(uri).toBeUndefined();
      return ctx.withheldCaptures?.[0];
    },
  },
  {
    site: 'visual/ocr.ts runOcr (pixels to an OCR provider)',
    clean: false,
    run: async (h) => {
      try {
        await runOcr(h.driver, h.root, ['node', '-e', ''], { session: h.session });
        return undefined;
      } catch (e) {
        if (e instanceof CaptureWithheldError) return e.verdict.note;
        throw e;
      }
    },
  },
];

describe.each(SITES)('$site', (row) => {
  it('secure field on screen (stale cache, the guard re-dumps): no capture, no file, withheld noted', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN });
    const note = await row.run(h);
    expect(note).toMatch(/screenshot withheld \(secure field\)/);
    expect(h.driver.shots).toBe(0);
    expect(h.imageFiles()).toEqual([]);
  });

  it('secure field in the fresh cached snapshot: no capture, no file, withheld noted', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN, cache: true });
    const note = await row.run(h);
    expect(note).toMatch(/screenshot withheld \(secure field\)/);
    expect(h.driver.shots).toBe(0);
    expect(h.imageFiles()).toEqual([]);
  });

  it('sensitive session on a clean screen: no capture, no file, withheld noted', async () => {
    const h = await captureHarness({ screen: CLEAN_SCREEN, sensitive: true });
    const note = await row.run(h);
    expect(note).toMatch(/screenshot withheld \(sensitive session\)/);
    expect(h.driver.shots).toBe(0);
    expect(h.imageFiles()).toEqual([]);
  });

  it.skipIf(row.clean === false)('clean screen: the site captures and writes the image', async () => {
    const h = await captureHarness({ screen: CLEAN_SCREEN });
    const note = await row.run(h);
    expect(note).toBeUndefined();
    expect(h.driver.shots).toBeGreaterThan(0);
    expect(h.imageFiles().length).toBeGreaterThan(0);
  });
});

describe('audit evidence reuses the tree the check just read', () => {
  it('a secure field in the snapshotText tree withholds with no extra dump', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN });
    const ctx: Parameters<typeof captureScreenshot>[0] = { sessions: h.sessions, session: h.session, driver: h.driver };
    await snapshotText(ctx);
    expect(await captureScreenshot(ctx, 'audit privacy')).toBeUndefined();
    expect(ctx.withheldCaptures).toEqual(['audit privacy: screenshot withheld (secure field)']);
    expect(h.driver.got('dumpXml')).toHaveLength(1);
    expect(h.driver.shots).toBe(0);
  });
});
