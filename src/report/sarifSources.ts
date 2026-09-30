// Source anchors for SARIF results (B3). GitHub code scanning only displays a result that has
// `locations[0].physicalLocation.artifactLocation.uri` pointing at a file in the repository
// (https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning).
// Swipium's evidence lives on a device, not in the source tree, so we anchor each result to the
// best REAL repo-relative file we can justify:
//   1. the app-map source file of the screen / feature the result names (when a map exists), else
//   2. the project manifest (app.json, package.json, Gradle app module, iOS Info.plist, pubspec).
// Every candidate is checked to exist under the root; nothing outside the root is ever emitted.
// URIs are relative to the REPOSITORY root (%SRCROOT% = the checkout root in CI), not the session
// root: in a monorepo (repo/apps/mobile) an anchor must read `apps/mobile/app.json`, or code
// scanning points at a nonexistent file. The repository root is found by walking up to the
// nearest `.git` entry (directory, or file for worktrees/submodules), with no git subprocess
// (git is outside Swipium's spawn scope, see lib/spawn.ts assertNoGitScope). Not a git checkout >
// the session root is used as before.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { appMapPath } from '../appMap/store.js';
import type { ReportData } from './export.js';

/** Where toSarif anchors results: a default manifest plus optional per-screen / per-workflow files. */
export interface SarifSourceMap {
  /** Repo-relative (POSIX) path of the fallback anchor file. */
  defaultUri: string;
  /** Lower-cased screen id/name/route > repo-relative source file. */
  byScreen?: Record<string, string>;
  /** Lower-cased workflow / feature title > repo-relative source file. */
  byWorkflow?: Record<string, string>;
}

/** Manifest candidates in preference order (first existing wins). `*` = one directory level. */
const MANIFEST_CANDIDATES = [
  'app.json',
  'package.json',
  'pubspec.yaml',
  'android/app/build.gradle.kts',
  'android/app/build.gradle',
  'app/build.gradle.kts',
  'app/build.gradle',
  'ios/*/Info.plist',
  '*/Info.plist',
  'README.md',
];

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** The repository top-level containing `root` (nearest ancestor-or-self with a `.git` entry), or
 * undefined when `root` is not inside a git checkout. */
export function repositoryTopLevel(root: string): string | undefined {
  let dir = resolve(root);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** POSIX prefix ('' or 'apps/mobile/') that turns a root-relative path into a repo-relative one. */
export function repositoryPrefix(root: string): string {
  const top = repositoryTopLevel(root);
  if (!top) return '';
  const rel = relative(top, resolve(root));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return '';
  return `${toPosix(rel)}/`;
}

/** A safe repo-relative path that exists as a file under root, or null. */
function existingRelative(root: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  const norm = normalize(rel);
  if (norm.startsWith('..')) return null;
  try {
    return statSync(join(root, norm)).isFile() ? toPosix(norm) : null;
  } catch {
    return null;
  }
}

function expandCandidate(root: string, pattern: string): string | null {
  const star = pattern.indexOf('*');
  if (star < 0) return existingRelative(root, pattern);
  const parent = pattern.slice(0, star).replace(/\/$/, '');
  const rest = pattern.slice(star + 1).replace(/^\//, '');
  let dirs: string[] = [];
  try {
    dirs = readdirSync(join(root, parent || '.'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'Pods')
      .map((d) => d.name)
      .sort();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const hit = existingRelative(root, parent ? `${parent}/${d}/${rest}` : `${d}/${rest}`);
    if (hit) return hit;
  }
  return null;
}

/** The project's manifest file (repo-relative), or `package.json` when nothing matches. */
export function projectManifestUri(root: string): string {
  for (const c of MANIFEST_CANDIDATES) {
    const hit = expandCandidate(root, c);
    if (hit) return hit;
  }
  return 'package.json';
}

interface RawMap {
  staticTopology?: { screens?: Array<{ id?: string; name?: string; route?: string; sourceFiles?: string[] }> };
  features?: Array<{ id?: string; title?: string; sourceFiles?: string[] }>;
}

/**
 * Build the SARIF anchor map for a report: manifest fallback + app-map screen/feature source files
 * (read-only; a missing or corrupt map just means manifest anchoring). Only screens/workflows the
 * report actually mentions are resolved. URIs are relative to the git repository top-level (see
 * repositoryTopLevel), or to `root` outside a git checkout.
 */
export function resolveSarifSources(root: string, r: Pick<ReportData, 'findings' | 'testOutcomes'>): SarifSourceMap {
  const out = resolveRootRelativeSources(root, r);
  const prefix = repositoryPrefix(root);
  if (!prefix) return out;
  const re = (rec?: Record<string, string>) => (rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, prefix + v])) : rec);
  return { defaultUri: prefix + out.defaultUri, byScreen: re(out.byScreen), byWorkflow: re(out.byWorkflow) };
}

/** resolveSarifSources before the repository-root prefix is applied (paths relative to `root`). */
function resolveRootRelativeSources(root: string, r: Pick<ReportData, 'findings' | 'testOutcomes'>): SarifSourceMap {
  const out: SarifSourceMap = { defaultUri: projectManifestUri(root), byScreen: {}, byWorkflow: {} };
  let map: RawMap | null = null;
  try {
    const p = appMapPath(root);
    if (existsSync(p)) map = JSON.parse(readFileSync(p, 'utf8')) as RawMap;
  } catch {
    map = null;
  }
  if (!map) return out;
  const firstFile = (files?: string[]) => {
    for (const f of files ?? []) {
      const hit = existingRelative(root, f);
      if (hit) return hit;
    }
    return null;
  };
  const screens = map.staticTopology?.screens ?? [];
  const wanted = new Set(r.findings.map((f) => (f as { screen?: string }).screen?.toLowerCase()).filter((s): s is string => Boolean(s)));
  for (const s of screens) {
    const keys = [s.id, s.name, s.route].filter((k): k is string => Boolean(k)).map((k) => k.toLowerCase());
    const key = keys.find((k) => wanted.has(k));
    if (!key) continue;
    const file = firstFile(s.sourceFiles);
    if (file) out.byScreen![key] = file;
  }
  for (const n of r.testOutcomes) {
    const wf = n.workflow.toLowerCase();
    const feature = (map.features ?? []).find((f) => f.title?.toLowerCase() === wf || f.id?.toLowerCase() === wf);
    const screen = screens.find((s) => s.name?.toLowerCase() === wf || s.id?.toLowerCase() === wf);
    const file = firstFile(feature?.sourceFiles) ?? firstFile(screen?.sourceFiles);
    if (file) out.byWorkflow![wf] = file;
  }
  return out;
}
