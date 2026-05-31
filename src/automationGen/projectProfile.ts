// SWIPIUM-REQ-04 — Automation project profile. Pure-ish module (filesystem reads only, no device,
// no mutation) that inspects a project root and decides HOW an "Automate my app" suite should be
// generated: which automation language (TS/JS/Python), which test framework, which Appium backend
// is the fast-feedback default, and what existing automation already lives in the repo.
//
// The selection rules are taken verbatim from SWIPIUM-REQ-04 §"Automation Project Profile
// Requirements" so the behavior is testable without a device and stable across runs.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectFramework, type Framework } from '../context/detect.js';

export type AutomationLanguage = 'typescript' | 'javascript' | 'python';
export type PrimaryLanguage = AutomationLanguage | 'swift' | 'kotlin' | 'dart' | 'unknown';
export type TestFramework = 'webdriverio' | 'mocha' | 'jest' | 'pytest' | 'unittest';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'poetry' | 'uv';
export type AppiumBackend = 'appium-uiautomator2' | 'appium-xcuitest';
export type SecondaryBackend = 'appium-xcuitest' | 'ios-wda' | 'android-direct';
export type OutputMode = 'project_native' | 'swipium_scaffold';

/** How well a platform is supported by THIS project — distinct from "we actually ran on it". */
export type PlatformSupportLevel = 'supported' | 'evidence_only' | 'none';

export interface PlatformSupport {
  level: PlatformSupportLevel;
  reasons: string[];
}

export interface ExistingAutomationSignal {
  /** webdriverio | mocha | jest | vitest | pytest | unittest | appium-python | detox | maestro | swipium-flows | native */
  tool: string;
  evidence: string;
}

export interface AutomationProjectProfile {
  projectRoot: string;
  appFramework: Framework;
  platforms: {
    android: PlatformSupport;
    ios: PlatformSupport;
  };
  primaryLanguage: PrimaryLanguage;
  automationLanguage: AutomationLanguage;
  testFramework: TestFramework;
  existingAutomation: ExistingAutomationSignal[];
  packageManager?: PackageManager;
  outputMode: OutputMode;
  defaultBackend: AppiumBackend;
  secondaryBackend?: SecondaryBackend;
  reasons: string[];
}

