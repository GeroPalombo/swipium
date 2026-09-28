// qa_status ladder (P0 #3): following nextBestAction must always change the state it keys on.
// Before: an app-up session with no recorded actions recommended qa_smoke forever (qa_smoke records
// no actions), and a finished qa_test_this job with a report still recommended qa_smoke. Milestones
// (smoke ran, report generated) are persisted session state, not recorded-action counts.
// Also P3 #12: after a restart (no live driver) the persisted driverKind still drives mode/platform.

import { describe, expect, it } from 'vitest';
import { nextBestAction, effectiveMode, sessionPlatform } from '../src/tools/agent.js';
import { sessionDevicePlatform } from '../src/automationGen/platformResolve.js';
import type { JobRecord, Session } from '../src/session/store.js';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    root: '/tmp/p',
    dir: '/tmp/p/.swipium',
    createdAt: 0,
    envChanges: [],
    workarounds: [],
    mode: 'structured',
    responseMode: 'normal',
    sensitive: false,
    budget: { maxMinutes: 8, maxActions: 20, maxScreenshots: 8, maxSnapshotFailures: 3, maxNoChangeActions: 3 },
    counters: { actions: 0, screenshots: 0, snapshotFailures: 0, noChangeActions: 0 },
    screenshotCount: 0,
    jobs: new Map(),
    artifacts: [],
    findings: [],
    notes: [],
    mutations: [],
    recordedActions: [],
    fixtures: [],
    auth: {},
    milestones: {},
    secrets: new Set(),
    inputs: [],
    generatedValues: [],
    inputValues: new Map(),
    aborts: new Map(),
    ...over,
  } as Session;
}

const up = { device: 'emulator-5554', appId: 'com.example.app' };
const smokeNote = { at: 10, workflow: 'launch_smoke', outcome: 'pass' as const };
const report = (at: number) => ({
  uri: `swipium://session/s1/report/report-${at}.json`,
  path: '/x',
  mime: 'application/json',
  kind: 'report',
  createdAt: at,
});
const tap = { at: 20, action: 'tap', selector: 'Go', selectorKind: 'text' as const };
function job(result: Record<string, unknown> | undefined, endedAt = 100): Map<string, JobRecord> {
  return new Map([
    ['j1', { jobId: 'j1', kind: 'test_this:execute', status: 'done', startedAt: 1, endedAt, result, artifactUris: [] } as JobRecord],
  ]);
}

describe('nextBestAction ladder — no loops (table)', () => {
  const rows: Array<{ name: string; s: Session; tool: string; args?: Record<string, unknown> }> = [
    { name: 'app up, nothing run → qa_smoke', s: makeSession(up), tool: 'qa_smoke' },
    {
      name: 'smoke ran (note) but no actions → NOT qa_smoke again; wrap up with qa_report',
      s: makeSession({ ...up, notes: [smokeNote] }),
      tool: 'qa_report',
    },
    {
      name: 'smoke milestone from the pipeline counts too',
      s: makeSession({ ...up, milestones: { smoke_completed: 5 } }),
      tool: 'qa_report',
    },
    {
      name: 'smoke ran + fresh report → read it (terminal)',
      s: makeSession({ ...up, notes: [smokeNote], artifacts: [report(50)] }),
      tool: 'qa_get_artifact',
      args: { uri: 'swipium://session/s1/report/report-50.json' },
    },
    {
      name: 'activity after the report → report again',
      s: makeSession({ ...up, notes: [smokeNote, { ...smokeNote, at: 60 }], artifacts: [report(50)] }),
      tool: 'qa_report',
    },
    {
      name: 'actions recorded, no assets → qa_generate',
      s: makeSession({ ...up, notes: [smokeNote], recordedActions: [tap] }),
      tool: 'qa_generate',
    },
    {
      name: 'completed qa_test_this job → its nextRecommendedAction (the report), not qa_smoke',
      s: makeSession({
        ...up,
        notes: [smokeNote],
        jobs: job({
          state: 'completed',
          nextRecommendedAction: {
            tool: 'qa_get_artifact',
            args: { uri: 'swipium://session/s1/report/report-90.json' },
            why: 'Open the report',
          },
        }),
      }),
      tool: 'qa_get_artifact',
      args: { uri: 'swipium://session/s1/report/report-90.json' },
    },
    {
      name: 'blocked job → qa_explain_blocker with its failureCode',
      s: makeSession({ jobs: job({ state: 'blocked', failureCode: 'EMULATOR_BOOT_FAILED' }) }),
      tool: 'qa_explain_blocker',
      args: { failureCode: 'EMULATOR_BOOT_FAILED' },
    },
    {
      name: 'needs_input job → the resume call it carries',
      s: makeSession({
        ...up,
        jobs: job({
          state: 'needs_input',
          nextRecommendedAction: { tool: 'qa_continue_from_blocker', args: { sessionId: 's1', kind: 'credentials' }, why: 'ask' },
        }),
      }),
      tool: 'qa_continue_from_blocker',
      args: { sessionId: 's1', kind: 'credentials' },
    },
    {
      name: 'actions AFTER a completed job → the ladder resumes (job no longer authoritative)',
      s: makeSession({ ...up, notes: [smokeNote], recordedActions: [{ ...tap, at: 500 }], jobs: job({ state: 'completed' }, 100) }),
      tool: 'qa_generate',
    },
  ];

  it.each(rows)('$name', ({ s, tool, args }) => {
    const next = nextBestAction(s);
    expect(next.tool).toBe(tool);
    if (args) expect(next.args).toEqual(args);
  });

  it('following each recommendation changes the state it keyed on (simulated loop terminates)', () => {
    const s = makeSession(up);
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const next = nextBestAction(s);
      seen.push(next.tool);
      if (next.tool === 'qa_get_artifact') break;
      if (next.tool === 'qa_smoke') s.notes.push({ ...smokeNote, at: 10 + i });
      else if (next.tool === 'qa_report') s.artifacts.push(report(100 + i));
      else throw new Error(`unexpected ${next.tool}`);
    }
    expect(seen).toEqual(['qa_smoke', 'qa_report', 'qa_get_artifact']);
  });
});

describe('persisted driverKind after a restart (no live driver)', () => {
  it('a rehydrated simctl session is visual-only and iOS', () => {
    const s = makeSession({ device: 'weird-device-id', driverKind: 'simulator' });
    expect(effectiveMode(s)).toBe('visual-only');
    expect(sessionPlatform(s)).toBe('ios');
    expect(sessionDevicePlatform(s)).toBe('ios');
  });
  it('a rehydrated adb session stays Android even for an ip:port serial', () => {
    const s = makeSession({ device: '127.0.0.1:5555', driverKind: 'direct' });
    expect(effectiveMode(s)).toBe('structured');
    expect(sessionPlatform(s)).toBe('android');
    expect(sessionDevicePlatform(s)).toBe('android');
  });
});
