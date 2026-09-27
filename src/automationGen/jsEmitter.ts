// SWIPIUM-REQ-04 — JS/TS WebdriverIO + Appium emitter. Pure: turns the shared Appium model into a
// runnable WebdriverIO POM suite (page/screen classes with locator getters + action methods, env-
// driven capabilities, structured waits). No XPath is ever emitted; coordinate fallbacks are marked
// non-release-grade. Aligns with the Appium JS quickstart (WebdriverIO) locator-strategy guidance.

import type { GeneratedFile } from '../suite/pom.js';
import type { AppiumLocator, AppiumScreen, AppiumStep, AppiumSuiteModel, CrossPlatformElement } from './appiumModel.js';
import type { AutomationProjectProfile } from './projectProfile.js';
import { defaultPlatformOf } from './platformResolve.js';
import {
  NameAllocator,
  UnemittableStepError,
  checkDirection,
  checkKey,
  className,
  commentSafe,
  isJsIdentifier,
  jsMemberName,
  pascalWords,
  screensOf,
} from './identifiers.js';

export interface JsEmitInput {
  model: AppiumSuiteModel;
  profile: AutomationProjectProfile;
  appId?: string;
  language: 'typescript' | 'javascript';
}

const DEFAULT_TIMEOUT = 15000;
const MAX_SCROLLS = 8;

/** Every member BaseScreen declares — a generated field/method must never shadow one (a field named
 *  `tap` would replace the tap() helper, and in TS it is a type error). */
const JS_BASE_MEMBERS = [
  'constructor',
  'element',
  'tap',
  'type',
  'typeFocused',
  'scrollTo',
  'scrollToText',
  'scrollOnce',
  'isVisible',
  'assertVisible',
  'assertTextVisible',
  'textSelector',
  'tapAt',
  'pressKey',
  'swipe',
  'openUrl',
];

/** Sanitized, collision-free names for one screen class (H4). */
interface JsScreenNames {
  cls: string;
  instance: string;
  /** original element name → field name */
  fields: Map<string, string>;
  /** `${action}|${element}` → method name */
  methods: Map<string, string>;
}

function methodKey(action: AppiumStep['action'], element: string): string {
  return `${action}|${element}`;
}

function planJsNames(model: AppiumSuiteModel): Map<string, JsScreenNames> {
  const classes = new NameAllocator(['BaseScreen', 'TestData', 'PlatformLocator'], (s) => s.toLowerCase());
  const instances = new NameAllocator(['testData', 'driver', 'browser', 'describe', 'it', 'expect', '$', '$$']);
  const plan = new Map<string, JsScreenNames>();
  for (const screen of screensOf(model)) {
    const cls = classes.alloc(className(screen.className));
    const instance = instances.alloc(cls[0].toLowerCase() + cls.slice(1));
    const members = new NameAllocator(JS_BASE_MEMBERS);
    const fields = new Map<string, string>();
    for (const el of screen.elements) if (!fields.has(el.name)) fields.set(el.name, members.alloc(jsMemberName(el.name)));
    const methods = new Map<string, string>();
    for (const s of model.steps) {
      if (s.screen !== screen.className || !s.element) continue;
      const field = fields.get(s.element);
      if (!field) {
        throw new UnemittableStepError(
          `cannot emit ${s.action} step on ${screen.className}: element ${JSON.stringify(s.element)} is not declared on that screen`,
        );
      }
      const key = methodKey(s.action, s.element);
      if (methods.has(key)) continue;
      methods.set(key, members.alloc(methodBase(s.action, pascalWords(field) || 'Element')));
    }
    plan.set(screen.className, { cls, instance, fields, methods });
  }
  return plan;
}

function jsProp(obj: string, key: string): string {
  return isJsIdentifier(key) ? `${obj}.${key}` : `${obj}[${JSON.stringify(key)}]`;
}

/** Env var (SWIPIUM_TEST_PASSWORD) → a stable testData key (password). */
export function varToKey(v: string): string {
  const stripped = v.replace(/^SWIPIUM_(TEST_)?/i, '');
  const parts = stripped
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'value';
  return parts.map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join('');
}

