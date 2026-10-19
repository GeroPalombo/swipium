// Filesystem writes and deletes under a project root that never follow a symlink. A cloned repo can
// commit `.swipium/` (or any folder or file below it) as a symlink to a path outside the project; a
// plain write, append or recursive delete would then land on the user's own files. Every helper here
// lstat's each existing path component between the project root and the target and refuses a
// symlink (an fs error with code ELOOP, so callers report it as an unwritable path). The project
// root itself may be a symlink (e.g. /tmp on macOS).

import {
  appendFileSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomicSync } from './lockfile.js';

function symlinkError(path: string, why: string): Error {
  return Object.assign(new Error(`${path} ${why}`), { code: 'ELOOP' });
}

/** Throw unless `path` is strictly below `root` and no existing component between them (the target
 *  included) is a symlink. Components that do not exist yet are fine: nothing below them can be one. */
export function assertNoSymlinkUnder(root: string, path: string): void {
  const absRoot = resolve(root);
  const abs = resolve(path);
  const rel = relative(absRoot, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(absRoot, rel) !== abs)
    throw symlinkError(abs, 'is outside the project');
  let cur = absRoot;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    let isLink = false;
    try {
      isLink = lstatSync(cur).isSymbolicLink();
    } catch {
      return; // does not exist yet: nothing below it can be a link
    }
    if (isLink) throw symlinkError(cur, 'is a symlink, refusing to write through it');
  }
}

/** True when `path` is below `root` with no symlinked component (the non-throwing form). */
export function isNoFollowPath(root: string, path: string): boolean {
  try {
    assertNoSymlinkUnder(root, path);
    return true;
  } catch {
    return false;
  }
}

/** mkdir -p `dir` (below `root`) after the symlink check. */
export function mkdirNoFollow(root: string, dir: string): void {
  assertNoSymlinkUnder(root, dir);
  mkdirSync(dir, { recursive: true });
}

/** Write a file below `root` without following a symlink, creating parent folders. */
export function writeFileNoFollow(root: string, path: string, content: string): void {
  assertNoSymlinkUnder(root, path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, content);
}

/** Atomic (unique tmp + rename) write below `root` without following a symlink. The rename replaces
 *  the directory entry, so even a symlink planted after the check is replaced, not written through. */
export function writeFileAtomicNoFollow(root: string, path: string, content: string, opts: { mode?: number } = {}): void {
  assertNoSymlinkUnder(root, path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileAtomicSync(path, content, opts);
}

/** Append below `root` without following a symlink. When the file exists and its last byte is not a
 *  newline (a torn earlier append), `ensureLeadingNewline` writes one first so a line-oriented file
 *  (JSONL) never glues the new record onto a partial one. */
export function appendFileNoFollow(root: string, path: string, content: string, opts: { ensureLeadingNewline?: boolean } = {}): void {
  assertNoSymlinkUnder(root, path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  let prefix = '';
  if (opts.ensureLeadingNewline && !endsWithNewlineOrEmpty(path)) prefix = '\n';
  appendFileSync(path, prefix + content);
}

function endsWithNewlineOrEmpty(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return true; // absent: nothing to terminate
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** rm (optionally recursive) below `root` without following a symlinked parent. Returns false (and
 *  deletes nothing) when the path is outside the root or any component is a symlink. */
export function rmNoFollow(root: string, path: string, opts: { recursive?: boolean } = {}): boolean {
  if (!isNoFollowPath(root, path)) return false;
  rmSync(path, { force: true, recursive: !!opts.recursive });
  return true;
}

/** Resolve `path` against `root` and check the real location of its nearest existing ancestor lies
 *  inside the real project root (so a symlinked output folder cannot redirect generated files out of
 *  the project). Returns the absolute path or throws ELOOP. */
function assertRealpathContained(root: string, path: string): string {
  const realRoot = realpathSync(resolve(root));
  const abs = resolve(path);
  let probe = dirname(abs);
  for (;;) {
    try {
      const real = realpathSync(probe);
      const rel = relative(realRoot, real);
      if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(realRoot, rel) !== real)
        throw symlinkError(abs, 'resolves outside the project, refusing to write');
      return abs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const up = dirname(probe);
      if (up === probe) throw e;
      probe = up;
    }
  }
}

/** Create a NEW file below `root` (flag 'wx': never overwrite, never follow a symlink at the target)
 *  whose real parent lies inside the real project root. Returns 'written', or 'exists' when a file
 *  (or a link) is already there. Any other failure throws. */
export function writeFileExclusiveContained(root: string, path: string, content: string): 'written' | 'exists' {
  const abs = assertRealpathContained(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  assertRealpathContained(root, abs); // the folders just created must still resolve inside the root
  try {
    writeFileSync(abs, content, { flag: 'wx' });
    return 'written';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw e;
  }
}

/** Overwrite-allowed counterpart of writeFileExclusiveContained: realpath containment, and a
 *  symlink at the target itself is refused rather than written through. */
export function writeFileContained(root: string, path: string, content: string): void {
  const abs = assertRealpathContained(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  assertRealpathContained(root, abs);
  let isLink = false;
  try {
    isLink = lstatSync(abs).isSymbolicLink();
  } catch {
    /* absent */
  }
  if (isLink) throw symlinkError(abs, 'is a symlink, refusing to write through it');
  writeFileSync(abs, content);
}
