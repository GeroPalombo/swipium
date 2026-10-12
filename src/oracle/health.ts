// Tier-1 deterministic health oracle. Phase 2.2: classifies BOTH layers:
// NATIVE health (process: crash dialog / ANR / wrong foreground) and APP health (JS/UI:
// RN RedBox / LogBox error / error-boundary fallback / WebView error). A green native
// process with a broken app UI (e.g. an ErrorBoundary screen) is now a first-class finding,
// so agents don't have to infer "healthy process but broken app" from raw snapshot text.

import type { Driver } from '../drivers/Driver.js';
import { parseSnapshot, type RawNode } from '../snapshot/parse.js';
import { isAbortError } from '../lib/abortScope.js';
import { isDeviceGoneError } from '../lib/deviceGone.js';

export type HealthLayer = 'native' | 'app';

export interface Finding {
  severity: 'high' | 'medium' | 'info';
  kind: string;
  detail: string;
  layer?: HealthLayer;
  evidence?: string; // the visible on-screen text that matched (caller redacts before emit)
  screenshotUri?: string; // attached by the caller when it captures error evidence
  logUri?: string; // crash/ANR log excerpt attached by the caller (oracle/record.ts)
}

export type NativeStatus = 'ok' | 'native_crash' | 'anr' | 'wrong_foreground_app' | 'wda_unreachable' | 'device_offline';
export type AppStatus = 'ok' | 'degraded' | 'error';

export interface HealthResult {
  healthy: boolean; // no high-severity finding in EITHER layer (kept for back-compat)
  nativeHealthy: boolean;
  appHealthy: boolean;
  nativeStatus: NativeStatus;
  appStatus: AppStatus; // ok | degraded (recoverable) | error (broken UI)
  foreground: string;
  findings: Finding[];
  /** The check was CANCELLED (the call/job was aborted while dumping): no verdict, no findings;
   *  callers must not record anything from it (lib/abortScope.ts isAbortError). */
  cancelled?: boolean;
  /** The bound device is gone (emulator killed / simulator shut down): NO verdict about the app.
   *  healthy=false so nobody reads it as OK; no findings (the app is not to blame). Callers
   *  surface NO_DEVICE (lib/deviceGone.ts). */
  deviceGone?: boolean;
}

/** The verdict-free result of a health check on a device that is no longer online. */
function deviceGoneHealth(): HealthResult {
  return {
    healthy: false,
    nativeHealthy: false,
    appHealthy: false,
    nativeStatus: 'device_offline',
    appStatus: 'ok',
    foreground: 'unknown',
    findings: [],
    deviceGone: true,
  };
}

/** The verdict-free result of a cancelled health check. */
function cancelledHealth(): HealthResult {
  return {
    healthy: true,
    nativeHealthy: true,
    appHealthy: true,
    nativeStatus: 'ok',
    appStatus: 'ok',
    foreground: 'unknown',
    findings: [],
    cancelled: true,
  };
}

/** Detail of the RedBox variant that means "the debug build could not fetch its JS bundle". */
export const RN_BUNDLE_LOAD_DETAIL = 'RN RedBox: JS bundle failed to load (Metro/bundle issue)';
/** Detail of the Expo dev-client launcher surface (the app's JS was never loaded). */
export const EXPO_DEV_LAUNCHER_DETAIL =
  'Expo dev-client launcher is showing ("No development servers found"): the app JS never loaded. Connect the dev client to a running Metro.';

