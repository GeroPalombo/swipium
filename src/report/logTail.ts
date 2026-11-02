// Which log a blocked ("not tested") run shows, and its last lines. One lookup used by report.html,
// summary.md and the GitHub summary, so all three point at the same log. No new log capture: only
// log artifacts the session already saved (build, Metro, logcat/simctl excerpts on findings).

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { artifactDirectoryName } from '../session/store.js';

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
const fileName = (a: { uri: string }) => a.uri.slice(a.uri.lastIndexOf('/') + 1);
const isLogArtifact = (a: { kind: string; uri: string }) =>
  LOG_KINDS.has(a.kind) || /\/(logs?|metro|build|logcat)\//.test(a.uri) || /\.log$/.test(a.uri);

/**
 * The lookup table:
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
  const find = (...preds: Array<(a: (typeof arts)[number]) => boolean>) => {
    for (const p of preds) {
      const hit = byNewest.find(p);
      if (hit) return hit;
    }
    return undefined;
  };
  const pick = (a: (typeof arts)[number] | undefined, rule: PickedLog['rule']): PickedLog | undefined =>
    a ? { uri: a.uri, ...(a.path ? { path: a.path } : {}), rule } : undefined;

  // Match on the file name and label, not the whole URI: other logs mention "build" or "metro"
  // too (WDA build log, metro diagnose logcat), and those must not win just by being newer.
  if (code === 'BUILD_FAILED') {
    const hit = pick(
      find(
        (a) => a.kind === 'build' || a.kind === 'build-log',
        (a) => /^build-[^/]*\.log$|gradle|xcodebuild/i.test(fileName(a)) || /^(failed )?build log/i.test(a.label ?? ''),
      ),
      'build',
    );
    if (hit) return hit;
  } else if (code === 'METRO_REQUIRED' || code === 'METRO_WRONG_PROJECT') {
    const hit = pick(
      find(
        (a) => a.kind === 'metro',
        (a) => /^metro[^/]*\.log$/i.test(fileName(a)),
      ),
      'metro',
    );
    if (hit) return hit;
  } else if (code === 'NATIVE_CRASH' || code === 'ANR' || code === 'APP_LAUNCH_FAILED') {
    const f = (r.findings ?? []).find((x) => x.logUri && (x.failureCode === code || /crash|anr|launch/i.test(x.kind ?? '')));
    const fallback = (r.findings ?? []).find((x) => x.logUri);
    const uri = f?.logUri ?? fallback?.logUri;
    if (uri) {
      const art = (r.artifacts ?? []).find((a) => a.uri === uri);
      return { uri, ...(art?.path ? { path: art.path } : {}), rule: 'crash' };
    }
    const hit = pick(
      find(
        (a) => a.kind === 'crash' || /^(crash|anr)-/i.test(fileName(a)),
        (a) => a.kind === 'logcat' || a.kind === 'syslog',
      ),
      'crash',
    );
    if (hit) return hit;
  }
  return pick(byNewest[0], 'newest');
}

// Session subfolders a report may read from. The report JSON can come from anywhere (a CI
// artifact, a PR), so its artifact paths are untrusted: only these folders, never dotfiles.
const READABLE_KINDS = ['screenshot', 'checkpoint', 'recording', 'logs', 'logcat', 'metro', 'wda', 'baseline', 'dump'];
const READABLE_DIRS = new Set(READABLE_KINDS.map(artifactDirectoryName));

/**
 * Absolute real path of a regular file inside the session folder, or undefined. `path` is relative
 * to `sessionDir` (or absolute inside it, as reports before 2.4.0 stored it). Rejects `..`, empty or
 * dot-prefixed segments, folders that are not artifact folders, symlinks whose target leaves the
 * folder or lands outside the artifact folders, and anything that is not a regular file (FIFOs, devices, directories).
 */
export function resolveSessionFile(sessionDir: string, path: string): string | undefined {
  try {
    if (!path || path.includes('\0')) return undefined;
    const lexRoot = resolve(sessionDir);
    const realRoot = realpathSync(lexRoot);
    let rel = path;
    if (isAbsolute(path)) {
      rel = relative(lexRoot, path);
      if (rel.startsWith('..') || isAbsolute(rel)) rel = relative(realRoot, path);
    }
    const segs = rel.split(/[\\/]/);
    if (segs.length < 2 || !READABLE_DIRS.has(segs[0])) return undefined;
    if (segs.some((s) => !s || s.startsWith('.'))) return undefined;
    const real = realpathSync(join(realRoot, ...segs));
    if (!real.startsWith(realRoot + sep)) return undefined;
    // The target must sit in an artifact folder too: a symlink in screenshots/ pointing at
    // state.json stays inside the session but is not an artifact.
    const realSegs = relative(realRoot, real).split(/[\\/]/);
    if (realSegs.length < 2 || !READABLE_DIRS.has(realSegs[0]) || realSegs.some((s) => !s || s.startsWith('.'))) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

// O_NONBLOCK so a FIFO swapped in after the checks can't hang the open; fstat then refuses it.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Read a regular file: the whole file (undefined when bigger than `maxBytes`), or with `fromEnd`
 *  its last `maxBytes`. Undefined for anything that is not a regular file. */
export function readRegularFile(abs: string, maxBytes: number, fromEnd = false): { buf: Buffer; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(abs, OPEN_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    if (st.size > maxBytes && !fromEnd) return undefined;
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: buf.subarray(0, got), truncated: start > 0 };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const TAIL_BYTES = 256 * 1024;

/** Last `n` lines of a log file. With `baseDir` (the session folder), `path` goes through
 *  resolveSessionFile first. Returns undefined when the file can't be read. Reads at most the last 256 KiB. */
export function readLogTail(path: string, baseDir?: string, n = 40): string[] | undefined {
  const abs = baseDir ? resolveSessionFile(baseDir, path) : path;
  if (!abs) return undefined;
  const got = readRegularFile(abs, TAIL_BYTES, true);
  if (!got) return undefined;
  const lines = got.buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  if (got.truncated) lines.shift(); // started mid-line
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}
