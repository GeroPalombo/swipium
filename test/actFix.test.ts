// Pre-launch qa_act / qa_snapshot fixes (fake driver, handler level):
//  #2  observe:"diff" falls back to the capped full list + removedCount on a mostly-new screen
//  #6  keyboard guard: one imeState() round trip instead of imeShown + imeFrame
//  #7  scroll untilVisible seeds the post-action settle with its last probe dump
//  #8  the MCP call's AbortSignal reaches the driver (and is restored afterwards)
//  #9  a Switch/Checkbox toggle is a change (no press retry that toggles it back)
//  #12 ${SWIPIUM_*} placeholders expand for typing and are what gets recorded
//  #13 untilVisible only counts a match whose center is on screen / not under the keyboard
//  #14 unknown session → typed INVALID_ARGUMENT (qa_act / qa_snapshot / qa_inspect)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buttonScreen, dump, FakeDriver, harness, structured, textOf, type NodeSpec } from './actFixFake.js';
import { expandInputPlaceholders, recordableTypedText } from '../src/tools/act.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('act-fix');
});
afterAll(async () => {
  delete process.env.SWIPIUM_TEST_EMAIL;
  await h.close();
});

async function act(id: string, args: Record<string, unknown>) {
  return structured(await h.call('qa_act', { sessionId: id, ...args }));
}

describe('#2 observe diff → full fallback', () => {
  it('navigation to a mostly-new screen returns the full list + removedCount, not every removal', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 31));
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    fake.onTap = () => (fake.xml = buttonScreen('Details', 31));
    const s = await act(id, { action: 'tap', target: { text: 'Home item 2' } });
    expect(s.observe).toBe('diff');
    expect(s.diffAsFull).toBe(true);
    expect((s.elements as unknown[]).length).toBe(32);
    expect(s.removedCount).toBe(32);
    expect(s.removed).toBeUndefined();
  }, 20_000);

  it('a small change keeps the regular diff', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 31));
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    fake.onTap = () => (fake.xml = buttonScreen('Home', 32));
    const s = await act(id, { action: 'tap', target: { text: 'Home item 2' } });
    expect(s.diffAsFull).toBeUndefined();
    expect((s.elements as unknown[]).length).toBe(1);
    expect(s.removed).toEqual([]);
  }, 20_000);
});

describe('#9 toggle detection', () => {
  const sw = (checked: boolean) =>
    dump([
      { cls: 'android.widget.TextView', text: 'Settings', bounds: [40, 100, 1040, 180], clickable: false },
      {
        cls: 'android.widget.Switch',
        text: 'Wi-Fi',
        id: 'com.example.app:id/wifi',
        bounds: [40, 200, 1040, 300],
        extra: `checkable="true" checked="${checked}"`,
      },
    ]).replace(/checked="false" selected="false" bounds="\[40,200\]\[1040,300\]"/, 'selected="false" bounds="[40,200][1040,300]"');

  it('a Switch flip is changed=true and is NOT retried as a press (which would flip it back)', async () => {
    const fake = new FakeDriver(sw(false));
    const id = await h.start(fake);
    const snap = structured(await h.call('qa_snapshot', { sessionId: id }));
    const ref = (snap.elements as Array<{ ref: string; text?: string }>).find((e) => e.text === 'Wi-Fi')!.ref;
    let on = false;
    fake.onTap = () => {
      on = !on;
      fake.xml = sw(on);
    };
    const res = await h.call('qa_act', { sessionId: id, action: 'tap', target: { ref } });
    const s = structured(res);
    expect(s.changed).toBe(true);
    expect(s.retriedAsPress).toBe(false);
    expect(fake.got('pressXY')).toHaveLength(0);
    expect(on).toBe(true);
    expect((s.stateChanged as string[])[0]).toContain('checked=true');
    expect(textOf(res)).toContain('state changed:');
  }, 20_000);
});

