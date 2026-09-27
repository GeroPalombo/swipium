// H3/H4/§4 — generated Appium suites must COMPILE, whatever the recorded names/titles contain.
// Golden-style compile test: a recording full of hostile names (Python/JS keywords, a leading
// digit, non-ASCII-only copy, quotes, backslashes, backticks, ${x}, BaseScreen member names,
// derived-name collisions) plus swipes/scrolls/presses is turned into JS, TS and Python suites,
// then checked with the real toolchains:
//   - .js  → `node --check` (inside the emitted package.json, so ESM is honoured);
//   - .ts  → a strict TypeScript program (stub wdio/mocha globals) with zero diagnostics;
//   - .py  → `python3 -m py_compile` (skipped only when python3 is not on PATH).
// It also asserts scroll/swipe steps are real gestures — never driver.swipe(0,0,0,0) / pass.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { generatePom } from '../src/suite/pom.js';
import type { RecordedAction } from '../src/session/store.js';
import { buildAppiumModel, type AppiumSuiteModel } from '../src/automationGen/appiumModel.js';
import { emitJsSuite } from '../src/automationGen/jsEmitter.js';
import { emitPythonSuite } from '../src/automationGen/pythonEmitter.js';
import { asciiFold, jsMemberName, pyName, className, UnemittableStepError } from '../src/automationGen/identifiers.js';
import type { GeneratedFile } from '../src/suite/pom.js';

const LOGIN = 'com.example/.LoginActivity';
const TWOFA = 'com.example/.2faActivity';

function act(a: Partial<RecordedAction> & { action: string }): RecordedAction {
  return { at: 0, exportability: 'semantic', screen: LOGIN, ...a } as RecordedAction;
}

const TRICKY_LABELS = [
  'Continue',
  'Return',
  '2FA code',
  'class',
  "user's login",
  'a\\',
  'say "hi"',
  '${x}',
  '`tick`',
  '登录',
  'tap',
  'login',
  'tapLogin',
  'None',
];

const actions: RecordedAction[] = [
  ...TRICKY_LABELS.map((selector) => act({ action: 'tap', selector, selectorKind: 'text' })),
  act({ action: 'tap', selector: 'login_btn', selectorKind: 'resource_id' }),
  act({ action: 'type', selector: 'Password', selectorKind: 'accessibility_id', text: 'hunter2', secret: true }),
  act({ action: 'type', text: 'it\'s \\ "quoted" `${HOME}`' }), // focused field (no selector)
  act({ action: 'tap', x: 10, y: 20, selectorKind: 'coords' }),
  act({ action: 'swipe', direction: 'left' }),
  act({ action: 'scroll', direction: 'down' }), // no target → finger swipe up
  act({ action: 'scroll', direction: 'down', selector: 'Terms & "Conditions"' }), // scroll until visible
  act({ action: 'scroll', direction: 'up', selector: 'Continue' }),
  act({ action: 'press', key: 'back' }),
  act({ action: 'press', key: 'home' }),
  act({ action: 'press', key: 'enter' }),
  act({ action: 'open_url', url: 'myapp://x?a=1&b="2"' }),
  act({ action: 'assert_visual', assertion: 'Welcome \\ "u" ${a} `b`' }),
  act({ action: 'tap', screen: TWOFA, selector: 'Return', selectorKind: 'text' }),
  act({ action: 'scroll', screen: TWOFA, direction: 'down', selector: '2FA code' }),
];

const TEST_NAME = 'user\'s login `${x}` \\ "quoted" </script>';
const pom = generatePom(actions, { name: TEST_NAME, appId: 'com.example' });
const model = buildAppiumModel(pom, { platforms: { android: true, ios: true } });
const profile = {} as never; // neither emitter reads the profile for code generation

const jsFiles = emitJsSuite({ model, profile, appId: 'com.example', language: 'javascript' });
const tsFiles = emitJsSuite({ model, profile, appId: 'com.example', language: 'typescript' });
const pyFiles = emitPythonSuite({ model, profile, appId: 'com.example', framework: 'pytest' });
const pyUnitFiles = emitPythonSuite({ model, profile, appId: 'com.example', framework: 'unittest' });

function writeTree(files: GeneratedFile[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'swipium-emit-'));
  for (const f of files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return dir;
}

const all = (files: GeneratedFile[]) => files.map((f) => f.content).join('\n');

