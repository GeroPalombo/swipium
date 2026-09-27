// SWIP-10 — Python emitter string escaping. The hand-rolled escaping for UiSelector /
// iOS-predicate locators only doubled quotes, so a backslash in a locator value (or a
// trailing backslash) produced a corrupted — or syntactically invalid — generated Python
// suite. Backslashes must be escaped FIRST, then quotes, both in the emitted locator
// tuples and in the generated BaseScreen.assert_text_visible runtime interpolation.
// When python3 is on PATH, the generated suite is also byte-compiled (py_compile).

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appiumByTuple, emitPythonSuite } from '../src/automationGen/pythonEmitter.js';
import type { AppiumLocator, AppiumSuiteModel, CrossPlatformElement } from '../src/automationGen/appiumModel.js';

const NASTY_VALUES = [
  ['backslash', 'C:\\temp\\file'],
  ['double quote', 'say "hi"'],
  ['both', 'a\\"b "quoted" c\\d'],
  ['trailing backslash', 'ends with\\'],
] as const;

function loc(strategy: AppiumLocator['strategy'], value: string): AppiumLocator {
  return { strategy, value, durable: false, releaseGrade: true };
}

/** Parse the emitted `(AppiumBy.X, "...")` tuple back into the Python string it carries.
 *  pyStr() is JSON.stringify, so the second tuple element is valid JSON. */
function tupleValue(tuple: string): string {
  const m = tuple.match(/^\(AppiumBy\.[A-Z_]+, (".*")\)$/s);
  expect(m, `tuple should match the (AppiumBy.X, "...") shape: ${tuple}`).toBeTruthy();
  return JSON.parse(m![1]) as string;
}

/** Undo the inner double-quoted-literal escaping (\\ → \, \" → ") to recover the raw value. */
function unescapeInner(s: string): string {
  return s.replace(/\\(["\\])/g, '$1');
}

describe('appiumByTuple escaping (SWIP-10)', () => {
  it.each(NASTY_VALUES)('androidUiautomator round-trips a value with a %s', (_name, value) => {
    const py = tupleValue(appiumByTuple(loc('androidUiautomator', value))!);
    const m = py.match(/^new UiSelector\(\)\.text\("(.*)"\)$/s);
    expect(m, `selector body should be one intact quoted literal: ${py}`).toBeTruthy();
    expect(unescapeInner(m![1])).toBe(value);
  });

  it.each(NASTY_VALUES)('iOS name predicate round-trips a value with a %s', (_name, value) => {
    const py = tupleValue(appiumByTuple(loc('name', value))!);
    const m = py.match(/^name == "(.*)" OR label == "(.*)"$/s);
    expect(m, `predicate should keep two intact quoted literals: ${py}`).toBeTruthy();
    expect(unescapeInner(m![1])).toBe(value);
    expect(unescapeInner(m![2])).toBe(value);
  });

  it('escapes backslashes before quotes so a trailing backslash cannot eat the closing quote', () => {
    const py = tupleValue(appiumByTuple(loc('androidUiautomator', 'ends with\\'))!);
    // The literal must close with an ESCAPED backslash then the quote — not \") swallowed.
    expect(py).toBe('new UiSelector().text("ends with\\\\")');
  });
});

describe('emitPythonSuite generated sources (SWIP-10)', () => {
  const nastyText = 'say "hi\\" now';
  const element: CrossPlatformElement = {
    name: 'loginButton',
    android: loc('androidUiautomator', 'a\\"b "quoted" c\\d'),
    ios: loc('name', 'ends with\\'),
    durability: 'semi',
    required: true,
  };
  const model: AppiumSuiteModel = {
    testName: 'escaping-smoke',
    screens: [{ className: 'HomeScreen', pageName: 'HomePage', elements: [element] }],
    steps: [
      { screen: 'HomeScreen', element: 'loginButton', action: 'tap' },
      { screen: 'HomeScreen', action: 'assertVisible', text: nastyText },
    ],
    variables: [],
    secrets: [],
    audit: { entries: [], durable: 0, semi: 1, brittle: 0, brittlePct: 0 },
    platforms: { android: true, ios: true },
  };
  const files = emitPythonSuite({
    model,
    profile: {} as never, // the Python emitter never reads the profile
    appId: 'com.example.app',
    framework: 'pytest',
  });
  const content = (path: string) => files.find((f) => f.path === path)?.content ?? '';

  it('emits the screen locators with backslashes and quotes doubled inside the outer string', () => {
    const screen = content('screens/home_screen.py');
    // Python source: "new UiSelector().text(\"a\\\\\"b \\\"quoted\\\" c\\\\d\")" — assert via the
    // exact emitted line so the on-disk bytes are what a Python parser will see.
    expect(screen).toContain(`(AppiumBy.ANDROID_UIAUTOMATOR, ${JSON.stringify('new UiSelector().text("a\\\\\\"b \\"quoted\\" c\\\\d")')})`);
    expect(screen).toContain(`(AppiumBy.IOS_PREDICATE, ${JSON.stringify('name == "ends with\\\\" OR label == "ends with\\\\"')})`);
  });

  it('hardens BaseScreen.assert_text_visible against runtime backslashes and quotes', () => {
    const base = content('screens/base_screen.py');
    expect(base).toContain(`escaped = text.replace("\\\\", "\\\\\\\\").replace('"', '\\\\"')`);
    expect(base).toContain(`'new UiSelector().textContains("%s")' % escaped`);
    expect(base).not.toContain('% text)');
  });

  it('passes nasty assert text through as a plain Python string (escaped at runtime)', () => {
    const smoke = content('tests/test_smoke.py');
    expect(smoke).toContain(`home_screen.assert_text_visible(${JSON.stringify(nastyText)})`);
  });

  const hasPython3 = spawnSync('python3', ['--version']).status === 0;
  it.runIf(hasPython3)('generated suite byte-compiles with python3 -m py_compile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swipium-pyemit-'));
    try {
      const pyFiles: string[] = [];
      for (const f of files) {
        const abs = join(dir, f.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
        if (f.path.endsWith('.py')) pyFiles.push(abs);
      }
      const res = spawnSync('python3', ['-m', 'py_compile', ...pyFiles], { encoding: 'utf8' });
      expect(res.status, `py_compile failed:\n${res.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