describe('#12 ${SWIPIUM_*} placeholders', () => {
  const form = () =>
    dump([
      { cls: 'android.widget.TextView', text: 'Login', bounds: [40, 100, 1040, 180], clickable: false },
      { cls: 'android.widget.EditText', desc: 'Email', id: 'com.example.app:id/email', bounds: [40, 200, 1040, 280] },
    ]);

  it('expands from the env, types the value, records the placeholder, never echoes the value', async () => {
    process.env.SWIPIUM_TEST_EMAIL = 'qa.person@example.com';
    const fake = new FakeDriver(form());
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    const res = await h.call('qa_act', { sessionId: id, action: 'type', target: { id: 'email' }, text: '${SWIPIUM_TEST_EMAIL}' });
    const s = structured(res);
    expect(s.ok).toBe(true);
    expect(s.placeholders).toEqual(['SWIPIUM_TEST_EMAIL']);
    expect(fake.got('inputText')[0].a).toEqual(['qa.person@example.com']);
    expect(JSON.stringify(res)).not.toContain('qa.person@example.com');
    const rec = h.sessions.get(id)!.recordedActions.at(-1)!;
    expect(rec.text).toBe('${SWIPIUM_TEST_EMAIL}');
  }, 20_000);

  it('a literal equal to a stored (non-secret) session input is recorded as its placeholder', async () => {
    const fake = new FakeDriver(form());
    const id = await h.start(fake);
    const session = h.sessions.get(id)!;
    h.sessions.setInput(session, 'SWIPIUM_TEST_EMAIL', 'stored@example.com', false, 'test');
    await h.call('qa_snapshot', { sessionId: id });
    await act(id, { action: 'type', target: { id: 'email' }, text: 'stored@example.com' });
    expect(fake.got('inputText')[0].a).toEqual(['stored@example.com']);
    expect(session.recordedActions.at(-1)!.text).toBe('${SWIPIUM_TEST_EMAIL}');
  }, 20_000);

  it('an unresolvable placeholder is MISSING_TEST_DATA and nothing is tapped or typed', async () => {
    const fake = new FakeDriver(form());
    const id = await h.start(fake);
    const s = await act(id, { action: 'type', target: { id: 'email' }, text: '${SWIPIUM_NOPE_VALUE}' });
    expect(s.ok).toBe(false);
    expect(s.failureCode).toBe('MISSING_TEST_DATA');
    expect(fake.got('tapXY')).toHaveLength(0);
    expect(fake.got('inputText')).toHaveLength(0);
  }, 20_000);

  it('PURE: only SWIPIUM_ names expand; secret inputs and secret-looking env names are flagged', () => {
    const values = new Map([['SWIPIUM_TEST_PASSWORD', 'pw-123']]);
    const r = expandInputPlaceholders(
      'a ${SWIPIUM_TEST_PASSWORD} ${HOME} ${SWIPIUM_API_TOKEN}',
      { values, secretVars: new Set(['SWIPIUM_TEST_PASSWORD']) },
      { SWIPIUM_API_TOKEN: 'tok', HOME: '/x' },
    );
    expect(r.text).toBe('a pw-123 ${HOME} tok');
    expect(r.vars).toEqual(['SWIPIUM_TEST_PASSWORD', 'SWIPIUM_API_TOKEN']);
    expect(r.secretValues).toEqual(['pw-123', 'tok']);
    expect(recordableTypedText('x', 'pw-123', [], values)).toBe('${SWIPIUM_TEST_PASSWORD}');
    expect(recordableTypedText('plain', 'plain', [], values)).toBe('plain');
  });
});

describe('#13 scroll untilVisible requires an on-screen, uncovered center', () => {
  const list = (targetTop: number): string => {
    const nodes: NodeSpec[] = [
      { cls: 'androidx.recyclerview.widget.RecyclerView', bounds: [0, 0, 1080, 1920], clickable: false, extra: 'scrollable="true"' },
    ];
    for (let i = 0; i < 5; i++) nodes.push({ text: `Row ${i}`, bounds: [40, 200 + i * 200, 1040, 380 + i * 200] });
    nodes.push({ text: 'Target row', bounds: [40, targetTop, 1040, targetTop + 200] });
    return dump(nodes);
  };

  it('a row crossing the bottom edge (center off-screen) is not "found" — one more swipe', async () => {
    const fake = new FakeDriver(list(1850)); // 1850..2050: center y=1950 > 1920
    const id = await h.start(fake);
    fake.onSwipe = () => (fake.xml = list(1400));
    const s = await act(id, { action: 'scroll', direction: 'down', untilVisible: { text: 'Target row' } });
    expect(s.untilVisibleFound).toBe(true);
    expect(s.swipes).toBe(1);
  }, 20_000);

  it('a match whose center is under a known keyboard frame is not "found" either', async () => {
    const fake = new FakeDriver(list(1300)); // center y=1400
    fake.ime = true;
    fake.imeRect = [0, 1200, 1080, 1920];
    const id = await h.start(fake);
    fake.onSwipe = () => (fake.xml = list(800));
    const s = await act(id, { action: 'scroll', direction: 'down', untilVisible: { text: 'Target row' } });
    expect(s.swipes).toBe(1);
    expect(s.untilVisibleFound).toBe(true);
  }, 20_000);

  it('#7 the post-action settle is seeded with the last probe (one dump fewer)', async () => {
    const fake = new FakeDriver(list(1850));
    const id = await h.start(fake);
    fake.onSwipe = () => (fake.xml = list(1400));
    fake.calls = [];
    await act(id, { action: 'scroll', direction: 'down', untilVisible: { text: 'Target row' } });
    // 2 probes (before + after the swipe) + 2 settle dumps (was 3 without the seed)
    expect(fake.got('dumpXml')).toHaveLength(4);
  }, 20_000);
});

