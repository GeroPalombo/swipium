// Build-from-source planner (roadmap §4.5) — propose the EXACT commands that turn a source
// project into an installable artifact, per framework + platform, with prerequisites
// (dependency install, Expo prebuild, CocoaPods) and the artifact globs the build will produce.
//
// PURE planning: `buildPlan()` only reads the filesystem + checks toolchain presence. It never
// runs a build. This makes command selection unit-testable, so an agent can show the plan and ask
// minutes compiling.

import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { detectFramework, type Framework } from '../context/detect.js';
import { which } from '../lib/android.js';
import type { FailureCode } from '../oracle/failures.js';

export type BuildPlatform = 'android' | 'ios';
export type BuildVariant = 'debug' | 'release';

export interface BuildStep {
  label: string;
  command: string; // human-readable command line
  argv: string[]; // argv form for spawn (command[0] is the executable)
  cwd: string;
  /** Only run this step if its marker is absent (e.g. android dir missing → needs prebuild). */
  optionalIfPresent?: string;
}

export interface BuildPlan {
  framework: Framework;
  platform: BuildPlatform;
  variant: BuildVariant;
  /** Dependency install / prebuild / pod install — run before the main build if needed. */
  prerequisites: BuildStep[];
  /** The main build command. */
  build: BuildStep | null;
  /** Where the resulting artifact is expected (globs, relative to projectRoot). */
  expectedArtifactGlobs: string[];
  toolchainOk: boolean;
  missingToolchain: string[];
  notes: string[];
  /** Set when no plan could be produced (typed blocker). */
  failureCode?: FailureCode;
}

export interface BuildPlanOptions {
  projectRoot: string;
  platform: BuildPlatform;
  variant?: BuildVariant; // default debug (QA-first)
}

function hasFile(root: string, ...rel: string[]): boolean {
  return rel.some((r) => existsSync(join(root, r)));
}

/** Pick the package manager from lockfiles (npm default). */
function nodeInstallStep(root: string): BuildStep {
  const pm = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm';
  const argv = pm === 'npm' ? ['npm', 'install'] : [pm, 'install'];
  return { label: 'install JS dependencies', command: argv.join(' '), argv, cwd: root, optionalIfPresent: 'node_modules' };
}

/** Best-effort iOS scheme/workspace discovery for xcodebuild. */
function iosWorkspace(root: string): { workspace?: string; project?: string; scheme?: string; dir: string } {
  const iosDir = existsSync(join(root, 'ios')) ? join(root, 'ios') : root;
  let workspace: string | undefined;
  let project: string | undefined;
  try {
    for (const f of readdirSync(iosDir)) {
      if (f.endsWith('.xcworkspace')) workspace = join(iosDir, f);
      else if (f.endsWith('.xcodeproj')) project = join(iosDir, f);
    }
  } catch {
    /* none */
  }
  const base = workspace ? basename(workspace, '.xcworkspace') : project ? basename(project, '.xcodeproj') : undefined;
  return { workspace, project, scheme: base, dir: iosDir };
}

function podInstallStep(root: string): BuildStep | null {
  const iosDir = existsSync(join(root, 'ios')) ? join(root, 'ios') : root;
  if (!existsSync(join(iosDir, 'Podfile'))) return null;
  return { label: 'install CocoaPods', command: 'pod install', argv: ['pod', 'install'], cwd: iosDir, optionalIfPresent: 'Pods' };
}

function xcodebuildStep(root: string, variant: BuildVariant): { step: BuildStep | null; notes: string[] } {
  const { workspace, project, scheme, dir } = iosWorkspace(root);
  const notes: string[] = [];
  if (!scheme) return { step: null, notes: ['Could not find an .xcworkspace/.xcodeproj — pass the scheme/workspace explicitly.'] };
  const config = variant === 'release' ? 'Release' : 'Debug';
  const argv = ['xcodebuild', '-scheme', scheme, '-sdk', 'iphonesimulator', '-configuration', config, '-derivedDataPath', 'build', 'build'];
  if (workspace) argv.splice(1, 0, '-workspace', basename(workspace));
  else if (project) argv.splice(1, 0, '-project', basename(project));
  notes.push(`Using scheme "${scheme}" (best-effort) — override if your scheme differs.`);
  return { step: { label: 'build iOS simulator app', command: argv.join(' '), argv, cwd: dir }, notes };
}

/**
 * Produce a build plan for the given platform. Async because it checks toolchain presence.
 */
