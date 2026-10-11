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

/** Read a .app bundle's build destination from Info.plist (best-effort; 'unknown' on any failure). */
export function appBuildDestination(appPath: string): 'simulator' | 'device' | 'unknown' {
  try {
    const plist = join(appPath, 'Info.plist');
    if (!existsSync(plist)) return 'unknown';
    return destinationFromPlatforms(parseSupportedPlatforms(readFileSync(plist, 'utf8')));
  } catch {
    return 'unknown';
  }
}
