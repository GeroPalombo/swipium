// SWIPIUM-REQ-04 — Cross-platform Appium POM model. Pure transform of the canonical Swipium POM
// (src/suite/pom.ts) into an Appium-ready, language-agnostic screen model that the JS and Python
// emitters share. This is the "shared intermediate model" the requirement asks for so generated
// JS/Python cannot drift from Swipium YAML semantics.
//
// Locator policy (REQ-04 §Generated * Suite Requirements + Appium locator-strategy guidance):
//   accessibility id > resource-id/id > iOS predicate/class-chain/name > text > coordinate.
//   XPath is NEVER emitted; coordinate is the explicit non-release-grade fallback.

import type { Durability, PomResult, PomTestStep } from '../suite/pom.js';

export type AppiumStrategy = 'accessibilityId' | 'id' | 'name' | 'iosPredicate' | 'iosClassChain' | 'androidUiautomator' | 'coordinate';

export interface AppiumLocator {
  strategy: AppiumStrategy;
  value: string;
  /** True for accessibility id / resource id — durable across releases. */
  durable: boolean;
  /** Coordinate (and, to a lesser degree, raw text) is brittle and not release-grade. */
  releaseGrade: boolean;
}

export interface CrossPlatformElement {
  name: string;
  role?: string;
  android?: AppiumLocator;
  ios?: AppiumLocator;
  fallback?: AppiumLocator;
  durability: Durability;
  required: boolean;
  secure?: boolean;
  remediation?: string;
  mapScreenId?: string;
  sourceFile?: string;
}

export type AppiumActionKind = 'tap' | 'tapAt' | 'inputText' | 'press' | 'swipe' | 'scrollTo' | 'openUrl' | 'assertVisible';

export interface AppiumStep {
  /** Screen CLASS name (e.g. LoginScreen) the step targets. */
  screen: string;
  /** Element name on that screen (camelCase), if any. */
  element?: string;
  action: AppiumActionKind;
  text?: string;
  /** True when `text` is a ${VAR} secret placeholder — never inline the value. */
  secret?: boolean;
  /** Env var name backing a secret/templated value. */
  varName?: string;
  key?: string;
  direction?: string;
  url?: string;
  coords?: [number, number];
}

export interface AppiumScreen {
  /** Class name, e.g. LoginScreen. */
  className: string;
  /** Original POM page name, e.g. LoginPage. */
  pageName: string;
  /** Foreground owner / screen signature, when known. */
  screenSignature?: string;
  elements: CrossPlatformElement[];
}

export interface AppiumSuiteModel {
  testName: string;
  screens: AppiumScreen[];
  steps: AppiumStep[];
  /** Non-secret ${VARS} the suite needs (test data). */
  variables: string[];
  /** Secret ${VARS} — must come from the environment, never inlined. */
  secrets: string[];
  audit: PomResult['audit'];
  platforms: { android: boolean; ios: boolean };
}

/** PomPage name (LoginPage) → screen class name (LoginScreen). */
export function screenClassName(pageName: string): string {
  return /Page$/.test(pageName) ? pageName.replace(/Page$/, 'Screen') : `${pageName}Screen`;
}

function durableStrategy(s: AppiumStrategy): boolean {
  return s === 'accessibilityId' || s === 'id';
}

function locator(strategy: AppiumStrategy, value: string): AppiumLocator {
  const durable = durableStrategy(strategy);
  // coordinate is never release-grade; raw text is a semi-fragile fallback but still runnable.
  const releaseGrade = strategy !== 'coordinate';
  return { strategy, value, durable, releaseGrade };
}

/**
 * Compute the platform-specific Appium locators for one POM element selectorKind.
 * Returns { android, ios, fallback } — any of which may be undefined.
 */
