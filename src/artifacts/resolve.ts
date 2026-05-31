// Artifact Resolver V2 (roadmap §4) — find the build a developer actually has, wherever it
// lives. detectContext() only looked under the project root and apps/android|ios; most real
// builds land deep under Gradle/Flutter/Xcode output trees. This module does a bounded
// recursive walk of the project (plus opt-in DerivedData), classifies every .apk/.aab/.ipa/.app
// by platform + build type + installability, ranks them, and reports EXACTLY where it looked
// so a "no artifact" result is explainable rather than a dead end.
//
// Split for testability: the filesystem walk + the PURE ranking are separate. Tool-dependent
// enrichment (aapt2 app id / native ABIs, Info.plist bundle id) is an optional async pass so
// the core resolution works (and is unit-testable) without any Android/Xcode toolchain.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { apkBadging } from '../lib/android.js';
import { parseSupportedPlatforms } from '../ios/signing.js';
import type { FailureCode } from '../oracle/failures.js';

export type ArtifactType = 'apk' | 'aab' | 'ipa' | 'app';
export type ArtifactPlatform = 'android' | 'ios';
export type PlatformPref = 'android' | 'ios' | 'any';
export type BuildTypePref = 'debug' | 'release' | 'any';
export type BuildType = 'debug' | 'release' | 'unknown';
export type InstallTarget = 'android-emulator' | 'android-real' | 'ios-simulator' | 'ios-real';

export interface ArtifactCandidate {
  path: string;
  type: ArtifactType;
  platform: ArtifactPlatform;
  sizeBytes: number;
  mtimeMs: number;
  buildType: BuildType;
  outsideRoot: boolean;
  /** Human label of which search location matched (e.g. "gradle apk output"). */
  source: string;
  /** Targets this artifact can DIRECTLY install on, before runtime ABI/signing checks.
   *  An .aab is NOT directly installable → []; see convertibleTo/requiresTool. */
  installableOn: InstallTarget[];
  /** Types this artifact can be converted into to become installable (e.g. .aab → .apk). */
  convertibleTo?: ArtifactType[];
  /** External tool needed to convert/install (e.g. 'bundletool' for .aab). */
  requiresTool?: string;
  /** Filled by enrichCandidates(): android package / iOS bundle id. */
  appId?: string | null;
  /** Filled by enrichCandidates(): native ABIs an APK ships (empty = pure JS/no native code). */
  abis?: string[];
  /** Filled by enrichCandidates(): version name (Android versionName / iOS CFBundleShortVersionString). */
  versionName?: string | null;
  /** Filled by enrichCandidates(): Android versionCode / iOS CFBundleVersion. */
  versionCode?: string | number | null;
  /** Filled by enrichCandidates(): Android APK minSdkVersion. */
  minSdk?: number | null;
  /** Filled by enrichCandidates(): iOS CFBundleSupportedPlatforms (e.g. ["iPhoneOS"] / ["iPhoneSimulator"]). */
  supportedPlatforms?: string[];
  warnings: string[];
  /** Higher = better fit for the requested options. */
  score: number;
}

export interface ResolveOptions {
  projectRoot: string;
  platform?: PlatformPref;
  buildType?: BuildTypePref;
  /** Explicit artifact path — short-circuits the search (still validated/classified). */
  explicitPath?: string;
  /** Allow a best candidate found outside the project root (downloads, DerivedData). */
  allowOutsideRoot?: boolean;
  /** Require the artifact to be installable on a specific target (filters + scores). */
  requireInstallableOn?: InstallTarget;
  /** Bounded recursion depth for the project walk (default 7). */
  maxDepth?: number;
}

export interface ResolveResult {
  candidates: ArtifactCandidate[]; // ranked, best first
  best: ArtifactCandidate | null;
  newest: ArtifactCandidate | null; // newest by mtime regardless of score
  searchedLocations: string[];
  warnings: string[];
  /** Set when no usable artifact was resolved — a typed, actionable blocker. */
  failureCode?: FailureCode;
}

