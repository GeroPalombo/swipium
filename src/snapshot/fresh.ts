// Session snapshot bookkeeping: stable @eN refs across dumps (X3) and ONE freshness rule (X1/P2):
// a stored snapshot is reusable only while it is young AND no action ran since it was taken.

import type { DumpOptions, Driver } from '../drivers/Driver.js';
import type { LastSnapshot, Session } from '../session/store.js';
import { parseSnapshot, signature, subtreeLabel, toElement, type ParsedSnapshot, type RawNode } from './parse.js';
import { screenFingerprint } from './settle.js';
import { samePixels, type PixelFingerprint } from '../lib/screenFingerprint.js';
import { runWithSignal } from '../lib/abortScope.js';

/** A ref target older than this is re-checked against a fresh dump before acting (X1). */
export const REF_FRESH_MS = 1500;
/** text/id resolution and flows reuse the stored snapshot while younger than this (P2). */
export const SNAPSHOT_REUSE_MS = 2000;
/** A ref snapshot older than this is always re-dumped, even when the pixels look unchanged (X1). */
export const PIXEL_TRUST_MAX_MS = 60_000;
/** Max center shift (Manhattan px) for a same-key node to keep its ref. */
const REF_KEEP_MAX_SHIFT = 64;

// Screen-changing calls that do not bump counters.actions (openUrl, app launch in flows).
const extraSeq = new WeakMap<Session, number>();
// Highest ref number handed out per session, so a vanished ref is never reused for another node.
const refHigh = new WeakMap<Session, number>();
// Pixel baseline per stored snapshot (X1 liveness), captured right after adoption on drivers with
// pixelFingerprint (Android direct), with the adoption time (`at` moves on each verification).
const baselines = new WeakMap<LastSnapshot, { at: number; fp: Promise<PixelFingerprint | undefined> }>();

/** A ref that dropped out of the session snapshot: the node it named and its label (parse.ts subtreeLabel). */
export interface RetiredRef {
  node: RawNode;
  label: string;
}
/** How many retired refs a session keeps (oldest dropped first). */
export const RETIRED_REFS_MAX = 200;
// Retired refs per session (X1), for the app they were seen in. Cleared when the app changes or
// ref numbering restarts (no prior snapshot), since an old ref could then name a new node.
const retired = new WeakMap<Session, { appId?: string; refs: Map<string, RetiredRef> }>();

/** The node a ref named before a later snapshot replaced it (same app), else undefined. */
export function retiredRef(session: Session, ref: string): RetiredRef | undefined {
  const bin = retired.get(session);
  return bin && bin.appId === session.appId ? bin.refs.get(ref) : undefined;
}

function retire(session: Session, prior: LastSnapshot | undefined, next: Map<string, RawNode>): void {
  let bin = retired.get(session);
  if (!prior || !bin || bin.appId !== session.appId) {
    bin = { appId: session.appId, refs: new Map() };
    retired.set(session, bin);
    return;
  }
  for (const [ref, node] of prior.fullByRef) {
    if (next.has(ref)) continue;
    bin.refs.delete(ref); // re-insert at the end (newest)
    bin.refs.set(ref, { node, label: node.label ?? subtreeLabel(node, prior.allNodes) });
  }
  for (const ref of bin.refs.keys()) {
    if (bin.refs.size <= RETIRED_REFS_MAX) break;
    bin.refs.delete(ref);
  }
}

/** The session's action counter: counted actions plus uncounted screen mutations. */
export function actionSeq(session: Session): number {
  return (session.counters?.actions ?? 0) + (extraSeq.get(session) ?? 0);
}

/** Mark a screen-changing call that is not counted as an action, so stored snapshots go stale. */
export function noteScreenMutation(session: Session): void {
  extraSeq.set(session, (extraSeq.get(session) ?? 0) + 1);
}

/** The stored snapshot when it is younger than maxAgeMs and no action ran since; else undefined. */
export function freshSnapshot(session: Session, maxAgeMs: number): LastSnapshot | undefined {
  const s = session.lastSnapshot;
  if (!s || s.at === undefined || s.actionSeq === undefined) return undefined;
  if (Date.now() - s.at > maxAgeMs || s.actionSeq !== actionSeq(session)) return undefined;
  return s;
}

/** A stored snapshot as a ParsedSnapshot-shaped view (elements rebuilt from its refs). */
export function snapshotView(s: LastSnapshot): Pick<ParsedSnapshot, 'elements' | 'fullByRef' | 'allNodes'> {
  return { elements: [...s.fullByRef].map(([ref, n]) => toElement(ref, n)), fullByRef: s.fullByRef, allNodes: s.allNodes };
}

function refNum(ref: string): number {
  const m = /^@e(\d+)$/.exec(ref);
  return m ? Number(m[1]) : 0;
}

function shift(a: RawNode, b: RawNode): number {
  return (
    Math.abs(a.bounds[0] + a.bounds[2] - b.bounds[0] - b.bounds[2]) / 2 +
    Math.abs(a.bounds[1] + a.bounds[3] - b.bounds[1] - b.bounds[3]) / 2
  );
}

function sameSlot(a: RawNode, b: RawNode): boolean {
  return a.cls === b.cls && a.id === b.id && sameLabel(a, b) && a.bounds.every((v, i) => Math.abs(v - b.bounds[i]) <= 8);
}

/** A node without its own text/desc (a list row container) must still show the same label: after a
 *  scroll by whole rows another row sits in the same slot under the same structural key. */
function sameLabel(a: RawNode, b: RawNode): boolean {
  return !!(a.text || a.desc || b.text || b.desc) || (a.label ?? '') === (b.label ?? '');
}

