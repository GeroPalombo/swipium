// Bounded wait-for-render after a launch. React Native / Expo debug builds show a splash and a
// "Bundling 47%…" / "Downloading 100%…" / "Connect to Metro to develop JavaScript" banner for
// several seconds before the real UI exists. Judging that screen (smoke baseline, first-run
// classification, exploration) produced false PASSes and "no actionable elements" tool blockers.
//
// Structured backends: re-dump until the loading markers are gone and the tree has content (an
// interactive control, or content on two dumps in a row). A rendered screen that keeps changing
// (an animated map / globe) is accepted: only a loading marker or a blank tree keeps the wait
// going, and a timeout on either is NOT ready. The app's own JS loading screen (a splash
// container id, a "Loading…" caption) is a loading marker too. Visual-only backends (no tree): wait until two consecutive screenshots
// are byte-identical (the progress banner changes while bundling). Always bounded.

import { isTextFieldClass, parseSnapshot } from './parse.js';
import type { Driver } from '../drivers/Driver.js';
import { isAbortError } from '../lib/abortScope.js';

/** RN/Expo loading surfaces that mean "the app's JS has not rendered yet". A bare "Bundling" only
 *  counts with a percent or a trailing ellipsis, so app copy doesn't match. */
export const RN_LOADING_RE =
  /\b(?:bundling|downloading)\s+\d{1,3}(?:\.\d+)?\s*%|\bbundling\s*(?:…|\.\.\.)|loading from (?:metro|localhost|\d{1,3}(?:\.\d{1,3}){3})|connect to metro to develop|downloading javascript bundle|building javascript bundle|new update available, downloading/i;

/** The app's own JS loading screen: a short caption that is only a loading message
 *  ("Loading…", "Downloading...", "Looking for your plane in the sky…"), or a splash container id
 *  (`nav.splash`, `splash_screen`). Only judged on a screen with almost no controls, so a feed's
 *  "Loading more…" row or a leftover splash id under the real UI doesn't hold the wait. */
const APP_LOADING_TEXT_RE =
  /^(?:loading|downloading|refreshing|please wait|looking for|fetching|preparing|getting ready|starting up)\b.{0,60}(?:…|\.\.\.)$/i;
/** These openings are also real, waiting-for-something screens ("Looking for nearby
 *  devices…" on a pairing screen, "Fetching your rides…"). Such a caption is a loading screen only
 *  when it is ALL the screen shows: no control and no other text. */
const WEAK_LOADING_TEXT_RE = /^(?:looking for|fetching|preparing|getting ready|starting up)\b/i;
const SPLASH_ID_RE = /(?:^|[^a-z])splash(?:screen|view|container)?(?:[^a-z]|$)/i;
/** At most this many controls on a screen still read as a loading screen (a dev LogBox toast or a
 *  skip / cancel button can sit on top of one). */
const LOADING_SCREEN_MAX_CONTROLS = 2;

export interface RenderWaitResult {
  /** false when an RN loading marker, or a blank tree (splash only), was still showing at the
   *  timeout (structured tree). */
  ready: boolean;
  waitedMs: number;
  /** Why it stopped waiting (ready / timeout / visual_only_stable / no_tree). `no_tree` with
   *  ready:false means no UI tree was ever read: nothing was judged either way. */
  reason: string;
  /** The loading text still visible when the wait timed out. */
  loadingText?: string;
  /** The tree never showed any content beyond the root (blank / splash screen) before the timeout. */
  blank?: boolean;
  /** The last UI tree read (structured backends), so callers don't dump the same screen again. */
  xml?: string;
}

/** The default bound of one render wait (a loading screen, or a blank tree while Metro serves). */
export const RENDER_WAIT_MS = 30_000;
// A cold Metro bundle keeps the splash up for 10-20 s; image-only first screens pay this once.
const EMPTY_TREE_WAIT_MS = 15_000;
const VISUAL_WAIT_MS = 8_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function treeState(xml: string): { content: number; interactive: number; loadingText?: string } {
  const nodes = parseSnapshot(xml).allNodes;
  let content = 0;
  let interactive = 0;
  let loadingText: string | undefined;
  let caption: string | undefined;
  let splash: string | undefined;
  const labels: string[] = [];
  nodes.forEach((n, i) => {
    const label = `${n.text} ${n.desc}`.trim();
    if (!loadingText && RN_LOADING_RE.test(label)) loadingText = label.slice(0, 80);
    // The root is not content: the iOS Application node always carries the app name, even on the
    // splash. A text field counts as interactive even when WDA leaves it unhittable.
    if (i === 0) return;
    // text and desc are often the same string on iOS: test each, not the joined label.
    if (!caption) caption = [n.text, n.desc].find((s) => APP_LOADING_TEXT_RE.test(s))?.slice(0, 80);
    if (!splash && SPLASH_ID_RE.test(n.id)) splash = `splash screen (${n.id.slice(0, 60)})`;
    if (label || n.clickable) content++;
    if (n.clickable || n.longClickable || n.scrollable || isTextFieldClass(n.cls)) interactive++;
    for (const s of [n.text, n.desc]) if (s.trim()) labels.push(s.trim());
  });
  // A weak caption counts only alone: every other text on the screen is part of it (iOS repeats the
  // caption on its container) and there is no control.
  if (caption && WEAK_LOADING_TEXT_RE.test(caption) && (interactive > 0 || labels.some((s) => !caption!.includes(s)))) caption = undefined;
  if (!loadingText && (caption || splash) && interactive <= LOADING_SCREEN_MAX_CONTROLS) loadingText = caption ?? splash;
  return { content, interactive, loadingText };
}