const MIN_APK_BYTES = 1024 * 1024; // <1MB .apk is almost always a Git-LFS pointer
const SKIP_DIRS = new Set(['node_modules', '.git', '.swipium', 'Pods', '.gradle', 'DerivedData', '.expo']);
const ART_EXT = /\.(apk|aab|ipa|app)$/i;

function classifyBuildType(path: string): BuildType {
  const p = path.toLowerCase();
  if (/[/\\](release|prod|production)[/\\]/.test(p) || /-release\./.test(p)) return 'release';
  if (/[/\\](debug|dev|development)[/\\]/.test(p) || /-debug\./.test(p)) return 'debug';
  return 'unknown';
}

/** A .app under an iphonesimulator product dir is simulator-only; iphoneos is device-only. */
function iosAppInstallTargets(path: string): { targets: InstallTarget[]; warnings: string[] } {
  const p = path.toLowerCase();
  if (p.includes('iphonesimulator') || p.includes('-simulator') || p.includes('/simulator/')) {
    return { targets: ['ios-simulator'], warnings: [] };
  }
  if (p.includes('iphoneos') || p.includes('-iphoneos')) {
    return { targets: ['ios-real'], warnings: ['device build (.app) — installing on a real device requires signing'] };
  }
  // Unknown destination — assume simulator (the common QA-first case) but warn.
  return { targets: ['ios-simulator'], warnings: ['could not infer simulator vs device from path — assuming simulator'] };
}

function baseInstallTargets(type: ArtifactType, path: string): { targets: InstallTarget[]; warnings: string[]; convertibleTo?: ArtifactType[]; requiresTool?: string } {
  switch (type) {
    case 'apk':
      return { targets: ['android-emulator', 'android-real'], warnings: [] };
    case 'aab':
      // An .aab is NOT directly installable. It must be converted to an APK set (bundletool).
      // installableOn stays [] so it never flows into an install path as if it were ready.
      return { targets: [], warnings: ['.aab is not directly installable — convert to an APK with bundletool first'], convertibleTo: ['apk'], requiresTool: 'bundletool' };
    case 'ipa':
      return { targets: ['ios-real'], warnings: ['.ipa installs only on a real device (with signing) — use a simulator .app for the simulator'] };
    case 'app':
      return iosAppInstallTargets(path);
  }
}

function makeCandidate(path: string, type: ArtifactType, source: string, projectRoot: string): ArtifactCandidate | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const sizeBytes = type === 'app' ? dirSize(path) : st.size;
  const warnings: string[] = [];
  if (type === 'apk' && sizeBytes < MIN_APK_BYTES) {
    warnings.push('APK <1MB — likely a Git-LFS pointer, not a real build');
  }
  const platform: ArtifactPlatform = type === 'ipa' || type === 'app' ? 'ios' : 'android';
  const { targets, warnings: instWarn, convertibleTo, requiresTool } = baseInstallTargets(type, path);
  return {
    path,
    type,
    platform,
    sizeBytes,
    mtimeMs: st.mtimeMs,
    buildType: classifyBuildType(path),
    outsideRoot: !path.startsWith(projectRoot + sep) && path !== projectRoot,
    source,
    installableOn: targets,
    convertibleTo,
    requiresTool,
    warnings: [...warnings, ...instWarn],
    score: 0,
  };
}

