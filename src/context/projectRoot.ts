// Resolve the project root the server should work in.
// Order (first hit wins):
//   1. explicit `projectRoot` arg (must be absolute + an existing directory; an invalid explicit
//      value is an error, never silently replaced by a fallback)
//   2. MCP roots (the client's declared workspace), on 2025-era connections only: protocol
//      2026-07-28 deprecates roots and has no server-to-client roots/list, so 2026 clients go
//      straight to the fallbacks below (pass projectRoot, or set SWIPIUM_PROJECT_ROOT)
//   3. env SWIPIUM_PROJECT_ROOT (user-set in the client's server config)
//   4. env CLAUDE_PROJECT_DIR (Claude Code sets it for every stdio server it launches)
//   5. process.cwd(), only when it is a real directory that is NOT the filesystem root and NOT
//      $HOME, AND it contains a project marker (package.json, app.json, pubspec.yaml, Gradle
//      build/settings files, android/, ios/, *.xcodeproj, *.xcworkspace, Podfile). GUI clients
//      often launch servers from `/`, `~` or an arbitrary directory, which must never be treated
//      as an app repo; clients that honor a configured `cwd` (Codex, Gemini, VS Code) land here.
// Unresolved: failureCode PROJECT_ROOT_UNRESOLVED (see unresolvedProjectRootError).

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { qaError } from '../lib/result.js';
import { servesModernEra } from './protocolEra.js';

export type ProjectRootSource = 'arg' | 'mcp-roots' | 'env:SWIPIUM_PROJECT_ROOT' | 'env:CLAUDE_PROJECT_DIR' | 'cwd' | 'none';

export interface ResolvedRoot {
  root?: string;
  source: ProjectRootSource;
  hint?: string;
}

export const PROJECT_ROOT_UNRESOLVED = 'PROJECT_ROOT_UNRESOLVED' as const;

/** Injectable process facts so the fallback chain is unit-testable. */
export interface RootEnv {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Files / directories whose presence marks a directory as a mobile (or JS) app project. */
export const PROJECT_MARKER_FILES = [
  'package.json',
  'app.json',
  'pubspec.yaml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'Podfile',
] as const;
export const PROJECT_MARKER_DIRS = ['android', 'ios'] as const;

/** Whether `dir` looks like an app project (see PROJECT_MARKER_FILES / _DIRS, *.xcodeproj, *.xcworkspace). */
export function hasProjectMarker(dir: string): boolean {
  if (PROJECT_MARKER_FILES.some((f) => existsSync(join(dir, f)))) return true;
  if (PROJECT_MARKER_DIRS.some((d) => isDir(join(dir, d)))) return true;
  try {
    return readdirSync(dir).some((e) => /\.(xcodeproj|xcworkspace)$/i.test(e));
  } catch {
    return false;
  }
}

/** A cwd is a usable project root only if it is a directory other than `/` (or a drive root) and
 * $HOME that contains a project marker (an arbitrary launch directory is never guessed as the app). */
export function isUsableCwd(cwd: string, home: string = homedir()): boolean {
  if (!cwd || !isAbsolute(cwd)) return false;
  const abs = resolve(cwd);
  if (abs === parse(abs).root) return false;
  if (home && abs === resolve(home)) return false;
  return isDir(abs) && hasProjectMarker(abs);
}

/** `/` (or a drive root) and $HOME are never a project root, whoever names them: discovery and the
 * artifact walk would crawl the whole disk. Same rule as MCP roots and the cwd guess. */
export function isOverlyBroadRoot(p: string, home: string = homedir()): boolean {
  const abs = resolve(p);
  return abs === parse(abs).root || (!!home && abs === resolve(home));
}

/** Directories that hold other people's files, never one app: a prebuilt .app/.apk found under them
 *  is not "this project's build" (for example a stray app under /private),
 *  and walking them takes minutes. */
const BROAD_SYSTEM_DIRS = [
  '/tmp',
  '/private',
  '/private/tmp',
  '/private/var',
  '/var',
  '/var/tmp',
  '/Users',
  '/home',
  '/Volumes',
  '/opt',
  '/usr',
  '/Library',
  '/Applications',
  '/System',
];
/** Per-user folders that hold caches, downloads and loose files rather than one app (a scan of
 *  ~/Library once planned WebDriverAgentRunner-Runner.app as the app under test). */
const BROAD_HOME_DIRS = ['Library', 'Downloads', 'Desktop'];

/** True for `/`, $HOME, its parent, ~/Library and friends, and the shared system directories above. */
export function isBroadSystemDir(root: string, home: string = homedir()): boolean {
  const abs = resolve(root);
  if (abs === parse(abs).root) return true;
  if (home) {
    const h = resolve(home);
    if (abs === h || abs === dirname(h) || BROAD_HOME_DIRS.some((d) => abs === join(h, d))) return true;
  }
  return BROAD_SYSTEM_DIRS.includes(abs);
}

const ROOT_ENV_KEYS = ['SWIPIUM_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR'] as const;

/** Why a SET root env var is unusable (not absolute, missing, or `/` / $HOME), else undefined. */
function envRootProblem(key: (typeof ROOT_ENV_KEYS)[number], v: string, home: string): string | undefined {
  if (!isAbsolute(v)) return `${key}=${JSON.stringify(v)} is not an absolute path`;
  if (!isDir(v)) return `${key}=${JSON.stringify(v)} does not exist or is not a directory`;
  if (isOverlyBroadRoot(v, home)) return `${key}=${JSON.stringify(v)} is the filesystem root or the home directory, not an app`;
  return undefined;
}

/** Steps 3-5 of the chain (env vars, then cwd). Exported for tests and CLI reuse. Env values are
 * explicit user/client configuration and are trusted as-is (only `/` and $HOME are refused);
 * only the cwd guess needs a marker. */
export function resolveFallbackRoot(opts: RootEnv = {}): ResolvedRoot | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  for (const key of ROOT_ENV_KEYS) {
    const v = env[key]?.trim();
    if (v && !envRootProblem(key, v, home)) return { root: resolve(v), source: `env:${key}` };
  }
  const cwd = opts.cwd ?? process.cwd();
  if (isUsableCwd(cwd, opts.home ?? homedir())) return { root: resolve(cwd), source: 'cwd' };
  return null;
}

