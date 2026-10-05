// DirectDriver: the v1 Android backend. Reads the accessibility tree via
// the platform UI-dump tool and acts via `adb shell input`. No external
// automation server.
//
// The shell-tap / `input text` approach is the same one proven in the Inn suite for
// React Native custom inputs that don't respond to programmatic clicks.

import { run, runBinary } from '../lib/spawn.js';
import { currentSignal, isAbortError, sleepOrCancel } from '../lib/abortScope.js';
import { adbDevices } from '../lib/android.js';
import type { DumpOptions, Driver, ImeState, TextDeliverability } from './Driver.js';

/** Characters the device-side /system/bin/sh (mksh) treats specially; each gets a backslash.
 * Includes brace/glob expansion (`{a,b}` > `a b`, `[s]dcard` > `sdcard`). Backslash itself is
 * escaped first (see escapeAdbInputText) so later escapes aren't doubled. */
const DEVICE_SHELL_META = /([&|;()<>"'$`*?!#~^{}[\]])/g;

/** PURE: can adb `input text` deliver `text` verbatim? It cannot deliver characters outside
 * printable ASCII (Unicode, newline, tab). The device-side shell/IME drops or mangles them.
 * qa_act checks this BEFORE focusing/clearing a field so a refusal changes nothing on device. */
export function adbTextDeliverability(text: string): TextDeliverability {
  const unsupported = [...new Set(text.match(/[^\x20-\x7E]/g) ?? [])];
  if (!unsupported.length) return { ok: true };
  return {
    ok: false,
    reason: `TEXT_INPUT_UNSUPPORTED: adb \`input text\` cannot deliver non-ASCII/control characters ${unsupported
      .map((c) => JSON.stringify(c))
      .join(', ')}; nothing was typed. Use ASCII-safe text for this field.`,
  };
}

/** PURE: escape one `input text` chunk for the device shell. Spaces become `%s` because
 * `input text` takes ONE arg and maps `%s` back to a space (InputShellCommand.sendText). */
export function escapeAdbInputText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(DEVICE_SHELL_META, '\\$1').replace(/ /g, '%s');
}

/** PURE: split raw text so no single `input text` call contains the literal two-char sequence
 * `%s`. AOSP InputShellCommand.sendText rewrites EVERY `%s` to a space with no escape for it,
 * so "ab%scd" must go out as "ab%" then "scd" (the rewrite never spans two calls). */
export function adbInputTextChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === '%' && text[i + 1] === 's') {
      chunks.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  chunks.push(text.slice(start));
  return chunks.filter((c) => c.length > 0);
}

/** PURE: POSIX single-quote a value for the device shell (`'` > `'\''`), so deep links and
 * launch extras with `&`, `;`, spaces or quotes reach `am` as ONE literal argument. */
export function deviceShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PURE: display rotation (0-3) from `dumpsys input`, i.e. `SurfaceOrientation: N` (per touch
 * device) or the viewport `orientation=N` line on newer builds. null when absent. */
