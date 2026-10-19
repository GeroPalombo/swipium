// Build-failure log parsing: a failed build becomes a typed blocker with the likely owner, a concrete
// fix, and only the log lines that describe the failure. Pure: fixture strings only, no toolchain.

import { describe, expect, it } from 'vitest';
import { analyzeBuildFailure, buildLogTool, relevantLogTail } from '../src/build/parseBuildLog.js';
import type { BuildStep } from '../src/build/plan.js';

function step(argv: string[], label = 'build'): BuildStep {
  return { label, command: argv.join(' '), argv, cwd: '/repo' };
}

const gradle = step(['./gradlew', 'assembleDebug']);
const xcode = step(['xcodebuild', '-workspace', 'ios/App.xcworkspace', '-scheme', 'App']);
const expo = step(['npx', 'expo', 'run:android']);
const flutter = step(['flutter', 'build', 'apk', '--debug']);

describe('buildLogTool', () => {
  it('classifies each build step by its executable, command, and label', () => {
    expect(buildLogTool(undefined)).toBe('unknown');
    expect(buildLogTool(gradle)).toBe('gradle');
    expect(buildLogTool(step(['sh', '-c', 'cd android && ./gradlew assembleDebug']))).toBe('gradle');
    expect(buildLogTool(xcode)).toBe('xcodebuild');
    expect(buildLogTool(flutter)).toBe('flutter');
    expect(buildLogTool(step(['pod', 'install']))).toBe('cocoapods');
    expect(buildLogTool(expo)).toBe('expo');
    expect(buildLogTool(step(['npx', 'expo', 'prebuild']))).toBe('expo');
    expect(buildLogTool(step(['npm', 'ci'], 'install dependencies'))).toBe('node-install');
    expect(buildLogTool(step(['make', 'all']))).toBe('unknown');
  });

  it('flutter pub get is a dependency install, not a flutter build', () => {
    expect(buildLogTool(step(['flutter', 'pub', 'get'], 'flutter pub get'))).toBe('node-install');
  });
});

