// Build-failure log parsing (Dev2 plan §4 "framework-specific build log parsing"). A build
// that exits non-zero is an ENVIRONMENT/BUILD failure, never an app QA failure — but "build
// failed" is useless to a developer. This module turns the captured build log into a typed
// blocker with the LIKELY OWNER (app dev vs environment vs user) and a CONCRETE fix, plus the
// relevant log tail (the lines that actually mention the error, not the whole transcript).
//
// PURE + testable: it only reads a log string + the step that produced it (no I/O), so the
// signatures below are unit-testable against fixture logs without any real toolchain.

import type { BuildStep } from './plan.js';
import type { FailureCode, FailureOwner } from '../oracle/failures.js';

/** Which build tool produced a log — drives which signatures we look for. */
export type BuildLogTool = 'gradle' | 'xcodebuild' | 'flutter' | 'cocoapods' | 'expo' | 'node-install' | 'unknown';

export interface BuildFailureAnalysis {
  failureCode: FailureCode;
  owner: FailureOwner;
  /** One-line human reason ("Android SDK platform missing", not the raw log). */
  reason: string;
  /** Concrete next action a developer can take. */
  fix: string;
  /** The lines from the log that actually describe the failure (bounded). */
  relevantTail: string;
  /** Which known signature matched, or null when only the tool-default applied. */
  signal: string | null;
  tool: BuildLogTool;
}

/** Classify a build step into the tool whose log signatures we should match. */
export function buildLogTool(step: BuildStep | undefined): BuildLogTool {
  if (!step) return 'unknown';
  const exe = step.argv[0] ?? '';
  const cmd = step.command.toLowerCase();
  const label = step.label.toLowerCase();
  if (exe === 'xcodebuild') return 'xcodebuild';
  if (exe === 'flutter' && !label.includes('pub get')) return 'flutter';
  if (exe === 'pod' || label.includes('cocoapods')) return 'cocoapods';
  if (exe === './gradlew' || cmd.includes('gradlew')) return 'gradle';
  if (cmd.includes('expo run') || cmd.includes('expo prebuild')) return 'expo';
  if (exe === 'npm' || exe === 'yarn' || exe === 'pnpm' || label.includes('dependencies') || label.includes('pub get')) return 'node-install';
  return 'unknown';
}

interface Signature {
  /** Name surfaced as `signal`. */
  name: string;
  test: RegExp;
  failureCode: FailureCode;
  owner: FailureOwner;
  reason: string;
  fix: string;
}

// Ordered most-specific-first. Expo/Flutter android builds delegate to Gradle, so Gradle
// signatures are also consulted for those tools (see SIGNATURES_BY_TOOL wiring below).
const GRADLE_SIGNATURES: Signature[] = [
  { name: 'sdk-location', test: /SDK location not found|ANDROID_HOME .* not|local\.properties/i, failureCode: 'GRADLE_FAILED', owner: 'environment', reason: 'Android SDK location not configured.', fix: 'Set ANDROID_HOME / sdk.dir (local.properties) to a valid Android SDK, then rebuild.' },
  { name: 'sdk-platform-missing', test: /Failed to find target with hash string|Failed to find Build Tools|Could not (?:find|determine) .*(?:platforms|build-tools)|install the (?:missing )?platform/i, failureCode: 'GRADLE_FAILED', owner: 'environment', reason: 'Required Android SDK platform/build-tools are missing.', fix: 'Install the required SDK platform + build-tools via Android Studio SDK Manager or `sdkmanager`, then rebuild.' },
  { name: 'sdk-license', test: /have not accepted the license|licenses? (?:have )?not.*accepted|to accept the SDK license/i, failureCode: 'GRADLE_FAILED', owner: 'environment', reason: 'Android SDK licenses are not accepted.', fix: 'Run `sdkmanager --licenses` (or accept licenses in Android Studio), then rebuild.' },
  { name: 'ndk-missing', test: /NDK (?:is )?not configured|No version of NDK matched|Failed to install the following Android SDK packages.*ndk/i, failureCode: 'GRADLE_FAILED', owner: 'environment', reason: 'Required Android NDK is missing.', fix: 'Install the NDK version the project requests (SDK Manager / ndkVersion), then rebuild.' },
  { name: 'signing', test: /Keystore file .* not found|Failed to read key .* from store|Could not (?:read|find) keystore|SigningConfig .* (?:is )?invalid|Failed to load signing config|keystore password was incorrect/i, failureCode: 'ANDROID_SIGNING_FAILED', owner: 'environment', reason: 'Gradle signing config (keystore) is missing or invalid.', fix: 'Provide a valid keystore + credentials, or build a debug variant (auto-signed with the debug keystore) for emulator QA.' },
  { name: 'dependency-resolve', test: /Could not resolve|Could not find [^\n]*\.(?:jar|aar|pom)|Could not download|Failed to resolve:|Could not GET/i, failureCode: 'GRADLE_FAILED', owner: 'app', reason: 'A Gradle dependency could not be resolved/downloaded.', fix: 'Check the missing coordinate/repository and network access; fix the dependency declaration, then rebuild.' },
  { name: 'compile', test: /error: cannot find symbol|Compilation (?:error|failed)|e: .*\.kt:|\.java:\d+: error:/i, failureCode: 'GRADLE_FAILED', owner: 'app', reason: 'A compile error in the app sources failed the Gradle build.', fix: 'Open the reported file/line in the log and fix the compile error, then rebuild.' },
];