export async function buildPlan(opts: BuildPlanOptions): Promise<BuildPlan> {
  const { projectRoot: root, platform } = opts;
  const variant = opts.variant ?? 'debug';
  const framework = detectFramework(root);
  const notes: string[] = [];
  const prerequisites: BuildStep[] = [];
  const missingToolchain: string[] = [];

  const base = (over: Partial<BuildPlan> = {}): BuildPlan => ({
    framework,
    platform,
    variant,
    prerequisites,
    build: null,
    expectedArtifactGlobs: [],
    toolchainOk: missingToolchain.length === 0,
    missingToolchain,
    notes,
    ...over,
  });

  if (framework === 'unknown') {
    return base({ failureCode: 'UNSUPPORTED_FRAMEWORK', notes: ['No supported mobile framework detected at this root.'] });
  }

  // Node-based frameworks need JS deps installed first.
  const nodeBased = framework === 'expo' || framework === 'bare-react-native';
  if (nodeBased) prerequisites.push(nodeInstallStep(root));

  if (platform === 'android') {
    const apkGlobs = ['android/app/build/outputs/apk/**/*.apk', 'app/build/outputs/apk/**/*.apk'];
    const flutterGlobs = ['build/app/outputs/flutter-apk/*.apk'];
    const gradleArg = variant === 'release' ? 'assembleRelease' : 'assembleDebug';

    switch (framework) {
      case 'expo': {
        // No native android dir → expo run:android prebuilds; otherwise it reuses it.
        if (!hasFile(root, 'android')) notes.push('No android/ directory — expo run:android will prebuild it (EXPO_PREBUILD).');
        notes.push(
          'Expo Android local run compiles native code, installs the app, and starts Metro. First run can take several minutes; later JS/TS-only work should usually reuse the installed development build with Metro.',
        );
        const argv = ['npx', 'expo', 'run:android', '--variant', variant];
        return base({
          build: { label: 'Expo Android local run', command: argv.join(' '), argv, cwd: root },
          expectedArtifactGlobs: apkGlobs,
        });
      }
      case 'bare-react-native':
      case 'native-android': {
        if (!hasFile(root, 'android/gradlew', 'gradlew')) {
          return base({
            failureCode: 'BUILD_COMMAND_UNAVAILABLE',
            notes: ['No gradlew found — run from the Android project or add the Gradle wrapper.'],
          });
        }
        const cwd = existsSync(join(root, 'android')) ? join(root, 'android') : root;
        const argv = ['./gradlew', gradleArg];
        return base({ build: { label: `Gradle ${gradleArg}`, command: argv.join(' '), argv, cwd }, expectedArtifactGlobs: apkGlobs });
      }
      case 'flutter': {
        if (!(await which('flutter'))) missingToolchain.push('flutter');
        prerequisites.unshift({ label: 'flutter pub get', command: 'flutter pub get', argv: ['flutter', 'pub', 'get'], cwd: root });
        const argv = ['flutter', 'build', 'apk', `--${variant}`];
        return base({
          build: { label: 'flutter build apk', command: argv.join(' '), argv, cwd: root },
          expectedArtifactGlobs: flutterGlobs,
          toolchainOk: missingToolchain.length === 0,
        });
      }
      default:
        return base({ failureCode: 'BUILD_COMMAND_UNAVAILABLE' });
    }
  }

  // ---- iOS (simulator-first) ----
  const appGlobs = ['ios/build/**/*.app', 'build/**/*.app', 'build/ios/iphonesimulator/*.app'];
  if (!(await which('xcodebuild')) && framework !== 'flutter') missingToolchain.push('xcodebuild');

  switch (framework) {
    case 'expo': {
      if (!hasFile(root, 'ios')) notes.push('No ios/ directory — expo run:ios will prebuild it (EXPO_PREBUILD).');
      const argv = ['npx', 'expo', 'run:ios', '--no-bundler'];
      return base({
        build: { label: 'build + run iOS simulator (Expo)', command: argv.join(' '), argv, cwd: root },
        expectedArtifactGlobs: appGlobs,
      });
    }
    case 'bare-react-native':
    case 'native-ios': {
      const pod = podInstallStep(root);
      if (pod) prerequisites.push(pod);
      const { step, notes: xnotes } = xcodebuildStep(root, variant);
      notes.push(...xnotes);
      if (!step) return base({ failureCode: 'BUILD_COMMAND_UNAVAILABLE' });
      return base({ build: step, expectedArtifactGlobs: appGlobs });
    }
    case 'flutter': {
      if (!(await which('flutter'))) missingToolchain.push('flutter');
      prerequisites.unshift({ label: 'flutter pub get', command: 'flutter pub get', argv: ['flutter', 'pub', 'get'], cwd: root });
      const argv = ['flutter', 'build', 'ios', '--simulator', `--${variant}`];
      return base({
        build: { label: 'flutter build ios --simulator', command: argv.join(' '), argv, cwd: root },
        expectedArtifactGlobs: ['build/ios/iphonesimulator/*.app'],
        toolchainOk: missingToolchain.length === 0,
      });
    }
    default:
      return base({ failureCode: 'BUILD_COMMAND_UNAVAILABLE' });
  }
}
