// 2.3.0 guidance: the swipium-qa skill (one source, shipped files stay in sync), the MCP prompts
// built on it, `swipium init claude|codex` (skill install, SWIPIUM_MAX_WAIT_MS, --trust-local),
// qa_continue_from_blocker resuming directly (C5), qa_status groups (K5), and the registry and
// plugin manifests. Hermetic: HOME points at a temp dir before anything loads.

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-guidance-home-'));
process.env.HOME = fakeHome;

const verifyMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/cli/verify.js', () => ({ runVerify: verifyMock }));
const testThisMock = vi.hoisted(() => vi.fn());
vi.mock('../src/orchestration/testThis/plan.js', () => ({ handleTestThis: testThisMock }));

const { SKILL_MD, SKILL_NAME } = await import('../src/skills/content.js');
const { registerPrompts } = await import('../src/prompts/index.js');
const { orientation, registerAgentTools } = await import('../src/tools/agent.js');
const { claudeAddArgs, claudeEnv, runInit, skillPath, trustLocalActions } = await import('../src/cli/init.js');
const { CONSENT_ACTION_TIERS, peekConsent, requireConsent } = await import('../src/consent/consent.js');
const { SessionStore } = await import('../src/session/store.js');

const REPO = resolve(import.meta.dirname, '..');
const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  testThisMock.mockReset();
});
afterAll(() => {
  for (const d of [fakeHome, ...tmpDirs]) rmSync(d, { recursive: true, force: true });
});

function captureStdout(): string[] {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  return out;
}

describe('swipium-qa skill files', () => {
  const files = ['skills/swipium-qa/SKILL.md', 'plugin/skills/swipium-qa/SKILL.md'];
  it('every shipped SKILL.md equals SKILL_MD (SWIPIUM_UPDATE_SKILL=1 rewrites them)', () => {
    for (const f of files) {
      const abs = join(REPO, f);
      if (process.env.SWIPIUM_UPDATE_SKILL === '1') {
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, SKILL_MD);
      }
      expect(readFileSync(abs, 'utf8'), f).toBe(SKILL_MD);
    }
  });

  it('has skill frontmatter and the canonical guidance', () => {
    expect(SKILL_MD.startsWith(`---\nname: ${SKILL_NAME}\ndescription: `)).toBe(true);
    const front = parseYaml(SKILL_MD.split('---\n')[1]) as { name: string; description: string };
    expect(front.name).toBe(SKILL_NAME);
    expect(front.description).toMatch(/^Test a mobile app/);
    for (const s of [
      'qa_test_this {waitForCompletion:true}',
      'report.md',
      'flowYaml',
      'SWIPIUM_TEST_EMAIL',
      'qa_app_control',
      'open_url',
      'npx swipium report',
    ])
      expect(SKILL_MD, s).toContain(s);
    expect(SKILL_MD).not.toContain('qa_explain_blocker');
  });

  it('package.json ships skills/', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('skills');
  });
});

describe('MCP prompts', () => {
  type PromptCb = (a: Record<string, unknown>) => { messages: Array<{ content: { text: string } }> };
  const prompts = new Map<string, PromptCb>();
  registerPrompts({ registerPrompt: (name: string, _cfg: unknown, cb: PromptCb) => prompts.set(name, cb) } as never);
  const text = (name: string, a: Record<string, unknown> = {}) => prompts.get(name)!(a).messages[0].content.text;

  it('registers the workflow prompts, including test_feature and generate_suite', () => {
    expect([...prompts.keys()].sort()).toEqual(
      [
        'swipium_bug_repro',
        'swipium_convert_run_to_flow',
        'swipium_full_smoke',
        'swipium_generate_suite',
        'swipium_guardrail_validation',
        'swipium_setup_check',
        'swipium_test_feature',
      ].sort(),
    );
  });

  it('route through the autopilot with the exact first call', () => {
    expect(text('swipium_full_smoke')).toContain('qa_test_this { mode: "execute", goal: "smoke", waitForCompletion: true }');
    expect(text('swipium_bug_repro', { bug: 'cart empties' })).toContain('goal: "reproduce_bug", goalText: "cart empties"');
    expect(text('swipium_setup_check', { projectRoot: '/a' })).toContain('qa_test_this { mode: "plan", projectRoot: "/a" }');
    expect(text('swipium_test_feature', { feature: 'search' })).toContain('qa_test_feature { feature: "search", mode: "execute" }');
    expect(text('swipium_generate_suite')).toContain('goal: "create_automation_suite"');
  });

  it('share the skill guidance: report.md, batching, app control, credentials via env', () => {
    const repro = text('swipium_bug_repro', { bug: 'x' });
    expect(repro).toContain('report.md');
    expect(repro).toContain('qa_flow_run {sessionId, flowYaml}');
    expect(repro).toContain('qa_app_control');
    expect(text('swipium_full_smoke')).toContain('SWIPIUM_TEST_PASSWORD');
    for (const name of prompts.keys()) expect(text(name, { bug: 'x', feature: 'y' }), name).not.toContain('qa_explain_blocker');
  });
});