const XCODE_SIGNATURES: Signature[] = [
  { name: 'scheme-missing', test: /does not contain a scheme named|Scheme .* is not currently configured|The project .* does not contain a scheme/i, failureCode: 'XCODEBUILD_FAILED', owner: 'environment', reason: 'The requested Xcode scheme was not found.', fix: 'Pass the correct -scheme/-workspace (run `xcodebuild -list` to see schemes), then rebuild.' },
  { name: 'signing', test: /Code Sign(?:ing)? error|requires a (?:development team|provisioning profile)|No (?:signing certificate|profiles for|account for team)|Signing for .* requires a development team/i, failureCode: 'XCODEBUILD_FAILED', owner: 'user', reason: 'Xcode code signing / provisioning is not configured.', fix: 'Set a development team and provisioning settings only if your simulator build configuration requires them.' },
  { name: 'simulator-runtime', test: /Unable to find a destination|no simulator runtime|cannot be located on disk.*iphonesimulator|iOS \d+\.\d+ (?:simulator )?runtime (?:is )?not (?:installed|available)|Unsupported SDK/i, failureCode: 'SIMULATOR_RUNTIME_MISSING', owner: 'environment', reason: 'No usable iOS simulator runtime/destination for the build.', fix: 'Install a matching iOS simulator runtime in Xcode (Settings → Platforms) or pick an available destination, then rebuild.' },
  { name: 'compile', test: /error: .*\.(?:m|mm|swift|h|c|cpp):|Command CompileC failed|Swift Compiler Error|fatal error: '.*' file not found/i, failureCode: 'XCODEBUILD_FAILED', owner: 'app', reason: 'A compile error in the iOS sources failed the build.', fix: 'Open the reported file/line in the xcodebuild log and fix the compile error, then rebuild.' },
];

const COCOAPODS_SIGNATURES: Signature[] = [
  { name: 'pods-incompatible', test: /CocoaPods could not find compatible versions|Unable to find a specification for|could not find compatible versions for pod/i, failureCode: 'DEPENDENCY_INSTALL_REQUIRED', owner: 'app', reason: 'CocoaPods could not resolve compatible pod versions.', fix: 'Run `pod repo update` then `pod install`; adjust the Podfile constraints if the conflict persists.' },
  { name: 'pods-out-of-sync', test: /sandbox is not in sync|run .?pod install.?|The .* Pods directory/i, failureCode: 'DEPENDENCY_INSTALL_REQUIRED', owner: 'environment', reason: 'CocoaPods sandbox is out of sync with the Podfile.', fix: 'Run `pod install` in the ios/ directory, then rebuild.' },
];

