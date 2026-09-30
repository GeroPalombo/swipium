// `swipium init <client> [--apply] [--scope project|user|local] [--cwd <dir>]`
//
// Default = PREVIEW the exact registration (safe, no mutation). `--apply` executes it by
// DELEGATING to the client's own CLI where that is the documented path (claude/gemini
// `mcp add`), writing Codex's ~/.codex/config.toml (so the block carries cwd + timeouts, which
// `codex mcp add` cannot set), or merging a project file for Cursor (.cursor/mcp.json) and
// VS Code (.vscode/mcp.json). After a successful apply it runs `verify` (the server starts +
// tools inject).
//
// Portability: anything that lands in a TEAM-SHARED project file (`claude --scope project`,
// gemini project scope, .cursor/.vscode) uses `npx -y swipium`, never this machine's absolute
// node/script paths. Absolute paths are used only for machine-local registrations
// (claude local/user, gemini user, codex), and even then not when this process runs from the
// npx cache (that path is ephemeral).
//
// NOTE: this is the CLI path, not the MCP server, so writing to stdout is fine here.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { runVerify } from './verify.js';
import { initFlowTemplates } from '../flows/templates.js';

const SELF = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'); // dist/index.js

export const PORTABLE_COMMAND = { command: 'npx', args: ['-y', 'swipium'] } as const;

export interface ServerCommand {
  command: string;
  args: string[];
}

/** True when `self` lives in npm's npx cache (…/_npx/…). An absolute path to it would rot. */
export function isEphemeralInstall(self: string = SELF): boolean {
  return self.split(/[\\/]/).includes('_npx');
}

/** The command a client should run: portable `npx -y swipium`, or this machine's node + script. */
export function serverCommand(portable: boolean, node: string = process.execPath, self: string = SELF): ServerCommand {
  if (portable || isEphemeralInstall(self)) return { command: PORTABLE_COMMAND.command, args: [...PORTABLE_COMMAND.args] };
  return { command: node, args: [self] };
}

/** A delegated CLI registration succeeded only if it both ran and exited 0. */
export function applyOk(r: { error?: unknown; status: number | null }): boolean {
  return !r.error && r.status === 0;
}

/** Gemini settings.json entry (user scope: machine-local command + the app repo as cwd). */
export function geminiBlock(node: string, cwd: string, self: string = SELF): string {
  const c = serverCommand(false, node, self);
  return `  "swipium": { "command": ${JSON.stringify(c.command)}, "args": ${JSON.stringify(c.args)}, "cwd": ${JSON.stringify(cwd)}, "timeout": 600000 }`;
}

/** Codex keeps servers in ~/.codex/config.toml; its defaults (10 s startup, 60 s per tool) are too
 *  short for `npx` first runs and for device work (builds, boots, flows). */
