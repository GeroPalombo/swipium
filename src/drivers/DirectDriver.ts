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
import { fingerprintRawScreencap, type PixelFingerprint } from '../lib/screenFingerprint.js';
import { isTextFieldClass, parseSnapshot } from '../snapshot/parse.js';
import { textFieldReadings } from '../core/readBack.js';

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

/** Longest piece of text one `adb shell input text` call sends (AND-14); longer text is split. */
export const ADB_TEXT_PIECE_CHARS = 40;

/** How long one piece of long text may take to show up at the end of the focused field (AND-14). */
const TEXT_PIECE_SETTLE_MS = 4000;

/** Long text is read back after this many pieces (and after the last one), not after each (AND-14). */
const TEXT_PIECES_PER_CHECK = 2;

/** Read-backs in a row that may fail to dump the screen before long text stops checking (R5-1). */
const DUMP_MISSES_BEFORE_OFF = 3;

/** Careful typing (the retry after a scramble, AND-14): a labeled Compose field jumps its caret to
 * the start and drops keys in the middle of one burst, so the retry sends bursts this short, paced,
 * and reads back every CAREFUL_PIECES_PER_CHECK of them. */
const CAREFUL_PIECE_CHARS = 8;
const CAREFUL_PIECES_PER_CHECK = 5;
const CAREFUL_PACE_MS = 250;

/** The select-all clear waits this long after the focusing tap (NEW-replace: 1 s by hand always cleared). */
const CLEAR_AFTER_TAP_MS = 900;

/** PURE: the `input text` pieces for `text`: split at every literal `%s` (adbInputTextChunks), then
 * into pieces of at most `max` chars. A cut is moved back (up to 8 chars) so no piece starts or ends
 * on a space: a space at a piece boundary was dropped by some fields (AND-14). */
export function adbTextPieces(text: string, max = ADB_TEXT_PIECE_CHARS): string[] {
  const out: string[] = [];
  for (const c of adbInputTextChunks(text)) {
    let start = 0;
    while (c.length - start > max) {
      let cut = start + max;
      for (let k = cut; k > start + max - 8 && k > start + 1; k--) {
        if (c[k - 1] !== ' ' && c[k] !== ' ') {
          cut = k;
          break;
        }
      }
      out.push(c.slice(start, cut));
      start = cut;
    }
    if (start < c.length) out.push(c.slice(start));
  }
  return out;
}

/** PURE: the focused text field in a uiautomator dump: its value (textFieldReadings: hint and a
 * Compose label left out), every reading, and whether it is a password field. null when no
 * editable field has focus. */
export function focusedFieldValue(xml: string): { text: string; readings: string[]; password: boolean } | null {
  const node = parseSnapshot(xml, { interactiveOnly: false }).allNodes.find((n) => n.focused && isTextFieldClass(n.cls));
  if (!node) return null;
  const readings = textFieldReadings(node);
  return { text: readings[0], readings, password: node.attrs['password'] === 'true' };
}

/** PURE (AND-14, CR-TYPING): does a field value end with the text typed so far? Case, whitespace
 * runs and trailing spaces are ignored, and an input mask or filter that only changes punctuation
 * or spacing still counts (letters and digits compared alone). */
export function fieldEndsWithTyped(value: string, typed: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (norm(value).endsWith(norm(typed))) return true;
  const lt = loose(typed);
  return !!lt && loose(value).endsWith(lt);
}

/** PURE (CR-TYPING): is a field value a non-empty start of the text typed so far (a max length cut
 * it)? Letters and digits only, as in fieldEndsWithTyped. */
