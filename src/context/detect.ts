// Detect the mobile project context under a resolved projectRoot (DESIGN §7).
// Best-effort, file-marker based; never trusts cwd.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { which, firstLine, adbDevices, listAvds, findAapt2 } from '../lib/android.js';
import { resolveArtifact } from '../artifacts/resolve.js';

export type Framework = 'expo' | 'bare-react-native' | 'native-android' | 'native-ios' | 'flutter' | 'unknown';

export interface DetectedContext {
  projectRoot: string;
  location: 'project' | 'empty' | 'unknown';
  framework: Framework;
  monorepo: boolean;
  artifacts: { apks: string[]; ipas: string[]; appBundles: string[] };
  devices: { androidOnline: string[]; avds: string[] };
  toolchain: { node: string; adb: boolean; emulator: boolean; java: boolean; aapt2: boolean; xcodebuild: boolean };
  buildable: boolean;
  blockers: string[];
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function hasAny(dir: string, names: string[]): boolean {
  return names.some((n) => existsSync(join(dir, n)));
}

function listApks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (f.toLowerCase().endsWith('.apk')) {
      const p = join(dir, f);
      try {
        if (statSync(p).size >= 1024 * 1024) out.push(p);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function listBy(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .map((f) => join(dir, f));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function detectFramework(root: string): Framework {
  const pkg = readJson(join(root, 'package.json'));
  const deps = pkg ? { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, unknown> : {};
  const hasRN = 'react-native' in deps;
  const hasExpo = 'expo' in deps;

  if (existsSync(join(root, 'pubspec.yaml'))) return 'flutter';
  if (hasExpo) return 'expo';
  if (hasRN) return 'bare-react-native';
  if (hasAny(root, ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'])) return 'native-android';
  if (
    existsSync(join(root, 'Package.swift')) ||
    readdirSync(root).some((f) => f.endsWith('.xcworkspace') || f.endsWith('.xcodeproj'))
  )
    return 'native-ios';
  return 'unknown';
}

function detectMonorepo(root: string): boolean {
  const pkg = readJson(join(root, 'package.json'));
  if (pkg && 'workspaces' in pkg) return true;
  if (existsSync(join(root, 'pnpm-workspace.yaml')) || existsSync(join(root, 'lerna.json'))) return true;
  // multiple package.json in immediate subdirs
  try {
    let count = 0;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules' && existsSync(join(root, e.name, 'package.json'))) count++;
    }
    return count >= 2;
  } catch {
    return false;
  }
}

export async function detectContext(projectRoot: string): Promise<DetectedContext> {
  let location: DetectedContext['location'] = 'unknown';
  try {
    const entries = readdirSync(projectRoot).filter((f) => !f.startsWith('.'));
    if (entries.length === 0) location = 'empty';
  } catch {
    /* leave unknown */
  }

  const framework = detectFramework(projectRoot);
  if (framework !== 'unknown') location = 'project';
  const monorepo = detectMonorepo(projectRoot);

  const artifacts = {
    apks: [...listApks(projectRoot), ...listApks(join(projectRoot, 'apps', 'android'))],
    ipas: listBy(join(projectRoot, 'apps', 'ios'), '.ipa'),
    appBundles: listBy(join(projectRoot, 'apps', 'ios'), '.app'),
  };
  const resolvedArtifacts = await resolveArtifact({ projectRoot, platform: 'any', allowOutsideRoot: false }, false).catch(() => null);
  if (resolvedArtifacts) {
    artifacts.apks = unique([...artifacts.apks, ...resolvedArtifacts.candidates.filter((c) => c.type === 'apk').map((c) => c.path)]);
    artifacts.ipas = unique([...artifacts.ipas, ...resolvedArtifacts.candidates.filter((c) => c.type === 'ipa').map((c) => c.path)]);
    artifacts.appBundles = unique([...artifacts.appBundles, ...resolvedArtifacts.candidates.filter((c) => c.type === 'app').map((c) => c.path)]);
  }

  const [adb, emulator, javaLine, xcodebuild] = await Promise.all([
    which('adb'),
    which('emulator'),
    firstLine('java', ['-version']),
    which('xcodebuild'),
  ]);
  const toolchain = {
    node: process.version,
    adb,
    emulator,
    java: javaLine !== null,
    aapt2: findAapt2() !== null,
    xcodebuild,
  };

  const devices = {
    androidOnline: adb ? await adbDevices() : [],
    avds: emulator ? await listAvds() : [],
  };

  const blockers: string[] = [];
  if (framework === 'unknown') blockers.push('Could not identify a mobile project here — pass an explicit projectRoot, or this is not a supported framework.');
  if (monorepo) blockers.push('Monorepo detected — specify which app target to use (avoids guessing).');
  if (!toolchain.adb) blockers.push('adb not found — install Android platform-tools.');
  if (framework === 'native-android' && artifacts.apks.length === 0) {
    blockers.push('No prebuilt Android APK found — drop an APK under apps/android, build Gradle output, or pass apk=.');
  } else if (framework === 'native-ios' && artifacts.ipas.length === 0 && artifacts.appBundles.length === 0) {
    blockers.push('No prebuilt iOS app artifact found — build a simulator .app or provide an .ipa for a real device lane.');
  } else if (framework !== 'native-android' && framework !== 'native-ios' && artifacts.apks.length === 0 && artifacts.ipas.length === 0 && artifacts.appBundles.length === 0) {
    blockers.push('No prebuilt app artifact found — build an APK for Android or a simulator .app for iOS, then run swipium scan again.');
  }
  if (toolchain.adb && devices.androidOnline.length === 0 && devices.avds.length === 0)
    blockers.push('No online device and no AVD — create an AVD (see qa_doctor).');

  return {
    projectRoot,
    location,
    framework,
    monorepo,
    artifacts,
    devices,
    toolchain,
    buildable: framework !== 'unknown',
    blockers,
  };
}
