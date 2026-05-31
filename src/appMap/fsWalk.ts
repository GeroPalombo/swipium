// Bounded, dependency-free source-file walker shared by the static scanner and code index.
// Never throws on an unreadable dir; caps total files so a huge monorepo can't blow up a scan.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.swipium', 'build', 'dist', 'out', '.next', '.expo', 'Pods', 'DerivedData',
  '.gradle', '.idea', 'vendor', 'coverage', '__pycache__', '.dart_tool', '.venv', 'venv', 'Carthage',
]);

export interface WalkOptions {
  exts?: string[]; // lowercase extensions incl. dot, e.g. ['.ts', '.tsx']; undefined = all
  maxFiles?: number; // default 4000
  maxDepth?: number; // default 12
  /** Match basenames exactly (e.g. AndroidManifest.xml, app.json) regardless of `exts`. */
  alsoNames?: string[];
}

export function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Recursively collect file paths under `root`, honoring ignore dirs + caps. Best-effort. */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const exts = opts.exts?.map((e) => e.toLowerCase());
  const names = new Set(opts.alsoNames ?? []);
  const maxFiles = opts.maxFiles ?? 4000;
  const maxDepth = opts.maxDepth ?? 12;
  const out: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.') && e.name !== '.well-known') {
        // allow hidden files only if explicitly named
        if (!names.has(e.name)) continue;
      }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        const extOk = !exts || exts.some((x) => lower.endsWith(x));
        if (extOk || names.has(e.name)) out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function fileHash(path: string): { hash: string; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const h = createHash('sha256').update(readFileSync(path)).digest('hex');
    return { hash: `sha256:${h}`, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

export function rel(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}
