// Element lists in structuredContent are one-line @eN strings (the same lines the text block
// renders), not one JSON object per element. Claude Code and Codex show the model structuredContent,
// so this is what the model reads. responseMode "verbose" keeps the full objects.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buttonScreen, dump, elementsOf, FakeDriver, harness, structured, textOf, type NodeSpec } from './actFixFake.js';
import { ELEMENT_LINE_MAX_LABEL_CHARS, parseElementLine, renderElementLine } from '../src/snapshot/parse.js';
import { presentElements } from '../src/snapshot/present.js';
import { makeRedactor } from '../src/lib/redact.js';
import { runWithResponseMode } from '../src/lib/result.js';
import type { SnapshotElement } from '../src/drivers/Driver.js';

const el = (over: Partial<SnapshotElement>): SnapshotElement => ({
  ref: '@e1',
  role: 'button',
  clickable: true,
  bounds: [40, 200, 1040, 245],
  ...over,
});

describe('renderElementLine', () => {
  it('carries ref, role, name, id, bounds and flags on one line', () => {
    expect(renderElementLine(el({ ref: '@e3', text: 'Log in', id: 'login_btn' }))).toBe(
      '@e3 [button] "Log in" #login_btn [40,200][1040,245]',
    );
    expect(renderElementLine(el({ role: 'text-field', label: 'Email', focused: true }))).toBe(
      '@e1 [text-field] "Email" [40,200][1040,245] (focused)',
    );
    expect(renderElementLine(el({ role: 'text', text: 'Hi', clickable: false, bounds: [0, 0, 0, 0] }))).toBe(
      '@e1 [text] "Hi" (non-clickable)',
    );
    expect(renderElementLine(el({ role: 'text-field', label: '«secure»', text: '«secure»', secure: true }))).toBe(
      '@e1 [text-field] "«secure»" [40,200][1040,245] (secure)',
    );
  });

  it('adds text="..." only when it differs from the label; quotes ids that are not plain tokens', () => {
    expect(renderElementLine(el({ label: 'Cart', text: '3 items', id: 'Cart Button' }))).toBe(
      '@e1 [button] "Cart" #"Cart Button" text="3 items" [40,200][1040,245]',
    );
    expect(renderElementLine(el({ label: 'Same', text: 'Same' }))).not.toContain('text=');
    expect(renderElementLine(el({}))).toBe('@e1 [button] "" [40,200][1040,245]');
  });

  it('escapes quotes, backslashes and newlines, and caps long labels', () => {
    const tricky = 'Say "hi"\nnext line \\ (done) [x] #y';
    const line = renderElementLine(el({ label: tricky, id: 'a' }));
    expect(line).not.toContain('\n');
    expect(parseElementLine(line)?.name).toBe(tricky);

    const long = 'x'.repeat(500);
    const capped = renderElementLine(el({ text: long }));
    expect(parseElementLine(capped)?.name).toBe(`${'x'.repeat(ELEMENT_LINE_MAX_LABEL_CHARS)}...`);
    expect(capped.length).toBeLessThan(ELEMENT_LINE_MAX_LABEL_CHARS + 60);
  });

  it('round-trips through parseElementLine', () => {
    const e = el({ ref: '@e12', role: 'scrollable', label: 'List', text: 'Rows', id: 'com.x:id/list', focused: true, clickable: false });
    expect(parseElementLine(renderElementLine(e))).toEqual({
      ref: '@e12',
      role: 'scrollable',
      name: 'List',
      id: 'com.x:id/list',
      text: 'Rows',
      bounds: [40, 200, 1040, 245],
      clickable: false,
      focused: true,
      secure: false,
    });
    expect(parseElementLine('not a line')).toBeUndefined();
  });
});

describe('presentElements payload', () => {
  const secret = 'Zq7!sEcr3t#Pw';
  const redact = makeRedactor([secret]);

  it('lines outside verbose, objects in verbose', () => {
    const els = [el({ text: 'OK' })];
    const normal = presentElements(els, redact);
    expect(normal.payload).toEqual(['@e1 [button] "OK" [40,200][1040,245]']);
    expect(normal.rendered).toBe(normal.lines.join('\n'));
    const compact = runWithResponseMode('compact', () => presentElements(els, redact));
    expect(compact.payload).toEqual(normal.lines);
    const verbose = runWithResponseMode('verbose', () => presentElements(els, redact));
    expect(verbose.payload).toEqual([expect.objectContaining({ ref: '@e1', text: 'OK', bounds: [40, 200, 1040, 245] })]);
  });

  it('redacts before encoding: known secrets and secure values never reach a line, even across the cap', () => {
    const { lines } = presentElements(
      [
        el({ ref: '@e1', role: 'text', text: `Welcome ${secret}`, clickable: false }),
        el({ ref: '@e2', role: 'text-field', label: 'Password', text: secret, secure: true }),
        // the secret straddles the label cap: it must be redacted before the cut, not cut in half
        el({ ref: '@e3', label: `${'a'.repeat(ELEMENT_LINE_MAX_LABEL_CHARS - 5)}${secret}` }),
        el({ ref: '@e4', label: 'Show password', secure: true }),
      ],
      redact,
    );
    const all = lines.join('\n');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('Zq7!s');
    expect(lines[0]).toContain('«redacted»');
    expect(lines[1]).toBe('@e2 [text-field] "«secure»" [40,200][1040,245] (secure)');
    expect(lines[3]).toContain('"Show password"');
  });
});

