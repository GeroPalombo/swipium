// SWIP-04: `swipium init codex --apply` must never write the literal "<your repo>"
// placeholder into ~/.codex/config.toml. The block gets the real cwd (from --cwd or the
// invocation directory), and apply refuses outright when that cwd does not exist.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `--apply` ends with a live `swipium verify` (spawns dist/index.js) — stub it out.
const verifyMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/cli/verify.js', () => ({ runVerify: verifyMock }));

const {
  claudeAddArgs,
  codexBlock,
  geminiAddArgs,
  geminiBlock,
  isEphemeralInstall,
  mergeServerJson,
  resolveTargetCwd,
  runInit,
  serverCommand,
} = await import('../src/cli/init.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cli init cwd handling', () => {
  it('codexBlock embeds the resolved cwd, never the placeholder', () => {
    const block = codexBlock('/usr/bin/node', '/Users/me/my-app');
    expect(block).toContain('cwd = "/Users/me/my-app"');
    expect(block).not.toContain('<your repo>');
  });

  it('geminiBlock embeds the resolved cwd, never the placeholder', () => {
    const block = geminiBlock('/usr/bin/node', '/Users/me/my-app');
    expect(block).toContain('"cwd": "/Users/me/my-app"');
    expect(block).not.toContain('<your repo>');
  });

  it('resolveTargetCwd defaults to process.cwd() and resolves --cwd', () => {
    expect(resolveTargetCwd(['codex'])).toBe(resolve(process.cwd()));
    expect(resolveTargetCwd(['codex', '--cwd', 'sub/dir'])).toBe(resolve(process.cwd(), 'sub/dir'));
    expect(resolveTargetCwd(['codex', '--cwd', '/abs/dir'])).toBe(resolve('/abs/dir'));
  });

  it('refuses `init codex --apply` when the resolved cwd does not exist (nothing written)', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });

    const prevExitCode = process.exitCode;
    await runInit(['codex', '--apply', '--cwd', '/definitely/not/a/real/dir']);
    const exitCode = process.exitCode;
    process.exitCode = prevExitCode;

    expect(exitCode).toBe(2);
    const text = out.join('');
    expect(text).toContain('Refusing to apply');
    expect(text).toContain(resolve('/definitely/not/a/real/dir'));
    expect(text).not.toContain('Appended to');
  });
});

