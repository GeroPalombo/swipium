// Item 1 (tokens): the normal-mode text channel used to repeat the WHOLE payload as indented
// JSON on top of the rendered @eN lines (qa_snapshot 32 elements = 8.6K chars, 7.3K of it fence).
// The fence is now compact and leaves out keys the summary already rendered; structuredContent
// stays complete, and verbose mode keeps everything.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buttonScreen, FakeDriver, harness, structured, textOf } from './actFixFake.js';
import { qaOk, runWithResponseMode } from '../src/lib/result.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('result-size');
});
afterAll(async () => {
  await h.close();
});

function fenceOf(text: string): Record<string, unknown> {
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  expect(m, text).toBeTruthy();
  return JSON.parse(m![1]) as Record<string, unknown>;
}

describe('result text size (normal mode)', () => {
  it('qa_snapshot with 32 elements renders < 4K chars; structuredContent keeps every element', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Details', 31)));
    const res = await h.call('qa_snapshot', { sessionId: id });
    const text = textOf(res);
    expect(text.length).toBeLessThan(4000); // was 8598 (7273 of it the indented fence)
    const s = structured(res);
    expect((s.elements as unknown[]).length).toBe(32);
    const fence = fenceOf(text);
    expect(fence.elements).toBeUndefined();
    expect(fence.renderedAbove).toEqual(['elements']);
    expect(fence.elementCount).toBe(32);
    expect(text).not.toMatch(/```json\n\{\n {2}"/); // no indentation
    expect(text).toContain('@e32 [button] "Details item 30"');
  });

  it('qa_act navigation result stays small (full-list fallback, no duplicate element JSON)', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 31));
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    fake.onTap = () => (fake.xml = buttonScreen('Details', 31));
    const res = await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'Home item 3' } });
    const text = textOf(res);
    expect(structured(res).ok).toBe(true);
    expect(text.length).toBeLessThan(4500); // was 10736
    expect(fenceOf(text).elements).toBeUndefined();
  });

  it('verbose keeps the full payload in the fence; compact has no fence', () => {
    const payload = { elements: [{ ref: '@e1' }], elementCount: 1 };
    const verbose = runWithResponseMode('verbose', () => qaOk(payload, 'sum', { textOmit: ['elements'] }));
    expect(fenceOf(textOf(verbose)).elements).toEqual([{ ref: '@e1' }]);
    const compact = runWithResponseMode('compact', () => qaOk(payload, 'sum', { textOmit: ['elements'] }));
    expect(textOf(compact)).toBe('sum');
    const normal = runWithResponseMode('normal', () => qaOk(payload, 'sum', { textOmit: ['elements'] }));
    expect(normal.structuredContent).toEqual({ ok: true, ...payload });
  });
});
