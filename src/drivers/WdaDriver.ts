import type { Driver, NativeSelectorStrategy } from './Driver.js';
import * as sim from '../lib/simctl.js';
import { parseSnapshot } from '../snapshot/parse.js';
import {
  acceptWdaAlert,
  clearWdaElement,
  clearWdaFocusedByKeys,
  createWdaSession,
  deleteWdaSession,
  dismissWdaAlert,
  dismissWdaKeyboard,
  isInvalidWdaSession,
  wdaKeyboardFrame,
  wdaKeyboardShown,
  wdaOrientation,
  withWdaCall,
  dragWdaPoint,
  findFocusedWdaElement,
  findWdaElement,
  normalizeWdaSource,
  pressWdaHome,
  tapWdaElement,
  tapWdaPoint,
  typeWdaElement,
  typeWdaKeys,
  wdaActiveAppInfo,
  wdaElementAttribute,
  wdaScreenshot,
  wdaSessionUdidMismatch,
  wdaSource,
  wdaWindowSize,
  type WdaSessionOptions,
} from '../lib/wda.js';

const UNSUPPORTED = 'not supported by the WDA backend yet.';
export type WdaTimingKind = 'session_create' | 'source' | 'find_element' | 'tap' | 'type' | 'clear' | 'screenshot';

type SimulatorControl = Pick<typeof sim, 'launchApp' | 'terminateApp' | 'openUrl' | 'simulatorLogs'> & {
  isInstalled?: typeof sim.isInstalled;
  installApp?: typeof sim.installApp;
  uninstallApp?: typeof sim.uninstallApp;
  launchAppWithArgs?: typeof sim.launchAppWithArgs;
};

