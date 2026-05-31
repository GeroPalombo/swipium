// DirectDriver — the v1 Android backend. Reads the accessibility tree via
// the platform UI-dump tool and acts via `adb shell input` (DESIGN §11). No external
// automation server.
//
// The shell-tap / `input text` approach is the same one proven in the Inn suite for
// React Native custom inputs that don't respond to programmatic clicks.

import { run, runBinary } from '../lib/spawn.js';
import { adbDevices } from '../lib/android.js';
import type { Driver } from './Driver.js';

const KEYCODE: Record<'back' | 'home' | 'enter', string> = {
  back: '4',
  home: '3',
  enter: '66',
};

export class DirectDriver implements Driver {
  readonly kind = 'direct' as const;
  private serial?: string;
  private signal?: AbortSignal;

  constructor(serial?: string) {
    this.serial = serial;
  }

  /** Bind an AbortSignal so a cancelled job actually kills in-flight adb children. */
  setSignal(signal?: AbortSignal): void {
    this.signal = signal;
  }

  private base(): string[] {
    return this.serial ? ['-s', this.serial] : [];
  }

  private async adb(args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    return run('adb', [...this.base(), ...args], {
      timeoutMs: opts.timeoutMs ?? 20000,
      signal: opts.signal ?? this.signal,
      rejectOnNonZero: true,
    });
  }

  async listDevices(): Promise<string[]> {
    return adbDevices();
  }

  useDevice(serial: string): void {
    this.serial = serial;
  }

  currentDevice(): string | undefined {
    return this.serial;
  }

  async installApp(apkPath: string): Promise<void> {
    await this.adb(['install', '-r', '-g', apkPath], { timeoutMs: 180000 });
  }

  async uninstallApp(pkg: string): Promise<void> {
    await this.adb(['uninstall', pkg], { timeoutMs: 60000 });
  }

  async isInstalled(pkg: string): Promise<boolean> {
    const r = await this.adb(['shell', 'pm', 'list', 'packages', pkg]);
    return r.stdout.split('\n').some((l) => l.trim() === `package:${pkg}`);
  }

  async isRunning(pkg: string): Promise<boolean> {
    try {
      const r = await this.adb(['shell', 'pidof', pkg]);
      return r.stdout.trim().length > 0;
    } catch {
      return false; // pidof exits non-zero when no process
    }
  }

  async clearData(pkg: string): Promise<void> {
    await this.adb(['shell', 'pm', 'clear', pkg]);
  }

  async imeShown(): Promise<boolean> {
    try {
      const r = await this.adb(['shell', 'dumpsys', 'input_method']);
      return /mInputShown=true/.test(r.stdout);
    } catch {
      return false;
    }
  }

  async logcat(lines: number, grep?: string): Promise<string> {
    try {
      const r = await this.adb(['logcat', '-d', '-t', String(lines)], { timeoutMs: 8000 });
      const out = r.stdout;
      if (!grep) return out;
      const re = new RegExp(grep, 'i');
      return out.split('\n').filter((l) => re.test(l)).join('\n');
    } catch {
      return '';
    }
  }

  async airplaneOn(): Promise<boolean> {
    try {
      const r = await this.adb(['shell', 'settings', 'get', 'global', 'airplane_mode_on']);
      return r.stdout.trim() === '1';
    } catch {
      return false;
    }
  }

  async setAirplane(on: boolean): Promise<void> {
    // `cmd connectivity airplane-mode` (API 30+) flips the flag + radios + broadcast.
    await this.adb(['shell', 'cmd', 'connectivity', 'airplane-mode', on ? 'enable' : 'disable']);
  }

  async launchApp(pkg: string): Promise<void> {
    // monkey is the simplest reliable launcher when we don't know the main activity.
    await this.adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  }

