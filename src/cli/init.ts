// `swipium init <client> [--apply] [--scope project|user|local] [--cwd <dir>]`
//
// Default = PREVIEW the exact registration (safe, no mutation). `--apply` executes it by
// DELEGATING to the client's own CLI where that is the documented path (claude/gemini
// `mcp add`), writing Codex's ~/.codex/config.toml (so the block carries cwd, timeouts and env_vars, which
// `codex mcp add` cannot set), or merging a project file for Cursor (.cursor/mcp.json) and
// VS Code (.vscode/mcp.json). After a successful apply it runs `verify` (the server starts +
// tools inject). `claude` and `codex` also install the swipium-qa agent skill (src/skills/content.ts)
// unless --no-skill; `claude --trust-local` pre-approves the consent actions that run no repo code.
//
// Portability: anything that lands in a TEAM-SHARED project file (`claude --scope project`,
// gemini project scope, .cursor/.vscode) uses `npx -y swipium`, never this machine's absolute
// node/script paths. Absolute paths are used only for machine-local registrations
// (claude local/user, gemini user, codex), and even then not when this process runs from the
// npx cache (that path is ephemeral).
//
// NOTE: this is the CLI path, not the MCP server, so writing to stdout is fine here.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, delimiter } from 'node:path';
import { runVerify } from './verify.js';
import { initFlowTemplates } from '../flows/templates.js';
import { codexEnvVarsLine } from '../lib/codexEnv.js';
import { codexCoreTools } from '../core/capabilityGroups.js';
import { CONSENT_ACTIONS, CONSENT_ACTION_TIERS, PREAPPROVE_ENV } from '../consent/consent.js';
import { SKILL_MD, SKILL_NAME } from '../skills/content.js';

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

export interface StableNodeDeps {
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
}

/**
 * A node path that survives upgrades. Homebrew's process.execPath is the versioned Cellar path
 * (/opt/homebrew/Cellar/node@20/20.19.6/bin/node), which disappears on `brew upgrade`. Prefer:
 * 1. the Homebrew `opt` symlink for that formula ($prefix/opt/<formula>/bin/node) when it exists;
 * 2. the first `node` on PATH that resolves (realpath) to this same binary;
 * 3. execPath itself.
 */
export function stableNodePath(execPath: string = process.execPath, deps: StableNodeDeps = {}): string {
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p));
  const real = (p: string): string | null => {
    try {
      return realpath(p);
    } catch {
      return null;
    }
  };
  const cellar = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (cellar) {
    const opt = `${cellar[1]}/opt/${cellar[2]}/bin/node`;
    if (exists(opt)) return opt;
  }
  const self = real(execPath) ?? execPath;
  const win = (deps.platform ?? process.platform) === 'win32';
  for (const dir of (deps.pathEnv ?? process.env.PATH ?? '').split(win ? ';' : delimiter)) {
    if (!dir) continue;
    const cand = join(dir, win ? 'node.exe' : 'node');
    if (cand === execPath) return execPath;
    if (exists(cand) && real(cand) === self) return cand;
  }
  return execPath;
}

/** A delegated CLI registration succeeded only if it both ran and exited 0. */
export function applyOk(r: { error?: unknown; status: number | null }): boolean {
  return !r.error && r.status === 0;
}

/** Gemini's per-server tool timeout (ms), written by both the `gemini mcp add` and the settings.json path. */
export const GEMINI_TIMEOUT_MS = 600000;

/** Gemini settings.json entry (user scope: machine-local command). No cwd: the user file serves every
 *  project, so pinning one app's directory would make all of them test it. Gemini starts the
 *  server in the directory you run gemini from, which is then the project root. */
export function geminiBlock(node: string, self: string = SELF): string {
  const c = serverCommand(false, node, self);
  return `  "swipium": { "command": ${JSON.stringify(c.command)}, "args": ${JSON.stringify(c.args)}, "timeout": ${GEMINI_TIMEOUT_MS} }`;
}

// The core tool set (also SWIPIUM_TOOLS=core in src/server.ts) lives with the capability groups,
// so the server does not load this CLI module (and the MCP client SDK it pulls in) at startup.
export { CODEX_CORE_GROUPS, CODEX_CORE_EXTRA_TOOLS, codexCoreTools } from '../core/capabilityGroups.js';

