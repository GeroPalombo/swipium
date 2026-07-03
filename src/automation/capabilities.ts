// Automation Kernel V2 — Workstream 1: backend capability matrix. Pure functions that answer
// "what can this backend actually do?" before any device is touched. The planner (plan.ts) consumes
// these to classify each step as native / supported_with_fallback / visual_only / unsupported and to
// name the exact missing capability when something cannot run.
//
// Driver.kind values map to backends as: 'direct' → android-direct, 'simulator' → ios-raw-simulator,
// 'wda' → ios-wda, 'remote' → an Appium backend (uiautomator2 | xcuitest, disambiguated by session).

import type { AutomationBackend, SelectorStrategy } from './types.js';

export interface BackendCapabilities {
  backend: AutomationBackend;
  // Lifecycle / observation
  install: boolean;
  launch: boolean;
  terminate: boolean;
  openUrl: boolean;
  screenshot: boolean;
  logs: boolean;
  structuredTree: boolean;
  // Selector strategies
  nativeSelectors: boolean;
  resourceId: boolean;
  accessibilityId: boolean;
  iosPredicate: boolean;
  iosClassChain: boolean;
  textSelector: boolean;
  // Text input
  textInputAscii: boolean;
  textInputUnicode: boolean;
  clearText: boolean;
  // Gestures
  longPress: boolean;
  doubleTap: boolean;
  scrollUntilVisible: boolean;
  pinch: boolean;
  drag: boolean;
  // System / stability
  systemAlerts: boolean;
  appDeclaredIdling: boolean;
  wdaIdling: boolean;
  // Hybrid / web
  webviewContexts: boolean;
  // Capture / fallback
  screenRecording: boolean;
  visualFallback: boolean;
  ocrFallback: boolean;
  notes: string[];
}

/** Optional session evidence that refines an Appium backend's capability picture. */
export interface AppiumSessionHints {
  automationName?: string;
  platformName?: string;
  /** Whether the live Appium session has reported additional contexts beyond NATIVE_APP. */
  webviewContextsAvailable?: boolean;
  loopback?: boolean;
}

function base(backend: AutomationBackend): BackendCapabilities {
  return {
    backend,
    install: false,
    launch: false,
    terminate: false,
    openUrl: false,
    screenshot: false,
    logs: false,
    structuredTree: false,
    nativeSelectors: false,
    resourceId: false,
    accessibilityId: false,
    iosPredicate: false,
    iosClassChain: false,
    textSelector: false,
    textInputAscii: false,
    textInputUnicode: false,
    clearText: false,
    longPress: false,
    doubleTap: false,
    scrollUntilVisible: false,
    pinch: false,
    drag: false,
    systemAlerts: false,
    appDeclaredIdling: false,
    wdaIdling: false,
    webviewContexts: false,
    screenRecording: false,
    visualFallback: false,
    ocrFallback: false,
    notes: [],
  };
}

/** Map a Swipium Driver.kind (+ optional Appium session) to an automation backend identity. */
export function backendForDriverKind(kind: 'direct' | 'remote' | 'simulator' | 'wda', session?: AppiumSessionHints): AutomationBackend {
  switch (kind) {
    case 'direct':
      return 'android-direct';
    case 'simulator':
      return 'ios-raw-simulator';
    case 'wda':
      return 'ios-wda';
    case 'remote':
      return appiumBackendFromSession(session);
    default:
      return 'unknown';
  }
}

export function appiumBackendFromSession(session?: AppiumSessionHints): AutomationBackend {
  const name = (session?.automationName ?? '').toLowerCase();
  const platform = (session?.platformName ?? '').toLowerCase();
  // iOS evidence first (an XCUITest automationName or an iOS platform), then Android.
  if (name.includes('xcuitest') || platform.includes('ios')) return 'appium-xcuitest';
  // Android: infer UiAutomator2 from the driver name OR from Android platform evidence alone
  // (espresso also implies an Android session).
  if (name.includes('uiautomator2') || name.includes('espresso') || name.includes('android') || platform.includes('android'))
    return 'appium-uiautomator2';
  // Without driver/session evidence we cannot claim a concrete Appium driver family.
  return 'unknown';
}

