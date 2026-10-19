// Persisted Swipium sessions of a project and their report JSON files, read straight from disk
// (no SessionStore, no device): `swipium report` picks the report to render from here, and the
// trend / flake history (report/history.ts) reads every session's latest report.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export interface SessionCandidate {
  id: string;
  dir: string;
  createdAt: number;
  reportPath?: string;
}

/** Newest persisted report JSON of a session (the qa_report "report" artifact, not an export). */
export function latestReportJson(
  dir: string,
  state: { artifacts?: Array<{ kind?: string; mime?: string; path?: string; createdAt?: number }> },
): string | undefined {
  const isReportJson = (p: string) => /(^|[\\/])report-\d+\.json$/.test(p);
  const fromState = (state.artifacts ?? [])
    .filter((a) => a.kind === 'report' && a.mime === 'application/json' && a.path && isReportJson(a.path) && existsSync(a.path))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  if (fromState.length) return fromState[fromState.length - 1].path;
  const reportDir = join(dir, 'report');
  if (!existsSync(reportDir)) return undefined;
  const files = readdirSync(reportDir)
    .filter((f) => isReportJson(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
  return files.length ? join(reportDir, files[files.length - 1]) : undefined;
}

/**
 * Sessions persisted for `root`: the registry (~/.swipium/registry.json, which also covers custom
 * session dirs) plus a scan of the default per-project runs dir (the registry is capped). A session
 * belongs to the project when its state.json `root` resolves to the same directory.
 */
export function findProjectSessions(root: string, home = homedir()): SessionCandidate[] {
  const base = join(home, '.swipium');
  const dirs = new Set<string>();
  try {
    const reg = JSON.parse(readFileSync(join(base, 'registry.json'), 'utf8')) as Array<{ dir?: string }>;
    for (const e of reg) if (typeof e.dir === 'string') dirs.add(e.dir);
  } catch {
    /* no registry yet */
  }
  // Mirrors SessionStore's default session dir: ~/.swipium/runs/<sha256(resolve(root))[:16]>/<id>.
  const projectRuns = join(base, 'runs', createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16));
  try {
    for (const d of readdirSync(projectRuns, { withFileTypes: true })) if (d.isDirectory()) dirs.add(join(projectRuns, d.name));
  } catch {
    /* no runs for this project */
  }
  const want = canonical(root);
  const out: SessionCandidate[] = [];
  for (const dir of dirs) {
    try {
      const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
        id?: string;
        root?: string;
        createdAt?: number;
        artifacts?: Array<{ kind?: string; mime?: string; path?: string; createdAt?: number }>;
      };
      if (typeof st.id !== 'string' || typeof st.root !== 'string' || canonical(st.root) !== want) continue;
      out.push({ id: st.id, dir, createdAt: st.createdAt ?? 0, reportPath: latestReportJson(dir, st) });
    } catch {
      /* unreadable / partial session: skip */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