export function parseInputRotation(dumpsysInput: string): number | null {
  const m =
    dumpsysInput.match(/SurfaceOrientation:\s*(\d)/) ??
    dumpsysInput.match(/Viewport (?:INTERNAL|DISPLAY)[^\n]*?orientation=(\d)/) ??
    dumpsysInput.match(/mCurrentRotation=ROTATION_(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 90 ? (n / 90) % 4 : n % 4;
}

/** PURE: the soft keyboard's on-screen rect from `dumpsys window InputMethod`, or null.
 * Prefers the touchable region; else the window frame shrunk by its given visible/content
 * insets (older builds size the IME window near full-screen and inset the keyboard). The caller
 * (qa_act keyboardArea) additionally treats a frame taller than ~55% of the screen as unknown. */
export function parseImeFrame(dumpsysWindow: string): [number, number, number, number] | null {
  const touch = dumpsysWindow.match(/touchable region=SkRegion\(\((\d+),(\d+),(\d+),(\d+)\)\)/);
  if (touch) {
    const r = touch.slice(1, 5).map(Number) as [number, number, number, number];
    if (r[3] > r[1] && r[2] > r[0]) return r;
  }
  const frame = dumpsysWindow.match(/(?:\bframe|mFrame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!frame) return null;
  const [x1, y1, x2, y2] = frame.slice(1, 5).map(Number);
  const insets =
    dumpsysWindow.match(/mGivenVisibleInsets=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/) ??
    dumpsysWindow.match(/mGivenContentInsets=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  const top = y1 + (insets ? Number(insets[2]) : 0);
  if (y2 <= top || x2 <= x1) return null;
  return [x1, top, x2, y2];
}

/** A valid Android application id (package name): dot-separated Java identifiers, >= 2 segments. */
export const ANDROID_APP_ID_RE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;

/** Throw a typed INVALID_ARGUMENT error unless `pkg` is a well-formed Android application id.
 * App ids reach `adb shell` (a device-side sh re-parses the joined argv), so a value like
 * `com.x; rm -rf /sdcard` must never get there (M1). Callers also shell-quote it. */
export function assertAndroidAppId(pkg: string): string {
  if (typeof pkg !== 'string' || !ANDROID_APP_ID_RE.test(pkg)) {
    const err = new Error(
      `INVALID_ARGUMENT: ${JSON.stringify(String(pkg).slice(0, 80))} is not a valid Android application id (expected e.g. com.example.app).`,
    );
    (err as Error & { code?: string }).code = 'INVALID_ARGUMENT';
    throw err;
  }
  return pkg;
}

/** Validated + device-shell-quoted app id for an `adb shell` argv. */
export function shellAppId(pkg: string): string {
  return deviceShellQuote(assertAndroidAppId(pkg));
}

/** PURE: `<hierarchy rotation="N">` from a uiautomator dump, or null. */
export function dumpRotation(xml: string): number | null {
  const m = xml.slice(0, 400).match(/<hierarchy\b[^>]*\brotation="(\d)"/);
  return m ? Number(m[1]) % 4 : null;
}

/** PURE: current-axes screen size from a uiautomator dump's ROOT node, only when the root is
 * anchored at [0,0] and its aspect agrees with the dump's rotation (a dialog/split-screen window
 * root is not the screen). null otherwise. */
export function dumpRootScreen(xml: string): { width: number; height: number } | null {
  const rotation = dumpRotation(xml);
  if (rotation === null) return null;
  const m = xml.match(/<node\b[^>]*?\bbounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
  if (x1 !== 0 || y1 !== 0 || x2 <= 0 || y2 <= 0) return null;
  if ((rotation % 2 === 1) !== x2 > y2) return null;
  return { width: x2, height: y2 };
}

/** Separator between the two dumpsys outputs of DirectDriver.imeState(). */
const IME_STATE_SEP = '__SWIPIUM_IME_SEP__';

const KEYCODE: Record<'back' | 'home' | 'enter', string> = {
  back: '4',
  home: '3',
  enter: '66',
};

/** How long a DirectDriver reuses its last screen size + rotation (review round 2: swipes used
 * to run `wm size` + a full `dumpsys input` (a few hundred ms) on EVERY gesture). A device-side
 * rotation is picked up sooner than the TTL: every UI dump carries `<hierarchy rotation=N>`, and a
 * rotation different from the cached one drops the cache (plus invalidateScreenSizeCache for
 * Swipium's own orientation changes). */
export const SCREEN_SIZE_TTL_MS = 30_000;
/** A dump younger than this may answer screenSize() from its root bounds (no adb round trip). */
export const DUMP_SCREEN_FRESH_MS = 5_000;

/** Serials whose cached screen size must be dropped (Swipium changed the orientation). Global so
 * the orientation tool can invalidate every DirectDriver bound to that device. */
const screenSizeEpoch = new Map<string, number>();

/** Invalidate cached screen sizes (call after Swipium changes the orientation of `serial`, or
 * of every device when omitted). */
export function invalidateScreenSizeCache(serial?: string): void {
  if (serial) screenSizeEpoch.set(serial, (screenSizeEpoch.get(serial) ?? 0) + 1);
  else screenSizeEpoch.set('*', (screenSizeEpoch.get('*') ?? 0) + 1);
}

function epochOf(serial: string | undefined): number {
  return (screenSizeEpoch.get(serial ?? '') ?? 0) + (screenSizeEpoch.get('*') ?? 0);
}

/** Current invalidation epoch for `serial` (shared with the WDA driver's size cache). */
export function currentScreenSizeEpoch(serial: string | undefined): number {
  return epochOf(serial);
}

export class DirectDriver implements Driver {
  readonly kind = 'direct' as const;
  private serial?: string;

  constructor(serial?: string) {
    this.serial = serial;
  }

  private base(): string[] {
    return this.serial ? ['-s', this.serial] : [];
  }

  private async adb(args: string[], opts: { timeoutMs?: number; signal?: AbortSignal; sensitiveLastArg?: boolean } = {}) {
    const full = [...this.base(), ...args];
    return run('adb', full, {
      timeoutMs: opts.timeoutMs ?? 20000,
      // Cancellation travels with the call (abortScope), never via a shared slot on the driver.
      signal: opts.signal ?? currentSignal(),
      rejectOnNonZero: true,
      ...(opts.sensitiveLastArg ? { redactArgs: [full.length - 1] } : {}),
    });
  }

  async listDevices(): Promise<string[]> {
    return adbDevices();
  }

  useDevice(serial: string): void {
    this.serial = serial;
    this.sizeCache = undefined;
    this.dumpScreen = undefined;
  }

  currentDevice(): string | undefined {
    return this.serial;
  }

  async installApp(apkPath: string): Promise<void> {
    await this.adb(['install', '-r', '-g', apkPath], { timeoutMs: 180000 });
  }

  async uninstallApp(pkg: string): Promise<void> {
    await this.adb(['uninstall', assertAndroidAppId(pkg)], { timeoutMs: 60000 });
  }

  async isInstalled(pkg: string): Promise<boolean> {
    const r = await this.adb(['shell', 'pm', 'list', 'packages', shellAppId(pkg)]);
    return r.stdout.split('\n').some((l) => l.trim() === `package:${pkg}`);
  }

  async isRunning(pkg: string): Promise<boolean> {
    assertAndroidAppId(pkg); // a malformed id is an argument error, not "not running"
    try {
      const r = await this.adb(['shell', 'pidof', shellAppId(pkg)]);
      return r.stdout.trim().length > 0;
    } catch {
      return false; // pidof exits non-zero when no process
    }
  }

  async clearData(pkg: string): Promise<void> {
    await this.adb(['shell', 'pm', 'clear', shellAppId(pkg)]);
  }

  async imeShown(): Promise<boolean> {
    try {
      const r = await this.adb(['shell', 'dumpsys', 'input_method']);
      return /mInputShown=true/.test(r.stdout);
    } catch {
      return false;
    }
  }

  /** Keyboard shown + frame in ONE `adb shell` (both dumpsys, separated). The keyboard guard
   * used to pay two adb round trips on every tap/type. */
  async imeState(): Promise<ImeState> {
    try {
      const r = await this.adb(['shell', `dumpsys input_method; echo ${IME_STATE_SEP}; dumpsys window InputMethod`], {
        timeoutMs: 8000,
      });
      const i = r.stdout.indexOf(IME_STATE_SEP);
      const ime = i >= 0 ? r.stdout.slice(0, i) : r.stdout;
      const win = i >= 0 ? r.stdout.slice(i + IME_STATE_SEP.length) : '';
      const shown = /mInputShown=true/.test(ime);
      return { shown, frame: shown ? parseImeFrame(win) : null };
    } catch {
      return { shown: false, frame: null };
    }
  }

  async logcat(lines: number, grep?: string): Promise<string> {
    try {
      const r = await this.adb(['logcat', '-d', '-t', String(lines)], { timeoutMs: 8000 });
      const out = r.stdout;
      if (!grep) return out;
      const re = new RegExp(grep, 'i');
      return out
        .split('\n')
        .filter((l) => re.test(l))
        .join('\n');
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
    await this.adb(['shell', 'monkey', '-p', shellAppId(pkg), '-c', 'android.intent.category.LAUNCHER', '1']);
  }

  async launchAppWithArgs(pkg: string, args: Record<string, unknown>): Promise<void> {
    const resolved = await this.adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', shellAppId(pkg)], { timeoutMs: 8000 });
    const component = resolved.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    if (!component || !component.includes('/')) throw new Error(`Could not resolve launch activity for ${pkg}`);
    const extras: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      // `adb shell` space-joins argv into ONE string the device sh re-parses: every
      // user-supplied token is single-quoted so `&`, `;`, spaces and quotes survive intact.
      if (typeof value === 'boolean') extras.push('--ez', deviceShellQuote(key), String(value));
      else if (Number.isInteger(value)) extras.push('--ei', deviceShellQuote(key), String(value));
      else if (typeof value === 'number') extras.push('--ef', deviceShellQuote(key), String(value));
      else extras.push('--es', deviceShellQuote(key), deviceShellQuote(String(value)));
    }
    await this.adb(['shell', 'am', 'start', '-W', '-S', '-n', deviceShellQuote(component), ...extras], { timeoutMs: 30000 });
  }

  async terminateApp(pkg: string): Promise<void> {
    await this.adb(['shell', 'am', 'force-stop', shellAppId(pkg)]);
  }

  async foregroundOwner(): Promise<string> {
    // Parse the currently focused window/activity. Works across recent Android versions.
    const r = await this.adb(['shell', 'dumpsys', 'activity', 'activities']);
    const m = r.stdout.match(/mResumedActivity:.*\{[^}]*\s([^\s/]+\/[^\s}]+)/) || r.stdout.match(/mCurrentFocus=.*\s([^\s/]+\/[^\s}]+)/);
    return m?.[1] ?? 'unknown';
  }

  async screenshot(): Promise<Buffer> {
    // exec-out returns raw PNG bytes on stdout, so it must be collected as binary.
    const r = await runBinary('adb', [...this.base(), 'exec-out', 'screencap', '-p'], {
      timeoutMs: 15000,
      signal: currentSignal(),
      rejectOnNonZero: true,
    });
    return r.stdout;
  }

  async dumpXml(opts: DumpOptions = {}): Promise<string> {
    // mobile-mcp's proven recipe: exec-out to stdout, retry on the transient
    // "could not get hierarchy" / null-root, strip warning lines before <?xml.
    // Kept modest (5) so a PERSISTENT idle failure (looping animation) surfaces fast and the
    // tool layer can switch to visual-fallback rather than burning ~30 attempts. Callers with a
    // deadline (settle) pass opts.timeoutMs (TOTAL budget, retries included) + fewer attempts.
    const ATTEMPTS = Math.max(1, opts.attempts ?? 5);
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : undefined;
    let lastErr = '';
    let attempt = 0;
    for (; attempt < ATTEMPTS; attempt++) {
      const remaining = deadline === undefined ? 20000 : Math.min(20000, deadline - Date.now());
      if (remaining <= 0) break;
      try {
        const r = await this.adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeoutMs: remaining });
        const idx = r.stdout.indexOf('<?xml');
        if (idx >= 0 && r.stdout.includes('</hierarchy>')) {
          const xml = r.stdout.slice(idx);
          this.noteDump(xml);
          return xml;
        }
        lastErr = r.stdout.trim() || r.stderr.trim();
      } catch (e) {
        // Cancelled: rethrow at once (still an AbortError for isAbortError) instead of retrying.
        if (isAbortError(e)) throw e;
        lastErr = String(e);
      }
      if (attempt + 1 >= ATTEMPTS || (deadline !== undefined && deadline - Date.now() <= 400)) {
        attempt++;
        break;
      }
      await sleepOrCancel(400);
    }
    throw new Error(`uiautomator dump failed after ${attempt} attempt(s): ${lastErr}`);
  }

  /** Last dump's root-derived screen size (see dumpRootScreen), for screenSize(). */
  private dumpScreen?: { at: number; serial?: string; size: { width: number; height: number } };

  /** Keep the screen-size cache honest from every dump: a rotation change drops it, and a
   * [0,0]-anchored root gives a free current-axes size. */
  private noteDump(xml: string): void {
    const rotation = dumpRotation(xml);
    if (rotation !== null && this.sizeCache && this.sizeCache.rotation !== rotation) this.sizeCache = undefined;
    const size = dumpRootScreen(xml);
    this.dumpScreen = size ? { at: Date.now(), serial: this.serial, size } : undefined;
  }

  async tapXY(x: number, y: number): Promise<void> {
    await this.adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  }

  async pressXY(x: number, y: number, ms: number): Promise<void> {
    // Same-point swipe with a duration. It registers on RN views that ignore instant taps.
    const sx = String(Math.round(x));
    const sy = String(Math.round(y));
    await this.adb(['shell', 'input', 'swipe', sx, sy, sx, sy, String(Math.round(ms))]);
  }

  canDeliverText(text: string): TextDeliverability {
    return adbTextDeliverability(text);
  }

  async inputText(text: string): Promise<void> {
    // `input text` cannot deliver characters outside printable ASCII (Unicode, newline, tab):
    // the device-side shell/IME drops or mangles them, so refuse loudly instead of mistyping.
    const verdict = adbTextDeliverability(text);
    if (!verdict.ok) throw new Error(verdict.reason);
    // Empty text: nothing to type, and `input text` with no argument is a usage error.
    if (!text) return;
    // `adb shell` space-joins its args into one string the DEVICE-side sh re-parses, so every
    // shell-significant character needs a backslash escape (escapeAdbInputText). A literal
    // "%s" can't be escaped for `input text`, so it is split across calls (adbInputTextChunks).
    for (const chunk of adbInputTextChunks(text)) {
      const escaped = escapeAdbInputText(chunk);
      try {
        // H2: the argv IS the (possibly secret) text, so never let it into the error message.
        await this.adb(['shell', 'input', 'text', escaped], { sensitiveLastArg: true });
      } catch (e) {
        let msg = String((e as Error)?.message ?? e);
        for (const v of [escaped, chunk, text]) if (v.length >= 3 && msg.includes(v)) msg = msg.split(v).join('«redacted»');
        // cause: the spawn error is already argv-redacted (redactArgs), so it's safe to chain.
        throw new Error(`adb input text failed (${text.length} chars, value withheld): ${msg}`, { cause: e });
      }
    }
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
      'shell',
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(ms),
    ]);
  }

  private sizeCache?: { at: number; epoch: number; serial?: string; rotation: number; size: { width: number; height: number } };

  /** Current-axes screen size, cached for SCREEN_SIZE_TTL_MS (and until invalidateScreenSizeCache
   * for this device, e.g. after a Swipium orientation change, or until a dump reports a different
   * rotation). Without a cache, a fresh dump's [0,0]-anchored root answers for free. Failures are
   * never cached. */
  async screenSize(): Promise<{ width: number; height: number } | null> {
    const c = this.sizeCache;
    if (c && c.serial === this.serial && c.epoch === epochOf(this.serial) && Date.now() - c.at < SCREEN_SIZE_TTL_MS) return { ...c.size };
    const ds = this.dumpScreen;
    if (ds && ds.serial === this.serial && Date.now() - ds.at < DUMP_SCREEN_FRESH_MS) return { ...ds.size };
    const epoch = epochOf(this.serial);
    const read = await this.readScreenSize();
    this.sizeCache = read ? { at: Date.now(), epoch, serial: this.serial, rotation: read.rotation, size: read.size } : undefined;
    return read ? { ...read.size } : null;
  }

  private async readScreenSize(): Promise<{ size: { width: number; height: number }; rotation: number } | null> {
    try {
      const r = await this.adb(['shell', 'wm', 'size']);
      // prefer "Override size:" if present, else "Physical size:"
      const m = r.stdout.match(/Override size:\s*(\d+)x(\d+)/) ?? r.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
      if (!m) return null;
      const size = { width: Number(m[1]), height: Number(m[2]) };
      // `wm size` reports the NATURAL orientation; swap for a 90°/270° rotation so gestures
      // and keyboard/obstruction geometry use the current screen axes.
      const rotation = await this.rotation();
      return { rotation, size: rotation % 2 === 1 ? { width: size.height, height: size.width } : size };
    } catch {
      return null;
    }
  }

  /** Current display rotation 0-3 (0 when unknown). */
  async rotation(): Promise<number> {
    try {
      const r = await this.adb(['shell', 'dumpsys', 'input'], { timeoutMs: 8000 });
      return parseInputRotation(r.stdout) ?? 0;
    } catch {
      return 0;
    }
  }

  /** On-screen soft-keyboard rect (dumpsys window InputMethod), or null when unknown/hidden. */
  async imeFrame(): Promise<[number, number, number, number] | null> {
    try {
      const r = await this.adb(['shell', 'dumpsys', 'window', 'InputMethod'], { timeoutMs: 8000 });
      return parseImeFrame(r.stdout);
    } catch {
      return null;
    }
  }

  /** Hide the soft keyboard: BACK only while the IME is actually shown (BACK otherwise navigates). */
  async hideKeyboard(): Promise<boolean> {
    if (!(await this.imeShown())) return false;
    await this.pressKey('back');
    return true;
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
    // Single-quoted for the device shell: `a=1&b=2` or spaces would otherwise split/background.
    await this.adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', deviceShellQuote(url)]);
  }

  async disableAnimations(): Promise<void> {
    for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
      await this.adb(['shell', 'settings', 'put', 'global', k, '0']);
    }
  }
}