describe('analyzeBuildFailure', () => {
  it('a timeout wins over any log signature', () => {
    const a = analyzeBuildFailure({ step: gradle, log: 'SDK location not found.', timedOut: true });
    expect(a).toMatchObject({ failureCode: 'BUILD_TIMED_OUT', owner: 'environment', signal: 'timeout', tool: 'gradle' });
  });

  it('Gradle: environment problems are owned by the environment, compile errors by the app', () => {
    expect(
      analyzeBuildFailure({ step: gradle, log: 'FAILURE: Build failed.\nSDK location not found. Define ANDROID_HOME.' }),
    ).toMatchObject({
      failureCode: 'GRADLE_FAILED',
      owner: 'environment',
      signal: 'sdk-location',
    });
    expect(analyzeBuildFailure({ step: gradle, log: "Failed to find target with hash string 'android-35' in: /sdk" })).toMatchObject({
      owner: 'environment',
      signal: 'sdk-platform-missing',
    });
    expect(
      analyzeBuildFailure({ step: gradle, log: "Keystore file '/repo/android/app/release.jks' not found for signing config 'release'." }),
    ).toMatchObject({ failureCode: 'ANDROID_SIGNING_FAILED', owner: 'environment', signal: 'signing' });
    expect(
      analyzeBuildFailure({ step: gradle, log: 'e: /repo/app/src/main/java/com/acme/Main.kt: (12, 5): Unresolved reference: foo' }),
    ).toMatchObject({ failureCode: 'GRADLE_FAILED', owner: 'app', signal: 'compile' });
  });

  it('xcodebuild: a missing scheme, signing, and a compile error get distinct owners', () => {
    expect(
      analyzeBuildFailure({ step: xcode, log: 'xcodebuild: error: The workspace named "App" does not contain a scheme named "Ap".' }),
    ).toMatchObject({ failureCode: 'XCODEBUILD_FAILED', owner: 'environment', signal: 'scheme-missing' });
    expect(analyzeBuildFailure({ step: xcode, log: 'error: Signing for "App" requires a development team.' })).toMatchObject({
      owner: 'user',
      signal: 'signing',
    });
    expect(
      analyzeBuildFailure({
        step: xcode,
        log: "In file included from Foo.m:1:\nfatal error: 'Bar.h' file not found\nCommand CompileC failed with a nonzero exit code",
      }),
    ).toMatchObject({ owner: 'app', signal: 'compile' });
    expect(
      analyzeBuildFailure({
        step: xcode,
        log: "/Users/dev/App/ContentView.swift:10:5: error: cannot find 'foo' in scope\n** BUILD FAILED **",
      }),
    ).toMatchObject({ owner: 'app', signal: 'compile' });
  });

  it('expo and flutter try their own signatures first, then the Gradle ones they delegate to', () => {
    expect(analyzeBuildFailure({ step: expo, log: 'Unable to resolve module ./Missing from App.tsx' })).toMatchObject({
      failureCode: 'METRO_FAILED',
      signal: 'metro',
      tool: 'expo',
    });
    expect(analyzeBuildFailure({ step: expo, log: 'SDK location not found.' })).toMatchObject({
      failureCode: 'GRADLE_FAILED',
      signal: 'sdk-location',
      tool: 'expo',
    });
    expect(analyzeBuildFailure({ step: flutter, log: 'Because app depends on foo ^2.0.0, version solving failed.' })).toMatchObject({
      failureCode: 'DEPENDENCY_INSTALL_REQUIRED',
      owner: 'app',
      signal: 'pub-solve',
    });
  });

  it('dependency installs: a peer conflict is the app, a network failure the environment', () => {
    const npm = step(['npm', 'ci'], 'install dependencies');
    expect(analyzeBuildFailure({ step: npm, log: 'npm ERR! code ERESOLVE\nnpm ERR! unable to resolve dependency tree' })).toMatchObject({
      owner: 'app',
      signal: 'peer-conflict',
    });
    expect(analyzeBuildFailure({ step: npm, log: 'npm ERR! network request failed, reason: getaddrinfo ENOTFOUND' })).toMatchObject({
      owner: 'environment',
      signal: 'network',
    });
  });

  it('no matching signature falls back to the tool default with signal null', () => {
    expect(analyzeBuildFailure({ step: gradle, log: 'something odd happened' })).toMatchObject({
      failureCode: 'GRADLE_FAILED',
      owner: 'app',
      signal: null,
      reason: 'Gradle build failed.',
    });
    expect(analyzeBuildFailure({ step: flutter, log: 'something odd happened' })).toMatchObject({
      failureCode: 'FLUTTER_BUILD_FAILED',
      signal: null,
    });
    // An unknown tool has no signatures: even a recognizable line gets the generic default.
    expect(analyzeBuildFailure({ step: step(['make']), log: 'SDK location not found.' })).toMatchObject({
      failureCode: 'BUILD_FAILED',
      owner: 'app',
      signal: null,
      tool: 'unknown',
    });
  });
});

describe('relevantLogTail', () => {
  it('keeps only the lines that describe the failure', () => {
    const log = ['> Task :app:preBuild', '> Task :app:compileDebugKotlin', 'e: Main.kt: error: unresolved', '', 'BUILD FAILED in 3s'].join(
      '\n',
    );
    expect(relevantLogTail(log)).toBe(['e: Main.kt: error: unresolved', 'BUILD FAILED in 3s'].join('\n'));
  });

  it('falls back to the last non-empty lines when nothing looks like an error, and respects maxLines', () => {
    const log = ['one', 'two', '', 'three', 'four'].join('\r\n');
    expect(relevantLogTail(log, 2)).toBe('three\nfour');
    const errors = Array.from({ length: 50 }, (_, i) => `error ${i}`).join('\n');
    expect(relevantLogTail(errors, 3)).toBe('error 47\nerror 48\nerror 49');
  });

  it('caps the tail at 4000 characters, keeping the end', () => {
    const long = `error: ${'x'.repeat(5000)}END`;
    const tail = relevantLogTail(long);
    expect(tail).toHaveLength(4000);
    expect(tail.endsWith('END')).toBe(true);
  });
});
