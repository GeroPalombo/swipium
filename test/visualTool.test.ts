// qa_visual contract coverage (OPP-04): baseline → diff round-trip with real (tiny) PNGs,
// consent-gated OCR find_text with a mocked OCR seam and an honest declared coordinate space,
// the secure-field withhold policy, and the tool-surface lockstep. Hermetic: HOME is a
// temp dir, the driver is a fake injected via the attach.ts test seam, and runOcr (which
// shells out to a configured provider) is mocked — findOcrRegion / coordinate conversion stay real.

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-visual-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

// Mock ONLY the seam that shells out to the local OCR provider; region matching and the
// screenshot-px → device-px conversion (findOcrRegion / toDevicePoint) stay the real code.
vi.mock('../src/visual/ocr.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/visual/ocr.js')>();
  return {
    ...actual,
    configuredOcrCommand: () => ['fake-ocr', '{image}'],
    runOcr: async () => fakeOcrResult(),
  };
});

/** OCR result in a DIFFERENT coordinate space than the device (scale 2): the returned
 * devicePoint must be the bbox center divided by the declared scale — honesty check. */
function fakeOcrResult() {
  return {
    text: 'Log in\nWelcome back',
    regions: [
      {
        text: 'Log in',
        confidence: 0.95,
        bbox: { x: 20, y: 30, width: 40, height: 20 },
        coordinateSpace: 'screenshot_px' as const,
      },
    ],
    coordinateSpace: {
      origin: 'top-left' as const,
      screenshot: { width: 128, height: 128 },
      device: { width: 64, height: 64 },
      density: null,
      scale: 2,
      orientation: 'portrait' as const,
    },
    provider: { io: 'argv' as const, argv: ['fake-ocr', '<screenshot>'] },
    masking: { providerConfigured: false, masksApplied: [] },
  };
}

const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
type Driver = import('../src/drivers/Driver.js').Driver;
type SessionStore = import('../src/session/store.js').SessionStore;

/** Build a real, decodable 8-bit RGBA PNG (filter 0 rows, dummy CRCs — decodePng skips CRC). */
function makePng(width: number, height: number, color: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
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
    return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC unchecked by decodePng
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const SIZE = 64;
const redScreen = makePng(SIZE, SIZE, () => [200, 40, 40]);
const halfBlueScreen = makePng(SIZE, SIZE, (x) => (x < SIZE / 2 ? [200, 40, 40] : [40, 40, 200]));

/** >=15 nodes so snapshot quality checks stay happy; optionally includes a password field. */
function screenXml(secure: boolean): string {
  const secureNode = secure
    ? `<node class="android.widget.EditText" text="" resource-id="com.example.app:id/password" content-desc="Password" password="true" bounds="[40,300][1040,400]" clickable="true" enabled="true"/>`
    : '';
  const rows = Array.from(
    { length: 16 },
    (_, i) =>
      `<node class="android.widget.TextView" text="Row ${i}" resource-id="com.example.app:id/row_${i}" content-desc="" bounds="[40,${500 + i * 60}][1040,${550 + i * 60}]" clickable="false" enabled="true"/>`,
  ).join('');
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>` +
    `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
    secureNode +
    rows +
    `</node></hierarchy>`
  );
}

class FakeDriver implements Driver {
  readonly kind = 'direct' as const;
  screen: Buffer = redScreen;
  xml: string = screenXml(false);
  taps: Array<[number, number]> = [];

  async listDevices(): Promise<string[]> {
    return ['fake-device'];
  }
  useDevice(): void {}
  currentDevice(): string | undefined {
    return undefined; // no orientation shell-out in captureCoordinateSpace
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
    return this.xml;
  }
  async tapXY(x: number, y: number): Promise<void> {
    this.taps.push([x, y]);
  }
  async pressXY(): Promise<void> {}
  async inputText(): Promise<void> {}
  async clearFocusedText(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async swipe(): Promise<void> {}
  async adbReverseMetro(): Promise<void> {}
  async screenSize(): Promise<{ width: number; height: number } | null> {
    return { width: SIZE, height: SIZE };
  }
  async screenDensity(): Promise<number | null> {
    return 420;
  }
  async openUrl(): Promise<void> {}
  async disableAnimations(): Promise<void> {}
}

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, `expected structuredContent, got: ${JSON.stringify(res.content)}`).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