const FLUTTER_SIGNATURES: Signature[] = [
  { name: 'sdk-missing', test: /Flutter SDK not found|command not found: flutter|Unable to locate the Flutter SDK|flutter: command not found/i, failureCode: 'BUILD_COMMAND_UNAVAILABLE', owner: 'environment', reason: 'The Flutter SDK is not available on PATH.', fix: 'Install Flutter and ensure `flutter` is on PATH (`flutter doctor`), then rebuild.' },
  { name: 'pub-solve', test: /version solving failed|Because .* depends on|pub get failed|Could not (?:resolve|find package)/i, failureCode: 'DEPENDENCY_INSTALL_REQUIRED', owner: 'app', reason: 'Dart/Flutter package resolution (pub get) failed.', fix: 'Fix the pubspec.yaml version constraints, run `flutter pub get`, then rebuild.' },
  { name: 'gradle-delegate', test: /Gradle task assemble\w+ failed|A problem occurred (?:configuring|evaluating) (?:root )?project/i, failureCode: 'GRADLE_FAILED', owner: 'app', reason: 'The Android Gradle build inside `flutter build` failed.', fix: 'Open the Gradle output in the log, fix the Android build error (SDK/dependency/signing), then rebuild.' },
];

const EXPO_SIGNATURES: Signature[] = [
  { name: 'prebuild-required', test: /No native (?:android|ios) (?:project|directory)|run (?:npx )?expo prebuild|CNG|Continuous Native Generation|android.*directory.*(?:missing|not exist)/i, failureCode: 'EXPO_PREBUILD_REQUIRED', owner: 'swipium', reason: 'Expo project has no native directory to build.', fix: 'Run `npx expo prebuild` (or `npx expo run:*`, which prebuilds) to generate the native project, then rebuild.' },
  { name: 'metro', test: /Unable to resolve module|Metro (?:bundler )?(?:has )?encountered|Cannot find module .* from .* Metro|Bundling failed/i, failureCode: 'METRO_FAILED', owner: 'app', reason: 'Metro bundling failed during the Expo build.', fix: 'Fix the unresolved module / bundling error (check imports + `node_modules`), then rebuild.' },
  { name: 'config', test: /Invalid (?:app\.json|app config|Expo config)|ConfigError|Failed to read the app config/i, failureCode: 'BUILD_FAILED', owner: 'app', reason: 'Expo app config (app.json/app.config) is invalid.', fix: 'Fix the Expo config error reported in the log, then rebuild.' },
];

const NODE_INSTALL_SIGNATURES: Signature[] = [
  { name: 'peer-conflict', test: /ERESOLVE|peer dep|unable to resolve dependency tree/i, failureCode: 'DEPENDENCY_INSTALL_REQUIRED', owner: 'app', reason: 'JS dependency resolution failed (peer/version conflict).', fix: 'Resolve the dependency conflict (align versions, or install with the appropriate flag), then re-run.' },
  { name: 'network', test: /ETIMEDOUT|ENOTFOUND|network.*(?:error|timeout)|registry\.npmjs\.org/i, failureCode: 'DEPENDENCY_INSTALL_REQUIRED', owner: 'environment', reason: 'JS dependency install failed to reach the registry.', fix: 'Restore network/registry access, then re-run the dependency install.' },
  { name: 'generic', test: /npm ERR!|error Command failed|ERR_PNPM|Cannot find module/i, failureCode: 'DEPENDENCY_INSTALL_REQUIRED', owner: 'environment', reason: 'JS dependency install failed.', fix: 'Read the install error in the log, fix it, then re-run the dependency install.' },
];

const SIGNATURES_BY_TOOL: Record<BuildLogTool, Signature[]> = {
  gradle: GRADLE_SIGNATURES,
  xcodebuild: XCODE_SIGNATURES,
  // flutter / expo android builds delegate to Gradle, so append Gradle signatures after the
  // framework-specific ones (framework signatures win when both match).
  flutter: [...FLUTTER_SIGNATURES, ...GRADLE_SIGNATURES, ...XCODE_SIGNATURES],
  expo: [...EXPO_SIGNATURES, ...GRADLE_SIGNATURES, ...XCODE_SIGNATURES],
  cocoapods: COCOAPODS_SIGNATURES,
  'node-install': NODE_INSTALL_SIGNATURES,
  unknown: [],
};

