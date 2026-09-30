// needs_input as a real terminal job state (P1 #7): a first-run login/OTP stop maps to ONE
// NeedsInput question bound to the session, and the finisher lands state:"needs_input" (job status
// done — a pause, not a failure) with the question, a report, and nextRecommendedAction = the
// qa_continue_from_blocker resume call. qa_status then recommends that same call.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-ni-home-'));
process.env.HOME = fakeHome;

// Pipeline collaborators faked: prepare binds a fake driver, smoke passes, first-run stops on login.
vi.mock('../src/services/prepareAndroid.js', () => ({
  prepareAndroid: vi.fn(async (_s: unknown, session: { driver?: unknown; device?: string; appId?: string }, driver: unknown) => {
    session.driver = driver;
    session.device = 'emulator-5554';
    session.appId = 'com.example.app';
    return { ok: true, resultText: 'launched' };
  }),
}));
vi.mock('../src/services/smoke.js', () => ({
  runSmoke: vi.fn(async () => ({ baseline: { launch: { outcome: 'pass' } }, flowsPassed: 0, flowsTotal: 0 })),
}));
vi.mock('../src/firstRun/firstRunRunner.js', () => ({
  resolveFirstRunPolicy: vi.fn(() => ({ policy: {}, decision: {} })),
  observeScreen: vi.fn(async () => ({
    elements: [],
    foreground: 'com.example.app',
    visibleText: 'Log in',
    screenSignature: 'sig',
    appError: false,
  })),
  runFirstRun: vi.fn(async () => ({
    state: 'needs_input',
    needsInput: { kind: 'credentials', reason: 'the login form needs a test account' },
    evidenceUris: [],
    mapUpdates: [],
    pathTaken: 'login',
    accountOutcome: 'pre_login_only',
    environment: { environment: 'unknown' },
  })),
}));
vi.mock('../src/firstRun/firstRunPlanner.js', () => ({
  planFirstRun: vi.fn(() => ({ classification: { purpose: 'login' } })),
}));

const { SessionStore } = await import('../src/session/store.js');
const { runExecutePipeline } = await import('../src/orchestration/testThis/pipeline.js');
const { createFinisher } = await import('../src/orchestration/testThis/terminal.js');
const { firstRunQuestion } = await import('../src/orchestration/testThis/pipeline.js');
const { nextBestAction } = await import('../src/tools/agent.js');
type ExecuteArgs = import('../src/orchestration/testThis/types.js').ExecuteArgs;

const root = mkdtempSync(join(tmpdir(), 'swipium-ni-root-'));
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('firstRunQuestion', () => {
  it('maps credentials / OTP / test-data stops to one question with the resume bound to the session', () => {
    const cred = firstRunQuestion({ kind: 'credentials', reason: 'login form needs an account' }, 'sid1', ['smoke']);
    expect(cred.kind).toBe('credentials');
    expect(cred.question).toMatch(/login form needs an account/);
    expect(cred.resume).toEqual({ tool: 'qa_continue_from_blocker', args: { sessionId: 'sid1', kind: 'credentials' } });
    expect(cred.attempted).toEqual(['smoke']);
    expect(firstRunQuestion({ kind: 'otp_or_manual_verification', reason: 'code' }, 'sid1', []).kind).toBe('otp_or_manual_verification');
    expect(firstRunQuestion({ kind: 'create_test_data', reason: 'x' }, 'sid1', []).kind).toBe('create_test_data');
  });
});

