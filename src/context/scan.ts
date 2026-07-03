// scanProject (PHASE3-PLAN §3.1) — the data behind `swipium scan` and `.swipium/config.json`.
// Extends detectContext() with the higher-level signals a developer needs to answer
// "what can I test right now?": app id, whether Metro is likely needed, whether a fresh
// start is safe, whether auth is likely, install state (best-effort), a recommended budget
// profile, and an overall ready | partial | blocked verdict. Best-effort and side-effect free.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectContext, type DetectedContext, type Framework } from './detect.js';
import { apkPackageId, adbDevices } from '../lib/android.js';
import { run } from '../lib/spawn.js';
import { bundleIdFromApp } from '../artifacts/resolve.js';

export type Readiness = 'ready' | 'partial' | 'blocked';

export interface ProjectScan {
  schemaVersion: 1;
  generatedAt: string;
  projectRoot: string;
  framework: Framework;
  monorepo: boolean;
  appId: string | null;
  appIdSource: string | null; // 'apk-badging' | 'Info.plist' | 'app.json' | 'gradle' | null
  apks: string[];
  ipas: string[];
  appBundles: string[];
  artifactHashes: Array<{ path: string; type: 'apk' | 'ipa' | 'app'; artifactHash: string }>;
  metroNeed: 'likely' | 'no'; // RN/Expo debug builds need Metro; release/native don't
  freshStartSafe: boolean; // false on debug RN/Expo (clear_data wipes the bundle)
  likelyAuth: boolean;
  authSignals: string[]; // deps that suggest the app has a login
  installed: boolean | null; // best-effort; null = not checked (no single device / no appId)
  recommendedProfile: 'guardrail' | 'login_smoke' | 'full_smoke' | 'install_smoke';
  readiness: Readiness;
  missing: string[]; // exact items to fix when partial/blocked
  devices: { androidOnline: string[]; avds: string[] };
}

const AUTH_DEP = /(^|[/@])(auth|next-auth|expo-auth-session|react-native-app-auth|amazon-cognito|@clerk|supabase|firebase)/i;
const HARD_BLOCKER =
  /adb not found|could not identify|no online device|no prebuilt (apk|app artifact|android apk|ios app artifact)|no build artifact/i;

function isDebugRN(fw: Framework): boolean {
  return fw === 'expo' || fw === 'bare-react-native';
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Best-effort appId from app config files (Expo / Android gradle) before falling back to the APK. */
function appIdFromSource(root: string, fw: Framework): { appId: string | null; source: string | null } {
  if (fw === 'expo') {
    const cfg = readJson(join(root, 'app.json'));
    const expo = (cfg?.expo ?? cfg) as { android?: { package?: string }; ios?: { bundleIdentifier?: string } } | undefined;
    const pkg = expo?.ios?.bundleIdentifier ?? expo?.android?.package;
    if (typeof pkg === 'string') return { appId: pkg, source: 'app.json' };
  }
  // gradle applicationId (best-effort regex over the app module's build.gradle[.kts])
  for (const g of ['app/build.gradle', 'app/build.gradle.kts', 'android/app/build.gradle', 'android/app/build.gradle.kts']) {
    const p = join(root, g);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/applicationId\s*[=\s]\s*["']([^"']+)["']/);
    if (m) return { appId: m[1], source: 'gradle' };
  }
  return { appId: null, source: null };
}

function detectAuth(root: string): { likely: boolean; signals: string[] } {
  const pkg = readJson(join(root, 'package.json'));
  const deps = pkg ? { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } : {};
  const signals = Object.keys(deps).filter((d) => AUTH_DEP.test(d));
  return { likely: signals.length > 0, signals };
}

/** Is `appId` installed on `serial`? Best-effort; short timeout. */
async function pmInstalled(serial: string, appId: string): Promise<boolean | null> {
  try {
    const r = await run('adb', ['-s', serial, 'shell', 'pm', 'list', 'packages', appId], { timeoutMs: 6000 });
    return r.stdout.includes(`package:${appId}`);
  } catch {
    return null;
  }
}

