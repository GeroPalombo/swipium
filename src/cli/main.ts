// CLI argv parsing + usage text for the `swipium` binary (kept out of src/index.ts so it can be
// unit-tested without starting the stdio server). No subcommand (or `serve`) = run the stdio MCP
// server; `--help`/`--version` print and exit; an unknown subcommand (bare word) prints usage and
// exits 2 instead of silently starting a server that waits on stdin forever. Unknown `--flags`
// with no subcommand (e.g. `--stdio`, which MCP client configs / registries commonly pass) start
// the server as 1.5 did, with a warning on stderr (stdout is the MCP channel).
//
// CLI path, not the MCP server, so writing to stdout is fine here.

import { SWIPIUM_VERSION } from '../version.js';

export const SUBCOMMANDS = ['init', 'scan', 'suite', 'verify', 'report', 'gc'] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

/** Options each subcommand accepts (for the "Did you mean" suggestion of misplaced flags only;
 *  each subcommand validates its own argv). */
const SUBCOMMAND_FLAGS: Record<Subcommand, readonly string[]> = {
  init: ['--apply', '--scope', '--cwd', '--no-skill', '--trust-local', '--root', '--force', '--help', '-h'],
  scan: ['--check', '--dry-run', '--no-write', '--help', '-h'],
  suite: ['--suite', '--force', '--strict', '--help', '-h'],
  verify: ['--help', '-h'],
  report: ['--format', '--latest', '--session', '--report', '--root', '--out', '--fail-on-gate', '--max-age', '--help', '-h'],
  gc: ['--dry-run', '--days', '--keep', '--help', '-h'],
};

export type ParsedCommand =
  /** orphanSweep:false = the throwaway server `swipium verify` (and `init --apply`) starts: it must
   *  not adopt or reap other runs' managed processes. */
  | { kind: 'serve'; ignoredFlags?: string[]; orphanSweep?: false }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'sub'; cmd: Subcommand; rest: string[] }
  | { kind: 'unknown'; cmd: string }
  /** Flags placed BEFORE a subcommand (`swipium -y init claude`): exit 2 with the corrected command
   *  rather than starting a stdio server that ignores the subcommand and waits on stdin. */
  | { kind: 'misplaced'; cmd: Subcommand; flags: string[]; suggestion: string };

export const USAGE = `swipium ${SWIPIUM_VERSION}: MCP server for mobile QA (Android emulator / iOS simulator)

Usage:
  swipium                     Start the stdio MCP server (what MCP clients run). Alias: swipium serve
  swipium init <client>       Preview (default) or --apply the MCP client registration
                              clients: claude | codex | gemini | cursor | vscode   (also: init flows)
                              options: [--apply] [--scope local|user|project] [--cwd <app dir>]
                                       [--no-skill] (claude/codex also install the swipium-qa skill)
                                       [--trust-local] (claude, local/user scope: pre-approve consents that run no code)
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

/** Internal flag `swipium verify` starts its throwaway server with: no orphan adopt / reap sweep. */
export const VERIFY_CHILD_FLAG = '--verify-child';

export function parseCommand(argv: string[], warn: (msg: string) => void = (m) => void process.stderr.write(m)): ParsedCommand {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return { kind: 'serve' };
  if (cmd === 'serve') {
    if (!rest.length) return { kind: 'serve' };
    warn(`swipium: serve takes no options, ignoring ${rest.join(' ')} (the server speaks stdio only; see swipium --help)\n`);
    return { kind: 'serve', ignoredFlags: rest };
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return { kind: 'help' };
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') return { kind: 'version' };
  if ((SUBCOMMANDS as readonly string[]).includes(cmd)) return { kind: 'sub', cmd: cmd as Subcommand, rest };
  if (cmd.startsWith('-')) {
    const subIdx = argv.findIndex((a) => (SUBCOMMANDS as readonly string[]).includes(a));
    if (subIdx > 0) {
      const flags = argv.slice(0, subIdx);
      // Keep only flags the subcommand accepts: `-y` is npx's (`npx -y swipium init …`), and an
      // unknown flag (`swipium --verbose init`) would make the suggested command fail too. A value
      // that follows a dropped flag (`--foo bar`) goes with it.
      const known = SUBCOMMAND_FLAGS[argv[subIdx] as Subcommand];
      const kept: string[] = [];
      let droppedPrev = false;
      for (const f of flags) {
        if (f.startsWith('-')) {
          droppedPrev = !known.includes(f.split('=')[0]);
          if (!droppedPrev) kept.push(f);
        } else if (!droppedPrev) kept.push(f);
      }
      const suggestion = ['swipium', ...argv.slice(subIdx), ...kept].join(' ');
      return { kind: 'misplaced', cmd: argv[subIdx] as Subcommand, flags, suggestion };
    }
    // No subcommand, only flags (e.g. `--stdio`): serve, as 1.5 did. MCP configs pass these.
    // VERIFY_CHILD_FLAG is internal: `swipium verify` passes it to the server it starts.
    const verifyChild = argv.includes(VERIFY_CHILD_FLAG);
    const ignoredFlags = argv.filter((a) => a.startsWith('-') && a !== VERIFY_CHILD_FLAG);
    if (verifyChild && !ignoredFlags.length) return { kind: 'serve', orphanSweep: false };
    warn(`swipium: ignoring unrecognized flag(s) ${ignoredFlags.join(' ')}, starting the stdio MCP server (see swipium --help)\n`);
    return { kind: 'serve', ignoredFlags, ...(verifyChild ? { orphanSweep: false as const } : {}) };
  }
  return { kind: 'unknown', cmd };
}

/** Minimum supported Node.js, mirrored from package.json "engines.node" (and MIN_NODE_VERSION in
 *  src/tools/doctor.ts, which this module must not import: it is on the server's startup path). */
export const MIN_NODE = '22.12';

/** True when `version` (e.g. "v20.19.6") is at least `min` (major.minor). */
export function nodeVersionSupported(version: string = process.version, min: string = MIN_NODE): boolean {
  const parse = (v: string): [number, number] | undefined => {
    const m = /^v?(\d+)(?:\.(\d+))?/.exec(v);
    return m ? [Number(m[1]), Number(m[2] ?? 0)] : undefined;
  };
  const have = parse(version);
  const need = parse(min) ?? [0, 0];
  return !!have && (have[0] > need[0] || (have[0] === need[0] && have[1] >= need[1]));
}

/** The stderr warning for an unsupported Node.js runtime, or null when it is supported. */
export function unsupportedNodeWarning(version: string = process.version): string | null {
  if (nodeVersionSupported(version)) return null;
  return (
    `swipium: WARNING: Node.js ${version} is not supported (requires >= ${MIN_NODE}). Some features may fail. ` +
    `Install Node.js ${MIN_NODE}+ and point your MCP client at it.\n`
  );
}
