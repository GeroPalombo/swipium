// Ref liveness: an aged ref (no action since) skips the re-dump when a cheap pixel
// fingerprint shows the screen unchanged; any change, an action, no baseline or a very old
// snapshot keeps the re-dump path.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buttonScreen, dump, elementsOf, FakeDriver, harness, structured } from './actFixFake.js';
import { parseSnapshot } from '../src/snapshot/parse.js';
import {
  adoptSnapshot,
  noteScreenMutation,
  PIXEL_TRUST_MAX_MS,
  preActionFingerprint,
  unchangedSinceSnapshot,
} from '../src/snapshot/fresh.js';
import { resolveTarget } from '../src/core/target.js';
import { SessionStore, type Session } from '../src/session/store.js';
import { fingerprintRawScreencap, pixelChangeRatio, samePixels, type PixelFingerprint } from '../src/lib/screenFingerprint.js';

/** A raw screencap: 16-byte header + RGBA, filled with `bg`, plus optional rects. */
function rawCap(w: number, h: number, bg: number, rects: Array<[number, number, number, number, number]> = [], header = 16): Buffer {
  const buf = Buffer.alloc(header + w * h * 4, bg);
  buf.writeUInt32LE(w, 0);
  buf.writeUInt32LE(h, 4);
  buf.writeUInt32LE(1, 8);
  if (header === 16) buf.writeUInt32LE(0, 12);
  for (const [x1, y1, x2, y2, v] of rects) for (let y = y1; y < y2; y++) buf.fill(v, header + (y * w + x1) * 4, header + (y * w + x2) * 4);
  return buf;
}

class PixelFake extends FakeDriver {
  cap: Buffer = rawCap(1080, 2400, 200);
  fail = false;
  async pixelFingerprint(): Promise<PixelFingerprint | undefined> {
    this.rec('pixelFingerprint');
    if (this.fail) throw new Error('screencap failed');
    return fingerprintRawScreencap(this.cap);
  }
}

function setup(): { fake: PixelFake; session: Session } {
  const xml = buttonScreen('Home', 3);
  const fake = new PixelFake(xml);
  const session = new SessionStore().create(mkdtempSync(join(tmpdir(), 'swipium-liveness-')));
  session.appId = 'com.example.app';
  session.driver = fake;
  adoptSnapshot(session, parseSnapshot(xml));
  session.lastSnapshot!.at = Date.now() - 6000; // aged past REF_FRESH_MS and PRE_ACTION_MAX_AGE_MS
  return { fake, session };
}

const dumps = (f: FakeDriver) => f.got('dumpXml').length;

describe('screenFingerprint (raw screencap sampling)', () => {
  it('parses 16- and 12-byte headers and ignores the status bar band', () => {
    const a = fingerprintRawScreencap(rawCap(1080, 2400, 10))!;
    expect(a).toMatchObject({ width: 1080, height: 2400, bpp: 4 });
    expect(fingerprintRawScreencap(rawCap(100, 200, 10, [], 12))).toMatchObject({ width: 100, height: 200, bpp: 4 });
    expect(fingerprintRawScreencap(Buffer.from('garbage-not-a-framebuffer'))).toBeUndefined();
    // clock change inside the top 4%: still the same screen
    const clock = fingerprintRawScreencap(rawCap(1080, 2400, 10, [[900, 10, 1060, 80, 255]]))!;
    expect(pixelChangeRatio(a, clock)).toBe(0);
  });

  it('a caret blink stays under tolerance; a toast or a shifted list does not', () => {
    const a = fingerprintRawScreencap(rawCap(1080, 2400, 10))!;
    const caret = fingerprintRawScreencap(rawCap(1080, 2400, 10, [[500, 600, 504, 660, 255]]))!;
    expect(samePixels(a, caret)).toBe(true);
    const toast = fingerprintRawScreencap(rawCap(1080, 2400, 10, [[340, 2000, 740, 2120, 255]]))!;
    expect(samePixels(a, toast)).toBe(false);
    const banner = fingerprintRawScreencap(rawCap(1080, 2400, 10, [[0, 200, 1080, 400, 90]]))!;
    expect(samePixels(a, banner)).toBe(false);
    expect(pixelChangeRatio(a, fingerprintRawScreencap(rawCap(1080, 1920, 10))!)).toBe(1);
  });
});