function hashArtifact(path: string): string | null {
  try {
    const h = createHash('sha256');
    const st = statSync(path);
    if (st.isFile()) {
      h.update(readFileSync(path));
    } else if (st.isDirectory()) {
      const walk = (dir: string, prefix = '') => {
        for (const name of readdirSync(dir).sort()) {
          const full = join(dir, name);
          const rel = prefix ? `${prefix}/${name}` : name;
          const child = statSync(full);
          if (child.isDirectory()) walk(full, rel);
          else if (child.isFile()) {
            h.update(rel);
            h.update('\0');
            h.update(readFileSync(full));
          }
        }
      };
      walk(path);
    } else {
      return null;
    }
    return `sha256:${h.digest('hex')}`;
  } catch {
    return null;
  }
}

function artifactHashes(ctx: DetectedContext): ProjectScan['artifactHashes'] {
  const refs = [
    ...ctx.artifacts.apks.map((path) => ({ path, type: 'apk' as const })),
    ...ctx.artifacts.ipas.map((path) => ({ path, type: 'ipa' as const })),
    ...ctx.artifacts.appBundles.map((path) => ({ path, type: 'app' as const })),
  ];
  return refs.flatMap((ref) => {
    const artifactHash = hashArtifact(ref.path);
    return artifactHash ? [{ ...ref, artifactHash }] : [];
  });
}

export async function scanProject(root: string): Promise<ProjectScan> {
  const ctx: DetectedContext = await detectContext(root);

  // app id: source config first (authoritative for the project), else the prebuilt APK.
  let { appId, source: appIdSource } = appIdFromSource(root, ctx.framework);
  if (!appId && ctx.artifacts.apks[0]) {
    const fromApk = await apkPackageId(ctx.artifacts.apks[0]);
    if (fromApk) {
      appId = fromApk;
      appIdSource = 'apk-badging';
    }
  }
  if (!appId && ctx.artifacts.appBundles[0]) {
    const fromApp = bundleIdFromApp(ctx.artifacts.appBundles[0]);
    if (fromApp) {
      appId = fromApp;
      appIdSource = 'Info.plist';
    }
  }

  const { likely: likelyAuth, signals: authSignals } = detectAuth(root);
  const metroNeed = isDebugRN(ctx.framework) ? 'likely' : 'no';
  const freshStartSafe = !isDebugRN(ctx.framework);

  // install state: only meaningful with exactly one online device + a known appId.
  let installed: boolean | null = null;
  if (appId && ctx.devices.androidOnline.length === 1) {
    installed = await pmInstalled(ctx.devices.androidOnline[0], appId);
  } else if (appId && ctx.toolchain.adb && ctx.devices.androidOnline.length === 0) {
    // adbDevices may have changed since detect; one cheap recheck before giving up
    const live = await adbDevices();
    if (live.length === 1) installed = await pmInstalled(live[0], appId);
  }

  // missing items: detect blockers, but a known-installed app removes the "no APK" blocker.
  const missing = ctx.blockers.filter((b) => !(installed === true && /no prebuilt apk/i.test(b)));
  const hard = missing.filter((b) => HARD_BLOCKER.test(b) && !(installed === true && /no prebuilt apk/i.test(b)));
  const readiness: Readiness = hard.length ? 'blocked' : missing.length ? 'partial' : 'ready';

  const needsBootOrInstall =
    (ctx.devices.androidOnline.length === 0 && ctx.devices.avds.length > 0) || (installed === false && ctx.artifacts.apks.length > 0);
  const recommendedProfile = needsBootOrInstall ? 'install_smoke' : likelyAuth ? 'login_smoke' : 'guardrail';

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    framework: ctx.framework,
    monorepo: ctx.monorepo,
    appId,
    appIdSource,
    apks: ctx.artifacts.apks,
    ipas: ctx.artifacts.ipas,
    appBundles: ctx.artifacts.appBundles,
    artifactHashes: artifactHashes(ctx),
    metroNeed,
    freshStartSafe,
    likelyAuth,
    authSignals,
    installed,
    recommendedProfile,
    readiness,
    missing,
    devices: ctx.devices,
  };
}
