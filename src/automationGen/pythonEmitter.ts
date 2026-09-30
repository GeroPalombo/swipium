// Python Appium emitter. Pure: turns the shared Appium model into a runnable
// Python Appium-Python-Client POM suite (pytest when the project uses it, else unittest). POM
// classes centralize selectors; AppiumBy strategies prefer accessibility id / id; iOS predicate /
// class-chain only where required; XPath is never emitted. Aligns with the Appium Python quickstart.

import type { GeneratedFile } from '../suite/pom.js';
import type { AppiumLocator, AppiumScreen, AppiumStep, AppiumSuiteModel, CrossPlatformElement } from './appiumModel.js';
import type { AutomationProjectProfile } from './projectProfile.js';
import { defaultPlatformOf } from './platformResolve.js';
import { NameAllocator, UnemittableStepError, checkDirection, checkKey, className, commentSafe, pyName, screensOf } from './identifiers.js';

export interface PyEmitInput {
  model: AppiumSuiteModel;
  profile: AutomationProjectProfile;
  appId?: string;
  /** pytest | unittest — from the profile. */
  framework: 'pytest' | 'unittest';
}

const DEFAULT_TIMEOUT = 15;
const MAX_SCROLLS = 8;

function snake(s: string): string {
  return (
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'x'
  );
}

/** Every attribute BaseScreen defines — a generated attribute/method must never shadow one (a class
 *  attribute named `tap` would replace the tap() helper at runtime). */
const PY_BASE_MEMBERS = [
  'driver',
  'find',
  'tap',
  'type',
  'type_focused',
  'scroll_to',
  'scroll_to_text',
  'is_visible',
  'assert_visible',
  'assert_text_visible',
  'tap_at',
  'press_key',
  'swipe',
  'open_url',
  'self',
  'cls',
];

/** Sanitized, collision-free names for one screen class (H4). */
interface PyScreenNames {
  cls: string;
  module: string;
  instance: string;
  attrs: Map<string, string>;
  methods: Map<string, string>;
}

function methodKey(action: AppiumStep['action'], element: string): string {
  return `${action}|${element}`;
}

function planPyNames(model: AppiumSuiteModel): Map<string, PyScreenNames> {
  const classes = new NameAllocator(['BaseScreen', 'AppiumBy', 'SmokeTest', 'WebDriverWait', 'EC'], (s) => s.toLowerCase());
  const modules = new NameAllocator(['base_screen', '__init__'], (s) => s.toLowerCase());
  const instances = new NameAllocator([
    'driver',
    'test_data',
    'self',
    'os',
    'unittest',
    'pytest',
    'webdriver',
    'build_options',
    'AppiumBy',
  ]);
  const plan = new Map<string, PyScreenNames>();
  for (const screen of screensOf(model)) {
    const cls = classes.alloc(className(screen.className));
    const module = modules.alloc(pyName(cls, 'screen'), '_');
    const instance = instances.alloc(pyName(cls, 'screen'), '_');
    // Leading-underscore names are private helpers (_spec, _scroll_once …); pyName never emits them.
    const members = new NameAllocator(PY_BASE_MEMBERS);
    const attrs = new Map<string, string>();
    for (const el of screen.elements) if (!attrs.has(el.name)) attrs.set(el.name, members.alloc(pyName(el.name), '_'));
    const methods = new Map<string, string>();
    for (const s of model.steps) {
      if (s.screen !== screen.className || !s.element) continue;
      const attr = attrs.get(s.element);
      if (!attr) {
        throw new UnemittableStepError(
          `cannot emit ${s.action} step on ${screen.className}: element ${JSON.stringify(s.element)} is not declared on that screen`,
        );
      }
      const key = methodKey(s.action, s.element);
      if (methods.has(key)) continue;
      methods.set(key, members.alloc(methodBase(s.action, attr.replace(/_+$/, '')), '_'));
    }
    plan.set(screen.className, { cls, module, instance, attrs, methods });
  }
  return plan;
}

