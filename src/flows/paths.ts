// Project-root confinement for paths that flow files (possibly from an untrusted cloned repo)
// or agents hand to the flow runner / repair tool: image templates, visual baselines and flow
// YAML files to patch. A path must resolve — after following symlinks — inside the project root.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class PathOutsideRootError extends Error {
  readonly code = 'PATH_OUTSIDE_ROOT';
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(`path "${requested}" resolves outside the project root (${root}) — flow files may only reference files under the project root`);
    this.name = 'PathOutsideRootError';
  }
}

function real(p: string): string {
  // Resolve symlinks on the longest existing prefix (the leaf may not exist yet).
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return p;
    tail.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ''));
    cur = parent;
  }
  try {
    return resolve(realpathSync(cur), ...tail);
  } catch {
    return p;
  }
}

function within(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/** Resolve `p` (relative to root, or absolute) and require it to stay under root after realpath.
 *  Throws PathOutsideRootError otherwise. */
export function resolveWithinRoot(root: string, p: string): string {
  const base = real(resolve(root));
  const abs = real(isAbsolute(p) ? resolve(p) : resolve(root, p));
  if (!within(abs, base)) throw new PathOutsideRootError(p, base);
  return abs;
}

/** Non-throwing variant: the confined path, or null when it escapes the root. */
export function withinRootOrNull(root: string, p: string): string | null {
  try {
    return resolveWithinRoot(root, p);
  } catch {
    return null;
  }
}