describe('qa_visual (consolidated visual intelligence)', () => {
  let client: Client;
  let sessions: SessionStore;
  let fake: FakeDriver;
  let projectRoot: string;
  let sessionId: string;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-visual-project-'));
    fake = new FakeDriver();
    setDriverFactoryForTests(() => fake);
    const ctx = createServer();
    sessions = ctx.sessions;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'visual-tool-test', version: '0' });
    await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
    const res = (await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult;
    sessionId = structured(res).sessionId as string;
  });

  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    structured((await client.callTool({ name: 'qa_visual', arguments: { sessionId, ...args } })) as CallToolResult);

  it('is on the public surface (qa_assert_visual folded into mode:"assert")', async () => {
    const { TOOL_NAMES } = await import('../src/version.js');
    expect(TOOL_NAMES).toContain('qa_visual');
    expect(TOOL_NAMES).not.toContain('qa_assert_visual');
  });

  it('baseline → diff round-trip: identical screen passes, changed screen fails with a region', async () => {
    const base = await call({ mode: 'baseline', name: 'home' });
    expect(base.ok).toBe(true);
    expect(String(base.uri)).toMatch(/^swipium:\/\/session\//);
    expect((base.coordinateSpace as { origin: string }).origin).toBe('top-left');
    // The baseline artifact is registered and fetchable.
    const found = sessions.findArtifact(base.uri as string);
    expect(found?.rec.mime).toBe('image/png');

    const same = await call({ mode: 'diff', name: 'home' });
    expect(same.ok).toBe(true);
    expect(same.pass).toBe(true);
    expect(same.changedRatio).toBe(0);
    expect(sessions.findArtifact(same.currentUri as string)).toBeTruthy();

    fake.screen = halfBlueScreen;
    const changed = await call({ mode: 'diff', name: 'home' });
    expect(changed.ok).toBe(true);
    expect(changed.pass).toBe(false);
    expect(changed.changedRatio as number).toBeGreaterThan(0.4);
    expect(changed.changedBox).toBeTruthy();
    expect(changed.changedBoxDevice).toBeTruthy();
    expect((changed.coordinateSpace as { scale: number }).scale).toBe(1);
    fake.screen = redScreen;
  });

  it('find_text is consent-gated, then returns the match with a DECLARED coordinate space', async () => {
    const envelope = await call({ mode: 'find_text', query: 'Log in' });
    expect(envelope.requiresConsent).toBe(true);
    expect(typeof envelope.consentId).toBe('string');

    const res = await call({ mode: 'find_text', query: 'Log in', consentId: envelope.consentId, approve: true });
    expect(res.ok).toBe(true);
    expect(res.found).toBe(true);
    expect(res.method).toBe('ocr');
    const cs = res.coordinateSpace as { origin: string; scale: number };
    expect(cs.origin).toBe('top-left');
    expect(cs.scale).toBe(2);
    // bbox center (40, 40) in screenshot px ÷ declared scale 2 → device (20, 20).
    expect(res.devicePoint).toEqual({ x: 20, y: 20 });
    expect((res.region as { coordinateSpace: string }).coordinateSpace).toBe('screenshot_px');
  });

  it('find_text reports found:false (with regions and the space) when the query is not on screen', async () => {
    const envelope = await call({ mode: 'find_text', query: 'Nonexistent' });
    const res = await call({ mode: 'find_text', query: 'Nonexistent', consentId: envelope.consentId, approve: true });
    expect(res.ok).toBe(true);
    expect(res.found).toBe(false);
    expect(Array.isArray(res.regions)).toBe(true);
    expect((res.coordinateSpace as { scale: number }).scale).toBe(2);
  });

  it('tap:true taps the found device point through the driver', async () => {
    const envelope = await call({ mode: 'find_text', query: 'Log in', tap: true });
    const res = await call({ mode: 'find_text', query: 'Log in', tap: true, consentId: envelope.consentId, approve: true });
    expect(res.ok).toBe(true);
    expect(res.tapped).toBe(true);
    expect(res.tapVia).toBe('driver');
    expect(fake.taps).toContainEqual([20, 20]);
  });

  it('withholds capture when a secure field is on screen, unless force:true', async () => {
    fake.xml = screenXml(true);
    const snap = structured((await client.callTool({ name: 'qa_snapshot', arguments: { sessionId } })) as CallToolResult);
    expect(snap.ok).toBe(true);

    const withheld = await call({ mode: 'baseline', name: 'secure-screen' });
    expect(withheld.ok).toBe(false);
    expect(String(withheld.what)).toMatch(/secure field/i);

    // OCR is withheld too — the screenshot would leave for the OCR provider.
    const ocrWithheld = await call({ mode: 'find_text', query: 'Log in' });
    expect(ocrWithheld.ok).toBe(false);
    expect(ocrWithheld.requiresConsent).toBeUndefined();

    const forced = await call({ mode: 'baseline', name: 'secure-screen', force: true });
    expect(forced.ok).toBe(true);
  });

  it('mode:"assert" records a visual pass/fail with screenshot evidence (the former qa_assert_visual)', async () => {
    fake.xml = screenXml(false);
    fake.screen = redScreen;
    const started = structured(
      (await client.callTool({
        name: 'qa_start_session',
        arguments: { projectRoot, budget: { maxScreenshots: 20, maxActions: 20 } },
      })) as CallToolResult,
    );
    const sid = started.sessionId as string;
    const assertCall = async (args: Record<string, unknown>) =>
      structured((await client.callTool({ name: 'qa_visual', arguments: { sessionId: sid, mode: 'assert', ...args } })) as CallToolResult);

    const missing = await assertCall({});
    expect(missing.ok).toBe(false);
    expect(String(missing.what)).toMatch(/assertion/);

    const passed = await assertCall({ assertion: 'Map shows the route' });
    expect(passed).toMatchObject({ ok: true, mode: 'assert', assertion: 'Map shows the route', pass: true, verifiedVisually: true });
    expect(sessions.findArtifact(passed.screenshotUri as string)?.rec.mime).toBe('image/png');

    const failed = await assertCall({ assertion: 'Checkout banner visible', pass: false, reason: 'banner missing' });
    expect(failed).toMatchObject({ ok: true, pass: false });

    const s = sessions.get(sid)!;
    expect(s.counters.screenshots).toBe(2); // captures count against the screenshot budget
    expect(s.notes.map((n) => [n.workflow, n.outcome, n.verifiedVisually])).toEqual([
      ['Map shows the route', 'pass', true],
      ['Checkout banner visible', 'fail', true],
    ]);
    // Only the pass becomes a semantic IR step for generated suites.
    expect(s.recordedActions.filter((a) => a.action === 'assert_visual').map((a) => a.assertion)).toEqual(['Map shows the route']);
  });
});
