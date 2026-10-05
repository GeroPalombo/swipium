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
  it('qa_snapshot with 32 elements renders < 4K chars; structuredContent keeps every element (as @eN lines)', async () => {
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
    expect(normal.structuredContent).toEqual({ summary: 'sum', ok: true, ...payload });
  });
});

describe('error size cap', () => {
  it('caps an echoed multi-MB `what`, keeping the head AND the tail (where exit codes live)', async () => {
    const { qaError, MAX_ERROR_WHAT_CHARS } = await import('../src/lib/result.js');
    const r = qaError({
      what: `Unknown artifact ${'a'.repeat(4_000_000)} exit 1: INSTALL_FAILED_UPDATE_INCOMPATIBLE`,
      changedState: false,
      retrySafe: true,
      nextSteps: [],
    });
    expect(JSON.stringify(r).length).toBeLessThan(MAX_ERROR_WHAT_CHARS * 4);
    const what = String((r.structuredContent as { what: string }).what);
    expect(what.startsWith('Unknown artifact aaa')).toBe(true);
    expect(what).toMatch(/ \.\.\. \[\d+ chars cut\] \.\.\. /);
    expect(what.endsWith('exit 1: INSTALL_FAILED_UPDATE_INCOMPATIBLE')).toBe(true);
  });

  it('caps nextSteps, clientHint and every string inside extra (nested, arrays); drops extra over 64 KB', async () => {
    const { qaError, MAX_ERROR_PAYLOAD_CHARS } = await import('../src/lib/result.js');
    const big = 'k'.repeat(2_000_000);
    const r = qaError(
      { what: 'x', changedState: false, retrySafe: true, nextSteps: [big, ...Array.from({ length: 100 }, () => 'step')], clientHint: big },
      { echoed: big, nested: { list: [big, { deeper: big }] }, when: new Date(0) },
    );
    const sc = r.structuredContent as Record<string, unknown>;
    expect(JSON.stringify(r).length).toBeLessThan(80_000);
    expect((sc.nextSteps as string[]).length).toBe(20);
    expect((sc.nextSteps as string[])[0].length).toBeLessThan(2100);
    expect(String(sc.clientHint).length).toBeLessThan(2100);
    expect(String(sc.echoed).length).toBeLessThan(8100);
    expect(sc.when).toBe('1970-01-01T00:00:00.000Z');
    const nested = sc.nested as { list: [string, { deeper: string }] };
    expect(nested.list[0].length).toBeLessThan(8100);
    expect(nested.list[1].deeper.length).toBeLessThan(8100);

    // Many capped fields can still add up: the safety net drops extra and says so.
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, big]));
    const d = qaError({ what: 'x', changedState: false, retrySafe: true, nextSteps: [] }, many);
    const ds = d.structuredContent as Record<string, unknown>;
    expect(JSON.stringify(ds).length).toBeLessThan(MAX_ERROR_PAYLOAD_CHARS);
    expect(ds.f0).toBeUndefined();
    expect((ds.extraDropped as string[]).length).toBe(40);
    expect(String(ds.extraDroppedNote)).toMatch(/dropped/);
  });
});

// structuredContent is what Claude Code / Codex show the model. 2.2.0 added `summary` + `next` to
// it; the default `headline` summary (first line) and skipping `next` when the payload has its own
// guidance keep the growth vs the bare payload (2.1.1) small. HEAD size = current minus the
// summary/next copies. Measured before this cap: qa_status (no session) +32%, qa_status (session)
// +46-66%, qa_act tap +17%, qa_doctor +15%, qa_report +32-35%, qa_snapshot +13%.
describe('structuredContent growth from summary/next stays small', () => {
  const growth = (r: Awaited<ReturnType<typeof h.call>>) => {
    const s = structured(r);
    const cur = JSON.stringify(s).length;
    const rest = { ...s };
    if (typeof rest.summary === 'string') delete rest.summary;
    if (Array.isArray(rest.next) && rest.next.every((x) => typeof x === 'string')) delete rest.next;
    const head = JSON.stringify(rest).length;
    return (cur - head) / head;
  };

  it('qa_status, qa_snapshot, qa_act, qa_doctor, qa_report: < 15% each', async () => {
    const out: Record<string, number> = {};
    out.statusNoSession = growth(await h.call('qa_status', {}));
    const fake = new FakeDriver(buttonScreen('Home', 5));
    // verbose: element lists as full objects, the payload base this 15% cap was set against. Outside
    // verbose the elements are one-line strings (~40% smaller payload), so the same summary/next
    // bytes are a larger share without having grown.
    const id = await h.start(fake, { responseMode: 'verbose' });
    out.statusSession = growth(await h.call('qa_status', { sessionId: id }));
    out.snapshot = growth(await h.call('qa_snapshot', { sessionId: id }));
    fake.onTap = () => (fake.xml = buttonScreen('Details', 5));
    out.actTap = growth(await h.call('qa_act', { sessionId: id, action: 'tap', target: { text: 'Home item 3' } }));
    out.doctor = growth(await h.call('qa_doctor', {}));
    out.report = growth(await h.call('qa_report', { sessionId: id }));
    for (const [k, v] of Object.entries(out)) expect(v, `${k} grew ${(v * 100).toFixed(1)}%`).toBeLessThan(0.15);
  });
});
