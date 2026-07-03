// Handler-level happy-path coverage (v1-mvp-plan P1 §6): drive the real server through an
// in-memory MCP client with a FakeDriver injected via the attach.ts test seam —
// qa_start_session → qa_snapshot → qa_act → qa_screenshot → qa_report — asserting the
// public contracts (element refs, resolved actions, swipium:// artifact URIs) without
// touching adb, simulators, or the real ~/.swipium.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Hermetic on-disk state: SessionStore persists under ~/.swipium, so point HOME at a temp
// dir BEFORE the store module is loaded (dynamic imports below).
const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-test-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
type Driver = import('../src/drivers/Driver.js').Driver;
type NativeSelectorStrategy = import('../src/drivers/Driver.js').NativeSelectorStrategy;

/** A uiautomator-style screen: >=15 nodes, fully-identified clickables → quality "good". */
function screenXml(title: string, buttonLabels: string[]): string {
  const leaves = [
    `<node class="android.widget.TextView" text="${title}" resource-id="" content-desc="" bounds="[40,120][1040,200]" clickable="false" enabled="true"/>`,
    `<node class="android.widget.EditText" text="" resource-id="com.example.app:id/email" content-desc="Email" bounds="[40,300][1040,400]" clickable="true" focusable="true" enabled="true"/>`,
    ...buttonLabels.map(
      (label, i) =>
        `<node class="android.widget.Button" text="${label}" resource-id="com.example.app:id/btn_${i}" content-desc="" bounds="[40,${450 + i * 120}][1040,${550 + i * 120}]" clickable="true" enabled="true"/>`,
    ),
    ...Array.from(
      { length: 8 },
      (_, i) =>
        `<node class="android.widget.TextView" text="Row item ${i + 1}" resource-id="com.example.app:id/row_${i}" content-desc="" bounds="[40,${1200 + i * 80}][1040,${1260 + i * 80}]" clickable="false" enabled="true"/>`,
    ),
  ].join('\n');
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n` +
    `<hierarchy rotation="0">` +
    `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
    `<node class="android.widget.LinearLayout" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">${leaves}</node>` +
    `</node></hierarchy>`
  );
}

/** Minimal PNG header (signature + IHDR) — enough for pngSize() to read 1080x1920. */
function fakePng(): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0); // PNG signature (first 4 bytes)
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(1080, 16); // width
  buf.writeUInt32BE(1920, 20); // height
  buf[24] = 8; // bit depth
  buf[25] = 6; // color type RGBA
  return buf;
}

/** Canned-response Driver that records every call it receives. */
class FakeDriver implements Driver {
  readonly kind = 'direct' as const;
  calls: Array<{ method: string; args: unknown[] }> = [];
  private screenIndex = 0;
  constructor(private screens: string[]) {}

  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }
  received(method: string): Array<{ method: string; args: unknown[] }> {
    return this.calls.filter((c) => c.method === method);
  }

  async listDevices(): Promise<string[]> {
    return ['fake-device'];
  }
  useDevice(): void {}
  currentDevice(): string | undefined {
    return undefined; // undefined → coordinate-space audit never shells out for orientation
  }
  async installApp(): Promise<void> {
    this.rec('installApp');
  }
  async isInstalled(): Promise<boolean> {
    return true;
  }
  async isRunning(): Promise<boolean> {
    return true;
  }
  async launchApp(): Promise<void> {
    this.rec('launchApp');
  }
  async terminateApp(): Promise<void> {
    this.rec('terminateApp');
  }
  async clearData(): Promise<void> {
    this.rec('clearData');
  }
  async imeShown(): Promise<boolean> {
    return false;
  }
  async logcat(): Promise<string> {
    return '';
  }
  async airplaneOn(): Promise<boolean> {
    return false;
  }
  async setAirplane(): Promise<void> {
    this.rec('setAirplane');
  }
  async foregroundOwner(): Promise<string> {
    return 'unknown';
  }
  async screenshot(): Promise<Buffer> {
    this.rec('screenshot');
    return fakePng();
  }
  async dumpXml(): Promise<string> {
    return this.screens[this.screenIndex];
  }
  async tapXY(x: number, y: number): Promise<void> {
    this.rec('tapXY', x, y);
    this.advance();
  }
  async pressXY(x: number, y: number, ms: number): Promise<void> {
    this.rec('pressXY', x, y, ms);
    this.advance();
  }
  async tapBySelector(using: NativeSelectorStrategy, value: string): Promise<void> {
    this.rec('tapBySelector', using, value);
    this.advance();
  }
  async inputText(text: string): Promise<void> {
    this.rec('inputText', text);
  }
  async clearFocusedText(): Promise<void> {
    this.rec('clearFocusedText');
  }
  async pressKey(key: string): Promise<void> {
    this.rec('pressKey', key);
  }
  async swipe(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    this.rec('swipe', x1, y1, x2, y2);
  }
  async adbReverseMetro(): Promise<void> {}
  async screenSize(): Promise<{ width: number; height: number } | null> {
    return { width: 1080, height: 1920 };
  }
  async screenDensity(): Promise<number | null> {
    return 420;
  }
  async openUrl(url: string): Promise<void> {
    this.rec('openUrl', url);
  }
  async disableAnimations(): Promise<void> {}

  private advance(): void {
    if (this.screenIndex < this.screens.length - 1) this.screenIndex++;
  }
}

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, `expected structuredContent, got: ${JSON.stringify(res.content)}`).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