describe('#6 keyboard guard uses one imeState() call', () => {
  it('a ref tap with the keyboard hidden asks imeState once and never imeShown/imeFrame', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const snap = structured(await h.call('qa_snapshot', { sessionId: id }));
    const ref = (snap.elements as Array<{ ref: string }>)[1].ref;
    fake.calls = [];
    fake.onTap = () => (fake.xml = buttonScreen('Next', 3));
    await act(id, { action: 'tap', target: { ref } });
    expect(fake.got('imeState')).toHaveLength(1);
    expect(fake.got('imeShown')).toHaveLength(0);
    expect(fake.got('imeFrame')).toHaveLength(0);
  }, 20_000);
});

describe('#4 health skips dumpsys when the dump root is the app', () => {
  it('qa_act on the app under test never calls foregroundOwner; a foreign root still does', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    fake.calls = [];
    fake.onTap = () => (fake.xml = buttonScreen('Next', 3));
    const s = await act(id, { action: 'tap', target: { text: 'Home item 1' } });
    expect(fake.got('foregroundOwner')).toHaveLength(0);
    expect((s.health as { foreground: string }).foreground).toBe('com.example.app');
    fake.onTap = () => (fake.xml = buttonScreen('Perm', 3, 'com.google.android.permissioncontroller'));
    fake.calls = [];
    await act(id, { action: 'tap', target: { text: 'Next item 1' } });
    expect(fake.got('foregroundOwner')).toHaveLength(1);
  }, 20_000);
});

describe('#8 cancellation reaches the driver', () => {
  it('binds the call signal during qa_act and restores the previous binding afterwards', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const jobSignal = new AbortController().signal;
    fake.setSignal(jobSignal);
    fake.signalsSeen = [];
    await act(id, { action: 'tap', target: { x: 10, y: 10 } });
    expect(fake.signalsSeen[0]).toBeInstanceOf(AbortSignal);
    expect(fake.signalsSeen[0]).not.toBe(jobSignal);
    expect(fake.signal).toBe(jobSignal); // restored
    fake.signalsSeen = [];
    await h.call('qa_snapshot', { sessionId: id });
    expect(fake.signalsSeen[0]).toBeInstanceOf(AbortSignal);
    expect(fake.signal).toBe(jobSignal);
  }, 20_000);

  it('an MCP cancel aborts the in-flight driver call', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    fake.hangTap = true;
    const ctl = new AbortController();
    const p = h.client.callTool({ name: 'qa_act', arguments: { sessionId: id, action: 'tap', target: { x: 5, y: 5 } } }, undefined, {
      signal: ctl.signal,
    });
    setTimeout(() => ctl.abort('user cancelled'), 150);
    await expect(p).rejects.toBeTruthy();
    for (let i = 0; i < 50 && !fake.got('pressXY').length; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.abortedDuringTap).toBe(true);
  }, 20_000);
});

describe('#14 typed session errors', () => {
  it('unknown sessionId is INVALID_ARGUMENT for qa_act, qa_snapshot and qa_inspect', async () => {
    for (const [tool, args] of [
      ['qa_act', { action: 'tap', target: { x: 1, y: 1 } }],
      ['qa_snapshot', {}],
      ['qa_inspect', { ref: '@e1' }],
    ] as const) {
      const res = (await h.call(tool, { sessionId: 'nope', ...args })) as CallToolResult;
      expect(structured(res).failureCode, tool).toBe('INVALID_ARGUMENT');
    }
  });

  it('a missing ref in qa_inspect is STALE_REF', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    expect(structured(await h.call('qa_inspect', { sessionId: id, ref: '@e99' })).failureCode).toBe('STALE_REF');
  });
});
