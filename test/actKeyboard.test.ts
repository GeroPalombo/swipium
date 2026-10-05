// qa_act handler-level coverage (fake driver) for the execution-layer fixes:
//  H5  keyboard obstruction — hide the IME (known frame only), re-resolve, tap; else
//      KEYBOARD_OBSTRUCTION; unknown/oversized frames tap with a warning; and the
//      no-change press retry never re-taps while the IME is up.
//  #8  awaitIme field-hop floor.
//  #10 scroll untilVisible checks visibility first and stops at the end of the list.
//  H2  driver error text is redacted before it reaches `what`.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { elementsOf } from './actFixFake.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-test-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
type Driver = import('../src/drivers/Driver.js').Driver;

/** A >=15-node screen with one "Sign in" button whose top edge is at `buttonY`. */
function screen(buttonY: number, extra = ''): string {
  const rows = Array.from(
    { length: 10 },
    (_, i) =>
      `<node class="android.widget.TextView" text="Row ${i + 1}${extra}" resource-id="com.example.app:id/row_${i}" content-desc="" bounds="[40,${300 + i * 70}][1040,${350 + i * 70}]" clickable="false" enabled="true"/>`,
  ).join('');
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
    `<node class="android.widget.TextView" text="Login" resource-id="" content-desc="" bounds="[40,100][1040,180]" clickable="false" enabled="true"/>` +
    `<node class="android.widget.EditText" text="" resource-id="com.example.app:id/password" content-desc="Password" password="true" bounds="[40,200][1040,280]" clickable="true" focusable="true" enabled="true"/>` +
    rows +
    `<node class="android.widget.Button" text="Sign in" resource-id="com.example.app:id/sign_in" content-desc="" bounds="[40,${buttonY}][1040,${buttonY + 100}]" clickable="true" enabled="true"/>` +
    `</node></hierarchy>`
  );
}

