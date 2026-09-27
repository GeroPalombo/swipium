// CLI argv parsing + usage text for the `swipium` binary (kept out of src/index.ts so it can be
// unit-tested without starting the stdio server). No subcommand (or `serve`) = run the stdio MCP
// server; `--help`/`--version` print and exit; an unknown subcommand prints usage and exits 2
// instead of silently starting a server that waits on stdin forever.
//
// CLI path, not the MCP server — writing to stdout is fine here.

import { SWIPIUM_VERSION } from '../version.js';

export const SUBCOMMANDS = ['init', 'scan', 'suite', 'verify', 'report'] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export type ParsedCommand =
  | { kind: 'serve' }
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
  swipium report --latest --format junit|sarif|github-summary [--out file] [--fail-on-gate]
  swipium --help | -h         Show this help
  swipium --version | -v      Print the version

Docs: https://github.com/GeroPalombo/swipium#readme
`;

export function parseCommand(argv: string[]): ParsedCommand {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === 'serve') return { kind: 'serve' };
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return { kind: 'help' };
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') return { kind: 'version' };
  if ((SUBCOMMANDS as readonly string[]).includes(cmd)) return { kind: 'sub', cmd: cmd as Subcommand, rest };
  return { kind: 'unknown', cmd };
}
