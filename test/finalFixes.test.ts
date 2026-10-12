// 2.3.0 fixes: retired refs re-found or STALE_REF with candidates, descendant labels
// skip the pre-tap screenshot.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDriver } from './actFixFake.js';
import { parseSnapshot } from '../src/snapshot/parse.js';
import { adoptSnapshot, RETIRED_REFS_MAX, retiredRef } from '../src/snapshot/fresh.js';
import { resolveTarget } from '../src/core/target.js';
import { needsPixelCheck } from '../src/tools/act.js';
import { SessionStore, type Session } from '../src/session/store.js';

const node = (attrs: string, kids = '') => `<node ${attrs}>${kids}</node>`;
const bounds = (y: number) => `bounds="[0,${y}][1080,${y + 150}]"`;
/** A Settings-style row: an unlabeled clickable container whose label is a child TextView. */
const row = (y: number, label: string) =>
  node(
    `class="android.widget.LinearLayout" clickable="true" ${bounds(y)}`,
    node(`class="android.widget.TextView" resource-id="android:id/title" text="${label}" ${bounds(y)}`),
  );
const screen = (rows: string) =>
  `<?xml version="1.0"?><hierarchy rotation="0">${node('class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][1080,2400]"', rows)}</hierarchy>`;
const list = (labels: string[], top = 200) => screen(labels.map((l, i) => row(top + i * 150, l)).join(''));

function newSession(fake: FakeDriver): Session {
  const session = new SessionStore().create(mkdtempSync(join(tmpdir(), 'swipium-final-proj-')));
  session.appId = 'com.example.app';
  session.driver = fake;
  return session;
}

/** The ref of the clickable row labeled `label` in the session snapshot. */
function rowRef(session: Session, label: string): string {
  const snap = session.lastSnapshot!;
  for (const [ref, n] of snap.fullByRef) {
    if (n.clickable && snap.allNodes[n.dfs + 1]?.text === label) return ref;
  }
  throw new Error(`no row ${label}`);
}

describe('retired refs', () => {
  it('a row that got a new ref after a scroll is re-found by identity + label and tapped at its new center', async () => {
    const labels = ['Network', 'Battery', 'Display', 'Sound'];
    const fake = new FakeDriver(list(labels));
    const session = newSession(fake);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    const battery = rowRef(session, 'Battery');
    // a scroll moves every row 300 px up: the rows get new refs, the old ones retire
    fake.xml = list(['Network', 'Battery', 'Display', 'Sound', 'Apps', 'Storage'], -100);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    expect(session.lastSnapshot!.fullByRef.has(battery)).toBe(false);
    expect(retiredRef(session, battery)?.label).toBe('Battery');
    const p = await resolveTarget(session, { ref: battery });
    expect(p).toMatchObject({ refMoved: true, y: -100 + 150 + 75 });
    expect('ref' in p && p.ref).toBe(rowRef(session, 'Battery'));
  });

  it('a retired ref with no unique match returns STALE_REF with look-alike candidates', async () => {
    const fake = new FakeDriver(list(['Network', 'Battery']));
    const session = newSession(fake);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    const battery = rowRef(session, 'Battery');
    fake.xml = list(['Wi-Fi', 'Hotspot'], 900);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    // gone from the screen now: candidates, no tap
    const gone = await resolveTarget(session, { ref: battery });
    expect(gone).toMatchObject({ failureCode: 'STALE_REF' });
    expect('error' in gone && gone.error).toMatch(/no longer on screen \(replaced by a later snapshot\)/);

    // two identical rows: ambiguous, never a guess
    fake.xml = list(['Battery', 'Battery'], 900);
    const twice = await resolveTarget(session, { ref: battery });
    expect(twice).toMatchObject({ failureCode: 'STALE_REF' });
    expect('error' in twice && twice.error).toMatch(/2 elements now look the same/);
    expect('candidates' in twice && twice.candidates?.length).toBeGreaterThanOrEqual(2);
  });

  it('is cleared when the app changes or ref numbering restarts, and is bounded', () => {
    const fake = new FakeDriver(list(['A', 'B']));
    const session = newSession(fake);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    const a = rowRef(session, 'A');
    adoptSnapshot(session, parseSnapshot(list(['C', 'D'], 1200)));
    expect(retiredRef(session, a)).toBeDefined();
    session.appId = 'com.other.app';
    expect(retiredRef(session, a)).toBeUndefined();
    session.appId = 'com.example.app';
    session.lastSnapshot = undefined; // refs invalid after a rebind
    adoptSnapshot(session, parseSnapshot(list(['E'])));
    expect(retiredRef(session, a)).toBeUndefined();

    for (let i = 0; i < 120; i++) adoptSnapshot(session, parseSnapshot(list([`X${i}`, `Y${i}`], 200 + (i % 2) * 900)));
    let kept = 0;
    for (let n = 1; n < 1000; n++) if (retiredRef(session, `@e${n}`)) kept++;
    expect(kept).toBe(RETIRED_REFS_MAX);
  });
});

describe('refs across a blank screen', () => {
  it('an empty snapshot (splash) does not restart ref numbering', () => {
    const fake = new FakeDriver(list(['A', 'B']));
    const session = newSession(fake);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    const before = [...session.lastSnapshot!.fullByRef.keys()];
    adoptSnapshot(session, parseSnapshot(screen('')));
    expect(session.lastSnapshot!.fullByRef.size).toBe(0);
    adoptSnapshot(session, parseSnapshot(list(['C', 'D'])));
    for (const ref of session.lastSnapshot!.fullByRef.keys()) expect(before).not.toContain(ref);
  });
});

describe('pre-tap screenshot only for really unlabeled targets', () => {
  it('a clickable row labeled by a child TextView needs no pixel check; a bare clickable does', () => {
    const xml = screen(row(200, 'Battery') + node(`class="android.view.View" clickable="true" ${bounds(600)}`));
    const session = newSession(new FakeDriver(xml));
    adoptSnapshot(session, parseSnapshot(xml));
    const labeled = rowRef(session, 'Battery');
    const bare = [...session.lastSnapshot!.fullByRef].find(([, n]) => n.cls === 'android.view.View')![0];
    expect(needsPixelCheck(session, { x: 540, y: 275, via: labeled, ref: labeled })).toBe(false);
    expect(needsPixelCheck(session, { x: 540, y: 675, via: bare, ref: bare })).toBe(true);
  });
});
