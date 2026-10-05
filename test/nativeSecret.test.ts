// SWIP-03 / SWIP-02 / SWIP-08 handler-level coverage (coreHappyPath FakeDriver pattern):
// native-selector typing must capture secrets exactly like the generic path (probe +
// SECRET_RE heuristic), qa_act swipes derive on-screen geometry from screenSize(), and a
// supplied-but-unresolvable swipe target is a structured error, not a default swipe.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

// Hermetic on-disk state: SessionStore persists under ~/.swipium, so point HOME at a temp
// dir BEFORE the store module is loaded (dynamic imports below).
const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-test-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
type Driver = import('../src/drivers/Driver.js').Driver;
type NativeSelectorStrategy = import('../src/drivers/Driver.js').NativeSelectorStrategy;

/** A small but parseable uiautomator-style screen. */
function screenXml(): string {
  const leaves = [
    `<node class="android.widget.TextView" text="Sign in" resource-id="" content-desc="" bounds="[40,120][1040,200]" clickable="false" enabled="true"/>`,
    `<node class="android.widget.EditText" text="" resource-id="com.example.app:id/email" content-desc="Email" bounds="[40,300][1040,400]" clickable="true" focusable="true" enabled="true"/>`,
    `<node class="android.widget.Button" text="Continue" resource-id="com.example.app:id/btn_continue" content-desc="" bounds="[40,450][1040,550]" clickable="true" enabled="true"/>`,
  ].join('\n');
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n` +
    `<hierarchy rotation="0">` +
    `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">${leaves}</node>` +
    `</hierarchy>`
  );
}

/** Minimal PNG header (signature + IHDR) — enough for pngSize() to read 1080x1920. */
function fakePng(): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(1080, 16);
  buf.writeUInt32BE(1920, 20);
  buf[24] = 8;
  buf[25] = 6;
  return buf;
}

/** Canned-response Driver with native selector support that records every call. */
class FakeDriver implements Driver {
  readonly kind = 'direct' as const;
  calls: Array<{ method: string; args: unknown[] }> = [];
  // Optional so the SECRET_RE-heuristic path (no probe available) is testable too.
  isSecureBySelector?: (using: NativeSelectorStrategy, value: string) => Promise<boolean>;

  constructor(opts: { secureProbe?: boolean } = {}) {
    if (opts.secureProbe) {
      this.isSecureBySelector = async (using, value) => {
        this.rec('isSecureBySelector', using, value);
        return true;
      };
    }
  }

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
    return undefined;
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
    return true; // keyboard "raises" instantly — the IME poll proceeds without burning its cap
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
    return fakePng();
  }
  async dumpXml(): Promise<string> {
    return screenXml();
  }
  async tapXY(x: number, y: number): Promise<void> {
    this.rec('tapXY', x, y);
  }
  async pressXY(x: number, y: number, ms: number): Promise<void> {
    this.rec('pressXY', x, y, ms);
  }
  async tapBySelector(using: NativeSelectorStrategy, value: string): Promise<void> {
    this.rec('tapBySelector', using, value);
  }
  async typeBySelector(using: NativeSelectorStrategy, value: string, text: string): Promise<void> {
    this.rec('typeBySelector', using, value, text);
  }
  async clearBySelector(using: NativeSelectorStrategy, value: string): Promise<void> {
    this.rec('clearBySelector', using, value);
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
}

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, `expected structuredContent, got: ${JSON.stringify(res.content)}`).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

