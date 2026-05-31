// Pre-launch static app map (Vision Gap Fix 1). The product principle is "read the durable app map
// BEFORE deciding what to do". Every high-level workflow (qa_test_this first) must load or build the
// static `.swipium/app-map.json` after resolving the project root and BEFORE installing/launching the
// app, so first-run decisions, exploration seeding, automation readiness, and the report are informed
// by the durable map at the time they are made — not by a fresh scan after the fact.
//
// Cheap + side-effect-light: this only touches source files (staticScan/codeIndex via buildAppMap) and
// `.swipium/`. It decides whether a rescan is actually needed (no map, missing/stale fingerprint, or a
// forced rescan) so a warm map is reused without a redundant full scan, while a changed app config or
// route/screen file triggers an incremental static refresh.

import { detectFramework, type Framework } from '../context/detect.js';
import { fileHash } from './fsWalk.js';
import { buildAppMap } from './build.js';
import { loadAppMap, appMapResourceUri } from './store.js';
import { join } from 'node:path';
import type { AppKnowledgeMap, ProjectIdentity } from './schema.js';

export interface PrelaunchAppMapResult {
  map: AppKnowledgeMap;
  appMapUri: string;
  rescanned: boolean;
  /** Why a rescan was (or was not) performed — surfaced in workaround/attempt trails. */
  reason: string;
}

export interface PrelaunchOptions {
  at: string; // ISO timestamp (caller supplies — deterministic/testable)
  forceRescan?: boolean;
  appIdentityHints?: { androidPackage?: string | null; iosBundleId?: string | null; artifactHash?: string | null; environment?: string | null };
  persist?: boolean; // default true
}

function platformsFor(fw: Framework): Array<'android' | 'ios'> {
  switch (fw) {
    case 'native-android':
      return ['android'];
    case 'native-ios':
      return ['ios'];
    default:
      return ['android', 'ios'];
  }
}

function fallbackIdentity(root: string, fw: Framework): ProjectIdentity {
  return { root, gitRemote: null, packageName: null, workspaceTarget: null, framework: fw, platforms: platformsFor(fw) };
}

/** Decide whether the static topology needs a (re)scan before launch, and explain why. */
export function decidePrelaunchRescan(root: string, at: string, forceRescan?: boolean): { rescan: boolean; reason: string } {
  if (forceRescan) return { rescan: true, reason: 'forceRescan' };
  const fw = detectFramework(root);
  const loaded = loadAppMap(root, fallbackIdentity(root, fw), at);
  if (!loaded.existed || !loaded.map) return { rescan: true, reason: 'no_map' };
  const fp = loaded.map.sourceFingerprint;
  if (!fp || !fp.files?.length) return { rescan: true, reason: 'missing_fingerprint' };
  // Any tracked source file (app config, route, or screen file) that changed or vanished invalidates
  // the static topology — refresh it. Bounded by the fingerprint size the scanner already chose.
  for (const f of fp.files) {
    const h = fileHash(join(root, f.path));
    if (!h || h.hash !== f.hash) return { rescan: true, reason: `source_changed:${f.path}` };
  }
  return { rescan: false, reason: 'up_to_date' };
}

/**
 * Load or build the static app map before launch. Builds (mode:"static_only") when a rescan is needed;
 * otherwise loads + migrates the existing map and persists it (a no-op runtime_merge with no graph),
 * so the canonical `.swipium/app-map.json` always exists and is migration-current after this call.
 */
export function ensurePrelaunchAppMap(root: string, opts: PrelaunchOptions): PrelaunchAppMapResult {
  const decision = decidePrelaunchRescan(root, opts.at, opts.forceRescan);
  const built = buildAppMap(root, {
    mode: decision.rescan ? 'static_only' : 'runtime_merge',
    at: opts.at,
    includeCodeIndex: true,
    appIdentityHints: opts.appIdentityHints,
    persist: opts.persist !== false,
  });
  const appMapUri = built.save?.resourceUri ?? appMapResourceUri(root);
  return { map: built.map, appMapUri, rescanned: decision.rescan, reason: decision.reason };
}
