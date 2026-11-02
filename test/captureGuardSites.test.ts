// Every guarded capture path, one table: a secure field on screen (or a sensitive session) means no
// screenshot is taken, no image file is written, and the site records why. A clean screen is the
// control: the same site does capture there, so the table can't pass vacuously.
//
// To cover another call site, add a row to SITES: drive the site once and return the withheld note
// it recorded (see CaptureSiteRow in test/helpers/captureHarness.ts).

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLEAN_SCREEN,
  SECURE_SCREEN,
  captureHarness,
  cleanupCaptureHarnesses,
  toolHandler,
  type CaptureHarness,
  type CaptureSiteRow,
} from './helpers/captureHarness.js';

const { observeScreen } = await import('../src/firstRun/firstRunRunner.js');
const { recordHealthFindings } = await import('../src/oracle/record.js');
const { captureScreenshot, snapshotText } = await import('../src/mobileAudit/evidence.js');
const { runOcr } = await import('../src/visual/ocr.js');
const { CaptureWithheldError } = await import('../src/lib/captureGuard.js');
const { registerAct } = await import('../src/tools/act.js');
const { registerNote } = await import('../src/tools/note.js');
const { parseFlow } = await import('../src/flows/schema.js');
const { runFlow } = await import('../src/flows/run.js');
const { runSmoke } = await import('../src/services/smoke.js');
const { runExplore } = await import('../src/explore/runner.js');

afterAll(() => cleanupCaptureHarnesses());

/** Run a one-flow YAML on the harness device and return its first step's result. */
async function flowStep(h: CaptureHarness, yaml: string) {
  const parsed = parseFlow(yaml);
  if (!parsed.flow) throw new Error(parsed.errors.join('; '));
  const run = await runFlow(h.sessions, h.session, h.driver, parsed.flow);
  return run.steps[0];
}