/** wdio selector string for a single Appium locator (no XPath, ever). */
export function wdioSelector(loc: AppiumLocator): string {
  switch (loc.strategy) {
    case 'accessibilityId':
      return `~${loc.value}`;
    case 'id':
      return `id=${loc.value}`;
    case 'androidUiautomator':
      return `android=new UiSelector().text(${JSON.stringify(loc.value)})`;
    case 'name':
      return `-ios predicate string:name == ${JSON.stringify(loc.value)} OR label == ${JSON.stringify(loc.value)}`;
    case 'iosPredicate':
      return `-ios predicate string:${loc.value}`;
    case 'iosClassChain':
      return `-ios class chain:${loc.value}`;
    case 'coordinate':
      return '';
    default:
      return '';
  }
}

function platformLocatorLiteral(el: CrossPlatformElement): string {
  const parts: string[] = [];
  if (el.android) parts.push(`android: ${JSON.stringify(wdioSelector(el.android))}`);
  if (el.ios) parts.push(`ios: ${JSON.stringify(wdioSelector(el.ios))}`);
  if (el.fallback && el.fallback.strategy === 'coordinate') parts.push(`coordinate: ${JSON.stringify(el.fallback.value)}`);
  else if (el.fallback && !el.android && !el.ios) parts.push(`android: ${JSON.stringify(wdioSelector(el.fallback))}`);
  return `{ ${parts.join(', ')} }`;
}

export function emitJsSuite(input: JsEmitInput): GeneratedFile[] {
  const ts = input.language === 'typescript';
  const ext = ts ? 'ts' : 'js';
  const files: GeneratedFile[] = [];
  // Plan every class/field/method name up front (H4) and validate every step is emittable (§4) —
  // generation fails loudly here rather than writing a suite with silent no-op steps.
  const names = planJsNames(input.model);
  const smoke = smokeTest(input.model, names);

  files.push({ path: 'package.json', content: packageJson(input) });
  if (ts) files.push({ path: 'tsconfig.json', content: tsconfigJson() });
  files.push({ path: `wdio.conf.${ext}`, content: wdioConf(ts, ext) });
  files.push({ path: `src/config/capabilities.${ext}`, content: capabilities(input, ts) });
  files.push({ path: `src/utils/locators.${ext}`, content: locatorsUtil(ts) });
  files.push({ path: `src/utils/waits.${ext}`, content: waitsUtil(ts) });
  files.push({ path: `src/screens/BaseScreen.${ext}`, content: baseScreen(ts) });
  for (const screen of screensOf(input.model)) {
    const n = names.get(screen.className)!;
    files.push({ path: `src/screens/${n.cls}.${ext}`, content: screenClass(screen, n, input.model.steps, ts) });
  }
  files.push({ path: `src/data/testData.${ext}`, content: testData(input.model, ts) });
  files.push({ path: `test/smoke.e2e.${ext}`, content: smoke });
  return files;
}

function packageJson(input: JsEmitInput): string {
  const ts = input.language === 'typescript';
  const name = `${(input.appId ?? 'app').split('.').pop()}-appium-suite`;
  const pkg: Record<string, unknown> = {
    name,
    private: true,
    type: 'module',
    description: 'Generated by Swipium — WebdriverIO + Appium POM suite (review before committing).',
    scripts: {
      test: 'wdio run ./wdio.conf.' + (ts ? 'ts' : 'js'),
    },
    devDependencies: {
      '@wdio/cli': '^9.0.0',
      '@wdio/local-runner': '^9.0.0',
      '@wdio/mocha-framework': '^9.0.0',
      '@wdio/appium-service': '^9.0.0',
      '@wdio/spec-reporter': '^9.0.0',
      appium: '^2.11.0',
      ...(ts ? { typescript: '^5.7.0', tsx: '^4.19.0', '@types/node': '^22.0.0' } : {}),
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function tsconfigJson(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node', '@wdio/globals/types', '@wdio/mocha-framework'],
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts', 'test/**/*.ts', 'wdio.conf.ts'],
      },
      null,
      2,
    ) + '\n'
  );
}

