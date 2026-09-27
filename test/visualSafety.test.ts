// qa_visual hardening (1.6.0-RC review B5–B8 + OCR docs issue):
//   B5 baseline names / diff reads / find_image templates cannot escape the project;
//   B6 WDA-less simulator taps go to `idb ui tap` in POINTS (3x fake: 1179×2556 px → 393×852 pt);
//   B7 visual taps are recorded as session actions, budgeted, and respect budgetStop;
//   B8 snapshot-less screens: credential-handling sessions need force for baseline only (diff/
//      assert keep no evidence; find_text is OCR-screened; structured backends re-dump), OCR that reads like a
//      password/OTP screen is withheld, and every OCR text (incl. regions[].text) is redacted;
//   find_text without a provider → OCR_NOT_CONFIGURED with the provider contract.
// Hermetic: fake drivers via the attach.ts seam; spawn `run`/`which` mocked (idb never runs);
// runOcr mocked but keeps the REAL coordinate-space capture from the driver.

import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-visual-safety-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
delete process.env.SWIPIUM_OCR_CMD;

const ocrState: {
  configured: boolean;
  text: string;
  regions: Array<{ text: string; confidence: number; bbox: { x: number; y: number; width: number; height: number } }>;
} = { configured: true, text: '', regions: [] };
const spawnCalls: string[][] = [];

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return {
    ...actual,
    run: async (cmd: string, args: string[]) => {
      spawnCalls.push([cmd, ...args]);
      return { code: cmd === 'idb' ? 0 : 1, stdout: '', stderr: '', timedOut: false };
    },
  };
});
vi.mock('../src/lib/android.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/android.js')>();
  return { ...actual, which: async (bin: string) => bin === 'idb' };
});
vi.mock('../src/visual/ocr.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/visual/ocr.js')>();
  const { captureCoordinateSpace } = await import('../src/lib/coordSpace.js');
  return {
    ...actual,
    configuredOcrCommand: () => (ocrState.configured ? ['fake-ocr', '{image}'] : undefined),
    runOcr: async (driver: import('../src/drivers/Driver.js').Driver) => {
      const png = await driver.screenshot();
      return {
        text: ocrState.text,
        regions: ocrState.regions.map((r) => ({ ...r, coordinateSpace: 'screenshot_px' as const })),
        coordinateSpace: await captureCoordinateSpace(driver, png),
        provider: { io: 'argv' as const, argv: ['fake-ocr', '<screenshot>'] },
        masking: { providerConfigured: false, masksApplied: [] },
      };
    },
  };
});

const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
const { parseOcrOutput, TESSERACT_OCR_EXAMPLE } = await import('../src/visual/ocr.js');
type Driver = import('../src/drivers/Driver.js').Driver;
type SessionStore = import('../src/session/store.js').SessionStore;