describe('identifier sanitization (H4)', () => {
  it.each([
    ['Continue', 'continue_', 'continue_'],
    ['Return', 'return_', 'return_'],
    ['class', 'class_', 'class_'],
    ['2FA code', 'el2FACode', 'el_2_fa_code'],
    ['登录', 'element', 'element'],
    ['', 'element', 'element'],
    ["user's login", 'userSLogin', 'user_s_login'],
    ['None', 'none', 'none'],
    ['match', 'match', 'match'], // Python soft keyword — a valid identifier
  ])('%j → js %s / py %s', (raw, js, py) => {
    expect(jsMemberName(raw)).toBe(js);
    expect(pyName(raw)).toBe(py);
  });

  it('class names never start with a digit or collide with a keyword', () => {
    expect(className('2faScreen')).toBe('Screen2faScreen');
    expect(className('')).toBe('Screen');
    expect(className('None')).toBe('None_');
  });

  it('pom element names are valid identifiers (digit prefix, non-ASCII fallback, deduped)', () => {
    for (const page of pom.pages) {
      const names = page.elements.map((e) => e.name);
      for (const n of names) expect(n).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      expect(new Set(names).size).toBe(names.length);
    }
    const names = pom.pages.flatMap((p) => p.elements.map((e) => e.name));
    expect(names).toContain('el2FACode');
    expect(names).toContain('element');
  });

  it('keyword/member-named elements are suffixed, never emitted raw', () => {
    const pyScreens = all(pyFiles.filter((f) => f.path.startsWith('screens/')));
    expect(pyScreens).toMatch(/^ {4}continue_ = /m);
    expect(pyScreens).toMatch(/^ {4}class_ = /m);
    expect(pyScreens).toMatch(/^ {4}tap_ = /m); // would shadow BaseScreen.tap
    expect(pyScreens).not.toMatch(/^ {4}(continue|return|class|tap) = /m);
    const jsScreens = all(jsFiles.filter((f) => f.path.startsWith('src/screens/') && !f.path.endsWith('BaseScreen.js')));
    expect(jsScreens).toMatch(/^ {2}tap_ = /m);
    expect(jsScreens).not.toMatch(/^ {2}tap = /m);
    // tapLogin (element) vs tapLogin() (tap method of `login`) — deduped deterministically.
    expect(jsScreens).toMatch(/^ {2}tapLogin = /m);
    expect(jsScreens).toContain('async tapLogin2()');
  });

  it('transliterates Latin diacritics (NFKD) consistently for class, module and file names', () => {
    expect(asciiFold('Configuración')).toBe('Configuracion');
    expect(asciiFold('登录')).toBe('登录'); // no ASCII decomposition → left for the sanitizer to strip
    expect(className('ConfiguraciónScreen')).toBe('ConfiguracionScreen');
    expect(className('Configuración2Screen')).toBe('Configuracion2Screen');
    expect(pyName('ConfiguracionScreen')).toBe('configuracion_screen');
    expect(pyName('Contraseña')).toBe('contrasena');
    expect(jsMemberName('Contraseña')).toBe('contrasena');

    // Two distinct screens titled "Configuración" (different signatures) → deduped page names.
    const cfg = (screenSig: string, selector: string): RecordedAction =>
      act({ action: 'tap', screen: 'Configuración', screenSig, selector, selectorKind: 'text' });
    const p = generatePom([cfg('sig-a', 'Contraseña'), cfg('sig-b', 'Guardar')], { name: 'ajustes', appId: 'com.example' });
    expect(p.pages.map((pg) => pg.name)).toEqual(['ConfiguracionPage', 'Configuracion2Page']);
    expect(p.pages[0].elements.map((e) => e.name)).toEqual(['contrasena']);
    expect(p.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['pages/configuracion-page.page.yaml', 'pages/configuracion2-page.page.yaml']),
    );
    const m = buildAppiumModel(p, { platforms: { android: true, ios: true } });
    expect(m.screens.map((sc) => sc.className)).toEqual(['ConfiguracionScreen', 'Configuracion2Screen']);
    const py = emitPythonSuite({ model: m, profile, appId: 'com.example', framework: 'pytest' }).map((f) => f.path);
    expect(py).toEqual(expect.arrayContaining(['screens/configuracion_screen.py', 'screens/configuracion2_screen.py']));
    expect(py.join(' ')).not.toMatch(/configuraci_n/);
    const js = emitJsSuite({ model: m, profile, appId: 'com.example', language: 'javascript' }).map((f) => f.path);
    expect(js).toEqual(expect.arrayContaining(['src/screens/ConfiguracionScreen.js', 'src/screens/Configuracion2Screen.js']));
  });

  it('generation is deterministic', () => {
    const again = emitPythonSuite({ model, profile, appId: 'com.example', framework: 'pytest' });
    expect(again).toEqual(pyFiles);
    expect(emitJsSuite({ model, profile, appId: 'com.example', language: 'typescript' })).toEqual(tsFiles);
  });
});