function tailLines(text: string, lines: number): string {
  const all = text.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

function errorSummary(e: unknown): string {
  return String((e as Error)?.message ?? e)
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

/** PURE: where iOS "back" is on this screen — the center of the navigation bar's back button in a
 * (normalized) WDA source, or null. The back button is the FIRST XCUIElementTypeButton inside the
 * first XCUIElementTypeNavigationBar, and only when it sits in the bar's LEFT half — a root screen's
 * bar can hold only trailing buttons ("Edit", "+"), which are not back. */
export function iosBackButtonPoint(normalizedXml: string): { x: number; y: number } | null {
  const nodes = parseSnapshot(normalizedXml).allNodes;
  const bar = nodes.find((n) => /XCUIElementTypeNavigationBar$/.test(n.cls));
  if (!bar) return null;
  const btn = nodes.find(
    (n) =>
      n.dfs > bar.dfs &&
      n.dfs <= bar.subtreeEnd &&
      /XCUIElementTypeButton$/.test(n.cls) &&
      n.enabled &&
      n.bounds[2] > n.bounds[0] &&
      n.bounds[3] > n.bounds[1],
  );
  if (!btn) return null;
  const x = Math.round((btn.bounds[0] + btn.bounds[2]) / 2);
  const y = Math.round((btn.bounds[1] + btn.bounds[3]) / 2);
  const barMid = (bar.bounds[0] + bar.bounds[2]) / 2;
  return x < barMid ? { x, y } : null;
}

/** Thrown (message prefix) when iOS has no way to go "back" on the current screen. */
export const IOS_BACK_UNSUPPORTED =
  'BACKEND_UNSUPPORTED: iOS has no system back key — no navigation-bar back button was found and the screen size needed for an edge-swipe back gesture is unknown.';

export class WdaDriver implements Driver {
  readonly kind = 'wda' as const;
  readonly baseUrl: string;
  private readonly simulator: SimulatorControl;
  private udid?: string;
  private sessionId?: string;
  private bundleId?: string;
  private readonly capabilities?: Record<string, unknown>;
  /** Every session this driver creates re-uses the running app (restart rebind). */
  private readonly reuseRunningApp: boolean;
  private readonly settings?: Record<string, unknown>;
  private readonly onTiming?: (kind: WdaTimingKind, durationMs: number) => void;
  private signal?: AbortSignal;

  constructor(
    baseUrl: string,
    opts: WdaSessionOptions & {
      sessionId?: string;
      simulator?: SimulatorControl;
      onTiming?: (kind: WdaTimingKind, durationMs: number) => void;
    } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.simulator = opts.simulator ?? sim;
    this.udid = opts.udid;
    this.sessionId = opts.sessionId;
    this.bundleId = opts.bundleId;
    this.capabilities = opts.capabilities;
    this.reuseRunningApp = opts.reuseRunningApp === true;
    this.settings = opts.settings;
    this.onTiming = opts.onTiming;
  }

  private async timed<T>(kind: WdaTimingKind, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.onTiming?.(kind, Date.now() - started);
    }
  }

  /** Bind an AbortSignal so a cancelled job aborts in-flight WDA HTTP requests. */
  setSignal(signal?: AbortSignal): void {
    this.signal = signal;
  }

  /** Set when a session was transparently re-created after "invalid session id" (WDA restart /
   * session reaped). Callers may surface it as a warning via consumeSessionRecovered(). */
  private sessionRecovered = false;

  /** Returns (and clears) whether the last operations ran on a re-created WDA session. */
  consumeSessionRecovered(): boolean {
    const v = this.sessionRecovered;
    this.sessionRecovered = false;
    return v;
  }

  /** Run a session-scoped WDA operation with the bound signal + per-endpoint timeouts. On
   * "invalid session id" (WDA restarted / session reaped) the cached session is dropped and
   * the operation retried ONCE on a fresh session — the failed request never acted. The fresh
   * session is created with forceAppLaunch:false + shouldTerminateApp:false (reuseRunningApp) so
   * WDA does NOT terminate + relaunch the app under test (WebDriverAgent FBSessionCommands: when
   * `bundleId` is passed, `forceAppLaunch` defaults to YES and a running app is relaunched; with
   * NO a running app is left as-is and a backgrounded one is only activated). */
  private async withSession<T>(fn: (sid: string) => Promise<T>): Promise<T> {
    return withWdaCall({ signal: this.signal }, async () => {
      const sid = await this.ensureSession();
      try {
        return await fn(sid);
      } catch (e) {
        if (!isInvalidWdaSession(e)) throw e;
        this.sessionId = undefined;
        this.cachedScreenSize = undefined;
        const fresh = await this.ensureSession({ recover: true });
        this.sessionRecovered = true;
        return fn(fresh);
      }
    });
  }

  private async ensureSession(opts: { recover?: boolean } = {}): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const s = await this.timed('session_create', () =>
      createWdaSession(this.baseUrl, {
        bundleId: this.bundleId,
        udid: this.udid,
        capabilities: this.capabilities,
        settings: this.settings,
        reuseRunningApp: this.reuseRunningApp || opts.recover === true,
      }),
    );
    const mismatchedUdid = wdaSessionUdidMismatch(s.capabilities, this.udid);
    if (mismatchedUdid) {
      throw new Error(`STALE_WDA_DEVICE: WDA session is bound to ${mismatchedUdid}, not requested device ${this.udid}.`);
    }
    this.sessionId = s.sessionId;
    return s.sessionId;
  }

  private no(op: string): Promise<never> {
    return Promise.reject(new Error(`${op} ${UNSUPPORTED}`));
  }

  listDevices(): Promise<string[]> {
    return Promise.resolve(this.udid ? [this.udid] : []);
  }
  useDevice(serial: string): void {
    this.udid = serial;
  }
  currentDevice(): string | undefined {
    return this.udid;
  }
  currentSession(): string | undefined {
    return this.sessionId;
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = undefined;
    await deleteWdaSession(this.baseUrl, sid);
  }

  async installApp(appPath: string): Promise<void> {
    if (!this.udid || !this.simulator.installApp) return this.no('app install');
    await this.simulator.installApp(this.udid, appPath);
  }
  async uninstallApp(pkg: string): Promise<void> {
    if (!this.udid || !this.simulator.uninstallApp) return this.no('app uninstall');
    await this.simulator.uninstallApp(this.udid, pkg);
  }
  async isInstalled(pkg: string): Promise<boolean> {
    const target = pkg || this.bundleId;
    if (!target) return false;
    if (this.udid && this.simulator.isInstalled) {
      return this.simulator.isInstalled(this.udid, target);
    }
    try {
      const info = await wdaActiveAppInfo(this.baseUrl, this.sessionId ?? 'current');
      return info.bundleId === target;
    } catch {
      return false;
    }
  }
  async isRunning(pkg: string): Promise<boolean> {
    const target = pkg || this.bundleId;
    if (!target) return false;
    try {
      const info = await wdaActiveAppInfo(this.baseUrl, this.sessionId ?? 'current');
      return info.bundleId === target;
    } catch {
      return false;
    }
  }
  async launchApp(pkg: string): Promise<void> {
    this.bundleId = pkg;
    if (this.udid) {
      await this.simulator.launchApp(this.udid, pkg);
    }
    await this.ensureSession();
  }
  async launchAppWithArgs(pkg: string, args: Record<string, unknown>): Promise<void> {
    this.bundleId = pkg;
    if (this.udid && this.simulator.launchAppWithArgs) {
      await this.simulator.launchAppWithArgs(this.udid, pkg, args);
    } else if (Object.keys(args).length) {
      return this.no('launch arguments');
    }
    await this.ensureSession();
  }
  async terminateApp(pkg: string): Promise<void> {
    const target = pkg || this.bundleId;
    if (!this.udid || !target) return this.no('app terminate');
    await this.simulator.terminateApp(this.udid, target);
  }
  clearData(): Promise<void> {
    return this.no('clear app data');
  }
  /** Keyboard shown? A single find-by-class-name call (XCUIElementTypeKeyboard). */
  async imeShown(): Promise<boolean> {
    return this.withSession((sid) => wdaKeyboardShown(this.baseUrl, sid));
  }
  async imeFrame(): Promise<[number, number, number, number] | null> {
    return this.withSession((sid) => wdaKeyboardFrame(this.baseUrl, sid));
  }
  async hideKeyboard(): Promise<boolean> {
    return this.withSession(async (sid) => {
      if (!(await wdaKeyboardShown(this.baseUrl, sid))) return false;
      try {
        await dismissWdaKeyboard(this.baseUrl, sid);
      } catch (e) {
        if (isInvalidWdaSession(e)) throw e; // let withSession recover the session
        // WDA 400 "Did not know how to dismiss the keyboard" — the app offers no generic way
        // (no Done/Return-dismiss). Report "could not hide" instead of an untyped error.
        return false;
      }
      return true;
    });
  }
  async logcat(lines = 200, grep?: string): Promise<string> {
    if (!this.udid) return this.no('iOS simulator log capture without a simulator UDID');
    const raw = await this.simulator.simulatorLogs(this.udid, { last: '5m', bundleId: this.bundleId });
    const filtered = grep
      ? raw
          .split(/\r?\n/)
          .filter((line) => new RegExp(grep, 'i').test(line))
          .join('\n')
      : raw;
    return tailLines(filtered, lines);
  }
  airplaneOn(): Promise<boolean> {
    return this.no('airplane-mode read');
  }
  setAirplane(): Promise<void> {
    return this.no('airplane-mode toggle');
  }
  async foregroundOwner(): Promise<string> {
    try {
      const info = await this.withSession((sid) => wdaActiveAppInfo(this.baseUrl, sid));
      return info.bundleId ?? info.name ?? this.bundleId ?? 'unknown';
    } catch {
      return this.bundleId ?? 'unknown';
    }
  }
  async screenshot(): Promise<Buffer> {
    return this.withSession((sid) => this.timed('screenshot', () => wdaScreenshot(this.baseUrl, sid)));
  }
  async dumpXml(): Promise<string> {
    return normalizeWdaSource(await this.withSession((sid) => this.timed('source', () => wdaSource(this.baseUrl, sid))));
  }
  async tapXY(x: number, y: number): Promise<void> {
    await this.withSession((sid) => this.timed('tap', () => tapWdaPoint(this.baseUrl, sid, x, y)));
  }
  async pressXY(x: number, y: number): Promise<void> {
    await this.tapXY(x, y);
  }
  async inputText(text: string): Promise<void> {
    return this.withSession((sid) => this.inputTextIn(sid, text));
  }
  private async inputTextIn(sid: string, text: string): Promise<void> {
    let focusedError: unknown;
    try {
      const el = await this.timed('find_element', () => findFocusedWdaElement(this.baseUrl, sid));
      await this.timed('type', () => typeWdaElement(this.baseUrl, sid, el.elementId, text));
      return;
    } catch (e) {
      focusedError = e;
    }
    try {
      await this.timed('type', () => typeWdaKeys(this.baseUrl, sid, text));
      return;
    } catch (keysError) {
      throw new Error(
        `TEXT_INPUT_UNSUPPORTED: WDA could not type into the focused input. focused-element path failed: ${errorSummary(focusedError)}; /wda/keys path failed: ${errorSummary(keysError)}`,
        { cause: keysError },
      );
    }
  }
  async clearFocusedText(approxLen = 40): Promise<void> {
    return this.withSession((sid) => this.clearFocusedTextIn(sid, approxLen));
  }
  private async clearFocusedTextIn(sid: string, approxLen: number): Promise<void> {
    let clearError: unknown;
    try {
      const el = await this.timed('find_element', () => findFocusedWdaElement(this.baseUrl, sid));
      await this.timed('clear', () => clearWdaElement(this.baseUrl, sid, el.elementId));
      return;
    } catch (e) {
      clearError = e;
    }
    try {
      await this.timed('clear', () => clearWdaFocusedByKeys(this.baseUrl, sid, approxLen));
    } catch (keysError) {
      throw new Error(
        `TEXT_INPUT_UNSUPPORTED: WDA could not clear the focused field. element-clear path failed: ${errorSummary(clearError)}; keyboard-backspace path failed: ${errorSummary(keysError)}`,
        { cause: keysError },
      );
    }
  }
  async pressKey(key: 'back' | 'home' | 'enter'): Promise<void> {
    if (key === 'home') {
      await this.withSession((sid) => pressWdaHome(this.baseUrl, sid));
      return;
    }
    if (key === 'back') {
      // iOS has no system back key (WDA has no /back endpoint): tap the navigation bar's back
      // button when the screen has one, else perform the interactive-pop edge swipe.
      await this.withSession((sid) => this.backIn(sid));
      return;
    }
    await this.inputText('\n');
  }

  /** Last `back` strategy used ('nav_button' | 'edge_swipe') — surfaced by qa_act. */
  lastBackVia?: 'nav_button' | 'edge_swipe';
  private async backIn(sid: string): Promise<void> {
    const xml = normalizeWdaSource(await this.timed('source', () => wdaSource(this.baseUrl, sid)));
    const btn = iosBackButtonPoint(xml);
    if (btn) {
      await this.timed('tap', () => tapWdaPoint(this.baseUrl, sid, btn.x, btn.y));
      this.lastBackVia = 'nav_button';
      return;
    }
    let size: { width: number; height: number } | null = null;
    try {
      size = await wdaWindowSize(this.baseUrl, sid);
    } catch (e) {
      if (isInvalidWdaSession(e)) throw e;
      const screen = parseSnapshot(xml).screen;
      size = screen[0] > 0 && screen[1] > 0 ? { width: screen[0], height: screen[1] } : null;
    }
    if (!size) throw new Error(IOS_BACK_UNSUPPORTED);
    const y = Math.round(size.height / 2);
    await dragWdaPoint(this.baseUrl, sid, 2, y, Math.round(size.width * 0.6), y, 0.1);
    this.lastBackVia = 'edge_swipe';
  }

  async acceptAlert(): Promise<void> {
    await this.withSession((sid) => acceptWdaAlert(this.baseUrl, sid));
  }

  async dismissAlert(): Promise<void> {
    await this.withSession((sid) => dismissWdaAlert(this.baseUrl, sid));
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 300): Promise<void> {
    await this.withSession((sid) => dragWdaPoint(this.baseUrl, sid, x1, y1, x2, y2, ms / 1000));
  }
  adbReverseMetro(): Promise<void> {
    return this.no('dev-server port reverse');
  }
  // SWIP-17: size in points via GET /window/size instead of dumping the entire page source.
  // Cached per (WDA session id, interface orientation): a rotation swaps the axes, so the
  // cheap GET /orientation keys the cache; a new session naturally misses it. Builds without
  // /orientation key on "unknown" (the pre-rotation behaviour).
  private cachedScreenSize?: { sessionId: string; orientation: string; size: { width: number; height: number } };
  async screenSize(): Promise<{ width: number; height: number } | null> {
    return this.withSession(async (sid) => {
      const orientation = await wdaOrientation(this.baseUrl, sid).catch(() => 'unknown');
      const cached = this.cachedScreenSize;
      if (cached?.sessionId === sid && cached.orientation === orientation) return cached.size;
      let size: { width: number; height: number } | null;
      try {
        size = await wdaWindowSize(this.baseUrl, sid);
      } catch (e) {
        if (isInvalidWdaSession(e)) throw e;
        // older WDA builds lack /window/size — fall back to the page-source root bounds
        const xml = normalizeWdaSource(await this.timed('source', () => wdaSource(this.baseUrl, sid)));
        const m = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
        size = m ? { width: Number(m[1]), height: Number(m[2]) } : null;
      }
      if (size) this.cachedScreenSize = { sessionId: sid, orientation, size };
      return size;
    });
  }
  screenDensity(): Promise<number | null> {
    return Promise.resolve(null);
  }
  async openUrl(url: string): Promise<void> {
    if (!this.udid) return this.no('open url without a simulator UDID');
    await this.simulator.openUrl(this.udid, url);
  }
  disableAnimations(): Promise<void> {
    return Promise.resolve();
  }

  async tapByAccessibilityId(value: string): Promise<void> {
    await this.tapBySelector('accessibility id', value);
  }

  async typeByAccessibilityId(value: string, text: string): Promise<void> {
    await this.typeBySelector('accessibility id', value, text);
  }

  async tapBySelector(using: NativeSelectorStrategy, value: string): Promise<void> {
    await this.withSession(async (sid) => {
      const el = await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, using, value));
      await this.timed('tap', () => tapWdaElement(this.baseUrl, sid, el.elementId));
    });
  }

  async typeBySelector(using: NativeSelectorStrategy, value: string, text: string): Promise<void> {
    await this.withSession(async (sid) => {
      const el = await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, using, value));
      await this.timed('type', () => typeWdaElement(this.baseUrl, sid, el.elementId, text));
    });
  }

  async clearBySelector(using: NativeSelectorStrategy, value: string): Promise<void> {
    await this.withSession(async (sid) => {
      const el = await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, using, value));
      await this.timed('clear', () => clearWdaElement(this.baseUrl, sid, el.elementId));
    });
  }

  // SWIP-03: real secure-field signal for native-selector typing — resolve the element and
  // read its `type` attribute (XCUIElementTypeSecureTextField), accepting a boolean `secure`
  // attribute where a WDA build exposes one instead.
  async isSecureBySelector(using: NativeSelectorStrategy, value: string): Promise<boolean> {
    return this.withSession((sid) => this.isSecureIn(sid, using, value));
  }
  private async isSecureIn(sid: string, using: NativeSelectorStrategy, value: string): Promise<boolean> {
    const el = await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, using, value));
    try {
      if (/SecureTextField/i.test(await wdaElementAttribute(this.baseUrl, sid, el.elementId, 'type'))) return true;
    } catch {
      // some builds don't serve /attribute/type — fall through to the `secure` attribute
    }
    return /^(true|1)$/i.test(await wdaElementAttribute(this.baseUrl, sid, el.elementId, 'secure').catch(() => ''));
  }

  async existsBySelector(using: NativeSelectorStrategy, value: string): Promise<boolean> {
    return this.withSession(async (sid) => {
      try {
        await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, using, value));
        return true;
      } catch (e) {
        if (isInvalidWdaSession(e)) throw e; // let withSession recover the session
        return false;
      }
    });
  }
}
