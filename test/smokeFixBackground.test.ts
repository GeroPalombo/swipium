// iOS device recheck: after qa_app_control background the result still said the app was in front
// (foreground read too early, and a failed activeAppInfo fell back to the app's own bundle id).
// background now polls until the foreground changes, and success results carry changedState.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeDriver, buttonScreen, harness, structured } from './actFixFake.js';

/** Reports the app in front for the first few reads after "home", then the home screen. */
class SlowHomeDriver extends FakeDriver {
  private readsAfterHome = -1;
  async pressKey(key: string) {
    await super.pressKey(key);
    if (key === 'home') this.readsAfterHome = 0;
  }
  async foregroundOwner() {
    this.rec('foregroundOwner');
    if (this.readsAfterHome < 0) return 'com.example.app';
    return ++this.readsAfterHome <= 2 ? 'com.example.app' : 'com.apple.springboard';
  }
}

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('smokefix-background');
});
afterAll(async () => {
  await h.close();
});

describe('qa_app_control background', () => {
  it('waits for the home transition and reports the real foreground', async () => {
    const fake = new SlowHomeDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const r = structured(await h.call('qa_app_control', { sessionId: id, action: 'background' }));
    expect(r.ok).toBe(true);
    expect(r.foreground).toBe('com.apple.springboard');
    expect(r.foregroundIsApp).toBe(false);
    expect(r.changedState).toBe(true);
  }, 20_000);
});

describe('WdaDriver.foregroundOwner', () => {
  it('returns "unknown" (never the app under test) when WDA cannot answer', async () => {
    const { WdaDriver } = await import('../src/drivers/WdaDriver.js');
    // Nothing listens on this port: session creation and activeAppInfo both fail fast.
    const d = new WdaDriver('http://127.0.0.1:9', { udid: 'SIM-1', bundleId: 'com.example.app' });
    expect(await d.foregroundOwner()).toBe('unknown');
  }, 20_000);
});