describe('qa_act native-selector secret capture + gesture geometry (fake driver)', () => {
  let client: Client;
  let close: () => Promise<void>;
  let projectRoot: string;
  let currentFake: FakeDriver;

  /** New session bound to a fresh FakeDriver (attach caches the driver per session). */
  async function startSession(fake: FakeDriver): Promise<string> {
    currentFake = fake;
    const res = (await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    return s.sessionId as string;
  }

  async function generatedYaml(sessionId: string): Promise<{ yaml: string; variables: string[] }> {
    const res = (await client.callTool({
      name: 'qa_generate',
      arguments: { sessionId, target: 'flow', name: 'secret-check' },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    return { yaml: String(s.yaml), variables: (s.variables as string[]) ?? [] };
  }

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-test-project-'));
    setDriverFactoryForTests(() => currentFake);
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'native-secret-test', version: '0' });
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

  it('registers a secret when the driver probe says the field is secure (SWIP-03)', async () => {
    const fake = new FakeDriver({ secureProbe: true });
    const sessionId = await startSession(fake);
    const password = 'Hunter2-S3cret!';
    // selector value deliberately does NOT match SECRET_RE — only the probe can flag it
    const res = (await client.callTool({
      name: 'qa_act',
      arguments: {
        sessionId,
        action: 'type',
        target: { selector: { using: 'accessibility id', value: 'user-credential' } },
        text: password,
      },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    expect(s.secret).toBe(true);
    expect(s.redacted).toBe(true);
    // the driver typed the real value…
    expect(fake.received('isSecureBySelector')[0]?.args).toEqual(['accessibility id', 'user-credential']);
    expect(fake.received('clearBySelector')).toHaveLength(1); // replace mode still clears
    expect(fake.received('typeBySelector')[0]?.args).toEqual(['accessibility id', 'user-credential', password]);
    // …but the response never echoes it
    expect(JSON.stringify(res)).not.toContain(password);

    // and the generated flow carries a SWIPIUM_-prefixed placeholder (env-resolvable), never the literal
    const gen = await generatedYaml(sessionId);
    expect(gen.yaml).toContain('${SWIPIUM_SECRET_1}');
    expect(gen.yaml).not.toContain(password);
    expect(gen.variables).toContain('SWIPIUM_SECRET_1');

    // a subsequent snapshot must not leak the value either
    const snap = (await client.callTool({ name: 'qa_snapshot', arguments: { sessionId } })) as CallToolResult;
    expect(JSON.stringify(snap)).not.toContain(password);
  }, 20_000);

  it('falls back to the SECRET_RE heuristic when the driver has no secure probe (SWIP-03)', async () => {
    const fake = new FakeDriver(); // no isSecureBySelector
    const sessionId = await startSession(fake);
    const password = 'TopSecret99!';
    const res = (await client.callTool({
      name: 'qa_act',
      arguments: {
        sessionId,
        action: 'type',
        target: { selector: { using: 'accessibility id', value: 'password-input' } },
        text: password,
      },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    expect(s.secret).toBe(true);
    expect(JSON.stringify(res)).not.toContain(password);

    const gen = await generatedYaml(sessionId);
    expect(gen.yaml).toContain('${SWIPIUM_TEST_PASSWORD}'); // named from the field, as the suite generator does
    expect(gen.yaml).not.toContain(password);
  }, 20_000);

  it('keeps recording literal text for non-secret native targets', async () => {
    const fake = new FakeDriver(); // no probe, selector value is not secret-shaped
    const sessionId = await startSession(fake);
    const res = (await client.callTool({
      name: 'qa_act',
      arguments: {
        sessionId,
        action: 'type',
        target: { selector: { using: 'accessibility id', value: 'search-box' } },
        text: 'flights to Rome',
      },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(true);
    expect(s.secret).toBeUndefined();

    const gen = await generatedYaml(sessionId);
    expect(gen.yaml).toContain('flights to Rome');
    expect(gen.yaml).not.toContain('SECRET_');
  }, 20_000);

  it('returns the structured resolution error for an unresolvable swipe target (SWIP-08)', async () => {
    const fake = new FakeDriver();
    const sessionId = await startSession(fake);
    const res = (await client.callTool({
      name: 'qa_act',
      arguments: { sessionId, action: 'swipe', direction: 'up', target: { text: 'Nonexistent Widget' } },
    })) as CallToolResult;
    const s = structured(res);
    expect(s.ok).toBe(false);
    expect(String(s.what)).toMatch(/No element matched/);
    expect(fake.received('swipe')).toHaveLength(0); // no silent default swipe
  }, 20_000);

  it('derives targetless swipe geometry from screenSize() with edge insets (SWIP-02)', async () => {
    const fake = new FakeDriver();
    const sessionId = await startSession(fake);
    const res = (await client.callTool({
      name: 'qa_act',
      arguments: { sessionId, action: 'swipe', direction: 'up' },
    })) as CallToolResult;
    expect(structured(res).ok).toBe(true);
    // 1080×1920, center anchor, distance 0.5 → [540, 1440, 540, 480], all inside the 8% frame
    expect(fake.received('swipe')[0]?.args).toEqual([540, 1440, 540, 480]);
  }, 20_000);

  it('uses a resolved coordinate start point verbatim — including x=0 (SWIP-08)', async () => {
    const fake = new FakeDriver();
    const sessionId = await startSession(fake);
    const res = (await client.callTool({
      name: 'qa_act',
      arguments: { sessionId, action: 'swipe', direction: 'down', target: { x: 0, y: 500 } },
    })) as CallToolResult;
    expect(structured(res).ok).toBe(true);
    const args = fake.received('swipe')[0]?.args as number[];
    expect(args[0]).toBe(0); // start verbatim, not swallowed by a truthiness check
    expect(args[1]).toBe(500);
    expect(args[3]).toBe(500 + 1920 * 0.5); // travel = half the screen height
  }, 20_000);
});
