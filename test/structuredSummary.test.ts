// F3: Claude Code and Codex hand the model structuredContent (not the text block) for successful
// results, so the human summary and its next-step guidance must also live in structuredContent.
// qaOk/qaStop put `summary` first and the extracted guidance under `next`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buttonScreen, FakeDriver, harness, structured, textOf } from './actFixFake.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractNextSteps,
  qaOk,
  qaStop,
  runWithResponseMode,
  STRUCTURED_HEADLINE_MAX_CHARS,
  STRUCTURED_SUMMARY_MAX_CHARS,
} from '../src/lib/result.js';

const sc = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;

describe('qaOk / qaStop structured summary', () => {
  it('summary is the first key, then ok + payload; next extracted from "Next:"', () => {
    const r = qaOk({ installed: true }, 'installed (com.x). Next: qa_ios { action: "launch" }.');
    expect(Object.keys(sc(r))[0]).toBe('summary');
    expect(sc(r)).toEqual({
      summary: 'installed (com.x). Next: qa_ios { action: "launch" }.',
      ok: true,
      installed: true,
      next: ['qa_ios { action: "launch" }'],
    });
  });

  it('the text fence does not repeat summary/next', () => {
    const t = textOf(qaOk({ a: 1 }, 'did it\nNext: qa_wda attach.'));
    const fence = JSON.parse(t.match(/```json\n([\s\S]*?)\n```/)![1]) as Record<string, unknown>;
    expect(fence).toEqual({ ok: true, a: 1 });
  });

  it('a payload summary / next / nextSteps is never overwritten', () => {
    expect(sc(qaOk({ summary: { features: 2 } }, 'text')).summary).toEqual({ features: 2 });
    expect(sc(qaOk({ next: { tool: 'qa_x' } }, 'Next: qa_y')).next).toEqual({ tool: 'qa_x' });
    const withSteps = sc(qaOk({ nextSteps: ['qa_z'] }, 'x\nnext:\n - qa_z'));
    expect(withSteps.next).toBeUndefined();
    expect(withSteps.nextSteps).toEqual(['qa_z']);
  });

  it('no guidance > no next key', () => {
    expect('next' in sc(qaOk({}, 'all good'))).toBe(false);
  });

  it('compact mode keeps the structured summary (the text block is what shrinks)', () => {
    const r = runWithResponseMode('compact', () => qaOk({ a: 1 }, 'sum. Call qa_report.'));
    expect(textOf(r)).toBe('sum. Call qa_report.');
    expect(sc(r)).toMatchObject({ summary: 'sum. Call qa_report.', next: ['qa_report'] });
  });

  it('textOmit: rendered @eN element lines are not duplicated in the structured summary', () => {
    const r = qaOk({ elements: [{ ref: '@e1' }] }, 'quality=good\n\n@e1 [button] "OK"\n@e2 [text] "Hi"', { textOmit: ['elements'] });
    expect(sc(r).summary).toBe('quality=good');
  });

  it('structuredSummary "full": a very long summary is capped with a marker', () => {
    const s = sc(qaOk({}, 'x'.repeat(STRUCTURED_SUMMARY_MAX_CHARS + 500), { structuredSummary: 'full' })).summary as string;
    expect(s.length).toBeLessThan(STRUCTURED_SUMMARY_MAX_CHARS + 100);
    expect(s).toMatch(/summary truncated/);
  });

  it('default "headline": only the first line, capped; next still comes from the full summary', () => {
    const r = qaOk({ a: 1 }, 'did it\nline two repeats payload\nCall qa_report to summarize.');
    expect(sc(r)).toEqual({ summary: 'did it', ok: true, a: 1, next: ['qa_report to summarize'] });
    // the text block is unchanged
    expect(textOf(r).startsWith('did it\nline two repeats payload\nCall qa_report to summarize.')).toBe(true);
    const long = sc(qaOk({}, 'y'.repeat(STRUCTURED_HEADLINE_MAX_CHARS + 50))).summary as string;
    expect(long).toBe(`${'y'.repeat(STRUCTURED_HEADLINE_MAX_CHARS)}...`);
  });

  it('"full" keeps every line; "none" drops the summary key', () => {
    expect(sc(qaOk({}, 'a\nb', { structuredSummary: 'full' })).summary).toBe('a\nb');
    expect('summary' in sc(qaOk({}, 'a\nb', { structuredSummary: 'none' }))).toBe(false);
  });

  it('next is skipped when the payload already has its own next-step guidance', () => {
    for (const k of ['nextBestAction', 'nextAction', 'nextRecommendedAction', 'nextSteps']) {
      expect('next' in sc(qaOk({ [k]: { tool: 'qa_x' } }, 'x. Call qa_report.')), k).toBe(false);
    }
  });

  it('qaStop always carries summary + next: qa_report', () => {
    const r = qaStop('action budget (40) reached', { counters: { actions: 40 } });
    const s = sc(r);
    expect(Object.keys(s)[0]).toBe('summary');
    expect(s).toMatchObject({ ok: true, stopped: true, reason: 'action budget (40) reached' });
    expect(String(s.summary)).toContain('Stopped: action budget (40) reached');
    expect(textOf(r)).toContain('Call qa_report');
    expect(s.next).toEqual(['qa_report to summarize what was verified']);
  });
});

