// SimctlDriver — the iOS Simulator backend behind the same Driver seam (PHASE3-PLAN Phase 11).
// It implements exactly what `simctl` supports (screenshot, lifecycle, deep links) so the shared
// visual tools (qa_screenshot, qa_visual) work on iOS unchanged. Operations that
// require a UI tree or input injection are honestly UNSUPPORTED here. Attach WebDriverAgent
// for structured iOS automation; this driver stays visual/lifecycle-only.

import * as sim from '../lib/simctl.js';
import { pngSize } from '../lib/png.js';
import { run } from '../lib/spawn.js';
import { which } from '../lib/android.js';
import type { Driver } from './Driver.js';

export type SimulatorScaleSource = 'idb' | 'device_type' | 'name_heuristic' | 'pixel_heuristic';

/** Parse `idb describe --json` → the point scale. idb reports `screen_dimensions` as
 * { width, height, density, width_points, height_points } (width/height in pixels). */
export function parseIdbDescribeScale(stdout: string): number | null {
  try {
    const j = JSON.parse(stdout.trim()) as { screen_dimensions?: Record<string, unknown> };
    const d = j?.screen_dimensions;
    if (!d) return null;
    const w = Number(d.width);
    const wp = Number(d.width_points);
    if (Number.isFinite(w) && Number.isFinite(wp) && w > 0 && wp > 0) return Math.round((w / wp) * 100) / 100;
    const density = Number(d.density);
    return Number.isFinite(density) && density >= 1 ? density : null;
  } catch {
    return null;
  }
}

/** Fallback scale from the device-type name. Documented heuristic: iPads and the 2x iPhones
 * (SE, 8 / 7 / 6s non-Plus, XR, 11 non-Pro) are 2x; every other iPhone (Pro/Plus/Max/mini and
 * the numbered models from 12 on) is 3x. null when the name says nothing about the device. */
export function scaleFromDeviceName(name: string | undefined): number | null {
  if (!name) return null;
  if (/ipad/i.test(name)) return 2;
  if (!/iphone/i.test(name)) return null;
  if (/plus|max|pro|mini/i.test(name)) return 3;
  if (/\bSE\b|iPhone (?:6s?|7|8|XR|11)\b/i.test(name)) return 2;
  return 3;
}

/** Last-resort scale from the screenshot pixel size: iPhone 3x panels have a short edge of
 * 1080–1320 px; 2x iPhones are <= 828 px and 2x iPads are > 1320 px. */
export function scaleFromPixels(px: { width: number; height: number }): number {
  const short = Math.min(px.width, px.height);
  return short >= 1000 && short <= 1320 ? 3 : 2;
}

/**
 * Resolve the simulator's pixel-per-point scale so screenSize() can report POINTS — the unit
 * `idb ui tap` and WebDriverAgent take. Order: `idb describe` (authoritative, when idb is on
 * PATH) → the device type's `profile.plist` `mainScreenScale` (via `simctl list`) → the device
 * name heuristic → the screenshot-size heuristic. Never throws.
 */
export async function resolveSimulatorScale(
  udid: string,
  px: { width: number; height: number },
): Promise<{ scale: number; source: SimulatorScaleSource }> {
  try {
    if (await which('idb')) {
      const r = await run('idb', ['describe', '--udid', udid, '--json'], { timeoutMs: 10000 });
      const scale = r.code === 0 ? parseIdbDescribeScale(r.stdout) : null;
      if (scale) return { scale, source: 'idb' };
    }
  } catch {
    // fall through
  }
  let name: string | undefined;
  try {
    const devs = await run('xcrun', ['simctl', 'list', 'devices', '--json'], { timeoutMs: 15000 });
    const all = Object.values(
      (JSON.parse(devs.stdout) as { devices?: Record<string, Array<{ udid: string; name: string; deviceTypeIdentifier?: string }>> })
        .devices ?? {},
    ).flat();
    const dev = all.find((d) => d.udid === udid);
    name = dev?.name;
    if (dev?.deviceTypeIdentifier) {
      const types = await run('xcrun', ['simctl', 'list', 'devicetypes', '--json'], { timeoutMs: 15000 });
      const type = (
        JSON.parse(types.stdout) as { devicetypes?: Array<{ identifier: string; name?: string; bundlePath?: string }> }
      ).devicetypes?.find((t) => t.identifier === dev.deviceTypeIdentifier);
      name = type?.name ?? name;
      if (type?.bundlePath) {
        const plist = await run('plutil', ['-convert', 'json', '-o', '-', `${type.bundlePath}/Contents/Resources/profile.plist`], {
          timeoutMs: 8000,
        });
        const scale = plist.code === 0 ? Number((JSON.parse(plist.stdout) as { mainScreenScale?: unknown }).mainScreenScale) : NaN;
        if (Number.isFinite(scale) && scale >= 1) return { scale, source: 'device_type' };
      }
    }
  } catch {
    // fall through to heuristics
  }
  const byName = scaleFromDeviceName(name);
  if (byName) return { scale: byName, source: 'name_heuristic' };
  return { scale: scaleFromPixels(px), source: 'pixel_heuristic' };
}

const UNSUPPORTED =
  'not supported on the visual-only iOS simulator backend. ' +
  'Attach WebDriverAgent with qa_wda for structured tap/type/snapshot, or use qa_ios plus qa_visual mode:"assert" for visual checks.';

export class SimctlDriver implements Driver {
  readonly kind = 'simulator' as const;
  private udid: string;
  private size?: { width: number; height: number };
  private scaleInfo?: { scale: number; source: SimulatorScaleSource };

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
    this.scaleInfo = undefined;
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
  /** Screen size in POINTS (B6) — the unit `idb ui tap` and WebDriverAgent use — so
   * captureCoordinateSpace derives scale = screenshot px / points and every devicePoint a
   * visual tool returns is directly tappable, consistent with the WDA backend. */
  async screenSize(): Promise<{ width: number; height: number } | null> {
    if (this.size) return this.size;
    try {
      const dims = pngSize(await sim.screenshot(this.udid));
      if (!dims) return null;
      const { scale } = await this.pointScale(dims);
      this.size = { width: Math.round(dims.width / scale), height: Math.round(dims.height / scale) };
      return this.size;
    } catch {
      return null;
    }
  }
  /** Pixel-per-point scale of this simulator and how it was derived (cached per device). */
  async pointScale(px?: { width: number; height: number }): Promise<{ scale: number; source: SimulatorScaleSource }> {
    if (this.scaleInfo) return this.scaleInfo;
    const dims = px ?? pngSize(await sim.screenshot(this.udid)) ?? { width: 0, height: 0 };
    this.scaleInfo = await resolveSimulatorScale(this.udid, dims);
    return this.scaleInfo;
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
      ? raw
          .split(/\r?\n/)
          .filter((line) => new RegExp(grep, 'i').test(line))
          .join('\n')
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