// APP-layer surfaces (JS/UI). Order matters: the first fatal RedBox variant wins over LogBox.
// Android AND iOS wording: the iOS RedBox says "No script URL provided … packager is running"
// (no bundle) and carries ids redbox-error / redbox-dismiss / redbox-reload (WDA: redboxDismiss);
// the Android one carries catalyst_redbox_title / rn_redbox_* ids.
const APP_SURFACES: Array<{ re: RegExp; kind: string; severity: 'high' | 'medium'; detail: string }> = [
  {
    re: /unable to load script|could not connect to development server|loadJSBundleFromAssets|index\.android\.bundle|no script url provided|unsanitizedScriptURLString|make sure the packager is running|you have embedded a JS bundle|could not connect to the server.{0,40}8081/i,
    kind: 'rn_redbox',
    severity: 'high',
    detail: RN_BUNDLE_LOAD_DETAIL,
  },
  {
    re: /no development servers found|fetch development servers|enter url manually|expo-dev-launcher|EXDevLauncher/i,
    kind: 'expo_dev_launcher',
    severity: 'high',
    detail: EXPO_DEV_LAUNCHER_DETAIL,
  },
  {
    re: /unhandled (js|javascript) exception|invariant violation|TypeError:|ReferenceError|undefined is not an object|is not a function|EarlyJsError|\[runtime not ready\]|cannot find native module|unable to resolve module|requiring unknown module|TurboModuleRegistry\.getEnforcing|property '[^']{1,80}' doesn.?t exist|catalyst_redbox_title|rn_redbox_(dismiss|reload|stack|title)|redbox-(error|dismiss|reload|stack)|redbox(Dismiss|Reload|Error)\b/i,
    kind: 'rn_redbox',
    severity: 'high',
    detail: 'RN RedBox: unhandled JS exception',
  },
  {
    // Expo's fatal screens when the JS entry threw before registering (SDK 50+ "App entry not
    // found"), the RN "has not been registered" invariant, a native-module HostObject failure at
    // load, and the Expo Go / dev-client "problem loading the project" error screen.
    re: /app entry not found|entry point named .{1,40} (?:was|has) not (?:been )?registered|["'][\w.-]{1,40}["'] has not been registered|exception in HostObject::get|unable to parse @ReactMethod|there was a problem (?:loading|running) the (?:project|requested app)/i,
    kind: 'rn_redbox',
    severity: 'high',
    detail: 'Expo/RN fatal error screen: the app JS crashed at load (entry point not registered)',
  },
  {
    re: /we encountered an error|something went wrong|this screen (crashed|encountered)|oops[!,. ].{0,40}(wrong|error|crash)/i,
    kind: 'app_error_boundary',
    severity: 'high',
    detail: 'app ErrorBoundary fallback UI (process alive, screen broken)',
  },
  {
    re: /net::ERR_|webpage not available|this site can.?t be reached|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i,
    kind: 'webview_error',
    severity: 'medium',
    detail: 'WebView error page',
  },
  {
    re: /console error|\b[1-9]\d* errors?\b/i,
    kind: 'rn_logbox_error',
    severity: 'medium',
    detail: 'RN LogBox error overlay (app running but logging errors)',
  },
];

/** A finding that means "this debug RN/Expo build has no JS bundle" (bundle-load RedBox or the
 *  Expo dev-client launcher): an environment blocker (METRO_REQUIRED), not an app regression. */
export function isMetroRequiredFinding(f: Pick<Finding, 'kind' | 'detail'>): boolean {
  return (f.kind === 'rn_redbox' && f.detail === RN_BUNDLE_LOAD_DETAIL) || f.kind === 'expo_dev_launcher';
}

/** E2E NEW-17: the RN/Expo launch error screen (RedBox, either variant, the Expo load-time fatal
 *  screen or the dev launcher) in a tree the caller already read, with no device call. Used by
 *  qa_prepare_* and qa_screenshot so a launch onto a RedBox never reads as plain "ready". */
export function launchErrorSurface(nodes: ReadonlyArray<Pick<RawNode, 'text' | 'desc' | 'cls' | 'id'>>): Finding | undefined {
  const hn: HealthNode[] = nodes.map((n) => ({ text: n.text, desc: n.desc, cls: n.cls, id: n.id }));
  const joined = hn.map((n) => `${n.text} ${n.desc} ${n.cls ?? ''} ${n.id ?? ''}`).join('  ');
  const s = APP_SURFACES.find((x) => (x.kind === 'rn_redbox' || x.kind === 'expo_dev_launcher') && x.re.test(joined));
  return s ? { severity: s.severity, layer: 'app', kind: s.kind, detail: s.detail, evidence: firstMatch(hn, s.re) } : undefined;
}

// A conservative last-resort generic error surface (only when nothing more specific matched).
const GENERIC_ERROR_RE = /failed to load|couldn.?t load|an error (occurred|has occurred)|no internet connection|please try again/i;

// Foreground owners that are genuine SYSTEM surfaces (not "the user left the app"): SystemUI
// (shade, crash/ANR dialogs host), the IME, package installer, the chooser/resolver (package
// `android` / intentresolver) and other framework-internal activities. Matched on the PACKAGE.
const SYSTEM_SURFACE_RE =
  /^(?:android|com\.android\.systemui|com\.android\.packageinstaller|com\.google\.android\.packageinstaller|com\.android\.intentresolver|com\.android\.internal\.[\w.]+)(?:\/|$)|inputmethod|com\.android\.internal\.app\./i;

