// PNG encoder and report-thumbnail downscale: round trips, aspect ratio, real device fixtures
// (Android screencap, iOS simctl, iOS WDA), undecodable input and the embedded-size budget.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodePng, downscalePng, encodePngRgb, pngSize } from '../src/lib/png.js';

const FIXTURES = join(__dirname, 'fixtures', 'png');
const REAL = [
  { name: 'android-screencap-redbox-1344x2992.png', width: 1344, height: 2992 },
  { name: 'ios-simctl-redbox-1206x2622.png', width: 1206, height: 2622 },
  { name: 'ios-wda-map-home-1206x2622.png', width: 1206, height: 2622 },
];
const readFixture = (name: string) => readFileSync(join(FIXTURES, name));

/** A screenshot-like synthetic image: flat bands, a gradient and some noise so it isn't trivial. */
function syntheticRgb(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 3);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (y < height / 10) {
        px[i] = 30;
        px[i + 1] = 30;
        px[i + 2] = 40;
      } else if ((y >> 6) % 2 === 0) {
        px[i] = (x * 255) / width;
        px[i + 1] = (y * 255) / height;
        px[i + 2] = 128;
      } else {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        px[i] = 240 + (seed & 7);
        px[i + 1] = 240;
        px[i + 2] = 245;
      }
    }
  }
  return px;
}

/** Build a PNG with arbitrary IHDR fields (filter 0 rows) to exercise the unsupported paths. */
function rawPng(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace: number,
  rowBytes: number,
  raw?: Buffer,
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // CRC unchecked by the decoder
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  raw ??= Buffer.alloc(height * (rowBytes + 1));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('encodePngRgb', () => {
  it('round trips exact pixels through decodePng', () => {
    const w = 37;
    const h = 23;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < px.length; i++) px[i] = (i * 31 + (i >> 5)) & 0xff;
    const png = encodePngRgb(w, h, px);
    expect(pngSize(png)).toEqual({ width: w, height: h });
    const img = decodePng(png);
    expect(img.width).toBe(w);
    expect(img.height).toBe(h);
    expect(img.channels).toBe(3);
    expect(Buffer.compare(img.data, Buffer.from(px))).toBe(0);
  });

  it('writes valid chunk CRCs', async () => {
    const { crc32 } = await import('node:zlib');
    const png = encodePngRgb(4, 4, new Uint8Array(48).fill(200));
    let pos = 8;
    while (pos < png.length) {
      const len = png.readUInt32BE(pos);
      expect(png.readUInt32BE(pos + 8 + len)).toBe(crc32(png.subarray(pos + 4, pos + 8 + len)));
      pos += 12 + len;
    }
    expect(pos).toBe(png.length);
  });
});