// D3: team-shared project files must be portable; machine-local registrations may use absolute paths.
describe('cli init portability + new clients', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'swipium-init-'));

  function capture(): string[] {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    return out;
  }

  it('claude --scope project uses npx -y swipium; local/user keep the absolute node path', () => {
    expect(claudeAddArgs('project', '/opt/node/bin/node', '/x/dist/index.js')).toEqual([
      'mcp',
      'add',
      'swipium',
      '--scope',
      'project',
      '--',
      'npx',
      '-y',
      'swipium',
    ]);
    expect(claudeAddArgs('local', '/opt/node/bin/node', '/x/dist/index.js')).toEqual([
      'mcp',
      'add',
      'swipium',
      '--',
      '/opt/node/bin/node',
      '/x/dist/index.js',
    ]);
    expect(claudeAddArgs('user', '/opt/node/bin/node', '/x/dist/index.js')).toContain('/opt/node/bin/node');
  });

  it('never embeds an npx-cache script path (it is ephemeral)', () => {
    const cached = '/Users/me/.npm/_npx/abc123/node_modules/swipium/dist/index.js';
    expect(isEphemeralInstall(cached)).toBe(true);
    expect(serverCommand(false, '/opt/node', cached)).toEqual({ command: 'npx', args: ['-y', 'swipium'] });
    expect(claudeAddArgs('user', '/opt/node', cached)).not.toContain(cached);
  });

  it('gemini defaults to a portable project registration and puts -y after --', () => {
    expect(geminiAddArgs('local', '/opt/node', '/x/dist/index.js')).toEqual([
      'mcp',
      'add',
      '--scope',
      'project',
      'swipium',
      'npx',
      '--',
      '-y',
      'swipium',
    ]);
    expect(geminiAddArgs('user', '/opt/node', '/x/dist/index.js')).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      'swipium',
      '/opt/node',
      '/x/dist/index.js',
    ]);
  });

  it('codexBlock sets startup/tool timeouts and is valid-looking TOML', () => {
    const block = codexBlock('/usr/bin/node', '/Users/me/my-app', '/x/dist/index.js');
    expect(block).toContain('startup_timeout_sec = 30');
    expect(block).toContain('tool_timeout_sec = 600');
    expect(block).toContain('args = ["/x/dist/index.js"]');
  });

  it('codex preview offers `codex mcp add` and names the Desktop-specific caveat', async () => {
    const out = capture();
    await runInit(['codex', '--cwd', tmpRoot]);
    const text = out.join('');
    expect(text).toContain('codex mcp add swipium');
    expect(text).toContain('#19425');
    expect(text).toContain('Desktop');
    expect(text).not.toMatch(/has no .?mcp add/);
  });

  it('mergeServerJson adds without clobbering, is idempotent, and refuses JSONC/garbage', () => {
    const entry = { command: 'npx', args: ['-y', 'swipium'] };
    const fresh = mergeServerJson(null, 'servers', entry);
    expect(fresh.status).toBe('added');
    const existing = JSON.stringify({ inputs: [1], servers: { other: { command: 'x' } } });
    const merged = mergeServerJson(existing, 'servers', entry);
    expect(merged.status).toBe('added');
    const doc = JSON.parse((merged as { json: string }).json);
    expect(doc.inputs).toEqual([1]);
    expect(doc.servers.other).toEqual({ command: 'x' });
    expect(doc.servers.swipium).toEqual(entry);
    expect(mergeServerJson((merged as { json: string }).json, 'servers', entry).status).toBe('present');
    expect(mergeServerJson('{ // comment\n}', 'servers', entry).status).toBe('invalid');
    expect(mergeServerJson('{"servers": []}', 'servers', entry).status).toBe('invalid');
  });

  it('init vscode previews by default and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'vs-'));
    const out = capture();
    await runInit(['vscode', '--cwd', dir]);
    expect(existsSync(join(dir, '.vscode', 'mcp.json'))).toBe(false);
    const text = out.join('');
    expect(text).toContain('"servers"');
    expect(text).toContain('${workspaceFolder}');
    expect(text).toContain('code --add-mcp');
  });

  it('init vscode --apply merges .vscode/mcp.json under top-level "servers"', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'vs-'));
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'mcp.json'), JSON.stringify({ servers: { keep: { command: 'k' } } }));
    capture();
    await runInit(['vscode', '--apply', '--cwd', dir]);
    const doc = JSON.parse(readFileSync(join(dir, '.vscode', 'mcp.json'), 'utf8'));
    expect(doc.servers.keep).toEqual({ command: 'k' });
    expect(doc.servers.swipium).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', 'swipium'] });
    expect(doc.mcpServers).toBeUndefined();
    expect(verifyMock).toHaveBeenCalled();
  });

  it('init cursor --apply creates .cursor/mcp.json with mcpServers + ${workspaceFolder}', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'cur-'));
    capture();
    await runInit(['cursor', '--apply', '--cwd', dir]);
    const doc = JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8'));
    expect(doc.mcpServers.swipium.env.SWIPIUM_PROJECT_ROOT).toBe('${workspaceFolder}');
  });

  it('init cursor --apply refuses to touch a JSONC file it cannot merge safely', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'cur-'));
    mkdirSync(join(dir, '.cursor'));
    const original = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    writeFileSync(join(dir, '.cursor', 'mcp.json'), original);
    const out = capture();
    const prev = process.exitCode;
    await runInit(['cursor', '--apply', '--cwd', dir]);
    const code = process.exitCode;
    process.exitCode = prev;
    expect(code).toBe(2);
    expect(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')).toBe(original);
    expect(out.join('')).toContain('Refusing to modify');
  });

  it('unknown clients print usage (including cursor/vscode) and exit 2', async () => {
    const out = capture();
    const prev = process.exitCode;
    await runInit(['windsurf']);
    const code = process.exitCode;
    process.exitCode = prev;
    expect(code).toBe(2);
    expect(out.join('')).toContain('cursor|vscode');
  });
});
