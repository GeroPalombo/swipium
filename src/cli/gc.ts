// `swipium gc [--dry-run] [--days N] [--keep N]` — reclaim disk from old ~/.swipium/runs session dirs
// (same rule as the automatic startup prune — src/session/retention.ts) and compact
// ~/.swipium/projects.json (drop entries whose project root no longer exists, cap to 200).
//
// CLI path, not the MCP server — writing to stdout is fine here.

import { pruneSessionRuns, retentionDaysFromEnv, retentionKeepFromEnv, DEFAULT_RETENTION_DAYS } from '../session/retention.js';
import { compactProjectRegistry } from '../appMap/projectRegistry.js';

export const GC_USAGE = `Usage: swipium gc [--dry-run] [--days N] [--keep N]
  Delete ~/.swipium/runs session dirs older than N days (default: SWIPIUM_RETENTION_DAYS or 30) that
  are not in ~/.swipium/registry.json, keeping the newest --keep (default: SWIPIUM_RETENTION_KEEP or 20)
  per project regardless of age; prune ~/.swipium/projects.json entries whose root no longer exists.
  --dry-run   report what would be reclaimed, delete nothing
`;

export interface GcArgs {
  dryRun: boolean;
  days: number;
  keep: number;
  help?: boolean;
  error?: string;
}

export function parseGcArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): GcArgs {
  const out: GcArgs = { dryRun: false, days: retentionDaysFromEnv(env) ?? DEFAULT_RETENTION_DAYS, keep: retentionKeepFromEnv(env) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--days' || a === '--keep' || a.startsWith('--days=') || a.startsWith('--keep=')) {
      const [flag, inline] = a.split('=', 2);
      const raw = inline ?? argv[++i];
      const n = Number(raw);
      if (raw == null || !Number.isInteger(n) || n < 0) {
        out.error = `${flag} expects a non-negative integer (got ${raw ?? 'nothing'})`;
        return out;
      }
      if (flag === '--days') out.days = n;
      else out.keep = n;
    } else {
      out.error = `unknown option ${a}`;
      return out;
    }
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Run gc; returns the process exit code. */
export async function runGc(argv: string[], out: (s: string) => void = (s) => void process.stdout.write(s)): Promise<number> {
  const args = parseGcArgs(argv);
  if (args.help) {
    out(GC_USAGE);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`swipium gc: ${args.error}\n\n${GC_USAGE}`);
    return 2;
  }
  const r = await pruneSessionRuns({ days: args.days, keepPerProject: args.keep, dryRun: args.dryRun });
  const projects = compactProjectRegistry({ dryRun: args.dryRun });
  const verb = args.dryRun ? 'would delete' : 'deleted';
  out(
    `swipium gc${args.dryRun ? ' (dry run)' : ''}: scanned ${r.scanned} session dir(s) under ${r.runsDir}\n` +
      `  ${verb} ${r.deleted.length} session dir(s) older than ${r.days} day(s) (not registered; newest ${r.keepPerProject} per project kept)\n` +
      `  ${args.dryRun ? 'reclaimable' : 'reclaimed'}: ${formatBytes(r.bytesReclaimed)}\n` +
      `  projects.json: ${projects.before} → ${projects.after} entr${projects.after === 1 ? 'y' : 'ies'}` +
      `${projects.removed ? ` (${projects.removed} stale ${args.dryRun ? 'would be ' : ''}removed)` : ''}\n` +
      (r.skipped ? `  prune skipped: ${r.skipped}\n` : '') +
      (r.errors ? `  ${r.errors} entr${r.errors === 1 ? 'y' : 'ies'} could not be processed (see logs)\n` : ''),
  );
  return 0;
}
