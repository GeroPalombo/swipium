// Real-device smoke regressions (E): the report repeated 24 identical WRONG_FOREGROUND findings, and
// said "Tool status: PASS" after tool errors (WDA 404, UNKNOWN). Identical findings collapse into one
// entry with a count; recorded tool errors make the TOOL status DEGRADED (never the app verdict).
// Hermetic: HOME points at a temp dir BEFORE the store module is loaded; no device discovery.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-report-dedupe-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { dedupeFindings } = await import('../src/report/findingsDedupe.js');
const { toolVerdictFor, toolErrorFromResult, recordToolErrorFromResult } = await import('../src/report/toolHealth.js');
const { generateSessionReport } = await import('../src/services/report.js');
const { toMarkdown } = await import('../src/report/export.js');
const { qaError, qaOk } = await import('../src/lib/result.js');

const projectRoot = mkdtempSync(join(tmpdir(), 'swipium-report-dedupe-proj-'));
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

const WRONG_FG = {
  severity: 'medium',
  kind: 'wrong_foreground',
  failureCode: 'WRONG_FOREGROUND',
  layer: 'native' as const,
  screen: 'com.google.android.apps.nexuslauncher',
  detail: 'Foreground is com.google.android.apps.nexuslauncher, not com.example.app',
};

describe('dedupeFindings', () => {
  it('collapses identical findings with a count, first/last time and distinct screenshots', () => {
    const list = [
      ...Array.from({ length: 24 }, (_, i) => ({ ...WRONG_FG, at: 1000 + i, screenshotUri: i < 2 ? `s${i}` : undefined })),
      { ...WRONG_FG, detail: 'Foreground is com.android.settings, not com.example.app', at: 5 },
    ];
    const out = dedupeFindings(list);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ count: 24, firstAt: 1000, lastAt: 1023, screenshotUri: 's0', screenshotUris: ['s0', 's1'] });
    expect(out[1].count).toBe(1);
  });

  it('keeps findings apart when screen or code differs', () => {
    expect(dedupeFindings([WRONG_FG, { ...WRONG_FG, screen: 'other' }, { ...WRONG_FG, failureCode: 'APP_CRASH' }])).toHaveLength(3);
  });
});

describe('tool status reflects recorded tool errors', () => {
  it('classifies error results; consent refusals / missing data are not tool errors', () => {
    const wda = qaError({
      what: 'WDA returned HTTP 404',
      changedState: false,
      retrySafe: true,
      nextSteps: [],
      failureCode: 'WDA_SESSION_FAILED',
    });
    expect(toolErrorFromResult('qa_snapshot', wda)).toEqual({
      tool: 'qa_snapshot',
      failureCode: 'WDA_SESSION_FAILED',
      message: 'WDA returned HTTP 404',
    });
    const unknown = qaError({ what: 'boom', changedState: false, retrySafe: true, nextSteps: [] });
    expect(toolErrorFromResult('qa_act', unknown)?.failureCode).toBe('UNKNOWN');
    const declined = qaError({ what: 'declined', changedState: false, retrySafe: false, nextSteps: [], failureCode: 'CONSENT_DECLINED' });
    expect(toolErrorFromResult('qa_app', declined)).toBeUndefined();
    expect(toolErrorFromResult('qa_act', qaOk({}, 'fine'))).toBeUndefined();
  });

  it('PASS without errors, DEGRADED with errors, BLOCKED with mcp_limitation notes', () => {
    expect(toolVerdictFor([], []).status).toBe('PASS');
    const errs = [
      { at: 1, tool: 'qa_snapshot', failureCode: 'WDA_SESSION_FAILED', message: 'HTTP 404' },
      { at: 2, tool: 'qa_act', failureCode: 'UNKNOWN', message: 'x' },
      { at: 3, tool: 'qa_snapshot', failureCode: 'WDA_SESSION_FAILED', message: 'HTTP 404' },
    ];
    const v = toolVerdictFor([], errs);
    expect(v.status).toBe('DEGRADED');
    expect(v.toolErrorCount).toBe(3);
    expect(v.toolErrorsByCode).toEqual({ WDA_SESSION_FAILED: 2, UNKNOWN: 1 });
    expect(v.summary).toContain('3 tool error(s)');
    expect(toolVerdictFor([{ workflow: 'map', reason: 'canvas' }], errs).status).toBe('BLOCKED');
  });
});

describe('qa_report end-to-end', () => {
  it('24 identical findings → one entry ×24; tool errors → Tool status DEGRADED; app verdict untouched', async () => {
    const store = new SessionStore();
    const s = store.create(projectRoot);
    s.appId = 'com.example.app';
    for (let i = 0; i < 24; i++) store.addFinding(s, { ...WRONG_FG, at: Date.now() + i });
    const wda = qaError({
      what: 'WDA returned HTTP 404',
      changedState: false,
      retrySafe: true,
      nextSteps: [],
      failureCode: 'WDA_SESSION_FAILED',
    });
    recordToolErrorFromResult(store, 'qa_snapshot', { sessionId: s.id }, wda);
    recordToolErrorFromResult(
      store,
      'qa_act',
      { sessionId: s.id },
      qaError({ what: 'boom', changedState: false, retrySafe: true, nextSteps: [] }),
    );
    expect(s.toolErrors).toHaveLength(2);

    const res = await generateSessionReport(store, s, { includeCurrentDump: false });
    const report = res.report as {
      findings: Array<{ failureCode: string; count: number }>;
      findingOccurrences: number;
      toolVerdict: { status: string };
      appVerdict: { status: string };
      toolErrors: unknown[];
    };
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ failureCode: 'WRONG_FOREGROUND', count: 24 });
    expect(report.findingOccurrences).toBe(24);
    expect(report.toolVerdict.status).toBe('DEGRADED');
    expect(report.toolErrors).toHaveLength(2);
    expect(report.appVerdict.status).not.toBe('BLOCKED');
    expect(res.summaryText).toMatch(/Tool status: DEGRADED - 2 tool error\(s\)/);
    expect(res.summaryText).not.toMatch(/Tool status: PASS/);
    expect(res.summaryText).toContain('findings: 1 unique (24 occurrence(s)');
    expect(res.summaryText.match(/\[medium\] native\/wrong_foreground/g)).toHaveLength(1);
    expect(res.summaryText).toContain('(×24)');
    expect(toMarkdown(res.report as never)).toContain('(×24)');

    // Tool errors survive a restart (persisted in state.json).
    store.flushAll();
    expect(new SessionStore().get(s.id)?.toolErrors).toHaveLength(2);
  });
});
