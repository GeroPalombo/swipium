import type { Driver, NativeSelectorStrategy } from './Driver.js';
import * as sim from '../lib/simctl.js';
import {
  clearWdaElement,
  createWdaSession,
  deleteWdaSession,
  dragWdaPoint,
  findWdaElement,
  normalizeWdaSource,
  pressWdaBack,
  pressWdaHome,
  tapWdaElement,
  tapWdaPoint,
  typeWdaElement,
  wdaActiveAppInfo,
  wdaScreenshot,
  wdaSessionUdidMismatch,
  wdaSource,
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

export class WdaDriver implements Driver {
  readonly kind = 'wda' as const;
  readonly baseUrl: string;
  private readonly simulator: SimulatorControl;
  private udid?: string;
  private sessionId?: string;
  private bundleId?: string;
  private readonly capabilities?: Record<string, unknown>;
  private readonly settings?: Record<string, unknown>;
  private readonly onTiming?: (kind: WdaTimingKind, durationMs: number) => void;

  constructor(baseUrl: string, opts: WdaSessionOptions & { sessionId?: string; simulator?: SimulatorControl; onTiming?: (kind: WdaTimingKind, durationMs: number) => void } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.simulator = opts.simulator ?? sim;
    this.udid = opts.udid;
    this.sessionId = opts.sessionId;
    this.bundleId = opts.bundleId;
    this.capabilities = opts.capabilities;
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

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const s = await this.timed('session_create', () => createWdaSession(this.baseUrl, { bundleId: this.bundleId, udid: this.udid, capabilities: this.capabilities, settings: this.settings }));
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
  imeShown(): Promise<boolean> {
    return Promise.resolve(false);
  }
  async logcat(lines = 200, grep?: string): Promise<string> {
    if (!this.udid) return this.no('iOS simulator log capture without a simulator UDID');
    const raw = await this.simulator.simulatorLogs(this.udid, { last: '5m', bundleId: this.bundleId });
    const filtered = grep
      ? raw.split(/\r?\n/).filter((line) => new RegExp(grep, 'i').test(line)).join('\n')
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
      const info = await wdaActiveAppInfo(this.baseUrl, await this.ensureSession());
      return info.bundleId ?? info.name ?? this.bundleId ?? 'unknown';
    } catch {
      return this.bundleId ?? 'unknown';
    }
  }
  async screenshot(): Promise<Buffer> {
    const sid = await this.ensureSession();
    return this.timed('screenshot', () => wdaScreenshot(this.baseUrl, sid));
  }
  async dumpXml(): Promise<string> {
    const sid = await this.ensureSession();
    return normalizeWdaSource(await this.timed('source', () => wdaSource(this.baseUrl, sid)));
  }
  async tapXY(x: number, y: number): Promise<void> {
    const sid = await this.ensureSession();
    await this.timed('tap', () => tapWdaPoint(this.baseUrl, sid, x, y));
  }
  async pressXY(x: number, y: number): Promise<void> {
    await this.tapXY(x, y);
  }
  async inputText(text: string): Promise<void> {
    const sid = await this.ensureSession();
    const el = await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, 'predicate string', 'hasKeyboardFocus == 1'));
    await this.timed('type', () => typeWdaElement(this.baseUrl, sid, el.elementId, text));
  }
  async clearFocusedText(): Promise<void> {
    const sid = await this.ensureSession();
    const el = await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, 'predicate string', 'hasKeyboardFocus == 1'));
    await this.timed('clear', () => clearWdaElement(this.baseUrl, sid, el.elementId));
  }
  async pressKey(key: 'back' | 'home' | 'enter'): Promise<void> {
    if (key === 'home') {
      await pressWdaHome(this.baseUrl, await this.ensureSession());
      return;
    }
    if (key === 'back') {
      await pressWdaBack(this.baseUrl, await this.ensureSession());
      return;
    }
    await this.inputText('\n');
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 300): Promise<void> {
    await dragWdaPoint(this.baseUrl, await this.ensureSession(), x1, y1, x2, y2, ms / 1000);
  }
  adbReverseMetro(): Promise<void> {
    return this.no('dev-server port reverse');
  }
  async screenSize(): Promise<{ width: number; height: number } | null> {
    const xml = await this.dumpXml();
    const m = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
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
    const sid = await this.ensureSession();
    const el = await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, using, value));
    await this.timed('tap', () => tapWdaElement(this.baseUrl, sid, el.elementId));
  }

  async typeBySelector(using: NativeSelectorStrategy, value: string, text: string): Promise<void> {
    const sid = await this.ensureSession();
    const el = await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, using, value));
    await this.timed('type', () => typeWdaElement(this.baseUrl, sid, el.elementId, text));
  }

  async clearBySelector(using: NativeSelectorStrategy, value: string): Promise<void> {
    const sid = await this.ensureSession();
    const el = await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, using, value));
    await this.timed('clear', () => clearWdaElement(this.baseUrl, sid, el.elementId));
  }

  async existsBySelector(using: NativeSelectorStrategy, value: string): Promise<boolean> {
    const sid = await this.ensureSession();
    try {
      await this.timed('find_element', () => findWdaElement(this.baseUrl, sid, using, value));
      return true;
    } catch {
      return false;
    }
  }
}