function wdioConf(ts: boolean, ext: string): string {
  const header = '// Generated by Swipium. WebdriverIO + Appium config — capabilities come from env (see src/config/capabilities).';
  const importLine = `import { buildCapabilities } from './src/config/capabilities.js';`;
  const typeAnno = ts ? `\nimport type { Options } from '@wdio/types';\n` : '\n';
  const cfgType = ts ? ': WebdriverIO.Config' : '';
  return `${header}${typeAnno}${importLine}

export const config${cfgType} = {
  runner: 'local',
  hostname: process.env.APPIUM_HOST || '127.0.0.1',
  port: Number(process.env.APPIUM_PORT || 4723),
  path: '/',
  specs: ['./test/**/*.e2e.${ext}'],
  maxInstances: 1,
  capabilities: [buildCapabilities()],
  logLevel: 'info',
  waitforTimeout: ${DEFAULT_TIMEOUT},
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120000 },
  services: [['appium', { args: { address: process.env.APPIUM_HOST || '127.0.0.1' } }]],
};
`;
}

function capabilities(input: JsEmitInput, ts: boolean): string {
  const primary = defaultPlatformOf(input.profile, input.model);
  const ret = ts ? ': WebdriverIO.Capabilities' : '';
  const appId = input.appId ?? '';
  const lines: string[] = [];
  lines.push('// Generated by Swipium. ALL device/app config is environment-driven — no secrets, no hardcoded paths.');
  lines.push(
    primary === 'ios'
      ? '// iOS (XCUITest) is the default for this suite; set SWIPIUM_PLATFORM=android to target Android (UiAutomator2).'
      : '// Android (UiAutomator2) is the default for this suite; set SWIPIUM_PLATFORM=ios to target iOS (XCUITest).',
  );
  lines.push('');
  lines.push(`export function buildCapabilities()${ret} {`);
  lines.push(`  const platform = (process.env.SWIPIUM_PLATFORM || ${JSON.stringify(primary)}).toLowerCase();`);
  lines.push("  if (platform === 'ios') {");
  lines.push('    return {');
  lines.push("      platformName: 'iOS',");
  lines.push("      'appium:automationName': 'XCUITest',");
  lines.push("      'appium:deviceName': process.env.IOS_DEVICE_NAME || 'iPhone 15',");
  lines.push("      'appium:platformVersion': process.env.IOS_PLATFORM_VERSION,");
  lines.push(`      'appium:bundleId': process.env.IOS_BUNDLE_ID${appId ? ` || ${JSON.stringify(appId)}` : ''},`);
  lines.push("      'appium:app': process.env.IOS_APP_PATH,");
  lines.push("      'appium:udid': process.env.IOS_UDID,");
  lines.push("      'appium:noReset': process.env.SWIPIUM_NO_RESET === 'true',");
  lines.push('    };');
  lines.push('  }');
  lines.push('  // Android UiAutomator2.');
  lines.push('  return {');
  lines.push("    platformName: 'Android',");
  lines.push("    'appium:automationName': 'UiAutomator2',");
  lines.push("    'appium:deviceName': process.env.ANDROID_DEVICE_NAME || 'Android Emulator',");
  lines.push(`    'appium:appPackage': process.env.ANDROID_APP_PACKAGE${appId ? ` || ${JSON.stringify(appId)}` : ''},`);
  lines.push("    'appium:appActivity': process.env.ANDROID_APP_ACTIVITY,");
  lines.push("    'appium:app': process.env.ANDROID_APP_PATH,");
  lines.push("    'appium:udid': process.env.ANDROID_UDID,");
  lines.push("    'appium:noReset': process.env.SWIPIUM_NO_RESET === 'true',");
  lines.push('  };');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function locatorsUtil(ts: boolean): string {
  const typeBlock = ts
    ? `export interface PlatformLocator {\n  android?: string;\n  ios?: string;\n  /** "x,y" coordinate fallback — non-release-grade. */\n  coordinate?: string;\n}\n\n`
    : '';
  const param = ts ? 'loc: PlatformLocator' : 'loc';
  const ret = ts ? ': string' : '';
  return `// Generated by Swipium. Resolves a centralized cross-platform locator to a wdio selector at runtime.
${typeBlock}export function resolveSelector(${param})${ret} {
  // @ts-ignore wdio global
  const android = typeof driver !== 'undefined' ? driver.isAndroid : true;
  const selector = android ? loc.android : loc.ios;
  if (!selector) {
    throw new Error('No durable selector for this platform — element relies on a coordinate fallback (non-release-grade). Add an accessibility id / resource-id / testID.');
  }
  return selector;
}

export function coordinateOf(${param})${ts ? ': [number, number] | undefined' : ''} {
  if (!loc.coordinate) return undefined;
  const [x, y] = loc.coordinate.split(',').map(Number);
  return [x, y];
}
`;
}

function waitsUtil(ts: boolean): string {
  const elAnno = ts ? ': WebdriverIO.Element' : '';
  const numAnno = ts ? ': number' : '';
  return `// Generated by Swipium. Structured waits — never a bare sleep. Auto-wait before interaction
// (Playwright-style resilience, applied to mobile Appium).
export const DEFAULT_TIMEOUT = ${DEFAULT_TIMEOUT};

export async function waitVisible(el${elAnno}, timeout${numAnno} = DEFAULT_TIMEOUT) {
  await el.waitForDisplayed({ timeout });
  return el;
}

export async function waitEnabled(el${elAnno}, timeout${numAnno} = DEFAULT_TIMEOUT) {
  await el.waitForEnabled({ timeout });
  return el;
}
`;
}

function baseScreen(ts: boolean): string {
  const locImport = ts ? `import type { PlatformLocator } from '../utils/locators.js';\n` : '';
  const p = (name: string, type: string) => (ts ? `${name}: ${type}` : name);
  // H3: TS-only modifiers/annotations are gated on the TypeScript flag so the .js output parses.
  const prot = ts ? 'protected ' : '';
  const dirType = ts ? `: 'up' | 'down' | 'left' | 'right'` : '';
  return `// Generated by Swipium. BaseScreen centralizes all element interaction so selectors are
// resolved per-platform in ONE place and tests never touch raw selectors.
${locImport}import { resolveSelector } from '../utils/locators.js';
import { waitVisible, waitEnabled } from '../utils/waits.js';

/** Upper bound on scroll gestures while looking for an element — never an endless loop. */
export const MAX_SCROLLS = ${MAX_SCROLLS};

export class BaseScreen {
  ${prot}async element(${p('loc', 'PlatformLocator')}) {
    // @ts-ignore wdio global
    return $(resolveSelector(loc));
  }

  ${prot}async tap(${p('loc', 'PlatformLocator')}) {
    const el = await this.element(loc);
    await waitEnabled(await waitVisible(el));
    await el.click();
  }

  ${prot}async type(${p('loc', 'PlatformLocator')}, ${p('value', 'string')}) {
    const el = await this.element(loc);
    await waitVisible(el);
    await el.setValue(value);
  }

  /** Type into whichever field currently has focus (the recording had no locator for it). */
  async typeFocused(${p('value', 'string')}) {
    // @ts-ignore wdio global
    const active = await $(await driver.getActiveElement());
    await active.addValue(value);
  }

  /**
   * One real content-scroll gesture. direction is the CONTENT direction: 'down' reveals what is below.
   * Android: UiAutomator2 \`mobile: scrollGesture\` (returns false once the end is reached).
   * iOS: XCUITest \`mobile: scroll\`.
   */
  async scrollOnce(${p('direction', 'string')} = 'down')${ts ? ': Promise<boolean>' : ''} {
    // @ts-ignore wdio global
    if (driver.isAndroid) {
      // @ts-ignore wdio global
      const { width, height } = await driver.getWindowSize();
      // @ts-ignore wdio global
      const canScrollMore = await driver.execute('mobile: scrollGesture', {
        left: Math.round(width * 0.1),
        top: Math.round(height * 0.2),
        width: Math.round(width * 0.8),
        height: Math.round(height * 0.6),
        direction,
        percent: 0.75,
      });
      return canScrollMore !== false;
    }
    // @ts-ignore wdio global
    await driver.execute('mobile: scroll', { direction });
    return true;
  }

  /** Scroll (bounded by maxScrolls) until the element is displayed; throws if it never appears. */
  ${prot}async scrollTo(${p('loc', 'PlatformLocator')}, ${p('direction', 'string')} = 'down', ${p('maxScrolls', 'number')} = MAX_SCROLLS) {
    let atEnd = false;
    for (let i = 0; i <= maxScrolls; i++) {
      if (await this.isVisible(loc)) return;
      if (i === maxScrolls || atEnd) break;
      atEnd = !(await this.scrollOnce(direction));
    }
    throw new Error('Element not visible after scrolling ' + direction + ' (max ' + maxScrolls + ' scrolls)');
  }

  /** Scroll (bounded) until an element whose text/label contains \`text\` is displayed. */
  async scrollToText(${p('text', 'string')}, ${p('direction', 'string')} = 'down', ${p('maxScrolls', 'number')} = MAX_SCROLLS) {
    let atEnd = false;
    for (let i = 0; i <= maxScrolls; i++) {
      // @ts-ignore wdio global
      if (await $(this.textSelector(text)).isDisplayed()) return;
      if (i === maxScrolls || atEnd) break;
      atEnd = !(await this.scrollOnce(direction));
    }
    throw new Error('Text ' + JSON.stringify(text) + ' not visible after scrolling ' + direction + ' (max ' + maxScrolls + ' scrolls)');
  }

  ${prot}async isVisible(${p('loc', 'PlatformLocator')})${ts ? ': Promise<boolean>' : ''} {
    const el = await this.element(loc);
    return el.isDisplayed();
  }

  async assertVisible(${p('loc', 'PlatformLocator')}) {
    const el = await this.element(loc);
    await waitVisible(el);
  }

  /** Platform-appropriate "text contains" selector. JSON.stringify escapes backslashes and quotes. */
  textSelector(${p('text', 'string')})${ts ? ': string' : ''} {
    // @ts-ignore wdio global
    if (driver.isAndroid) return 'android=new UiSelector().textContains(' + JSON.stringify(text) + ')';
    return '-ios predicate string:label CONTAINS ' + JSON.stringify(text) + ' OR name CONTAINS ' + JSON.stringify(text);
  }

  async assertTextVisible(${p('text', 'string')}) {
    // Non-release-grade text/OCR assertion — prefer a structured locator.
    // @ts-ignore wdio global
    const el = await $(this.textSelector(text));
    await waitVisible(el);
  }

  // Coordinate tap — brittle, non-release-grade fallback. Only used when no durable locator exists.
  async tapAt(${p('x', 'number')}, ${p('y', 'number')}) {
    // @ts-ignore wdio global
    await driver.action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x, y }).down().pause(50).up().perform();
  }

  async pressKey(${p('key', `'back' | 'home' | 'enter'`)}) {
    // @ts-ignore wdio global
    const android = driver.isAndroid;
    if (key === 'back') {
      // @ts-ignore wdio global
      if (android) { await driver.back(); return; }
      // iOS has no system back key: swipe in from the left edge (UINavigationController back gesture).
      // @ts-ignore wdio global
      const { width, height } = await driver.getWindowSize();
      // @ts-ignore wdio global
      await driver.action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ x: 2, y: Math.round(height / 2) }).down().pause(50)
        .move({ duration: 400, x: Math.round(width * 0.7), y: Math.round(height / 2) }).up().perform();
      return;
    }
    if (key === 'home') {
      // @ts-ignore wdio global
      if (android) await driver.execute('mobile: pressKey', { keycode: 3 });
      // @ts-ignore wdio global
      else await driver.execute('mobile: pressButton', { name: 'home' });
      return;
    }
    if (key === 'enter') {
      // @ts-ignore wdio global
      if (android) { await driver.execute('mobile: pressKey', { keycode: 66 }); return; }
      await this.typeFocused('\\n');
      return;
    }
    throw new Error('Unsupported key: ' + key);
  }

  /** Real window-size-relative swipe. direction is the FINGER direction ('up' drags from bottom to top). */
  async swipe(${p('direction', dirType.slice(2) || 'string')}) {
    // @ts-ignore wdio global
    const { width, height } = await driver.getWindowSize();
    const cx = Math.round(width / 2), cy = Math.round(height / 2);
    const map = {
      up: [cx, Math.round(height * 0.8), cx, Math.round(height * 0.2)],
      down: [cx, Math.round(height * 0.2), cx, Math.round(height * 0.8)],
      left: [Math.round(width * 0.8), cy, Math.round(width * 0.2), cy],
      right: [Math.round(width * 0.2), cy, Math.round(width * 0.8), cy],
    };
    const vec = map[direction];
    if (!vec) throw new Error('Unsupported swipe direction: ' + direction);
    const [x1, y1, x2, y2] = vec;
    // @ts-ignore wdio global
    await driver.action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x: x1, y: y1 }).down().pause(100).move({ duration: 600, x: x2, y: y2 }).up().perform();
  }

  async openUrl(${p('url', 'string')}) {
    // @ts-ignore wdio global
    await driver.url(url);
  }
}
`;
}

/** Base (pre-dedupe) action-method name for an (action, element) pair. */
function methodBase(action: AppiumStep['action'], E: string): string {
  switch (action) {
    case 'tap':
      return `tap${E}`;
    case 'inputText':
      return `enter${E}`;
    case 'scrollTo':
      return `scrollTo${E}`;
    case 'assertVisible':
      return `assert${E}Visible`;
    default:
      throw new UnemittableStepError(`cannot emit a ${action} step bound to an element — no generated action exists for it`);
  }
}

function screenClass(screen: AppiumScreen, names: JsScreenNames, steps: AppiumStep[], ts: boolean): string {
  const lines: string[] = [];
  lines.push(
    `// Generated by Swipium. Screen object for ${commentSafe(screen.pageName)}${screen.screenSignature ? ` (${commentSafe(screen.screenSignature)})` : ''}.`,
  );
  lines.push('// Selectors are centralized here; tests call the action methods below.');
  if (ts) lines.push(`import type { PlatformLocator } from '../utils/locators.js';`);
  lines.push(`import { BaseScreen } from './BaseScreen.js';`);
  lines.push('');
  lines.push(`export class ${names.cls} extends BaseScreen {`);

  // Locators (centralized). H3: `readonly` + the type annotation are TypeScript-only.
  for (const el of screen.elements) {
    const field = names.fields.get(el.name)!;
    const durabilityNote =
      el.durability === 'durable' ? '' : ` // ${el.durability} locator${el.remediation ? ` — ${commentSafe(el.remediation)}` : ''}`;
    lines.push(`  ${ts ? 'readonly ' : ''}${field}${ts ? ': PlatformLocator' : ''} = ${platformLocatorLiteral(el)};${durabilityNote}`);
  }
  lines.push('');

  // Action methods for each (element, action) used in steps on this screen.
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.screen !== screen.className || !s.element) continue;
    const key = methodKey(s.action, s.element);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = names.methods.get(key)!;
    const field = `this.${names.fields.get(s.element)!}`;
    if (s.action === 'inputText') {
      lines.push(`  async ${name}(${ts ? 'value: string' : 'value'}) {`);
      lines.push(`    await this.type(${field}, value);`);
    } else if (s.action === 'tap') {
      lines.push(`  async ${name}() {`);
      lines.push(`    await this.tap(${field});`);
    } else if (s.action === 'scrollTo') {
      lines.push(`  async ${name}(${ts ? "direction: string = 'down'" : "direction = 'down'"}) {`);
      lines.push(`    await this.scrollTo(${field}, direction);`);
    } else {
      lines.push(`  async ${name}() {`);
      lines.push(`    await this.assertVisible(${field});`);
    }
    lines.push('  }');
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function envRef(v: string): string {
  return jsProp('process.env', v);
}

function testData(model: AppiumSuiteModel, ts: boolean): string {
  const lines: string[] = [];
  const key = (v: string) => (isJsIdentifier(varToKey(v)) ? varToKey(v) : JSON.stringify(varToKey(v)));
  lines.push('// Generated by Swipium. Test data comes from the ENVIRONMENT — secrets are never inlined.');
  lines.push('export const testData = {');
  for (const v of model.variables) {
    lines.push(`  ${key(v)}: ${envRef(v)} || '',`);
  }
  for (const v of model.secrets) {
    lines.push(`  ${key(v)}: ${envRef(v)} || '', // secret — provide via environment only`);
  }
  lines.push('};');
  lines.push('');
  if (ts) lines.push('export type TestData = typeof testData;');
  lines.push('');
  return lines.join('\n');
}

function smokeTest(model: AppiumSuiteModel, names: Map<string, JsScreenNames>): string {
  const classes = [...new Set(model.steps.map((s) => s.screen))];
  const lines: string[] = [];
  lines.push('// Generated by Swipium. Smoke test driving the recorded flow through the screen objects.');
  for (const c of classes) {
    const cls = names.get(c)!.cls;
    lines.push(`import { ${cls} } from '../src/screens/${cls}.js';`);
  }
  lines.push(`import { testData } from '../src/data/testData.js';`);
  lines.push('');
  // H3: titles come from recorded data — always a JSON-escaped literal, never raw interpolation.
  lines.push(`describe(${JSON.stringify(`${model.testName} smoke`)}, () => {`);
  lines.push(`  it(${JSON.stringify('completes the recorded flow')}, async () => {`);
  for (const c of classes) lines.push(`    const ${names.get(c)!.instance} = new ${names.get(c)!.cls}();`);
  for (const s of model.steps) {
    lines.push('    ' + stepCall(names.get(s.screen)!, s));
  }
  lines.push('  });');
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function dataArg(s: AppiumStep): string {
  return s.varName ? jsProp('testData', varToKey(s.varName)) : JSON.stringify(s.text ?? '');
}

function num(n: number | undefined): number {
  return Number.isFinite(n) ? Math.round(n as number) : 0;
}

function stepCall(n: JsScreenNames, s: AppiumStep): string {
  const v = n.instance;
  if (s.element) {
    const name = n.methods.get(methodKey(s.action, s.element))!;
    if (s.action === 'inputText') return `await ${v}.${name}(${dataArg(s)});`;
    if (s.action === 'scrollTo') return `await ${v}.${name}(${JSON.stringify(checkDirection(s.direction ?? 'down', 'scrollTo step'))});`;
    return `await ${v}.${name}();`;
  }
  // No element: generic BaseScreen helpers.
  switch (s.action) {
    case 'tapAt':
      if (!s.coords) throw new UnemittableStepError('cannot emit a coordinate tap without coordinates');
      return `await ${v}.tapAt(${num(s.coords[0])}, ${num(s.coords[1])}); // coordinate fallback — non-release-grade`;
    case 'inputText':
      return `await ${v}.typeFocused(${dataArg(s)}); // focused-field input`;
    case 'press':
      return `await ${v}.pressKey(${JSON.stringify(checkKey(s.key))});`;
    case 'swipe':
      return `await ${v}.swipe(${JSON.stringify(checkDirection(s.direction ?? 'up', 'swipe step'))});`;
    case 'scrollTo':
      if (!s.text) throw new UnemittableStepError('cannot emit a scrollTo step with neither an element nor a target text');
      return `await ${v}.scrollToText(${JSON.stringify(s.text)}, ${JSON.stringify(checkDirection(s.direction ?? 'down', 'scrollTo step'))});`;
    case 'openUrl':
      if (!s.url) throw new UnemittableStepError('cannot emit an openUrl step without a URL');
      return `await ${v}.openUrl(${JSON.stringify(s.url)});`;
    case 'assertVisible':
      if (!s.text) throw new UnemittableStepError('cannot emit a text assertion without text');
      return `await ${v}.assertTextVisible(${JSON.stringify(s.text)});`;
    case 'visualCheck':
      // Visual judgement prose is not on-screen text — a manual checkpoint, never a failing text check.
      return `// TODO(manual visual check — not automated): ${commentSafe(s.text ?? 'visual checkpoint')}`;
    default:
      throw new UnemittableStepError(`cannot emit step action ${JSON.stringify(s.action)} — no WebdriverIO equivalent is generated for it`);
  }
}