/** Choose among the client's MCP roots: the first existing file:// root that has a
 * project marker; else the first one that is neither `/` nor $HOME. A client exposing
 * [$HOME, app] must land on the app, not on the home directory. Exported for tests. */
export function pickMcpRoot(uris: unknown[], home: string = homedir()): string | undefined {
  const dirs: string[] = [];
  for (const u of uris) {
    if (typeof u !== 'string' || !u.startsWith('file://')) continue;
    try {
      const p = fileURLToPath(u);
      if (isDir(p)) dirs.push(p);
    } catch {
      /* malformed URI, skip */
    }
  }
  const unsafe = (p: string) => {
    const abs = resolve(p);
    return abs === parse(abs).root || (!!home && abs === resolve(home));
  };
  return dirs.find((p) => !unsafe(p) && hasProjectMarker(p)) ?? dirs.find((p) => !unsafe(p));
}

/** The PROJECT_ROOT_UNRESOLVED hint. Says precisely why a SET env var was skipped: a typo
 * in the fix the README recommends must not read as "unset". */
export function unresolvedRootHint(opts: RootEnv = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const unset: string[] = [];
  const skipped: string[] = [];
  for (const key of ROOT_ENV_KEYS) {
    const v = env[key]?.trim();
    if (!v) unset.push(key);
    else {
      const problem = envRootProblem(key, v, home);
      if (problem) skipped.push(`${problem} (skipped)`);
    }
  }
  const envPart = [...skipped, ...(unset.length ? [`${unset.join(' / ')} ${unset.length === 1 ? 'is' : 'are'} unset`] : [])].join(', ');
  return (
    `No project root: the client exposed no MCP roots, ${envPart}, and the server cwd is not an app directory (no package.json / app.json / pubspec.yaml / Gradle files / android/ / ios/ / *.xcodeproj / Podfile). ` +
    'Pass projectRoot="/absolute/path/to/app", or set SWIPIUM_PROJECT_ROOT in the MCP server "env" to the absolute app directory (or a "cwd" where the client supports it).'
  );
}

/** Per-tool-call record of the first project root resolveProjectRoot() found (AsyncLocalStorage,
 * like the response mode). Lets the server wrapper surface `rootSource` on EVERY tool that
 * resolves a root without threading it through each result builder. */
const rootResolutionStore = new AsyncLocalStorage<{ resolved?: { root: string; source: ProjectRootSource } }>();

/** Run `fn` (one tool call) while recording the project root it resolves. */
export async function withRootResolutionRecording<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; resolved?: { root: string; source: ProjectRootSource } }> {
  const slot: { resolved?: { root: string; source: ProjectRootSource } } = {};
  const value = await rootResolutionStore.run(slot, fn);
  return { value, resolved: slot.resolved };
}

/** The note shown when the root was guessed from the server's working directory. */
export function cwdRootNote(root: string): string {
  return `project root taken from server cwd: ${root}; pass projectRoot to override`;
}

/** Additively stamp `rootSource` (+ `projectRoot` when absent) onto a successful tool result, and
 * the cwd note onto its text when the root was only guessed from the server cwd. Results that
 * already carry `rootSource`, errors, and results without structuredContent are left as-is. */
