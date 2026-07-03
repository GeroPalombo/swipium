// Automation Kernel V2 — Workstream 7 (Stage 1): Hybrid / WebView awareness. Pure detection of
// probable WebView / canvas / map surfaces from UI-tree element classes, plus the diagnostics that
// tell a developer whether structured automation is possible or whether Appium context support (or a
// native accessibility id) is required. Stage 1 is detection + read-only Appium context inventory; it
// does NOT add arbitrary web JS execution.

import type { BackendCapabilities } from './capabilities.js';
import type { PlanDiagnostic, SelectorIR } from './types.js';

export type HybridSurfaceKind = 'webview' | 'canvas' | 'map';

export interface HybridSurface {
  kind: HybridSurfaceKind;
  signal: string; // the class/role that triggered the detection
}

export type WebViewDiagnosticCode = 'WEBVIEW_CONTEXT_AVAILABLE' | 'WEBVIEW_CONTEXT_MISSING' | 'WEBVIEW_VISUAL_ONLY' | 'NATIVE';

export interface HybridSurfaceReport {
  hybrid: boolean;
  surfaces: HybridSurface[];
  diagnostic: WebViewDiagnosticCode;
  appiumRequired: boolean;
  agentMessage: string;
}

// Class/role signals. Matching is case-insensitive substring so framework-prefixed classes still hit.
const WEBVIEW_SIGNALS = ['webview', 'wkwebview', 'uiwebview', 'org.chromium', 'xwalk', 'xcuielementtypewebview', 'rctwebview'];
const CANVAS_SIGNALS = ['surfaceview', 'textureview', 'glsurfaceview', 'flutterview', 'unityplayer', 'canvas'];
const MAP_SIGNALS = ['mapview', 'com.google.android.maps', 'mkmapview', 'gmsmapview'];

interface ElementLike {
  role?: string;
  className?: string;
}

function classify(value: string): HybridSurfaceKind | null {
  const v = value.toLowerCase();
  if (WEBVIEW_SIGNALS.some((s) => v.includes(s))) return 'webview';
  if (MAP_SIGNALS.some((s) => v.includes(s))) return 'map';
  if (CANVAS_SIGNALS.some((s) => v.includes(s))) return 'canvas';
  return null;
}

export interface DetectHybridOptions {
  /** Appium contexts reported by a live session (e.g. ['NATIVE_APP', 'WEBVIEW_com.x']). */
  contexts?: string[];
  /** Backend capabilities — used to decide whether Appium context switching is even possible. */
  caps?: BackendCapabilities;
  /** How often steps fell back to visual-only on this screen (a soft hybrid signal). */
  visualFallbackRatio?: number;
}

/** Detect probable hybrid surfaces from a parsed UI tree and emit the right diagnostic. */
export function detectHybridSurface(elements: ElementLike[], opts: DetectHybridOptions = {}): HybridSurfaceReport {
  const surfaces: HybridSurface[] = [];
  for (const el of elements) {
    for (const value of [el.className, el.role]) {
      if (!value) continue;
      const kind = classify(value);
      if (kind && !surfaces.some((s) => s.kind === kind && s.signal === value)) {
        surfaces.push({ kind, signal: value });
      }
    }
  }
  // A high visual-fallback ratio with no structured matches is a soft hybrid/canvas signal.
  const softHybrid = surfaces.length === 0 && (opts.visualFallbackRatio ?? 0) >= 0.5;
  const hybrid = surfaces.length > 0 || softHybrid;

  if (!hybrid) {
    return {
      hybrid: false,
      surfaces,
      diagnostic: 'NATIVE',
      appiumRequired: false,
      agentMessage: 'This screen looks like a native UI tree; structured selectors should work.',
    };
  }

  const hasWebview = surfaces.some((s) => s.kind === 'webview') || softHybrid;
  const nonNativeContexts = (opts.contexts ?? []).filter((c) => !/^native_app$/i.test(c));
  const contextSwitchingPossible = !!opts.caps?.webviewContexts;

  if (hasWebview && nonNativeContexts.length > 0) {
    return {
      hybrid: true,
      surfaces,
      diagnostic: 'WEBVIEW_CONTEXT_AVAILABLE',
      appiumRequired: false,
      agentMessage: `This screen is hybrid (WebView). Appium reports ${nonNativeContexts.length} web context(s) (${nonNativeContexts.join(', ')}); structural web automation is possible by switching context.`,
    };
  }

  if (hasWebview && contextSwitchingPossible) {
    return {
      hybrid: true,
      surfaces,
      diagnostic: 'WEBVIEW_CONTEXT_MISSING',
      appiumRequired: true,
      agentMessage:
        'This screen looks like a WebView. The backend can switch contexts, but none are currently reported; attach the WebView context or use a native accessibility id, otherwise only visual candidate evidence is possible.',
    };
  }

  return {
    hybrid: true,
    surfaces,
    diagnostic: 'WEBVIEW_VISUAL_ONLY',
    appiumRequired: true,
    agentMessage:
      'This screen looks like a WebView. I need Appium context support or a native accessibility id to automate it structurally; otherwise I can only produce visual candidate evidence.',
  };
}

export interface AppiumContextInventory {
  current: string | null;
  available: string[];
  webviewContexts: string[];
}

/** Read-only Appium context inventory (Stage 2 deliverable — no arbitrary JS execution). */
export function summarizeAppiumContexts(contexts: string[], current?: string | null): AppiumContextInventory {
  const webviewContexts = contexts.filter((c) => !/^native_app$/i.test(c));
  return { current: current ?? null, available: [...contexts], webviewContexts };
}

/** An actionable blocker for a structured step that targets a WebView-only surface. */
export function webviewSelectorBlocker(selector: SelectorIR): PlanDiagnostic {
  return {
    code: 'WEBVIEW_VISUAL_ONLY',
    detail: `Selector ${selector.strategy}=${selector.value} targets a WebView surface that the current backend cannot reach structurally.`,
    nextStep:
      'This screen looks like a WebView. I need Appium context support or a native accessibility id to automate it structurally; otherwise I can only produce visual candidate evidence.',
  };
}
