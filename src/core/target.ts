// Shared target resolution (PHASE3-PLAN §2.3 core extraction). Both qa_act and the flow
// runner resolve a target the SAME way — extracting it here is the "one IR, no drift" rule:
// a ref | selector | coords becomes a tappable point with the resolved @eN (for obstruction
// checks) and secure-field awareness (for redaction). Selector resolution re-snapshots and
// updates session.lastSnapshot, exactly as before.

import { parseSnapshot, signature } from '../snapshot/parse.js';
import { isSecureNode } from '../lib/redact.js';
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
  ref?: string; // resolved @eN (ref AND selector targets) — used for obstruction lookup
  textLen?: number;
  secure?: boolean;
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

export async function resolveTarget(session: Session, target?: Target): Promise<Point | { error: string }> {
  if (target?.x != null && target?.y != null) return { x: target.x, y: target.y, via: 'coords' };

  if (target?.ref) {
    const node = session.lastSnapshot?.fullByRef.get(target.ref);
    if (!node) return { error: `No ${target.ref} in the latest snapshot — run qa_snapshot first (refs invalidate after navigation).` };
    return { ...center(node.bounds), via: target.ref, ref: target.ref, textLen: node.text.length, secure: isSecureNode(node) };
  }

  if (target?.text || target?.id) {
    const parsed = parseSnapshot(await session.driver!.dumpXml());
    session.lastSnapshot = { fullByRef: parsed.fullByRef, signatures: new Set(parsed.elements.map(signature)), allNodes: parsed.allNodes };
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
    if (!cands.length) {
      return {
        error: `No element matched selector ${JSON.stringify(target)}${screenMismatch ? ' (recorded screen signature differs from current screen)' : ''}.`,
      };
    }
    if (target.id && cands.length > 1 && target.index == null) {
      const labels = cands.map((e) => `${e.ref}:${e.role}:${e.text ?? e.label ?? e.id ?? 'unlabeled'}`).join(', ');
      return {
        error: `AMBIGUOUS_SELECTOR: resource-id ${target.id} matched ${cands.length} elements (${labels}); add text/class/bounds hints or an explicit index${screenMismatch ? ' (recorded screen signature differs from current screen)' : ''}.`,
      };
    }
    const el = cands[target.index ?? 0] ?? cands[0];
    return { ...center(el.bounds), via: `selector(${el.ref})`, ref: el.ref, textLen: el.text?.length, secure: el.secure };
  }

  return { error: 'No target provided. Use { ref } | { text|id } | { x, y }.' };
}