export function annotateRootSource(result: unknown, resolved: { root: string; source: ProjectRootSource } | undefined): unknown {
  if (!resolved) return result;
  const r = result as CallToolResult | undefined;
  const sc = r?.structuredContent as Record<string, unknown> | undefined;
  if (!r || r.isError || !sc || typeof sc !== 'object' || Array.isArray(sc) || 'rootSource' in sc) return result;
  const structuredContent = { ...sc, rootSource: resolved.source, ...('projectRoot' in sc ? {} : { projectRoot: resolved.root }) };
  let content = r.content;
  if (resolved.source === 'cwd' && Array.isArray(content)) {
    const i = content.findIndex((c) => c.type === 'text');
    if (i >= 0) {
      const block = content[i] as { type: 'text'; text: string };
      content = [...content];
      content[i] = { ...block, text: `${block.text}\nℹ ${cwdRootNote(resolved.root)}` };
    }
  }
  return { ...r, content, structuredContent };
}

/** The client's MCP roots per server instance (keyed on the low-level Server, which test fakes
 *  provide too). Cleared by notifications/roots/list_changed (src/server.ts). */
const clientRootsCache = new WeakMap<object, string[]>();

export function clearClientRootsCache(server: McpServer): void {
  clientRootsCache.delete(server.server);
}

/**
 * The root URIs the connected client exposes (MCP roots), asked once per server instance and
 * cached until the client sends notifications/roots/list_changed. [] when the client does not
 * advertise roots, on a 2026-07-28 instance (listRoots() throws there: no server-to-client
 * requests, and roots are deprecated in that revision), or when the call fails (not cached).
 */
export async function clientRootUris(server: McpServer): Promise<string[]> {
  const hit = clientRootsCache.get(server.server);
  if (hit) return hit;
  try {
    const caps = servesModernEra(server) ? undefined : server.server.getClientCapabilities?.();
    if (!caps?.roots) return [];
    // 5 s cap; the SDK default is 60 s.
    const res = await server.server.listRoots(undefined, { timeout: 5_000 });
    const uris = (res.roots ?? []).map((r) => r.uri).filter((u): u is string => typeof u === 'string');
    clientRootsCache.set(server.server, uris);
    return uris;
  } catch {
    return []; // client doesn't support roots, or the call failed
  }
}

export async function resolveProjectRoot(server: McpServer, explicit?: string, opts: RootEnv = {}): Promise<ResolvedRoot> {
  const resolved = await resolveProjectRootUnrecorded(server, explicit, opts);
  const slot = rootResolutionStore.getStore();
  if (slot && !slot.resolved && resolved.root) slot.resolved = { root: resolved.root, source: resolved.source };
  return resolved;
}

async function resolveProjectRootUnrecorded(server: McpServer, explicit?: string, opts: RootEnv = {}): Promise<ResolvedRoot> {
  // 1) explicit arg wins (must be an absolute, existing directory)
  if (explicit && explicit.trim()) {
    const raw = explicit.trim();
    if (!isAbsolute(raw)) {
      return { source: 'none', hint: `projectRoot must be an absolute path, got "${raw}".` };
    }
    // Normalize once here (trailing "/", "..", "."), so the session root, project
    // hash, artifact search and outside-root checks all see one spelling of the directory.
    const p = resolve(raw);
    // Refused fast: app discovery + the artifact walk under `/` or $HOME took minutes.
    if (isOverlyBroadRoot(p, opts.home ?? homedir())) {
      return {
        source: 'none',
        hint: `projectRoot "${p}" is the filesystem root or the home directory, which is never an app project. Pass the app's own directory.`,
      };
    }
    // Shared system folders (/Applications, /Users, ~/Library…) too, before any walk.
    if (isBroadSystemDir(p, opts.home ?? homedir())) {
      return {
        source: 'none',
        hint: `projectRoot "${p}" is a shared system or user folder (other apps, caches, downloads), not one app project. Pass the app's own directory.`,
      };
    }
    if (isDir(p)) {
      return { root: p, source: 'arg' };
    }
    return { source: 'none', hint: `Path not found or not a directory: ${p}` };
  }

  // 2) MCP roots (workspace the client exposed; never on a 2026-07-28 instance), cached per instance.
  const picked = pickMcpRoot(await clientRootUris(server), opts.home ?? homedir());
  if (picked) return { root: picked, source: 'mcp-roots' };

  // 3-5) env vars, then a meaningful cwd
  const fallback = resolveFallbackRoot(opts);
  if (fallback) return fallback;

  return { source: 'none', hint: unresolvedRootHint(opts) };
}

/**
 * The typed error every tool should return when resolveProjectRoot() finds nothing. Keeps the
 * failureCode (PROJECT_ROOT_UNRESOLVED) and wording consistent across call sites.
 */
export function unresolvedProjectRootError(resolved: ResolvedRoot, opts: { what?: string; nextSteps?: string[] } = {}): CallToolResult {
  return qaError({
    what: opts.what ?? 'Could not resolve a project root',
    changedState: false,
    retrySafe: true,
    failureCode: PROJECT_ROOT_UNRESOLVED,
    nextSteps: opts.nextSteps ?? [
      'Pass projectRoot="/absolute/path/to/app" (or call qa_start_session with it first, then pass the sessionId it returns).',
      'Or set SWIPIUM_PROJECT_ROOT in the MCP server config "env".',
    ],
    clientHint: resolved.hint,
  });
}
