// Cheap pixel fingerprint of the screen (liveness check): a sparse sample grid of a raw framebuffer,
// used to answer "has the screen changed since the snapshot?" without a ~2 s UI-tree dump.
//
// Input is Android `screencap` WITHOUT -p: a 12 or 16 byte header (width, height, format
// [, colorspace] as little-endian u32) followed by width*height pixels (4 bytes for RGBA_8888).
// The status bar band (clock, notification icons, battery) is skipped, so a ticking clock never
// reads as a change. PURE.

/** Fraction of the screen height skipped at the top (status bar). */
export const PIXEL_TOP_SKIP = 0.04;
/** Sample every Nth pixel in x and y (1080x2400 gives about 40k samples). */
export const PIXEL_STRIDE = 8;
/** A sample counts as changed when any channel differs by more than this. */
export const PIXEL_CHANNEL_TOLERANCE = 8;
/** Screens are "unchanged" when at most this fraction of samples changed (a blinking caret). */
export const PIXEL_CHANGED_MAX_RATIO = 0.002;

export interface PixelFingerprint {
  width: number;
  height: number;
  /** Bytes per pixel of the source framebuffer. */
  bpp: number;
  /** Sampled pixel bytes, row-major over the sample grid. */
  samples: Uint8Array;
}

/** Parse a raw screencap buffer into a sampled fingerprint; undefined when the layout is unknown. */
export function fingerprintRawScreencap(buf: Buffer, stride = PIXEL_STRIDE, topSkip = PIXEL_TOP_SKIP): PixelFingerprint | undefined {
  if (buf.length < 16) return undefined;
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const px = width * height;
  if (!width || !height || px > 50_000_000) return undefined;
  let header = 0;
  let bpp = 0;
  for (const h of [16, 12]) {
    const body = buf.length - h;
    if (body > 0 && body % px === 0 && body / px >= 2 && body / px <= 4) {
      header = h;
      bpp = body / px;
      break;
    }
  }
  if (!bpp) return undefined;
  const y0 = Math.ceil(height * topSkip);
  const cols = Math.ceil(width / stride);
  const rows = Math.ceil((height - y0) / stride);
  const samples = new Uint8Array(cols * rows * bpp);
  let o = 0;
  for (let y = y0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const p = header + (y * width + x) * bpp;
      for (let c = 0; c < bpp; c++) samples[o++] = buf[p + c];
    }
  }
  return { width, height, bpp, samples };
}

/** Fraction of samples that differ (1 when the geometry differs). */
export function pixelChangeRatio(a: PixelFingerprint, b: PixelFingerprint, tolerance = PIXEL_CHANNEL_TOLERANCE): number {
  if (a.width !== b.width || a.height !== b.height || a.bpp !== b.bpp || a.samples.length !== b.samples.length) return 1;
  const n = a.samples.length / a.bpp;
  if (!n) return 1;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < a.bpp; c++) {
      const j = i * a.bpp + c;
      if (Math.abs(a.samples[j] - b.samples[j]) > tolerance) {
        changed++;
        break;
      }
    }
  }
  return changed / n;
}

/** True when two fingerprints show the same screen (within PIXEL_CHANGED_MAX_RATIO). */
export function samePixels(a: PixelFingerprint, b: PixelFingerprint): boolean {
  return pixelChangeRatio(a, b) <= PIXEL_CHANGED_MAX_RATIO;
}