  async launchAppWithArgs(pkg: string, args: Record<string, unknown>): Promise<void> {
    const resolved = await this.adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', pkg], { timeoutMs: 8000 });
    const component = resolved.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
    if (!component || !component.includes('/')) throw new Error(`Could not resolve launch activity for ${pkg}`);
    const extras: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'boolean') extras.push('--ez', key, String(value));
      else if (Number.isInteger(value)) extras.push('--ei', key, String(value));
      else if (typeof value === 'number') extras.push('--ef', key, String(value));
      else extras.push('--es', key, String(value));
    }
    await this.adb(['shell', 'am', 'start', '-W', '-S', '-n', component, ...extras], { timeoutMs: 30000 });
  }

  async terminateApp(pkg: string): Promise<void> {
    await this.adb(['shell', 'am', 'force-stop', pkg]);
  }

  async foregroundOwner(): Promise<string> {
    // Parse the currently focused window/activity. Works across recent Android versions.
    const r = await this.adb(['shell', 'dumpsys', 'activity', 'activities']);
    const m =
      r.stdout.match(/mResumedActivity:.*\{[^}]*\s([^\s/]+\/[^\s}]+)/) ||
      r.stdout.match(/mCurrentFocus=.*\s([^\s/]+\/[^\s}]+)/);
    return m?.[1] ?? 'unknown';
  }

  async screenshot(): Promise<Buffer> {
    // exec-out returns raw PNG bytes on stdout — must be collected as binary.
    const r = await runBinary('adb', [...this.base(), 'exec-out', 'screencap', '-p'], {
      timeoutMs: 15000,
      signal: this.signal,
      rejectOnNonZero: true,
    });
    return r.stdout;
  }

  async dumpXml(): Promise<string> {
    // mobile-mcp's proven recipe: exec-out to stdout, retry on the transient
    // "could not get hierarchy" / null-root, strip warning lines before <?xml.
    // Kept modest (5) so a PERSISTENT idle failure (looping animation) surfaces fast and the
    // tool layer can switch to visual-fallback rather than burning ~30 attempts.
    const ATTEMPTS = 5;
    let lastErr = '';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        const r = await this.adb(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
        const idx = r.stdout.indexOf('<?xml');
        if (idx >= 0 && r.stdout.includes('</hierarchy>')) {
          return r.stdout.slice(idx);
        }
        lastErr = r.stdout.trim() || r.stderr.trim();
      } catch (e) {
        lastErr = String(e);
      }
      await new Promise((res) => setTimeout(res, 400));
    }
    throw new Error(`uiautomator dump failed after ${ATTEMPTS} attempts: ${lastErr}`);
  }

  async tapXY(x: number, y: number): Promise<void> {
    await this.adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  }

  async pressXY(x: number, y: number, ms: number): Promise<void> {
    // Same-point swipe with a duration — registers on RN views that ignore instant taps.
    const sx = String(Math.round(x));
    const sy = String(Math.round(y));
    await this.adb(['shell', 'input', 'swipe', sx, sy, sx, sy, String(Math.round(ms))]);
  }

  async inputText(text: string): Promise<void> {
    // `input text` uses %s for space; avoid characters the shell would interpret.
    const escaped = text.replace(/ /g, '%s');
    await this.adb(['shell', 'input', 'text', escaped]);
  }

  async clearFocusedText(approxLen = 40): Promise<void> {
    const n = Math.min(Math.max(approxLen + 2, 1), 120);
    // MOVE_END (123) then a batch of DEL (67) in a single keyevent call.
    await this.adb(['shell', 'input', 'keyevent', '123', ...Array(n).fill('67')]);
  }

  async pressKey(key: 'back' | 'home' | 'enter'): Promise<void> {
    await this.adb(['shell', 'input', 'keyevent', KEYCODE[key]]);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 300): Promise<void> {
    await this.adb([
      'shell', 'input', 'swipe',
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
      String(ms),
    ]);
  }

  async screenSize(): Promise<{ width: number; height: number } | null> {
    try {
      const r = await this.adb(['shell', 'wm', 'size']);
      // prefer "Override size:" if present, else "Physical size:"
      const m = r.stdout.match(/Override size:\s*(\d+)x(\d+)/) ?? r.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
      return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
    } catch {
      return null;
    }
  }

  async screenDensity(): Promise<number | null> {
    try {
      const r = await this.adb(['shell', 'wm', 'density']);
      const m = r.stdout.match(/Override density:\s*(\d+)/) ?? r.stdout.match(/Physical density:\s*(\d+)/);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  async adbReverseMetro(port = 8081): Promise<void> {
    await this.adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
  }

  async openUrl(url: string): Promise<void> {
    await this.adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
  }

  async disableAnimations(): Promise<void> {
    for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
      await this.adb(['shell', 'settings', 'put', 'global', k, '0']);
    }
  }
}
