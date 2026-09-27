// Flow runner execution-layer fixes (runFlow driven directly with a fake driver):
//  H7  clearOverlay presses BACK only when a keyboard/dialog is actually present.
//  H2  step detail/reason are scrubbed of secrets (driver errors can echo typed text).
//  #7  gestures re-read the screen size, so a mid-flow rotation uses the new axes.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-flow-home-'));
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { runFlow } = await import('../src/flows/run.js');
const { SessionStore } = await import('../src/session/store.js');
type Driver = import('../src/drivers/Driver.js').Driver;
type Flow = import('../src/flows/schema.js').Flow;
type FlowStep = import('../src/flows/schema.js').FlowStep;

function xml(dialog = false, extra = ''): string {
  const dlg = dialog
    ? `<node class="android.widget.Button" text="OK" resource-id="android:id/button1" content-desc="" bounds="[600,1000][900,1100]" clickable="true" enabled="true"/>`
    : extra;
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
    `<node class="android.widget.TextView" text="Home" resource-id="" content-desc="" bounds="[40,100][1040,180]" clickable="false" enabled="true"/>` +
    `<node class="android.widget.EditText" text="" resource-id="com.example.app:id/pw" content-desc="Password" password="true" bounds="[40,300][1040,400]" clickable="true" enabled="true"/>` +
    dlg +
    `</node></hierarchy>`
  );
}

class FlowFake implements Driver {
  readonly kind = 'direct' as const;
  calls: Array<{ m: string; a: unknown[] }> = [];
  ime = false;
  dialog = false;
  extra = '';
  fg = 'com.example.app/.Main';
  size = { width: 1080, height: 1920 };
  withHide = true;
  inputError?: Error;
  hideKeyboard?: () => Promise<boolean>;
  constructor() {
    this.hideKeyboard = async () => {
      this.rec('hideKeyboard');
      const was = this.ime;
      this.ime = false;
      return was;
    };
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
    return 'fake';
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
  async logcat() {
    return '';
  }
  async airplaneOn() {
    return false;
  }
  async setAirplane() {}
  async foregroundOwner() {
    return this.fg;
  }
  async screenshot() {
    return Buffer.alloc(0);
  }
  async dumpXml() {
    return xml(this.dialog, this.extra);
  }
  async tapXY(x: number, y: number) {
    this.rec('tapXY', x, y);
  }
  async pressXY() {}
  async inputText(text: string) {
    this.rec('inputText', text);
    if (this.inputError) throw this.inputError;
  }
  async clearFocusedText() {}
  async pressKey(key: string) {
    this.rec('pressKey', key);
    if (key === 'back') {
      this.dialog = false;
      this.extra = '';
      this.fg = 'com.example.app/.Main';
    }
  }
  async swipe(x1: number, y1: number, x2: number, y2: number) {
    this.rec('swipe', x1, y1, x2, y2);
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

function flowOf(steps: FlowStep[]): Flow {
  return { name: 'fixes', appId: 'com.example.app', mode: 'structured', fixtures: [], setup: [], teardown: [], steps } as Flow;
}

async function runWith(fake: FlowFake, steps: FlowStep[], variables?: Record<string, string>) {
  const sessions = new SessionStore();
  const session = sessions.create(mkdtempSync(join(tmpdir(), 'swipium-flow-proj-')));
  session.appId = 'com.example.app';
  return runFlow(sessions, session, fake, flowOf(steps), { variables });
}

describe('flow clearOverlay (H7)', () => {
  it('does NOT press BACK when no keyboard or dialog is present', async () => {
    const fake = new FlowFake();
    const r = await runWith(fake, [{ kind: 'clearOverlay' }]);
    expect(r.passed).toBe(true);
    expect(fake.got('pressKey')).toHaveLength(0);
    expect(r.steps[0].detail).toMatch(/nothing to clear/);
    expect(r.steps[0].nothingCleared).toBe(true);
  }, 20_000);

  it('dismisses a Material bottom sheet and a system permission dialog with BACK', async () => {
    const sheet = new FlowFake();
    sheet.extra = `<node class="android.widget.FrameLayout" text="" resource-id="com.example.app:id/design_bottom_sheet" content-desc="" bounds="[0,1200][1080,1920]" clickable="false" enabled="true"/>`;
    const r1 = await runWith(sheet, [{ kind: 'clearOverlay' }]);
    expect(sheet.got('pressKey').map((c) => c.a[0])).toEqual(['back']);
    expect(r1.steps[0].detail).toMatch(/bottom_sheet/);
    expect(r1.steps[0].nothingCleared).toBeUndefined();

    const perm = new FlowFake();
    perm.fg = 'com.google.android.permissioncontroller/.GrantPermissionsActivity';
    const r2 = await runWith(perm, [{ kind: 'clearOverlay' }]);
    expect(perm.got('pressKey').map((c) => c.a[0])).toEqual(['back']);
    expect(r2.steps[0].detail).toMatch(/permission_dialog/);
  }, 20_000);

  it('never presses BACK for a snackbar/banner or plain screen (BACK would navigate away)', async () => {
    const snack = new FlowFake();
    snack.extra = `<node class="android.widget.TextView" text="Saved" resource-id="com.example.app:id/snackbar_text" content-desc="" bounds="[0,1800][1080,1900]" clickable="false" enabled="true"/>`;
    const r = await runWith(snack, [{ kind: 'clearOverlay' }]);
    expect(snack.got('pressKey')).toHaveLength(0);
    expect(r.steps[0].nothingCleared).toBe(true);
  }, 20_000);

  it('hides a shown keyboard (no BACK) and dismisses a native dialog with BACK', async () => {
    const kb = new FlowFake();
    kb.ime = true;
    await runWith(kb, [{ kind: 'clearOverlay' }]);
    expect(kb.got('hideKeyboard')).toHaveLength(1);
    expect(kb.got('pressKey')).toHaveLength(0);

    const dlg = new FlowFake();
    dlg.dialog = true;
    const r = await runWith(dlg, [{ kind: 'clearOverlay' }]);
    expect(dlg.got('pressKey').map((c) => c.a[0])).toEqual(['back']);
    expect(r.steps[0].detail).toMatch(/native_dialog/);
  }, 20_000);
});

describe('flow step detail redaction (H2)', () => {
  it('scrubs a secret typed value echoed by a failing driver from detail and reason', async () => {
    const fake = new FlowFake();
    fake.inputError = new Error('`adb shell input text S3cretPass` exited 1: S3cretPass rejected');
    const r = await runWith(fake, [{ kind: 'inputText', value: 'S3cretPass', secret: true }]);
    expect(r.passed).toBe(false);
    expect(r.steps[0].detail).not.toContain('S3cretPass');
    expect(r.reason).not.toContain('S3cretPass');
    expect(r.steps[0].detail).toContain('«redacted»');
  }, 20_000);
});

describe('flow gestures follow rotation (#7)', () => {
  it('re-reads the screen size for each swipe', async () => {
    const fake = new FlowFake();
    const steps: FlowStep[] = [
      { kind: 'swipe', direction: 'up' },
      { kind: 'swipe', direction: 'up' },
    ];
    const origSwipe = fake.swipe.bind(fake);
    fake.swipe = async (...a: [number, number, number, number]) => {
      await origSwipe(...a);
      fake.size = { width: 1920, height: 1080 }; // rotated after the first swipe
    };
    await runWith(fake, steps);
    const [first, second] = fake.got('swipe').map((c) => c.a);
    expect(first[0]).toBe(540); // portrait center x
    expect(second[0]).toBe(960); // landscape center x
  }, 20_000);
});