function makePng(width: number, height: number, color: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = color(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = 255;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const SMALL = makePng(64, 64, (x, y) => (x >= 20 && x < 30 && y >= 20 && y < 30 ? [250, 250, 250] : [30, 30, 30]));
const TEMPLATE = makePng(14, 14, (x, y) => (x >= 2 && x < 12 && y >= 2 && y < 12 ? [250, 250, 250] : [30, 30, 30]));

/** Header-only PNG: enough for pngSize() (the coordinate space) without a 12 MB buffer. */
function headerOf(width: number, height: number): Buffer {
  const b = Buffer.from(makePng(1, 1, () => [0, 0, 0]));
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Minimal driver; `kind` selects the backend (simulator = WDA-less, taps via idb). */
class FakeDriver implements Driver {
  taps: Array<[number, number]> = [];
  screen: Buffer = SMALL;
  size = { width: 64, height: 64 };
  constructor(readonly kind: 'direct' | 'simulator') {}
  async listDevices(): Promise<string[]> {
    return ['SIM-1'];
  }
  useDevice(): void {}
  currentDevice(): string | undefined {
    return this.kind === 'simulator' ? 'SIM-1' : undefined;
  }
  async installApp(): Promise<void> {}
  async isInstalled(): Promise<boolean> {
    return true;
  }
  async isRunning(): Promise<boolean> {
    return true;
  }
  async launchApp(): Promise<void> {}
  async terminateApp(): Promise<void> {}
  async clearData(): Promise<void> {}
  async imeShown(): Promise<boolean> {
    return false;
  }
  async logcat(): Promise<string> {
    return '';
  }
  async airplaneOn(): Promise<boolean> {
    return false;
  }
  async setAirplane(): Promise<void> {}
  async foregroundOwner(): Promise<string> {
    return 'unknown';
  }
  async screenshot(): Promise<Buffer> {
    return this.screen;
  }
  async dumpXml(): Promise<string> {
    throw new Error('no UI tree');
  }
  async tapXY(x: number, y: number): Promise<void> {
    if (this.kind === 'simulator') throw new Error('tap not supported');
    this.taps.push([x, y]);
  }
  async pressXY(): Promise<void> {}
  async inputText(): Promise<void> {}
  async clearFocusedText(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async swipe(): Promise<void> {}
  async adbReverseMetro(): Promise<void> {}
  async screenSize(): Promise<{ width: number; height: number } | null> {
    return this.size;
  }
  async screenDensity(): Promise<number | null> {
    return null;
  }
  async openUrl(): Promise<void> {}
  async disableAnimations(): Promise<void> {}
}

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, `expected structuredContent, got: ${JSON.stringify(res.content)}`).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

describe('qa_visual safety + WDA-less correctness', () => {
  let client: Client;
  let sessions: SessionStore;
  let driver: FakeDriver;
  let projectRoot: string;
  let outside: string;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-visual-safety-project-'));
    outside = mkdtempSync(join(tmpdir(), 'swipium-visual-safety-outside-'));
    driver = new FakeDriver('direct');
    setDriverFactoryForTests(() => driver);
    const ctx = createServer();
    sessions = ctx.sessions;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'visual-safety-test', version: '0' });
    await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    await client.close();
    for (const d of [fakeHome, projectRoot, outside]) rmSync(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    driver = new FakeDriver('direct');
    ocrState.configured = true;
    ocrState.text = '';
    ocrState.regions = [];
    spawnCalls.length = 0;
  });

  const newSession = async (): Promise<string> =>
    structured((await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult).sessionId as string;
  const call = async (sessionId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    structured((await client.callTool({ name: 'qa_visual', arguments: { sessionId, ...args } })) as CallToolResult);
  const ocr = async (sessionId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const env = await call(sessionId, { mode: 'find_text', ...args });
    if (!env.requiresConsent) return env;
    return call(sessionId, { mode: 'find_text', ...args, consentId: env.consentId, approve: true });
  };

  // ---- B5 ----
  it('B5: refuses traversal / hidden baseline names and never writes outside .swipium/baselines', async () => {
    const sid = await newSession();
    for (const name of ['../../src/assets/logo', '../evil', '..', '.hidden', 'a/b', 'x'.repeat(65), 'sp ace']) {
      const res = await call(sid, { mode: 'baseline', name });
      expect(res.ok, name).toBe(false);
      expect(res.failureCode, name).toBe('VISUAL_PATH_REFUSED');
    }
    expect(existsSync(join(projectRoot, 'src', 'assets', 'logo.png'))).toBe(false);
    expect(existsSync(join(projectRoot, '.swipium', 'evil.png'))).toBe(false);
    expect((await call(sid, { mode: 'diff', name: '../../../etc/passwd-ish' })).failureCode).toBe('VISUAL_PATH_REFUSED');

    const ok = await call(sid, { mode: 'baseline', name: 'home.v2_final-1' });
    expect(ok.ok).toBe(true);
    expect(existsSync(join(projectRoot, '.swipium', 'baselines', 'home.v2_final-1.png'))).toBe(true);
  });

  it('B5: find_image templates must be inside the project root or a swipium:// artifact', async () => {
    const sid = await newSession();
    const outsideTpl = join(outside, 'tpl.png');
    writeFileSync(outsideTpl, TEMPLATE);
    const abs = await call(sid, { mode: 'find_image', template: outsideTpl });
    expect(abs.ok).toBe(false);
    expect(abs.failureCode).toBe('VISUAL_PATH_REFUSED');
    const rel = await call(sid, { mode: 'find_image', template: `../${join(outside, 'tpl.png').split('/').slice(-2).join('/')}` });
    expect(rel.ok).toBe(false);

    mkdirSync(join(projectRoot, 'refs'), { recursive: true });
    writeFileSync(join(projectRoot, 'refs', 'tpl.png'), TEMPLATE);
    const inside = await call(sid, { mode: 'find_image', template: 'refs/tpl.png' });
    expect(inside.ok).toBe(true);
    expect(inside.found).toBe(true);
    const insideAbs = await call(sid, { mode: 'find_image', template: join(projectRoot, 'refs', 'tpl.png') });
    expect(insideAbs.found).toBe(true);

    // A session artifact URI is allowed (e.g. a saved baseline as the template).
    const base = await call(sid, { mode: 'baseline', name: 'as-template' });
    const viaUri = await call(sid, { mode: 'find_image', template: base.uri as string, minScore: 0.5 });
    expect(viaUri.ok).toBe(true);
  });

  // ---- B6 + B7 ----
  it('B6/B7: WDA-less simulator taps go to idb in POINTS and are recorded + budgeted', async () => {
    driver = new FakeDriver('simulator');
    driver.screen = headerOf(1179, 2556);
    driver.size = { width: 393, height: 852 }; // SimctlDriver reports points
    const sid = await newSession();
    const session = sessions.get(sid)!;
    ocrState.text = 'Continue';
    ocrState.regions = [{ text: 'Continue', confidence: 0.97, bbox: { x: 540, y: 2340, width: 120, height: 60 } }];

    const res = await ocr(sid, { query: 'Continue', tap: true });
    expect(res.ok).toBe(true);
    expect(res.tapVia).toBe('idb');
    expect((res.coordinateSpace as { scale: number }).scale).toBe(3);
    // bbox centre (600, 2370) px ÷ 3 → (200, 790) pt — inside the 393×852 pt screen.
    expect(res.devicePoint).toEqual({ x: 200, y: 790 });
    expect(spawnCalls).toContainEqual(['idb', 'ui', 'tap', '200', '790', '--udid', 'SIM-1']);

    expect(session.counters.actions).toBe(1);
    expect(session.counters.screenshots).toBe(1);
    expect(session.recordedActions).toHaveLength(1);
    const ra = session.recordedActions[0];
    expect(ra).toMatchObject({ action: 'tap', x: 200, y: 790, selectorKind: 'coords', exportability: 'coordinate' });
    expect(ra.provenance?.visual?.ocrText).toBe('Continue');

    // Budget: once the action budget is spent, qa_visual stops before capturing or tapping.
    session.budget.maxActions = 1;
    spawnCalls.length = 0;
    const stopped = await ocr(sid, { query: 'Continue', tap: true });
    expect(stopped.stopped).toBe(true);
    expect(String(stopped.reason)).toMatch(/action budget/);
    expect(spawnCalls.filter((c) => c[0] === 'idb')).toHaveLength(0);
    expect(session.recordedActions).toHaveLength(1);
  });

  it('B7: pixel captures count as screenshots and the screenshot budget stops the tool', async () => {
    const sid = await newSession();
    const session = sessions.get(sid)!;
    session.budget.maxScreenshots = 2;
    expect((await call(sid, { mode: 'baseline', name: 'one' })).ok).toBe(true);
    expect((await call(sid, { mode: 'diff', name: 'one' })).ok).toBe(true);
    expect(session.counters.screenshots).toBe(2);
    const stopped = await call(sid, { mode: 'diff', name: 'one' });
    expect(stopped.stopped).toBe(true);
    expect(String(stopped.reason)).toMatch(/screenshot budget/);
  });

  // ---- B8 ----
  it('B8: without a fresh UI tree, a credential-handling session needs force:true', async () => {
    driver = new FakeDriver('simulator');
    const sid = await newSession();
    const session = sessions.get(sid)!;
    expect(session.lastSnapshot).toBeUndefined();
    const plain = await call(sid, { mode: 'baseline', name: 'nosnap' });
    expect(plain.ok).toBe(true);
    expect(plain.secureFieldCheck).toBe('unverified');

    session.secrets.add('hunter22');
    const withheld = await call(sid, { mode: 'baseline', name: 'nosnap2' });
    expect(withheld.ok).toBe(false);
    expect(String(withheld.what)).toMatch(/no fresh UI tree/i);
    const forced = await call(sid, { mode: 'baseline', name: 'nosnap2', force: true });
    expect(forced.ok).toBe(true);
  });

  it('B8: only baseline needs force — find_text/find_image/diff/assert run, persist nothing, and say how they checked', async () => {
    driver = new FakeDriver('simulator');
    const sid = await newSession();
    const session = sessions.get(sid)!;
    expect((await call(sid, { mode: 'baseline', name: 'pre-login' })).ok).toBe(true); // before credentials
    session.secrets.add('hunter22');
    const artifactsBefore = session.artifacts.length;

    // find_text: proceeds (consent-gated as usual); the OCR text is screened → secureFieldCheck:"ocr".
    ocrState.text = 'Welcome back\nContinue';
    ocrState.regions = [{ text: 'Continue', confidence: 0.97, bbox: { x: 10, y: 10, width: 20, height: 10 } }];
    const found = await ocr(sid, { query: 'Continue' });
    expect(found.ok).toBe(true);
    expect(found.found).toBe(true);
    expect(found.secureFieldCheck).toBe('ocr');
    // …and a password/OTP-looking OCR screen is still withheld.
    ocrState.text = 'Enter your password';
    ocrState.regions = [{ text: 'Enter your password', confidence: 0.97, bbox: { x: 10, y: 10, width: 20, height: 10 } }];
    const hit = await ocr(sid, { query: 'password' });
    expect(hit.ok).toBe(false);
    expect(hit.regions).toBeUndefined();

    // diff / assert: run, but the capture is NOT saved as an artifact.
    const diff = await call(sid, { mode: 'diff', name: 'pre-login' });
    expect(diff.ok).toBe(true);
    expect(diff.currentUri).toBeNull();
    expect(diff.captureWithheld).toBe(true);
    expect(diff.secureFieldCheck).toBe('unverified');
    const asserted = await call(sid, { mode: 'assert', assertion: 'Map rendered' });
    expect(asserted.ok).toBe(true);
    expect(asserted.screenshotUri).toBeNull();
    expect(asserted.captureWithheld).toBe(true);

    // find_image: coordinates only, nothing persisted.
    mkdirSync(join(projectRoot, 'refs'), { recursive: true });
    writeFileSync(join(projectRoot, 'refs', 'tpl-b8.png'), TEMPLATE);
    const img = await call(sid, { mode: 'find_image', template: 'refs/tpl-b8.png' });
    expect(img.ok).toBe(true);
    expect(img.secureFieldCheck).toBe('unverified');
    expect(session.artifacts.length).toBe(artifactsBefore);

    // force:true keeps the evidence.
    const forcedDiff = await call(sid, { mode: 'diff', name: 'pre-login', force: true });
    expect(typeof forcedDiff.currentUri).toBe('string');
  });

  it('B8: on a structured backend a qa_visual tap does not leave the next call unverified (tree re-dumped)', async () => {
    const d = new FakeDriver('direct') as FakeDriver & { dumpXml(): Promise<string> };
    let xml =
      `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
      `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][64,64]" clickable="false" enabled="true">` +
      `<node class="android.widget.Button" text="Continue" resource-id="com.example.app:id/go" content-desc="" bounds="[0,0][64,32]" clickable="true" enabled="true"/>` +
      `</node></hierarchy>`;
    d.dumpXml = async () => xml;
    driver = d;
    const sid = await newSession();
    const session = sessions.get(sid)!;
    session.secrets.add('hunter22');
    ocrState.text = 'Continue';
    ocrState.regions = [{ text: 'Continue', confidence: 0.97, bbox: { x: 10, y: 10, width: 20, height: 10 } }];
    const tapped = await ocr(sid, { query: 'Continue', tap: true });
    expect(tapped.tapped).toBe(true);
    // The pre-tap tree is stale, but the backend can re-dump it: a baseline is allowed without force.
    const base = await call(sid, { mode: 'baseline', name: 'after-visual-tap' });
    expect(base.ok).toBe(true);
    expect(base.secureFieldCheck).toBe('clear');
    // …and a fresh dump that shows a password field still blocks.
    xml = xml.replace('text="Continue"', 'text="" password="true"');
    const blocked = await call(sid, { mode: 'baseline', name: 'after-visual-tap-2' });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.what)).toMatch(/secure field/i);
  });

  it('B8: OCR that reads like a password/OTP screen is withheld without a fresh tree', async () => {
    const sid = await newSession();
    ocrState.text = 'Enter the one-time code\nVerify';
    ocrState.regions = [{ text: 'Verify', confidence: 0.99, bbox: { x: 10, y: 10, width: 20, height: 10 } }];
    const res = await ocr(sid, { query: 'Verify', tap: true });
    expect(res.ok).toBe(false);
    expect(String(res.what)).toMatch(/password\/OTP/);
    expect(res.regions).toBeUndefined();
    expect(driver.taps).toHaveLength(0);
  });

  it('B8: every OCR text (top-level, regions[].text, the hit region) is secret-redacted', async () => {
    const sid = await newSession();
    const session = sessions.get(sid)!;
    session.secrets.add('hunter22');
    ocrState.text = 'user hunter22\nWelcome hunter22';
    ocrState.regions = [
      { text: 'user hunter22', confidence: 0.95, bbox: { x: 0, y: 0, width: 10, height: 10 } },
      { text: 'Welcome hunter22', confidence: 0.95, bbox: { x: 0, y: 20, width: 10, height: 10 } },
    ];
    const miss = await ocr(sid, { query: 'Nope', force: true });
    expect(miss.found).toBe(false);
    expect(JSON.stringify(miss)).not.toContain('hunter22');
    expect((miss.regions as Array<{ text: string }>)[0].text).toBe('user «redacted»');

    const hit = await ocr(sid, { query: 'Welcome', force: true });
    expect(hit.found).toBe(true);
    expect(JSON.stringify(hit)).not.toContain('hunter22');
  });

  // ---- OCR provider docs ----
  it('find_text without a provider returns OCR_NOT_CONFIGURED with the provider contract', async () => {
    const sid = await newSession();
    ocrState.configured = false;
    const res = await call(sid, { mode: 'find_text', query: 'Log in' });
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('OCR_NOT_CONFIGURED');
    const steps = (res.nextSteps as string[]).join('\n');
    expect(steps).toMatch(/SWIPIUM_OCR_CMD/);
    expect(steps).toMatch(/ocrCommand/);
    expect(steps).toMatch(/\{image\}/);
    expect(steps).toMatch(/bbox/);
    expect((res.exampleProvider as { script: string }).script).toContain('tesseract');
  });

  it('the documented tesseract example emits JSON the OCR parser accepts', () => {
    let python = true;
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore' });
    } catch {
      python = false;
    }
    if (!python) return; // host without python3 — contract still covered by the parser tests
    const dir = mkdtempSync(join(tmpdir(), 'swipium-tess-'));
    try {
      // Stand-in `tesseract` that prints a word-level TSV for two lines.
      const fake = join(dir, 'tesseract');
      const tsv = [
        'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
        '5\t1\t1\t1\t1\t1\t53\t182\t50\t38\t96.2\tLog',
        '5\t1\t1\t1\t1\t2\t110\t184\t47\t36\t94.0\tin',
        '5\t1\t2\t1\t1\t1\t51\t52\t261\t30\t96.4\tWelcome',
      ].join('\n');
      writeFileSync(fake, `#!/bin/sh\ncat <<'EOF'\n${tsv}\nEOF\n`);
      chmodSync(fake, 0o755);
      const script = join(dir, 'ocr.py');
      writeFileSync(script, TESSERACT_OCR_EXAMPLE);
      const out = execFileSync('python3', [script, 'screen.png'], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      }).toString();
      const parsed = parseOcrOutput(out);
      expect(parsed.regions).toHaveLength(2);
      expect(parsed.regions[0]).toMatchObject({ text: 'Log in', bbox: { x: 53, y: 182, width: 104, height: 38 } });
      expect(parsed.regions[0].confidence).toBeCloseTo(0.94, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
