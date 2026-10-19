// Record health findings into the session for qa_report.
// Shared by qa_act (auto after each action) and qa_check_health (on demand). Carries the
// native/app layer + visible-text evidence, and (for app-layer error surfaces) captures
// ONE screenshot as evidence and attaches its URI to those findings.

import type { SessionStore, Session } from '../session/store.js';
import type { Driver } from '../drivers/Driver.js';
import { isMetroRequiredFinding, launchErrorSurface, type Finding } from './health.js';
import { parseSnapshot, type RawNode } from '../snapshot/parse.js';
import { iosAlertCancel } from '../snapshot/overlays.js';
import { isAbortError } from '../lib/abortScope.js';

export async function recordHealthFindings(
  sessions: SessionStore,
  session: Session,
  findings: Finding[],
  driver?: Driver,
  screen?: string,
): Promise<void> {
  // Capture one screenshot of an app-layer error surface (RedBox / error-boundary / etc.)
  // so the report shows WHAT broke, not just that something did. Evidence, not budgeted.
  let evidenceUri: string | undefined;
  const appError = findings.find((f) => f.layer === 'app' && (f.severity === 'high' || f.severity === 'medium'));
  // Sensitive mode: record the finding but DON'T capture pixels.
  if (appError && driver && !session.sensitive) {
    try {
      const png = await driver.screenshot();
      evidenceUri = sessions.saveArtifact(
        session,
        'screenshot',
        `app-error-${Date.now()}.png`,
        png,
        'image/png',
        `app-health: ${appError.kind}`,
      );
    } catch {
      /* best-effort; evidence is a bonus, not required */
    }
  }

  // Crash / ANR / "process gone" findings: attach the log excerpt (FATAL EXCEPTION stack or
  // ANR block from logcat's main/system/crash buffers), not just the dialog text.
  const crashLike = findings.find((f) => f.layer === 'native' && f.severity === 'high' && CRASH_KIND_RE.test(`${f.kind} ${f.detail}`));
  const logUri = crashLike && driver ? await captureCrashLog(sessions, session, driver, crashLike.kind) : undefined;
  // Also on the caller's finding, so the qa_check_health / qa_act response links the excerpt
  // instead of leaving it findable only through qa_report's Evidence list.
  if (crashLike && logUri && !crashLike.logUri) crashLike.logUri = logUri;

  for (const f of findings) {
    if (f.severity === 'info') continue;
    const screenshotUri = f.layer === 'app' ? (f.screenshotUri ?? evidenceUri) : f.screenshotUri;
    const findingLog = f.logUri ?? (f === crashLike ? logUri : undefined);
    sessions.addFinding(session, {
      at: Date.now(),
      severity: f.severity,
      kind: f.kind,
      detail: f.detail,
      layer: f.layer,
      evidence: f.evidence,
      screen,
      screenshotUri,
      ...(findingLog ? { logUri: findingLog } : {}),
      // A bundle-load RedBox / Expo dev launcher means "no JS bundle": METRO_REQUIRED (environment),
      // not a generic REDBOX app regression.
      ...(isMetroRequiredFinding(f) ? { failureCode: 'METRO_REQUIRED' as const } : {}),
    });
  }
}

/** After a prepare launch, read ONE UI tree and look for an RN/Expo launch error
 *  screen. A bundle-load RedBox / the Expo dev launcher marks the session not tested with
 *  METRO_REQUIRED (an environment blocker, cleared by a later Swipium outcome, so a qa_note pass
 *  can't turn it into a tested run); any other RedBox is recorded as the same app finding
 *  qa_check_health records. The same tree also names an iOS alert left on top of the app
 *  (prepare said "ready" under a SpringBoard "Sign in to your Apple Account" alert).
 *  Best-effort: a failed dump is no verdict. */
export async function checkLaunchErrorSurface(
  sessions: SessionStore,
  session: Session,
  driver: Driver,
): Promise<{ appError?: Finding; alert?: string }> {
  let nodes: RawNode[];
  try {
    nodes = parseSnapshot(await driver.dumpXml()).allNodes;
  } catch (e) {
    if (isAbortError(e)) throw e;
    return {};
  }
  const alertTitle = iosAlertCancel(nodes)?.title;
  const alert = alertTitle === undefined ? undefined : alertTitle || 'untitled alert';
  const f = launchErrorSurface(nodes);
  if (!f) return alert ? { alert } : {};
  if (isMetroRequiredFinding(f)) {
    session.notTested = {
      reason: 'the app launched without its JS bundle (RedBox / Expo dev launcher after the launch: METRO_REQUIRED)',
      failureCode: 'METRO_REQUIRED',
      at: Date.now(),
    };
    sessions.persist(session);
  } else await recordHealthFindings(sessions, session, [f], driver);
  return { appError: f, ...(alert ? { alert } : {}) };
}

/** "the app shows <detail> ("<evidence>")" for a checkLaunchErrorSurface finding. */
export function launchErrorText(f: Finding): string {
  return `the app shows ${f.detail}${f.evidence ? ` ("${f.evidence.slice(0, 80)}")` : ''}`;
}

const CRASH_KIND_RE = /native_crash|\banr\b|possible crash/i;
const CRASH_START_RE = /FATAL EXCEPTION|ANR in |am_anr|am_crash|Fatal signal \d+/;
// Swipium's own processes in logcat (the uiautomator dump runs as `app_process` uid 2000): their
// AndroidRuntime start/stop lines matched the crash fallback and buried the real evidence.
const SWIPIUM_NOISE_RE = /RuntimeInit uid 2000|com\.android\.commands\.|uiautomator/i;

