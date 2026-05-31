// Minimal zero-dependency PNG decode (PHASE3-PLAN §8). Device screenshots come from
// `screencap -p` as non-interlaced 8-bit truecolor(+alpha) PNGs, so we support exactly that
// (color types 2 and 6, bit depth 8, interlace 0) and error clearly on anything else. Uses
// Node's built-in zlib — no image library, no third-party code.

import { inflateSync } from 'node:zlib';

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
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
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
        case 0: val = cur; break;
        case 1: val = cur + a; break;
        case 2: val = cur + b; break;
        case 3: val = cur + ((a + b) >> 1); break;
        case 4: val = cur + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter} at row ${y}`);
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
