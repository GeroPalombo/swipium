// Shared fake driver + MCP harness for the actFix / resultSize / perf handler tests.
// (Not a test file itself — vitest only collects *.test.ts.)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Driver, DumpOptions, ImeState } from '../src/drivers/Driver.js';
import { currentSignal } from '../src/lib/abortScope.js';

type Rect = [number, number, number, number];

export interface NodeSpec {
  cls?: string;
  text?: string;
  desc?: string;
  id?: string;
  bounds: Rect;
  clickable?: boolean;
  extra?: string; // raw extra attributes, e.g. checkable="true" checked="false"
}

/** A uiautomator-shaped dump (root owned by `pkg`, 1080x1920, rotation 0). */
export function dump(nodes: NodeSpec[], pkg = 'com.example.app', rotation = 0): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const body = nodes
    .map(
      (n) =>
        `<node class="${n.cls ?? 'android.widget.Button'}" package="${pkg}" text="${esc(n.text ?? '')}" resource-id="${n.id ?? ''}" ` +
        `content-desc="${esc(n.desc ?? '')}" checked="false" selected="false" bounds="[${n.bounds[0]},${n.bounds[1]}][${n.bounds[2]},${n.bounds[3]}]" ` +
        `clickable="${n.clickable ?? true}" enabled="true" ${n.extra ?? ''}/>`,
    )
    .join('');
  const [w, h] = rotation % 2 ? [1920, 1080] : [1080, 1920];
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${rotation}">` +
    `<node class="android.widget.FrameLayout" package="${pkg}" text="" resource-id="" content-desc="" checked="false" selected="false" bounds="[0,0][${w},${h}]" clickable="false" enabled="true">` +
    body +
    `</node></hierarchy>`
  );
}

/** `count` buttons "<prefix> item i" with ids <prefix>_i, stacked from y=200. */
export function buttonScreen(prefix: string, count: number, pkg = 'com.example.app'): string {
  const nodes: NodeSpec[] = [{ cls: 'android.widget.TextView', text: prefix, bounds: [40, 100, 1040, 180], clickable: false }];
  for (let i = 0; i < count; i++) {
    nodes.push({
      text: `${prefix} item ${i}`,
      id: `${pkg}:id/${prefix.toLowerCase()}_${i}`,
      bounds: [40, 200 + i * 50, 1040, 245 + i * 50],
    });
  }
  return dump(nodes, pkg);
}

export class FakeDriver implements Driver {
  readonly kind = 'direct' as const;
  calls: Array<{ m: string; a: unknown[] }> = [];
  xml: string;
  ime = false;
  imeRect: Rect | null = null;
  foreground = 'com.example.app/.MainActivity';
  /** The per-call cancellation signal (abortScope) seen by each recorded driver call. */
  signalsSeen: Array<AbortSignal | undefined> = [];
  onTap?: (x: number, y: number) => void;
  onSwipe?: () => void;
  /** When set, tapXY/pressXY block until the call's scoped signal aborts (cancellation test). */
  hangTap = false;
  abortedDuringTap = false;
  constructor(xml: string) {
    this.xml = xml;
  }
  rec(m: string, ...a: unknown[]) {
    this.calls.push({ m, a });
    this.signalsSeen.push(currentSignal());
  }
  got(m: string) {
    return this.calls.filter((c) => c.m === m);
  }
  async listDevices() {
    return ['fake'];
  }
  useDevice() {}
  currentDevice() {
    return undefined;
  }
  async installApp() {}
  async isInstalled() {
    return true;
  }
  async isRunning() {
    return true;
  }
  async launchApp() {}
  async terminateApp() {}
  async clearData() {}
  async imeShown() {
    this.rec('imeShown');
    return this.ime;
  }
  async imeFrame() {
    this.rec('imeFrame');
    return this.ime ? this.imeRect : null;
  }
  async imeState(): Promise<ImeState> {
    this.rec('imeState');
    return { shown: this.ime, frame: this.ime ? this.imeRect : null };
  }
  async logcat() {
    return '';
  }
  async airplaneOn() {
    return false;
  }
  async setAirplane() {}
  async foregroundOwner() {
    this.rec('foregroundOwner');
    return this.foreground;
  }
  async screenshot() {
    return Buffer.alloc(0);
  }
  async dumpXml(opts?: DumpOptions) {
    this.rec('dumpXml', opts);
    return this.xml;
  }
  async tapXY(x: number, y: number) {
    this.rec('tapXY', x, y);
    await this.maybeHang();
    this.onTap?.(x, y);
  }
  private async maybeHang() {
    if (this.hangTap) {
      const sig = currentSignal();
      await new Promise<void>((resolve) => {
        if (!sig) return resolve();
        if (sig.aborted) return resolve();
        sig.addEventListener('abort', () => resolve(), { once: true });
        setTimeout(resolve, 5000);
      });
      this.abortedDuringTap = !!sig?.aborted;
      throw new Error('aborted');
    }
  }
  async pressXY(x: number, y: number, ms: number) {
    this.rec('pressXY', x, y, ms);
    await this.maybeHang();
    this.onTap?.(x, y);
  }
  async inputText(text: string) {
    this.rec('inputText', text);
  }
  async clearFocusedText() {
    this.rec('clearFocusedText');
  }
  async pressKey(key: string) {
    this.rec('pressKey', key);
  }
  async swipe(x1: number, y1: number, x2: number, y2: number) {
    this.rec('swipe', x1, y1, x2, y2);
    this.onSwipe?.();
  }
  async adbReverseMetro() {}
  async screenSize() {
    return { width: 1080, height: 1920 };
  }
  async screenDensity() {
    return 420;
  }
  async openUrl() {}
  async disableAnimations() {}
}

export function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, JSON.stringify(res.content)).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

export function textOf(res: CallToolResult): string {
  const first = res.content?.[0];
  return first && first.type === 'text' ? String(first.text) : '';
}

/** Boot an in-memory Swipium server whose sessions all use `current()`'s driver. */
export async function harness(name: string) {
  const fakeHome = mkdtempSync(join(tmpdir(), `swipium-${name}-home-`));
  process.env.HOME = fakeHome;
  process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
  const projectRoot = mkdtempSync(join(tmpdir(), `swipium-${name}-project-`));
  const { createServer } = await import('../src/server.js');
  const { setDriverFactoryForTests } = await import('../src/session/attach.js');
  let current: Driver | undefined;
  setDriverFactoryForTests(() => current);
  const { server, sessions } = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    sessions,
    async start(d: Driver, extra: Record<string, unknown> = {}): Promise<string> {
      current = d;
      const s = structured((await client.callTool({ name: 'qa_start_session', arguments: { projectRoot, ...extra } })) as CallToolResult);
      const id = s.sessionId as string;
      const session = sessions.get(id)!;
      session.appId ??= 'com.example.app';
      return id;
    },
    async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
      return (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
    },
    async close() {
      setDriverFactoryForTests(undefined);
      await client.close();
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}