export interface ProfileInputs {
  /** auto | javascript | typescript | python — caller override of the language decision. */
  language?: 'auto' | AutomationLanguage;
  /** auto | android | ios | both — caller override of the platform decision. */
  platform?: 'auto' | 'android' | 'ios' | 'both';
  /** Write into the user's existing test dir (project_native) vs .swipium scaffold. Default false. */
  integrateIntoProject?: boolean;
  /** appId from the session/scan, used only to enrich reasons. */
  appId?: string;
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function deps(root: string): Record<string, unknown> {
  const pkg = readJson(join(root, 'package.json'));
  if (!pkg) return {};
  return { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, unknown>;
}

function hasDep(d: Record<string, unknown>, re: RegExp): boolean {
  return Object.keys(d).some((k) => re.test(k));
}

function exists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

/** Best-effort: does the project have any Python automation stack present? */
function pythonStack(root: string): { present: boolean; pytest: boolean; appiumClient: boolean; evidence: string[] } {
  const evidence: string[] = [];
  const pyproject = exists(root, 'pyproject.toml') ? readFileSafe(join(root, 'pyproject.toml')) : '';
  const requirements = exists(root, 'requirements.txt') ? readFileSafe(join(root, 'requirements.txt')) : '';
  const setup = exists(root, 'setup.py') || exists(root, 'setup.cfg');
  const haystack = `${pyproject}\n${requirements}`.toLowerCase();
  const pytest = /(^|[^a-z])pytest([^a-z]|$)/.test(haystack) || exists(root, 'pytest.ini') || exists(root, 'conftest.py');
  const appiumClient = /appium-python-client/.test(haystack);
  if (pyproject) evidence.push('pyproject.toml');
  if (requirements) evidence.push('requirements.txt');
  if (setup) evidence.push('setup.py/setup.cfg');
  if (pytest) evidence.push('pytest');
  if (appiumClient) evidence.push('appium-python-client');
  const present = !!pyproject || !!requirements || setup || pytest || appiumClient;
  return { present, pytest, appiumClient, evidence };
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function detectExistingAutomation(root: string, d: Record<string, unknown>, py: ReturnType<typeof pythonStack>): ExistingAutomationSignal[] {
  const signals: ExistingAutomationSignal[] = [];
  if (hasDep(d, /^@wdio\/|^webdriverio$/)) signals.push({ tool: 'webdriverio', evidence: 'package.json: webdriverio/@wdio dependency' });
  if (hasDep(d, /^mocha$/)) signals.push({ tool: 'mocha', evidence: 'package.json: mocha dependency' });
  if (hasDep(d, /^jest$|^@jest\//)) signals.push({ tool: 'jest', evidence: 'package.json: jest dependency' });
  if (hasDep(d, /^vitest$/)) signals.push({ tool: 'vitest', evidence: 'package.json: vitest dependency' });
  if (hasDep(d, /^detox$/)) signals.push({ tool: 'detox', evidence: 'package.json: detox dependency' });
  if (py.appiumClient) signals.push({ tool: 'appium-python', evidence: 'Appium-Python-Client in Python deps' });
  if (py.pytest) signals.push({ tool: 'pytest', evidence: 'pytest config/dependency' });
  // Maestro: a .maestro dir or *.flow.yaml under it.
  if (exists(root, '.maestro') || exists(root, 'maestro')) signals.push({ tool: 'maestro', evidence: '.maestro/ flows present' });
  // Existing Swipium YAML flows.
  if (exists(root, '.swipium/flows') && hasYaml(join(root, '.swipium/flows'))) {
    signals.push({ tool: 'swipium-flows', evidence: '.swipium/flows/*.yaml present' });
  }
  return signals;
}

function hasYaml(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => /\.ya?ml$/i.test(f));
  } catch {
    return false;
  }
}

function detectPackageManager(root: string, automationLanguage: AutomationLanguage): PackageManager | undefined {
  if (automationLanguage === 'python') {
    if (exists(root, 'poetry.lock')) return 'poetry';
    if (exists(root, 'uv.lock')) return 'uv';
    if (exists(root, 'requirements.txt') || exists(root, 'pyproject.toml')) return 'pip';
    return 'pip';
  }
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  if (exists(root, 'package-lock.json') || exists(root, 'package.json')) return 'npm';
  return undefined;
}

function primaryLanguageFor(root: string, fw: Framework, d: Record<string, unknown>, py: ReturnType<typeof pythonStack>): PrimaryLanguage {
  if (fw === 'flutter') return 'dart';
  if (fw === 'native-ios') return 'swift';
  if (fw === 'native-android') return 'kotlin';
  if (fw === 'expo' || fw === 'bare-react-native') {
    return exists(root, 'tsconfig.json') || hasDep(d, /^typescript$/) ? 'typescript' : 'javascript';
  }
  // Unknown framework: infer from on-disk languages.
  if (exists(root, 'package.json')) return exists(root, 'tsconfig.json') ? 'typescript' : 'javascript';
  if (py.present) return 'python';
  return 'unknown';
}

/** Platform support from framework + artifact/source evidence. */
function platformSupport(root: string, fw: Framework, appId?: string): { android: PlatformSupport; ios: PlatformSupport } {
  const androidReasons: string[] = [];
  const iosReasons: string[] = [];
  let android: PlatformSupportLevel = 'none';
  let ios: PlatformSupportLevel = 'none';

  const hasAndroidSource = exists(root, 'android') || exists(root, 'app/build.gradle') || exists(root, 'build.gradle') || exists(root, 'settings.gradle') || exists(root, 'settings.gradle.kts');
  const hasIosSource = exists(root, 'ios') || readdirSafe(root).some((f) => /\.xcworkspace$|\.xcodeproj$/.test(f)) || exists(root, 'Package.swift');

  if (fw === 'native-android') {
    android = 'supported';
    androidReasons.push('native-android project');
  } else if (fw === 'native-ios') {
    ios = 'supported';
    iosReasons.push('native-ios project');
  } else if (fw === 'expo' || fw === 'bare-react-native' || fw === 'flutter') {
    // Cross-platform frameworks support both; downgrade to evidence_only when the platform
    // folder/config isn't present yet.
    android = hasAndroidSource ? 'supported' : 'evidence_only';
    ios = hasIosSource ? 'supported' : 'evidence_only';
    androidReasons.push(hasAndroidSource ? `${fw} with android/ project` : `${fw} can target Android (no android/ folder yet)`);
    iosReasons.push(hasIosSource ? `${fw} with ios/ project` : `${fw} can target iOS (no ios/ folder yet)`);
  } else {
    // Unknown framework: lean on raw source evidence.
    if (hasAndroidSource) { android = 'supported'; androidReasons.push('android source detected'); }
    if (hasIosSource) { ios = 'supported'; iosReasons.push('ios source detected'); }
  }

  if (appId) {
    androidReasons.push(`appId ${appId}`);
    iosReasons.push(`appId ${appId}`);
  }
  return {
    android: { level: android, reasons: androidReasons },
    ios: { level: ios, reasons: iosReasons },
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Apply the caller's platform override on top of detected support. */
function applyPlatformOverride(
  platforms: { android: PlatformSupport; ios: PlatformSupport },
  override: ProfileInputs['platform'],
): { android: PlatformSupport; ios: PlatformSupport } {
  if (!override || override === 'auto') return platforms;
  const android = { ...platforms.android };
  const ios = { ...platforms.ios };
  if (override === 'android') {
    if (ios.level === 'supported') { ios.level = 'evidence_only'; ios.reasons = [...ios.reasons, 'demoted: caller requested android-only generation']; }
  } else if (override === 'ios') {
    if (android.level === 'supported') { android.level = 'evidence_only'; android.reasons = [...android.reasons, 'demoted: caller requested ios-only generation']; }
  } else if (override === 'both') {
    if (android.level === 'none') { android.level = 'evidence_only'; android.reasons = [...android.reasons, 'forced: caller requested both platforms']; }
    if (ios.level === 'none') { ios.level = 'evidence_only'; ios.reasons = [...ios.reasons, 'forced: caller requested both platforms']; }
  }
  return { android, ios };
}

/**
 * Build the automation project profile. Filesystem-only, deterministic, no device.
 */
export function buildProjectProfile(root: string, inputs: ProfileInputs = {}): AutomationProjectProfile {
  const fw = detectFramework(root);
  const d = deps(root);
  const py = pythonStack(root);
  const reasons: string[] = [];

  const platformsBase = platformSupport(root, fw, inputs.appId);
  const platforms = applyPlatformOverride(platformsBase, inputs.platform);

  const primaryLanguage = primaryLanguageFor(root, fw, d, py);
  const hasJsProject = exists(root, 'package.json');
  const hasTs = exists(root, 'tsconfig.json') || hasDep(d, /^typescript$/);

  // ---- automation language selection (REQ-04 selection rules) ----
  let automationLanguage: AutomationLanguage;
  if (inputs.language && inputs.language !== 'auto') {
    automationLanguage = inputs.language;
    reasons.push(`language forced to ${automationLanguage} by caller`);
  } else if ((primaryLanguage === 'python' || py.pytest || py.appiumClient) && !hasJsProject) {
    automationLanguage = 'python';
    reasons.push('Python project / pytest / Appium-Python-Client present and no JS package.json → Python');
  } else if (hasJsProject) {
    automationLanguage = hasTs ? 'typescript' : 'javascript';
    reasons.push(`JS/TS project (package.json) → ${automationLanguage}${hasTs ? ' (TypeScript present)' : ' (no TypeScript)'}`);
  } else if (py.present) {
    automationLanguage = 'python';
    reasons.push('Python stack present (no package.json) → Python');
  } else {
    automationLanguage = 'typescript';
    reasons.push('No clear JS/Python stack — defaulting to TypeScript WebdriverIO Appium');
  }

  // ---- test framework selection ----
  let testFramework: TestFramework;
  if (automationLanguage === 'python') {
    testFramework = py.pytest ? 'pytest' : 'unittest';
    reasons.push(testFramework === 'pytest' ? 'pytest already in project → pytest' : 'no pytest → unittest-compatible structure');
  } else if (hasDep(d, /^@wdio\/|^webdriverio$/)) {
    testFramework = 'webdriverio';
    reasons.push('WebdriverIO already in project → webdriverio runner');
  } else if (hasDep(d, /^jest$|^@jest\//)) {
    testFramework = 'jest';
    reasons.push('Jest present — generated WDIO suite uses the mocha-style runner but jest noted as existing');
  } else {
    testFramework = 'webdriverio';
    reasons.push('default WebdriverIO + Appium for Node (per Appium JS quickstart)');
  }

  const packageManager = detectPackageManager(root, automationLanguage);
  if (packageManager) reasons.push(`package manager: ${packageManager}`);

  const existingAutomation = detectExistingAutomation(root, d, py);
  if (existingAutomation.some((s) => s.tool === 'maestro' || s.tool === 'swipium-flows')) {
    reasons.push('existing Maestro/.swipium flows kept — Appium code generated as an ADDITIONAL layer, not a replacement');
  }

  // ---- backend selection (Android-first for dual platform) ----
  const androidOk = platforms.android.level !== 'none';
  const iosOk = platforms.ios.level !== 'none';
  let defaultBackend: AppiumBackend;
  let secondaryBackend: SecondaryBackend | undefined;
  if (androidOk && iosOk) {
    defaultBackend = 'appium-uiautomator2';
    secondaryBackend = 'appium-xcuitest';
    reasons.push('dual-platform: Android UiAutomator2 default (faster feedback), iOS XCUITest secondary');
  } else if (iosOk && !androidOk) {
    defaultBackend = 'appium-xcuitest';
    reasons.push('iOS-only: Appium XCUITest');
  } else {
    defaultBackend = 'appium-uiautomator2';
    reasons.push('Android-only (or default): Appium UiAutomator2');
  }

  // ---- output mode ----
  const projectE2eDir = ['e2e', 'test/e2e', 'tests/e2e'].find((p) => exists(root, p));
  let outputMode: OutputMode = 'swipium_scaffold';
  if (inputs.integrateIntoProject && projectE2eDir) {
    outputMode = 'project_native';
    reasons.push(`integrateIntoProject + existing ${projectE2eDir}/ → project_native`);
  } else if (inputs.integrateIntoProject) {
    reasons.push('integrateIntoProject requested but no e2e/ dir found — writing to .swipium/automation and recommending a copy target');
  } else {
    reasons.push('default: write under .swipium/automation/<language> (no in-project mutation)');
  }

  return {
    projectRoot: root,
    appFramework: fw,
    platforms,
    primaryLanguage,
    automationLanguage,
    testFramework,
    existingAutomation,
    packageManager,
    outputMode,
    defaultBackend,
    secondaryBackend,
    reasons,
  };
}
