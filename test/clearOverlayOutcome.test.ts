// qa_clear_overlay honesty: a strategy that found nothing to tap never reports "cleared"
// (not_dismissible when the overlay is there, nothing_to_clear when it is not), LogBox's buttons
// are tapped only by their exact label, and LogBox detection needs LogBox structure: an app's
// "2 errors in your form" is not a LogBox overlay.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dump, FakeDriver, harness, structured } from './actFixFake.js';
import { detectTreeOverlays } from '../src/snapshot/overlays.js';
import { parseSnapshot } from '../src/snapshot/parse.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('clear-overlay-outcome');
});
afterAll(async () => {
  await h.close();
});

const FORM = dump([
  { cls: 'android.widget.TextView', text: '2 errors in your form', bounds: [40, 100, 1040, 180], clickable: false },
  { cls: 'android.widget.TextView', text: 'Dismiss notifications for this chat', bounds: [40, 200, 1040, 280] },
]);
const LOGBOX = dump([
  { cls: 'android.widget.TextView', text: 'Home', bounds: [40, 100, 1040, 180], clickable: false },
  { cls: 'android.widget.TextView', text: '3 warnings', bounds: [40, 1600, 700, 1680], clickable: false },
  { text: 'Dismiss', bounds: [40, 1700, 520, 1800] },
  { text: 'Minimize', bounds: [560, 1700, 1040, 1800] },
]);
const overlaysOf = (xml: string) => {
  const p = parseSnapshot(xml);
  return detectTreeOverlays(p.allNodes, p.screen).map((o) => o.type);
};

describe('LogBox detection', () => {
  it('a warning/error count in app copy is not a LogBox', () => {
    expect(overlaysOf(FORM)).not.toContain('rn_logbox');
  });
  it('a count with LogBox Minimize / Dismiss buttons is, and so is LogBox wording', () => {
    expect(overlaysOf(LOGBOX)).toContain('rn_logbox');
    expect(overlaysOf(dump([{ cls: 'android.widget.TextView', text: 'Log 1 of 3', bounds: [40, 100, 1040, 180] }]))).toContain('rn_logbox');
  });
});

describe('qa_clear_overlay outcome', () => {
  it('dismiss_logbox with no LogBox is never "cleared", and app copy containing "Dismiss" is not tapped', async () => {
    const fake = new FakeDriver(FORM);
    const sessionId = await h.start(fake);
    const r = structured(await h.call('qa_clear_overlay', { sessionId, strategy: 'dismiss_logbox' }));
    expect(r.outcome).toBe('nothing_to_clear');
    expect(fake.got('pressXY')).toHaveLength(0);
  }, 20_000);

  it('a LogBox whose control is missing is not_dismissible', async () => {
    const fake = new FakeDriver(
      dump([{ cls: 'android.widget.TextView', text: 'Open debugger to view warnings', bounds: [40, 1600, 1040, 1680], clickable: false }]),
    );
    const sessionId = await h.start(fake);
    const r = structured(await h.call('qa_clear_overlay', { sessionId, strategy: 'minimize_logbox' }));
    expect(r.outcome).toBe('not_dismissible');
    expect(fake.got('pressXY')).toHaveLength(0);
  }, 20_000);

  it('a LogBox Minimize button is tapped', async () => {
    const fake = new FakeDriver(LOGBOX);
    const sessionId = await h.start(fake);
    await h.call('qa_clear_overlay', { sessionId, strategy: 'minimize_logbox' });
    const taps = fake.got('pressXY');
    expect(taps).toHaveLength(1);
    expect(taps[0]!.a[0]).toBe(800); // the Minimize button's center
  }, 20_000);

  it('dismiss_toast_if_possible is not_dismissible, not cleared', async () => {
    const sessionId = await h.start(new FakeDriver(FORM));
    const r = structured(await h.call('qa_clear_overlay', { sessionId, strategy: 'dismiss_toast_if_possible' }));
    expect(r.outcome).toBe('not_dismissible');
  }, 20_000);
});
