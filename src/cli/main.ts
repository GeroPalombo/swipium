// CLI argv parsing + usage text for the `swipium` binary (kept out of src/index.ts so it can be
// unit-tested without starting the stdio server). No subcommand (or `serve`) = run the stdio MCP
// server; `--help`/`--version` print and exit; an unknown subcommand (bare word) prints usage and
// exits 2 instead of silently starting a server that waits on stdin forever. Unknown `--flags`
// with no subcommand (e.g. `--stdio`, which MCP client configs / registries commonly pass) start
// the server as 1.5 did, with a warning on stderr (stdout is the MCP channel).
//
// CLI path, not the MCP server — writing to stdout is fine here.

import { SWIPIUM_VERSION } from '../version.js';

export const SUBCOMMANDS = ['init', 'scan', 'suite', 'verify', 'report', 'gc'] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export type ParsedCommand =
  | { kind: 'serve'; ignoredFlags?: string[] }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'sub'; cmd: Subcommand; rest: string[] }
  | { kind: 'unknown'; cmd: string };

export const USAGE = `swipium ${SWIPIUM_VERSION} — MCP server for mobile QA (Android emulator / iOS simulator)

Usage:
  swipium                     Start the stdio MCP server (what MCP clients run). Alias: swipium serve
  swipium init <client>       Preview (default) or --apply the MCP client registration
                              clients: claude | codex | gemini | cursor | vscode   (also: init flows)
                              options: [--apply] [--scope local|user|project] [--cwd <app dir>]
  swipium verify              Start the server over stdio, list its tools, run qa_doctor
  swipium scan [path]         Inspect a project; scaffold .swipium/ unless BLOCKED
                              options: [--check | --dry-run | --no-write]
  swipium suite <lint|compile|init> [projectRoot] [--suite suites/smoke.yaml]
  swipium report --format junit|sarif|github-summary|markdown|json
                              options: [--latest | --session <id> | --report <file>] [--root <dir>]
                                       [--out <file>] [--fail-on-gate]   (swipium report --help)
  swipium gc [--dry-run] [--days N] [--keep N]
                              Delete old ~/.swipium/runs session dirs + stale projects.json entries
  swipium --help | -h         Show this help
  swipium --version | -v      Print the version

Docs: https://github.com/GeroPalombo/swipium#readme
`;

export function parseCommand(argv: string[], warn: (msg: string) => void = (m) => void process.stderr.write(m)): ParsedCommand {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === 'serve') return { kind: 'serve' };
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return { kind: 'help' };
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') return { kind: 'version' };
  if ((SUBCOMMANDS as readonly string[]).includes(cmd)) return { kind: 'sub', cmd: cmd as Subcommand, rest };
  if (cmd.startsWith('-')) {
    // No subcommand, only flags (e.g. `--stdio`): serve, as 1.5 did — MCP configs pass these.
    const ignoredFlags = argv.filter((a) => a.startsWith('-'));
    warn(`swipium: ignoring unrecognized flag(s) ${ignoredFlags.join(' ')} — starting the stdio MCP server (see swipium --help)\n`);
    return { kind: 'serve', ignoredFlags };
  }
  return { kind: 'unknown', cmd };
}
