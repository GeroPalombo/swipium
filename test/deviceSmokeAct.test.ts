// Regression tests for real-device smoke findings (Swipium 2.0.0) at the qa_act / qa_clear_overlay /
// qa_screenshot layer, driven through the MCP server with a fake driver:
//  A  a registered secret typed into a NON-secure field is recorded without plaintext
//  B  scroll swipes are anchored inside the largest scrollable container (landscape app-bar case)
//  C  a plain scroll performs exactly ONE swipe
//  D  undeliverable text is refused BEFORE the field is focused/cleared
//  F  a scroll that only moved bounds reports changed:true
//  G  typed failure codes (INVALID_ARGUMENT, KEYBOARD_NOT_DISMISSIBLE, CAPTURE_WITHHELD_SECURE)
//  I  a successful action after an auto-hidden keyboard reports keyboardHidden:true

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { elementsOf } from './actFixFake.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-device-act-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
const { adbTextDeliverability } = await import('../src/drivers/DirectDriver.js');
const { largestScrollableRect, swipeInRect, GESTURE_EDGE_INSET, SCROLL_CONTAINER_INSET } = await import('../src/lib/gestures.js');
type Driver = import('../src/drivers/Driver.js').Driver;
type SessionStore = import('../src/session/store.js').SessionStore;

const HEAD = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">`;
const node = (cls: string, attrs: string, bounds: string, extra = '') =>
  `<node class="${cls}" package="com.example.app" ${attrs} bounds="${bounds}" enabled="true"${extra}/>`;

/** Portrait login form: password (secure), email (plain), 10 rows, a Sign in button. */
function formScreen(buttonY = 1700): string {
  const rows = Array.from({ length: 10 }, (_, i) =>
    node(
      'android.widget.TextView',
      `text="Row ${i}" resource-id="com.example.app:id/row_${i}" content-desc=""`,
      `[40,${400 + i * 70}][1040,${450 + i * 70}]`,
      ' clickable="false"',
    ),
  ).join('');
  return (
    HEAD +
    `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
    node(
      'android.widget.EditText',
      `text="" resource-id="com.example.app:id/password" content-desc="Password" password="true"`,
      '[40,200][1040,280]',
      ' clickable="true" focusable="true"',
    ) +
    node(
      'android.widget.EditText',
      `text="" resource-id="com.example.app:id/email" content-desc="Email"`,
      '[40,300][1040,380]',
      ' clickable="true" focusable="true"',
    ) +
    rows +
    node(
      'android.widget.Button',
      `text="Sign in" resource-id="com.example.app:id/sign_in" content-desc=""`,
      `[40,${buttonY}][1040,${buttonY + 100}]`,
      ' clickable="true"',
    ) +
    `</node></hierarchy>`
  );
}

/** Landscape 2400x1080 list: app_bar [0,0][2400,315] over a scrollable list [0,315][2400,1080],
 * plus a clipped scrollable node with inverted bounds (seen on a real device). `offset` shifts
 * the rows vertically (a scroll that moves content but keeps every element present). */
function landscapeList(offset = 0): string {
  const rows = Array.from({ length: 12 }, (_, i) =>
    node(
      'android.widget.TextView',
      `text="Item ${i}" resource-id="com.example.app:id/item_${i}" content-desc=""`,
      `[40,${340 + i * 90 - offset}][2360,${420 + i * 90 - offset}]`,
      ' clickable="true"',
    ),
  ).join('');
  return (
    HEAD +
    `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][2400,1080]" clickable="false" enabled="true">` +
    node(
      'android.view.ViewGroup',
      `text="" resource-id="com.example.app:id/app_bar" content-desc=""`,
      '[0,0][2400,315]',
      ' clickable="false"',
    ) +
    node('android.widget.TextView', `text="Settings" resource-id="" content-desc=""`, '[40,120][600,200]', ' clickable="false"') +
    node(
      'android.widget.HorizontalScrollView',
      `text="" resource-id="com.example.app:id/chips" content-desc=""`,
      '[210,315][750,124]',
      ' scrollable="true" clickable="false"',
    ) +
    `<node class="androidx.recyclerview.widget.RecyclerView" package="com.example.app" text="" resource-id="com.example.app:id/list" content-desc="" bounds="[0,315][2400,1080]" scrollable="true" clickable="false" enabled="true">` +
    rows +
    `</node></node></hierarchy>`
  );
}