describe('JavaScript output is plain JS (H3)', () => {
  it('has no TypeScript-only syntax', () => {
    for (const f of jsFiles.filter((x) => x.path.endsWith('.js'))) {
      expect(f.content, f.path).not.toMatch(/^\s*(protected|private|readonly)\s/m);
      expect(f.content, f.path).not.toMatch(/import type /);
      expect(f.content, f.path).not.toMatch(/\): Promise</);
    }
  });

  it('JSON-escapes the describe() title built from recorded data', () => {
    const smoke = jsFiles.find((f) => f.path === 'test/smoke.e2e.js')!.content;
    expect(smoke).toContain(`describe(${JSON.stringify(`${TEST_NAME} smoke`)}, () => {`);
  });

  it('every .js file passes node --check', () => {
    const dir = writeTree(jsFiles);
    try {
      for (const f of jsFiles.filter((x) => x.path.endsWith('.js'))) {
        const res = spawnSync(process.execPath, ['--check', join(dir, f.path)], { encoding: 'utf8' });
        expect(res.status, `node --check ${f.path}:\n${res.stderr}\n----\n${f.content}`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Minimal ambient stubs so the generated TS can be type-checked without installing wdio. */
const WDIO_STUBS = `
declare namespace WebdriverIO { type Config = Record<string, unknown>; type Capabilities = Record<string, unknown>; type Element = any; }
declare const driver: any;
declare function $(selector: unknown): any;
declare function describe(title: string, fn: () => void): void;
declare function it(title: string, fn: () => Promise<void>): void;
declare const process: { env: Record<string, string | undefined> };
declare module '@wdio/types' { export type Options = unknown; }
`;

/** Strict in-memory TypeScript program over generated .ts files → formatted diagnostics. */
function tsDiagnostics(files: GeneratedFile[]): string[] {
  const sources = new Map<string, string>();
  for (const f of files.filter((x) => x.path.endsWith('.ts'))) sources.set(`/gen/${f.path}`, f.content);
  sources.set('/gen/wdio-stubs.d.ts', WDIO_STUBS);
  // NodeNext maps ./x.js → ./x.ts; an in-memory package.json marks the tree as ESM.
  sources.set('/gen/package.json', JSON.stringify({ type: 'module' }));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    types: [],
    lib: ['lib.es2022.d.ts'],
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const read = (p: string) => sources.get(p) ?? (p.startsWith('/gen/') ? undefined : ts.sys.readFile(p));
  host.fileExists = (p) => sources.has(p) || (!p.startsWith('/gen/') && ts.sys.fileExists(p));
  host.readFile = read;
  host.getSourceFile = (p, lang) => {
    const text = read(p);
    return text === undefined ? undefined : ts.createSourceFile(p, text, lang);
  };
  host.directoryExists = (d) => [...sources.keys()].some((k) => k.startsWith(d.endsWith('/') ? d : `${d}/`)) || ts.sys.directoryExists(d);
  const roots = [...sources.keys()].filter((k) => k.endsWith('.ts'));
  const program = ts.createProgram(roots, options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (!d.file || d.start === undefined) return msg;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName}:${line + 1}: ${msg}\n    ${d.file.text.split('\n')[line]}`;
  });
}

describe('TypeScript output type-checks (H3/H4)', () => {
  it('a strict program over the generated .ts files has zero diagnostics', () => {
    const diags = tsDiagnostics(tsFiles);
    expect(diags, diags.join('\n')).toEqual([]);
  });

  it('the type-check is not vacuous (a protected-member call from the test is caught)', () => {
    const broken = tsFiles.map((f) =>
      f.path === 'test/smoke.e2e.ts'
        ? { ...f, content: f.content.replace(/await (\w+)\.tapContinue\(\);/, 'await $1.tap($1.continue_);') }
        : f,
    );
    expect(broken.find((f) => f.path === 'test/smoke.e2e.ts')!.content).toContain('.tap(');
    expect(tsDiagnostics(broken).join('\n')).toMatch(/protected/);
  });
});

describe('Python output compiles (H4)', () => {
  const hasPython3 = spawnSync('python3', ['--version']).status === 0;
  it.runIf(hasPython3).each([
    ['pytest', pyFiles],
    ['unittest', pyUnitFiles],
  ] as const)('%s suite byte-compiles with python3 -m py_compile', (_n, files) => {
    const dir = writeTree(files);
    try {
      const py = files.filter((f) => f.path.endsWith('.py')).map((f) => join(dir, f.path));
      const res = spawnSync('python3', ['-m', 'py_compile', ...py], { encoding: 'utf8' });
      expect(res.status, `py_compile failed:\n${res.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scroll/swipe steps are real gestures (§4)', () => {
  it('never emits no-op gestures or unsupported-step placeholders', () => {
    for (const files of [jsFiles, tsFiles, pyFiles, pyUnitFiles]) {
      const src = all(files);
      expect(src).not.toMatch(/swipe\(0,\s*0,\s*0,\s*0\)/);
      expect(src).not.toMatch(/unsupported step/i);
      expect(src).not.toMatch(/^\s*pass\s+#/m);
    }
  });

  it('JS base uses mobile: scrollGesture / mobile: scroll and a window-size pointer swipe', () => {
    const base = jsFiles.find((f) => f.path === 'src/screens/BaseScreen.js')!.content;
    expect(base).toContain(`driver.execute('mobile: scrollGesture'`);
    expect(base).toContain(`driver.execute('mobile: scroll'`);
    expect(base).toContain('driver.getWindowSize()');
    expect(base).toMatch(/for \(let i = 0; i <= maxScrolls; i\+\+\)/); // bounded scroll-until-visible
  });

  it('Python base uses window-size driver.swipe and mobile: scroll(Gesture) with a bounded loop', () => {
    const base = pyFiles.find((f) => f.path === 'screens/base_screen.py')!.content;
    expect(base).toContain('self.driver.swipe(int(w * fx1), int(h * fy1), int(w * fx2), int(h * fy2), 600)');
    expect(base).toContain('"mobile: scrollGesture"');
    expect(base).toContain('"mobile: scroll"');
    expect(base).toContain('for i in range(max_scrolls + 1):');
  });

  it('recorded scroll semantics survive into the steps', () => {
    const smoke = pyFiles.find((f) => f.path === 'tests/test_smoke.py')!.content;
    expect(smoke).toContain('.swipe("left")');
    expect(smoke).toContain('.swipe("up")'); // scroll down with no target = finger swipe up
    expect(smoke).toMatch(/\.scroll_to_terms_conditions\("down"\)/);
    expect(smoke).toMatch(/\.scroll_to_continue\("up"\)/);
    expect(smoke).toContain('.press_key("home")');
    expect(smoke).toContain('.press_key("enter")');
    const jsSmoke = jsFiles.find((f) => f.path === 'test/smoke.e2e.js')!.content;
    expect(jsSmoke).toMatch(/\.scrollToTermsConditions\("down"\);/);
    expect(jsSmoke).toContain('.typeFocused(');
  });

  const bad = (step: Partial<AppiumSuiteModel['steps'][number]>): AppiumSuiteModel => ({
    ...model,
    steps: [{ screen: model.screens[0].className, action: 'swipe', ...step } as AppiumSuiteModel['steps'][number]],
  });

  it.each([
    ['a diagonal swipe', { action: 'swipe', direction: 'diagonal' }],
    ['an unsupported key', { action: 'press', key: 'volume_up' }],
    ['a target-less scrollTo', { action: 'scrollTo' }],
    ['an unknown action', { action: 'pinch' }],
  ] as const)('fails generation loudly for %s', (_n, step) => {
    const m = bad(step as never);
    expect(() => emitJsSuite({ model: m, profile, language: 'javascript' })).toThrow(UnemittableStepError);
    expect(() => emitPythonSuite({ model: m, profile, framework: 'pytest' })).toThrow(UnemittableStepError);
  });
});