/**
 * Re-key `parsed` so a node that was in `prior` keeps its ref: same structural key (parse.ts) with
 * a close position, else the same class + id in (nearly) the same bounds (text changed in place).
 * Every other node gets a new ref above `high`. No prior (first snapshot, or refs reset): the DFS
 * numbering stands. An EMPTY prior still numbers above `high`, so a blank screen never restarts refs. PURE.
 */
export function stabilizeRefs(
  parsed: ParsedSnapshot,
  prior: Map<string, RawNode> | undefined,
  high = 0,
): { parsed: ParsedSnapshot; high: number } {
  if (!prior) return { parsed, high: parsed.elements.length };
  for (const ref of prior.keys()) high = Math.max(high, refNum(ref));
  const byKey = new Map<string, Array<[string, RawNode]>>();
  for (const entry of prior) {
    const k = entry[1].key;
    if (!k) continue;
    const list = byKey.get(k) ?? [];
    list.push(entry);
    byKey.set(k, list);
  }
  const used = new Set<string>();
  const nodes = [...parsed.fullByRef.values()];
  const assigned: Array<string | undefined> = nodes.map((n) => {
    let best: [string, number] | undefined;
    for (const [ref, old] of byKey.get(n.key ?? '') ?? []) {
      const d = shift(n, old);
      if (!used.has(ref) && d <= REF_KEEP_MAX_SHIFT && sameLabel(n, old) && (!best || d < best[1])) best = [ref, d];
    }
    if (best) used.add(best[0]);
    return best?.[0];
  });
  nodes.forEach((n, i) => {
    if (assigned[i]) return;
    for (const [ref, old] of prior) {
      if (!used.has(ref) && sameSlot(n, old)) {
        used.add(ref);
        assigned[i] = ref;
        return;
      }
    }
  });
  const fullByRef = new Map<string, RawNode>();
  const elements = nodes.map((n, i) => {
    const ref = assigned[i] ?? `@e${++high}`;
    fullByRef.set(ref, n);
    return { ...parsed.elements[i], ref };
  });
  return { parsed: { ...parsed, elements, fullByRef }, high };
}

/** Adopt a parsed dump as the session's snapshot: stable refs + capture time + action counter. */
export function adoptSnapshot(session: Session, parsed: ParsedSnapshot): ParsedSnapshot {
  const prior = session.lastSnapshot?.fullByRef;
  const r = stabilizeRefs(parsed, prior, prior ? (refHigh.get(session) ?? 0) : 0);
  refHigh.set(session, r.high);
  retire(session, session.lastSnapshot, r.parsed.fullByRef);
  const snap: LastSnapshot = {
    fullByRef: r.parsed.fullByRef,
    signatures: new Set(r.parsed.elements.map(signature)),
    allNodes: r.parsed.allNodes,
    at: Date.now(),
    actionSeq: actionSeq(session),
  };
  session.lastSnapshot = snap;
  // Background (no latency, not tied to the call's cancellation): a raw screencap as the baseline
  // for unchangedSinceSnapshot. Taken just AFTER the dump, so a change during the dump's last few
  // hundred ms is missed, a narrower window than the REF_FRESH_MS trust it extends.
  const d = session.driver;
  if (d?.pixelFingerprint) {
    baselines.set(snap, { at: snap.at!, fp: runWithSignal(undefined, () => d.pixelFingerprint!()).catch(() => undefined) });
  }
  return r.parsed;
}

/**
 * X1 liveness: is the screen pixel-identical (status bar excluded, lib/screenFingerprint.ts) to
 * when the stored snapshot was adopted? Only when no action ran since, the snapshot was adopted
 * less than PIXEL_TRUST_MAX_MS ago and it has a baseline. One raw screencap (~130 ms on Android)
 * instead of a ~2 s dump. Any doubt (no baseline, capture failed, changed pixels) answers false.
 * True refreshes the snapshot's `at` (verified current now), so the action's settle can still use
 * it as the pre-action screen (preActionFingerprint, P1).
 */
export async function unchangedSinceSnapshot(session: Session): Promise<boolean> {
  const s = session.lastSnapshot;
  const d = session.driver;
  const base = s && baselines.get(s);
  if (!s || !base || !d?.pixelFingerprint) return false;
  if (Date.now() - base.at > PIXEL_TRUST_MAX_MS || s.actionSeq !== actionSeq(session)) return false;
  const before = await base.fp;
  if (!before) return false;
  const now = await d.pixelFingerprint().catch(() => undefined);
  // Re-check: a concurrent action (job) may have run during the capture.
  const same = !!now && session.lastSnapshot === s && s.actionSeq === actionSeq(session) && samePixels(before, now);
  if (same) s.at = Date.now();
  return same;
}

/** Dump, parse and adopt in one step. */
export async function snapshotNow(session: Session, d: Driver, opts?: DumpOptions): Promise<ParsedSnapshot> {
  return adoptSnapshot(session, parseSnapshot(await d.dumpXml(opts)));
}

/** Fingerprint of the stored snapshot when it is a recent PRE-action view (taken within
 *  PRE_ACTION_MAX_AGE_MS, at most one action since), for settle's fast accept; undefined otherwise (P1 then stays 2-dump). */
export function preActionFingerprint(session: Session): string | undefined {
  const s = session.lastSnapshot;
  if (!s?.at || Date.now() - s.at > PRE_ACTION_MAX_AGE_MS) return undefined;
  // Taken right before THIS action (at most one action/mutation since), not before an earlier one.
  if (s.actionSeq === undefined || actionSeq(session) - s.actionSeq > 1) return undefined;
  return screenFingerprint(s.fullByRef.values());
}

/** A stored snapshot older than this is not trusted as the pre-action screen. */
export const PRE_ACTION_MAX_AGE_MS = 5000;
