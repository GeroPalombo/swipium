// Round-5 should-fix items (hermetic):
//  - NEW-R5-1 (tools-contract): suite writes under .swipium/ never follow a committed symlink.
//  - NEW-R5-3 (goals-ios): the explorer's mid-run relaunch is a restartApp step in generated flows.
//  - Missing tests: isTestRunnerBundle and resolveArtifact's onlyPaths.

import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { emptySuite } from '../src/testSuite/schema.js';
import { recordRun, saveSuite, writeFileNoFollow } from '../src/testSuite/store.js';
import { actionsWithRelaunches } from '../src/services/suiteGenerate.js';
import { generatePom } from '../src/suite/pom.js';
import { compileTest } from '../src/suite/compile.js';
import { generateFlow } from '../src/flows/generate.js';
import { isTestRunnerBundle, resolveArtifact } from '../src/artifacts/resolve.js';
import type { RecordedAction, TestNote } from '../src/session/store.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('NEW-R5-1: suite writes refuse symlinks', () => {
  it('refuses a symlinked test-suite.json and leaves the target untouched', () => {
    const root = tmp('swipium-sym-root-');
    const out = tmp('swipium-sym-out-');
    const victim = join(out, 'victim');
    writeFileSync(victim, 'precious');
    mkdirSync(join(root, '.swipium'));
    symlinkSync(victim, join(root, '.swipium', 'test-suite.json'));
    expect(() => saveSuite(root, emptySuite('com.example.app'))).toThrow(/symlink/);
    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });

  it('refuses a symlinked export folder (directory symlink) and a symlinked .swipium', () => {
    const root = tmp('swipium-sym-root-');
    const out = tmp('swipium-sym-out-');
    mkdirSync(join(root, '.swipium'));
    symlinkSync(out, join(root, '.swipium', 'test-suite-export'));
    expect(() => writeFileNoFollow(root, join(root, '.swipium', 'test-suite-export', 'test-suite.md'), 'x')).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
    expect(existsSync(join(out, 'test-suite.md'))).toBe(false);

    const root2 = tmp('swipium-sym-root-');
    symlinkSync(out, join(root2, '.swipium'));
    expect(() => recordRun(root2, { at: new Date().toISOString() } as never)).toThrow(/symlink/);
  });

  it('writes normally (creating folders) when nothing is a symlink, and refuses paths outside the root', () => {
    const root = tmp('swipium-sym-root-');
    const written = saveSuite(root, emptySuite('com.example.app'));
    expect(lstatSync(written[0]).isFile()).toBe(true);
    writeFileNoFollow(root, join(root, '.swipium', 'test-suite-export', 'yaml', 'a', 'b.yaml'), 'ok');
    expect(readFileSync(join(root, '.swipium', 'test-suite-export', 'yaml', 'a', 'b.yaml'), 'utf8')).toBe('ok');
    expect(() => writeFileNoFollow(root, join(root, '..', 'escape.txt'), 'x')).toThrow(/outside the project/);
  });
});

describe('NEW-R5-3: explorer relaunch is recorded in generated flows', () => {
  const tap = (at: number, selector: string, screen: string): RecordedAction => ({
    at,
    action: 'tap',
    selector,
    selectorKind: 'accessibility_id',
    exportability: 'semantic',
    screen,
  });
  const relaunchNote = (at: number): TestNote => ({
    at,
    workflow: 'guided_exploration',
    outcome: 'skipped',
    category: 'other',
    reason: 'back did not leave "About"; relaunching com.example.app to continue from its first screen',
  });
  const recordedActions = [tap(100, 'map.menu', 'Map'), tap(200, 'about.row', 'Menu'), tap(400, 'settings.button', 'Map')];

  it('inserts restart_app between the actions it happened between; drops leading / trailing ones', () => {
    const notes = [relaunchNote(50), relaunchNote(300), relaunchNote(900)];
    const actions = actionsWithRelaunches({ recordedActions, notes });
    expect(actions.map((a) => a.action)).toEqual(['tap', 'tap', 'restart_app', 'tap']);
    expect(actionsWithRelaunches({ recordedActions, notes: [] })).toBe(recordedActions);
  });

  it('a generated flow and a compiled POM test relaunch at that point', () => {
    const actions = actionsWithRelaunches({ recordedActions, notes: [relaunchNote(300)] });
    const flow = parse(generateFlow(actions, { name: 'gen', appId: 'com.example.app' }).yaml) as { steps: unknown[] };
    const flat = flow.steps.map((s) => (typeof s === 'string' ? s : Object.keys(s as object)[0]));
    const taps = flat.flatMap((s, i) => (s === 'tap' ? [i] : []));
    const restart = flat.indexOf('restartApp');
    expect(flat.filter((s) => s === 'restartApp')).toHaveLength(1);
    expect(taps[1]).toBeLessThan(restart);
    expect(restart).toBeLessThan(taps[2]);

    const pom = generatePom(actions, { name: 'gen', appId: 'com.example.app' });
    expect(pom.steps.map((s) => s.action)).toEqual(['tap', 'tap', 'restartApp', 'tap']);
    const testFile = pom.files.find((f) => f.path.startsWith('tests/'))!;
    expect(testFile.content).toContain('action: restartApp');
    const compiled = compileTest({ name: 'gen', steps: [{ page: 'MapPage', action: 'restartApp' }] }, new Map());
    expect(compiled.errors).toEqual([]);
    expect(compiled.flow.steps).toEqual(['prepareTarget', 'restartApp']);
  });
});

describe('artifact resolution: isTestRunnerBundle and onlyPaths', () => {
  it('isTestRunnerBundle flags XCTest / WDA runners, not the app or Flutter Runner.app', () => {
    expect(isTestRunnerBundle('/b/WebDriverAgentRunner-Runner.app')).toBe(true);
    expect(isTestRunnerBundle('/b/FooUITests-Runner.app')).toBe(true);
    expect(isTestRunnerBundle('/b/Foo.xctrunner')).toBe(true);
    expect(isTestRunnerBundle('/b/Runner.app')).toBe(false);
    expect(isTestRunnerBundle('/b/MyApp.app')).toBe(false);
  });

  it('resolveArtifact skips runner bundles and, with onlyPaths, picks only the listed artifacts', async () => {
    const root = tmp('swipium-art-');
    const mkApp = (rel: string) => {
      const dir = join(root, rel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'Info.plist'), '<plist><dict></dict></plist>');
      writeFileSync(join(dir, 'MyApp'), Buffer.alloc(4096));
      return dir;
    };
    const near = mkApp('prebuilt/MyApp.app');
    const deep = mkApp('ios/build/Build/Products/Debug-iphonesimulator/Other.app');
    mkApp('ios/build/Build/Products/Debug-iphonesimulator/MyAppUITests-Runner.app');

    const all = await resolveArtifact({ projectRoot: root, platform: 'ios' }, false);
    const names = all.candidates.map((c) => c.path.split('/').pop());
    expect(names).toEqual(expect.arrayContaining(['MyApp.app', 'Other.app']));
    expect(names).not.toContain('MyAppUITests-Runner.app');

    const only = await resolveArtifact({ projectRoot: root, platform: 'ios', onlyPaths: [near] }, false);
    expect(only.candidates.map((c) => c.path)).toEqual([near]);
    expect(only.best?.path).toBe(near);

    const none = await resolveArtifact({ projectRoot: root, platform: 'ios', onlyPaths: [join(root, 'missing.app')] }, false);
    expect(none.best).toBeNull();
    expect(none.failureCode).toBe('NO_BUILD_ARTIFACT');
    void deep;
  });
});