function locatorsFor(
  selectorKind: string,
  selector: string | undefined,
  coords: [number, number] | undefined,
  platforms: { android: boolean; ios: boolean },
): { android?: AppiumLocator; ios?: AppiumLocator; fallback?: AppiumLocator } {
  const value = selector ?? '';
  switch (selectorKind) {
    case 'accessibility_id': {
      // accessibility id is the one strategy that is durable AND cross-platform.
      const loc = locator('accessibilityId', value);
      return { android: platforms.android ? loc : undefined, ios: platforms.ios ? loc : undefined };
    }
    case 'resource_id':
      return { android: platforms.android ? locator('id', value) : undefined };
    case 'name':
      return { ios: platforms.ios ? locator('name', value) : undefined };
    case 'predicate':
      return { ios: platforms.ios ? locator('iosPredicate', value) : undefined };
    case 'class_chain':
      return { ios: platforms.ios ? locator('iosClassChain', value) : undefined };
    case 'text': {
      // text → Android UiAutomator text match (semi), iOS name match (semi). Both fragile.
      const android = platforms.android ? locator('androidUiautomator', value) : undefined;
      const ios = platforms.ios ? locator('name', value) : undefined;
      return { android, ios, fallback: locator('androidUiautomator', value) };
    }
    case 'coords':
    default: {
      const c = coords ?? [0, 0];
      return { fallback: locator('coordinate', `${c[0]},${c[1]}`) };
    }
  }
}

/**
 * Build the cross-platform Appium model from a generated POM + the resolved platform support.
 */
export function buildAppiumModel(
  pom: PomResult,
  opts: { platforms: { android: boolean; ios: boolean }; sourceFilePrefix?: string },
): AppiumSuiteModel {
  const platforms = opts.platforms;
  const secrets = new Set<string>();
  const variables = new Set<string>();

  const screens: AppiumScreen[] = pom.pages.map((p) => {
    const className = screenClassName(p.name);
    const elements: CrossPlatformElement[] = p.elements.map((e) => {
      const { android, ios, fallback } = locatorsFor(e.selectorKind, e.selector, e.coords, platforms);
      return {
        name: e.name,
        role: undefined,
        android,
        ios,
        fallback,
        durability: e.durability,
        required: e.required,
        secure: e.secure,
        remediation: e.remediation,
        mapScreenId: p.screen,
        sourceFile: opts.sourceFilePrefix
          ? `${opts.sourceFilePrefix}/pages/${kebab(p.name)}.page.yaml`
          : `pages/${kebab(p.name)}.page.yaml`,
      };
    });
    return { className, pageName: p.name, screenSignature: p.screen, elements };
  });

  const steps: AppiumStep[] = pom.steps.map((s) => toStep(s, secrets, variables));

  return {
    testName: pom.testName,
    screens,
    steps,
    variables: [...variables],
    secrets: [...secrets],
    audit: pom.audit,
    platforms,
  };
}

function toStep(s: PomTestStep, secrets: Set<string>, variables: Set<string>): AppiumStep {
  const screen = screenClassName(s.page);
  const base: AppiumStep = { screen, element: s.element, action: s.action as AppiumActionKind };
  if (s.action === 'inputText') {
    const m = (s.text ?? '').match(/^\$\{([^}]+)\}$/);
    if (m) {
      if (s.secret) secrets.add(m[1]);
      else variables.add(m[1]);
      return { ...base, action: 'inputText', text: s.text, secret: s.secret, varName: m[1] };
    }
    // literal non-secret text — also scan for embedded ${VARS}
    for (const mm of (s.text ?? '').matchAll(/\$\{([^}]+)\}/g)) variables.add(mm[1]);
    return { ...base, action: 'inputText', text: s.text ?? '', secret: s.secret };
  }
  if (s.action === 'tap' && !s.element && s.coords) return { ...base, action: 'tapAt', coords: s.coords };
  if (s.action === 'press') return { ...base, action: 'press', key: s.key };
  if (s.action === 'swipe') return { ...base, action: 'swipe', direction: s.direction };
  if (s.action === 'openUrl') return { ...base, action: 'openUrl', url: s.url };
  if (s.action === 'assertVisible') return { ...base, action: 'assertVisible', text: s.text };
  return base;
}

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
