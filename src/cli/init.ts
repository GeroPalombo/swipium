// `swipium init <client> [--apply] [--scope project|user|local]`
//
// Default = PREVIEW the exact registration (safe, no mutation). `--apply` executes it by
// DELEGATING to the client's own CLI where one exists (claude/gemini `mcp add`), or writing
// Codex's config.toml (it has no `mcp add` + a history of silent config-load bugs). After a
// successful apply it runs `verify` (the server starts + tools inject).
//
// NOTE: this is the CLI path, not the MCP server — writing to stdout is fine here.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { runVerify } from './verify.js';
import { initFlowTemplates } from '../flows/templates.js';

const SELF = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'); // dist/index.js

/** A delegated CLI registration succeeded only if it both ran and exited 0. */
export function applyOk(r: { error?: unknown; status: number | null }): boolean {
  return !r.error && r.status === 0;
}

function geminiBlock(node: string): string {
  return `  "swipium": { "command": ${JSON.stringify(node)}, "args": [${JSON.stringify(SELF)}], "cwd": "<your repo>", "timeout": 600000 }`;
}
function codexBlock(node: string): string {
  return `[mcp_servers.swipium]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(SELF)}]\ncwd = "<your repo>"`;
}

export async function runInit(args: string[]): Promise<void> {
  const client = (args[0] ?? '').toLowerCase();
  const apply = args.includes('--apply');
  const scopeIdx = args.indexOf('--scope');
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : 'local';
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
    process.stdout.write('\nNext: edit selectors/variables, then validate with qa_flow_check and run with qa_flow_run from an MCP session.\n');
    return;
  }

  if (!['claude', 'gemini', 'codex'].includes(client)) {
    process.stdout.write('Usage: swipium init <claude|gemini|codex> [--apply] [--scope project|user|local]\n       swipium init flows [--root <dir>] [--force]\n');
    process.exitCode = 2;
    return;
  }

  if (client === 'claude') {
    const cmd = ['mcp', 'add', 'swipium', ...(scope !== 'local' ? ['--scope', scope] : []), '--', node, SELF];
    if (apply) {
      const r = spawnSync('claude', cmd, { stdio: 'inherit' });
      if (!applyOk(r)) {
        process.stdout.write(`claude registration failed (status ${r.status ?? 'n/a'}). Run manually:\n  claude ${cmd.join(' ')}\n`);
      } else {
        process.stdout.write('\nRegistered. Verifying the server starts + tools inject…\n');
        await runVerify();
      }
    } else {
      process.stdout.write(`Preview (run with --apply to execute):\n  claude ${cmd.join(' ')}\n`);
    }
  } else if (client === 'gemini') {
    const cmd = ['mcp', 'add', 'swipium', node, SELF];
    if (apply) {
      const r = spawnSync('gemini', cmd, { stdio: 'inherit' });
      if (!applyOk(r)) {
        process.stdout.write(`gemini \`mcp add\` unavailable. Add to ~/.gemini/settings.json under "mcpServers":\n${geminiBlock(node)}\n`);
      } else {
        process.stdout.write('\nRegistered. Verifying…\n');
        await runVerify();
      }
    } else {
      process.stdout.write(`Preview (run with --apply):\n  gemini ${cmd.join(' ')}\nor add to ~/.gemini/settings.json:\n${geminiBlock(node)}\n`);
    }
  } else {
    // codex — no `mcp add`; write config.toml (append if absent), then self-verify.
    const cfg = join(homedir(), '.codex', 'config.toml');
    const block = codexBlock(node);
    if (apply) {
      mkdirSync(dirname(cfg), { recursive: true });
      const cur = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
      if (cur.includes('[mcp_servers.swipium]')) {
        process.stdout.write(`Already present in ${cfg}\n`);
      } else {
        appendFileSync(cfg, `\n${block}\n`);
        process.stdout.write(`Appended to ${cfg}\n`);
      }
      process.stdout.write('⚠ Codex has an open tool-injection regression (#19425) on builds after ~0.120.0 — confirm tools actually appear in Codex. Server-side self-check:\n');
      await runVerify();
    } else {
      process.stdout.write(`Add to ${cfg}:\n${block}\n⚠ Codex has an open tool-injection regression — verify tools appear after adding.\n`);
    }
  }

  process.stdout.write('\nSelf-check anytime: swipium verify\n');
}