export function backendCapabilities(backend: AutomationBackend, session?: AppiumSessionHints): BackendCapabilities {
  const c = base(backend);
  switch (backend) {
    case 'android-direct':
      // Android DirectDriver via adb + UI Automator dump: resource-id / text / accessibility tree,
      // ascii text input, basic gestures. No WebView context switching, no app-declared idle proof.
      Object.assign(c, {
        install: true,
        launch: true,
        terminate: true,
        openUrl: true,
        screenshot: true,
        logs: true,
        structuredTree: true,
        nativeSelectors: true,
        resourceId: true,
        accessibilityId: true,
        textSelector: true,
        textInputAscii: true,
        textInputUnicode: false,
        clearText: true,
        longPress: true,
        doubleTap: true,
        scrollUntilVisible: true,
        pinch: false,
        drag: true,
        systemAlerts: true,
        appDeclaredIdling: false,
        screenRecording: true,
        visualFallback: true,
        ocrFallback: true,
      });
      c.notes.push('Unicode text input is not safe on adb input; use a fixture-provided ASCII value or a stronger backend.');
      c.notes.push('No WebView context switching on the Android direct backend; attach Appium UiAutomator2 for hybrid contexts.');
      return c;
    case 'ios-raw-simulator':
      // simctl lifecycle + screenshot + deep links + visual/OCR only. NO structured taps/selectors.
      Object.assign(c, {
        install: true,
        launch: true,
        terminate: true,
        openUrl: true,
        screenshot: true,
        logs: true,
        structuredTree: false,
        nativeSelectors: false,
        screenRecording: true,
        visualFallback: true,
        ocrFallback: true,
      });
      c.notes.push('iOS raw simulator cannot run structured taps; attach WDA or Appium XCUITest for selector-based automation.');
      return c;
    case 'ios-wda':
      // WebDriverAgent / XCTest: accessibility id / name / predicate / class-chain, idle settings.
      Object.assign(c, {
        install: true,
        launch: true,
        terminate: true,
        openUrl: true,
        screenshot: true,
        logs: true,
        structuredTree: true,
        nativeSelectors: true,
        accessibilityId: true,
        iosPredicate: true,
        iosClassChain: true,
        textSelector: true,
        textInputAscii: true,
        textInputUnicode: true,
        clearText: true,
        longPress: true,
        doubleTap: true,
        scrollUntilVisible: true,
        pinch: false,
        drag: true,
        systemAlerts: true,
        wdaIdling: true,
        screenRecording: true,
        visualFallback: true,
        ocrFallback: true,
      });
      c.notes.push('iOS resource-id selectors do not exist; use accessibility id / name / predicate / class chain.');
      c.notes.push('Pinch/zoom is capability-gated until a tested WDA/Appium implementation exists.');
      return c;
    case 'appium-uiautomator2':
      Object.assign(c, {
        install: true,
        launch: true,
        terminate: true,
        openUrl: true,
        screenshot: true,
        logs: true,
        structuredTree: true,
        nativeSelectors: true,
        resourceId: true,
        accessibilityId: true,
        textSelector: true,
        textInputAscii: true,
        textInputUnicode: true,
        clearText: true,
        longPress: true,
        doubleTap: true,
        scrollUntilVisible: true,
        pinch: true,
        drag: true,
        systemAlerts: true,
        appDeclaredIdling: false,
        screenRecording: true,
        visualFallback: true,
        ocrFallback: true,
        // Web/hybrid potential is only claimed when the live session reports contexts.
        webviewContexts: session?.webviewContextsAvailable === true,
      });
      if (!c.webviewContexts)
        c.notes.push(
          'WebView contexts only available when the Appium session reports a non-native context; not claimed without session evidence.',
        );
      return c;
    case 'appium-xcuitest':
      Object.assign(c, {
        install: true,
        launch: true,
        terminate: true,
        openUrl: true,
        screenshot: true,
        logs: true,
        structuredTree: true,
        nativeSelectors: true,
        accessibilityId: true,
        iosPredicate: true,
        iosClassChain: true,
        textSelector: true,
        textInputAscii: true,
        textInputUnicode: true,
        clearText: true,
        longPress: true,
        doubleTap: true,
        scrollUntilVisible: true,
        pinch: true,
        drag: true,
        systemAlerts: true,
        wdaIdling: true,
        screenRecording: true,
        visualFallback: true,
        ocrFallback: true,
        webviewContexts: session?.webviewContextsAvailable === true,
      });
      c.notes.push(
        'XCUITest sessions expose WDA settings (snapshot depth, waitForIdleTimeout, reduceMotion); bind automation evidence to them.',
      );
      if (!c.webviewContexts)
        c.notes.push(
          'WebView contexts only available when the Appium session reports a non-native context; not claimed without session evidence.',
        );
      return c;
    case 'unknown':
    default:
      c.notes.push('Backend is unknown; attach a device/session so capabilities can be resolved.');
      return c;
  }
}

/** Whether a backend can target an element with the given selector strategy. */
export function selectorSupported(caps: BackendCapabilities, strategy: SelectorStrategy): boolean {
  switch (strategy) {
    case 'resource_id':
      return caps.resourceId;
    case 'accessibility_id':
      return caps.accessibilityId;
    case 'text':
      return caps.textSelector;
    case 'ios_predicate':
      return caps.iosPredicate;
    case 'ios_class_chain':
      return caps.iosClassChain;
    case 'ocr_text':
      return caps.ocrFallback;
    case 'image':
      return caps.visualFallback;
    case 'coordinate':
      // Any backend that can screenshot can be driven by coordinate as a last resort.
      return caps.screenshot;
    default:
      return false;
  }
}
