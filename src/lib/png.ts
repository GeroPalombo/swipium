// Minimal zero-dependency PNG decode. Device screenshots come from
// `screencap -p` as non-interlaced 8-bit truecolor(+alpha) PNGs, so we support exactly that
// (color types 2 and 6, bit depth 8, interlace 0) and error clearly on anything else. Uses
// Node's built-in zlib. No image library, no third-party code. Also a tiny RGB encoder and a
// box-filter downscale for report thumbnails (bottom of file).

import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface DecodedImage {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Buffer; // row-major, `channels` bytes per pixel
}

/** Read width/height from the IHDR without decoding pixels (for the coordinate-space audit). */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null; // PNG signature
  // IHDR data starts at byte 16 (after 8-byte sig + 4 len + 4 type)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): DecodedImage {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4; // skip data + CRC
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}); expected 8-bit truecolor`);
  }
  const channels: 3 | 4 = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  // Cap the inflate at exactly what the header promises: a tiny file can otherwise inflate to
  // hundreds of MB (decompression bomb) before we ever look at it.
  const expected = height * (stride + 1);
  if (width < 1 || height < 1) throw new Error(`corrupt PNG: ${width}x${height}`);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (e) {
    throw new Error(`corrupt PNG: image data does not inflate to ${width}x${height} (${(e as Error).message})`, {
      cause: e,
    });
  }
  if (raw.length !== expected) throw new Error(`corrupt PNG: image data is ${raw.length} bytes, expected ${expected}`);
  const out = Buffer.allocUnsafe(height * stride);

  // Un-filter each scanline (PNG filter types 0..4), reconstructing in place.
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const o = y * stride;
    const po = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++];
      const a = x >= channels ? out[o + x - channels] : 0; // left
      const b = y > 0 ? out[po + x] : 0; // up
      const c = x >= channels && y > 0 ? out[po + x - channels] : 0; // up-left
      let val: number;
      switch (filter) {
        case 0:
          val = cur;
          break;
        case 1:
          val = cur + a;
          break;
        case 2:
          val = cur + b;
          break;
        case 3:
          val = cur + ((a + b) >> 1);
          break;
        case 4:
          val = cur + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad PNG filter ${filter} at row ${y}`);
      }
      out[o + x] = val & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Convert a decoded image to a grayscale Uint8Array (one byte per pixel). */
export function toGray(img: DecodedImage): Uint8Array {
  const { width, height, channels, data } = img;
  const g = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += channels) {
    // Rec.601 luma
    g[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
  }
  return g;
}

// --- Encode + downscale (report thumbnails) ---

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode 8-bit RGB pixels (row-major, 3 bytes per pixel) as a PNG. Every row uses the Sub
 *  filter, which compresses flat UI screenshots well without per-row filter selection. */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  if (rgb.length < stride * height) throw new Error('encodePngRgb: pixel buffer too small');
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const s = y * stride;
    raw[o] = 1; // Sub
    for (let x = 0; x < stride; x++) {
      raw[o + 1 + x] = (rgb[s + x] - (x >= 3 ? rgb[s + x - 3] : 0)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Refuse absurd dimensions before allocating: a real phone screenshot is well under this.
const MAX_DOWNSCALE_PIXELS = 40_000_000;

/** Box-filter (area average) downscale to at most `maxWidth` px wide, keeping the aspect ratio,
 *  re-encoded as RGB with alpha composited on white. Images already narrow enough are still
 *  re-encoded so the output is consistently small. Returns null for anything the decoder can't
 *  handle (16-bit, interlaced, palette, corrupt); never throws. */
export function downscalePng(png: Buffer, maxWidth: number): Buffer | null {
  try {
    const size = pngSize(png);
    if (!size || size.width < 1 || size.height < 1 || size.width * size.height > MAX_DOWNSCALE_PIXELS) return null;
    const img = decodePng(png);
    const { width: w, height: h, channels, data } = img;
    if (data.length < w * h * channels) return null;
    const ow = Math.max(1, Math.min(Math.floor(maxWidth), w));
    const oh = Math.max(1, Math.round((h * ow) / w));

    // Source column > output column, and the number of source columns per output column.
    const colOut = new Uint32Array(w);
    for (let x = 0; x < w; x++) colOut[x] = Math.min(ow - 1, Math.floor((x * ow) / w));
    const colCount = new Uint32Array(ow);
    for (let x = 0; x < w; x++) colCount[colOut[x]]++;

    const out = new Uint8Array(ow * oh * 3);
    const acc = new Float64Array(ow * 3);
    let sy = 0;
    for (let oy = 0; oy < oh; oy++) {
      const yEnd = Math.max(sy + 1, Math.min(h, Math.round(((oy + 1) * h) / oh)));
      acc.fill(0);
      for (let y = sy; y < yEnd; y++) {
        let p = y * w * channels;
        for (let x = 0; x < w; x++, p += channels) {
          let r = data[p];
          let g = data[p + 1];
          let b = data[p + 2];
          if (channels === 4) {
            const a = data[p + 3];
            if (a !== 255) {
              const inv = 255 - a;
              r = (r * a + 255 * inv) / 255;
              g = (g * a + 255 * inv) / 255;
              b = (b * a + 255 * inv) / 255;
            }
          }
          const o = colOut[x] * 3;
          acc[o] += r;
          acc[o + 1] += g;
          acc[o + 2] += b;
        }
      }
      const rows = yEnd - sy;
      const base = oy * ow * 3;
      for (let ox = 0; ox < ow; ox++) {
        const n = colCount[ox] * rows;
        const o = ox * 3;
        out[base + o] = Math.round(acc[o] / n);
        out[base + o + 1] = Math.round(acc[o + 1] / n);
        out[base + o + 2] = Math.round(acc[o + 2] / n);
      }
      sy = yEnd;
    }
    return encodePngRgb(ow, oh, out);
  } catch {
    return null;
  }
}
