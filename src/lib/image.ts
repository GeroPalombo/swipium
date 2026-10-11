// Local, deterministic visual ops: baseline diff + template matching on
// decoded pixels. No AI, no network, no third-party code: just arithmetic over PNG bytes.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, pngSize, toGray } from './png.js';
import { run } from './spawn.js';

export interface DiffResult {
  comparable: boolean;
  reason?: string;
  ratio: number; // fraction of pixels that changed (0..1)
  changedPixels: number;
  total: number;
  box: { x: number; y: number; width: number; height: number } | null; // bounding box of changes
}

/** Per-pixel diff of two same-size screenshots. A pixel "changed" if any channel differs by > tol. */
export function imageDiff(aBuf: Buffer, bBuf: Buffer, tol = 32): DiffResult {
  const a = decodePng(aBuf);
  const b = decodePng(bBuf);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      comparable: false,
      reason: `size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`,
      ratio: 1,
      changedPixels: 0,
      total: 0,
      box: null,
    };
  }
  const { width, height } = a;
  const ca = a.channels;
  const cb = b.channels;
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pa = (y * width + x) * ca;
      const pb = (y * width + x) * cb;
      if (
        Math.abs(a.data[pa] - b.data[pb]) > tol ||
        Math.abs(a.data[pa + 1] - b.data[pb + 1]) > tol ||
        Math.abs(a.data[pa + 2] - b.data[pb + 2]) > tol
      ) {
        changed++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const total = width * height;
  return {
    comparable: true,
    ratio: changed / total,
    changedPixels: changed,
    total,
    box: maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}

export interface MatchResult {
  found: boolean;
  score: number; // 0..1, higher = better
  // center of the best match, in SCREENSHOT pixels (convert to device px via coordinateSpace.scale)
  x: number;
  y: number;
}

function downscaleGray(g: Uint8Array, w: number, h: number, factor: number): { g: Uint8Array; w: number; h: number } {
  const nw = Math.max(1, Math.floor(w / factor));
  const nh = Math.max(1, Math.floor(h / factor));
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) out[y * nw + x] = g[Math.min(h - 1, y * factor) * w + Math.min(w - 1, x * factor)];
  }
  return { g: out, w: nw, h: nh };
}

/**
 * Locate `templateBuf` within `screenBuf` by sum-of-absolute-differences on downscaled
 * grayscale (best-effort; returns a confidence score the caller can threshold). Returns the
 * match CENTER in screenshot pixels. Bounded so it stays fast on phone-sized screenshots.
 */
export function findTemplate(screenBuf: Buffer, templateBuf: Buffer, minScore = 0.85): MatchResult {
  const s = decodePng(screenBuf);
  const t = decodePng(templateBuf);
  // Downscale the screen to ~200px wide for speed; scale the template by the same factor.
  const factor = Math.max(1, Math.ceil(s.width / 200));
  const sg = downscaleGray(toGray(s), s.width, s.height, factor);
  const tg = downscaleGray(toGray(t), t.width, t.height, factor);
  if (tg.w < 1 || tg.h < 1 || tg.w > sg.w || tg.h > sg.h) {
    return { found: false, score: 0, x: -1, y: -1 };
  }
  const stride = tg.w * tg.h > 400 ? 2 : 1; // coarse search for larger templates
  let best = Infinity;
  let bx = 0;
  let by = 0;
  const maxSad = tg.w * tg.h * 255;
  for (let y = 0; y + tg.h <= sg.h; y += stride) {
    for (let x = 0; x + tg.w <= sg.w; x += stride) {
      let sad = 0;
      for (let ty = 0; ty < tg.h && sad < best; ty++) {
        const srow = (y + ty) * sg.w + x;
        const trow = ty * tg.w;
        for (let tx = 0; tx < tg.w; tx++) sad += Math.abs(sg.g[srow + tx] - tg.g[trow + tx]);
      }
      if (sad < best) {
        best = sad;
        bx = x;
        by = y;
      }
    }
  }
  const score = 1 - best / maxSad;
  // center back in full-resolution screenshot pixels
  const cx = Math.round((bx + tg.w / 2) * factor);
  const cy = Math.round((by + tg.h / 2) * factor);
  return { found: score >= minScore, score: Math.round(score * 1000) / 1000, x: cx, y: cy };
}

// ---- Inline images (qa_screenshot inline:true, qa_get_artifact mode:"inline") ----

/** Long edge an inline image is downscaled to: what Claude resizes larger images to anyway, so
 * bigger pixels only cost bytes and tokens. */
export const INLINE_IMAGE_MAX_EDGE = 1568;

/** `_meta` for inline image content blocks: Codex reads codex/imageDetail (default "high"). */
export const INLINE_IMAGE_META = { 'codex/imageDetail': 'auto' } as const;

export interface InlineImage {
  data: Buffer;
  mime: string;
  width: number | null;
  height: number | null;
  /** inline px per original px (1 when not resized). Divide inline coordinates by it to get
   * original (screenshot) pixels. */
  scale: number;
  resized: boolean;
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Prepare image bytes for an inline content block: a PNG whose long edge exceeds
 * INLINE_IMAGE_MAX_EDGE is downscaled to it as JPEG with macOS `sips` when available; anything
 * else (other hosts, other formats, sips failing) is returned unchanged with scale 1.
 */
export async function prepareInlineImage(buf: Buffer, mime: string, maxEdge = INLINE_IMAGE_MAX_EDGE): Promise<InlineImage> {
  const size = mime === 'image/png' ? pngSize(buf) : null;
  const same: InlineImage = { data: buf, mime, width: size?.width ?? null, height: size?.height ?? null, scale: 1, resized: false };
  if (!size || Math.max(size.width, size.height) <= maxEdge || process.platform !== 'darwin') return same;
  const dir = mkdtempSync(join(tmpdir(), 'swipium-inline-'));
  try {
    const src = join(dir, 'in.png');
    const out = join(dir, 'out.jpg');
    writeFileSync(src, buf);
    const r = await run('sips', ['-Z', String(maxEdge), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', src, '--out', out], {
      timeoutMs: 10_000,
    });
    if (r.code !== 0) return same;
    const data = readFileSync(out);
    const dims = jpegSize(data);
    if (!dims) return same;
    return {
      data,
      mime: 'image/jpeg',
      width: dims.width,
      height: dims.height,
      scale: Math.round((dims.width / size.width) * 10000) / 10000,
      resized: true,
    };
  } catch {
    return same;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One text line describing an inline image's pixel mapping back to the original. */
export function inlineScaleLine(img: InlineImage, original: { width: number; height: number } | null): string {
  if (!img.resized) return `inline image: original size${img.width ? ` ${img.width}x${img.height}` : ''} (scale 1)`;
  return (
    `inline image: ${img.width}x${img.height} JPEG, downscaled from ${original?.width}x${original?.height} (scale ${img.scale}); ` +
    `divide inline image coordinates by ${img.scale} to get screenshot pixels`
  );
}