/** Shallow size of a .app bundle's top-level files (cheap signal that it's a real bundle). */
function dirSize(dir: string): number {
  try {
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) {
        try {
          total += statSync(join(dir, e.name)).size;
        } catch {
          /* skip */
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function artifactType(name: string): ArtifactType | null {
  const m = name.toLowerCase().match(/\.(apk|aab|ipa|app)$/);
  return m ? (m[1] as ArtifactType) : null;
}

/** Label the search location a hit came from, for the "exactly where I looked" report (§3.4). */
function sourceLabel(relDir: string, type: ArtifactType): string {
  const r = relDir.toLowerCase();
  if (r.includes('build/app/outputs/flutter-apk')) return 'flutter apk output';
  if (r.includes('outputs/bundle')) return 'gradle aab output';
  if (r.includes('outputs/apk')) return 'gradle apk output';
  if (r.includes('build/ios/iphonesimulator')) return 'flutter/xcode simulator app output';
  if (r.includes('deriveddata')) return 'Xcode DerivedData';
  if (r.includes('apps/android') || r.includes('apps/ios')) return 'apps/ directory';
  if (relDir === '' || relDir === '.') return 'project root';
  return `${type} under ${relDir || 'project'}`;
}

/**
 * Bounded recursive walk collecting artifacts. Pure filesystem; no external tools. Records every
 * directory it descends into so the caller can report exact search locations. `.app` is a
 * directory — we record it as a hit and do NOT descend into it.
 */
function walk(
  root: string,
  projectRoot: string,
  maxDepth: number,
  out: ArtifactCandidate[],
  searched: Set<string>,
  depth = 0,
): void {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  searched.add(root);
  for (const e of entries) {
    const full = join(root, e.name);
    const type = artifactType(e.name);
    if (type === 'app' && e.isDirectory()) {
      const c = makeCandidate(full, 'app', sourceLabel(root.slice(projectRoot.length + 1), 'app'), projectRoot);
      if (c) out.push(c);
      continue; // don't descend into a .app
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(full, projectRoot, maxDepth, out, searched, depth + 1);
    } else if (type && type !== 'app') {
      const c = makeCandidate(full, type, sourceLabel(root.slice(projectRoot.length + 1), type), projectRoot);
      if (c) out.push(c);
    }
  }
}

/** PURE: score + sort candidates against the requested options. Best first. */
export function rankCandidates(candidates: ArtifactCandidate[], opts: ResolveOptions): ArtifactCandidate[] {
  const platformPref = opts.platform ?? 'any';
  const buildPref = opts.buildType ?? 'any';
  const newest = candidates.reduce((m, c) => Math.max(m, c.mtimeMs), 0);

  const scored = candidates.map((c) => {
    let score = 0;
    // Directly-installable beats archive-only.
    score += c.type === 'apk' || c.type === 'app' ? 40 : 10;
    // Platform preference.
    if (platformPref !== 'any') score += c.platform === platformPref ? 30 : -100;
    // Build-type preference (debug is the QA-first default when the caller says 'debug').
    if (buildPref !== 'any' && c.buildType === buildPref) score += 20;
    if (buildPref !== 'any' && c.buildType !== 'unknown' && c.buildType !== buildPref) score -= 10;
    // Required install target.
    if (opts.requireInstallableOn) {
      score += c.installableOn.includes(opts.requireInstallableOn) ? 50 : -200;
    }
    // Inside the project root beats a stray download/DerivedData hit.
    if (c.outsideRoot) score -= 25;
    // Lint-y / pointer warnings push a candidate down.
    score -= c.warnings.length * 5;
    // Recency: up to +20 for the newest, scaled.
    if (newest > 0) score += Math.round((c.mtimeMs / newest) * 20);
    return { ...c, score };
  });

  return scored.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
}

/**
 * Enrich the top `limit` candidates with toolchain-derived facts (Android app id + native ABIs
 * via aapt2; iOS bundle id from the .app Info.plist). Best-effort: silently leaves fields unset
 * when the tool/file is unavailable. Mutates + returns the same array.
 */
export async function enrichCandidates(candidates: ArtifactCandidate[], limit = 3): Promise<ArtifactCandidate[]> {
  for (const c of candidates.slice(0, limit)) {
    try {
      if (c.type === 'apk') {
        // One aapt2 call for all Android metadata (was two: packageId + ABIs).
        const b = await apkBadging(c.path);
        if (b) {
          c.appId = b.packageId;
          c.abis = b.abis;
          c.versionName = b.versionName;
          c.versionCode = b.versionCode;
          c.minSdk = b.minSdk;
        }
      } else if (c.type === 'app') {
        const meta = appInfoPlistMeta(c.path);
        c.appId = meta.bundleId;
        c.versionName = meta.versionName;
        c.versionCode = meta.versionCode;
        c.supportedPlatforms = meta.supportedPlatforms;
      }
    } catch {
      /* enrichment is best-effort */
    }
  }
  return candidates;
}

/** Read identity + version + supported platforms from a .app's Info.plist (XML plists only). */
export function appInfoPlistMeta(appDir: string): { bundleId: string | null; versionName: string | null; versionCode: string | null; supportedPlatforms: string[] } {
  const plist = join(appDir, 'Info.plist');
  if (!existsSync(plist)) return { bundleId: null, versionName: null, versionCode: null, supportedPlatforms: [] };
  try {
    const raw = readFileSync(plist, 'utf8');
    const str = (key: string): string | null => raw.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]?.trim() ?? null;
    return {
      bundleId: str('CFBundleIdentifier'),
      versionName: str('CFBundleShortVersionString'),
      versionCode: str('CFBundleVersion'),
      supportedPlatforms: parseSupportedPlatforms(raw),
    };
  } catch {
    return { bundleId: null, versionName: null, versionCode: null, supportedPlatforms: [] };
  }
}

/** Read CFBundleIdentifier from a .app's Info.plist (XML plists only; binary plists are skipped). */
export function bundleIdFromApp(appDir: string): string | null {
  const plist = join(appDir, 'Info.plist');
  if (!existsSync(plist)) return null;
  try {
    const raw = readFileSync(plist, 'utf8');
    const m = raw.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** The list of locations Swipium WILL search, for the "where I looked" report even on a miss. */
export function plannedSearchLocations(projectRoot: string, allowOutsideRoot?: boolean): string[] {
  const rel = [
    'android/app/build/outputs/apk/**',
    'android/app/build/outputs/bundle/**',
    'app/build/outputs/**',
    'build/app/outputs/flutter-apk/**',
    'build/ios/iphonesimulator/**',
    'ios/build/**',
    'apps/android/**',
    'apps/ios/**',
    '<project root, recursive>',
  ].map((r) => join(projectRoot, r));
  if (allowOutsideRoot) rel.push(derivedDataDir());
  return rel;
}

function derivedDataDir(): string {
  return join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
}

function validateExplicit(path: string, projectRoot: string): ArtifactCandidate | { error: string; code: FailureCode } {
  if (!existsSync(path)) return { error: `Artifact not found: ${path}`, code: 'NO_BUILD_ARTIFACT' };
  const type = artifactType(path);
  if (!type) return { error: `Unsupported artifact type: ${basename(path)} (expected .apk/.aab/.ipa/.app)`, code: 'NO_BUILD_ARTIFACT' };
  const c = makeCandidate(path, type, 'explicit path', projectRoot);
  if (!c) return { error: `Could not stat artifact: ${path}`, code: 'NO_BUILD_ARTIFACT' };
  return c;
}

/**
 * Resolve the best installable artifact for the requested options. Side effects limited to
 * filesystem reads + (when enriching) aapt2/Info.plist; never installs or builds.
 */
export async function resolveArtifact(opts: ResolveOptions, enrich = true): Promise<ResolveResult> {
  const { projectRoot } = opts;
  const maxDepth = opts.maxDepth ?? 7;
  const warnings: string[] = [];

  // Explicit path short-circuit (still classified + validated).
  if (opts.explicitPath && opts.explicitPath.trim()) {
    const v = validateExplicit(opts.explicitPath.trim(), projectRoot);
    if ('error' in v) {
      return { candidates: [], best: null, newest: null, searchedLocations: [opts.explicitPath.trim()], warnings: [v.error], failureCode: v.code };
    }
    const ranked = rankCandidates([v], opts);
    if (enrich) await enrichCandidates(ranked, 1);
    return { candidates: ranked, best: ranked[0], newest: ranked[0], searchedLocations: ['explicit: ' + opts.explicitPath.trim()], warnings: ranked[0].warnings };
  }

  const found: ArtifactCandidate[] = [];
  const searched = new Set<string>();
  walk(projectRoot, projectRoot, maxDepth, found, searched);

  // Opt-in: scan Xcode DerivedData (always outside the project root).
  if (opts.allowOutsideRoot && (opts.platform === 'ios' || opts.platform === 'any' || opts.platform == null)) {
    const dd = derivedDataDir();
    if (existsSync(dd)) walk(dd, projectRoot, 4, found, searched);
  }

  const searchedLocations = [...searched].sort();
  if (found.length === 0) {
    return {
      candidates: [],
      best: null,
      newest: null,
      searchedLocations: plannedSearchLocations(projectRoot, opts.allowOutsideRoot),
      warnings,
      failureCode: 'NO_BUILD_ARTIFACT',
    };
  }

  let ranked = rankCandidates(found, opts);
  if (enrich) await enrichCandidates(ranked);

  // Re-filter by required target now that base installability is known.
  if (opts.requireInstallableOn) {
    const ok = ranked.filter((c) => c.installableOn.includes(opts.requireInstallableOn!));
    if (ok.length === 0) {
      return {
        candidates: ranked,
        best: null,
        newest: byNewest(ranked),
        searchedLocations,
        warnings: [`No artifact is installable on ${opts.requireInstallableOn}.`],
        failureCode: failureForRequired(opts.requireInstallableOn, ranked),
      };
    }
    ranked = ok;
  }

  let best: ArtifactCandidate | null = ranked[0] ?? null;
  // Outside-root gate (roadmap §10).
  if (best && best.outsideRoot && !opts.allowOutsideRoot) {
    const inside = ranked.find((c) => !c.outsideRoot);
    if (inside) {
      best = inside;
    } else {
      return { candidates: ranked, best: null, newest: byNewest(ranked), searchedLocations, warnings: [`Best artifact is outside the project root: ${ranked[0].path}`], failureCode: 'ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL' };
    }
  }

  // Ambiguity: several same-platform installable candidates within a hair of each other.
  const topPlat = best?.platform;
  const close = ranked.filter((c) => c.platform === topPlat && best && Math.abs(c.score - best.score) <= 5);
  if (close.length > 1) warnings.push(`${close.length} similar ${topPlat} artifacts found — picked the newest/best; pass an explicit path to override.`);

  // A lone .aab with no APK is a precise, common blocker.
  if (best && best.type === 'aab' && !ranked.some((c) => c.type === 'apk')) {
    warnings.push('Only a .aab is available; install needs bundletool conversion or a directly built APK.');
  }

  return { candidates: ranked, best, newest: byNewest(ranked), searchedLocations, warnings };
}

function byNewest(cands: ArtifactCandidate[]): ArtifactCandidate | null {
  return cands.length ? cands.reduce((m, c) => (c.mtimeMs > m.mtimeMs ? c : m)) : null;
}

function failureForRequired(target: InstallTarget, ranked: ArtifactCandidate[]): FailureCode {
  if (target === 'ios-simulator') {
    if (ranked.some((c) => c.type === 'ipa')) return 'IPA_NEEDS_REAL_DEVICE';
    return 'IOS_SIMULATOR_APP_MISSING';
  }
  if (target === 'android-emulator' || target === 'android-real') {
    if (ranked.some((c) => c.type === 'aab') && !ranked.some((c) => c.type === 'apk')) return 'AAB_NEEDS_BUNDLETOOL';
  }
  return 'NO_BUILD_ARTIFACT';
}