// `[mcp_servers.swipium]`, also spaced (`[ mcp_servers . swipium ]`) or quoted (`"swipium"`, `'swipium'`).
const SWIPIUM_KEY = `(?:"swipium"|'swipium'|swipium)`;
const CODEX_BLOCK_HEADER = new RegExp(`^[ \\t]*\\[[ \\t]*mcp_servers[ \\t]*\\.[ \\t]*${SWIPIUM_KEY}[ \\t]*\\][ \\t]*(?:#.*)?$`, 'm');

/** A swipium server written with dotted keys instead of its own table:
 *  `mcp_servers.swipium.command = …` at the top level, or `swipium.command = …` / `swipium = {…}`
 *  under `[mcp_servers]`. Appending a table then makes Codex fail with "duplicate key". */
export function hasCodexDottedServer(toml: string): boolean {
  let table = '';
  for (const line of toml.split(/\r?\n/)) {
    const h = /^[ \t]*\[([^[\]]*)\][ \t]*(?:#.*)?$/.exec(line);
    if (h) {
      table = h[1].replace(/[ \t]/g, '');
      continue;
    }
    if (table === '' && new RegExp(`^[ \\t]*mcp_servers[ \\t]*\\.[ \\t]*${SWIPIUM_KEY}[ \\t]*[.=]`).test(line)) return true;
    if (table === 'mcp_servers' && new RegExp(`^[ \\t]*${SWIPIUM_KEY}[ \\t]*[.=]`).test(line)) return true;
  }
  return false;
}

/** The existing [mcp_servers.swipium] table in a config.toml (header to the next table), or null. */
export function findCodexServerBlock(toml: string): string | null {
  const m = CODEX_BLOCK_HEADER.exec(toml);
  if (!m) return null;
  const rest = toml.slice(m.index + m[0].length);
  const next = /^[ \t]*\[/m.exec(rest);
  return m[0] + (next ? rest.slice(0, next.index) : rest);
}

/** True when that table already sets env_vars. */
export function codexBlockHasEnvVars(block: string): boolean {
  return /^[ \t]*env_vars[ \t]*=/m.test(block);
}

/** Raw value of `key = value` in a TOML table body (first match; trailing comment stripped), or null. */
function tomlValue(block: string, key: string): string | null {
  const m = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.+)$`, 'm').exec(block);
  if (!m) return null;
  return m[1].replace(/[ \t]+#[^"']*$/, '').trim();
}

/** Compare TOML scalar/array text loosely: JSON-parse when possible ('…' strings become "…"). */
function tomlNormalize(v: string): string {
  const t = v.trim().replace(/^'([^']*)'$/, (_m, x: string) => JSON.stringify(x));
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return t.replace(/\s+/g, '');
  }
}

/** What an existing [mcp_servers.swipium] table lacks or sets differently from `expected`
 *  (command, args, cwd, timeouts, env_vars). Each item is one human-readable line. */
export function codexBlockDiff(existing: string, expected: string): string[] {
  const out: string[] = [];
  for (const key of ['command', 'args', 'cwd']) {
    const want = tomlValue(expected, key);
    const have = tomlValue(existing, key);
    if (want == null) continue;
    if (have == null) out.push(`${key} is missing (expected ${key} = ${want})`);
    else if (tomlNormalize(have) !== tomlNormalize(want))
      out.push(`${key} = ${have} differs (expected ${key} = ${want})${key === 'cwd' ? ': Codex keeps testing the other app' : ''}`);
  }
  for (const key of ['startup_timeout_sec', 'tool_timeout_sec']) {
    const want = Number(tomlValue(expected, key));
    const raw = tomlValue(existing, key);
    if (raw == null) out.push(`${key} is missing (expected ${key} = ${want}; Codex's default is too short)`);
    else if (Number(raw) < want) out.push(`${key} = ${raw} is below the recommended ${want}`);
  }
  if (!codexBlockHasEnvVars(existing)) {
    out.push(`it has no env_vars, so your shell exports never reach Swipium (add: ${codexEnvVarsLine()})`);
  }
  return out;
}

/** A conservative TOML sanity check (no TOML parser dependency). Returns the first line that
 *  is clearly not TOML (unterminated table header or string, `key = = value`, a bare word or bare
 *  value, an invalid escape, a key or [table] defined twice, a dotted-key table or [[array]]
 *  redefined as a [table]…), or null when the file looks well-formed. Multi-line strings and
 *  arrays/inline tables are skipped over. Not a full parser: a rare malformed file can still pass. */
export function tomlSanityError(toml: string): string | null {
  const lines = toml.split(/\r?\n/);
  type Delim = '"""' | "'''";
  let inMultiline: Delim | null = null;
  let depth = 0; // open [ / { of a multi-line array (or inline table) value
  let unterminated = false; // a single-line "…" / '…' string left open at the end of a line
  /** One key segment: bare, "basic" (escapes allowed) or 'literal'. Quoted keys take any
   *  character, as in TOML: Codex writes [projects."/abs/path"] and [plugins."name@source"]. */
  const KEY = `(?:[A-Za-z0-9_-]+|"(?:[^"\\\\]|\\\\.)*"|'[^']*')`;
  /** Dotted key or table name, normalized: `a . "b"` and `a.b` are the same key. */
  const keyPath = (text: string): string =>
    (text.match(new RegExp(KEY, 'g')) ?? []).map((k) => k.replace(/^["']|["']$/g, '')).join('\u0001');
  const headerRe = new RegExp(`^(\\[\\[?)[ \\t]*(${KEY}(?:[ \\t]*\\.[ \\t]*${KEY})*)[ \\t]*(\\]\\]?)[ \\t]*(#.*)?$`);
  const kvRe = new RegExp(`^${KEY}(?:[ \\t]*\\.[ \\t]*${KEY})*[ \\t]*=[ \\t]*(.*)$`);
  let table = '';
  /** What each key path defines: an explicit [table], an [[array]] of tables, a table made
   *  implicitly by a dotted key, or a value. TOML forbids redefining any of them. */
  const defined = new Map<string, 'table' | 'array' | 'dotted' | 'value'>();
  /** [[array]] path > the path of its latest entry, so [array.sub] lands in that entry. */
  const arrays = new Map<string, string>();
  let badEscape = false;
  /** Track brackets in a value; returns the multi-line string delimiter left open, if any. */
  const scanValue = (text: string): Delim | null => {
    let q: string | null = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '\\' && q === '"') {
          // TOML escapes (\e and \xHH are TOML 1.1; accepted so a valid file is never refused).
          if (!/[btnfr"\\uUex]/.test(text[i + 1] ?? '')) badEscape = true;
          i++;
        } else if (ch === q) q = null;
        continue;
      }
      if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
        const delim = text.slice(i, i + 3) as Delim;
        const end = text.indexOf(delim, i + 3);
        if (end < 0) return delim;
        i = end + 2;
      } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '#') return null;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
    }
    if (q) unterminated = true;
    return null;
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (inMultiline) {
      if (line.includes(inMultiline)) {
        const rest = line.slice(line.indexOf(inMultiline) + 3);
        inMultiline = scanValue(rest);
      }
      continue;
    }
    const t = line.trim();
    if (depth > 0) {
      inMultiline = scanValue(t);
      if (unterminated) return `line ${n + 1}: unterminated string: ${t}`;
      if (badEscape) return `line ${n + 1}: invalid escape sequence: ${t}`;
      continue;
    }
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('[')) {
      const header = headerRe.exec(t);
      // [a]] and [[a] are not TOML: the brackets must pair up.
      if (!header || header[1].length !== header[3].length) return `line ${n + 1}: ${t}`;
      // Resolve parents through [[array]] entries: [a.b] after [[a]] is a sub-table of the last a.
      const parts = keyPath(header[2]).split('\u0001');
      let path = '';
      for (let i = 0; i < parts.length; i++) {
        path = path ? `${path}\u0001${parts[i]}` : parts[i];
        if (i < parts.length - 1) path = arrays.get(path) ?? path;
      }
      const prior = defined.get(path);
      if (header[1] === '[[') {
        if (prior && prior !== 'array') return `line ${n + 1}: ${t} redefines a key or table as an array of tables`;
        defined.set(path, 'array');
        table = `${path}\u0002${n}`; // each [[array]] entry is its own table
        arrays.set(path, table);
      } else {
        if (prior) return `line ${n + 1}: table ${t} is defined twice`;
        defined.set(path, 'table');
        table = path;
      }
      continue;
    }
    const kv = kvRe.exec(t);
    if (!kv) return `line ${n + 1}: ${t}`;
    const value = kv[kv.length - 1];
    if (!value || value.startsWith('=') || value.startsWith('#')) return `line ${n + 1}: ${t}`;
    const keyName = t.split('=')[0].trim();
    const parts = keyPath(t.slice(0, t.length - value.length).replace(/=[ \t]*$/, '')).split('\u0001');
    let path = table;
    for (let i = 0; i < parts.length; i++) {
      path = path ? `${path}\u0001${parts[i]}` : parts[i];
      const prior = defined.get(path);
      if (i === parts.length - 1) {
        if (prior) return `line ${n + 1}: key ${keyName} is defined twice`;
        defined.set(path, 'value');
      } else if (prior && prior !== 'dotted') {
        return `line ${n + 1}: dotted key ${keyName} extends a ${prior === 'value' ? 'value' : 'table'} defined elsewhere`;
      } else defined.set(path, 'dotted');
    }
    if (!/^["'[{]/.test(value)) {
      // A bare scalar must be a boolean, number, or date/time (`a = nope` is not TOML).
      const scalar = value.replace(/[ \t]*#.*$/, '').trim();
      const ok =
        /^(true|false)$/.test(scalar) ||
        /^[+-]?(inf|nan)$/.test(scalar) ||
        /^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$|^0o[0-7](_?[0-7])*$|^0b[01](_?[01])*$/.test(scalar) ||
        /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(scalar) ||
        /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$/.test(scalar) ||
        /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(scalar);
      if (!ok) return `line ${n + 1}: not a TOML value: ${t}`;
    }
    inMultiline = scanValue(value);
    if (unterminated) return `line ${n + 1}: unterminated string: ${t}`;
    if (badEscape) return `line ${n + 1}: invalid escape sequence: ${t}`;
  }
  if (inMultiline) return 'unterminated multi-line string';
  if (depth > 0) return 'unterminated array or inline table';
  return null;
}

/** Codex keeps servers in ~/.codex/config.toml; its defaults (10 s startup, 60 s per tool) are too
 *  short for `npx` first runs and for device work (builds, boots, flows). Codex also does not pass
 *  the parent env to stdio servers (only a fixed whitelist), so `env_vars` forwards the names
 *  Swipium reads (test credentials, SWIPIUM_* config, ANDROID_HOME, JAVA_HOME...). */
export function codexBlock(node: string, cwd: string, self: string = SELF): string {
  const c = serverCommand(false, node, self);
  return [
    '[mcp_servers.swipium]',
    `command = ${JSON.stringify(c.command)}`,
    `args = [${c.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    `cwd = ${JSON.stringify(cwd)}`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 600',
    '# Codex only passes HOME, PATH, SHELL, USER, TMPDIR, LANG... to MCP servers; forward the rest by name',
    '# (add any custom SWIPIUM_* flow variables and ORG_GRADLE_PROJECT_* signing vars you use).',
    '# Literal values go in env = { NAME = "value" }. Approval grants (SWIPIUM_CONSENT_PREAPPROVE,',
    '# SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE, SWIPIUM_ALLOW_REMOTE_WDA) are deliberately not forwarded:',
    '# set them literally in env if you want them.',
    codexEnvVarsLine(),
    '# Optional: expose only the core tools to keep the tool list small (uncomment to enable).',
    `# enabled_tools = [${codexCoreTools()
      .map((t) => JSON.stringify(t))
      .join(', ')}]`,
  ].join('\n');
}

/** `claude mcp add` argv. Project scope writes the team-shared .mcp.json, so the command is portable.
 *  `env` becomes `-e NAME=value` flags (before `--`, so they are claude's, not the server's). */
export function claudeAddArgs(
  scope: string,
  node: string = process.execPath,
  self: string = SELF,
  env: Record<string, string> = {},
): string[] {
  const c = serverCommand(scope === 'project', node, self);
  const envFlags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['mcp', 'add', 'swipium', ...(scope !== 'local' ? ['--scope', scope] : []), ...envFlags, '--', c.command, ...c.args];
}

/** Claude Code waits far longer than 60 s on a tool call, so qa_test_this waitForCompletion and
 *  qa_job_status waitMs may block up to 110 s there (the server default stays 50 s for clients
 *  with a 60 s tool timeout, e.g. Codex). */
export const CLAUDE_MAX_WAIT_MS = '110000';

/** Not pre-approved by --trust-local although it runs no code: it taps a destructive control the
 *  agent picked in the app (delete, pay, send), which acts on the app's backend, not just this machine. */
const TRUST_LOCAL_EXCLUDED: ReadonlySet<string> = new Set(['destructive_ui_candidate']);

/** Consent actions `--trust-local` pre-approves: every action that runs no repo- or model-chosen
 *  code and is pre-approvable by name (src/consent/consent.ts tiers), except destructive UI taps.
 *  Builds, Metro, WDA, seed scripts, OCR commands and destructive UI candidates keep prompting. */
export function trustLocalActions(): string[] {
  return CONSENT_ACTIONS.filter(
    (a) => !CONSENT_ACTION_TIERS[a].runsCode && !CONSENT_ACTION_TIERS[a].notPreapprovable && !TRUST_LOCAL_EXCLUDED.has(a),
  );
}

/** Env for the Claude Code registration. The pre-approval only ever goes to a machine-local scope
 *  (runInit refuses --trust-local with --scope project, which writes the team-shared .mcp.json). */
export function claudeEnv(trustLocal: boolean): Record<string, string> {
  return { SWIPIUM_MAX_WAIT_MS: CLAUDE_MAX_WAIT_MS, ...(trustLocal ? { [PREAPPROVE_ENV]: trustLocalActions().join(',') } : {}) };
}

/** Where `init claude|codex` installs the skill: Claude user scope > ~/.claude/skills (or
 *  $CLAUDE_CONFIG_DIR/skills), other Claude scopes > <cwd>/.claude/skills, Codex > <cwd>/.agents/skills. */
export function skillPath(client: 'claude' | 'codex', scope: string, cwd: string): string {
  const base =
    client === 'codex'
      ? join(cwd, '.agents', 'skills')
      : scope === 'user'
        ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills')
        : join(cwd, '.claude', 'skills');
  return join(base, SKILL_NAME, 'SKILL.md');
}

/** Write SKILL.md (ours: replaced when it differs). */
export function installSkill(file: string): 'created' | 'updated' | 'unchanged' {
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (cur === SKILL_MD) return 'unchanged';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, SKILL_MD);
  return cur === null ? 'created' : 'updated';
}

/** `gemini mcp add` argv. Gemini's default scope is project (.gemini/settings.json), so it's portable. */
export function geminiAddArgs(scope: string, node: string = process.execPath, self: string = SELF): string[] {
  const user = scope === 'user';
  const c = serverCommand(!user, node, self);
  // Gemini's parser would read `-y` as its own flag: server args that start with "-" go after `--`
  // (documented form: `gemini mcp add python-server python server.py -- --server-arg v`).
  const rest = c.args.some((x) => x.startsWith('-')) ? ['--', ...c.args] : c.args;
  // --timeout keeps this path equal to the settings.json fallback entry.
  return ['mcp', 'add', '--scope', user ? 'user' : 'project', '--timeout', String(GEMINI_TIMEOUT_MS), 'swipium', c.command, ...rest];
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

export interface InitArgs {
  client: string;
  apply: boolean;
  scope: string;
  /** Raw --cwd value (undefined = where init was invoked). */
  cwd?: string;
  /** Raw --root value (init flows). */
  root?: string;
  trustLocal: boolean;
  withSkill: boolean;
  force: boolean;
  help: boolean;
  /** Set on an unknown flag, a flag missing its value, or a stray positional (exit 2 + usage). */
  error?: string;
}

const INIT_VALUE_FLAGS = new Set(['--scope', '--cwd', '--root']);
const INIT_BOOL_FLAGS = new Set(['--apply', '--trust-local', '--no-skill', '--force', '--help', '-h']);
const INIT_FLOWS_FLAGS = new Set(['--root', '--force', '--help', '-h']);

/** Parse `init` argv: accepts `--flag value` and `--flag=value`; an unknown flag, a value
 *  flag with no value, or an extra positional is an error instead of being silently ignored. */
export function parseInitArgs(args: string[]): InitArgs {
  const out: InitArgs = { client: '', apply: false, scope: 'local', trustLocal: false, withSkill: true, force: false, help: false };
  const positionals: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      positionals.push(a);
      continue;
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    flags.push(flag);
    if (INIT_VALUE_FLAGS.has(flag)) {
      const value = eq > 0 ? a.slice(eq + 1) : args[i + 1];
      if (value == null || value === '' || (eq < 0 && value.startsWith('-'))) {
        out.error = `${flag} expects a value`;
        return out;
      }
      if (eq < 0) i++;
      if (flag === '--scope') out.scope = value;
      else if (flag === '--cwd') out.cwd = value;
      else out.root = value;
    } else if (eq < 0 && INIT_BOOL_FLAGS.has(a)) {
      if (a === '--apply') out.apply = true;
      else if (a === '--trust-local') out.trustLocal = true;
      else if (a === '--no-skill') out.withSkill = false;
      else if (a === '--force') out.force = true;
      else out.help = true;
    } else {
      out.error = `unknown option ${a}`;
      return out;
    }
  }
  out.client = (positionals[0] ?? '').toLowerCase();
  if (positionals.length > 1) out.error = `unexpected argument ${positionals[1]}`;
  // `init flows` only scaffolds templates: a registration flag there is a mistake, not a no-op.
  const flowsIgnored = out.client === 'flows' ? flags.find((f) => !INIT_FLOWS_FLAGS.has(f)) : undefined;
  if (!out.error && flowsIgnored) out.error = `${flowsIgnored} does not apply to init flows (it takes --root <dir> and --force)`;
  return out;
}

/** The app repo the server should run in: `--cwd <dir>` if given, else where init was invoked. */
export function resolveTargetCwd(args: string[]): string {
  return resolve(parseInitArgs(args).cwd ?? process.cwd());
}

/** Claude Code's config file (local/user-scope MCP servers): $CLAUDE_CONFIG_DIR/.claude.json or ~/.claude.json. */
function claudeConfigFile(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
}

/** The existing `swipium` entry Claude Code has for this scope (local: ~/.claude.json
 *  projects[cwd]; user: its top-level mcpServers; project: <cwd>/.mcp.json), `null` when there is
 *  none, `undefined` when it can't be determined (unreadable file). Best-effort. */
export function existingClaudeEntry(scope: string, cwd: string): Record<string, unknown> | null | undefined {
  const file = scope === 'project' ? join(cwd, '.mcp.json') : claudeConfigFile();
  if (!existsSync(file)) return null;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const serversOf = (o: unknown): Record<string, unknown> | undefined =>
    o && typeof o === 'object' ? ((o as { mcpServers?: Record<string, unknown> }).mcpServers ?? undefined) : undefined;
  let servers: Record<string, unknown> | undefined;
  if (scope === 'local') {
    const projects = (doc.projects ?? {}) as Record<string, unknown>;
    let real = cwd;
    try {
      real = realpathSync(cwd);
    } catch {
      /* keep cwd */
    }
    servers = serversOf(projects[cwd]) ?? serversOf(projects[real]);
  } else servers = serversOf(doc);
  const entry = servers?.swipium;
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
}

/** Whether an existing Claude entry already runs `cmd` (the claudeAddArgs argv) with `env`. */
export function claudeEntryMatches(entry: Record<string, unknown>, cmd: string[], env: Record<string, string>): boolean {
  const sep = cmd.indexOf('--');
  const [command, ...args] = cmd.slice(sep + 1);
  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const sortEnv = (e: unknown): Record<string, unknown> => {
    if (!e || typeof e !== 'object') return {};
    return Object.fromEntries(Object.entries(e as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  };
  return entry.command === command && sameJson(entry.args ?? [], args) && sameJson(sortEnv(entry.env), sortEnv(env));
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
  '       swipium init claude [--trust-local] [--no-skill]   (claude/codex install the swipium-qa skill unless --no-skill)\n' +
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
  const parsed = parseInitArgs(args);
  if (parsed.error) {
    process.stderr.write(`swipium init: ${parsed.error}\n\n${INIT_USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { client, apply, scope, trustLocal, withSkill } = parsed;
  const node = stableNodePath();

  if (client === 'flows') {
    if (parsed.help) {
      process.stdout.write(INIT_USAGE);
      return;
    }
    const root = parsed.root != null ? resolve(parsed.root) : process.cwd();
    if (!isDir(root)) {
      process.stdout.write(`Path not found: ${root}\n`);
      process.exitCode = 2;
      return;
    }
    const force = parsed.force;
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

  if (parsed.help) {
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

  if (trustLocal && (client !== 'claude' || scope === 'project')) {
    process.stdout.write(
      client !== 'claude'
        ? `--trust-local is only supported for init claude. For ${client}, set ${PREAPPROVE_ENV} in the server env yourself.\n`
        : `Refusing --trust-local with --scope project: that writes the team-shared .mcp.json. Use --scope local or user.\n`,
    );
    process.exitCode = 2;
    return;
  }

  const cwd = resolve(parsed.cwd ?? process.cwd());
  /** Preview line, or (apply) the install result for the swipium-qa skill. */
  const skillStep = (target: 'claude' | 'codex'): void => {
    if (!withSkill) return;
    const file = skillPath(target, scope, cwd);
    if (!apply) {
      process.stdout.write(`Skill: --apply also installs the ${SKILL_NAME} agent skill to ${file} (skip with --no-skill).\n`);
      return;
    }
    if ((target === 'codex' || scope !== 'user') && !isDir(cwd)) {
      process.stdout.write(`Skill not installed: ${cwd} does not exist.\n`);
      return;
    }
    try {
      process.stdout.write(`Skill ${SKILL_NAME}: ${installSkill(file)} ${file}\n`);
      // A local (private) registration still puts the skill in the repo, which is usually committed.
      if (target === 'claude' && scope === 'local') {
        process.stdout.write(
          `  This is inside the repository: add .claude/skills/${SKILL_NAME}/ to .gitignore if you don't want it committed (or pass --no-skill).\n`,
        );
      }
    } catch (e) {
      process.stdout.write(`Skill not installed (${(e as Error).message}).\n`);
    }
  };
  const refuseMissingCwd = (): boolean => {
    if (isDir(cwd)) return false;
    const why = existsSync(cwd) ? 'is not a directory' : 'does not exist';
    process.stdout.write(
      `Refusing to ${apply ? 'apply' : 'preview'}: cwd ${cwd} ${why}. Run init from your mobile app repo or pass --cwd <dir>.\n`,
    );
    process.exitCode = 2;
    return true;
  };
  // An explicit --cwd that isn't a directory is a usage error even in preview (exit 2, as documented).
  if (parsed.cwd != null && refuseMissingCwd()) return;

  if (client === 'claude') {
    const cmd = claudeAddArgs(scope, node, SELF, claudeEnv(trustLocal));
    const shared =
      (scope === 'project' ? '\n(project scope writes .mcp.json for your team, so it uses the portable `npx -y swipium`.)' : '') +
      `\nSWIPIUM_MAX_WAIT_MS=${CLAUDE_MAX_WAIT_MS} lets one qa_test_this {waitForCompletion:true} / qa_job_status call block up to 110 s.` +
      (trustLocal
        ? `\n--trust-local pre-approves (machine-local ${scope} scope only): ${trustLocalActions().join(', ')}.\n` +
          'Builds, Metro, WebDriverAgent, seed scripts, OCR commands and destructive UI taps still ask.'
        : '');
    if (apply) {
      if (refuseMissingCwd()) return; // Never register for the shell's cwd instead
      const removeCmd = `claude mcp remove swipium --scope ${scope}`;
      const existing = existingClaudeEntry(scope, cwd);
      if (existing && claudeEntryMatches(existing, cmd, claudeEnv(trustLocal))) {
        process.stdout.write(`swipium is already registered in Claude Code's ${scope} config with these settings (unchanged).\n`);
      } else if (existing) {
        // `claude mcp add` refuses to overwrite; say so and give the two commands that work.
        process.stdout.write(
          `swipium is already registered in Claude Code's ${scope} config with a different command or env (left unchanged).\n` +
            `To replace it, run:\n  ${removeCmd}\n  claude ${cmd.join(' ')}\n`,
        );
        process.exitCode = 1;
      } else {
        const r = spawnSync('claude', cmd, { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', cwd });
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
        if (applyOk(r)) {
          process.stdout.write('\nRegistered. Verifying the server starts + tools inject…\n');
          await runVerify();
        } else {
          const notFound = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
          const exists = /already exists/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
          process.stdout.write(
            notFound
              ? `claude CLI not found on PATH. Install Claude Code, then run:\n  claude ${cmd.join(' ')}\n`
              : exists
                ? `swipium is already registered (scope ${scope}) and claude does not overwrite it. To replace it, run:\n  ${removeCmd}\n  claude ${cmd.join(' ')}\n`
                : `claude registration failed (status ${r.status ?? 'n/a'}). Run manually:\n  claude ${cmd.join(' ')}\n`,
          );
          process.exitCode = 1;
        }
      }
    } else {
      process.stdout.write(`Preview (run with --apply to execute):\n  claude ${cmd.join(' ')}${shared}\n`);
    }
    skillStep('claude');
  } else if (client === 'gemini') {
    const cmd = geminiAddArgs(scope, node);
    const manual =
      scope === 'user'
        ? `add to ~/.gemini/settings.json under "mcpServers":\n${geminiBlock(node)}\n` +
          '(user scope serves every project, so no cwd is pinned: Swipium tests the directory you start gemini from)'
        : `add to ${join(cwd, '.gemini', 'settings.json')} under "mcpServers":\n  "swipium": { "command": "npx", "args": ["-y", "swipium"], "timeout": ${GEMINI_TIMEOUT_MS} }`;
    if (apply) {
      if (refuseMissingCwd()) return;
      const r = spawnSync('gemini', cmd, { stdio: 'inherit', cwd });
      if (!applyOk(r)) {
        // settings.json is plain JSON, so merge it directly (as for Cursor/VS Code) rather than
        // only printing a block and exiting 0 with nothing registered.
        const user = scope === 'user';
        const c = serverCommand(!user, node);
        const file = user ? join(homedir(), '.gemini', 'settings.json') : join(cwd, '.gemini', 'settings.json');
        process.stdout.write(`gemini \`mcp add\` failed or unavailable; merging ${file} directly.\n`);
        const ok = projectFileInit({
          label: 'Gemini CLI',
          file,
          topKey: 'mcpServers',
          entry: { command: c.command, args: c.args, timeout: GEMINI_TIMEOUT_MS },
          apply: true,
        });
        if (!ok) {
          process.stdout.write(`Or ${manual}\n`);
          return;
        }
      }
      process.stdout.write('\nRegistered. Verifying…\n');
      await runVerify();
    } else {
      process.stdout.write(`Preview (run with --apply):\n  gemini ${cmd.join(' ')}\nor ${manual}\n`);
    }
  } else if (client === 'codex') {
    // Written to config.toml directly (rather than `codex mcp add`) so the block carries cwd,
    // longer startup/tool timeouts and env_vars, which `codex mcp add` has no flags for.
    // Codex itself honours CODEX_HOME (default ~/.codex).
    const cfg = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    const block = codexBlock(node, cwd);
    const c = serverCommand(false, node);
    const alt =
      `  codex mcp add swipium --env SWIPIUM_PROJECT_ROOT=${cwd} -- ${[c.command, ...c.args].join(' ')}\n` +
      `  (--env only sets literal values; then add startup_timeout_sec = 30, tool_timeout_sec = 600 and the env_vars line\n` +
      `  under [mcp_servers.swipium] in ${cfg}: env_vars is config-only, and without it your shell exports never reach Swipium)`;
    const caveat =
      '⚠ Codex Desktop threads may not expose tools from custom stdio MCP servers (openai/codex#19425, open). If the tools are missing in the Desktop app, try the Codex CLI.\n';
    if (apply) {
      if (refuseMissingCwd()) return;
      mkdirSync(dirname(cfg), { recursive: true });
      const cur = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
      // Never append to a config.toml that doesn't parse (Codex would then fail to start).
      const tomlError = tomlSanityError(cur);
      if (tomlError) {
        process.stdout.write(
          `Refusing to modify ${cfg}: it does not look like valid TOML (${tomlError}).\nFix it, then rerun, or add this block by hand:\n${block}\n`,
        );
        process.exitCode = 2;
        return;
      }
      const existing = findCodexServerBlock(cur);
      if (existing !== null) {
        // Name what differs from (or is missing versus) the expected table.
        const diff = codexBlockDiff(existing, block);
        process.stdout.write(
          diff.length
            ? `Already present in ${cfg} (left unchanged), but it differs from the expected [mcp_servers.swipium] table:\n` +
                diff.map((d) => `  - ${d}`).join('\n') +
                '\nEdit those lines by hand (Codex has no command to update a server).\n'
            : `Already present in ${cfg} (left unchanged); it matches the expected settings.\n`,
        );
      } else if (hasCodexDottedServer(cur) || tomlSanityError(`${cur}\n${block}\n`)) {
        // A swipium entry written another way (dotted keys), or anything else that would
        // make the appended file invalid: never leave Codex unable to start.
        const why = hasCodexDottedServer(cur)
          ? 'it already defines a swipium server with dotted keys'
          : `appending would make it invalid TOML (${tomlSanityError(`${cur}\n${block}\n`)})`;
        process.stdout.write(`Refusing to modify ${cfg}: ${why}.\nCompare it by hand with:\n${block}\n`);
        process.exitCode = 2;
        return;
      } else {
        appendFileSync(cfg, `\n${block}\n`);
        process.stdout.write(`Appended to ${cfg}\n`);
      }
      skillStep('codex');
      process.stdout.write(caveat + 'Server-side self-check:\n');
      await runVerify();
    } else {
      process.stdout.write(
        `Preview (run with --apply to append to ${cfg}):\n${block}\n${CWD_NOTE}\nor register with the Codex CLI:\n${alt}\n${caveat}`,
      );
      skillStep('codex');
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