export function codexBlock(node: string, cwd: string, self: string = SELF): string {
  const c = serverCommand(false, node, self);
  return [
    '[mcp_servers.swipium]',
    `command = ${JSON.stringify(c.command)}`,
    `args = [${c.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    `cwd = ${JSON.stringify(cwd)}`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 600',
  ].join('\n');
}

/** `claude mcp add` argv. Project scope writes the team-shared .mcp.json, so the command is portable. */
export function claudeAddArgs(scope: string, node: string = process.execPath, self: string = SELF): string[] {
  const c = serverCommand(scope === 'project', node, self);
  return ['mcp', 'add', 'swipium', ...(scope !== 'local' ? ['--scope', scope] : []), '--', c.command, ...c.args];
}

/** `gemini mcp add` argv. Gemini's default scope is project (.gemini/settings.json), so it's portable. */
export function geminiAddArgs(scope: string, node: string = process.execPath, self: string = SELF): string[] {
  const user = scope === 'user';
  const c = serverCommand(!user, node, self);
  // Gemini's parser would read `-y` as its own flag: server args that start with "-" go after `--`
  // (documented form: `gemini mcp add python-server python server.py -- --server-arg v`).
  const rest = c.args.some((x) => x.startsWith('-')) ? ['--', ...c.args] : c.args;
  return ['mcp', 'add', '--scope', user ? 'user' : 'project', 'swipium', c.command, ...rest];
}

/** Cursor: .cursor/mcp.json (`mcpServers`). ${workspaceFolder} is interpolated by Cursor. */
export function cursorEntry(): Record<string, unknown> {
  return {
    type: 'stdio',
    command: PORTABLE_COMMAND.command,
    args: [...PORTABLE_COMMAND.args],
    env: { SWIPIUM_PROJECT_ROOT: '${workspaceFolder}' },
  };
}

/** VS Code: .vscode/mcp.json uses a top-level `servers` object (not `mcpServers`). */
export function vscodeEntry(): Record<string, unknown> {
  return {
    type: 'stdio',
    command: PORTABLE_COMMAND.command,
    args: [...PORTABLE_COMMAND.args],
    env: { SWIPIUM_PROJECT_ROOT: '${workspaceFolder}' },
  };
}

export type MergeResult = { status: 'added'; json: string } | { status: 'present' } | { status: 'invalid'; reason: string };

/**
 * Merge `swipium` into an existing JSON config under `topKey` WITHOUT touching anything else.
 * Refuses (never overwrites) when the file isn't plain JSON (e.g. JSONC comments) or `topKey`
 * isn't an object; leaves an existing `swipium` entry as-is.
 */
export function mergeServerJson(existing: string | null, topKey: string, entry: Record<string, unknown>): MergeResult {
  let doc: Record<string, unknown> = {};
  if (existing !== null && existing.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { status: 'invalid', reason: 'top level is not a JSON object' };
      doc = parsed as Record<string, unknown>;
    } catch (e) {
      return {
        status: 'invalid',
        reason: `not valid JSON (${(e as Error).message}); comments/trailing commas are not merged automatically`,
      };
    }
  }
  const cur = doc[topKey];
  if (cur !== undefined && (typeof cur !== 'object' || cur === null || Array.isArray(cur))) {
    return { status: 'invalid', reason: `"${topKey}" is not an object` };
  }
  const servers = { ...((cur as Record<string, unknown> | undefined) ?? {}) };
  if (Object.prototype.hasOwnProperty.call(servers, 'swipium')) return { status: 'present' };
  servers.swipium = entry;
  return { status: 'added', json: `${JSON.stringify({ ...doc, [topKey]: servers }, null, 2)}\n` };
}

/** The app repo the server should run in: `--cwd <dir>` if given, else where init was invoked. */
export function resolveTargetCwd(args: string[]): string {
  const cwdIdx = args.indexOf('--cwd');
  return resolve(cwdIdx >= 0 ? (args[cwdIdx + 1] ?? '') : process.cwd());
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const CWD_NOTE = '(cwd should be your mobile app repo: run init from it, or pass --cwd <dir>)';

export const INIT_USAGE =
  'Usage: swipium init <claude|codex|gemini|cursor|vscode> [--apply] [--scope local|user|project] [--cwd <dir>]\n' +
  '       swipium init flows [--root <dir>] [--force]\n' +
  'Without --apply, prints the exact registration and changes nothing.\n';

/** Preview/apply a project-file registration (Cursor/VS Code). Returns false when refused. */
function projectFileInit(opts: {
  label: string;
  file: string;
  topKey: string;
  entry: Record<string, unknown>;
  apply: boolean;
  extraPreview?: string;
}): boolean {
  const { label, file, topKey, entry, apply } = opts;
  const snippet = JSON.stringify({ [topKey]: { swipium: entry } }, null, 2);
  if (!apply) {
    process.stdout.write(
      `Preview (run with --apply to merge into ${file}):\n${snippet}\n` +
        `SWIPIUM_PROJECT_ROOT uses \${workspaceFolder}, which ${label} expands to the open folder.\n` +
        (opts.extraPreview ?? ''),
    );
    return true;
  }
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const merged = mergeServerJson(existing, topKey, entry);
  if (merged.status === 'invalid') {
    process.stdout.write(`Refusing to modify ${file}: ${merged.reason}.\nAdd this under "${topKey}" by hand:\n${snippet}\n`);
    process.exitCode = 2;
    return false;
  }
  if (merged.status === 'present') {
    process.stdout.write(`Already present in ${file} (left unchanged).\n`);
    return true;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, merged.json);
  process.stdout.write(`${existing === null ? 'Created' : 'Merged into'} ${file}\n`);
  return true;
}

export async function runInit(args: string[]): Promise<void> {
  const client = (args[0] ?? '').toLowerCase();
  const apply = args.includes('--apply');
  const scopeIdx = args.indexOf('--scope');
  const scope = scopeIdx >= 0 ? (args[scopeIdx + 1] ?? 'local') : 'local';
  const node = process.execPath;

  if (client === 'flows') {
    const rootIdx = args.indexOf('--root');
    const root = rootIdx >= 0 ? resolve(args[rootIdx + 1]) : process.cwd();
    const force = args.includes('--force');
    const result = initFlowTemplates(root, { force });
    process.stdout.write(`Initialized Swipium flow templates under ${root}\n`);
    for (const f of result.files) {
      process.stdout.write(`  ${f.written ? 'wrote' : 'kept'} ${f.path}${f.skipped ? ' (--force to overwrite)' : ''}\n`);
    }
    process.stdout.write(
      '\nNext: edit selectors/variables, then validate with qa_flow_check and run with qa_flow_run from an MCP session.\n',
    );
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(INIT_USAGE);
    return;
  }

  if (!['claude', 'gemini', 'codex', 'cursor', 'vscode'].includes(client)) {
    process.stdout.write(INIT_USAGE);
    process.exitCode = 2;
    return;
  }
  if (!['local', 'user', 'project'].includes(scope)) {
    process.stdout.write(`Unknown --scope "${scope}" (expected local, user, or project).\n${INIT_USAGE}`);
    process.exitCode = 2;
    return;
  }

  const cwd = resolveTargetCwd(args);
  const refuseMissingCwd = (): boolean => {
    if (isDir(cwd)) return false;
    process.stdout.write(`Refusing to apply: cwd ${cwd} does not exist. Run init from your mobile app repo or pass --cwd <dir>.\n`);
    process.exitCode = 2;
    return true;
  };

  if (client === 'claude') {
    const cmd = claudeAddArgs(scope, node);
    const shared = scope === 'project' ? '\n(project scope writes .mcp.json for your team, so it uses the portable `npx -y swipium`.)' : '';
    if (apply) {
      const r = spawnSync('claude', cmd, { stdio: 'inherit', cwd: isDir(cwd) ? cwd : undefined });
      if (!applyOk(r)) {
        process.stdout.write(`claude registration failed (status ${r.status ?? 'n/a'}). Run manually:\n  claude ${cmd.join(' ')}\n`);
      } else {
        process.stdout.write('\nRegistered. Verifying the server starts + tools inject…\n');
        await runVerify();
      }
    } else {
      process.stdout.write(`Preview (run with --apply to execute):\n  claude ${cmd.join(' ')}${shared}\n`);
    }
  } else if (client === 'gemini') {
    const cmd = geminiAddArgs(scope, node);
    const manual =
      scope === 'user'
        ? `add to ~/.gemini/settings.json under "mcpServers":\n${geminiBlock(node, cwd)}\n${CWD_NOTE}`
        : `add to ${join(cwd, '.gemini', 'settings.json')} under "mcpServers":\n  "swipium": { "command": "npx", "args": ["-y", "swipium"], "timeout": 600000 }`;
    if (apply) {
      const r = spawnSync('gemini', cmd, { stdio: 'inherit', cwd: isDir(cwd) ? cwd : undefined });
      if (!applyOk(r)) {
        process.stdout.write(`gemini \`mcp add\` failed or unavailable. Instead, ${manual}\n`);
      } else {
        process.stdout.write('\nRegistered. Verifying…\n');
        await runVerify();
      }
    } else {
      process.stdout.write(`Preview (run with --apply):\n  gemini ${cmd.join(' ')}\nor ${manual}\n`);
    }
  } else if (client === 'codex') {
    // Written to config.toml directly (rather than `codex mcp add`) so the block carries cwd and
    // longer startup/tool timeouts, which `codex mcp add` has no flags for.
    const cfg = join(homedir(), '.codex', 'config.toml');
    const block = codexBlock(node, cwd);
    const c = serverCommand(false, node);
    const alt = `  codex mcp add swipium --env SWIPIUM_PROJECT_ROOT=${cwd} -- ${[c.command, ...c.args].join(' ')}\n  (then add startup_timeout_sec = 30 and tool_timeout_sec = 600 under [mcp_servers.swipium] in ${cfg})`;
    const caveat =
      '⚠ Codex Desktop threads may not expose tools from custom stdio MCP servers (openai/codex#19425, open). If the tools are missing in the Desktop app, try the Codex CLI.\n';
    if (apply) {
      if (refuseMissingCwd()) return;
      mkdirSync(dirname(cfg), { recursive: true });
      const cur = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
      if (cur.includes('[mcp_servers.swipium]')) {
        process.stdout.write(`Already present in ${cfg} (left unchanged). Expected block:\n${block}\n`);
      } else {
        appendFileSync(cfg, `\n${block}\n`);
        process.stdout.write(`Appended to ${cfg}\n`);
      }
      process.stdout.write(caveat + 'Server-side self-check:\n');
      await runVerify();
    } else {
      process.stdout.write(
        `Preview (run with --apply to append to ${cfg}):\n${block}\n${CWD_NOTE}\nor register with the Codex CLI:\n${alt}\n${caveat}`,
      );
    }
  } else if (client === 'cursor' || client === 'vscode') {
    const isCursor = client === 'cursor';
    if (scope === 'user') {
      process.stdout.write(
        `Note: init ${client} only writes the project file (${isCursor ? '.cursor/mcp.json' : '.vscode/mcp.json'}); ` +
          (isCursor
            ? 'for all projects, add the same entry to ~/.cursor/mcp.json.\n'
            : 'for your user profile use `code --add-mcp` (shown below).\n'),
      );
    }
    if (apply && refuseMissingCwd()) return;
    const ok = projectFileInit({
      label: isCursor ? 'Cursor' : 'VS Code',
      file: join(cwd, isCursor ? '.cursor' : '.vscode', 'mcp.json'),
      topKey: isCursor ? 'mcpServers' : 'servers',
      entry: isCursor ? cursorEntry() : vscodeEntry(),
      apply,
      extraPreview: isCursor
        ? undefined
        : `or add it to your VS Code user profile:\n  code --add-mcp '${JSON.stringify({ name: 'swipium', command: 'npx', args: ['-y', 'swipium'] })}'\n`,
    });
    if (!ok) return;
    if (apply) {
      process.stdout.write(
        `Reload ${isCursor ? 'Cursor' : 'VS Code'} (or its MCP server list) to start Swipium. Server-side self-check:\n`,
      );
      await runVerify();
    }
  }

  process.stdout.write('\nSelf-check anytime: swipium verify\n');
}
