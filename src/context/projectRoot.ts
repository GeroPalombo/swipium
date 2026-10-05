// Resolve the project root the server should work in.
// Order (first hit wins):
//   1. explicit `projectRoot` arg (must be absolute + an existing directory; an invalid explicit
//      value is an error, never silently replaced by a fallback)
//   2. MCP roots (the client's declared workspace, the proper mechanism)
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
import { isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaError } from '../lib/result.js';

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

/** Steps 3-5 of the chain (env vars, then cwd). Exported for tests and CLI reuse. Env values are
 * explicit user/client configuration and are trusted as-is; only the cwd guess needs a marker. */
export function resolveFallbackRoot(opts: RootEnv = {}): ResolvedRoot | null {
  const env = opts.env ?? process.env;
  for (const key of ['SWIPIUM_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR'] as const) {
    const v = env[key]?.trim();
    if (v && isAbsolute(v) && isDir(v)) return { root: v, source: `env:${key}` };
  }
  const cwd = opts.cwd ?? process.cwd();
  if (isUsableCwd(cwd, opts.home ?? homedir())) return { root: resolve(cwd), source: 'cwd' };
  return null;
}

/** Choose among the client's MCP roots (review P2): the first existing file:// root that has a
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

const UNRESOLVED_HINT =
  'No project root: the client exposed no MCP roots, SWIPIUM_PROJECT_ROOT / CLAUDE_PROJECT_DIR are unset, and the server cwd is not an app directory (no package.json / app.json / pubspec.yaml / Gradle files / android/ / ios/ / *.xcodeproj / Podfile). ' +
  'Pass projectRoot="/absolute/path/to/app", or set SWIPIUM_PROJECT_ROOT in the MCP server "env" (or a "cwd" where the client supports it).';

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

export async function resolveProjectRoot(server: McpServer, explicit?: string, opts: RootEnv = {}): Promise<ResolvedRoot> {
  const resolved = await resolveProjectRootUnrecorded(server, explicit, opts);
  const slot = rootResolutionStore.getStore();
  if (slot && !slot.resolved && resolved.root) slot.resolved = { root: resolved.root, source: resolved.source };
  return resolved;
}

async function resolveProjectRootUnrecorded(server: McpServer, explicit?: string, opts: RootEnv = {}): Promise<ResolvedRoot> {
  // 1) explicit arg wins (must be an absolute, existing directory)
  if (explicit && explicit.trim()) {
    const p = explicit.trim();
    if (!isAbsolute(p)) {
      return { source: 'none', hint: `projectRoot must be an absolute path, got "${p}".` };
    }
    if (isDir(p)) {
      return { root: p, source: 'arg' };
    }
    return { source: 'none', hint: `Path not found or not a directory: ${p}` };
  }

  // 2) MCP roots (workspace the client exposed)
  try {
    const caps = server.server.getClientCapabilities?.();
    if (caps?.roots) {
      // Same 5 s cap as currentProjectRoots (src/server.ts); the SDK default is 60 s.
      const res = await server.server.listRoots(undefined, { timeout: 5_000 });
      const picked = pickMcpRoot(
        (res.roots ?? []).map((r) => r.uri),
        opts.home ?? homedir(),
      );
      if (picked) return { root: picked, source: 'mcp-roots' };
    }
  } catch {
    // client doesn't support roots, or the call failed; fall through
  }

  // 3-5) env vars, then a meaningful cwd
  const fallback = resolveFallbackRoot(opts);
  if (fallback) return fallback;

  return { source: 'none', hint: UNRESOLVED_HINT };
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
      'Pass projectRoot="/absolute/path/to/app" (or call qa_start_session with it first).',
      'Or set SWIPIUM_PROJECT_ROOT in the MCP server config "env".',
    ],
    clientHint: resolved.hint,
  });
}
