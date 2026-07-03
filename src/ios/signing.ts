import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { run, runBinary } from '../lib/spawn.js';

export interface ParsedCodesign {
  identifier: string | null;
  teamIdentifier: string | null;
  authorityCount: number;
  signed: boolean;
}

export interface ParsedMobileProvision {
  teamIds: string[];
  applicationIdentifier: string | null;
  bundleId: string | null;
  expirationDate: string | null;
  provisionedDevices: string[] | null;
  entitlements: Record<string, string>;
}

export interface IosSigningInspection {
  checked: boolean;
  artifactPath: string;
  artifactType: 'ipa' | 'iphoneos-app' | 'unknown';
  appPath: string | null;
  embeddedProvisionPresent: boolean;
  /** A real iOS device build always embeds a provisioning profile; a simulator .app never does. */
  simulatorBuildSuspected: boolean;
  codesign: ParsedCodesign | null;
  mobileProvision: ParsedMobileProvision | null;
  requestedUdid: string | null;
  ready: boolean;
  missing: string[];
  warnings: string[];
}

function firstMatch(text: string, re: RegExp): string | null {
  return text.match(re)?.[1]?.trim() ?? null;
}

function arrayValues(text: string, key: string): string[] {
  const keyIndex = text.indexOf(`<key>${key}</key>`);
  if (keyIndex < 0) return [];
  const array = text.slice(keyIndex).match(/<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
  return [...array.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1].trim()).filter(Boolean);
}

function dictStringValue(text: string, key: string): string | null {
  const idx = text.indexOf(`<key>${key}</key>`);
  if (idx < 0) return null;
  return (
    text
      .slice(idx)
      .match(/<string>([^<]+)<\/string>/)?.[1]
      ?.trim() ?? null
  );
}

function entitlements(text: string): Record<string, string> {
  const idx = text.indexOf('<key>Entitlements</key>');
  if (idx < 0) return {};
  const dict = text.slice(idx).match(/<dict>([\s\S]*?)<\/dict>/)?.[1] ?? '';
  const out: Record<string, string> = {};
  const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
  for (const match of dict.matchAll(re)) out[match[1]] = match[2];
  return out;
}

export function parseCodesignDetails(text: string): ParsedCodesign {
  const authorityCount = [...text.matchAll(/^Authority=/gm)].length;
  const signature = firstMatch(text, /^Signature=(.+)$/m);
  return {
    identifier: firstMatch(text, /^Identifier=(.+)$/m),
    teamIdentifier: firstMatch(text, /^TeamIdentifier=(.+)$/m),
    authorityCount,
    signed: !!signature && !/adhoc/i.test(signature) && authorityCount > 0,
  };
}