class Fake implements Driver {
  readonly kind = 'direct' as const;
  calls: Array<{ m: string; a: unknown[] }> = [];
  xml: string;
  size = { width: 1080, height: 1920 };
  ime = false;
  imeRect: [number, number, number, number] | null = [0, 1200, 1080, 1920];
  canHide = true;
  hideThrows?: Error;
  onSwipe?: () => void;
  asciiOnly = false;
  constructor(xml: string) {
    this.xml = xml;
  }
  private rec(m: string, ...a: unknown[]) {
    this.calls.push({ m, a });
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
    return this.ime;
  }
  async imeFrame() {
    return this.ime ? this.imeRect : null;
  }
  async hideKeyboard() {
    this.rec('hideKeyboard');
    if (this.hideThrows) throw this.hideThrows;
    if (!this.ime || !this.canHide) return false;
    this.ime = false;
    return true;
  }
  async logcat() {
    return '';
  }
  async airplaneOn() {
    return false;
  }
  async setAirplane() {}
  async foregroundOwner() {
    return 'com.example.app/.Main';
  }
  async screenshot() {
    this.rec('screenshot');
    return Buffer.alloc(0);
  }
  async dumpXml() {
    return this.xml;
  }
  async tapXY(x: number, y: number) {
    this.rec('tapXY', x, y);
  }
  async pressXY(x: number, y: number, ms: number) {
    this.rec('pressXY', x, y, ms);
  }
  canDeliverText(text: string) {
    return this.asciiOnly ? adbTextDeliverability(text) : ({ ok: true } as const);
  }
  async inputText(text: string) {
    this.rec('inputText', text);
  }
  async clearFocusedText() {
    this.rec('clearFocusedText');
  }
  async typeBySelector(using: string, value: string, text: string) {
    this.rec('typeBySelector', using, value, text);
  }
  async clearBySelector(using: string, value: string) {
    this.rec('clearBySelector', using, value);
  }
  async isSecureBySelector() {
    return false;
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
    return this.size;
  }
  async screenDensity() {
    return 420;
  }
  async openUrl() {}
  async disableAnimations() {}
}

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, JSON.stringify(res.content)).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

describe('gesture geometry (B)', () => {
  it('ignores inverted (clipped) scrollables and anchors inside the list, never on the app bar', () => {
    const size = { width: 2400, height: 1080 };
    const nodes = [
      { scrollable: true, bounds: [210, 315, 750, 124] as [number, number, number, number] },
      { scrollable: false, bounds: [0, 0, 2400, 315] as [number, number, number, number] },
      { scrollable: true, bounds: [0, 315, 2400, 1080] as [number, number, number, number] },
    ];
    const rect = largestScrollableRect(nodes, size);
    expect(rect).toEqual([0, 315, 2400, 1080]);
    // scroll up = finger moves DOWN
    const v = swipeInRect(rect!, 'down', size, 0.6, SCROLL_CONTAINER_INSET, GESTURE_EDGE_INSET);
    expect(v[1]).toBeGreaterThan(315); // the old screen-center swipe started at y=216 (app bar)
    expect(v[3]).toBeGreaterThan(v[1]);
    expect(v[3]).toBeLessThanOrEqual(1080 - Math.round(1080 * GESTURE_EDGE_INSET));
    expect(largestScrollableRect([{ scrollable: true, bounds: [210, 315, 750, 124] }], size)).toBeNull();
  });
});

