// SimctlDriver — the iOS Simulator backend behind the same Driver seam (PHASE3-PLAN Phase 11).
// It implements exactly what `simctl` supports (screenshot, lifecycle, deep links) so the shared
// visual tools (qa_screenshot, qa_assert_visual) work on iOS unchanged. Operations that
// require a UI tree or input injection are honestly UNSUPPORTED here. Attach WebDriverAgent
// for structured iOS automation; this driver stays visual/lifecycle-only.

import * as sim from '../lib/simctl.js';
import { pngSize } from '../lib/png.js';
import type { Driver } from './Driver.js';

const UNSUPPORTED =
  'not supported on the visual-only iOS simulator backend. ' +
  'Attach WebDriverAgent with qa_wda for structured tap/type/snapshot, or use qa_ios plus qa_assert_visual for visual checks.';

export class SimctlDriver implements Driver {
  readonly kind = 'simulator' as const;
  private udid: string;
  private size?: { width: number; height: number };

  constructor(udid: string) {
    this.udid = udid;
  }

  // REJECT (not throw) — these implement async Driver methods, so callers that do
  // `driver.x().catch(...)` (e.g. qa_report) must see a rejected promise, not a sync throw.
  private no(op: string): Promise<never> {
    return Promise.reject(new Error(`${op} ${UNSUPPORTED}`));
  }

  async listDevices(): Promise<string[]> {
    return (await sim.listSimulators()).filter((s) => s.state === 'Booted').map((s) => s.udid);
  }
  useDevice(udid: string): void {
    this.udid = udid;
    this.size = undefined;
  }
  currentDevice(): string | undefined {
    return this.udid;
  }

  installApp(appPath: string): Promise<void> {
    return sim.installApp(this.udid, appPath);
  }
  uninstallApp(bundleId: string): Promise<void> {
    return sim.uninstallApp(this.udid, bundleId);
  }
  isInstalled(bundleId: string): Promise<boolean> {
    return sim.isInstalled(this.udid, bundleId);
  }
  launchApp(bundleId: string): Promise<void> {
    return sim.launchApp(this.udid, bundleId);
  }
  launchAppWithArgs(bundleId: string, args: Record<string, unknown>): Promise<void> {
    return sim.launchAppWithArgs(this.udid, bundleId, args);
  }
  terminateApp(bundleId: string): Promise<void> {
    return sim.terminateApp(this.udid, bundleId);
  }
  openUrl(url: string): Promise<void> {
    return sim.openUrl(this.udid, url);
  }
  async screenshot(): Promise<Buffer> {
    return sim.screenshot(this.udid);
  }
  async screenSize(): Promise<{ width: number; height: number } | null> {
    if (this.size) return this.size;
    try {
      const dims = pngSize(await sim.screenshot(this.udid));
      if (dims) this.size = dims;
      return dims;
    } catch {
      return null;
    }
  }
  async screenDensity(): Promise<number | null> {
    return null; // simulator density isn't exposed via simctl; coordinate space still has px + scale
  }

  // --- UI tree / input injection: attach WebDriverAgent for structured automation. ---
  isRunning(): Promise<boolean> {
    return this.no('checking run state');
  }
  clearData(): Promise<void> {
    return this.no('clear app data (use qa_ios erase / privacy_reset)');
  }
  imeShown(): Promise<boolean> {
    return this.no('keyboard detection');
  }
  async logcat(lines = 200, grep?: string): Promise<string> {
    const raw = await sim.simulatorLogs(this.udid, { last: '5m' });
    const filtered = grep
      ? raw.split(/\r?\n/).filter((line) => new RegExp(grep, 'i').test(line)).join('\n')
      : raw;
    const all = filtered.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  }
  airplaneOn(): Promise<boolean> {
    return this.no('airplane-mode read');
  }
  setAirplane(): Promise<void> {
    return this.no('airplane-mode toggle');
  }
  foregroundOwner(): Promise<string> {
    return this.no('foreground-app detection');
  }
  dumpXml(): Promise<string> {
    return this.no('UI-tree dump (qa_snapshot)');
  }
  tapXY(): Promise<void> {
    return this.no('tap');
  }
  pressXY(): Promise<void> {
    return this.no('press');
  }
  inputText(): Promise<void> {
    return this.no('text input');
  }
  clearFocusedText(): Promise<void> {
    return this.no('clearing a field');
  }
  pressKey(): Promise<void> {
    return this.no('key press');
  }
  swipe(): Promise<void> {
    return this.no('swipe');
  }
  adbReverseMetro(): Promise<void> {
    return this.no('dev-server port reverse');
  }
  disableAnimations(): Promise<void> {
    return this.no('disabling animations');
  }
}
