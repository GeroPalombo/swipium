// Shared target resolution (core extraction). Both qa_act and the flow
// runner resolve a target the SAME way. Extracting it here is the "one IR, no drift" rule:
// a ref | selector | coords becomes a tappable point with the resolved @eN (for obstruction
// checks) and secure-field awareness (for redaction). Selector resolution reuses a just-settled
// snapshot or re-snapshots (updating session.lastSnapshot); a ref read from a stale snapshot is
// re-found by identity in a fresh dump (snapshot/fresh.ts holds the one freshness rule), unless
// a pixel check shows the screen has not changed since (Android).

import { isTextFieldClass, signature, type ParsedSnapshot, type RawNode } from '../snapshot/parse.js';
import {
  freshSnapshot,
  REF_FRESH_MS,
  retiredRef,
  SNAPSHOT_REUSE_MS,
  snapshotNow,
  snapshotView,
  unchangedSinceSnapshot,
} from '../snapshot/fresh.js';
import { presentElements } from '../snapshot/present.js';
import { isSecureNode, makeRedactor } from '../lib/redact.js';
import { sleepOrCancel } from '../lib/abortScope.js';
import type { FailureCode } from '../oracle/failures.js';
import type { Session } from '../session/store.js';
import { createHash } from 'node:crypto';

export interface Target {
  ref?: string;
  text?: string;
  id?: string;
  selector?: string;
  index?: number;
  x?: number;
  y?: number;
  packageName?: string;
  className?: string;
  textHint?: string;
  boundsHint?: string;
  screenSignature?: string;
}

export interface Point {
  x: number;
  y: number;
  via: string;
  ref?: string; // resolved @eN (ref AND selector targets), used for obstruction lookup
  textLen?: number;
  secure?: boolean;
  /** X1: the ref's node moved since the snapshot the agent read; the tap used its new center. */
  refMoved?: boolean;
}

export function resourceIdAliases(id: string): Set<string> {
  const raw = id.trim();
  const short = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw.replace(/^id\//, '');
  const pkgLess = raw.includes(':id/') ? raw.slice(raw.indexOf(':id/') + 4) : short;
  return new Set([raw, short, `id/${short}`, pkgLess].filter(Boolean));
}

export function resourceIdMatches(candidateShort: string | undefined, candidateFull: string | undefined, target: string): boolean {
  const wanted = resourceIdAliases(target);
  const cands = [candidateShort, candidateFull].filter((x): x is string => !!x);
  return cands.some((c) => [...resourceIdAliases(c)].some((alias) => wanted.has(alias)));
}

export function boundsBucket(bounds?: [number, number, number, number]): string | undefined {
  if (!bounds) return undefined;
  const bucket = (n: number) => Math.floor(n / 50) * 50;
  return `${bucket(bounds[0])},${bucket(bounds[1])},${bucket(bounds[2])},${bucket(bounds[3])}`;
}

export function center(b: [number, number, number, number]): { x: number; y: number } {
  return { x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) };
}

export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function screenSignatureFor(parsed: { elements: Array<Parameters<typeof signature>[0]> }): string | undefined {
  const sigs = parsed.elements.map(signature);
  if (!sigs.length) return undefined;
  return createHash('sha1').update(sigs.sort().join('\n')).digest('hex').slice(0, 16);
}

function norm(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}

function applyResourceIdHints<T extends { text?: string; label?: string; role?: string; bounds: [number, number, number, number] }>(
  candidates: T[],
  target: Target,
  rawFor: (
    candidate: T,
  ) => { id?: string; cls?: string; text?: string; desc?: string; bounds?: [number, number, number, number] } | undefined,
): T[] {
  let narrowed = candidates;
  const tryNarrow = (fn: (candidate: T) => boolean) => {
    const next = narrowed.filter(fn);
    if (next.length) narrowed = next;
  };
  if (target.packageName) {
    tryNarrow((candidate) => rawFor(candidate)?.id?.startsWith(`${target.packageName}:id/`) === true);
  }
  if (target.className) {
    const wanted = norm(target.className);
    tryNarrow((candidate) => {
      const raw = rawFor(candidate);
      const cls = norm(raw?.cls);
      return cls === wanted || cls.endsWith(`.${wanted}`) || norm(candidate.role) === wanted;
    });
  }
  if (target.textHint) {
    const wanted = norm(target.textHint);
    tryNarrow((candidate) => {
      const raw = rawFor(candidate);
      return [candidate.text, candidate.label, raw?.text, raw?.desc].some((value) => norm(value) === wanted);
    });
  }
  if (target.boundsHint) {
    tryNarrow((candidate) => boundsBucket(rawFor(candidate)?.bounds ?? candidate.bounds) === target.boundsHint);
  }
  return narrowed;
}

