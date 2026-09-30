// Item 1: qa_status must not replay a terminal job's recommended action once it has been done.
//  (a) needs_input → the user answers via qa_continue_from_blocker → qa_status moved on (re-run the
//      autopilot with the answer), not qa_continue_from_blocker again.
//  (b) completed job whose report failed → qa_report → after a successful qa_report, qa_status
//      moves on (read the report), not qa_report again.
//  (c) blocked → qa_explain_blocker {sessionId} → the ladder moves past the blocker.
// Plus a simulation: following nextBestAction and applying each tool's effect never recommends the
// same call twice in a row (except the terminal qa_get_artifact read).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKER_ANSWERED_MILESTONE, BLOCKER_EXPLAINED_MILESTONE, nextBestAction } from '../src/tools/agent.js';
import type { JobRecord, Session } from '../src/session/store.js';
import { FakeDriver, buttonScreen, harness, structured } from './actFixFake.js';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    root: '/tmp/final2-ladder',
    dir: '/tmp/final2-ladder/.swipium',
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

const up = { device: 'emulator-5554', appId: 'com.example.app', milestones: { smoke_completed: 50 } as Record<string, number> };
const report = (at: number) => ({
  uri: `swipium://session/s1/report/report-${at}.json`,
  path: '/x',
  mime: 'application/json',
  kind: 'report',
  createdAt: at,
});
const needsInputResult = {
  state: 'needs_input',
  nextRecommendedAction: { tool: 'qa_continue_from_blocker', args: { sessionId: 's1', kind: 'credentials' }, why: 'ask' },
};
const reportFailedResult = {
  state: 'completed',
  nextRecommendedAction: { tool: 'qa_report', args: { sessionId: 's1' }, why: 'Generate the report' },
};
function job(result: Record<string, unknown>, endedAt = 100, status: JobRecord['status'] = 'done'): Map<string, JobRecord> {
  return new Map([
    ['j1', { jobId: 'j1', kind: 'test_this:execute', status, startedAt: 1, endedAt, result, artifactUris: [] } as JobRecord],
  ]);
}

describe('qa_status ladder: a satisfied terminal-job action is not replayed (table)', () => {
  const rows: Array<{ name: string; s: Session; tool: string; args?: Record<string, unknown> }> = [
    {
      name: '(a) needs_input, unanswered → resume call',
      s: makeSession({ ...up, jobs: job(needsInputResult) }),
      tool: 'qa_continue_from_blocker',
    },
    {
      name: '(a) needs_input, input stored BEFORE the job ended → still the resume call',
      s: makeSession({
        ...up,
        jobs: job(needsInputResult),
        inputs: [{ varName: 'SWIPIUM_TEST_PASSWORD', secret: true, source: 'x', at: 50 }],
      }),
      tool: 'qa_continue_from_blocker',
    },
    {
      name: '(a) needs_input answered (stored input newer than the job) → re-run the autopilot',
      s: makeSession({
        ...up,
        jobs: job(needsInputResult),
        inputs: [{ varName: 'SWIPIUM_TEST_PASSWORD', secret: true, source: 'x', at: 150 }],
      }),
      tool: 'qa_test_this',
      args: { mode: 'execute', sessionId: 's1', stopOnNeedsInput: false },
    },
    {
      name: '(a) needs_input answered with choices only (answer milestone) → re-run the autopilot',
      s: makeSession({ ...up, jobs: job(needsInputResult), milestones: { ...up.milestones, [BLOCKER_ANSWERED_MILESTONE]: 150 } }),
      tool: 'qa_test_this',
    },
    { name: '(b) completed, report failed → qa_report', s: makeSession({ ...up, jobs: job(reportFailedResult) }), tool: 'qa_report' },
    {
      name: '(b) completed, report failed, then qa_report succeeded → read it (not qa_report again)',
      s: makeSession({ ...up, jobs: job(reportFailedResult), artifacts: [report(150)] }),
      tool: 'qa_get_artifact',
      args: { uri: report(150).uri },
    },
    {
      name: '(c) blocked, explained with sessionId → moves past the blocker',
      s: makeSession({
        ...up,
        jobs: job({ state: 'blocked', failureCode: 'EMULATOR_BOOT_FAILED' }),
        artifacts: [report(99)],
        milestones: { ...up.milestones, [BLOCKER_EXPLAINED_MILESTONE]: 150 },
      }),
      tool: 'qa_get_artifact',
    },
  ];
  for (const r of rows)
    it(r.name, () => {
      const next = nextBestAction(r.s);
      expect(next.tool).toBe(r.tool);
      if (r.args) expect(next.args).toEqual(r.args);
    });
});