class KbFake implements Driver {
  readonly kind = 'direct' as const;
  calls: Array<{ m: string; a: unknown[]; t: number }> = [];
  ime = false;
  imeRect: [number, number, number, number] | null = [0, 1200, 1080, 1920];
  canHide = true;
  onHide?: () => void;
  onSwipe?: () => void;
  xml: string;
  inputError?: Error;
  constructor(xml: string) {
    this.xml = xml;
  }
  private rec(m: string, ...a: unknown[]) {
    this.calls.push({ m, a, t: Date.now() });
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
    if (!this.ime || !this.canHide) return false;
    this.ime = false;
    this.onHide?.();
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
    return 'unknown';
  }
  async screenshot() {
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
  async inputText(text: string) {
    this.rec('inputText', text);
    if (this.inputError) throw this.inputError;
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

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, JSON.stringify(res.content)).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

describe('qa_act execution-layer fixes (fake driver)', () => {
  let client: Client;
  let projectRoot: string;
  let current: KbFake;

  async function start(fake: KbFake): Promise<string> {
    current = fake;
    const s = structured((await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult);
    return s.sessionId as string;
  }
  async function act(sessionId: string, args: Record<string, unknown>) {
    return structured((await client.callTool({ name: 'qa_act', arguments: { sessionId, ...args } })) as CallToolResult);
  }
  async function refOf(sessionId: string, text: string): Promise<string> {
    const snap = structured((await client.callTool({ name: 'qa_snapshot', arguments: { sessionId } })) as CallToolResult);
    const el = elementsOf(snap).find((e) => e.name === text);
    expect(el, `element ${text}`).toBeTruthy();
    return el!.ref;
  }

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-test-project-'));
    setDriverFactoryForTests(() => current);
    const { server } = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'act-keyboard-test', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('H5: hides the keyboard, re-resolves the moved button, and taps its NEW position', async () => {
    const fake = new KbFake(screen(1700));
    const sessionId = await start(fake);
    const ref = await refOf(sessionId, 'Sign in');
    fake.ime = true;
    fake.onHide = () => (fake.xml = screen(1000)); // layout reflows once the IME is gone
    const s = await act(sessionId, { action: 'tap', target: { ref } });
    expect(s.ok).toBe(true);
    expect(fake.got('hideKeyboard')).toHaveLength(1);
    expect(fake.got('tapXY').map((c) => c.a)).toEqual([[540, 1050]]); // never (540,1750) — that's a key
    expect(fake.got('pressKey')).toHaveLength(0); // no blind BACK
  }, 20_000);

  it('H5: returns KEYBOARD_OBSTRUCTION without tapping when the keyboard cannot be hidden', async () => {
    const fake = new KbFake(screen(1700));
    const sessionId = await start(fake);
    const ref = await refOf(sessionId, 'Sign in');
    fake.ime = true;
    fake.canHide = false;
    const s = await act(sessionId, { action: 'tap', target: { ref } });
    expect(s.ok).toBe(false);
    expect(s.failureCode).toBe('KEYBOARD_OBSTRUCTION');
    expect(fake.got('tapXY')).toHaveLength(0);
    expect(fake.got('pressXY')).toHaveLength(0);
  }, 20_000);

  it('H5: unknown IME frame + target in the bottom 40% → tapped with a warning, keyboard NOT hidden', async () => {
    const fake = new KbFake(screen(1300)); // center y=1350, inside the old bottom-40% guess
    fake.imeRect = null;
    const sessionId = await start(fake);
    const ref = await refOf(sessionId, 'Sign in');
    fake.ime = true;
    const s = await act(sessionId, { action: 'tap', target: { ref } });
    expect(s.ok).toBe(true);
    expect(fake.got('hideKeyboard')).toHaveLength(0);
    expect(fake.got('tapXY').map((c) => c.a)).toEqual([[540, 1350]]);
    expect((s.warnings as string[]).join(' ')).toContain('keyboard is up; could not determine its area');
  }, 20_000);

  it('H5: accessory toolbar / suggestion chip just ABOVE a known keyboard frame → tapped, no hide', async () => {
    const fake = new KbFake(screen(1300)); // chip at y 1300..1400, keyboard starts at 1450
    fake.imeRect = [0, 1450, 1080, 1920];
    const sessionId = await start(fake);
    const ref = await refOf(sessionId, 'Sign in');
    fake.ime = true;
    const s = await act(sessionId, { action: 'tap', target: { ref } });
    expect(s.ok).toBe(true);
    expect(s.warnings).toBeUndefined();
    expect(fake.got('hideKeyboard')).toHaveLength(0);
    expect(fake.got('tapXY').map((c) => c.a)).toEqual([[540, 1350]]);
  }, 20_000);

  it('H5: an oversized IME frame (> 55% of the screen) is treated as unknown — no hide, warning', async () => {
    const fake = new KbFake(screen(1300));
    fake.imeRect = [0, 200, 1080, 1920]; // near-full-screen IME window, not a keyboard rect
    const sessionId = await start(fake);
    const ref = await refOf(sessionId, 'Sign in');
    fake.ime = true;
    const s = await act(sessionId, { action: 'type', target: { ref }, text: 'x', mode: 'append' });
    expect(s.ok).toBe(true);
    expect(fake.got('hideKeyboard')).toHaveLength(0);
    expect(fake.got('inputText')).toHaveLength(1);
    expect((s.warnings as string[]).join(' ')).toContain('could not determine its area');
  }, 20_000);

  it('H5: a KEYBOARD_OBSTRUCTION after actually hiding the keyboard says so (changedState:true)', async () => {
    const fake = new KbFake(screen(1700));
    const sessionId = await start(fake);
    const ref = await refOf(sessionId, 'Sign in');
    fake.ime = true;
    fake.onHide = () => {
      // the target vanished from the dump once the keyboard hid
      fake.xml = screen(1700).replace('text="Sign in"', 'text="Other"');
    };
    const s = await act(sessionId, { action: 'tap', target: { ref } });
    expect(s.failureCode).toBe('KEYBOARD_OBSTRUCTION');
    expect(s.changedState).toBe(true);
    expect(String(s.what)).toContain('keyboard was hidden');
    expect(fake.got('tapXY')).toHaveLength(0);
  }, 20_000);

  it('WDA session recovery surfaces a warning on the qa_act result', async () => {
    const fake = new KbFake(screen(600)) as KbFake & { consumeSessionRecovered(): boolean };
    let recovered = true;
    fake.consumeSessionRecovered = () => {
      const v = recovered;
      recovered = false;
      return v;
    };
    const sessionId = await start(fake);
    const ref = await refOf(sessionId, 'Sign in');
    const s = await act(sessionId, { action: 'tap', target: { ref } });
    expect(s.ok).toBe(true);
    expect((s.warnings as string[]).join(' ')).toContain('WDA session was re-created (requested without relaunching the app)');
    const s2 = await act(sessionId, { action: 'tap', target: { ref } });
    expect(s2.warnings).toBeUndefined();
  }, 20_000);

  it('H5: with the IME up, an unchanged-screen tap is NOT retried as a press', async () => {
    const fake = new KbFake(screen(600)); // well above the keyboard
    const sessionId = await start(fake);
    const ref = await refOf(sessionId, 'Sign in');
    fake.ime = true;
    const s = await act(sessionId, { action: 'tap', target: { ref } });
    expect(s.ok).toBe(true);
    expect(s.changed).toBe(false);
    expect(s.retriedAsPress).toBe(false);
    expect(fake.got('tapXY')).toHaveLength(1);
    expect(fake.got('pressXY')).toHaveLength(0);
  }, 20_000);

  it('#8: typing after a field hop (IME already up) waits at least the 250ms floor', async () => {
    const fake = new KbFake(screen(600));
    const sessionId = await start(fake);
    fake.ime = true;
    const s = await act(sessionId, { action: 'type', target: { text: 'Row 1' }, text: 'abc', mode: 'append' });
    expect(s.ok).toBe(true);
    const tap = fake.got('tapXY')[0];
    const typed = fake.got('inputText')[0];
    expect(typed.t - tap.t).toBeGreaterThanOrEqual(240);
  }, 20_000);

  it('#10: scroll untilVisible does not swipe when the target is already visible', async () => {
    const fake = new KbFake(screen(600));
    const sessionId = await start(fake);
    const s = await act(sessionId, { action: 'scroll', direction: 'down', untilVisible: { text: 'Sign in' } });
    expect(s.untilVisibleFound).toBe(true);
    expect(s.swipes).toBe(0);
    expect(fake.got('swipe')).toHaveLength(0);
  }, 20_000);

  it('#10: scroll untilVisible stops at the end of the list and reports it', async () => {
    const fake = new KbFake(screen(600));
    const sessionId = await start(fake);
    const s = await act(sessionId, { action: 'scroll', direction: 'down', untilVisible: { text: 'Nowhere' }, maxScrolls: 8 });
    expect(s.untilVisibleFound).toBe(false);
    expect(s.endOfList).toBe(true);
    expect(fake.got('swipe')).toHaveLength(1);
  }, 20_000);

  it('#10: a list that moved but shows the same labels is not treated as the end (device regression)', async () => {
    // Swipe 1 moves the content (same labels, new positions); swipe 2 reveals the target. A
    // label-only comparison stopped after swipe 1 with endOfList mid-list on a real emulator.
    const screens = [screen(700), screen(800, ' more')];
    const fake = new KbFake(screen(600));
    fake.onSwipe = () => {
      fake.xml = screens.shift() ?? fake.xml;
    };
    const sessionId = await start(fake);
    const s = await act(sessionId, { action: 'scroll', direction: 'down', untilVisible: { text: 'Row 3 more' }, maxScrolls: 8 });
    expect(s.untilVisibleFound).toBe(true);
    expect(s.endOfList).toBeFalsy();
    expect(fake.got('swipe')).toHaveLength(2);
  }, 20_000);

  it('H2: a driver error echoing the typed secret is redacted in `what`', async () => {
    const fake = new KbFake(screen(600));
    const sessionId = await start(fake);
    fake.inputError = new Error('`adb -s x shell input text Hunter2\\!Secret` exited 1: boom Hunter2!Secret');
    const s = await act(sessionId, { action: 'type', target: { text: 'Password' }, text: 'Hunter2!Secret' });
    expect(s.ok).toBe(false);
    expect(String(s.what)).not.toContain('Hunter2'); // neither raw nor adb-escaped form
    expect(String(s.what)).toContain('«redacted»');
  }, 20_000);
});
