import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function arrayValues(text: string, key: string): string[] {
  const keyIndex = text.indexOf(`<key>${key}</key>`);
  if (keyIndex < 0) return [];
  const array = text.slice(keyIndex).match(/<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
  return [...array.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1].trim()).filter(Boolean);
}

/** PURE: the CFBundleSupportedPlatforms array from an Info.plist's XML text. */
export function parseSupportedPlatforms(plistText: string): string[] {
  return arrayValues(plistText, 'CFBundleSupportedPlatforms');
}

/**
 * PURE: classify a .app's build destination from its CFBundleSupportedPlatforms. A simulator .app
 * lists "iPhoneSimulator"; a device build lists "iPhoneOS". Unknown when neither is present.
 */
export function destinationFromPlatforms(platforms: string[]): 'simulator' | 'device' | 'unknown' {
  const p = platforms.map((x) => x.toLowerCase());
  if (p.some((x) => x.includes('simulator'))) return 'simulator';
  if (p.some((x) => x === 'iphoneos' || x.includes('iphoneos'))) return 'device';
  return 'unknown';
}

/** PURE: parse a binary property list (`bplist00`, what Xcode writes into every built .app) into
 *  plain JS values (dict > object, array > array, string/int/real/bool). Data, dates and UIDs come
 *  back as null. Throws on a malformed file. */
export function parseBinaryPlist(buf: Buffer): unknown {
  if (buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') throw new Error('not a binary plist');
  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6];
  const refSize = buf[trailer + 7];
  const numObjects = Number(buf.readBigUInt64BE(trailer + 8));
  const topObject = Number(buf.readBigUInt64BE(trailer + 16));
  const tableOffset = Number(buf.readBigUInt64BE(trailer + 24));
  const uint = (pos: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
    return v;
  };
  const offsetOf = (ref: number): number => {
    if (ref >= numObjects) throw new Error('bad object ref');
    return uint(tableOffset + ref * offsetSize, offsetSize);
  };
  const read = (ref: number, depth: number): unknown => {
    if (depth > 64) throw new Error('plist too deep');
    const pos = offsetOf(ref);
    const marker = buf[pos];
    const type = marker >> 4;
    const info = marker & 0x0f;
    // Length-carrying objects: a nibble of 0xF means the length follows as an int object.
    const lengthAt = (): { len: number; start: number } => {
      if (info !== 0x0f) return { len: info, start: pos + 1 };
      const size = 1 << (buf[pos + 1] & 0x0f);
      return { len: uint(pos + 2, size), start: pos + 2 + size };
    };
    switch (type) {
      case 0x0:
        return info === 0x09 ? true : info === 0x08 ? false : null;
      case 0x1:
        return uint(pos + 1, 1 << info);
      case 0x2:
        return info === 2 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1);
      case 0x5: {
        const { len, start } = lengthAt();
        return buf.toString('latin1', start, start + len);
      }
      case 0x6: {
        const { len, start } = lengthAt();
        const chars: number[] = [];
        for (let i = 0; i < len; i++) chars.push(buf.readUInt16BE(start + i * 2));
        return String.fromCharCode(...chars);
      }
      case 0xa: {
        const { len, start } = lengthAt();
        return Array.from({ length: len }, (_, i) => read(uint(start + i * refSize, refSize), depth + 1));
      }
      case 0xd: {
        const { len, start } = lengthAt();
        const out: Record<string, unknown> = {};
        for (let i = 0; i < len; i++) {
          const key = read(uint(start + i * refSize, refSize), depth + 1);
          out[String(key)] = read(uint(start + (len + i) * refSize, refSize), depth + 1);
        }
        return out;
      }
      default:
        return null; // data, date, UID, set: not needed for app identity
    }
  };
  return read(topObject, 0);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** PURE: render a parsed plist dict's string / number / string-array values as the XML plist
 *  fragments the regex readers here (and in artifacts/resolve.ts) understand. */
export function plistDictToXml(dict: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(dict)) {
    if (typeof value === 'string') parts.push(`<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`);
    else if (typeof value === 'number') parts.push(`<key>${xmlEscape(key)}</key><string>${value}</string>`);
    else if (Array.isArray(value))
      parts.push(
        `<key>${xmlEscape(key)}</key><array>${value
          .filter((v): v is string => typeof v === 'string')
          .map((v) => `<string>${xmlEscape(v)}</string>`)
          .join('')}</array>`,
      );
  }
  return `<plist><dict>${parts.join('')}</dict></plist>`;
}

/** A .app's Info.plist as XML text, whether it is stored as XML or as a binary plist (Xcode
 *  always writes binary). Null when missing or unreadable. */
export function readInfoPlistText(appPath: string): string | null {
  try {
    const plist = join(appPath, 'Info.plist');
    if (!existsSync(plist)) return null;
    const buf = readFileSync(plist);
    if (buf.toString('latin1', 0, 8) !== 'bplist00') return buf.toString('utf8');
    const parsed = parseBinaryPlist(buf);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? plistDictToXml(parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Read a .app bundle's build destination from Info.plist, XML or binary (best-effort; 'unknown' on any failure). */
export function appBuildDestination(appPath: string): 'simulator' | 'device' | 'unknown' {
  const text = readInfoPlistText(appPath);
  return text ? destinationFromPlatforms(parseSupportedPlatforms(text)) : 'unknown';
}
