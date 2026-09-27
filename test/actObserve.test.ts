// OPP-06 / OPP-07 handler-level coverage (coreHappyPath FakeDriver pattern):
// qa_act's per-action field contract is enforced by ONE validation layer whose error names
// both the missing field and the action, and the `observe` presentation modes (diff/full/none)
// change only what is rendered — verdicts (changed/health/quality) survive in every mode.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

/** Canned-response Driver: advances to the next screen on taps, records every call. */
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

function textOf(res: CallToolResult): string {
  return (res.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

describe('qa_act per-action contract + observe modes (fake driver)', () => {
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

  async function act(sessionId: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await client.callTool({ name: 'qa_act', arguments: { sessionId, ...args } })) as CallToolResult;
  }

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-test-project-'));
    setDriverFactoryForTests(() => currentFake);
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'act-observe-test', version: '0' });
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

  describe('per-action field contract (OPP-06)', () => {
    it('rejects the invalid combinations naming both the missing field and the action', async () => {
      const sessionId = await startSession(new FakeDriver([screenXml('Sign in', ['Continue'])]));
      const cases: Array<{ args: Record<string, unknown>; action: string; field: string }> = [
        { args: { action: 'type', target: { text: 'Email' } }, action: 'type', field: 'text' },
        { args: { action: 'swipe' }, action: 'swipe', field: 'direction' },
        { args: { action: 'press' }, action: 'press', field: 'key' },
      ];
      for (const c of cases) {
        const res = await act(sessionId, c.args);
        const s = structured(res);
        expect(res.isError, `${c.action} without ${c.field} must be an error`).toBe(true);
        expect(s.ok).toBe(false);
        // The single validation layer names BOTH the action and the missing field.
        expect(String(s.what)).toContain(`"${c.action}"`);
        expect(String(s.what)).toContain(`\`${c.field}\``);
        expect(s.changedState).toBe(false);
        expect(s.retrySafe).toBe(true);
      }
      // Rejected calls never reached the driver.
      expect(currentFake.calls.filter((c) => ['inputText', 'swipe', 'pressKey'].includes(c.method))).toHaveLength(0);
    }, 20_000);

    it('still performs valid type / swipe / press calls', async () => {
      const fake = new FakeDriver([screenXml('Sign in', ['Continue'])]);
      const sessionId = await startSession(fake);

      const typed = structured(await act(sessionId, { action: 'type', target: { text: 'Email' }, text: 'hi@example.com' }));
      expect(typed.ok).toBe(true);
      expect(fake.received('inputText')[0]?.args).toEqual(['hi@example.com']);

      const swiped = structured(await act(sessionId, { action: 'swipe', direction: 'up' }));
      expect(swiped.ok).toBe(true);
      expect(fake.received('swipe')).toHaveLength(1);

      const pressed = structured(await act(sessionId, { action: 'press', key: 'back' }));
      expect(pressed.ok).toBe(true);
      expect(fake.received('pressKey')[0]?.args).toEqual(['back']);
    }, 20_000);
  });

  describe('observe modes (OPP-07)', () => {
    it('defaults to full on the first action (no prior snapshot) and diff afterwards', async () => {
      const sessionId = await startSession(new FakeDriver([screenXml('Home', ['Search flights', 'Profile', 'Settings'])]));

      // First action: no session.lastSnapshot yet → full element list.
      const first = structured(await act(sessionId, { action: 'press', key: 'back' }));
      expect(first.ok).toBe(true);
      expect(first.observe).toBe('full');
      const fullElements = first.elements as Array<{ ref: string }>;
      expect(fullElements.length).toBeGreaterThan(0);
      expect(first.unchangedElements).toBeUndefined();

      // Second action: the first act stored a snapshot → diff is the default.
      const res = await act(sessionId, { action: 'press', key: 'back' });
      const second = structured(res);
      expect(second.ok).toBe(true);
      expect(second.observe).toBe('diff');
      expect(second.changed).toBe(false);
      // Unchanged screen → zero elements plus the honesty note, in structured AND text.
      expect(second.elements).toEqual([]);
      expect(second.removed).toEqual([]);
      expect(second.unchangedElements as number).toBeGreaterThan(0);
      expect(String(second.hint)).toContain('observe:"full"');
      expect(textOf(res)).toContain('observe:"full"');
      // Verdicts survive in diff mode.
      expect(second.health).toBeTruthy();
      expect(second.quality).toBe('good');
    }, 20_000);

    it('observe:"diff" on a changed screen lists only the new elements and names the removed ones', async () => {
      const fake = new FakeDriver([
        screenXml('Welcome back', ['Log in', 'Create account', 'Help']),
        screenXml('Home', ['Search flights', 'Profile', 'Settings']),
      ]);
      const sessionId = await startSession(fake);
      const snap = structured((await client.callTool({ name: 'qa_snapshot', arguments: { sessionId } })) as CallToolResult);
      const login = (snap.elements as Array<{ ref: string; text?: string }>).find((e) => e.text === 'Log in');
      expect(login).toBeTruthy();

      const res = await act(sessionId, { action: 'tap', target: { ref: login!.ref }, observe: 'diff' });
      const s = structured(res);
      expect(s.ok).toBe(true);
      expect(s.changed).toBe(true);
      const added = s.elements as Array<{ text?: string; label?: string }>;
      // Only screen-2-only elements are listed — the shared Email field and rows are not.
      expect(added.some((e) => e.text === 'Search flights')).toBe(true);
      expect(added.every((e) => e.label !== 'Email' && !(e.text ?? '').startsWith('Row item'))).toBe(true);
      const removed = s.removed as string[];
      expect(removed.some((sig) => sig.includes('Log in'))).toBe(true);
      // Honesty: the unchanged remainder is counted, not hidden silently.
      expect(s.unchangedElements as number).toBeGreaterThan(0);
      expect(textOf(res)).toContain('DIFF vs pre-action');
    }, 20_000);

    it('observe:"none" returns verdicts only — no element list, changed/health intact', async () => {
      const sessionId = await startSession(new FakeDriver([screenXml('Home', ['Search flights'])]));
      const res = await act(sessionId, { action: 'press', key: 'back', observe: 'none' });
      const s = structured(res);
      expect(s.ok).toBe(true);
      expect(s.observe).toBe('none');
      expect(s.elements).toBeUndefined();
      expect(s.removed).toBeUndefined();
      expect(typeof s.changed).toBe('boolean');
      expect(s.health).toBeTruthy();
      expect(String(s.hint)).toContain('observe:"full"');
      expect(textOf(res)).toContain('observe:"none"');
    }, 20_000);

    it('observe:"full" forces the whole capped element list even with a prior snapshot', async () => {
      const sessionId = await startSession(new FakeDriver([screenXml('Home', ['Search flights', 'Profile'])]));
      await client.callTool({ name: 'qa_snapshot', arguments: { sessionId } });
      const s = structured(await act(sessionId, { action: 'press', key: 'back', observe: 'full' }));
      expect(s.ok).toBe(true);
      expect(s.observe).toBe('full');
      const elements = s.elements as Array<{ text?: string; label?: string }>;
      // Unchanged screen, yet the full list (including unchanged elements) is returned.
      expect(elements.some((e) => e.text === 'Search flights')).toBe(true);
      expect(elements.some((e) => e.label === 'Email')).toBe(true);
    }, 20_000);
  });
});