/**
 * Wait (bounded) until the launched app has rendered. Only waits when the first look says it has
 * NOT (a loading marker is visible, or the tree is blank); a normal rendered screen returns after
 * one dump, and does not have to stop changing. Never throws except on cancellation.
 */
export async function waitForAppRender(
  d: Driver,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    visualOnly?: boolean;
    /** Asked once when a blank tree reaches its short bound: true (Metro is serving, so a cold
     *  bundle may still be building) keeps waiting up to the full timeout. */
    metroProbe?: () => Promise<boolean>;
  } = {},
): Promise<RenderWaitResult> {
  const timeoutMs = opts.timeoutMs ?? RENDER_WAIT_MS;
  const pollMs = opts.pollMs ?? 800;
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;

  if (!opts.visualOnly) {
    let prevRendered = false;
    let loadingText: string | undefined;
    let blank = false;
    let first = true;
    let sawTree = false;
    let xml: string | undefined;
    let blankBound = Math.min(timeoutMs, EMPTY_TREE_WAIT_MS);
    let probed = !opts.metroProbe;
    while (true) {
      let st: ReturnType<typeof treeState> | undefined;
      try {
        const dumped = await d.dumpXml({ timeoutMs: Math.max(2000, Math.min(10_000, timeoutMs - elapsed())) });
        st = treeState(dumped);
        xml = dumped;
        sawTree = true;
      } catch (e) {
        if (isAbortError(e)) throw e;
        // No tree this time (animated / idle-timeout). After a rendered dump that is the app's own
        // screen: ready. Before any tree was read it proves nothing, so keep polling within the
        // bound instead of calling a splash "ready".
        if (prevRendered) return { ready: true, waitedMs: elapsed(), reason: 'no_tree', ...(xml ? { xml } : {}) };
      }
      if (st) {
        loadingText = st.loadingText;
        blank = st.content === 0;
        const looksRendered = !st.loadingText && !blank;
        // Rendered = content with a control on it, or content on two dumps in a row (the content may
        // differ between them: animated screens never produce two identical dumps).
        if (looksRendered && (first || prevRendered || st.interactive > 0))
          return { ready: true, waitedMs: elapsed(), reason: 'ready', xml };
        prevRendered = looksRendered;
        first = false;
      }
      // A blank tree with no loading copy (splash / image-only first screen) gets a shorter bound,
      // unless Metro is serving: a cold bundle keeps the native splash up past it.
      if (!loadingText && !probed && elapsed() + pollMs > blankBound) {
        probed = true;
        if (await opts.metroProbe!().catch(() => false)) blankBound = timeoutMs;
      }
      const bound = loadingText ? timeoutMs : blankBound;
      if (elapsed() + pollMs > bound) {
        if (!sawTree) return { ready: false, waitedMs: elapsed(), reason: 'no_tree' };
        // Still loading, or still blank: NOT ready (a splash used to be judged as the app). Content
        // that only appeared on the last dump counts as rendered.
        const ready = !loadingText && !blank;
        return {
          ready,
          waitedMs: elapsed(),
          reason: 'timeout',
          ...(loadingText ? { loadingText } : {}),
          ...(!loadingText && blank ? { blank: true } : {}),
          xml,
        };
      }
      await sleep(pollMs);
    }
  }
  return waitForStableScreenshot(d, t0, timeoutMs, pollMs);
}

async function waitForStableScreenshot(d: Driver, t0: number, timeoutMs: number, pollMs: number): Promise<RenderWaitResult> {
  const elapsed = () => Date.now() - t0;
  let prev: Buffer | undefined;
  // Visual-only: no text to read, so a shorter bound (the loading banner animates while bundling).
  const bound = Math.min(timeoutMs, VISUAL_WAIT_MS);
  while (elapsed() < bound) {
    let png: Buffer;
    try {
      png = await d.screenshot();
    } catch (e) {
      if (isAbortError(e)) throw e;
      return { ready: true, waitedMs: elapsed(), reason: 'no_screenshot' };
    }
    if (prev && prev.equals(png)) return { ready: true, waitedMs: elapsed(), reason: 'visual_only_stable' };
    prev = png;
    await sleep(Math.max(pollMs, 1000));
  }
  // Never a verdict in visual-only mode (an animated screen never stabilizes): only a bounded wait.
  return { ready: true, waitedMs: elapsed(), reason: 'visual_only_unstable' };
}