describe('core happy path (fake driver)', () => {
  let client: Client;
  let close: () => Promise<void>;
  let fake: FakeDriver;
  let projectRoot: string;
  let sessionId: string;
  let screenshotUri: string;
  let reportUri: string;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-test-project-'));
    fake = new FakeDriver([
      screenXml('Welcome back', ['Log in', 'Create account', 'Help']),
      screenXml('Home', ['Search flights', 'Profile', 'Settings']),
    ]);
    setDriverFactoryForTests(() => fake);

    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'happy-path-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
    };
  });

  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    await close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('qa_start_session opens a session with hermetic on-disk state', async () => {
    const res = (await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    expect(typeof s.sessionId).toBe('string');
    sessionId = s.sessionId as string;
    expect(s.projectRoot).toBe(projectRoot);
    // Session state must live under the temp HOME, never the real ~/.swipium.
    expect(String(s.artifactsDir).startsWith(fakeHome)).toBe(true);
    expect(existsSync(join(fakeHome, '.swipium', 'registry.json'))).toBe(true);
  });

  it('qa_snapshot returns addressable @eN element refs from the fake UI tree', async () => {
    const res = (await client.callTool({ name: 'qa_snapshot', arguments: { sessionId } })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    const elements = s.elements as Array<{ ref: string; text?: string; id?: string }>;
    expect(elements.length).toBeGreaterThan(0);
    for (const el of elements) expect(el.ref).toMatch(/^@e\d+$/);
    expect(elements.some((el) => el.text === 'Log in')).toBe(true);
    expect(elements.some((el) => el.id === 'email')).toBe(true);
    expect(s.quality).toBe('good');
  });

  it('qa_act with an object selector reaches the driver and records the resolved action', async () => {
    const res = (await client.callTool({
      name: 'qa_act',
      arguments: { sessionId, action: 'tap', target: { selector: { using: 'accessibility id', value: 'login-button' } } },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    // The fake driver received the resolved native-selector tap…
    const taps = fake.received('tapBySelector');
    expect(taps).toHaveLength(1);
    expect(taps[0].args).toEqual(['accessibility id', 'login-button']);
    // …and the response records what was performed.
    expect(s.action).toBe('tap');
    expect(s.via).toBe('native-selector');
    expect(s.selector).toEqual({ using: 'accessibility id', value: 'login-button' });
    expect(s.changed).toBe(true); // the fake advanced to its second screen
    const health = s.health as { healthy: boolean };
    expect(health.healthy).toBe(true);
  }, 20_000);

  it('qa_act with a ref target taps the element coordinates from the snapshot', async () => {
    const snap = structured((await client.callTool({ name: 'qa_snapshot', arguments: { sessionId } })) as CallToolResult);
    const elements = snap.elements as Array<{ ref: string; text?: string }>;
    const button = elements.find((el) => el.text === 'Search flights');
    expect(button).toBeTruthy();

    const res = (await client.callTool({
      name: 'qa_act',
      arguments: { sessionId, action: 'tap', target: { ref: button!.ref } },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    expect(fake.received('tapXY').length).toBeGreaterThan(0);
    expect(s.tappedAt).toEqual([540, 500]); // center of the Search flights bounds
  }, 20_000);

  it('qa_screenshot returns a swipium:// artifact URI, not inline bytes', async () => {
    const res = (await client.callTool({ name: 'qa_screenshot', arguments: { sessionId } })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    expect(String(s.uri)).toMatch(/^swipium:\/\/session\//);
    screenshotUri = s.uri as string;
    // No inline image content blocks — the artifact URI is the contract (DESIGN §4).
    expect((res.content ?? []).every((c) => c.type === 'text')).toBe(true);
    expect(String(s.path).startsWith(fakeHome)).toBe(true);
    expect(existsSync(String(s.path))).toBe(true);
  });

  it('qa_report produces a report artifact', async () => {
    const res = (await client.callTool({ name: 'qa_report', arguments: { sessionId } })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    expect(String(s.reportUri)).toMatch(/^swipium:\/\/session\//);
    reportUri = s.reportUri as string;
  }, 20_000);

  it('qa_get_artifact resolves the screenshot and report artifacts by URI', async () => {
    for (const uri of [screenshotUri, reportUri]) {
      const res = (await client.callTool({ name: 'qa_get_artifact', arguments: { uri, mode: 'metadata' } })) as CallToolResult;
      const s = structured(res);
      expect(res.isError, `artifact ${uri} should resolve`).toBeFalsy();
      expect(s.uri).toBe(uri);
      expect(s.bytes as number).toBeGreaterThan(0);
    }
  });
});