export function parseMobileProvisionPlist(text: string): ParsedMobileProvision {
  const appIdentifier = entitlements(text)['application-identifier'] ?? dictStringValue(text, 'ApplicationIdentifierPrefix');
  const bundleId = appIdentifier?.includes('.') ? appIdentifier.split('.').slice(1).join('.') : null;
  return {
    teamIds: arrayValues(text, 'TeamIdentifier'),
    applicationIdentifier: appIdentifier ?? null,
    bundleId,
    expirationDate: firstMatch(text, /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/),
    provisionedDevices: text.includes('<key>ProvisionedDevices</key>') ? arrayValues(text, 'ProvisionedDevices') : null,
    entitlements: entitlements(text),
  };
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

function findExtractedApp(dir: string): string | null {
  const payload = join(dir, 'Payload');
  if (!existsSync(payload)) return null;
  for (const name of readdirSync(payload)) {
    const full = join(payload, name);
    if (name.endsWith('.app') && statSync(full).isDirectory()) return full;
  }
  return null;
}

async function materializeApp(
  path: string,
): Promise<{ appPath: string | null; cleanup?: string; artifactType: IosSigningInspection['artifactType']; missing: string[] }> {
  if (path.endsWith('.app')) return { appPath: path, artifactType: 'iphoneos-app', missing: [] };
  if (extname(path).toLowerCase() !== '.ipa')
    return { appPath: null, artifactType: 'unknown', missing: [`unsupported iOS artifact extension: ${basename(path)}`] };
  const dir = mkdtempSync(join(tmpdir(), 'swipium-ipa-'));
  const unzip = await run('unzip', ['-q', path, '-d', dir], { timeoutMs: 30000 });
  if (unzip.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return { appPath: null, artifactType: 'ipa', missing: [`could not extract ipa: ${unzip.stderr.trim() || `exit ${unzip.code}`}`] };
  }
  return { appPath: findExtractedApp(dir), cleanup: dir, artifactType: 'ipa', missing: [] };
}

export async function inspectIosSigningArtifact(
  path: string,
  opts: { requestedUdid?: string | null; expectedBundleId?: string | null } = {},
): Promise<IosSigningInspection> {
  const missing: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(path)) {
    return {
      checked: true,
      artifactPath: path,
      artifactType: 'unknown',
      appPath: null,
      embeddedProvisionPresent: false,
      simulatorBuildSuspected: false,
      codesign: null,
      mobileProvision: null,
      requestedUdid: opts.requestedUdid ?? null,
      ready: false,
      missing: ['artifact path does not exist'],
      warnings,
    };
  }
  if (process.platform !== 'darwin') {
    return {
      checked: false,
      artifactPath: path,
      artifactType: path.endsWith('.ipa') ? 'ipa' : path.endsWith('.app') ? 'iphoneos-app' : 'unknown',
      appPath: null,
      embeddedProvisionPresent: false,
      simulatorBuildSuspected: false,
      codesign: null,
      mobileProvision: null,
      requestedUdid: opts.requestedUdid ?? null,
      ready: false,
      missing: ['iOS signing inspection requires macOS codesign/security tools'],
      warnings,
    };
  }

  const materialized = await materializeApp(path);
  missing.push(...materialized.missing);
  let codesign: ParsedCodesign | null = null;
  let mobileProvision: ParsedMobileProvision | null = null;
  let embeddedProvisionPresent = false;
  try {
    if (materialized.appPath) {
      const provisionPath = join(materialized.appPath, 'embedded.mobileprovision');
      embeddedProvisionPresent = existsSync(provisionPath);
      const sign = await run('codesign', ['-dv', '--verbose=4', materialized.appPath], { timeoutMs: 15000 });
      codesign = parseCodesignDetails(`${sign.stdout}\n${sign.stderr}`);
      if (sign.code !== 0 || !codesign.signed) missing.push('codesign verification did not prove a non-ad-hoc signed app');
      if (!embeddedProvisionPresent) {
        missing.push('embedded.mobileprovision is missing');
      } else {
        const cms = await runBinary('security', ['cms', '-D', '-i', provisionPath], { timeoutMs: 15000 });
        if (cms.code !== 0) missing.push('embedded.mobileprovision could not be decoded');
        else mobileProvision = parseMobileProvisionPlist(cms.stdout.toString('utf8'));
      }
    } else if (!missing.length) {
      missing.push('could not find .app inside artifact');
    }
  } finally {
    if (materialized.cleanup) rmSync(materialized.cleanup, { recursive: true, force: true });
  }

  if (opts.expectedBundleId && mobileProvision?.bundleId && mobileProvision.bundleId !== opts.expectedBundleId) {
    missing.push(`provisioned bundle id ${mobileProvision.bundleId} does not match expected ${opts.expectedBundleId}`);
  }
  if (codesign?.teamIdentifier && mobileProvision?.teamIds.length && !mobileProvision.teamIds.includes(codesign.teamIdentifier)) {
    missing.push('codesign team identifier does not match provisioning profile team');
  }
  if (opts.requestedUdid && mobileProvision?.provisionedDevices && !mobileProvision.provisionedDevices.includes(opts.requestedUdid)) {
    missing.push(`provisioning profile does not include requested device UDID ${opts.requestedUdid}`);
  }
  if (!opts.requestedUdid && mobileProvision?.provisionedDevices?.length)
    warnings.push(
      'provisioning profile has device UDIDs; pass a device UDID to verify this artifact is provisioned for the target hardware',
    );
  if (mobileProvision?.expirationDate) {
    const expiresAt = Date.parse(mobileProvision.expirationDate);
    if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
      missing.push(`embedded provisioning profile expired on ${mobileProvision.expirationDate}`);
    }
  }

  const simulatorBuildSuspected = !!materialized.appPath && !embeddedProvisionPresent;
  if (simulatorBuildSuspected) missing.push('no embedded.mobileprovision: this looks like a simulator .app, not a signed device build');

  return {
    checked: true,
    artifactPath: path,
    artifactType: materialized.artifactType,
    appPath: materialized.appPath,
    embeddedProvisionPresent,
    simulatorBuildSuspected,
    codesign,
    mobileProvision,
    requestedUdid: opts.requestedUdid ?? null,
    ready: missing.length === 0,
    missing,
    warnings,
  };
}