/** Same node across dumps: class + id + desc, and text (except text fields, whose value changes). */
export function sameIdentity(a: RawNode, b: RawNode): boolean {
  return a.cls === b.cls && a.id === b.id && a.desc === b.desc && (isTextFieldClass(a.cls) || a.text === b.text);
}

function pointFor(ref: string, node: RawNode, extra: Partial<Point> = {}): Point {
  return { ...center(node.bounds), via: ref, ref, textLen: node.text.length, secure: isSecureNode(node), ...extra };
}

/** Up to 3 elements that look like the missing node (same id / name / subtree label / class),
 *  nearest first. `label` is the missing node's subtree label when known (a retired ref). */
function staleCandidates(session: Session, old: RawNode, parsed: Pick<ParsedSnapshot, 'elements' | 'fullByRef'>, label?: string): string[] {
  const oc = center(old.bounds);
  const scored = parsed.elements
    .map((e) => {
      const n = parsed.fullByRef.get(e.ref)!;
      const score =
        (old.id && n.id === old.id ? 3 : 0) +
        ((old.text && n.text === old.text) || (old.desc && n.desc === old.desc) || (label && n.label === label) ? 2 : 0) +
        (n.cls === old.cls ? 1 : 0);
      const c = center(n.bounds);
      return { e, score, dist: Math.abs(c.x - oc.x) + Math.abs(c.y - oc.y) };
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score || a.dist - b.dist)
    .slice(0, 3)
    .map((x) => x.e);
  return presentElements(scored, makeRedactor(session.secrets)).lines;
}

/**
 * Re-find a ref's node in a FRESH dump (X1): the same ref when it still names the same node, else
 * the same identity nearest its old position. Polls until waitMs when missing. A moved node is
 * returned with refMoved:true; a missing one is an error with up to 3 look-alike candidates.
 * A retired ref (no longer in the stored snapshot) passes its subtree `label`: the identity must
 * also match that label and be the ONLY such node on screen, else STALE_REF with candidates.
 */
export async function reresolveRef(
  session: Session,
  ref: string,
  old: RawNode,
  opts: { waitMs?: number; context?: string; label?: string } = {},
): Promise<Point | ResolveError> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const oc = center(old.bounds);
  const retired = opts.label !== undefined;
  let ambiguous = 0;
  for (;;) {
    const parsed = await snapshotNow(session, session.driver!);
    const same = parsed.fullByRef.get(ref);
    let hit: [string, RawNode] | undefined = !retired && same && sameIdentity(same, old) ? [ref, same] : undefined;
    if (retired) {
      const matches = [...parsed.fullByRef].filter(([, n]) => sameIdentity(n, old) && (n.label ?? '') === opts.label);
      if (matches.length === 1) return pointFor(matches[0][0], matches[0][1], { refMoved: true });
      ambiguous = matches.length;
    } else if (!hit) {
      let bestDist = Infinity;
      for (const [r, n] of parsed.fullByRef) {
        if (!sameIdentity(n, old)) continue;
        const c = center(n.bounds);
        const dist = Math.abs(c.x - oc.x) + Math.abs(c.y - oc.y);
        if (dist < bestDist) [hit, bestDist] = [[r, n], dist];
      }
    }
    if (hit) {
      const c = center(hit[1].bounds);
      const moved = Math.abs(c.x - oc.x) > 8 || Math.abs(c.y - oc.y) > 8;
      return pointFor(hit[0], hit[1], moved ? { refMoved: true } : {});
    }
    if (Date.now() >= deadline) {
      const candidates = staleCandidates(session, old, parsed, opts.label);
      return {
        error:
          (ambiguous > 1
            ? `${ref} is no longer in the snapshot${opts.context ?? ''} and ${ambiguous} elements now look the same; re-run qa_snapshot.`
            : `${ref} is no longer on screen${opts.context ?? ''}; re-run qa_snapshot.`) +
          (candidates.length ? ` Similar elements now: ${candidates.join(' | ')}` : ''),
        failureCode: 'STALE_REF',
        candidates,
      };
    }
    await sleepOrCancel(Math.min(RESOLVE_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

/** A failed resolution: the message, plus a failure code / candidates when known. */
export interface ResolveError {
  error: string;
  failureCode?: FailureCode;
  candidates?: string[];
}

/** Poll interval while resolveTarget waits for a target (waitMs). */
export const RESOLVE_POLL_MS = 300;
/** Default resolveTarget wait in flows (X2); interactive qa_act uses 0. */
export const FLOW_TARGET_WAIT_MS = 5000;

export async function resolveTarget(session: Session, target?: Target, opts: { waitMs?: number } = {}): Promise<Point | ResolveError> {
  if (target?.x != null && target?.y != null) return { x: target.x, y: target.y, via: 'coords' };

  if (target?.ref) {
    const node = session.lastSnapshot?.fullByRef.get(target.ref);
    if (!node) {
      // A ref a later snapshot replaced (an action, a scroll): re-find it by identity, or STALE_REF + candidates.
      const gone = retiredRef(session, target.ref);
      if (gone)
        return reresolveRef(session, target.ref, gone.node, {
          waitMs: opts.waitMs,
          label: gone.label,
          context: ' (replaced by a later snapshot)',
        });
      return { error: `No ${target.ref} in the latest snapshot. Run qa_snapshot first (refs invalidate after navigation).` };
    }
    // X1: a ref read from an old snapshot (or one taken before the last action) is re-checked.
    // Aged only (no action since): an unchanged screen (one raw screencap on Android) keeps it.
    if (freshSnapshot(session, REF_FRESH_MS) || (await unchangedSinceSnapshot(session))) return pointFor(target.ref, node);
    return reresolveRef(session, target.ref, node, { waitMs: opts.waitMs });
  }

  if (target?.text || target?.id) {
    const deadline = Date.now() + (opts.waitMs ?? 0);
    // P2: a just-settled snapshot (young, no action since) is reused instead of dumping again.
    const cached = freshSnapshot(session, SNAPSHOT_REUSE_MS);
    let parsed: Pick<ParsedSnapshot, 'elements' | 'fullByRef'> = cached
      ? snapshotView(cached)
      : await snapshotNow(session, session.driver!);
    let fromCache = !!cached;
    for (;;) {
      const r = matchSelector(parsed, target);
      if (r) return r;
      // A miss on the cached snapshot always gets one fresh dump; then poll until the deadline.
      if (!fromCache && Date.now() >= deadline) break;
      if (!fromCache) await sleepOrCancel(Math.min(RESOLVE_POLL_MS, Math.max(1, deadline - Date.now())));
      parsed = await snapshotNow(session, session.driver!);
      fromCache = false;
    }
    const screenMismatch = target.screenSignature && screenSignatureFor(parsed) !== target.screenSignature;
    return {
      error: `No element matched selector ${JSON.stringify(target)}${screenMismatch ? ' (recorded screen signature differs from current screen)' : ''}.`,
    };
  }

  return { error: 'No target provided. Use { ref } | { text|id } | { x, y }.' };
}

/** Match a text/id selector on one snapshot: a point, an AMBIGUOUS_SELECTOR error, or undefined (no match). */
function matchSelector(parsed: Pick<ParsedSnapshot, 'elements' | 'fullByRef'>, target: Target): Point | ResolveError | undefined {
  const screenMismatch = target.screenSignature && screenSignatureFor(parsed) !== target.screenSignature;
  const t = target.text?.toLowerCase();
  const idCands = target.id
    ? parsed.elements.filter((e) => {
        const raw = e.ref ? parsed.fullByRef.get(e.ref) : undefined;
        return resourceIdMatches(e.id, raw?.id, target.id!);
      })
    : [];
  const textCands =
    !target.id && t ? parsed.elements.filter((e) => e.text?.toLowerCase().includes(t) || e.label?.toLowerCase().includes(t)) : [];
  let cands = target.id ? idCands : textCands;
  if (target.id && cands.length > 1 && target.index == null) {
    cands = applyResourceIdHints(cands, target, (candidate) => parsed.fullByRef.get(candidate.ref));
  }
  if (!cands.length) return undefined;
  if (target.id && cands.length > 1 && target.index == null) {
    const labels = cands.map((e) => `${e.ref}:${e.role}:${e.text ?? e.label ?? e.id ?? 'unlabeled'}`).join(', ');
    return {
      error: `AMBIGUOUS_SELECTOR: resource-id ${target.id} matched ${cands.length} elements (${labels}); add text/class/bounds hints or an explicit index${screenMismatch ? ' (recorded screen signature differs from current screen)' : ''}.`,
    };
  }
  const el = cands[target.index ?? 0] ?? cands[0];
  return { ...center(el.bounds), via: `selector(${el.ref})`, ref: el.ref, textLen: el.text?.length, secure: el.secure };
}