/** Tool-default code/owner/fix when no specific signature matched. */
function toolDefault(tool: BuildLogTool): { failureCode: FailureCode; owner: FailureOwner; reason: string; fix: string } {
  switch (tool) {
    case 'gradle': return { failureCode: 'GRADLE_FAILED', owner: 'app', reason: 'Gradle build failed.', fix: 'Open the Gradle log artifact and fix the reported error (SDK/dependency/compile/signing), then rebuild.' };
    case 'xcodebuild': return { failureCode: 'XCODEBUILD_FAILED', owner: 'app', reason: 'xcodebuild failed.', fix: 'Open the xcodebuild log artifact and fix the reported error (scheme/signing/simulator/compile), then rebuild.' };
    case 'flutter': return { failureCode: 'FLUTTER_BUILD_FAILED', owner: 'app', reason: 'flutter build failed.', fix: 'Open the flutter build log artifact and fix the reported error, then rebuild.' };
    case 'cocoapods': return { failureCode: 'DEPENDENCY_INSTALL_REQUIRED', owner: 'environment', reason: 'CocoaPods install failed.', fix: 'Run `pod install` in the ios/ directory and resolve the reported error, then rebuild.' };
    case 'expo': return { failureCode: 'BUILD_FAILED', owner: 'app', reason: 'Expo build failed.', fix: 'Open the build log artifact and fix the reported error, then rebuild.' };
    case 'node-install': return { failureCode: 'DEPENDENCY_INSTALL_REQUIRED', owner: 'environment', reason: 'Dependency install failed.', fix: 'Read the install error in the log, fix it, then re-run.' };
    default: return { failureCode: 'BUILD_FAILED', owner: 'app', reason: 'Build from source failed.', fix: 'Open the build log artifact, fix the compile/config error, then re-run. A build failure is NOT a test failure.' };
  }
}

/**
 * Extract the lines from a build log that actually describe the failure. Prefers lines that
 * mention errors/failures; falls back to the last `maxLines` lines so the tail is never empty.
 */
export function relevantLogTail(log: string, maxLines = 30): string {
  const lines = log.split(/\r?\n/);
  const errRe = /error|FAILURE|Could not|failed|fatal|ERR!|exception|✗|not found|unable to|requires/i;
  const hits = lines.filter((l) => l.trim() && errRe.test(l));
  const chosen = hits.length ? hits.slice(-maxLines) : lines.filter((l) => l.trim()).slice(-maxLines);
  return chosen.join('\n').slice(-4000);
}

/**
 * Analyze a failed build step's log into a typed, owned, actionable blocker. `timedOut` short-
 * circuits to BUILD_TIMED_OUT (the log rarely explains a timeout). Otherwise we match the
 * tool's signatures most-specific-first, then fall back to the tool default.
 */
export function analyzeBuildFailure(opts: { step?: BuildStep; log: string; timedOut?: boolean }): BuildFailureAnalysis {
  const tool = buildLogTool(opts.step);
  const relevantTail = relevantLogTail(opts.log);
  if (opts.timedOut) {
    return { failureCode: 'BUILD_TIMED_OUT', owner: 'environment', reason: 'Build exceeded its time budget.', tool, signal: 'timeout', relevantTail, fix: 'Increase the build timeout, warm caches, or build once manually then re-run against the artifact.' };
  }
  for (const sig of SIGNATURES_BY_TOOL[tool]) {
    if (sig.test.test(opts.log)) {
      return { failureCode: sig.failureCode, owner: sig.owner, reason: sig.reason, fix: sig.fix, relevantTail, signal: sig.name, tool };
    }
  }
  const def = toolDefault(tool);
  return { ...def, relevantTail, signal: null, tool };
}