// NATIVE-layer dialogs (process-level).
const ANR_RE = /isn['’]t responding|application not responding/i;
const CRASH_RE = /keeps stopping|has stopped|unfortunately/i;

type HealthNode = { text: string; desc: string; cls?: string; id?: string };

function firstMatch(nodes: HealthNode[], re: RegExp): string | undefined {
  for (const n of nodes) {
    const t = `${n.text} ${n.desc} ${n.cls ?? ''} ${n.id ?? ''}`.trim();
    if (re.test(t)) return (n.text || n.desc).trim().slice(0, 160);
  }
  return undefined;
}

/** The package that owns the dumped window (Android uiautomator root `package=`), or undefined. */
export function dumpRootPackage(nodes: ReadonlyArray<Pick<RawNode, 'attrs'>> | undefined): string | undefined {
  const pkg = nodes?.[0]?.attrs?.package;
  return pkg ? pkg : undefined;
}

/**
 * Health check. `opts.nodes` = the ALREADY-PARSED allNodes of `xml` (callers that just parsed the
 * post-action dump pass them). Re-parsing a big screen cost ~60 ms per action.
 *
 * Foreground: on Android the dump's root `package=` already says which app owns the window. When
 * it IS the app under test and no crash/ANR copy is on screen, the heavy `dumpsys activity
 * activities` (foregroundOwner) is skipped (foreground = the package); it still runs whenever the
 * caller did not supply the dump, the root package differs from appId, is absent (WDA / older
 * dumps), or a crash/ANR pattern matched.
 */
export async function checkHealth(driver: Driver, appId?: string, xml?: string, opts: { nodes?: RawNode[] } = {}): Promise<HealthResult> {
  let source = xml;
  let dumpAborted = false;
  let dumpError: unknown;
  if (source === undefined)
    source = await driver.dumpXml().catch((e) => {
      dumpAborted = isAbortError(e);
      dumpError = e;
      return '';
    });
  // Cancelled work is not evidence: an aborted dump (or a check whose call/job was cancelled) must
  // never become a `wda_unreachable` finding / BLOCK verdict.
  if (dumpAborted || isAbortError(undefined)) return cancelledHealth();
  // A dead device is not "healthy" (empty dump + unknown foreground used to read as OK).
  if (isDeviceGoneError(dumpError)) return deviceGoneHealth();

  // Parse to nodes so evidence is the VISIBLE text (not attribute names). Best-effort.
  let raw: RawNode[] | undefined = opts.nodes;
  if (!raw) {
    try {
      raw = parseSnapshot(source).allNodes;
    } catch {
      raw = [];
    }
  }
  const nodes: HealthNode[] = raw.map((n) => ({ text: n.text, desc: n.desc, cls: n.cls, id: n.id }));
  const joined = nodes.map((n) => `${n.text} ${n.desc} ${n.cls ?? ''} ${n.id ?? ''}`).join('  ') || source;

  const rootPkg = dumpRootPackage(raw);
  // Only on the post-action path (caller supplied the dump): a standalone health check (no xml)
  // keeps the full dumpsys answer, which also names the resumed activity.
  const trustRoot = xml !== undefined && !!appId && rootPkg === appId && !ANR_RE.test(joined) && !CRASH_RE.test(joined);
  const foreground = trustRoot ? rootPkg! : await driver.foregroundOwner().catch(() => 'unknown');
  if (isAbortError(undefined)) return cancelledHealth();

  const findings: Finding[] = [];

  // ---- NATIVE layer ----
  let nativeStatus: NativeStatus = 'ok';
  if (driver.kind === 'wda' && !source) {
    findings.push({ severity: 'high', layer: 'native', kind: 'wda_unreachable', detail: 'WebDriverAgent did not return a UI source' });
    nativeStatus = 'wda_unreachable';
  }
  if (ANR_RE.test(joined)) {
    findings.push({
      severity: 'high',
      layer: 'native',
      kind: 'anr',
      detail: 'Application Not Responding dialog',
      evidence: firstMatch(nodes, ANR_RE),
    });
    nativeStatus = 'anr';
  } else if (CRASH_RE.test(joined)) {
    findings.push({
      severity: 'high',
      layer: 'native',
      kind: 'native_crash',
      detail: 'native crash dialog',
      evidence: firstMatch(nodes, CRASH_RE),
    });
    nativeStatus = 'native_crash';
  }

  if (driver.kind === 'wda') {
    const springboard = /SpringBoard|XCUIElementTypeApplication[^]*com\.apple\.springboard/i.test(joined);
    const alert = /XCUIElementTypeAlert/i.test(joined);
    const permission = /would like to|allow|don.?t allow|while using|permission/i.test(joined) && alert;
    if (springboard) {
      findings.push({
        severity: 'high',
        layer: 'native',
        kind: 'wrong_foreground_app',
        detail: 'iOS SpringBoard is foreground (app not active or crashed)',
        evidence: firstMatch(nodes, /SpringBoard/i),
      });
      if (nativeStatus === 'ok') nativeStatus = 'wrong_foreground_app';
    } else if (permission) {
      findings.push({
        severity: 'medium',
        layer: 'native',
        kind: 'permission_dialog',
        detail: 'iOS runtime permission dialog is visible',
        evidence: firstMatch(nodes, /would like to|allow|don.?t allow|while using|permission/i),
      });
    } else if (alert) {
      findings.push({
        severity: 'medium',
        layer: 'native',
        kind: 'native_alert',
        detail: 'iOS native alert is visible',
        evidence: firstMatch(nodes, /.+/),
      });
    }
  }

  if (appId && !foreground.startsWith(appId) && foreground !== 'unknown') {
    if (/launcher/i.test(foreground)) {
      findings.push({
        severity: 'high',
        layer: 'native',
        kind: 'wrong_foreground_app',
        detail: `app left to the launcher (possible crash), foreground=${foreground}`,
      });
      if (nativeStatus === 'ok') nativeStatus = 'wrong_foreground_app';
    } else if (/permissioncontroller/i.test(foreground)) {
      findings.push({
        severity: 'medium',
        layer: 'native',
        kind: 'permission_dialog',
        detail: `Android runtime permission dialog is visible, foreground=${foreground}`,
      });
    } else if (SYSTEM_SURFACE_RE.test(foreground)) {
      // Real system surfaces only (status bar / notification shade, IME, installer, chooser,
      // system dialogs). NOT every com.android.* package: Settings / Chrome are user-facing apps.
      findings.push({ severity: 'info', layer: 'native', kind: 'system_surface', detail: foreground });
    } else {
      // Another app is in front. Android: is ours still alive, and is the foreign activity part of
      // OUR task (e.g. Settings search = settings.intelligence started inside the Settings task)?
      const android = driver.kind === 'direct' || driver.kind === 'remote';
      const alive = android ? await driver.isRunning(appId).catch(() => undefined) : undefined;
      const taskRoot = android && alive !== false ? await driver.foregroundTaskRoot?.().catch(() => undefined) : undefined;
      if (alive === false) {
        findings.push({
          severity: 'high',
          layer: 'native',
          kind: 'wrong_foreground_app',
          detail: `app process is gone and another app is in front (possible crash), foreground=${foreground}`,
        });
        if (nativeStatus === 'ok') nativeStatus = 'wrong_foreground_app';
      } else if (taskRoot && (taskRoot === appId || taskRoot.startsWith(`${appId}.`))) {
        findings.push({
          severity: 'info',
          layer: 'native',
          kind: 'foreign_activity_in_app_task',
          detail: `another package's activity is showing inside the app's own task (task root ${taskRoot}), foreground=${foreground}`,
        });
      } else {
        findings.push({
          severity: 'medium',
          layer: 'native',
          kind: 'wrong_foreground_app',
          detail: `foreground is a different app, foreground=${foreground}`,
        });
        if (nativeStatus === 'ok') nativeStatus = 'wrong_foreground_app';
      }
    }
  }

  // ---- APP layer (only meaningful while OUR app owns the foreground) ----
  const appInForeground = !appId || foreground.startsWith(appId) || driver.kind === 'wda';
  let appStatus: AppStatus = 'ok';
  if (appInForeground) {
    let matched = false;
    for (const s of APP_SURFACES) {
      if (s.re.test(joined)) {
        findings.push({ severity: s.severity, layer: 'app', kind: s.kind, detail: s.detail, evidence: firstMatch(nodes, s.re) });
        appStatus = s.severity === 'high' ? 'error' : appStatus === 'error' ? 'error' : 'degraded';
        matched = true;
        // RedBox/error-boundary are terminal for the screen; don't also report lesser surfaces.
        if (s.severity === 'high') break;
      }
    }
    if (!matched && GENERIC_ERROR_RE.test(joined)) {
      findings.push({
        severity: 'medium',
        layer: 'app',
        kind: 'unknown_error_surface',
        detail: 'generic error copy on screen (low confidence)',
        evidence: firstMatch(nodes, GENERIC_ERROR_RE),
      });
      appStatus = 'degraded';
    }
  }

  const nativeHealthy = !findings.some((f) => f.layer === 'native' && f.severity === 'high');
  const appHealthy = appStatus === 'ok';
  return {
    healthy: !findings.some((f) => f.severity === 'high'),
    nativeHealthy,
    appHealthy,
    nativeStatus,
    appStatus,
    foreground,
    findings,
  };
}
