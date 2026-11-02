// Which log a blocked ("not tested") run shows, and its last lines. One lookup used by report.html,
// summary.md and the GitHub summary, so all three point at the same log. No new log capture: only
// log artifacts the session already saved (build, Metro, logcat/simctl excerpts on findings).

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface LogPickInput {
  notTested?: { failureCode?: string } | null;
  findings?: Array<{ failureCode?: string; kind?: string; logUri?: string }>;
  artifacts?: Array<{ uri: string; kind: string; path?: string; createdAt?: number; label?: string }>;
}

export interface PickedLog {
  uri: string;
  /** Path as stored on the artifact (relative to the session folder since 2.4.0). */
  path?: string;
  /** Which row of the lookup table matched. */
  rule: 'build' | 'metro' | 'crash' | 'newest';
}

const LOG_KINDS = new Set(['log', 'logs', 'build', 'build-log', 'metro', 'logcat', 'crash', 'syslog']);
const isLogArtifact = (a: { kind: string; uri: string }) =>
  LOG_KINDS.has(a.kind) || /\/(logs?|metro|build|logcat)\//.test(a.uri) || /\.log$/.test(a.uri);

/**
 * The lookup table (plan W3.2):
 *   BUILD_FAILED                         > build log
 *   METRO_REQUIRED, METRO_WRONG_PROJECT  > Metro log
 *   NATIVE_CRASH, ANR, APP_LAUNCH_FAILED > logcat / simctl excerpt (finding logUri)
 *   anything else                        > newest log artifact
 *   none                                 > undefined ("no log captured")
 */
export function pickNotTestedLog(r: LogPickInput): PickedLog | undefined {
  const code = r.notTested?.failureCode ?? '';
  const arts = (r.artifacts ?? []).filter(isLogArtifact);
  const byNewest = [...arts].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const find = (re: RegExp) => byNewest.find((a) => re.test(a.kind) || re.test(a.uri) || re.test(a.label ?? ''));
  const pick = (a: (typeof arts)[number] | undefined, rule: PickedLog['rule']): PickedLog | undefined =>
    a ? { uri: a.uri, ...(a.path ? { path: a.path } : {}), rule } : undefined;

  if (code === 'BUILD_FAILED') {
    const hit = pick(find(/build|gradle|xcodebuild/i), 'build');
    if (hit) return hit;
  } else if (code === 'METRO_REQUIRED' || code === 'METRO_WRONG_PROJECT') {
    const hit = pick(find(/metro/i), 'metro');
    if (hit) return hit;
  } else if (code === 'NATIVE_CRASH' || code === 'ANR' || code === 'APP_LAUNCH_FAILED') {
    const f = (r.findings ?? []).find((x) => x.logUri && (x.failureCode === code || /crash|anr|launch/i.test(x.kind ?? '')));
    const fallback = (r.findings ?? []).find((x) => x.logUri);
    const uri = f?.logUri ?? fallback?.logUri;
    if (uri) {
      const art = (r.artifacts ?? []).find((a) => a.uri === uri);
      return { uri, ...(art?.path ? { path: art.path } : {}), rule: 'crash' };
    }
    const hit = pick(find(/logcat|crash|syslog/i), 'crash');
    if (hit) return hit;
  }
  return pick(byNewest[0], 'newest');
}

/** Last `n` lines of a log file. `path` may be relative to `baseDir` (the session folder).
 *  Returns undefined when the file can't be read. Reads at most the last 256 KB. */
export function readLogTail(path: string, baseDir?: string, n = 40): string[] | undefined {
  try {
    const abs = isAbsolute(path) || !baseDir ? path : join(baseDir, path);
    const size = statSync(abs).size;
    const buf = readFileSync(abs);
    const text = buf.subarray(Math.max(0, size - 256 * 1024)).toString('utf8');
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } catch {
    return undefined;
  }
}