/** Apply the observable effect of each recommended tool (what the real tool persists). */
function apply(s: Session, tool: string, t: number): void {
  switch (tool) {
    case 'qa_job_status': {
      const j = [...s.jobs.values()][0];
      j.status = 'done';
      j.endedAt = t;
      break;
    }
    case 'qa_continue_from_blocker':
      s.inputs.push({ varName: 'SWIPIUM_TEST_PASSWORD', secret: true, source: 'needs_input:credentials', at: t });
      s.milestones[BLOCKER_ANSWERED_MILESTONE] = t;
      break;
    case 'qa_explain_blocker':
      s.milestones[BLOCKER_EXPLAINED_MILESTONE] = t;
      break;
    case 'qa_report':
      s.artifacts.push(report(t));
      break;
    case 'qa_test_this':
      s.jobs = new Map([
        ['j2', { jobId: 'j2', kind: 'test_this:execute', status: 'running', startedAt: t, artifactUris: [] } as JobRecord],
      ]);
      break;
    case 'qa_smoke':
      s.notes.push({ at: t, workflow: 'launch_smoke', outcome: 'pass' } as Session['notes'][number]);
      break;
    case 'qa_generate':
      s.workarounds.push('generated 1 test asset(s) from recorded actions (qa_generate)');
      break;
    case 'qa_prepare_target':
    case 'qa_prepare_ios_target':
      s.appId = 'com.example.app';
      break;
    default:
      throw new Error(`no effect modelled for ${tool}`);
  }
}

describe('qa_status ladder simulation: following the advice always changes the advice', () => {
  const starts: Array<[string, () => Session]> = [
    ['needs_input job', () => makeSession({ ...up, jobs: job(needsInputResult) })],
    ['report-failed completed job', () => makeSession({ ...up, jobs: job(reportFailedResult) })],
    ['blocked job', () => makeSession({ ...up, jobs: job({ state: 'blocked', failureCode: 'EMULATOR_BOOT_FAILED' }) })],
    ['blocked job, no device', () => makeSession({ jobs: job({ state: 'blocked', failureCode: 'EMULATOR_BOOT_FAILED' }) })],
    ['app up, nothing run', () => makeSession({ device: 'emulator-5554', appId: 'com.example.app' })],
    ['device, no app', () => makeSession({ device: 'emulator-5554' })],
  ];
  for (const [name, mk] of starts)
    it(name, () => {
      const s = mk();
      let prev = '';
      for (let t = 200; t < 2000; t += 100) {
        const next = nextBestAction(s);
        const key = `${next.tool} ${JSON.stringify(next.args)}`;
        if (next.tool === 'qa_get_artifact') return; // terminal read — done
        if (next.tool === 'qa_test_this' && [...s.jobs.keys()].includes('j2')) return; // re-ran the autopilot
        expect(key, `loop at t=${t}: ${next.why}`).not.toBe(prev);
        prev = key;
        apply(s, next.tool, t);
      }
      throw new Error('ladder did not terminate');
    });
});

describe('qa_status over MCP after qa_continue_from_blocker / qa_explain_blocker', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness('final2-ladder');
  });
  afterAll(async () => {
    await h.close();
  });

  const status = async (id: string) =>
    structured(await h.call('qa_status', { sessionId: id })).nextBestAction as { tool: string; args: Record<string, unknown> };

  it('(a) answering the needs_input question moves qa_status off qa_continue_from_blocker', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 2)));
    const s = h.sessions.get(id)!;
    s.milestones.smoke_completed = Date.now();
    s.jobs.set('j1', {
      jobId: 'j1',
      kind: 'test_this:execute',
      status: 'done',
      startedAt: Date.now() - 10,
      endedAt: Date.now(),
      result: {
        ...needsInputResult,
        nextRecommendedAction: { ...needsInputResult.nextRecommendedAction, args: { sessionId: id, kind: 'credentials' } },
      },
      artifactUris: [],
    });
    expect((await status(id)).tool).toBe('qa_continue_from_blocker');
    await new Promise((r) => setTimeout(r, 5));
    const res = structured(
      await h.call('qa_continue_from_blocker', {
        sessionId: id,
        kind: 'credentials',
        values: { email: 'qa@example.com', password: 'hunter22' },
      }),
    );
    expect(res.ok).not.toBe(false);
    const next = await status(id);
    expect(next.tool).toBe('qa_test_this');
    expect(next.args).toMatchObject({ mode: 'execute', sessionId: id, stopOnNeedsInput: false });
  }, 20_000);

  it('(c) qa_explain_blocker {sessionId} moves qa_status past the blocker', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 2)));
    const s = h.sessions.get(id)!;
    s.jobs.set('j1', {
      jobId: 'j1',
      kind: 'test_this:execute',
      status: 'failed',
      startedAt: Date.now() - 10,
      endedAt: Date.now(),
      result: { state: 'blocked', failureCode: 'EMULATOR_BOOT_FAILED' },
      artifactUris: [],
    });
    const first = await status(id);
    expect(first.tool).toBe('qa_explain_blocker');
    await new Promise((r) => setTimeout(r, 5));
    await h.call('qa_explain_blocker', first.args);
    expect((await status(id)).tool).not.toBe('qa_explain_blocker');
  }, 20_000);
});
