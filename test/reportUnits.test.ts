// Unit tests for the report building blocks: evidence labels by note origin (with the heuristics
// for notes written before origins existed), phase timings, and the artifact manifest.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceKindForNote, evidenceTaxonomyForNotes } from '../src/report/evidence.js';
import { phaseTimingsForSession } from '../src/report/timing.js';
import { buildSessionArtifactManifest } from '../src/report/artifactManifest.js';
import { SessionStore } from '../src/session/store.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('evidenceKindForNote by origin', () => {
  it.each([
    ['smoke', { workflow: 'launch_smoke', origin: 'smoke' }, 'structured_locator'],
    ['visual-only smoke', { workflow: 'launch_smoke', origin: 'smoke', method: 'visual' as const }, 'visual_match'],
    ['flow', { workflow: 'login', origin: 'flow' }, 'structured_locator'],
    ['flow with a visual step', { workflow: 'login:visual', origin: 'flow', visualStep: true }, 'visual_match'],
    ['flow note step', { workflow: 'login:note', origin: 'flow_note' }, 'structured_locator'],
    ['explore', { workflow: 'explore: Settings', origin: 'explore' }, 'structured_locator'],
    ['agent note', { workflow: 'checkout', origin: 'agent', source: 'qa_note' }, 'manual_review'],
    ['agent note with a structured method', { workflow: 'checkout', origin: 'agent', method: 'structured' as const }, 'structured_locator'],
    [
      'agent visual assert',
      { workflow: 'chart', origin: 'agent', evidenceKind: 'manual_review' as const, method: 'visual' as const },
      'manual_review',
    ],
  ])('%s', (_label, note, want) => {
    expect(evidenceKindForNote(note)).toBe(want);
  });

  it('a 2.3.5-era session (no origin) falls back to heuristics and never gets visual_match from them', () => {
    // Notes exactly as 2.3.5 wrote them.
    const old = [
      { workflow: 'launch_smoke', outcome: 'pass', reason: 'native=ok app=ok quality=good' },
      { workflow: 'fo-search', outcome: 'fail', reason: 'qa_flow_run failed at step 2: element "Home" not found' },
      { workflow: 'fo-search:note', outcome: 'pass', reason: 'cart shows 2 items' },
      { workflow: 'checkout', outcome: 'pass', source: 'qa_note', reason: 'looks fine' },
      { workflow: 'mobile_audit: smoke', outcome: 'pass', reason: 'audit completed' },
    ];
    expect(old.map((n) => evidenceKindForNote(n))).toEqual([
      'structured_locator',
      'structured_locator',
      'structured_locator',
      'manual_review',
      'manual_review',
    ]);
    const tax = evidenceTaxonomyForNotes(old);
    expect(tax.counts.visual_match).toBe(0);
    expect(tax.counts.structured_locator).toBe(3);
  });

  it('an old visual flow note keeps its own visual label (fields win over heuristics)', () => {
    expect(evidenceKindForNote({ workflow: 'login:visual', method: 'visual', verifiedVisually: true })).toBe('visual_match');
  });
});

describe('phaseTimingsForSession', () => {
  const base = { createdAt: 1000, milestones: { session_start: 1000 } as Record<string, number> };

  it('activeMs starts at the first step when no qa_act ran', () => {
    const t = phaseTimingsForSession(
      { ...base, steps: [{ i: 0, at: 4000, durationMs: 1, source: 'smoke', action: 'launch', result: 'ok' }] },
      10_000,
    );
    expect(t.activeMs).toBe(6000);
    expect(t.setupMs).toBe(3000);
    expect(t.totalMs).toBe(9000);
  });

  it('activeMs starts at the earlier of first_action and the first step', () => {
    const t = phaseTimingsForSession(
      {
        ...base,
        milestones: { session_start: 1000, first_action: 5000 },
        steps: [{ i: 0, at: 3000, durationMs: 1, source: 'flow', action: 'tap', result: 'ok' }],
      },
      10_000,
    );
    expect(t.activeMs).toBe(7000);
    expect(phaseTimingsForSession({ ...base, milestones: { session_start: 1000, first_action: 2000 } }, 10_000).activeMs).toBe(8000);
  });

  it('activeMs is 0 when nothing happened on the device', () => {
    expect(phaseTimingsForSession({ ...base, steps: [] }, 10_000).activeMs).toBe(0);
  });

  it('reads paired and aggregate milestones', () => {
    const t = phaseTimingsForSession(
      {
        ...base,
        milestones: { session_start: 1000, app_launch_start: 2000, app_launch_end: 2500, wait_ms: 700 },
        counters: { screenshots: 3 } as never,
      },
      3000,
    );
    expect(t.diagnostics.appLaunchMs).toBe(500);
    expect(t.diagnostics.waitMs).toBe(700);
    expect(t.diagnostics.screenshotCount).toBe(3);
    expect(t.diagnostics.wdaBuildMs).toBeNull();
  });
});

describe('buildSessionArtifactManifest', () => {
  it('hashes present files, lists missing ones and counts by kind', () => {
    const root = mkdtempSync(join(tmpdir(), 'swipium-manifest-'));
    roots.push(root);
    const store = new SessionStore();
    const s = store.create(root);
    store.saveArtifact(s, 'report', 'r.json', '{"a":1}', 'application/json');
    store.saveArtifact(s, 'screenshot', 's.png', Buffer.from('png'), 'image/png');
    s.artifacts.push({
      uri: 'swipium://session/x/dump/gone.xml',
      path: join(s.dir, 'dump', 'gone.xml'),
      mime: 'application/xml',
      kind: 'dump',
      createdAt: 1,
    });
    const m = buildSessionArtifactManifest(s);
    expect(m.sessionId).toBe(s.id);
    expect(m.artifactCounts).toEqual({ report: 1, screenshot: 1, dump: 1 });
    expect(m.files).toHaveLength(2);
    const json = m.files.find((f) => f.kind === 'report')!;
    expect(json.bytes).toBe(7);
    expect(json.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.missing).toEqual([{ uri: 'swipium://session/x/dump/gone.xml', path: join(s.dir, 'dump', 'gone.xml'), kind: 'dump' }]);
  });
});