describe('through the server', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness('element-lines');
  });
  afterAll(async () => {
    await h.close();
  });

  it('qa_snapshot: structured elements are the same lines as the text block, which has no JSON copy of them', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    const res = await h.call('qa_snapshot', { sessionId: id });
    const s = structured(res);
    const lines = s.elements as string[];
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('@e2 [button] "Home item 0" #home_0 [40,200][1040,245]');
    const text = textOf(res);
    for (const l of lines) expect(text.split(l).length - 1, l).toBe(1); // rendered once
    expect(text).toContain('"renderedAbove":["elements"]');
    expect(elementsOf(s).map((e) => e.ref)).toEqual(['@e1', '@e2', '@e3', '@e4']);
  });

  it('qa_snapshot redacts session secrets in the encoded lines', async () => {
    const secret = 'Zq7!sEcr3t#Pw';
    const xml = dump([
      { cls: 'android.widget.TextView', text: `Hello ${secret}`, bounds: [40, 100, 1040, 180], clickable: false },
      { cls: 'android.widget.EditText', text: secret, id: 'com.example.app:id/pw', bounds: [40, 200, 1040, 280], extra: 'password="true"' },
    ]);
    const id = await h.start(new FakeDriver(xml));
    h.sessions.get(id)!.secrets.add(secret);
    const res = await h.call('qa_snapshot', { sessionId: id });
    expect(JSON.stringify(res)).not.toContain(secret);
    const els = elementsOf(structured(res));
    expect(els[1]).toMatchObject({ name: '«secure»', secure: true, id: 'pw' });
  });

  it('responseMode verbose keeps full element objects (qa_snapshot and qa_act)', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 3));
    const id = await h.start(fake, { responseMode: 'verbose' });
    const snap = structured(await h.call('qa_snapshot', { sessionId: id }));
    const objs = snap.elements as SnapshotElement[];
    expect(objs[1]).toMatchObject({ ref: '@e2', role: 'button', text: 'Home item 0', id: 'home_0', bounds: [40, 200, 1040, 245] });
    fake.onTap = () => (fake.xml = buttonScreen('Details', 3));
    const act = structured(await h.call('qa_act', { sessionId: id, action: 'tap', target: { ref: '@e2' } }));
    expect((act.elements as SnapshotElement[])[0]).toMatchObject({ ref: '@e1', text: 'Details' });
  }, 20_000);

  it('qa_act returns lines too (full-list fallback after navigation)', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    fake.onTap = () => (fake.xml = buttonScreen('Details', 3));
    const s = structured(await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'Home item 1' } }));
    expect(s.diffAsFull).toBe(true);
    expect(elementsOf(s).map((e) => e.name)).toEqual(['Details', 'Details item 0', 'Details item 1', 'Details item 2']);
  }, 20_000);

  it('size: qa_snapshot with 40 elements shrinks elements by >= 40% and structuredContent by >= 38%', async () => {
    // 40 on-screen elements, two columns: a title, text buttons with ids, icon buttons with a
    // content-desc, and a text field.
    const nodes: NodeSpec[] = [{ cls: 'android.widget.TextView', text: 'Settings', bounds: [40, 100, 1040, 180], clickable: false }];
    for (let i = 0; i < 38; i++) {
      const x = i % 2 ? 560 : 40;
      const y = 200 + Math.floor(i / 2) * 80;
      nodes.push(
        i % 3 === 0
          ? { cls: 'android.widget.ImageButton', desc: `Open item ${i}`, bounds: [x, y, x + 480, y + 60] }
          : { text: `Setting option ${i}`, id: `com.example.app:id/option_${i}`, bounds: [x, y, x + 480, y + 60] },
      );
    }
    nodes.push({
      cls: 'android.widget.EditText',
      desc: 'Search settings',
      id: 'com.example.app:id/search',
      bounds: [40, 1760, 1040, 1840],
    });
    const xml = dump(nodes);
    const normal = structured(await h.call('qa_snapshot', { sessionId: await h.start(new FakeDriver(xml)) }));
    const verbose = structured(await h.call('qa_snapshot', { sessionId: await h.start(new FakeDriver(xml), { responseMode: 'verbose' }) }));
    expect((normal.elements as unknown[]).length).toBe(40);
    const size = (v: unknown) => JSON.stringify(v).length;
    // Measured at 2.1.2: elements 4474 > 2519 chars (-43.7%), structuredContent 4865 > 2910 (-40.2%).
    // The rest of the payload (quality signals, overlays, summary) is the same in both modes.
    expect(size(normal.elements)).toBeLessThanOrEqual(size(verbose.elements) * 0.6);
    expect(size(normal)).toBeLessThanOrEqual(size(verbose) * 0.62);
  });
});