describe('downscalePng', () => {
  it('downscales a 1440x3120 image to 480 px wide with the same aspect ratio', () => {
    const src = encodePngRgb(1440, 3120, syntheticRgb(1440, 3120));
    const times: number[] = [];
    let out: Buffer | null = null;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      out = downscalePng(src, 480);
      times.push(performance.now() - t);
    }
    console.log(`downscale 1440x3120 > 480: ${times.map((t) => t.toFixed(0)).join(', ')} ms, ${out?.length} bytes`);
    expect(out).not.toBeNull();
    const img = decodePng(out!);
    expect(img.width).toBe(480);
    expect(Math.abs(img.height - (3120 * 480) / 1440)).toBeLessThanOrEqual(1);
  });

  it('averages pixels (box filter) and composites alpha on white', () => {
    // 2x2 RGBA: opaque black, transparent, opaque white, half-transparent black > one pixel.
    // Each row: filter byte 0, then RGBA pixels.
    const raw = Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 128]);
    const withPixels = rawPng(2, 2, 8, 6, 0, 8, raw);
    const out = downscalePng(withPixels, 1);
    expect(out).not.toBeNull();
    const img = decodePng(out!);
    expect([img.width, img.height, img.channels]).toEqual([1, 1, 3]);
    // black 0, transparent > white 255, white 255, 50% black > ~127: mean ~159
    expect(Math.abs(img.data[0] - 159)).toBeLessThanOrEqual(1);
    expect(img.data[0]).toBe(img.data[1]);
    expect(img.data[1]).toBe(img.data[2]);
  });

  it('re-encodes images already narrower than the target as RGB without resizing', () => {
    const px = syntheticRgb(100, 200);
    const out = downscalePng(encodePngRgb(100, 200, px), 480);
    expect(out).not.toBeNull();
    const img = decodePng(out!);
    expect([img.width, img.height, img.channels]).toEqual([100, 200, 3]);
    expect(Buffer.compare(img.data, Buffer.from(px))).toBe(0);
  });

  for (const fx of REAL) {
    it(`decodes and downscales the real ${fx.name}`, () => {
      const src = readFixture(fx.name);
      const full = decodePng(src);
      expect([full.width, full.height]).toEqual([fx.width, fx.height]);
      const t = performance.now();
      const out = downscalePng(src, 480);
      const ms = performance.now() - t;
      expect(out).not.toBeNull();
      const img = decodePng(out!);
      expect(img.width).toBe(480);
      expect(Math.abs(img.height - (fx.height * 480) / fx.width)).toBeLessThanOrEqual(1);
      console.log(`${fx.name}: ${src.length} > ${out!.length} bytes (${Math.ceil(out!.length / 3) * 4} base64), ${ms.toFixed(0)} ms`);
    });
  }

  it('returns null for undecodable input and never throws', () => {
    const good = readFixture(REAL[1].name);
    const cases: Record<string, Buffer> = {
      empty: Buffer.alloc(0),
      garbage: Buffer.from('definitely not a png, just some bytes here'),
      'signature only': good.subarray(0, 8),
      truncated: good.subarray(0, Math.floor(good.length / 2)),
      'corrupt IDAT': (() => {
        const b = Buffer.from(good);
        b.fill(0xab, 200, 4000);
        return b;
      })(),
      '16-bit RGB': rawPng(4, 4, 16, 2, 0, 4 * 6),
      interlaced: rawPng(4, 4, 8, 2, 1, 4 * 3),
      palette: rawPng(4, 4, 8, 3, 0, 4),
      'zero size': rawPng(0, 0, 8, 2, 0, 0),
      'absurd size': rawPng(100000, 100000, 8, 2, 0, 0),
    };
    for (const [name, buf] of Object.entries(cases)) {
      let out: Buffer | null | undefined;
      expect(() => (out = downscalePng(buf, 480)), name).not.toThrow();
      expect(out, name).toBeNull();
    }
  });

  it('keeps 40 real-size screenshots under 8 MB of base64', () => {
    const sources = REAL.map((f) => readFixture(f.name));
    let total = 0;
    for (let i = 0; i < 40; i++) {
      const out = downscalePng(sources[i % sources.length], 480);
      expect(out).not.toBeNull();
      total += out!.toString('base64').length;
    }
    console.log(`40 thumbnails: ${(total / 1024 / 1024).toFixed(2)} MB base64`);
    expect(total).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe('decompression bomb', () => {
  // 1x1 RGB header, but the IDAT inflates to 64 MB of zeros (a few tens of KB on disk).
  const BOMB_BYTES = 64 * 1024 * 1024;
  const bomb = rawPng(1, 1, 8, 2, 0, 3, Buffer.alloc(BOMB_BYTES));

  it('downscalePng returns null fast without inflating the whole stream', () => {
    expect(bomb.length).toBeLessThan(BOMB_BYTES / 100);
    const before = process.memoryUsage().arrayBuffers;
    const t0 = performance.now();
    expect(downscalePng(bomb, 480)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
  });

  it('decodePng throws on a bomb and on image data shorter than the header promises', () => {
    expect(() => decodePng(bomb)).toThrow(/corrupt PNG/);
    expect(() => decodePng(rawPng(4, 4, 8, 2, 0, 12, Buffer.alloc(10)))).toThrow(/corrupt PNG/);
    // An exact-size stream still decodes.
    expect(decodePng(rawPng(4, 4, 8, 2, 0, 12)).width).toBe(4);
  });
});