describe('extractNextSteps on the real tool summaries', () => {
  it.each([
    ['visual budget', '"Pay" > tapped device (10, 20) via adb\n⏹ budget reached: action budget. Call qa_report.', ['qa_report']],
    [
      'screen record start',
      'recording started (direct, always) (auto-stops after ~3 min). Call qa_screen_record { action: "stop", failed:<bool> } to finalize and save the video.',
      ['qa_screen_record { action: "stop", failed:<bool> } to finalize and save the video'],
    ],
    [
      'ios boot',
      'booted + bound iPhone 16 [iOS 18]\nNext: qa_ios install/launch, then qa_screenshot / qa_visual.',
      ['qa_ios install/launch, then qa_screenshot / qa_visual'],
    ],
    ['wda start', 'started managed WDA pid 12 and /status is ready > swipium://x\nNext: qa_wda attach.', ['qa_wda attach']],
    ['smoke', 'qa_smoke done: launch=ok, flows 1/1 passed.\n✓ login\nCall qa_report to summarize.', ['qa_report to summarize']],
    [
      'metro without device',
      'metro listening\n⚠ No device bound; adb reverse needs one. Call qa_prepare_target first (it binds the device), then qa_metro.',
      ['qa_prepare_target first (it binds the device), then qa_metro'],
    ],
    ['bullet list', 'flow failed\nnext:\n - qa_snapshot\n - qa_flow_repair', ['qa_snapshot', 'qa_flow_repair']],
  ])('%s', (_label, summary, want) => {
    expect(extractNextSteps(summary)).toEqual(want);
  });

  it('ignores quoted UI labels and mid-sentence mentions', () => {
    expect(extractNextSteps('✓ 3. tap "Next: Payment"\n✓ 4. tap "Call qa_x now"')).toEqual([]);
    expect(extractNextSteps('overlays: keyboard (clear with qa_clear_overlay)')).toEqual([]);
  });

  it.each([
    ['qa level (report.ts)', 'QA level: AUTOMATION_CANDIDATE: Reached it. · next: smoke_tested (Run qa_smoke.)', []],
    ['UI text after a step number', 'step 3. Next: Payment screen loaded', []],
    [
      'test-this plan (plan.ts)',
      'plan:\n  1. [ ] qa_prepare_target: install\nnext: call qa_prepare_target {"sessionId":"s1"}',
      ['qa_prepare_target {"sessionId":"s1"}'],
    ],
    ['split + dedupe', 'Next: qa_report. Call qa_report.', ['qa_report']],
    ['split into two entries', 'Next: qa_snapshot. Call qa_report to summarize.', ['qa_snapshot', 'qa_report to summarize']],
    ['lowercase call', 'done. call qa_report', ['qa_report']],
  ])('%s', (_label, summary, want) => {
    expect(extractNextSteps(summary)).toEqual(want);
  });

  it('every entry produced from any summary literal in src starts with a qa_ tool', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(import.meta.dirname, '..', 'src'));
    const literals: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
        const lit = m[0].slice(1, -1).replace(/\\n/g, '\n');
        if (/[Nn]ext:|[Cc]all qa_/.test(lit)) literals.push(lit);
      }
    }
    expect(literals.length).toBeGreaterThan(20);
    let produced = 0;
    for (const lit of literals) {
      for (const e of extractNextSteps(lit)) {
        produced++;
        expect(e, lit).toMatch(/^qa_[a-z_]+/);
      }
    }
    expect(produced).toBeGreaterThan(5);
  });
});

describe('through the server', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness('structured-summary');
  });
  afterAll(async () => {
    await h.close();
  });

  it('qa_snapshot structuredContent has a summary without element lines, elements intact', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    const s = structured(await h.call('qa_snapshot', { sessionId: id }));
    expect(Object.keys(s)[0]).toBe('summary');
    expect(String(s.summary)).toMatch(/quality=/);
    expect(String(s.summary)).not.toMatch(/^@e\d/m);
    expect((s.elements as unknown[]).length).toBe(4);
  });
});
