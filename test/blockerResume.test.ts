// H1 — qa_continue_from_blocker must resume a monorepo_target answer as a PROJECT ROOT (not a
// device), resolve relative candidates against the session root, validate the directory exists,
// only emit args qa_test_this's schema accepts, and report everything else as `ignored` instead
// of silently dropping it. Hermetic: HOME points at a temp dir before the store loads.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-test-home-'));
process.env.HOME = fakeHome;

const { SessionStore } = await import('../src/session/store.js');
const { registerAgentTools, mapBlockerChoices, TEST_THIS_RESUME_KEYS } = await import('../src/tools/agent.js');

const projectRoot = mkdtempSync(join(tmpdir(), 'swipium-test-mono-'));
mkdirSync(join(projectRoot, 'apps', 'mobile'), { recursive: true });

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

type Handler = (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
function captureTools(register: (server: never) => void): Map<string, { schema: Record<string, unknown>; handler: Handler }> {
  const tools = new Map<string, { schema: Record<string, unknown>; handler: Handler }>();
  const fake = {
    registerTool: (name: string, cfg: { inputSchema?: Record<string, unknown> }, handler: Handler) => {
      tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
    },
  };
  register(fake as never);
  return tools;
}

describe('mapBlockerChoices (H1)', () => {
  it('maps a monorepo target to projectRoot (resolved against the session root), never to device', () => {
    const m = mapBlockerChoices('monorepo_target', { target: 'apps/mobile' }, projectRoot);
    expect(m.error).toBeUndefined();
    expect(m.args).toEqual({ projectRoot: join(projectRoot, 'apps', 'mobile') });
    expect(m.args.device).toBeUndefined();
  });

  it('rejects a monorepo target that does not exist', () => {
    const m = mapBlockerChoices('monorepo_target', { target: 'apps/nope' }, projectRoot);
    expect(m.error).toMatch(/not an existing directory/);
  });

  it('rejects monorepo targets outside the project root (/, ~, absolute or ../ escapes); the root itself is fine', () => {
    for (const target of ['/', '~', '~/', tmpdir(), '..', join(projectRoot, '..')]) {
      const m = mapBlockerChoices('monorepo_target', { target }, projectRoot);
      expect(m.error, target).toMatch(/outside the project root|no ~ paths/);
      expect(m.projectRoot, target).toBeUndefined();
    }
    expect(mapBlockerChoices('monorepo_target', { target: '.' }, projectRoot).error).toBeUndefined();
    expect(mapBlockerChoices('monorepo_target', { target: join(projectRoot, 'apps', 'mobile') }, projectRoot).error).toBeUndefined();
  });

  it('keeps target → device for non-monorepo kinds', () => {
    expect(mapBlockerChoices('preferred_platform', { target: 'emulator-5554' }, projectRoot).args).toEqual({ device: 'emulator-5554' });
  });

  it('reports values qa_test_this does not accept as ignored (never silently dropped)', () => {
    const m = mapBlockerChoices('signing_team', { developmentTeam: 'ABCDE12345', provisioningProfile: 'Dev' }, projectRoot);
    expect(m.args).toEqual({});
    expect(m.ignored.map((i) => i.field).sort()).toEqual(['developmentTeam', 'provisioningProfile']);
    expect(m.ignored.find((i) => i.field === 'developmentTeam')?.howToApply).toMatch(/ios\.wda\.developmentTeam/);
    const svc = mapBlockerChoices('external_service_required', { serviceEndpoint: 'https://staging' }, projectRoot);
    expect(svc.ignored[0]).toMatchObject({ field: 'serviceEndpoint' });
    const unknown = mapBlockerChoices('preferred_platform', { whatever: 'x' }, projectRoot);
    expect(unknown.ignored[0]).toMatchObject({ field: 'whatever' });
  });

  it('maps approveDestructive and coerces allowOutsideRoot', () => {
    expect(mapBlockerChoices('destructive_exploration_approval', { approveDestructive: 'true' }, projectRoot).approveDestructive).toBe(
      true,
    );
    expect(mapBlockerChoices('artifact_outside_root', { allowOutsideRoot: 'true' }, projectRoot).args).toEqual({ allowOutsideRoot: true });
  });
});

describe('qa_continue_from_blocker end-to-end (H1)', () => {
  const store = new SessionStore();
  const tools = captureTools((s) => registerAgentTools(s, store));
  const cont = tools.get('qa_continue_from_blocker')!.handler;

  it('monorepo resume: re-invokes qa_test_this with projectRoot and adopts it as the session root', async () => {
    const s = store.create(projectRoot);
    const r = await cont({ sessionId: s.id, kind: 'monorepo_target', values: { target: 'apps/mobile' } });
    const sc = r.structuredContent!;
    const next = sc.nextAction as { tool: string; args: Record<string, unknown> };
    const chosen = join(projectRoot, 'apps', 'mobile');
    expect(next.tool).toBe('qa_test_this');
    expect(next.args).toMatchObject({ sessionId: s.id, projectRoot: chosen, mode: 'execute' });
    expect(next.args.device).toBeUndefined();
    // qa_test_this reads an existing session's root from the session, so it must be adopted.
    expect(store.get(s.id)?.root).toBe(chosen);
    expect(sc.ignored).toEqual([]);
  });

  it('monorepo resume with a bad target is a typed error, not a silent device arg', async () => {
    const s = store.create(projectRoot);
    const r = await cont({ sessionId: s.id, kind: 'monorepo_target', values: { target: '../../etc-nope' } });
    expect(r.isError).toBe(true);
    expect(store.get(s.id)?.root).toBe(projectRoot);
  });

  it('monorepo resume pointing outside the root is a typed INVALID_ARGUMENT and keeps the root', async () => {
    const s = store.create(projectRoot);
    const r = await cont({ sessionId: s.id, kind: 'monorepo_target', values: { target: '/' } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent!.failureCode).toBe('INVALID_ARGUMENT');
    expect(store.get(s.id)?.root).toBe(projectRoot);
  });

  it('signing resume surfaces ignored fields in the result', async () => {
    const s = store.create(projectRoot);
    const r = await cont({ sessionId: s.id, kind: 'signing_team', values: { developmentTeam: 'ABCDE12345' } });
    const sc = r.structuredContent!;
    expect((sc.ignored as Array<{ field: string }>).map((i) => i.field)).toEqual(['developmentTeam']);
    expect((sc.nextAction as { args: Record<string, unknown> }).args.developmentTeam).toBeUndefined();
  });

  it('approved destructive exploration resumes via qa_explore dry run (qa_test_this has no such switch)', async () => {
    const s = store.create(projectRoot);
    const r = await cont({ sessionId: s.id, kind: 'destructive_exploration_approval', values: { approveDestructive: true } });
    expect(r.structuredContent!.nextAction).toMatchObject({
      tool: 'qa_explore',
      args: { sessionId: s.id, safeMode: 'dry_run_destructive' },
    });
  });

  it('every resume key is accepted by qa_test_this’s real input schema (lockstep)', async () => {
    const { registerTestThis } = await import('../src/tools/testThis.js');
    const t = captureTools((s) => registerTestThis(s, store));
    const schemaKeys = Object.keys(t.get('qa_test_this')!.schema);
    for (const k of [...TEST_THIS_RESUME_KEYS, 'sessionId', 'mode', 'stopOnNeedsInput']) expect(schemaKeys).toContain(k);
    const { registerExplore } = await import('../src/tools/explore.js');
    const e = captureTools((s) => registerExplore(s, store));
    expect(Object.keys(e.get('qa_explore')!.schema)).toContain('safeMode');
  });
});

describe('monorepo root chosen as the target does not re-ask forever (H1)', () => {
  it('qa_test_this plan asks once, then honors the monorepo_target answer for the root app itself', async () => {
    const { writeFileSync } = await import('node:fs');
    const { handleTestThis } = await import('../src/orchestration/testThis/plan.js');
    const mono = mkdtempSync(join(tmpdir(), 'swipium-test-monoroot-'));
    try {
      const expoPkg = (name: string, extra: Record<string, unknown> = {}) =>
        JSON.stringify({ name, dependencies: { expo: '51.0.0', 'react-native': '0.74.0' }, ...extra });
      writeFileSync(join(mono, 'package.json'), expoPkg('root-app', { workspaces: ['apps/*'] }));
      writeFileSync(join(mono, 'app.json'), JSON.stringify({ expo: { name: 'root', android: { package: 'com.example.root' } } }));
      for (const sib of ['admin', 'kiosk']) {
        mkdirSync(join(mono, 'apps', sib), { recursive: true });
        writeFileSync(join(mono, 'apps', sib, 'package.json'), expoPkg(sib));
        writeFileSync(
          join(mono, 'apps', sib, 'app.json'),
          JSON.stringify({ expo: { name: sib, android: { package: `com.example.${sib}` } } }),
        );
      }
      const store = new SessionStore();
      const server = {} as never;
      const s = store.create(mono);
      const first = await handleTestThis(server, store, { sessionId: s.id, mode: 'plan' });
      expect(first.structuredContent).toMatchObject({ needsInput: true, kind: 'monorepo_target' });

      const cont = captureTools((srv) => registerAgentTools(srv, store)).get('qa_continue_from_blocker')!.handler;
      const r = await cont({ sessionId: s.id, kind: 'monorepo_target', values: { target: mono } });
      expect(store.get(s.id)?.chosenTarget).toBe(mono);
      const args = (r.structuredContent!.nextAction as { args: Record<string, unknown> }).args;

      const second = await handleTestThis(server, store, { ...args, mode: 'plan' } as never);
      expect((second.structuredContent as { kind?: string }).kind).not.toBe('monorepo_target');
    } finally {
      rmSync(mono, { recursive: true, force: true });
    }
  }, 60_000);
});
