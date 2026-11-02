// The exploration summary step points at the saved screen graph on every path that saves one:
// qa_explore, the qa_test_this pipeline and feature testing.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-exlink-home-'));
process.env.HOME = fakeHome;

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
    visibleText: 'Home',
    screenSignature: 'sig',
    appError: false,
  })),
  runFirstRun: vi.fn(async () => ({
    state: 'completed',
    evidenceUris: [],
    mapUpdates: [],
    pathTaken: 'home',
    accountOutcome: 'no_login_needed',
    environment: { environment: 'unknown' },
  })),
}));
vi.mock('../src/firstRun/firstRunPlanner.js', () => ({
  planFirstRun: vi.fn(() => ({ classification: { purpose: 'home' } })),
}));
// The exploration itself is faked: it writes its summary step like the real runner does.
vi.mock('../src/explore/runner.js', async (orig) => {
  const real = await orig<typeof import('../src/explore/runner.js')>();
  return {
    ...real,
    runExplore: vi.fn(async (sessions: InstanceType<typeof SessionStore>, session: import('../src/session/store.js').Session) => {
      const st = sessions.addStep(session, {
        source: 'explore',
        action: 'explore',
        target: 'explored 1 screen(s), 0 action(s)',
        result: 'ok',
        durationMs: 5,
      });
      return {
        graph: { serialize: () => ({ nodes: [], edges: [] }), toMarkdown: () => '# graph' },
        state: 'completed',
        stoppedReason: 'done',
        summary: { screensVisited: 1, visualOnlyScreens: 0, blockers: 0, unsafeActionsSkipped: 0 },
        stepIndex: st.i,
      };
    }),
  };
});

const { SessionStore } = await import('../src/session/store.js');
const { runExecutePipeline } = await import('../src/orchestration/testThis/pipeline.js');
type ExecuteArgs = import('../src/orchestration/testThis/types.js').ExecuteArgs;

const root = mkdtempSync(join(tmpdir(), 'swipium-exlink-root-'));
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('qa_test_this exploration', () => {
  it('links the explore summary step to the saved graph', async () => {
    const sessions = new SessionStore();
    const session = sessions.create(root);
    const job = sessions.createJob(session, 'test_this:execute');
    const args = {
      mode: 'execute',
      scan: { framework: 'native-android', likelyAuth: false, metroNeed: 'no', appId: 'com.example.app' },
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
      goal: 'smoke',
      releaseGate: false,
      requiredOutputs: ['reportUri', 'smoke'],
      artifactChoice: null,
      targetChoice: null,
      generateSuite: false,
      explore: true,
      stopOnNeedsInput: false,
      workaroundLog: () => [],
    } as unknown as ExecuteArgs;
    await runExecutePipeline(sessions, session, job, args);
    const graphUri = session.exploration?.graphUri;
    expect(graphUri).toMatch(/graph-\d+\.json$/);
    const st = session.steps.find((x) => x.source === 'explore')!;
    expect(st.target).toContain(`graph: ${graphUri}`);
  }, 30_000);
});