describe('ref liveness in resolveTarget', () => {
  it('aged ref, unchanged pixels: no re-dump, stored coordinates', async () => {
    const { fake, session } = setup();
    const p = await resolveTarget(session, { ref: '@e2' });
    expect(p).toMatchObject({ ref: '@e2', y: 223 });
    expect(p).not.toHaveProperty('refMoved');
    expect(dumps(fake)).toBe(0);
    expect(fake.got('pixelFingerprint').length).toBe(2); // baseline + check
    // verified current: the action's settle may use it as the pre-action screen
    expect(preActionFingerprint(session)).toBeDefined();
  });

  it('changed pixels re-dump and re-find the node', async () => {
    const { fake, session } = setup();
    fake.cap = rawCap(1080, 2400, 200, [[0, 150, 1080, 300, 30]]); // a late banner
    fake.xml = buttonScreen('Home', 3).replace('[40,200][1040,245]', '[40,230][1040,275]');
    const p = await resolveTarget(session, { ref: '@e2' });
    expect(p).toMatchObject({ ref: '@e2', y: 253, refMoved: true });
    expect(dumps(fake)).toBe(1);
  });

  it('an action since, a failed capture, or an over-age snapshot keep the re-dump', async () => {
    const a = setup();
    noteScreenMutation(a.session);
    expect(await unchangedSinceSnapshot(a.session)).toBe(false);
    await resolveTarget(a.session, { ref: '@e2' });
    expect(dumps(a.fake)).toBe(1);

    const b = setup();
    b.fake.fail = true;
    expect(await unchangedSinceSnapshot(b.session)).toBe(false);

    const c = setup();
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0 + PIXEL_TRUST_MAX_MS + 1);
    try {
      expect(await unchangedSinceSnapshot(c.session)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('drivers without pixelFingerprint (iOS) keep the re-dump', async () => {
    const xml = buttonScreen('Home', 3);
    const fake = new FakeDriver(xml);
    const session = new SessionStore().create(mkdtempSync(join(tmpdir(), 'swipium-liveness-')));
    session.driver = fake;
    adoptSnapshot(session, parseSnapshot(xml));
    session.lastSnapshot!.at = Date.now() - 5000;
    await resolveTarget(session, { ref: '@e2' });
    expect(dumps(fake)).toBe(1);
  });
});

describe('review fixes', () => {
  it('preActionFingerprint needs the snapshot to precede THIS action (at most one action since)', () => {
    const { session } = setup();
    session.lastSnapshot!.at = Date.now();
    expect(preActionFingerprint(session)).toBeDefined();
    noteScreenMutation(session);
    expect(preActionFingerprint(session)).toBeDefined();
    noteScreenMutation(session); // e.g. an app restart before the tap
    expect(preActionFingerprint(session)).toBeUndefined();
  });

  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness('liveness');
  });
  afterAll(async () => {
    await h.close();
  });

  it('wait for:{ref, gone:true} on a text field is not "gone" when only its text changes', async () => {
    const field = (text: string) =>
      dump([{ cls: 'android.widget.EditText', text, id: 'com.example.app:id/q', bounds: [40, 200, 1040, 300] }]);
    const fake = new FakeDriver(field('hello'));
    const id = await h.start(fake);
    const snap = structured(await h.call('qa_snapshot', { sessionId: id }));
    const ref = elementsOf(snap).find((e) => e.id?.endsWith('q') || e.text === 'hello')?.ref;
    expect(ref).toBeTruthy();
    let n = 0;
    fake.dumpXml = async () => field(`hello ${++n}`);
    const s = structured(await h.call('qa_act', { sessionId: id, action: 'wait', for: { ref, gone: true }, timeoutMs: 1200 }));
    expect(s).toMatchObject({ ok: false });
    expect(s.gone).toBeUndefined();
  }, 20_000);
});
