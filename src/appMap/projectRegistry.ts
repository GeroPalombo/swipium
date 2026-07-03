// Vision Gap Fix 8 — a DURABLE reverse registry of projectId → project root, so app-map MCP resource
// URIs (swipium://project/<projectId>/app-map…) stay resolvable across server restarts. projectId(root)
// is a one-way hash; without a persisted reverse lookup, a previously-returned resource URI only
// resolves while a live session for that root exists. This stores the mapping under ~/.swipium so any
// later server process can resolve it. Best-effort + defensive: a read/write failure is never fatal.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../lib/logger.js';
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

/** In-memory cache of the durable registry, loaded once per process and kept warm across calls. */
let cache: RegistryFile | null = null;
function registry(): RegistryFile {
  if (!cache) cache = loadRegistry();
  return cache;
}

/** Remember (or refresh) a project root in the durable registry. Best-effort, never throws. */
export function rememberProject(root: string, info: { packageName?: string | null; framework?: string | null; at?: string } = {}): void {
  try {
    const reg = registry();
    const id = projectId(root);
    reg.projects[id] = {
      projectId: id,
      root,
      lastSeenAt: info.at ?? new Date().toISOString(),
      appMapPath: appMapPath(root),
      packageName: info.packageName ?? reg.projects[id]?.packageName ?? null,
      framework: info.framework ?? reg.projects[id]?.framework ?? null,
    };
    mkdirSync(registryDir(), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
  } catch (e) {
    // In-memory + session fallbacks still work this process, but app-map resource URIs for this
    // project will NOT resolve after a restart — surface that instead of losing it silently.
    log('warn', 'failed to persist project registry (~/.swipium/projects.json) — app-map URIs will not survive a restart', {
      root,
      err: String(e),
    });
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
