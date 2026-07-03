// Mobile app discovery for low-context roots (Developer 1, roadmap §3.1 / §3.7). When a developer
// or agent points Swipium at a monorepo root, a parent directory, or any folder that is not itself
// a mobile app, this locates the candidate app(s) so `qa_test_this` can either proceed with the one
// strong candidate (recording a workaround) or ask ONE disambiguation question — instead of failing
// with NOT_MOBILE_PROJECT at a root that does in fact contain an app.
//
// Pure + bounded + side-effect free: it scans a fixed, shallow set of conventional locations and
// scores each candidate from cheap file markers. It never recurses into node_modules/build output.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { detectFramework, type Framework } from './detect.js';

export interface AppCandidate {
  /** Absolute path to the candidate app directory. */
  path: string;
  /** Path relative to the scanned root ('.' for the root itself). */
  rel: string;
  framework: Framework;
  /** Higher = a more confident mobile-app candidate. */
  score: number;
  /** Human-readable signals that contributed to the score. */
  reasons: string[];
  hasArtifact: boolean;
  appConfig: boolean;
  appId: string | null;
  /** Most-recent mtime (ms) of the candidate's key config files; 0 if unknown. */
  mtimeMs: number;
}

export interface FindAppsResult {
  root: string;
  /** Ranked best-first; only entries with a recognized framework are returned. */
  candidates: AppCandidate[];
  /** The directories actually inspected (for honest NOT_MOBILE_PROJECT reporting). */
  searchedLocations: string[];
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.swipium',
  '.expo',
  '.gradle',
  '.idea',
  '.vscode',
  'build',
  'dist',
  'out',
  'DerivedData',
  'Pods',
  'vendor',
  'coverage',
  '.next',
  '.turbo',
]);

