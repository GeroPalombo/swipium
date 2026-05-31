// Screen signatures (Phase 3.3 §6.4). Identify a screen so revisiting Home dedupes to one node
// while a modal becomes a distinct node. Layered: structured (UI tree) when available, visual
// (screenshot hash) when the tree is poor, plus context (foreground + modal/keyboard). PURE.

import { createHash } from 'node:crypto';
import type { SnapshotElement } from '../drivers/Driver.js';

export interface SignatureContext {
  foreground?: string;
  modalPresent?: boolean;
  keyboardShown?: boolean;
}

function short(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function ctxSuffix(ctx: SignatureContext): string {
  return `${ctx.foreground ?? ''}|${ctx.modalPresent ? 'modal' : ''}|${ctx.keyboardShown ? 'kbd' : ''}`;
}

/**
 * Structured signature: stable ids + normalized visible text + a coarse element-count bucket. Text
 * is included but bucketed/sorted so transient toasts don't shift identity; ids dominate when present.
 */
export function structuredSignature(elements: SnapshotElement[], ctx: SignatureContext = {}): string {
  const ids = [...new Set(elements.map((e) => e.id).filter(Boolean))].sort();
  const labels = [...new Set(elements.map((e) => (e.label || e.text || '').trim().toLowerCase()).filter((t) => t.length > 0 && t.length <= 40))].sort();
  // Coarse count bucket so one extra list row doesn't fork the screen identity.
  const bucket = Math.min(10, Math.floor(elements.length / 5));
  const body = `ids:${ids.join(',')}|labels:${labels.slice(0, 25).join(',')}|n:${bucket}`;
  return `struct:${short(body + '|' + ctxSuffix(ctx))}`;
}

/**
 * Visual signature: screen dimensions + a cheap content hash of the screenshot bytes (sampled).
 * Not a perceptual hash — good enough to dedupe an unchanged canvas/map screen across revisits.
 */
export function visualSignature(png: Buffer, screen: { width: number; height: number }, ctx: SignatureContext = {}): string {
  // Sample bytes across the buffer so a large PNG hashes quickly and stably.
  const step = Math.max(1, Math.floor(png.length / 4096));
  let sample = '';
  for (let i = 0; i < png.length; i += step) sample += png[i].toString(16);
  return `visual:${short(`${screen.width}x${screen.height}|${png.length}|${short(sample)}|${ctxSuffix(ctx)}`)}`;
}