/** threadtime `MM-DD HH:MM:SS.mmm  PID  TID L TAG: msg` > PID. */
function logPid(line: string): string | undefined {
  return line.match(/^\d\d-\d\d\s+\S+\s+(\d+)\s+\d+\s/)?.[1];
}

/** Log lines minus Swipium's own uiautomator / shell processes (every line of their pids). */
function withoutSwipiumNoise(log: string): string[] | undefined {
  if (!log.trim()) return undefined;
  const lines = log.split('\n');
  const noisy = new Set(
    lines
      .filter((l) => SWIPIUM_NOISE_RE.test(l))
      .map(logPid)
      .filter((p): p is string => !!p),
  );
  return lines.filter((l) => !SWIPIUM_NOISE_RE.test(l) && !noisy.has(logPid(l) ?? ''));
}

/** The last crash / ANR block, preferring the app under test's (`Process: <appId>` right after the
 *  FATAL line); undefined when the log has none. `appOnly`: only the app's own block counts (the
 *  crash buffer keeps other processes' and older crashes). */
function crashBlock(log: string, appId?: string, appOnly = false): string | undefined {
  const lines = withoutSwipiumNoise(log);
  if (!lines) return undefined;
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!CRASH_START_RE.test(lines[i])) continue;
    if (start < 0) start = i;
    if (appId && lines.slice(i, i + 4).some((l) => l.includes(appId))) {
      start = i;
      break;
    }
    if (!appId) break;
  }
  if (start < 0 || (appOnly && appId && !lines.slice(start, start + 4).some((l) => l.includes(appId)))) return undefined;
  // The block only: from its start line to the next crash start, so an older tombstone's tail or a
  // later crash never leaks in. A Java crash is also limited to the crashed pid's lines; a
  // native tombstone is not (its backtrace is logged by crash_dump/DEBUG under another pid).
  let end = start + 1;
  while (end < lines.length && end < start + 120 && !CRASH_START_RE.test(lines[end])) end++;
  let block = lines.slice(start, end);
  const pid = /FATAL EXCEPTION/.test(lines[start]) ? logPid(lines[start]) : undefined;
  if (pid) block = block.filter((l) => !logPid(l) || logPid(l) === pid);
  return block.join('\n');
}

// One log capture per session per class (crash / ANR) and window: qa_act re-runs health after every
// action while a crash dialog stays up, and each would otherwise pull logcat again. A repeat inside
// the window reuses the captured excerpt, so the later finding (a qa_act after qa_check_health, or
// "process gone" after the crash dialog) still links it. A crash reuses it only while
// the crash buffer's newest FATAL block is the same one: a second crash (new pid / time) inside the
// window gets its own excerpt. The crash-buffer read is small; the wide main-buffer
// read is what the window saves.
const lastLogCapture = new WeakMap<Session, Map<string, { at: number; uri?: string; block?: string }>>();
const LOG_CAPTURE_WINDOW_MS = 30_000;

async function captureCrashLog(sessions: SessionStore, session: Session, driver: Driver, kind: string): Promise<string | undefined> {
  if (session.sensitive) return undefined; // sensitive mode persists no device output beyond findings
  if (driver.kind !== 'direct' && driver.kind !== 'remote') return undefined; // logcat is Android-only
  const seen = lastLogCapture.get(session) ?? new Map<string, { at: number; uri?: string; block?: string }>();
  const anr = /\banr\b/i.test(kind);
  const key = anr ? 'anr' : 'crash';
  const block = anr
    ? undefined
    : await driver.logcat(400, undefined, { buffer: 'crash' }).then(
        (log) => crashBlock(log, session.appId, true),
        () => undefined,
      );
  const last = seen.get(key);
  if (last && Date.now() - last.at < LOG_CAPTURE_WINDOW_MS && last.block === block) return last.uri;
  const entry: { at: number; uri?: string; block?: string } = { at: Date.now(), block };
  seen.set(key, entry);
  lastLogCapture.set(session, seen);
  entry.uri = await readCrashLog(sessions, session, driver, kind, block);
  return entry.uri;
}

async function readCrashLog(
  sessions: SessionStore,
  session: Session,
  driver: Driver,
  kind: string,
  fromCrash?: string,
): Promise<string | undefined> {
  try {
    // The crash buffer's block (read by the caller: it keeps the FATAL stack however much the app
    // logs after crashing), else a wide window of the default buffers (ANR blocks live there).
    const main = fromCrash ? undefined : withoutSwipiumNoise(await driver.logcat(3000));
    let excerpt = fromCrash ?? (main ? crashBlock(main.join('\n'), session.appId) : undefined);
    if (!excerpt && main)
      excerpt = main
        .filter((l) => /AndroidRuntime|ActivityManager.*(ANR|crash|died|Process .* has died)|DEBUG\s*:|libc\s*:/i.test(l))
        .slice(-120)
        .join('\n');
    if (!excerpt?.trim()) return undefined;
    return sessions.saveArtifact(
      session,
      'logcat',
      `crash-${kind}-${Date.now()}.txt`,
      excerpt,
      'text/plain',
      `health: ${kind} log excerpt`,
    );
  } catch {
    return undefined; // evidence is best-effort
  }
}