describe('needs_input terminal state', () => {
  it('lands state needs_input with the question, a report, and the resume call as nextRecommendedAction', async () => {
    const sessions = new SessionStore();
    const session = sessions.create(root);
    const job = sessions.createJob(session, 'test_this:execute');
    const a = {
      goal: 'test_login',
      requiredOutputs: ['reportUri', 'smoke'],
      releaseGate: false,
      artifactChoice: null,
      targetChoice: null,
    } as unknown as ExecuteArgs;
    const finish = createFinisher({
      sessions,
      session,
      job,
      a,
      attempted: ['smoke', 'first-run autonomy'],
      artifacts: [],
      getSuiteForReport: () => undefined,
      upd: (patch) => sessions.updateJobIfRunning(session, job, patch),
    });
    const q = firstRunQuestion({ kind: 'credentials', reason: 'login required' }, session.id, []);
    await finish('needs_input', undefined, 'paused', { needsInput: q });
    const cur = session.jobs.get(job.jobId)!;
    expect(cur.status).toBe('done');
    const r = cur.result as Record<string, unknown>;
    expect(r.state).toBe('needs_input');
    expect(r.needsInput).toMatchObject({ kind: 'credentials', needsInput: true });
    expect(r.blockers).toEqual([]);
    expect(String(r.reportUri)).toMatch(/report/);
    expect(r.nextRecommendedAction).toMatchObject({
      tool: 'qa_continue_from_blocker',
      args: { sessionId: session.id, kind: 'credentials' },
    });
    expect(session.milestones.report_generated).toBeTypeOf('number');
    expect(nextBestAction(session).tool).toBe('qa_continue_from_blocker');
  });

  it('a blocked run points at qa_explain_blocker WITH sessionId (so qa_status can see it was explained)', async () => {
    const sessions = new SessionStore();
    const session = sessions.create(root);
    const job = sessions.createJob(session, 'test_this:execute');
    const finish = createFinisher({
      sessions,
      session,
      job,
      a: { requiredOutputs: ['reportUri'], releaseGate: false } as unknown as ExecuteArgs,
      attempted: ['install'],
      artifacts: [],
      getSuiteForReport: () => undefined,
      upd: (patch) => sessions.updateJobIfRunning(session, job, patch),
    });
    await finish('blocked', 'INSTALL_FAILED', 'install failed');
    const r = session.jobs.get(job.jobId)!.result as Record<string, unknown>;
    expect(r.nextRecommendedAction).toMatchObject({
      tool: 'qa_explain_blocker',
      args: { failureCode: 'INSTALL_FAILED', sessionId: session.id },
    });
  });
});

describe('runExecutePipeline surfaces the first-run question', () => {
  const baseArgs = (stopOnNeedsInput: boolean) =>
    ({
      mode: 'execute',
      scan: { framework: 'native-android', likelyAuth: true, metroNeed: 'no', appId: 'com.example.app' },
      art: { best: { path: join(root, 'app.apk'), type: 'apk', appId: 'com.example.app' }, candidates: [] },
      target: {
        selected: 'android-emulator',
        device: 'emulator-5554',
        willBoot: false,
        reason: 'test',
        alternatives: [],
        preconditions: [],
      },
      isAndroid: true,
      isIosReal: false,
      isAab: false,
      needBuild: false,
      effectiveApk: join(root, 'app.apk'),
      goal: stopOnNeedsInput ? 'test_login' : 'smoke',
      releaseGate: false,
      requiredOutputs: ['reportUri', 'smoke'],
      artifactChoice: null,
      targetChoice: null,
      generateSuite: false,
      explore: false,
      stopOnNeedsInput,
      workaroundLog: () => [],
    }) as unknown as ExecuteArgs;

  it('stopOnNeedsInput (goal test_login) → terminal needs_input carrying the question', async () => {
    const sessions = new SessionStore();
    const session = sessions.create(root);
    const job = sessions.createJob(session, 'test_this:execute');
    await runExecutePipeline(sessions, session, job, baseArgs(true));
    const r = session.jobs.get(job.jobId)!.result as Record<string, unknown>;
    expect(r.state).toBe('needs_input');
    expect((r.needsInput as { question: string }).question).toMatch(/login form needs a test account/);
    expect(session.milestones.smoke_completed).toBeTypeOf('number');
  });

  it('otherwise the run completes pre-login and the question rides on the result (not dropped)', async () => {
    const sessions = new SessionStore();
    const session = sessions.create(root);
    const job = sessions.createJob(session, 'test_this:execute');
    await runExecutePipeline(sessions, session, job, baseArgs(false));
    const cur = session.jobs.get(job.jobId)!;
    const r = cur.result as Record<string, unknown>;
    expect(r.state).toBe('completed');
    expect(r.optionalQuestion).toMatchObject({ kind: 'credentials', resume: { args: { sessionId: session.id } } });
    expect(cur.resultText).toMatch(/optional question/);
  });
});
