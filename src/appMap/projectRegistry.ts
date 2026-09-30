// Vision Gap Fix 8: a DURABLE reverse registry of projectId > project root, so app-map MCP resource
// URIs (swipium://project/<projectId>/app-map…) stay resolvable across server restarts. projectId(root)
// is a one-way hash; without a persisted reverse lookup, a previously-returned resource URI only
// resolves while a live session for that root exists. This stores the mapping under ~/.swipium so any
// later server process can resolve it. Best-effort + defensive: a read/write failure is never fatal.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../lib/logger.js';
import { withFileLock, writeFileAtomicSync } from '../lib/lockfile.js';
import { projectId, appMapPath } from './store.js';

export interface ProjectRegistryEntry {
  projectId: string;
  root: string;
  lastSeenAt: string;
  appMapPath: string;
  packageName?: string | null;
  framework?: string | null;
}

interface RegistryFile {
  schemaVersion: 1;
  projects: Record<string, ProjectRegistryEntry>; // keyed by projectId
}

function registryDir(): string {
  return join(homedir(), '.swipium');
}
export function registryPath(): string {
  return join(registryDir(), 'projects.json');
}

function emptyRegistry(): RegistryFile {
  return { schemaVersion: 1, projects: {} };
}

/** Load the durable registry (empty when missing/corrupt). */
export function loadRegistry(): RegistryFile {
  const path = registryPath();
  if (!existsSync(path)) return emptyRegistry();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistryFile>;
    return { schemaVersion: 1, projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {} };
  } catch {
    return emptyRegistry();
  }
}

/** Max entries kept in projects.json (most recently seen first). */
export const MAX_PROJECT_ENTRIES = 200;
/** A lastSeenAt refresh alone rewrites the file at most this often per project. */
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

/** In-memory cache of the durable registry, loaded once per process and kept warm across calls. */
let cache: RegistryFile | null = null;
function registry(): RegistryFile {
  if (!cache) cache = loadRegistry();
  return cache;
}

/** Drop entries whose project root no longer exists (deleted temp roots…) and keep only the
 *  MAX_PROJECT_ENTRIES most recently seen. `keep` is always retained. */
function pruneEntries(projects: Record<string, ProjectRegistryEntry>, keep?: string): Record<string, ProjectRegistryEntry> {
  const live = Object.values(projects).filter((e) => e && typeof e.root === 'string' && (e.projectId === keep || existsSync(e.root)));
  live.sort((x, y) => (y.lastSeenAt ?? '').localeCompare(x.lastSeenAt ?? ''));
  const kept = live.slice(0, MAX_PROJECT_ENTRIES);
  if (keep && !kept.some((e) => e.projectId === keep) && projects[keep]) kept.push(projects[keep]);
  return Object.fromEntries(kept.map((e) => [e.projectId, e]));
}

/** Read-modify-write projects.json under its lock (another server may be writing too); compact JSON. */
function mutateRegistry(fn: (reg: RegistryFile) => RegistryFile | null): RegistryFile | null {
  mkdirSync(registryDir(), { recursive: true });
  return withFileLock(`${registryPath()}.lock`, () => {
    const next = fn(loadRegistry());
    if (next) writeFileAtomicSync(registryPath(), JSON.stringify(next));
    return next;
  });
}

/** Remember (or refresh) a project root in the durable registry. Best-effort, never throws.
 *  Skips the write when nothing but a recent lastSeenAt would change (app-map calls are frequent). */
export function rememberProject(root: string, info: { packageName?: string | null; framework?: string | null; at?: string } = {}): void {
  try {
    const id = projectId(root);
    const prev = registry().projects[id];
    const entry: ProjectRegistryEntry = {
      projectId: id,
      root,
      lastSeenAt: info.at ?? new Date().toISOString(),
      appMapPath: appMapPath(root),
      packageName: info.packageName ?? prev?.packageName ?? null,
      framework: info.framework ?? prev?.framework ?? null,
    };
    const unchanged =
      prev &&
      prev.root === entry.root &&
      prev.appMapPath === entry.appMapPath &&
      prev.packageName === entry.packageName &&
      prev.framework === entry.framework &&
      Math.abs(Date.parse(entry.lastSeenAt) - Date.parse(prev.lastSeenAt)) < LAST_SEEN_REFRESH_MS;
    if (unchanged) return;
    const written = mutateRegistry((reg) => ({ schemaVersion: 1, projects: pruneEntries({ ...reg.projects, [id]: entry }, id) }));
    cache = written ?? cache;
  } catch (e) {
    // In-memory + session fallbacks still work this process, but app-map resource URIs for this
    // project will NOT resolve after a restart. Surface that instead of losing it silently.
    try {
      const id = projectId(root);
      registry().projects[id] = { projectId: id, root, lastSeenAt: info.at ?? new Date().toISOString(), appMapPath: appMapPath(root) };
    } catch {
      /* ignore */
    }
    log('warn', 'failed to persist project registry (~/.swipium/projects.json); app-map URIs will not survive a restart', {
      root,
      err: String(e),
    });
  }
}

/** `swipium gc`: prune projects.json (missing roots, cap) under the lock. Never throws. */
export function compactProjectRegistry(opts: { dryRun?: boolean } = {}): { before: number; after: number; removed: number } {
  try {
    if (!existsSync(registryPath())) return { before: 0, after: 0, removed: 0 };
    if (opts.dryRun) {
      const reg = loadRegistry();
      const before = Object.keys(reg.projects).length;
      const after = Object.keys(pruneEntries(reg.projects)).length;
      return { before, after, removed: before - after };
    }
    let before = 0;
    const next = mutateRegistry((reg) => {
      before = Object.keys(reg.projects).length;
      return { schemaVersion: 1, projects: pruneEntries(reg.projects) };
    });
    cache = next ?? cache;
    const after = next ? Object.keys(next.projects).length : before;
    return { before, after, removed: before - after };
  } catch (e) {
    log('warn', 'failed to compact project registry', { err: String(e) });
    return { before: 0, after: 0, removed: 0 };
  }
}

/** Resolve a project root from a projectId via the durable registry. Verifies the map file exists. */
export function lookupRoot(id: string): { root: string; entry: ProjectRegistryEntry } | undefined {
  const entry = registry().projects[id];
  if (!entry) return undefined;
  return { root: entry.root, entry };
}

/** Force a reload from disk (used after another process may have written the registry). */
export function reloadRegistry(): void {
  cache = loadRegistry();
}
