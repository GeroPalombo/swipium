// 2.3.0 precision & speed: stable refs, ref freshness re-check,
// target waits, settle fingerprint + Android fast accept, settled-snapshot reuse,
// pixel no-change check, qa_snapshot diff, qa_inspect attrs, weak-tree hint,
// qa_act wait gone, flow inputText IME wait.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { buttonScreen, dump, FakeDriver, harness, structured, type NodeSpec } from './actFixFake.js';
import { stableHash } from '../src/lib/stableHash.js';
import { parseSnapshot } from '../src/snapshot/parse.js';
import { looksBusy, screenFingerprint, settle } from '../src/snapshot/settle.js';
import { adoptSnapshot, freshSnapshot, noteScreenMutation, REF_FRESH_MS, stabilizeRefs } from '../src/snapshot/fresh.js';
import { resolveTarget } from '../src/core/target.js';
import { SessionStore, type Session } from '../src/session/store.js';
import { runFlow } from '../src/flows/run.js';
import type { Flow, FlowStep } from '../src/flows/schema.js';

function makePng(size: number, color: [number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      raw[p++] = color[0];
      raw[p++] = color[1];
      raw[p++] = color[2];
      raw[p++] = 255;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function newSession(fake: FakeDriver): { sessions: SessionStore; session: Session } {
  const sessions = new SessionStore();
  const session = sessions.create(mkdtempSync(join(tmpdir(), 'swipium-precision-proj-')));
  session.appId = 'com.example.app';
  session.driver = fake;
  return { sessions, session };
}

const dumps = (f: FakeDriver) => f.got('dumpXml').length;

describe('stableHash', () => {
  it('ignores key order, keeps array order', () => {
    expect(stableHash({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(stableHash({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('stable refs', () => {
  const base: NodeSpec[] = [
    { cls: 'android.widget.TextView', text: 'Title', bounds: [40, 100, 1040, 180], clickable: false },
    { text: 'One', id: 'com.example.app:id/one', bounds: [40, 300, 1040, 360] },
    { text: 'Two', id: 'com.example.app:id/two', bounds: [40, 400, 1040, 460] },
  ];
  it('first snapshot is DFS-numbered; an inserted element gets a NEW ref and the others keep theirs', () => {
    const a = parseSnapshot(dump(base));
    expect(a.elements.map((e) => e.ref)).toEqual(['@e1', '@e2', '@e3']);
    const inserted = [base[0], { text: 'Banner', bounds: [40, 200, 1040, 260] } as NodeSpec, base[1], base[2]];
    const b = stabilizeRefs(parseSnapshot(dump(inserted)), a.fullByRef, 3).parsed;
    expect(b.elements.map((e) => `${e.ref}:${e.text}`)).toEqual(['@e1:Title', '@e4:Banner', '@e2:One', '@e3:Two']);
  });
  it('a label changed in place keeps its ref; a far move gets a new one', () => {
    const a = parseSnapshot(dump(base));
    const relabeled = [base[0], { ...base[1], text: 'One (1)' }, base[2]];
    expect(stabilizeRefs(parseSnapshot(dump(relabeled)), a.fullByRef, 3).parsed.elements[1].ref).toBe('@e2');
    const moved = [base[0], { ...base[1], bounds: [40, 900, 1040, 960] as [number, number, number, number] }, base[2]];
    expect(stabilizeRefs(parseSnapshot(dump(moved)), a.fullByRef, 3).parsed.elements[1].ref).toBe('@e4');
  });
});

describe('settle fingerprint + Android fast accept', () => {
  const clockScreen = (t: string, extra: NodeSpec[] = []) =>
    dump([
      { cls: 'android.widget.TextView', text: t, bounds: [0, 0, 200, 50], clickable: false },
      { text: 'OK', id: 'com.example.app:id/ok', bounds: [40, 300, 1040, 360] },
      ...extra,
    ]);

  it('a ticking clock does not keep the screen unsettled', async () => {
    const fake = new FakeDriver(clockScreen('12:00'));
    let n = 0;
    fake.dumpXml = async () => clockScreen(`12:${String(n++ % 60).padStart(2, '0')}`);
    const s = await settle(fake, { timeoutMs: 3000, stableForMs: 150, intervalMs: 30 });
    expect(s.settled).toBe(true);
    expect(s.parsed?.elements.length).toBe(2);
  });

  it('accepts the first differing, non-busy dump on the direct driver', async () => {
    const pre = screenFingerprint(parseSnapshot(clockScreen('Before')).fullByRef.values());
    const fake = new FakeDriver(clockScreen('After'));
    const s = await settle(fake, { timeoutMs: 3000, preFingerprint: pre });
    expect(s).toMatchObject({ settled: true, fastAccepted: true });
    expect(dumps(fake)).toBe(1);
  });

  it('keeps the 2-dump confirm when the first dump equals pre, shows a spinner, or the driver is not direct', async () => {
    const pre = screenFingerprint(parseSnapshot(clockScreen('Same')).fullByRef.values());
    const same = new FakeDriver(clockScreen('Same'));
    expect((await settle(same, { timeoutMs: 3000, stableForMs: 50, intervalMs: 20, preFingerprint: pre })).fastAccepted).toBeUndefined();
    expect(dumps(same)).toBeGreaterThan(1);

    const busyXml = clockScreen('After', [{ cls: 'android.widget.ProgressBar', bounds: [500, 500, 600, 600], clickable: false }]);
    expect(looksBusy(parseSnapshot(busyXml).allNodes)).toBe(true);
    const busy = new FakeDriver(busyXml);
    expect((await settle(busy, { timeoutMs: 3000, stableForMs: 50, intervalMs: 20, preFingerprint: pre })).fastAccepted).toBeUndefined();

    const wda = new FakeDriver(clockScreen('After'));
    Object.defineProperty(wda, 'kind', { value: 'wda' });
    expect((await settle(wda, { timeoutMs: 3000, stableForMs: 50, intervalMs: 20, preFingerprint: pre })).fastAccepted).toBeUndefined();
  });
});

describe('resolveTarget', () => {
  it('a fresh snapshot is trusted; a stale ref is re-found (moved → refMoved) or STALE_REF with candidates', async () => {
    const xml = buttonScreen('Home', 3);
    const fake = new FakeDriver(xml);
    const { session } = newSession(fake);
    adoptSnapshot(session, parseSnapshot(xml));
    expect(freshSnapshot(session, REF_FRESH_MS)).toBeDefined();
    const fresh = await resolveTarget(session, { ref: '@e2' });
    expect(fresh).toMatchObject({ ref: '@e2', y: 223 });
    expect(dumps(fake)).toBe(0);

    // an action since the snapshot makes it stale: re-dump, same node 30 px lower
    noteScreenMutation(session);
    fake.xml = xml.replace('[40,200][1040,245]', '[40,230][1040,275]');
    const moved = await resolveTarget(session, { ref: '@e2' });
    expect(moved).toMatchObject({ ref: '@e2', y: 253, refMoved: true });
    expect(dumps(fake)).toBe(1);

    // gone: STALE_REF + look-alike candidates
    session.lastSnapshot!.at = Date.now() - 5000;
    fake.xml = buttonScreen('Home', 3).replace('Home item 0', 'Other');
    const gone = await resolveTarget(session, { ref: '@e2' });
    expect(gone).toMatchObject({ failureCode: 'STALE_REF' });
    expect('error' in gone && gone.error).toMatch(/no longer on screen/);
    expect('candidates' in gone && gone.candidates?.length).toBeGreaterThan(0);
  });

  it('text/id targets reuse a just-settled snapshot (no dump) and waitMs polls until the element appears', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 2));
    const { session } = newSession(fake);
    adoptSnapshot(session, parseSnapshot(fake.xml));
    expect(await resolveTarget(session, { text: 'Home item 1' })).toMatchObject({ x: 540 });
    expect(dumps(fake)).toBe(0);

    let n = 0;
    fake.dumpXml = async () => {
      fake.rec('dumpXml');
      return ++n >= 3 ? buttonScreen('Late', 1) : buttonScreen('Home', 2);
    };
    expect(await resolveTarget(session, { text: 'Late item 0' })).toHaveProperty('error'); // waitMs 0: one fresh dump
    n = 0;
    const found = await resolveTarget(session, { text: 'Late item 0' }, { waitMs: 3000 });
    expect(found).toMatchObject({ x: 540 });
    expect(n).toBe(3);
  });
});

describe('qa_act / qa_snapshot / qa_inspect (MCP)', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness('precision');
  });
  afterAll(async () => {
    await h.close();
  });
  const act = async (id: string, args: Record<string, unknown>) => structured(await h.call('qa_act', { sessionId: id, ...args }));

  it('wait for:{text, gone:true} returns once the element disappears', async () => {
    const fake = new FakeDriver(buttonScreen('Spinner', 1));
    const id = await h.start(fake);
    let n = 0;
    fake.dumpXml = async () => (++n >= 2 ? buttonScreen('Done', 1) : buttonScreen('Spinner', 1));
    const s = await act(id, { action: 'wait', for: { text: 'Spinner item 0', gone: true }, timeoutMs: 5000 });
    expect(s).toMatchObject({ ok: true, gone: true });
  }, 20_000);

  it('same hierarchy but changed pixels on an unlabeled target is a change (no press retry)', async () => {
    const xml = dump([
      { cls: 'android.widget.TextView', text: 'Canvas', bounds: [0, 0, 1080, 90], clickable: false },
      { cls: 'android.view.View', bounds: [100, 400, 900, 900] },
      { text: 'Other', id: 'com.example.app:id/o', bounds: [40, 1000, 1040, 1060] },
    ]);
    const fake = new FakeDriver(xml);
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    let tapped = false;
    fake.onTap = () => (tapped = true);
    fake.screenshot = async () => makePng(32, tapped ? [0, 0, 255] : [255, 0, 0]);
    const s = await act(id, { action: 'tap', target: { ref: '@e2' } });
    expect(s).toMatchObject({ changed: true, pixelChanged: true, retriedAsPress: false });
  }, 20_000);

  it('diff on the same screen returns only the changes; a new screen returns the full list', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 6));
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    fake.xml = buttonScreen('Home', 7).replace('Home item 0', 'Home item zero');
    const small = structured(await h.call('qa_snapshot', { sessionId: id, diff: true }));
    expect(small.elements).toBeUndefined();
    const diff = small.diff as {
      added: string[];
      removed: string[];
      changed: string[];
      counts: Record<string, number>;
      bigChange: boolean;
    };
    expect(diff.counts).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(diff.changed[0]).toMatch(/^@e2 .*Home item zero/);
    expect(diff.bigChange).toBe(false);

    fake.xml = buttonScreen('Settings', 6);
    const big = structured(await h.call('qa_snapshot', { sessionId: id, diff: true }));
    expect((big.elements as unknown[]).length).toBe(7);
    expect(big.diff).toMatchObject({ bigChange: true });
  }, 20_000);

  it('qa_inspect attrs carry only keys not already top-level; weak tree hint', async () => {
    const fake = new FakeDriver(
      dump([{ text: 'Only', id: 'com.example.app:id/only', bounds: [40, 300, 1040, 360], extra: 'checkable="true"' }]),
    );
    const id = await h.start(fake);
    const snap = structured(await h.call('qa_snapshot', { sessionId: id }));
    expect(String(snap.treeHint)).toMatch(/qa_screenshot/);
    const ins = structured(await h.call('qa_inspect', { sessionId: id, ref: '@e1' }));
    const attrs = ins.attrs as Record<string, string>;
    expect(attrs.checkable).toBe('true');
    expect(attrs.text).toBeUndefined();
    expect(attrs.bounds).toBeUndefined();
    expect(ins.text).toBe('Only');
  }, 20_000);
});

describe('flows: tap wait + IME wait', () => {
  const flowOf = (steps: FlowStep[]): Flow =>
    ({ name: 'precision', appId: 'com.example.app', mode: 'structured', fixtures: [], setup: [], teardown: [], steps }) as Flow;

  it('a flow tap waits for its target; inputText into proceeds as soon as the keyboard is up', async () => {
    const fake = new FakeDriver(buttonScreen('Loading', 1));
    const { sessions, session } = newSession(fake);
    let n = 0;
    fake.dumpXml = async () => {
      fake.rec('dumpXml');
      return ++n >= 3 ? buttonScreen('Ready', 2) : buttonScreen('Loading', 1);
    };
    fake.ime = true;
    const started = Date.now();
    const r = await runFlow(
      sessions,
      session,
      fake,
      flowOf([
        { kind: 'tap', selector: 'Ready item 0' },
        { kind: 'inputText', into: 'Ready item 1', value: 'hello' },
      ] as FlowStep[]),
    );
    expect(r.passed, JSON.stringify(r.steps)).toBe(true);
    expect(fake.got('inputText').map((c) => c.a[0])).toEqual(['hello']);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);
});
