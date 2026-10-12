// scanProject: the data behind `swipium scan` and `.swipium/config.json`.
// Extends detectContext() with the higher-level signals a developer needs to answer
// "what can I test right now?": app id, whether Metro is likely needed, whether a fresh
// start is safe, whether auth is likely, install state (best-effort), a recommended budget
// profile, and an overall ready | partial | blocked verdict. Best-effort and side-effect free.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { detectContext, type DetectedContext, type Framework } from './detect.js';
import { isBroadSystemDir } from './projectRoot.js';
import { apkPackageId, adbDevices } from '../lib/android.js';
import { run } from '../lib/spawn.js';
import { bundleIdFromApp } from '../artifacts/resolve.js';
import { buildPlan, type BuildPlatform } from '../build/plan.js';

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
  /** No prebuilt artifact, but Swipium can build one from source (the same check qa_test_this's
   *  plan uses): the platform and main build command. Absent when an artifact exists or no build is possible. */
  buildFromSource?: { platform: BuildPlatform; command: string } | null;
  devices: { androidOnline: string[]; avds: string[] };
}

const AUTH_DEP = /(^|[/@])(auth|next-auth|expo-auth-session|react-native-app-auth|amazon-cognito|@clerk|supabase|firebase)/i;
const NO_PREBUILT = /no prebuilt (apk|app artifact|android apk|ios app artifact)/i;
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

/** `device`: the device the caller's session is bound to (or asked for). When set, the install probe
 *  only ever reads THAT device (if online), never a bystander that happens to be the lone one online. */
// isBroadSystemDir (the shared-folder list) lives in projectRoot.ts, which also refuses those roots.
export { isBroadSystemDir };

/** Max directories between the root and a prebuilt artifact for "test the prebuilt build as-is"
 *  (root/X.app, root/build/X.app, root/apps/ios/X.app). Deeper hits are someone else's files. */
export const PREBUILT_MAX_DEPTH = 2;

/** The artifacts a prebuilt-only root may test: near the root, and never under a broad system dir. */
export function prebuiltArtifactsNearRoot(root: string, paths: string[], home: string = homedir()): string[] {
  if (isBroadSystemDir(root, home)) return [];
  return paths.filter((p) => {
    const rel = relative(resolve(root), resolve(p));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    return rel.split(sep).length - 1 <= PREBUILT_MAX_DEPTH;
  });
}

export async function scanProject(root: string, opts: { device?: string } = {}): Promise<ProjectScan> {
  const ctx: DetectedContext = await detectContext(root);

  // app id: source config first (authoritative for the project), else the prebuilt APK.
  let { appId, source: appIdSource } = appIdFromSource(root, ctx.framework);
  // Prefer an artifact near the root: that is the one a prebuilt-only plan installs (TOOL NEW-4).
  const idApk = prebuiltArtifactsNearRoot(root, ctx.artifacts.apks)[0] ?? ctx.artifacts.apks[0];
  const idApp = prebuiltArtifactsNearRoot(root, ctx.artifacts.appBundles)[0] ?? ctx.artifacts.appBundles[0];
  if (!appId && idApk) {
    const fromApk = await apkPackageId(idApk);
    if (fromApk) {
      appId = fromApk;
      appIdSource = 'apk-badging';
    }
  }
  if (!appId && idApp) {
    const fromApp = bundleIdFromApp(idApp);
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
  if (appId && opts.device) {
    if (ctx.devices.androidOnline.includes(opts.device)) installed = await pmInstalled(opts.device, appId);
  } else if (appId && ctx.devices.androidOnline.length === 1) {
    installed = await pmInstalled(ctx.devices.androidOnline[0], appId);
  } else if (appId && ctx.toolchain.adb && ctx.devices.androidOnline.length === 0) {
    // adbDevices may have changed since detect; one cheap recheck before giving up
    const live = await adbDevices();
    if (live.length === 1) installed = await pmInstalled(live[0], appId);
  }

  // missing items: detect blockers, but a known-installed app removes the "no APK" blocker.
  let missing = ctx.blockers.filter((b) => !(installed === true && /no prebuilt apk/i.test(b)));

  // E2E-5: a directory holding only a prebuilt simulator .app / .apk (no source project) is testable
  // as-is once its app id resolves; "could not identify a mobile project" is then not a blocker.
  // Only for an artifact near the root, never one found deep under a broad dir (TOOL NEW-4).
  const nearPrebuilts = prebuiltArtifactsNearRoot(root, [...ctx.artifacts.appBundles, ...ctx.artifacts.apks]);
  const prebuiltOnly = ctx.framework === 'unknown' && !!appId && nearPrebuilts.length > 0;
  if (prebuiltOnly) {
    const artifact = nearPrebuilts[0];
    missing = missing.map((b) =>
      /could not identify/i.test(b)
        ? `No source project here: Swipium will test the prebuilt artifact ${artifact} (${appId}) as-is; it cannot rebuild it.`
        : b,
    );
  }

  // SET-14: "no prebuilt artifact" is not a hard blocker when Swipium can build from source (the
  // same pure buildPlan() check qa_test_this's plan uses), so scan agrees with qa_test_this.
  let buildFromSource: ProjectScan['buildFromSource'] = null;
  if (missing.some((b) => NO_PREBUILT.test(b))) {
    const d = ctx.devices;
    const androidFirst = d.androidOnline.length > 0 || d.avds.length > 0 || (d.iosBooted.length === 0 && d.iosAvailable.length === 0);
    const platforms: BuildPlatform[] =
      ctx.framework === 'native-ios'
        ? ['ios']
        : ctx.framework === 'native-android'
          ? ['android']
          : androidFirst
            ? ['android', 'ios']
            : ['ios', 'android'];
    for (const platform of platforms) {
      const bp = await buildPlan({ projectRoot: root, platform }).catch(() => null);
      if (bp && !bp.failureCode && bp.build && bp.toolchainOk) {
        buildFromSource = { platform, command: bp.build.command };
        break;
      }
    }
    if (buildFromSource) {
      const note = `No installable artifact yet: qa_test_this will build ${buildFromSource.platform} from source (${buildFromSource.command}) after one approval prompt.`;
      missing = missing.map((b) => (NO_PREBUILT.test(b) ? note : b));
    }
  }
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
    buildFromSource,
    devices: ctx.devices,
  };
}