/** Conventional parents whose immediate subdirectories may each hold a mobile app. */
const GLOB_PARENTS = ['apps', 'packages', 'mobile', 'examples', 'example', 'clients'];
/** Conventional direct app locations (relative to root). */
const DIRECT_DIRS = ['', 'ios', 'android', 'app', 'src-app'];

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Light, bounded check for a usable app config in `dir` (mirrors the framework signals). */
function appConfigPresent(dir: string, fw: Framework): boolean {
  switch (fw) {
    case 'expo':
      return ['app.json', 'app.config.js', 'app.config.ts'].some((f) => existsSync(join(dir, f)));
    case 'bare-react-native':
      return existsSync(join(dir, 'package.json'));
    case 'native-android':
      return ['app/build.gradle', 'app/build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((f) => existsSync(join(dir, f)));
    case 'native-ios':
      return readdirSafe(dir).some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace')) || existsSync(join(dir, 'Package.swift'));
    case 'flutter':
      return existsSync(join(dir, 'pubspec.yaml'));
    default:
      return false;
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Best-effort app id from cheap config markers (no APK badging — that is too heavy here). */
function lightAppId(dir: string, fw: Framework): string | null {
  if (fw === 'expo') {
    const cfg = readJson(join(dir, 'app.json'));
    const expo = (cfg?.expo ?? cfg) as { android?: { package?: string }; ios?: { bundleIdentifier?: string } } | undefined;
    const id = expo?.ios?.bundleIdentifier ?? expo?.android?.package;
    if (typeof id === 'string') return id;
  }
  for (const g of ['app/build.gradle', 'app/build.gradle.kts', 'android/app/build.gradle', 'android/app/build.gradle.kts']) {
    const p = join(dir, g);
    if (!existsSync(p)) continue;
    try {
      const m = readFileSync(p, 'utf8').match(/applicationId\s*[=\s]\s*["']([^"']+)["']/);
      if (m) return m[1];
    } catch {
      /* unreadable */
    }
  }
  return null;
}

/** Bounded heuristic for "an installable artifact probably exists here" (existence-only, no walk). */
function artifactPresent(dir: string): boolean {
  const candidates = [
    join(dir, 'android', 'app', 'build', 'outputs', 'apk'),
    join(dir, 'app', 'build', 'outputs', 'apk'),
    join(dir, 'build', 'app', 'outputs', 'flutter-apk'),
    join(dir, 'ios', 'build'),
    join(dir, 'apps', 'android'),
    join(dir, 'apps', 'ios'),
  ];
  if (candidates.some((p) => existsSync(p))) return true;
  // a top-level .apk/.ipa/.app dropped in the dir
  return readdirSafe(dir).some((f) => /\.(apk|aab|ipa)$/i.test(f) || f.endsWith('.app'));
}

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Podfile.lock', 'Gemfile.lock', 'pubspec.lock'];
const RECENT_MS = 1000 * 60 * 60 * 24 * 60; // 60 days

/** Score one directory as a mobile-app candidate. Returns null if no framework is recognized. */
function scoreDir(root: string, dir: string, nowMs: number): AppCandidate | null {
  const fw = detectFramework(dir);
  if (fw === 'unknown') return null;

  const reasons: string[] = [`framework=${fw}`];
  let score = 50; // a recognized framework is the dominant signal

  const appConfig = appConfigPresent(dir, fw);
  if (appConfig) {
    score += 15;
    reasons.push('app config present');
  }
  const hasArtifact = artifactPresent(dir);
  if (hasArtifact) {
    score += 20;
    reasons.push('build artifact present');
  }
  const appId = lightAppId(dir, fw);
  if (appId) {
    score += 10;
    reasons.push(`appId=${appId}`);
  }
  if (LOCKFILES.some((f) => existsSync(join(dir, f)))) {
    score += 5;
    reasons.push('lockfile present');
  }

  // recency: prefer the app the developer is actually working on
  const mtimeMs = Math.max(
    safeMtime(join(dir, 'package.json')),
    safeMtime(join(dir, 'app.json')),
    safeMtime(join(dir, 'pubspec.yaml')),
    safeMtime(dir),
  );
  if (mtimeMs && nowMs - mtimeMs < RECENT_MS) {
    score += 10;
    reasons.push('recently modified');
  }

  return { path: dir, rel: relative(root, dir) || '.', framework: fw, score, reasons, hasArtifact, appConfig, appId, mtimeMs };
}

/**
 * Discover mobile-app candidates at or under `root`. Bounded: root + a curated set of conventional
 * locations + the immediate children of apps/packages/mobile/examples. Best-first, deduped by path.
 *
 * `nowMs` is injected (default Date.now) so callers/tests stay deterministic.
 */
export function findMobileApps(root: string, nowMs: number = Date.now()): FindAppsResult {
  const searched = new Set<string>();
  const candidates = new Map<string, AppCandidate>();

  const consider = (dir: string) => {
    if (!dir || searched.has(dir)) return;
    if (!existsSync(dir)) return;
    try {
      if (!statSync(dir).isDirectory()) return;
    } catch {
      return;
    }
    searched.add(dir);
    const c = scoreDir(root, dir, nowMs);
    if (c && !candidates.has(c.path)) candidates.set(c.path, c);
  };

  // 1. direct conventional locations
  for (const rel of DIRECT_DIRS) consider(rel ? join(root, rel) : root);

  // 2. immediate children of conventional parents (apps/*, packages/*, mobile/*, examples/*)
  for (const parent of GLOB_PARENTS) {
    const parentDir = join(root, parent);
    for (const name of listDirs(parentDir)) consider(join(parentDir, name));
  }

  const ranked = [...candidates.values()].sort(
    (a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs || basename(a.path).localeCompare(basename(b.path)),
  );

  return { root, candidates: ranked, searchedLocations: [...searched].sort() };
}

/**
 * Decide what `qa_test_this` should do with the discovery result.
 * - 'adopt'      → exactly one recognized app; proceed with it.
 * - 'disambiguate' → ≥2 recognized apps; ask one monorepo_target question with ranked choices.
 * - 'none'       → no recognized app anywhere searched.
 */
export function classifyDiscovery(result: FindAppsResult): {
  decision: 'adopt' | 'disambiguate' | 'none';
  chosen?: AppCandidate;
  choices: AppCandidate[];
} {
  const choices = result.candidates;
  if (choices.length === 0) return { decision: 'none', choices };
  if (choices.length === 1) return { decision: 'adopt', chosen: choices[0], choices };
  return { decision: 'disambiguate', choices };
}