describe('qa_status orientation (K5)', () => {
  it('capabilityGroups carry names + purpose only', () => {
    const groups = orientation().capabilityGroups as Array<Record<string, unknown>>;
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) expect(Object.keys(g).sort()).toEqual(['group', 'purpose']);
    expect(orientation().firstCall.args).toMatchObject({ mode: 'execute', waitForCompletion: true });
  });
});

describe('swipium init claude|codex (S1, C1, C6)', () => {
  it('claude registration carries SWIPIUM_MAX_WAIT_MS=110000 as -e flags before --', () => {
    const argv = claudeAddArgs('user', '/n', '/x/dist/index.js', claudeEnv(false));
    expect(argv).toEqual(['mcp', 'add', 'swipium', '--scope', 'user', '-e', 'SWIPIUM_MAX_WAIT_MS=110000', '--', '/n', '/x/dist/index.js']);
  });

  it('--trust-local pre-approves exactly the non-code-running, pre-approvable actions', () => {
    const list = trustLocalActions();
    expect(list.length).toBeGreaterThan(0);
    for (const a of list) {
      expect(CONSENT_ACTION_TIERS[a].runsCode, a).toBe(false);
      expect(CONSENT_ACTION_TIERS[a].notPreapprovable, a).toBeUndefined();
    }
    for (const a of [
      'build_from_source',
      'start_metro',
      'wda_start',
      'wda_build',
      'flow_mutation_run',
      'wda_non_loopback',
      'destructive_ui_candidate',
    ])
      expect(list).not.toContain(a);
    expect(claudeEnv(true).SWIPIUM_CONSENT_PREAPPROVE).toBe(list.join(','));
  });

  it('--trust-local is refused for project scope (team-shared .mcp.json) and for other clients', async () => {
    for (const argv of [
      ['claude', '--trust-local', '--scope', 'project'],
      ['codex', '--trust-local'],
    ]) {
      const out = captureStdout();
      const prev = process.exitCode;
      await runInit(argv);
      const code = process.exitCode;
      process.exitCode = prev;
      expect(code, argv.join(' ')).toBe(2);
      expect(out.join('')).not.toContain('claude mcp add');
    }
  });

  it('claude preview shows the env and the skill path, and writes nothing', async () => {
    const app = tmp('swipium-guidance-app-');
    const out = captureStdout();
    await runInit(['claude', '--trust-local', '--cwd', app]);
    const text = out.join('');
    expect(text).toContain('-e SWIPIUM_MAX_WAIT_MS=110000');
    expect(text).toContain('-e SWIPIUM_CONSENT_PREAPPROVE=');
    expect(text).toContain(join(app, '.claude', 'skills', 'swipium-qa', 'SKILL.md'));
    expect(existsSync(join(app, '.claude'))).toBe(false);
  });

  it('skill paths follow the client and scope', () => {
    expect(skillPath('claude', 'user', '/app')).toBe(join(fakeHome, '.claude', 'skills', 'swipium-qa', 'SKILL.md'));
    expect(skillPath('claude', 'project', '/app')).toBe(join('/app', '.claude', 'skills', 'swipium-qa', 'SKILL.md'));
    expect(skillPath('codex', 'local', '/app')).toBe(join('/app', '.agents', 'skills', 'swipium-qa', 'SKILL.md'));
  });

  it('init codex --apply installs the skill into <cwd>/.agents/skills; codex config gets no wait override', async () => {
    const app = tmp('swipium-guidance-codex-app-');
    const codexHome = tmp('swipium-guidance-codex-home-');
    const prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      captureStdout();
      await runInit(['codex', '--apply', '--cwd', app]);
      expect(readFileSync(join(app, '.agents', 'skills', 'swipium-qa', 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).not.toContain('SWIPIUM_MAX_WAIT_MS=');
      await runInit(['codex', '--apply', '--no-skill', '--cwd', tmp('swipium-guidance-noskill-')]);
    } finally {
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
    }
  });
});

describe('qa_continue_from_blocker resumes directly (C5)', () => {
  type Handler = (a: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; content?: unknown[] }>;
  const store = new SessionStore();
  const tools = new Map<string, Handler>();
  registerAgentTools({ registerTool: (n: string, _c: unknown, h: Handler) => tools.set(n, h) } as never, store);
  const cont = tools.get('qa_continue_from_blocker')!;
  const root = tmp('swipium-guidance-root-');
  const prepared = () => {
    const s = store.create(root);
    s.device = 'emulator-5554';
    s.appId = 'com.example.app';
    return s;
  };

  it('a prepared session with no new consent: starts the job and returns its jobId', async () => {
    const s = prepared();
    testThisMock.mockResolvedValue({
      content: [{ type: 'text', text: 'started' }],
      structuredContent: { state: 'running', jobId: 'job-1' },
    });
    const r = await cont({ sessionId: s.id, kind: 'credentials', values: { email: 'qa@example.com', password: 'pw-123456' } });
    expect(testThisMock).toHaveBeenCalledTimes(1);
    expect(testThisMock.mock.calls[0][2]).toMatchObject({ sessionId: s.id, mode: 'execute', stopOnNeedsInput: false });
    expect(r.structuredContent).toMatchObject({
      resumed: true,
      jobId: 'job-1',
      nextAction: { tool: 'qa_job_status', args: { jobId: 'job-1' } },
    });
    expect(r.structuredContent!.tip).toMatch(/SWIPIUM_TEST_EMAIL/);
    expect(JSON.stringify(r)).not.toContain('pw-123456');
  });

  it('when the re-run needs a new consent: the challenge is burned and the call comes back as nextAction', async () => {
    const s = prepared();
    let consentId = '';
    testThisMock.mockImplementation(async () => {
      const res = requireConsent({ action: 'test_this_plan', risk: 'low', explain: 'x', affects: {} } as never);
      consentId = (res.structuredContent as { consentId: string }).consentId;
      return res;
    });
    const r = await cont({ sessionId: s.id, kind: 'preferred_platform', values: { platform: 'android' } });
    expect(peekConsent(consentId)).toBeUndefined();
    expect(r.structuredContent!.resumed).toBeUndefined();
    expect(r.structuredContent!.nextAction).toMatchObject({ tool: 'qa_test_this', args: { platform: 'android' } });
  });

  it('an unprepared session never auto-runs (its boot/install needs consent)', async () => {
    const s = store.create(root);
    const r = await cont({ sessionId: s.id, kind: 'credentials', values: { choice: 'test pre-login only' } });
    expect(testThisMock).not.toHaveBeenCalled();
    expect(r.structuredContent!.nextAction).toMatchObject({ tool: 'qa_test_this' });
  });
});

describe('registry + plugin manifests (D2, C6)', () => {
  const json = (f: string) => JSON.parse(readFileSync(join(REPO, f), 'utf8')) as Record<string, unknown>;

  it('server.json matches package.json (mcpName, npm identifier, version)', () => {
    const pkg = json('package.json') as { name: string; version: string; mcpName: string };
    const srv = json('server.json') as {
      name: string;
      description: string;
      version: string;
      packages: Array<{ identifier: string; version: string }>;
    };
    expect(srv.name).toBe(pkg.mcpName);
    expect(srv.description.length).toBeLessThanOrEqual(100);
    expect(srv.packages[0].identifier).toBe(pkg.name);
    expect(srv.packages[0].version).toBe(srv.version);
    expect(srv.version).toBe(pkg.version);
    expect(json('plugin/.claude-plugin/plugin.json').version).toBe(pkg.version);
  });

  it('the repo-root marketplace lists the plugin', () => {
    const market = json('.claude-plugin/marketplace.json') as { name: string; plugins: Array<{ name: string; source: string }> };
    expect(market.plugins).toContainEqual(expect.objectContaining({ name: 'swipium', source: './plugin' }));
  });

  it('the Claude Code plugin registers the server via npx and never pre-approves consent', () => {
    expect(json('plugin/.claude-plugin/plugin.json').name).toBe('swipium');
    const mcp = json('plugin/.mcp.json') as { mcpServers: { swipium: { command: string; args: string[]; env: Record<string, string> } } };
    expect(mcp.mcpServers.swipium).toMatchObject({ command: 'npx', args: ['-y', 'swipium'] });
    expect(mcp.mcpServers.swipium.env.SWIPIUM_MAX_WAIT_MS).toBe('110000');
    expect(JSON.stringify(mcp)).not.toContain('SWIPIUM_CONSENT_PREAPPROVE');
  });
});
