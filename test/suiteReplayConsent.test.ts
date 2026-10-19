// qa_generate target:"suite" replay runs THIS run's compiled output (not a kept hand-edited
// flows/ copy), and a replayed flow with mutating steps (seed, openUrl...) goes through the same
// flow_mutation_run consent qa_flow_run uses. Hermetic: generation, driver and runFlow are stubbed.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompiledFlowInfo, SuiteGenerationResult } from '../src/services/suiteGenerate.js';

const state = vi.hoisted(() => ({
  res: undefined as unknown,
  runs: [] as Array<{ flow: { name: string }; opts: Record<string, unknown> }>,
}));

vi.mock('../src/services/suiteGenerate.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/suiteGenerate.js')>()),
  generateAndCompileSuite: vi.fn(() => state.res),
}));
vi.mock('../src/session/attach.js', async (orig) => ({
  ...(await orig<typeof import('../src/session/attach.js')>()),
  getDriver: vi.fn(async () => ({ driver: { kind: 'direct' } })),
}));
vi.mock('../src/flows/run.js', async (orig) => ({
  ...(await orig<typeof import('../src/flows/run.js')>()),
  runFlow: vi.fn(async (_s: unknown, _session: unknown, _d: unknown, flow: { name: string }, opts: Record<string, unknown>) => {
    state.runs.push({ flow, opts });
    return { name: flow.name, passed: true };
  }),
}));
vi.mock('../src/report/readiness.js', async (orig) => ({
  ...(await orig<typeof import('../src/report/readiness.js')>()),
  readinessForSession: vi.fn(() => []),
}));

const { runSuiteGenerate } = await import('../src/tools/suite.js');

const root = mkdtempSync(join(tmpdir(), 'swipium-replay-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const session = {
  id: 's1',
  root,
  appId: 'com.example.app',
  createdAt: Date.now(),
  fixtures: [{ name: 'evil', seed: { type: 'script', command: ['./seed.sh'] } }],
  secrets: new Set<string>(),
  notes: [],
  recordedActions: [{ tool: 'qa_act' }],
  mutations: [] as unknown[],
};
const sessions = {
  get: () => session,
  inputVariables: () => ({}),
  recordMutation: (_s: unknown, m: unknown) => void session.mutations.push(m),
  saveArtifact: () => 'swipium://x',
};

/** A kept hand-edited flows/ copy plus this run's compiled output, as writeCompiledFlow leaves them. */
function generated(compiledYaml: string): SuiteGenerationResult {
  mkdirSync(join(root, '.swipium', 'flows'), { recursive: true });
  mkdirSync(join(root, '.swipium', 'compiled'), { recursive: true });
  const flowPath = join(root, '.swipium', 'flows', 'smoke.yaml');
  const compiledPath = join(root, '.swipium', 'compiled', 'smoke.flow.yaml');
  writeFileSync(flowPath, 'name: hand-edited\nsteps:\n  - assertVisible: "Edited"\n');
  writeFileSync(compiledPath, compiledYaml);
  const flow: CompiledFlowInfo = {
    name: 'smoke',
    slug: 'smoke',
    ok: true,
    flowPath,
    compiledPath,
    replayPath: compiledPath,
    errors: [],
    keptEditedFlow: true,
    newOutputPath: `${flowPath}.new`,
  };
  return {
    skipped: false,
    name: 'smoke',
    audit: { durable: 1, semi: 0, brittle: 0, brittlePct: 0, entries: [] },
    compiledFlows: [flow],
    suiteRunnable: true,
    readinessLabels: [],
    written: [],
    pages: [],
    testCases: [],
    variables: [],
  } as unknown as SuiteGenerationResult;
}

beforeEach(() => {
  state.runs = [];
  session.mutations = [];
});

describe('suite replay', () => {
  it('replays the compiled output, not the kept hand-edited flows/ copy', async () => {
    state.res = generated('name: generated\nsteps:\n  - assertVisible: "Home"\n');
    const r = await runSuiteGenerate(sessions as never, { sessionId: 's1', replay: 'same_session' });
    expect(r.isError).toBeFalsy();
    expect(state.runs.map((x) => x.flow.name)).toEqual(['generated']);
    expect(state.runs[0].opts.mutationConsent).toMatchObject({ required: false });
  });

  it('a replayed flow with a seed step needs flow_mutation_run consent first, then runs with it', async () => {
    state.res = generated('name: generated\nsteps:\n  - seed: evil\n');
    const first = await runSuiteGenerate(sessions as never, { sessionId: 's1', replay: 'same_session' });
    const s = first.structuredContent as Record<string, unknown>;
    expect(s).toMatchObject({ requiresConsent: true, action: 'flow_mutation_run', risk: 'high' });
    expect(String(s.exactCommand)).toContain('./seed.sh');
    expect(state.runs).toHaveLength(0);
    expect(session.mutations.at(-1)).toMatchObject({ action: 'flow_mutation_run', status: 'requested' });

    const second = await runSuiteGenerate(sessions as never, {
      sessionId: 's1',
      replay: 'same_session',
      consentId: s.consentId as string,
      approve: true,
    });
    expect(second.isError).toBeFalsy();
    expect(state.runs.map((x) => x.flow.name)).toEqual(['generated']);
    expect(state.runs[0].opts.mutationConsent).toMatchObject({ required: true, approved: true, consentId: s.consentId });
    expect(session.mutations.at(-1)).toMatchObject({ action: 'flow_mutation_run', status: 'approved' });
  });

  it('a replayed flow whose only mutating step is restartApp runs without a prompt', async () => {
    state.res = generated('name: generated\nappId: com.acme.app\nsteps:\n  - restartApp\n  - assertVisible: "Home"\n');
    const r = await runSuiteGenerate(sessions as never, { sessionId: 's1', replay: 'same_session' });
    expect((r.structuredContent as Record<string, unknown>).requiresConsent).toBeUndefined();
    expect(state.runs.map((x) => x.flow.name)).toEqual(['generated']);
  });

  it('dry_run never runs flows or asks for consent', async () => {
    state.res = generated('name: generated\nsteps:\n  - seed: evil\n');
    const r = await runSuiteGenerate(sessions as never, { sessionId: 's1', replay: 'dry_run' });
    expect((r.structuredContent as Record<string, unknown>).requiresConsent).toBeUndefined();
    expect(state.runs).toHaveLength(0);
  });
});