export function fieldIsCutTyped(value: string, typed: string): boolean {
  const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const lv = loose(value);
  return !!lv && lv.length < loose(typed).length && loose(typed).startsWith(lv);
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
    this.densityCache = undefined;
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

  async logcat(lines: number, grep?: string, opts: { buffer?: string } = {}): Promise<string> {
    try {
      const r = await this.adb(['logcat', '-d', ...(opts.buffer ? ['-b', opts.buffer] : []), '-t', String(lines)], { timeoutMs: 8000 });
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

  /** The package's launcher activity (`pkg/.Main`) via `cmd package resolve-activity`, or null. */
  private async resolveLaunchComponent(pkg: string): Promise<string | null> {
    const resolved = await this.adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', shellAppId(pkg)], { timeoutMs: 8000 });
    const component = resolved.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    return component && component.includes('/') ? component : null;
  }

  async launchApp(pkg: string): Promise<void> {
    // `am start -W` with the resolved launcher activity returns once the activity is drawn, so
    // callers poll the foreground briefly instead of sleeping. Same intent shape as a launcher tap
    // (MAIN/LAUNCHER, NEW_TASK|RESET_TASK_IF_NEEDED): a running app's task is brought forward,
    // not restarted. monkey stays the fallback when resolution or `am start` fails.
    const component = await this.resolveLaunchComponent(pkg).catch((e) => {
      if (isAbortError(e)) throw e;
      return null;
    });
    if (component) {
      try {
        const r = await this.adb(
          [
            'shell',
            'am',
            'start',
            '-W',
            '-a',
            'android.intent.action.MAIN',
            '-c',
            'android.intent.category.LAUNCHER',
            '-f',
            '0x10200000',
            '-n',
            deviceShellQuote(component),
          ],
          { timeoutMs: 30000 },
        );
        if (!/^Error/m.test(r.stdout)) return;
      } catch (e) {
        if (isAbortError(e)) throw e;
      }
    }
    await this.adb(['shell', 'monkey', '-p', shellAppId(pkg), '-c', 'android.intent.category.LAUNCHER', '1']);
  }

  async relaunchCleanTask(pkg: string): Promise<void> {
    // LOG-12: force-stop alone leaves the app's task alive when another package's activity tops
    // it (Settings > search is a settings.intelligence activity in Settings' task), and a launcher
    // intent (RESET_TASK_IF_NEEDED) brings that stale task back. -S force-stops first, and
    // NEW_TASK|CLEAR_TASK (0x10008000) wipes the task before the launcher activity starts.
    const component = await this.resolveLaunchComponent(pkg).catch((e) => {
      if (isAbortError(e)) throw e;
      return null;
    });
    if (component) {
      try {
        const r = await this.adb(
          [
            'shell',
            'am',
            'start',
            '-W',
            '-S',
            '-a',
            'android.intent.action.MAIN',
            '-c',
            'android.intent.category.LAUNCHER',
            '-f',
            '0x10008000',
            '-n',
            deviceShellQuote(component),
          ],
          { timeoutMs: 30000 },
        );
        if (!/^Error/m.test(r.stdout)) return;
      } catch (e) {
        if (isAbortError(e)) throw e;
      }
    }
    await this.terminateApp(pkg);
    await this.launchApp(pkg);
  }

  async launchAppWithArgs(pkg: string, args: Record<string, unknown>): Promise<void> {
    const component = await this.resolveLaunchComponent(pkg);
    if (!component) throw new Error(`Could not resolve launch activity for ${pkg}`);
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
    // Filtered on the device: the full dump is tens of KB and only these lines are parsed.
    // `|| true`: grep exits 1 on no match, which must read as 'unknown', not an adb failure.
    const r = await this.adb([
      'shell',
      "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity|mCurrentFocus' || true",
    ]);
    const m = r.stdout.match(/mResumedActivity:.*\{[^}]*\s([^\s/]+\/[^\s}]+)/) || r.stdout.match(/mCurrentFocus=.*\s([^\s/]+\/[^\s}]+)/);
    return m?.[1] ?? 'unknown';
  }

  async foregroundTaskRoot(): Promise<string | undefined> {
    // The resumed activity line ends with its task id (`… pkg/.Act t45}`). That task's block
    // (`Task{… #45 … A=1000:com.android.settings.root …}` / older `TaskRecord{… #45 A=com.x …}`)
    // carries `realActivity=<pkg>/<activity>`: the package whose activity started the task. The
    // `A=` taskAffinity is only a fallback (apps set custom affinities, e.g. `….settings.root`).
    const r = await this.adb([
      'shell',
      "dumpsys activity activities | grep -E 'Task\\{|TaskRecord\\{|realActivity=|mResumedActivity|topResumedActivity' || true",
    ]);
    const t = r.stdout.match(/(?:mResumedActivity|topResumedActivity)[:=]\s*ActivityRecord\{[^}]*\st(\d+)\b/);
    if (!t) return undefined;
    const lines = r.stdout.split('\n');
    const head = new RegExp(`(?:Task|TaskRecord)\\{\\S+ #${t[1]}\\b`);
    const i = lines.findIndex((l) => head.test(l));
    if (i < 0) return undefined;
    for (let j = i + 1; j < lines.length && !/(?:Task|TaskRecord)\{/.test(lines[j]); j++) {
      const real = lines[j].match(/realActivity=\{?([\w.]+)\//);
      if (real) return real[1];
    }
    return lines[i].match(/\bA=(?:\d+:)?([\w.]+)/)?.[1];
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

  /** Raw `screencap` (no PNG encode, ~120 ms on an emulator) sampled into a small fingerprint. */
  async pixelFingerprint(): Promise<PixelFingerprint | undefined> {
    const r = await runBinary('adb', [...this.base(), 'exec-out', 'screencap'], {
      timeoutMs: 5000,
      signal: currentSignal(),
      rejectOnNonZero: true,
    });
    return fingerprintRawScreencap(r.stdout);
  }

  async dumpXml(opts: DumpOptions = {}): Promise<string> {
    // mobile-mcp's proven recipe: exec-out to stdout, retry on the transient
    // "could not get hierarchy" / null-root, strip warning lines before <?xml.
    // Kept modest (5) so a PERSISTENT idle failure (looping animation) surfaces fast and the
    // tool layer can switch to visual-fallback rather than burning ~30 attempts. Callers with a
    // deadline (settle) pass opts.timeoutMs (TOTAL budget, retries included) + fewer attempts.
    const ATTEMPTS = Math.max(1, opts.attempts ?? 5);
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : undefined;
    // Opt-in (SWIPIUM_ANDROID_DUMPER=agent): persistent on-device dumper, ~7x faster. Any
    // failure stops it (it holds the UiAutomation slot exec-out needs) and falls through.
    if (process.env.SWIPIUM_ANDROID_DUMPER) {
      const agent = await import('./androidDumper.js');
      if (agent.androidDumperUsable(this.serial)) {
        try {
          const xml = await agent.agentDump(this.serial, opts.timeoutMs ? Math.min(opts.timeoutMs, 10000) : 10000);
          currentSignal()?.throwIfAborted();
          this.noteDump(xml);
          return xml;
        } catch (e) {
          if (isAbortError(e)) throw e;
          await agent.noteAndroidDumperFailure(this.serial, e);
        }
      }
    }
    let lastErr = '';
    let attempt = 0;
    // AND NEW R4-4: a dump that ran into a full (>= 10 s) adb timeout means the device stopped
    // answering (a stalled emulator), not a transient miss; retrying cost 20 s each (~100 s a call).
    let hung = false;
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
        hung = remaining >= 10000 && /\(timed out\)/.test(lastErr);
      }
      // AND R3-4: "could not get idle state" means uiautomator already waited ~12 s for an idle
      // window that a looping animation never gives; each retry burns the same 12 s (60 s per call).
      // Give up after the first one so the tool layer can fall back (visual / settle deadline).
      const idle = /could not get idle state/i.test(lastErr);
      if (hung) {
        attempt++;
        throw new Error(
          `DEVICE_UNRESPONSIVE: uiautomator dump got no answer within ${Math.round(remaining / 1000)} s ` +
            `(attempt ${attempt}); the device looks stalled. Restart the app, or the emulator if it stays unresponsive.`,
        );
      }
      if (idle || attempt + 1 >= ATTEMPTS || (deadline !== undefined && deadline - Date.now() <= 400)) {
        attempt++;
        break;
      }
      await sleepOrCancel(400);
    }
    const hint =
      /could not get idle state/i.test(lastErr) && !process.env.SWIPIUM_ANDROID_DUMPER
        ? ' (the screen never goes idle, e.g. a looping animation; SWIPIUM_ANDROID_DUMPER=agent dumps such screens without waiting for idle)'
        : '';
    throw new Error(`uiautomator dump failed after ${attempt} attempt(s): ${lastErr}${hint}`);
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

  /** When the last tap went out (clearFocusedText waits CLEAR_AFTER_TAP_MS past it). */
  private lastTapAt = 0;

  async tapXY(x: number, y: number): Promise<void> {
    await this.adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
    this.lastTapAt = Date.now();
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

  async inputText(text: string, opts: { careful?: boolean } = {}): Promise<void> {
    // `input text` cannot deliver characters outside printable ASCII (Unicode, newline, tab):
    // the device-side shell/IME drops or mangles them, so refuse loudly instead of mistyping.
    const verdict = adbTextDeliverability(text);
    if (!verdict.ok) throw new Error(verdict.reason);
    // Empty text: nothing to type, and `input text` with no argument is a usage error.
    if (!text) return;
    // `adb shell` space-joins its args into one string the DEVICE-side sh re-parses, so every
    // shell-significant character needs a backslash escape (escapeAdbInputText). A literal
    // "%s" can't be escaped for `input text`, so it is split across calls (adbTextPieces).
    // Careful (a retry): short bursts, each moved to the end and paced, whatever the text length.
    const careful = !!opts.careful;
    const pieces = adbTextPieces(text, careful ? CAREFUL_PIECE_CHARS : ADB_TEXT_PIECE_CHARS);
    const long = careful || text.length > ADB_TEXT_PIECE_CHARS;
    const perCheck = careful ? CAREFUL_PIECES_PER_CHECK : TEXT_PIECES_PER_CHECK;
    const pace = careful ? CAREFUL_PACE_MS : 300;
    // AND-14: a field whose state round-trips through the app (Compose) can't keep up with one long
    // stream of key events: it moves the caret mid-way, so later parts land first and characters
    // drop. Long text goes out piece by piece, and each piece must read back at the end of the
    // focused field (the dump also waits for the UI to go idle) before the next one is sent. A
    // field that never reads back right fails with TEXT_INPUT_MISMATCH instead of passing.
    let verify = long;
    let typed = '';
    // The field's value at the last good read-back (undefined before the first one), and the
    // pieces sent since then.
    let prev: string | undefined;
    let unchecked: string[] = [];
    // Read-backs in a row that could not dump the screen (R5-1): one is skipped (the pieces stay
    // unchecked for the next read-back), only DUMP_MISSES_BEFORE_OFF in a row turn checking off.
    let dumpMisses = 0;
    const send = async (piece: string) => {
      const escaped = escapeAdbInputText(piece);
      try {
        // Long text: move to the end first, in the same shell call, so each piece goes at the end
        // even if the field moved the caret (or the focus tap put it mid-text).
        const cmd = long ? [...this.moveEndArgs(), ';', 'input', 'text', escaped] : ['input', 'text', escaped];
        // H2: the argv IS the (possibly secret) text, so never let it into the error message.
        await this.adb(['shell', ...cmd], { sensitiveLastArg: true });
      } catch (e) {
        let msg = String((e as Error)?.message ?? e);
        for (const v of [escaped, piece, text]) if (v.length >= 3 && msg.includes(v)) msg = msg.split(v).join('«redacted»');
        // cause: the spawn error is already argv-redacted (redactArgs), so it's safe to chain.
        throw new Error(`adb input text failed (${text.length} chars, value withheld): ${msg}`, { cause: e });
      }
    };
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      await send(piece);
      typed += piece;
      if (!long) continue;
      unchecked.push(piece);
      // No readable focused field (password, or none reports focus): pace the pieces instead. Else
      // read back every TEXT_PIECES_PER_CHECK pieces (CAREFUL_PIECES_PER_CHECK when careful) and
      // after the last one (a uiautomator dump costs about 2 s, AND-14 speed), pacing the pieces in
      // between.
      if (!verify || (unchecked.length < perCheck && i < pieces.length - 1)) {
        await sleepOrCancel(pace);
        continue;
      }
      let held = await this.awaitFieldEndsWith(typed);
      // What was sent since the last read-back landed at the end but lost characters: delete what
      // it added and send it once more.
      if (held === undefined) {
        // Could not dump the screen: skip this check, keep the pieces for the next one.
        if (++dumpMisses >= DUMP_MISSES_BEFORE_OFF) verify = false;
        await sleepOrCancel(pace);
        continue;
      }
      dumpMisses = 0;
      if (held && !held.ok && prev !== undefined && held.text.startsWith(prev) && held.text.length > prev.length) {
        const before = held.text;
        await this.adb(['shell', ...this.moveEndArgs(), ';', 'input', 'keyevent', ...Array(held.text.length - prev.length).fill('67')]);
        for (const [k, p] of unchecked.entries()) {
          if (k) await sleepOrCancel(pace);
          await send(p);
        }
        const again = await this.awaitFieldEndsWith(typed);
        // Unreadable after the resend: the resent pieces stay unchecked for the next read-back.
        if (again === undefined) continue;
        held = again;
        // Cut at the same place twice: the field has a max length. Stop typing; the caller's
        // read-back reports the cut-short value (CR-TYPING).
        if (held && !held.ok && held.text === before && fieldIsCutTyped(held.text, typed)) return;
      }
      // The field holds only a start of the typed text and did not grow: a max length. Stop there and
      // leave the verdict to the caller's read-back. A first cut is confirmed by the next piece
      // adding nothing (dropped input would still add the next piece).
      if (held && !held.ok && fieldIsCutTyped(held.text, typed) && (prev === undefined || held.text === prev)) {
        if (held.text === prev || i === pieces.length - 1) return;
        prev = held.text;
        unchecked = [];
        continue;
      }
      if (held === null) verify = false;
      else if (!held.ok)
        throw new Error(
          `TEXT_INPUT_MISMATCH: after ${typed.length} of ${text.length} chars the focused field does not end with the text typed so far ` +
            `(it holds ${held.text.length} chars); the field reordered or dropped input. The field was left as it is.`,
        );
      else {
        prev = held.text;
        unchecked = [];
      }
    }
  }

  /** Poll the focused field until its value ends with `want` (fieldEndsWithTyped), up to
   * TEXT_PIECE_SETTLE_MS. Returns the last value read and whether it matched. null when no
   * readable field has focus; undefined when the screen could not be dumped (a timeout). */
  private async awaitFieldEndsWith(want: string): Promise<{ ok: boolean; text: string } | null | undefined> {
    const deadline = Date.now() + TEXT_PIECE_SETTLE_MS;
    for (;;) {
      const left = deadline - Date.now();
      let field: ReturnType<typeof focusedFieldValue>;
      try {
        field = focusedFieldValue(await this.dumpXml({ timeoutMs: Math.max(left, 1500), attempts: 2 }));
      } catch (e) {
        if (isAbortError(e)) throw e;
        return undefined; // can't read the screen: don't fail the typing on that
      }
      if (!field || field.password) return null;
      const hit = field.readings.find((r) => fieldEndsWithTyped(r, want));
      if (hit !== undefined) return { ok: true, text: hit };
      if (deadline - Date.now() < 300) return { ok: false, text: field.text };
      await sleepOrCancel(200);
    }
  }

  /** Per device: does `input keycombination` work (Android 13+)? Probed by the first clear. */
  private keyCombo = new Map<string, boolean>();

  /** Shell argv that moves the caret to the end of the TEXT. CTRL+MOVE_END where key combinations
   * work: a plain MOVE_END stops at the end of the caret's line in a multi-line field (CR-TYPING). */
  private moveEndArgs(): string[] {
    return this.keyCombo.get(this.serial ?? '') ? ['input', 'keycombination', '113', '123'] : ['input', 'keyevent', '123'];
  }

  async clearFocusedText(approxLen = 40, opts: { byLength?: boolean } = {}): Promise<void> {
    // R5-2: a retry after a clear that left text uses the by-length clear below, not the same
    // select-all again.
    if (opts.byLength) return this.clearByLength(approxLen);
    // CR-TYPING / AND NEW-2: select all (CTRL+A) then DEL clears the whole field wherever the caret
    // is, whatever the target kind and however long or multi-line the field. Needs Android 13
    // (`input keycombination`); the first clear on a device probes it.
    const serial = this.serial ?? '';
    const combo = this.keyCombo.get(serial);
    // NEW-replace: a tap on a Compose field that already has focus starts a caret-placement
    // gesture whose late handling collapses a select-all sent ~0.5 s after it (1 in 3 clears
    // deleted one char). Send it only once the focusing tap is CLEAR_AFTER_TAP_MS old.
    const sinceTap = Date.now() - this.lastTapAt;
    if (combo !== false && sinceTap < CLEAR_AFTER_TAP_MS) await sleepOrCancel(CLEAR_AFTER_TAP_MS - sinceTap);
    if (combo) {
      await this.adb(['shell', 'input', 'keycombination', '113', '29', ';', 'input', 'keyevent', '67']);
      return;
    }
    if (combo === undefined) {
      let ok = false;
      try {
        const r = await this.adb(['shell', 'input', 'keycombination', '113', '29']);
        ok = !/unknown command|usage:|error/i.test(`${r.stdout}\n${r.stderr}`);
      } catch (e) {
        if (isAbortError(e)) throw e;
      }
      this.keyCombo.set(serial, ok);
      if (ok) {
        await this.adb(['shell', 'input', 'keyevent', '67']);
        return;
      }
    }
    await this.clearByLength(approxLen);
  }

  /** Clear by the field's length: move to the end, then DEL and FORWARD_DEL that many times. */
  private async clearByLength(approxLen: number): Promise<void> {
    // Older Android: read the field's real length (the snapshot's or the caller's guess can be
    // short or stale), then DEL before the caret and FORWARD_DEL (112) after it, so text after
    // the caret's line in a multi-line field goes too. No upper cap. qa_act reads the field back.
    let len = approxLen;
    try {
      const f = focusedFieldValue(await this.dumpXml({ timeoutMs: 5000, attempts: 2 }));
      if (f && !f.password && f.text === '') return;
      if (f) len = Math.max(len, ...f.readings.map((r) => r.length));
    } catch (e) {
      if (isAbortError(e)) throw e;
    }
    const n = Math.max(len + 2, 1);
    // CTRL+MOVE_END first where key combinations work (the end of the text, not of the caret's line).
    const toEnd = this.keyCombo.get(this.serial ?? '') ? ['input', 'keycombination', '113', '123', ';'] : [];
    await this.adb(['shell', ...toEnd, 'input', 'keyevent', '123', ...Array(n).fill('67'), ...Array(n).fill('112')], {
      timeoutMs: 20000 + n * 100,
    });
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

  /** Density cached per bound device (dropped on useDevice); failures are never cached. */
  private densityCache?: { serial?: string; density: number };

  async screenDensity(): Promise<number | null> {
    const c = this.densityCache;
    if (c && c.serial === this.serial) return c.density;
    try {
      const r = await this.adb(['shell', 'wm', 'density']);
      const m = r.stdout.match(/Override density:\s*(\d+)/) ?? r.stdout.match(/Physical density:\s*(\d+)/);
      if (!m) return null;
      this.densityCache = { serial: this.serial, density: Number(m[1]) };
      return this.densityCache.density;
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