describe('qa_act smoke-test fixes (fake driver)', () => {
  let client: Client;
  let sessions: SessionStore;
  let projectRoot: string;
  let current: Fake;

  async function start(fake: Fake): Promise<string> {
    current = fake;
    const s = structured((await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult);
    return s.sessionId as string;
  }
  async function call(name: string, args: Record<string, unknown>) {
    return structured((await client.callTool({ name, arguments: args })) as CallToolResult);
  }
  async function refOf(sessionId: string, pred: (e: { name: string; text?: string; id?: string }) => boolean): Promise<string> {
    const snap = await call('qa_snapshot', { sessionId });
    const el = elementsOf(snap).find(pred);
    expect(el, JSON.stringify(snap.elements).slice(0, 600)).toBeTruthy();
    return el!.ref;
  }

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-device-act-proj-'));
    setDriverFactoryForTests(() => current);
    const ctx = createServer();
    sessions = ctx.sessions;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'device-act-test', version: '0' });
    await Promise.all([ctx.server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('A: a registered secret typed into a NON-secure field is recorded as secret, without plaintext', async () => {
    const fake = new Fake(formScreen());
    const sessionId = await start(fake);
    const pw = await refOf(sessionId, (e) => e.id === 'password');
    const SECRET = 'Sup3r-S3cret!';
    expect((await call('qa_act', { sessionId, action: 'type', target: { ref: pw }, text: SECRET })).ok).toBe(true);
    const email = await refOf(sessionId, (e) => e.name === 'Email');
    const r = await call('qa_act', { sessionId, action: 'type', target: { ref: email }, text: SECRET });
    expect(r.ok).toBe(true);
    expect(r.secret).toBe(true);
    // contains-match via the native-selector path
    const r2 = await call('qa_act', {
      sessionId,
      action: 'type',
      target: { selector: { using: 'accessibility id', value: 'notes' } },
      text: `note ${SECRET} end`,
    });
    expect(r2.ok).toBe(true);
    const recorded = sessions.get(sessionId)!.recordedActions.filter((a) => a.action === 'type');
    expect(recorded).toHaveLength(3);
    for (const a of recorded) {
      expect(a.secret).toBe(true);
      expect(a.text).toBeUndefined();
      expect(a.exportability).toBe('needs-human-data');
    }
    expect(JSON.stringify(sessions.get(sessionId)!.recordedActions)).not.toContain(SECRET);
  }, 20_000);

  it('B: landscape scroll up starts inside the scrollable list, not on the app bar', async () => {
    const fake = new Fake(landscapeList());
    fake.size = { width: 2400, height: 1080 };
    const sessionId = await start(fake);
    await call('qa_snapshot', { sessionId });
    const r = await call('qa_act', { sessionId, action: 'scroll', direction: 'up' });
    expect(r.ok).toBe(true);
    expect(r.anchoredIn).toBe('scrollable');
    const [x1, y1, x2, y2] = fake.got('swipe')[0].a as number[];
    expect(y1).toBeGreaterThan(315);
    expect(y2).toBeGreaterThan(y1); // finger moves down for scroll up
    expect(x1).toBe(x2);
    expect(y2).toBeLessThan(1080);
  }, 20_000);

  it('C: a plain scroll (no untilVisible) performs exactly ONE swipe', async () => {
    const fake = new Fake(landscapeList());
    fake.size = { width: 2400, height: 1080 };
    const sessionId = await start(fake);
    await call('qa_snapshot', { sessionId });
    const r = await call('qa_act', { sessionId, action: 'scroll', direction: 'down' });
    expect(r.ok).toBe(true);
    expect(r.swipes).toBe(1);
    expect(fake.got('swipe')).toHaveLength(1);
  }, 20_000);

  it('F: a scroll that only moves element bounds reports changed:true', async () => {
    const fake = new Fake(landscapeList(0));
    fake.size = { width: 2400, height: 1080 };
    fake.onSwipe = () => (fake.xml = landscapeList(80)); // same elements, shifted 80px
    const sessionId = await start(fake);
    await call('qa_snapshot', { sessionId });
    const r = await call('qa_act', { sessionId, action: 'scroll', direction: 'down' });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    // and a scroll that moved nothing stays changed:false
    fake.onSwipe = undefined;
    const r2 = await call('qa_act', { sessionId, action: 'scroll', direction: 'down' });
    expect(r2.changed).toBe(false);
  }, 20_000);

  it('D: replace-mode typing of undeliverable text is refused before focusing/clearing the field', async () => {
    const fake = new Fake(formScreen());
    fake.asciiOnly = true;
    const sessionId = await start(fake);
    const email = await refOf(sessionId, (e) => e.name === 'Email');
    const r = await call('qa_act', { sessionId, action: 'type', target: { ref: email }, text: 'héllo' });
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('TEXT_INPUT_UNSUPPORTED');
    expect(r.changedState).toBe(false);
    expect(fake.got('tapXY')).toHaveLength(0);
    expect(fake.got('clearFocusedText')).toHaveLength(0);
    expect(fake.got('inputText')).toHaveLength(0);
    expect(sessions.get(sessionId)!.recordedActions).toHaveLength(0);
  }, 20_000);

  it('G: a missing required field is INVALID_ARGUMENT (not UNKNOWN)', async () => {
    const fake = new Fake(formScreen());
    const sessionId = await start(fake);
    const r = await call('qa_act', { sessionId, action: 'scroll' });
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('INVALID_ARGUMENT');
    const r2 = await call('qa_act', { sessionId, action: 'tap' });
    expect(r2.failureCode).toBe('INVALID_ARGUMENT');
  }, 20_000);

  it('G: qa_clear_overlay hide_keyboard that cannot dismiss returns KEYBOARD_NOT_DISMISSIBLE', async () => {
    const fake = new Fake(formScreen());
    fake.ime = true;
    fake.hideThrows = new Error(
      'WdaHttpError: WDA HTTP 400: Did not know how to dismiss the keyboard. Try to dismiss it in the way supported by your application under test.',
    );
    const sessionId = await start(fake);
    const r = await call('qa_clear_overlay', { sessionId, strategy: 'hide_keyboard' });
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('KEYBOARD_NOT_DISMISSIBLE');
    expect((r.nextSteps as string[]).join(' ')).toMatch(/enter/);
    // a backend that reports "could not hide" (false) is typed the same way
    fake.hideThrows = undefined;
    fake.canHide = false;
    const r2 = await call('qa_clear_overlay', { sessionId, strategy: 'hide_keyboard' });
    expect(r2.failureCode).toBe('KEYBOARD_NOT_DISMISSIBLE');
  }, 20_000);

  it('G: a withheld screenshot returns CAPTURE_WITHHELD_SECURE', async () => {
    const fake = new Fake(formScreen());
    const sessionId = await start(fake);
    await call('qa_snapshot', { sessionId });
    const r = await call('qa_screenshot', { sessionId });
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('CAPTURE_WITHHELD_SECURE');
    expect(fake.got('screenshot')).toHaveLength(0);
  }, 20_000);

  it('I: a tap that first auto-hid the keyboard reports keyboardHidden:true', async () => {
    const fake = new Fake(formScreen(1700));
    const sessionId = await start(fake);
    const ref = await refOf(sessionId, (e) => e.name === 'Sign in');
    fake.ime = true;
    const r = await call('qa_act', { sessionId, action: 'tap', target: { ref } });
    expect(r.ok).toBe(true);
    expect(r.keyboardHidden).toBe(true);
    expect(fake.got('hideKeyboard')).toHaveLength(1);
  }, 20_000);
});