/** Env var (SWIPIUM_TEST_PASSWORD) → a stable test_data key (password). */
export function pyVarToKey(v: string): string {
  const stripped = v.replace(/^SWIPIUM_(TEST_)?/i, '');
  return snake(stripped) || 'value';
}

function pyStr(s: string): string {
  return JSON.stringify(s);
}

/** Escape a value embedded inside a double-quoted literal WITHIN a selector expression
 *  (UiSelector text / iOS predicate). Backslashes FIRST, then quotes — pyStr() only wraps the
 *  OUTER Python string, so the inner quoted literal must escape its own \ and " itself. */
function innerQuoted(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** (AppiumBy.<X>, "<value>") tuple for one Appium locator. No XPath, ever. */
export function appiumByTuple(loc: AppiumLocator): string | undefined {
  switch (loc.strategy) {
    case 'accessibilityId':
      return `(AppiumBy.ACCESSIBILITY_ID, ${pyStr(loc.value)})`;
    case 'id':
      return `(AppiumBy.ID, ${pyStr(loc.value)})`;
    case 'androidUiautomator':
      return `(AppiumBy.ANDROID_UIAUTOMATOR, ${pyStr(`new UiSelector().text("${innerQuoted(loc.value)}")`)})`;
    case 'name':
      return `(AppiumBy.IOS_PREDICATE, ${pyStr(`name == "${innerQuoted(loc.value)}" OR label == "${innerQuoted(loc.value)}"`)})`;
    case 'iosPredicate':
      return `(AppiumBy.IOS_PREDICATE, ${pyStr(loc.value)})`;
    case 'iosClassChain':
      return `(AppiumBy.IOS_CLASS_CHAIN, ${pyStr(loc.value)})`;
    case 'coordinate':
      return undefined;
    default:
      return undefined;
  }
}

function locatorDict(el: CrossPlatformElement): string {
  const parts: string[] = [];
  if (el.android) {
    const t = appiumByTuple(el.android);
    if (t) parts.push(`"android": ${t}`);
  }
  if (el.ios) {
    const t = appiumByTuple(el.ios);
    if (t) parts.push(`"ios": ${t}`);
  }
  if (el.fallback && el.fallback.strategy === 'coordinate') parts.push(`"coordinate": ${pyStr(el.fallback.value)}`);
  else if (el.fallback && !el.android && !el.ios) {
    const t = appiumByTuple(el.fallback);
    if (t) parts.push(`"android": ${t}`);
  }
  return `{${parts.join(', ')}}`;
}

export function emitPythonSuite(input: PyEmitInput): GeneratedFile[] {
  // Plan every class/attribute/method name up front (H4) and validate every step is emittable
  // (§4) — generation fails loudly here rather than writing a suite with silent no-op steps.
  const names = planPyNames(input.model);
  const smoke = input.framework === 'pytest' ? pytestSmoke(input.model, names) : unittestSmoke(input.model, names);
  const files: GeneratedFile[] = [];
  files.push({ path: 'requirements.txt', content: requirementsTxt(input) });
  if (input.framework === 'pytest') files.push({ path: 'pytest.ini', content: pytestIni() });
  files.push({ path: 'conftest.py', content: conftest(input) });
  files.push({ path: 'screens/__init__.py', content: '' });
  files.push({ path: 'screens/base_screen.py', content: baseScreen() });
  for (const screen of screensOf(input.model)) {
    const n = names.get(screen.className)!;
    files.push({ path: `screens/${n.module}.py`, content: screenClass(screen, n, input.model.steps) });
  }
  files.push({ path: 'data/__init__.py', content: '' });
  files.push({ path: 'data/test_data.py', content: testData(input.model) });
  files.push({ path: 'tests/__init__.py', content: '' });
  files.push({ path: 'tests/test_smoke.py', content: smoke });
  return files;
}

function requirementsTxt(input: PyEmitInput): string {
  const lines = ['# Generated by Swipium — review before committing.', 'Appium-Python-Client>=4.0.0', 'selenium>=4.20.0'];
  if (input.framework === 'pytest') lines.push('pytest>=8.0.0');
  return lines.join('\n') + '\n';
}

function pytestIni(): string {
  return `# Generated by Swipium.
[pytest]
testpaths = tests
python_files = test_*.py
addopts = -ra
`;
}

function conftest(input: PyEmitInput): string {
  const appId = input.appId ?? '';
  return `# Generated by Swipium. Appium driver fixture — ALL device/app config is environment-driven.
# Default platform: ${defaultPlatformOf(input.profile, input.model)} — override with SWIPIUM_PLATFORM=android|ios.
import os
import pytest
from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.options.ios import XCUITestOptions


def build_options():
    platform = os.environ.get("SWIPIUM_PLATFORM", "${defaultPlatformOf(input.profile, input.model)}").lower()
    if platform == "ios":
        opts = XCUITestOptions()
        opts.device_name = os.environ.get("IOS_DEVICE_NAME", "iPhone 15")
        bundle_id = os.environ.get("IOS_BUNDLE_ID"${appId ? `, ${pyStr(appId)}` : ''})
        if bundle_id:
            opts.bundle_id = bundle_id
        if os.environ.get("IOS_APP_PATH"):
            opts.app = os.environ["IOS_APP_PATH"]
        if os.environ.get("IOS_UDID"):
            opts.udid = os.environ["IOS_UDID"]
        opts.no_reset = os.environ.get("SWIPIUM_NO_RESET") == "true"
        return opts
    opts = UiAutomator2Options()
    opts.device_name = os.environ.get("ANDROID_DEVICE_NAME", "Android Emulator")
    app_package = os.environ.get("ANDROID_APP_PACKAGE"${appId ? `, ${pyStr(appId)}` : ''})
    if app_package:
        opts.app_package = app_package
    if os.environ.get("ANDROID_APP_ACTIVITY"):
        opts.app_activity = os.environ["ANDROID_APP_ACTIVITY"]
    if os.environ.get("ANDROID_APP_PATH"):
        opts.app = os.environ["ANDROID_APP_PATH"]
    if os.environ.get("ANDROID_UDID"):
        opts.udid = os.environ["ANDROID_UDID"]
    opts.no_reset = os.environ.get("SWIPIUM_NO_RESET") == "true"
    return opts


@pytest.fixture
def driver():
    url = os.environ.get("APPIUM_URL", "http://127.0.0.1:4723")
    drv = webdriver.Remote(url, options=build_options())
    yield drv
    drv.quit()
`;
}

function baseScreen(): string {
  return `# Generated by Swipium. BaseScreen centralizes element interaction so selectors resolve
# per-platform in ONE place and tests never touch raw selectors.
from appium.webdriver.common.appiumby import AppiumBy
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

DEFAULT_TIMEOUT = ${DEFAULT_TIMEOUT}
# Upper bound on scroll gestures while looking for an element — never an endless loop.
MAX_SCROLLS = ${MAX_SCROLLS}

# Finger-direction swipe vectors as fractions of the window size: (x1, y1, x2, y2).
_SWIPES = {
    "up": (0.5, 0.8, 0.5, 0.2),
    "down": (0.5, 0.2, 0.5, 0.8),
    "left": (0.8, 0.5, 0.2, 0.5),
    "right": (0.2, 0.5, 0.8, 0.5),
}


class BaseScreen:
    def __init__(self, driver):
        self.driver = driver

    def _platform(self):
        return (self.driver.capabilities.get("platformName") or "").lower()

    def _spec(self, loc):
        spec = loc.get("ios") if self._platform() == "ios" else loc.get("android")
        if not spec:
            raise RuntimeError(
                "No durable selector for this platform — element relies on a coordinate fallback "
                "(non-release-grade). Add an accessibility id / resource-id / testID."
            )
        return spec

    def _text_spec(self, text):
        # Escape backslashes first, then quotes, so the runtime text cannot break the selector.
        escaped = text.replace("\\\\", "\\\\\\\\").replace('"', '\\\\"')
        if self._platform() == "ios":
            return (AppiumBy.IOS_PREDICATE, 'label CONTAINS "%s" OR name CONTAINS "%s"' % (escaped, escaped))
        return (AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().textContains("%s")' % escaped)

    def find(self, loc, timeout=DEFAULT_TIMEOUT):
        by, value = self._spec(loc)
        return WebDriverWait(self.driver, timeout).until(
            EC.presence_of_element_located((by, value))
        )

    def tap(self, loc):
        self.find(loc).click()

    def type(self, loc, value):
        el = self.find(loc)
        el.clear()
        el.send_keys(value)

    def type_focused(self, value):
        # The recording had no locator for this field — type into whatever has focus.
        self.driver.switch_to.active_element.send_keys(value)

    def _displayed_now(self, spec):
        try:
            return any(el.is_displayed() for el in self.driver.find_elements(*spec))
        except Exception:
            return False

    def _scroll_once(self, direction):
        """One real content-scroll gesture. direction is the CONTENT direction ("down" reveals
        what is below). Returns False once Android reports the end of the scrollable area."""
        if self._platform() == "ios":
            self.driver.execute_script("mobile: scroll", {"direction": direction})
            return True
        size = self.driver.get_window_size()
        w, h = size["width"], size["height"]
        can_scroll_more = self.driver.execute_script("mobile: scrollGesture", {
            "left": int(w * 0.1),
            "top": int(h * 0.2),
            "width": int(w * 0.8),
            "height": int(h * 0.6),
            "direction": direction,
            "percent": 0.75,
        })
        return can_scroll_more is not False

    def _scroll_until(self, spec, direction, max_scrolls, what):
        at_end = False
        for i in range(max_scrolls + 1):
            if self._displayed_now(spec):
                return
            if i == max_scrolls or at_end:
                break
            at_end = not self._scroll_once(direction)
        raise AssertionError("%s not visible after scrolling %s (max %d scrolls)" % (what, direction, max_scrolls))

    def scroll_to(self, loc, direction="down", max_scrolls=MAX_SCROLLS):
        spec = self._spec(loc)
        self._scroll_until(spec, direction, max_scrolls, "element %r" % (spec,))

    def scroll_to_text(self, text, direction="down", max_scrolls=MAX_SCROLLS):
        self._scroll_until(self._text_spec(text), direction, max_scrolls, "text %r" % (text,))

    def is_visible(self, loc):
        try:
            return self.find(loc).is_displayed()
        except Exception:
            return False

    def assert_visible(self, loc):
        assert self.find(loc).is_displayed()

    def assert_text_visible(self, text):
        # Non-release-grade text assertion — prefer a structured locator.
        spec = self._text_spec(text)
        assert WebDriverWait(self.driver, DEFAULT_TIMEOUT).until(
            EC.presence_of_element_located(spec)
        ).is_displayed()

    def tap_at(self, x, y):
        # Coordinate tap — brittle, non-release-grade fallback.
        self.driver.tap([(x, y)])

    def swipe(self, direction):
        """Real window-size-relative swipe. direction is the FINGER direction ("up" drags bottom → top)."""
        if direction not in _SWIPES:
            raise ValueError("Unsupported swipe direction: %r" % (direction,))
        size = self.driver.get_window_size()
        w, h = size["width"], size["height"]
        fx1, fy1, fx2, fy2 = _SWIPES[direction]
        self.driver.swipe(int(w * fx1), int(h * fy1), int(w * fx2), int(h * fy2), 600)

    def press_key(self, key):
        ios = self._platform() == "ios"
        if key == "back":
            if not ios:
                self.driver.back()
                return
            # iOS has no system back key: swipe in from the left edge (navigation back gesture).
            size = self.driver.get_window_size()
            w, h = size["width"], size["height"]
            self.driver.swipe(2, h // 2, int(w * 0.7), h // 2, 400)
        elif key == "home":
            if ios:
                self.driver.execute_script("mobile: pressButton", {"name": "home"})
            else:
                self.driver.press_keycode(3)
        elif key == "enter":
            if ios:
                self.type_focused("\\n")
            else:
                self.driver.press_keycode(66)
        else:
            raise ValueError("Unsupported key: %r" % (key,))

    def open_url(self, url):
        self.driver.get(url)
`;
}

/** Base (pre-dedupe) action-method name for an (action, attribute) pair. */
function methodBase(action: AppiumStep['action'], e: string): string {
  switch (action) {
    case 'tap':
      return `tap_${e}`;
    case 'inputText':
      return `enter_${e}`;
    case 'scrollTo':
      return `scroll_to_${e}`;
    case 'assertVisible':
      return `assert_${e}_visible`;
    default:
      throw new UnemittableStepError(`cannot emit a ${action} step bound to an element — no generated action exists for it`);
  }
}

function screenClass(screen: AppiumScreen, names: PyScreenNames, steps: AppiumStep[]): string {
  const lines: string[] = [];
  lines.push(
    `# Generated by Swipium. Screen object for ${commentSafe(screen.pageName)}${screen.screenSignature ? ` (${commentSafe(screen.screenSignature)})` : ''}.`,
  );
  lines.push('from appium.webdriver.common.appiumby import AppiumBy  # noqa: F401');
  lines.push('from .base_screen import BaseScreen');
  lines.push('');
  lines.push('');
  lines.push(`class ${names.cls}(BaseScreen):`);
  const body: string[] = [];
  for (const el of screen.elements) {
    const note = el.durability === 'durable' ? '' : `  # ${el.durability}${el.remediation ? ` — ${commentSafe(el.remediation)}` : ''}`;
    body.push(`    ${names.attrs.get(el.name)!} = ${locatorDict(el)}${note}`);
  }
  if (body.length) body.push('');

  const seen = new Set<string>();
  for (const s of steps) {
    if (s.screen !== screen.className || !s.element) continue;
    const key = methodKey(s.action, s.element);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = names.methods.get(key)!;
    const attr = `self.${names.attrs.get(s.element)!}`;
    if (s.action === 'inputText') {
      body.push(`    def ${name}(self, value):`);
      body.push(`        self.type(${attr}, value)`);
    } else if (s.action === 'tap') {
      body.push(`    def ${name}(self):`);
      body.push(`        self.tap(${attr})`);
    } else if (s.action === 'scrollTo') {
      body.push(`    def ${name}(self, direction="down"):`);
      body.push(`        self.scroll_to(${attr}, direction)`);
    } else {
      body.push(`    def ${name}(self):`);
      body.push(`        self.assert_visible(${attr})`);
    }
    body.push('');
  }
  if (!body.length) body.push('    pass');
  lines.push(...body);
  return lines.join('\n').replace(/\n+$/, '\n');
}

function testData(model: AppiumSuiteModel): string {
  const lines: string[] = [];
  lines.push('# Generated by Swipium. Test data comes from the ENVIRONMENT — secrets are never inlined.');
  lines.push('import os');
  lines.push('');
  lines.push('test_data = {');
  for (const v of model.variables) lines.push(`    ${pyStr(pyVarToKey(v))}: os.environ.get(${pyStr(v)}, ""),`);
  for (const v of model.secrets) lines.push(`    ${pyStr(pyVarToKey(v))}: os.environ.get(${pyStr(v)}, ""),  # secret — environment only`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

function stepClasses(model: AppiumSuiteModel): string[] {
  return [...new Set(model.steps.map((s) => s.screen))];
}

function importsForTest(model: AppiumSuiteModel, names: Map<string, PyScreenNames>): string[] {
  return stepClasses(model).map((c) => `from screens.${names.get(c)!.module} import ${names.get(c)!.cls}`);
}

function dataArg(s: AppiumStep): string {
  return s.varName ? `test_data[${pyStr(pyVarToKey(s.varName))}]` : pyStr(s.text ?? '');
}

function num(n: number | undefined): number {
  return Number.isFinite(n) ? Math.round(n as number) : 0;
}

function stepCall(n: PyScreenNames, s: AppiumStep): string {
  const v = n.instance;
  if (s.element) {
    const name = n.methods.get(methodKey(s.action, s.element))!;
    if (s.action === 'inputText') return `${v}.${name}(${dataArg(s)})`;
    if (s.action === 'scrollTo') return `${v}.${name}(${pyStr(checkDirection(s.direction ?? 'down', 'scrollTo step'))})`;
    return `${v}.${name}()`;
  }
  switch (s.action) {
    case 'tapAt':
      if (!s.coords) throw new UnemittableStepError('cannot emit a coordinate tap without coordinates');
      return `${v}.tap_at(${num(s.coords[0])}, ${num(s.coords[1])})  # coordinate fallback — non-release-grade`;
    case 'inputText':
      return `${v}.type_focused(${dataArg(s)})  # focused-field input`;
    case 'press':
      return `${v}.press_key(${pyStr(checkKey(s.key))})`;
    case 'swipe':
      return `${v}.swipe(${pyStr(checkDirection(s.direction ?? 'up', 'swipe step'))})`;
    case 'scrollTo':
      if (!s.text) throw new UnemittableStepError('cannot emit a scrollTo step with neither an element nor a target text');
      return `${v}.scroll_to_text(${pyStr(s.text)}, ${pyStr(checkDirection(s.direction ?? 'down', 'scrollTo step'))})`;
    case 'openUrl':
      if (!s.url) throw new UnemittableStepError('cannot emit an openUrl step without a URL');
      return `${v}.open_url(${pyStr(s.url)})`;
    case 'assertVisible':
      if (!s.text) throw new UnemittableStepError('cannot emit a text assertion without text');
      return `${v}.assert_text_visible(${pyStr(s.text)})`;
    case 'visualCheck':
      // Visual judgement prose is not on-screen text — a manual checkpoint, never a failing text check.
      // A comment line is safe here: the test body always instantiates the step's screen first.
      return `# TODO(manual visual check — not automated): ${commentSafe(s.text ?? 'visual checkpoint')}`;
    default:
      throw new UnemittableStepError(
        `cannot emit step action ${JSON.stringify(s.action)} — no Appium Python equivalent is generated for it`,
      );
  }
}

function pytestSmoke(model: AppiumSuiteModel, names: Map<string, PyScreenNames>): string {
  const lines: string[] = [];
  lines.push('# Generated by Swipium. Smoke test driving the recorded flow through the screen objects.');
  lines.push(...importsForTest(model, names));
  lines.push('from data.test_data import test_data  # noqa: F401');
  lines.push('');
  lines.push('');
  lines.push('def test_smoke(driver):');
  for (const c of stepClasses(model)) lines.push(`    ${names.get(c)!.instance} = ${names.get(c)!.cls}(driver)`);
  for (const s of model.steps) lines.push(`    ${stepCall(names.get(s.screen)!, s)}`);
  if (!model.steps.length) lines.push('    pass');
  return lines.join('\n') + '\n';
}

function unittestSmoke(model: AppiumSuiteModel, names: Map<string, PyScreenNames>): string {
  const lines: string[] = [];
  lines.push('# Generated by Swipium. Smoke test (unittest) driving the recorded flow through screen objects.');
  lines.push('import os');
  lines.push('import unittest');
  lines.push('from appium import webdriver');
  lines.push('from conftest import build_options');
  lines.push(...importsForTest(model, names));
  lines.push('from data.test_data import test_data  # noqa: F401');
  lines.push('');
  lines.push('');
  lines.push('class SmokeTest(unittest.TestCase):');
  lines.push('    def setUp(self):');
  lines.push('        url = os.environ.get("APPIUM_URL", "http://127.0.0.1:4723")');
  lines.push('        self.driver = webdriver.Remote(url, options=build_options())');
  lines.push('');
  lines.push('    def tearDown(self):');
  lines.push('        if self.driver:');
  lines.push('            self.driver.quit()');
  lines.push('');
  lines.push('    def test_smoke(self):');
  for (const c of stepClasses(model)) lines.push(`        ${names.get(c)!.instance} = ${names.get(c)!.cls}(self.driver)`);
  for (const s of model.steps) lines.push(`        ${stepCall(names.get(s.screen)!, s)}`);
  if (!model.steps.length) lines.push('        pass');
  lines.push('');
  lines.push('');
  lines.push('if __name__ == "__main__":');
  lines.push('    unittest.main()');
  return lines.join('\n') + '\n';
}