/** Configure an OCR provider that leaves a marker file when it runs (and finds nothing). */
function configureMarkerOcr(h: CaptureHarness): string {
  const marker = join(h.root, 'ocr-provider-ran');
  mkdirSync(join(h.root, '.swipium'), { recursive: true });
  writeFileSync(
    join(h.root, '.swipium', 'config.json'),
    JSON.stringify({ ocrCommand: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log('[]')`] }),
  );
  return marker;
}

/** An OCR flow step with a marker provider configured: a withheld
 *  capture fails the step with CAPTURE_WITHHELD_SECURE and never reaches the provider. A sensitive
 *  session is refused before the guard (UNSAFE_ACTION_REFUSED), and the failure screenshot that
 *  follows is withheld too, which is what the step detail records. */
async function ocrFlowStep(h: CaptureHarness, step: string): Promise<string | undefined> {
  const marker = configureMarkerOcr(h);
  const rec = await flowStep(h, `name: ocr\nsteps:\n  - ${step}\n`);
  expect(existsSync(marker)).toBe(false);
  expect(rec.ok).toBe(false);
  expect(rec.failureCode).toBe(h.session.sensitive ? 'UNSAFE_ACTION_REFUSED' : 'CAPTURE_WITHHELD_SECURE');
  if (!h.session.sensitive) expect(rec.detail).toMatch(/^OCR not run: screenshot withheld/);
  // The timeline step reuses the withheld failure screenshot.
  expect(h.session.steps.at(-1)?.screenshotSkipped).toMatch(/screenshot withheld/);
  return rec.detail;
}

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
      const ctx: Parameters<typeof captureScreenshot>[0] = { sessions: h.sessions, session: h.session, driver: h.driver };
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
  {
    site: 'tools/act.ts failed qa_act step (lib/steps.ts captureFailedStepEvidence)',
    run: async (h) => {
      h.session.driver = h.driver;
      const act = toolHandler(registerAct, h.sessions, 'qa_act');
      const res = await act({ sessionId: h.session.id, action: 'tap', target: { text: 'No such button' } });
      expect((res.structuredContent as { ok?: boolean }).ok).toBe(false);
      const st = h.session.steps.at(-1)!;
      expect(st).toMatchObject({ source: 'act', result: 'failed' });
      if (st.screenshotSkipped) expect(st.screenshotUri).toBeUndefined();
      return st.screenshotSkipped;
    },
  },
  {
    site: 'tools/note.ts qa_note checkpoint on a pass/fail note',
    run: async (h) => {
      h.session.driver = h.driver;
      const note = toolHandler(registerNote, h.sessions, 'qa_note');
      const res = await note({ sessionId: h.session.id, workflow: 'Login', outcome: 'fail' });
      const sc = res.structuredContent as { checkpointSkipped?: string; checkpointUri?: string };
      const n = h.session.notes.at(-1)!;
      expect(n.checkpointSkipped).toBe(sc.checkpointSkipped);
      expect(h.session.steps.at(-1)?.screenshotSkipped).toBe(sc.checkpointSkipped);
      if (sc.checkpointSkipped) expect(n.checkpointUri).toBeUndefined();
      return n.checkpointSkipped;
    },
  },
  {
    site: 'flows/run.ts failure screenshot of a failed flow step',
    run: async (h) => {
      const rec = await flowStep(h, 'name: broken\nsteps:\n  - assertVisible: "Not on this screen"\n');
      expect(rec.ok).toBe(false);
      const st = h.session.steps.at(-1)!;
      if (st.screenshotSkipped) {
        expect(rec.detail).toContain(st.screenshotSkipped);
        expect(rec.screenshotUri).toBeUndefined();
        expect(st.screenshotUri).toBeUndefined();
      }
      return st.screenshotSkipped;
    },
  },
  {
    site: 'flows/run.ts screenshot step',
    run: async (h) => {
      const rec = await flowStep(h, 'name: shot\nsteps:\n  - screenshot: "login screen"\n');
      expect(rec.ok).toBe(true);
      return rec.detail;
    },
  },
  {
    site: 'flows/run.ts assertVisual checkpoint',
    run: async (h) => {
      const rec = await flowStep(h, 'name: vis\nsteps:\n  - assertVisual: "login screen"\n');
      expect(rec.ok).toBe(true);
      const n = h.session.notes.find((x) => x.workflow === 'vis:visual')!;
      if (rec.detail) {
        expect(n).toMatchObject({ outcome: 'skipped', origin: 'flow_note' });
        expect(n.reason).toMatch(/not captured, screenshot withheld/);
        expect(n.artifactUris).toBeUndefined();
      } else expect(n.outcome).toBe('pass');
      return rec.detail;
    },
  },
  {
    site: 'flows/run.ts assertOcrText (pixels to an OCR provider)',
    clean: false,
    run: (h) => ocrFlowStep(h, 'assertOcrText: "Sign in"'),
  },
  {
    site: 'flows/run.ts tapOcrText (pixels to an OCR provider)',
    clean: false,
    run: (h) => ocrFlowStep(h, 'tapOcrText: "Log in"'),
  },
  {
    site: 'services/smoke.ts launch baseline screenshot',
    run: async (h) => {
      const res = await runSmoke(h.sessions, h.session, h.driver, { launch: true, runFlows: false });
      const st = h.session.steps.find((x) => x.source === 'smoke' && x.action === 'launch')!;
      const n = h.session.notes.find((x) => x.workflow === 'launch_smoke')!;
      expect((res.baseline.launch as { screenshotSkipped?: string } | undefined)?.screenshotSkipped).toBe(st.screenshotSkipped);
      if (st.screenshotSkipped) {
        expect(n.reason).toContain(`(${st.screenshotSkipped})`);
        expect(n.artifactUris).toBeUndefined();
        expect(st.screenshotUri).toBeUndefined();
      }
      return st.screenshotSkipped;
    },
  },
  {
    site: 'explore/runner.ts per-screen observe screenshot',
    recordsCount: true,
    grabsBeforeGuard: true,
    run: async (h) => {
      const res = await runExplore(h.sessions, h.session, h.driver, { maxActions: 1, maxDurationMs: 20_000, stopOnAuth: true });
      const n = res.summary.screenshotsWithheld ?? 0;
      if (n > 0) for (const node of res.graph.allNodes()) expect(node.screenshotUri).toBeUndefined();
      return n > 0 ? `${n} screenshot(s) withheld` : undefined;
    },
  },
];

describe.each(SITES)('$site', (row) => {
  const expectWithheld = (h: CaptureHarness, note: string | undefined, reason: RegExp, grabbed = false) => {
    if (row.recordsCount) expect(note).toBeTruthy();
    else expect(note).toMatch(reason);
    if (!grabbed) expect(h.driver.shots).toBe(0);
    expect(h.imageFiles()).toEqual([]);
    expect(h.session.artifacts.filter((a) => a.mime.startsWith('image/'))).toEqual([]);
  };

  it('secure field on screen (stale cache, the guard re-dumps): no capture, no file, withheld noted', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN });
    expectWithheld(h, await row.run(h), /screenshot withheld \(secure field\)/, row.grabsBeforeGuard);
  }, 60_000);

  it('secure field in the fresh cached snapshot: no capture, no file, withheld noted', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN, cache: true });
    expectWithheld(h, await row.run(h), /screenshot withheld \(secure field\)/, row.grabsBeforeGuard);
  }, 60_000);

  it('sensitive session on a clean screen: no capture, no file, withheld noted', async () => {
    const h = await captureHarness({ screen: CLEAN_SCREEN, sensitive: true });
    expectWithheld(h, await row.run(h), /screenshot withheld \(sensitive session\)/);
  }, 60_000);

  it.skipIf(row.clean === false)(
    'clean screen: the site captures and writes the image',
    async () => {
      const h = await captureHarness({ screen: CLEAN_SCREEN });
      const note = await row.run(h);
      expect(note).toBeUndefined();
      expect(h.driver.shots).toBeGreaterThan(0);
      expect(h.imageFiles().length).toBeGreaterThan(0);
    },
    60_000,
  );
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

describe('the OCR flow rows are not vacuous', () => {
  it('on a clean screen the same flow step does reach the provider', async () => {
    const h = await captureHarness({ screen: CLEAN_SCREEN });
    const marker = configureMarkerOcr(h);
    const rec = await flowStep(h, 'name: ocr\nsteps:\n  - assertOcrText: "Home"\n');
    expect(existsSync(marker)).toBe(true);
    expect(rec.failureCode).toBe('ASSERTION_FAILED');
    expect(h.driver.shots).toBeGreaterThan(0);
  }, 60_000);
});
