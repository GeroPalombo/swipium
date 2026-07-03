// Tier-1 deterministic health oracle (DESIGN §6). Phase 2.2: classifies BOTH layers —
// NATIVE health (process: crash dialog / ANR / wrong foreground) and APP health (JS/UI:
// RN RedBox / LogBox error / error-boundary fallback / WebView error). A green native
// process with a broken app UI (e.g. an ErrorBoundary screen) is now a first-class finding,
// so agents don't have to infer "healthy process but broken app" from raw snapshot text.

import type { Driver } from '../drivers/Driver.js';
import { parseSnapshot } from '../snapshot/parse.js';

export type HealthLayer = 'native' | 'app';

export interface Finding {
  severity: 'high' | 'medium' | 'info';
  kind: string;
  detail: string;
  layer?: HealthLayer;
  evidence?: string; // the visible on-screen text that matched (caller redacts before emit)
  screenshotUri?: string; // attached by the caller when it captures error evidence
}

export type NativeStatus = 'ok' | 'native_crash' | 'anr' | 'wrong_foreground_app' | 'wda_unreachable';
export type AppStatus = 'ok' | 'degraded' | 'error';

export interface HealthResult {
  healthy: boolean; // no high-severity finding in EITHER layer (kept for back-compat)
  nativeHealthy: boolean;
  appHealthy: boolean;
  nativeStatus: NativeStatus;
  appStatus: AppStatus; // ok | degraded (recoverable) | error (broken UI)
  foreground: string;
  findings: Finding[];
}

// APP-layer surfaces (JS/UI). Order matters: the first fatal RedBox variant wins over LogBox.
const APP_SURFACES: Array<{ re: RegExp; kind: string; severity: 'high' | 'medium'; detail: string }> = [
  {
    re: /unable to load script|could not connect to development server|loadJSBundleFromAssets|index\.android\.bundle/i,
    kind: 'rn_redbox',
    severity: 'high',
    detail: 'RN RedBox — JS bundle failed to load (Metro/bundle issue)',
  },
  {
    re: /unhandled (js|javascript) exception|invariant violation|TypeError:|ReferenceError|undefined is not an object|is not a function/i,
    kind: 'rn_redbox',
    severity: 'high',
    detail: 'RN RedBox — unhandled JS exception',
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

// A conservative last-resort generic error surface (only when nothing more specific matched).
const GENERIC_ERROR_RE = /failed to load|couldn.?t load|an error (occurred|has occurred)|no internet connection|please try again/i;

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

export async function checkHealth(driver: Driver, appId?: string, xml?: string): Promise<HealthResult> {
  const foreground = await driver.foregroundOwner().catch(() => 'unknown');
  let source = xml;
  if (source === undefined) source = await driver.dumpXml().catch(() => '');

  // Parse to nodes so evidence is the VISIBLE text (not attribute names) — best-effort.
  let nodes: HealthNode[] = [];
  try {
    nodes = parseSnapshot(source).allNodes.map((n) => ({ text: n.text, desc: n.desc, cls: n.cls, id: n.id }));
  } catch {
    nodes = [];
  }
  const joined = nodes.map((n) => `${n.text} ${n.desc} ${n.cls ?? ''} ${n.id ?? ''}`).join('  ') || source;

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
        detail: `app left to the launcher (possible crash) — foreground=${foreground}`,
      });
      if (nativeStatus === 'ok') nativeStatus = 'wrong_foreground_app';
    } else if (/permissioncontroller/i.test(foreground)) {
      findings.push({
        severity: 'medium',
        layer: 'native',
        kind: 'permission_dialog',
        detail: `Android runtime permission dialog is visible — foreground=${foreground}`,
      });
    } else if (/packageinstaller|systemui|com\.android\.|inputmethod/i.test(foreground)) {
      findings.push({ severity: 'info', layer: 'native', kind: 'system_surface', detail: foreground });
    } else {
      findings.push({
        severity: 'medium',
        layer: 'native',
        kind: 'wrong_foreground_app',
        detail: `foreground is a different app — foreground=${foreground}`,
      });
      if (nativeStatus === 'ok') nativeStatus = 'wrong_foreground_app';
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
        // RedBox/error-boundary are terminal for the screen — don't also report lesser surfaces.
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
