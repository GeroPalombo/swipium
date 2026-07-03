// Framework-aware STATIC scanner (SWIPIUM-REQ-01). Additive + confidence-based: it never fails a
// run because one framework can't be parsed — parser problems are recorded in `parserNotes` and
// surface as reduced confidence. For JS/TS the TypeScript compiler API (Vision Gap Fix 10) is the
// PRIMARY parser — it resolves route-constant references, navigator <Stack.Screen> declarations, and
// multiline default-export components that regex misses — with line-aware regex as the fallback when
// the `typescript` package is not resolvable. Each scanner is independent so the surface can grow.

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseYaml } from 'yaml';
import { detectFramework, type Framework } from '../context/detect.js';
import { fileHash, rel, readTextSafe, walkFiles } from './fsWalk.js';
import { scanTsSource, tsAstAvailable } from './tsAstScan.js';
import type {
  AppIdentity,
  AuthModel,
  FlowModel,
  InputModel,
  NavigationEdge,
  SourceFingerprint,
  StaticScreen,
  StaticTopology,
} from './schema.js';

export interface StaticScanResult {
  staticTopology: StaticTopology;
  appIdentity: Partial<AppIdentity>;
  auth: AuthModel;
  onboarding: FlowModel | null;
  paywalls: FlowModel[];
  inputModels: InputModel[];
  sourceFingerprint: SourceFingerprint;
  packageName: string | null;
  /** Absolute paths of source files collected (for the code index). */
  collectedFiles: string[];
}

const AUTH_LIB_RE =
  /(next-auth|expo-auth-session|react-native-app-auth|amazon-cognito|@clerk|@supabase\/supabase|firebase\/auth|@react-native-firebase\/auth|@auth0|msal|react-native-keychain|@okta)/i;
const FORM_LIB_RE = /(react-hook-form|formik|yup|zod|@hookform|final-form)/i;
const PAYWALL_LIB_RE = /(react-native-purchases|expo-in-app-purchases|react-native-iap|revenuecat|@stripe\/stripe-react-native|stripe)/i;
const ONBOARDING_RE = /(onboard|welcome|intro|get-?started|walkthrough|tutorial)/i;

function readJson(p: string): Record<string, unknown> | null {
  const t = readTextSafe(p);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function slug(value: string): string {
  return (
    value
      .replace(/\.[a-zA-Z]+$/, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'screen'
  );
}

function depsOf(root: string): Record<string, string> {
  const pkg = readJson(join(root, 'package.json'));
  if (!pkg) return {};
  return { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
}

/** Fingerprint the files that define app structure (config + entry/route files) for incremental rescans. */
function fingerprint(root: string, files: string[], generatedAt: string): SourceFingerprint {
  const out: SourceFingerprint = { generatedAt, files: [] };
  for (const f of files.slice(0, 400)) {
    const h = fileHash(f);
    if (h) out.files.push({ path: rel(root, f), hash: h.hash, mtimeMs: h.mtimeMs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expo / React Native
// ---------------------------------------------------------------------------

function scanExpoRouter(root: string, topo: StaticTopology): void {
  // Expo Router: file-system routes under app/** (or src/app/**).
  const appDirs = [join(root, 'app'), join(root, 'src', 'app')].filter((d) => existsSync(d));
  if (!appDirs.length) return;
  topo.router = topo.router ?? 'expo-router';
  for (const dir of appDirs) {
    const files = walkFiles(dir, { exts: ['.tsx', '.ts', '.jsx', '.js'] });
    for (const f of files) {
      const base = basename(f);
      if (/^_/.test(base) && !/^_layout\./.test(base)) continue; // skip private files except layouts
      const route = rel(dir, f).replace(/\.(tsx?|jsx?)$/, '');
      const isLayout = /_layout$/.test(route);
      const isNotFound = /\+not-found$/.test(route);
      const isModal = /modal/i.test(route);
      const isDynamic = /\[.+\]/.test(route);
      const isTab = /\(tabs?\)/.test(route);
      const groupless = route.replace(/\([^)]*\)\//g, '').replace(/\/index$/, '') || 'index';
      const kind: StaticScreen['kind'] = isLayout ? 'layout' : isNotFound ? 'not_found' : isModal ? 'modal' : isTab ? 'tab' : 'route';
      const reasons = ['expo_router_file'];
      if (isDynamic) reasons.push('dynamic_route');
      if (isTab) reasons.push('tab_group');
      topo.screens.push({
        id: `route:${slug(groupless)}`,
        name: groupless,
        route: '/' + groupless.replace(/index$/, ''),
        kind,
        sourceFiles: [rel(root, f)],
        navParams: isDynamic ? (route.match(/\[([^\]]+)\]/g)?.map((m) => m.replace(/[[\]]/g, '')) ?? []) : [],
        confidence: isLayout ? 0.6 : 0.85,
        reasons,
      });
      if (!isLayout && !isNotFound) {
        topo.edges.push({ to: `route:${slug(groupless)}`, kind: 'route_declaration', evidence: rel(root, f), confidence: 0.8 });
      }
    }
  }
}

function scanReactNavigation(root: string, topo: StaticTopology, jsFiles: string[]): void {
  const navSignals = /createNativeStackNavigator|createStackNavigator|createBottomTabNavigator|createDrawerNavigator|NavigationContainer/;
  let found = false;
  for (const f of jsFiles) {
    const text = readTextSafe(f);
    if (!text || !navSignals.test(text)) continue;
    found = true;
    const relPath = rel(root, f);
    // Stack.Screen / Tab.Screen / Drawer.Screen name= declarations.
    const screenRe = /<([A-Za-z0-9_]+)\.Screen\b[^>]*\bname=(?:["'`]([^"'`]+)["'`]|\{["'`]?([^}"'`]+)["'`]?\})/g;
    let m: RegExpExecArray | null;
    while ((m = screenRe.exec(text))) {
      const navType = m[1];
      const name = (m[2] ?? m[3] ?? '').trim();
      if (!name) continue;
      const kindMap: Record<string, NavigationEdge['kind']> = { Tab: 'tab', Drawer: 'drawer', Stack: 'stack' };
      const navKind = Object.entries(kindMap).find(([k]) => navType.includes(k))?.[1] ?? 'navigation';
      const id = `screen:${slug(name)}`;
      if (!topo.screens.some((s) => s.id === id)) {
        topo.screens.push({
          id,
          name,
          route: name,
          kind: 'screen',
          sourceFiles: [relPath],
          confidence: 0.8,
          reasons: ['react_navigation_screen', `nav_${navKind}`],
        });
      } else {
        const existing = topo.screens.find((s) => s.id === id)!;
        existing.sourceFiles = uniq([...existing.sourceFiles, relPath]);
      }
      topo.edges.push({ to: id, kind: navKind, evidence: `${relPath}:${navType}.Screen`, confidence: 0.7 });
    }
    // navigation.navigate('Foo') / .push('Foo') call sites → probable edges.
    const navCallRe = /\.(navigate|push|replace)\(\s*["'`]([^"'`]+)["'`]/g;
    while ((m = navCallRe.exec(text))) {
      const to = `screen:${slug(m[2])}`;
      topo.edges.push({ to, kind: 'navigation', evidence: `${relPath}:navigation.${m[1]}`, confidence: 0.5 });
    }
  }
  if (found && !topo.router) topo.router = 'react-navigation';
}

/**
 * Vision Gap Fix 10 — AST pass over JS/TS/TSX files. Folds AST-discovered navigator screens (with
 * resolved route-constant names + bound components), exported screen components, navigation edges, and
 * route constants into the topology. Bounded; parse failures become parserNotes, never hard failures.
 */
function scanTsAst(root: string, topo: StaticTopology, jsFiles: string[]): void {
  if (!tsAstAvailable()) {
    topo.parserNotes.push('TypeScript compiler API unavailable — JS/TS scanned with regex fallback only');
    return;
  }
  let parsedFiles = 0;
  let failedFiles = 0;
  const MAX = 1500;
  const MAX_BYTES = 512 * 1024;
  for (const f of jsFiles.slice(0, MAX)) {
    const relPath = rel(root, f);
    if (/\.(test|spec|stories)\./.test(relPath)) continue;
    const text = readTextSafe(f);
    if (!text || text.length > MAX_BYTES) continue;
    const res = scanTsSource(relPath, text);
    if (!res.parsed) {
      failedFiles++;
      continue;
    }
    parsedFiles++;
    // Fold ONLY explicit navigator (<Stack/Tab/Drawer.Screen>) declarations into the topology — these
    // carry an authoritative route name (incl. constant-resolved) that regex misses. Generic component
    // / default-export screens are intentionally NOT folded here to avoid duplicating expo-router's
    // file-based routes and the screen-filename convention; scanTsSource still exposes them to callers.
    for (const s of res.screens.filter((x) => x.reasons.includes('ast_navigator_screen'))) {
      const id = `screen:${slug(s.name)}`;
      const existing = topo.screens.find((x) => x.id === id);
      if (existing) {
        existing.sourceFiles = uniq([...existing.sourceFiles, relPath]);
        existing.confidence = Math.max(existing.confidence, s.confidence);
        existing.reasons = uniq([...existing.reasons, ...s.reasons]);
        if (s.route && !existing.route) existing.route = s.route;
      } else {
        topo.screens.push({
          id,
          name: s.name,
          route: s.route,
          kind: 'screen',
          sourceFiles: [relPath],
          confidence: s.confidence,
          reasons: ['ast', ...s.reasons],
        });
      }
    }
    for (const e of res.navEdges) {
      const to = `screen:${slug(e.to)}`;
      if (!topo.edges.some((x) => x.to === to && x.evidence === `${relPath}:${e.via}`)) {
        topo.edges.push({ to, kind: 'navigation', evidence: `${relPath}:${e.via}`, confidence: 0.6 });
      }
    }
    for (const rc of res.routeConstants) {
      if (!topo.routeConstants.some((x) => x.name === rc.name && x.file === relPath))
        topo.routeConstants.push({ name: rc.name, value: rc.value, file: relPath });
    }
    for (const note of res.parserNotes) topo.parserNotes.push(note);
  }
  if (!topo.router && parsedFiles && topo.screens.some((s) => (s.reasons ?? []).includes('ast_navigator_screen')))
    topo.router = 'react-navigation';
  topo.routeConstants = topo.routeConstants.slice(0, 200);
  if (failedFiles) topo.parserNotes.push(`AST scan: ${failedFiles} JS/TS file(s) failed to parse — reduced confidence`);
}

function scanRnScreenFiles(root: string, topo: StaticTopology, jsFiles: string[]): void {
  // Heuristic: files under */screens/* or features/*/screens/* whose default export looks like a screen.
  for (const f of jsFiles) {
    const relPath = rel(root, f);
    if (!/(^|\/)(screens|pages)\//.test(relPath) && !/features\/[^/]+\/screens\//.test(relPath)) continue;
    if (/\.(test|spec|stories)\./.test(relPath)) continue;
    const name = basename(f).replace(/\.(tsx?|jsx?)$/, '');
    if (!/^[A-Z]/.test(name) || name.toLowerCase() === 'index') continue;
    const id = `screen:${slug(name)}`;
    if (topo.screens.some((s) => s.id === id)) continue;
    topo.screens.push({ id, name, kind: 'screen', sourceFiles: [relPath], confidence: 0.55, reasons: ['screen_filename_convention'] });
  }
}

function scanRouteConstants(root: string, topo: StaticTopology, jsFiles: string[]): void {
  // Exported route constant objects: e.g. export const Routes = { Home: 'Home', ... }
  for (const f of jsFiles) {
    const text = readTextSafe(f);
    if (!text) continue;
    const relPath = rel(root, f);
    const blockRe = /export\s+const\s+([A-Za-z0-9_]*[Rr]outes?[A-Za-z0-9_]*)\s*=\s*\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(text))) {
      const body = m[2];
      const pairRe = /([A-Za-z0-9_]+)\s*:\s*["'`]([^"'`]+)["'`]/g;
      let p: RegExpExecArray | null;
      while ((p = pairRe.exec(body))) {
        topo.routeConstants.push({ name: `${m[1]}.${p[1]}`, value: p[2], file: relPath });
      }
    }
  }
  topo.routeConstants = topo.routeConstants.slice(0, 200);
}

function detectRnInputModels(jsFiles: string[], root: string): InputModel[] {
  const out: InputModel[] = [];
  const seen = new Set<string>();
  for (const f of jsFiles) {
    const text = readTextSafe(f);
    if (!text || !/TextInput|TextField|<Input\b/.test(text)) continue;
    const relPath = rel(root, f);
    // secureTextEntry → password; keyboardType email-address → email; placeholder hints.
    if (/secureTextEntry/.test(text) && !seen.has('password')) {
      out.push({
        fieldPurpose: 'password',
        inputType: 'password',
        secret: true,
        fixtureRequired: true,
        safeGenerator: 'faker.internet.password',
        validation: 'non-empty',
        source: relPath,
      });
      seen.add('password');
    }
    if (/keyboardType\s*=\s*["'`]email-address["'`]|placeholder\s*=\s*["'`][^"'`]*email/i.test(text) && !seen.has('email')) {
      out.push({
        fieldPurpose: 'email',
        inputType: 'email',
        secret: false,
        fixtureRequired: true,
        safeGenerator: 'faker.internet.email',
        validation: 'email format',
        source: relPath,
      });
      seen.add('email');
    }
    if (/placeholder\s*=\s*["'`][^"'`]*search/i.test(text) && !seen.has('search')) {
      out.push({
        fieldPurpose: 'search',
        inputType: 'text',
        secret: false,
        fixtureRequired: false,
        safeGenerator: 'static.search-term',
        source: relPath,
      });
      seen.add('search');
    }
  }
  return out;
}

function scanExpoRn(root: string, fw: Framework, topo: StaticTopology, result: StaticScanResult, jsFiles: string[]): void {
  // app.json / app.config.* / package.json identity
  const appJson = readJson(join(root, 'app.json'));
  const expo = (appJson?.expo ?? appJson) as
    | { name?: string; version?: string; android?: { package?: string }; ios?: { bundleIdentifier?: string }; scheme?: string | string[] }
    | undefined;
  if (expo) {
    result.appIdentity.appName = expo.name ?? null;
    result.appIdentity.version = expo.version ?? null;
    result.appIdentity.androidPackage = expo.android?.package ?? null;
    result.appIdentity.iosBundleId = expo.ios?.bundleIdentifier ?? null;
    const schemes = Array.isArray(expo.scheme) ? expo.scheme : expo.scheme ? [expo.scheme] : [];
    topo.deepLinks.push(...schemes.map((s) => `${s}://`));
  }
  // config presence notes (app.config.js/ts not evaluated — recorded as partial confidence)
  for (const cfg of ['app.config.js', 'app.config.ts']) {
    if (existsSync(join(root, cfg)))
      topo.parserNotes.push(`${cfg} present but not evaluated (dynamic config) — identity may be incomplete`);
  }

  scanExpoRouter(root, topo);
  scanReactNavigation(root, topo, jsFiles);
  scanTsAst(root, topo, jsFiles); // Fix 10: AST pass augments/refines the regex results.
  scanRnScreenFiles(root, topo, jsFiles);
  scanRouteConstants(root, topo, jsFiles);
  result.inputModels.push(...detectRnInputModels(jsFiles, root));
}

// ---------------------------------------------------------------------------
// Native Android
// ---------------------------------------------------------------------------

function findManifest(root: string): string | null {
  for (const p of ['app/src/main/AndroidManifest.xml', 'android/app/src/main/AndroidManifest.xml', 'src/main/AndroidManifest.xml']) {
    if (existsSync(join(root, p))) return join(root, p);
  }
  const hits = walkFiles(root, { alsoNames: ['AndroidManifest.xml'], maxFiles: 50, exts: [] }).filter(
    (f) => basename(f) === 'AndroidManifest.xml' && !/\/(test|androidTest|debug)\//.test(f),
  );
  return hits[0] ?? null;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function scanNativeAndroid(root: string, topo: StaticTopology, result: StaticScanResult): void {
  topo.router = topo.router ?? 'android';
  const manifestPath = findManifest(root);
  if (manifestPath) {
    const text = readTextSafe(manifestPath);
    if (text) {
      try {
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const doc = parser.parse(text) as Record<string, any>;
        const manifest = doc.manifest ?? {};
        result.appIdentity.androidPackage = result.appIdentity.androidPackage ?? manifest['@_package'] ?? null;
        const app = manifest.application ?? {};
        const activities = asArray(app.activity);
        for (const act of activities) {
          const name: string = act['@_android:name'] ?? '';
          if (!name) continue;
          const short = name.split('.').pop() ?? name;
          topo.nativeActivities.push(name);
          topo.screens.push({
            id: `activity:${slug(short)}`,
            name: short,
            kind: 'activity',
            sourceFiles: [rel(root, manifestPath)],
            confidence: 0.85,
            reasons: ['android_manifest_activity'],
          });
          // deep links from intent-filter data
          for (const f of asArray(act['intent-filter'])) {
            for (const d of asArray(f.data)) {
              const scheme = d['@_android:scheme'];
              const host = d['@_android:host'];
              if (scheme) topo.deepLinks.push(`${scheme}://${host ?? ''}`);
            }
          }
        }
        for (const perm of asArray(manifest['uses-permission'])) {
          const n = perm['@_android:name'];
          if (n) topo.permissions.push(n);
        }
      } catch {
        topo.parserNotes.push(`Failed to parse ${rel(root, manifestPath)} — activities/permissions may be incomplete`);
      }
    }
  } else {
    topo.parserNotes.push('No AndroidManifest.xml found under common locations');
  }

  // Gradle namespace / applicationId
  for (const g of [
    'app/build.gradle',
    'app/build.gradle.kts',
    'android/app/build.gradle',
    'android/app/build.gradle.kts',
    'build.gradle',
    'build.gradle.kts',
  ]) {
    const p = join(root, g);
    const text = readTextSafe(p);
    if (!text) continue;
    const appId = text.match(/applicationId\s*[=\s]\s*["']([^"']+)["']/);
    const ns = text.match(/namespace\s*[=\s]\s*["']([^"']+)["']/);
    if (appId && !result.appIdentity.androidPackage) result.appIdentity.androidPackage = appId[1];
    if (ns && !result.packageName) result.packageName = ns[1];
    const versionName = text.match(/versionName\s*[=\s]\s*["']([^"']+)["']/);
    if (versionName && !result.appIdentity.version) result.appIdentity.version = versionName[1];
  }

  // Jetpack Navigation XML graphs (res/navigation/*.xml) + Compose navigation calls.
  const navXml = walkFiles(root, { exts: ['.xml'], maxFiles: 1500 }).filter((f) => /\/res\/navigation\//.test(f));
  for (const f of navXml) {
    const text = readTextSafe(f);
    if (!text) continue;
    const fragRe = /android:name="([^"]+)"|android:label="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = fragRe.exec(text))) {
      const name = (m[1] ?? m[2] ?? '').split('.').pop();
      if (name)
        topo.screens.push({
          id: `fragment:${slug(name)}`,
          name,
          kind: 'fragment',
          sourceFiles: [rel(root, f)],
          confidence: 0.7,
          reasons: ['jetpack_navigation_xml'],
        });
    }
    if (navXml.length) topo.router = 'jetpack-navigation';
  }
  const kotlin = walkFiles(root, { exts: ['.kt'], maxFiles: 2000 });
  for (const f of kotlin) {
    const text = readTextSafe(f);
    if (!text || !/NavHost|composable\(/.test(text)) continue;
    topo.router = topo.router === 'android' ? 'compose-navigation' : topo.router;
    const compRe = /composable\(\s*(?:route\s*=\s*)?["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = compRe.exec(text))) {
      const route = m[1];
      const name = route.split('/')[0].split('?')[0] || route;
      const id = `composable:${slug(name)}`;
      if (!topo.screens.some((s) => s.id === id))
        topo.screens.push({
          id,
          name,
          route,
          kind: 'screen',
          sourceFiles: [rel(root, f)],
          confidence: 0.7,
          reasons: ['compose_navigation'],
        });
      topo.edges.push({ to: id, kind: 'route_declaration', evidence: `${rel(root, f)}:composable`, confidence: 0.6 });
    }
  }
}

// ---------------------------------------------------------------------------
// Native iOS
// ---------------------------------------------------------------------------

function plistValue(text: string, key: string): string | null {
  const re = new RegExp(`<key>${key}</key>\\s*<(string|true|false|integer)>?([^<]*)`, 'i');
  const m = text.match(re);
  return m ? (m[1] === 'true' || m[1] === 'false' ? m[1] : m[2].trim()) : null;
}

function scanNativeIos(root: string, topo: StaticTopology, result: StaticScanResult, swiftFiles: string[]): void {
  topo.router = topo.router ?? 'storyboard';
  const plists = walkFiles(root, { alsoNames: ['Info.plist'], exts: [], maxFiles: 200 }).filter(
    (f) => basename(f) === 'Info.plist' && !/\/(Tests|Pods)\//.test(f),
  );
  for (const p of plists) {
    const text = readTextSafe(p);
    if (!text) continue;
    result.appIdentity.iosBundleId = result.appIdentity.iosBundleId ?? plistValue(text, 'CFBundleIdentifier');
    result.appIdentity.appName = result.appIdentity.appName ?? plistValue(text, 'CFBundleDisplayName') ?? plistValue(text, 'CFBundleName');
    result.appIdentity.version = result.appIdentity.version ?? plistValue(text, 'CFBundleShortVersionString');
    // URL schemes (CFBundleURLSchemes string array)
    const schemeBlock = text.match(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/i);
    if (schemeBlock) {
      for (const m of schemeBlock[1].matchAll(/<string>([^<]+)<\/string>/g)) topo.deepLinks.push(`${m[1]}://`);
    }
    break; // first non-test Info.plist is authoritative enough
  }

  // SwiftUI View structs + UIKit view controllers.
  for (const f of swiftFiles) {
    const text = readTextSafe(f);
    if (!text) continue;
    const relPath = rel(root, f);
    for (const m of text.matchAll(/struct\s+([A-Za-z0-9_]+)\s*:\s*[^{]*\bView\b/g)) {
      const name = m[1];
      if (/Cell|Row|Button|Style|Modifier|Preview$/.test(name)) continue;
      const id = `view:${slug(name)}`;
      if (!topo.screens.some((s) => s.id === id))
        topo.screens.push({
          id,
          name,
          kind: 'view_controller',
          sourceFiles: [relPath],
          confidence: /View$|Screen$|Page$/.test(name) ? 0.7 : 0.5,
          reasons: ['swiftui_view_struct'],
        });
      topo.viewControllers.push(name);
    }
    for (const m of text.matchAll(
      /class\s+([A-Za-z0-9_]+)\s*:\s*[^{]*\b(UIViewController|UITableViewController|UICollectionViewController)\b/g,
    )) {
      const name = m[1];
      const id = `vc:${slug(name)}`;
      if (!topo.screens.some((s) => s.id === id))
        topo.screens.push({
          id,
          name,
          kind: 'view_controller',
          sourceFiles: [relPath],
          confidence: 0.75,
          reasons: ['uikit_view_controller'],
        });
      topo.viewControllers.push(name);
    }
    // NavigationLink destinations → edges (best-effort)
    for (const m of text.matchAll(/NavigationLink[^{]*?destination:\s*([A-Za-z0-9_]+)\s*\(/g)) {
      topo.edges.push({ to: `view:${slug(m[1])}`, kind: 'navigation', evidence: `${relPath}:NavigationLink`, confidence: 0.5 });
    }
  }
  // storyboards/xibs
  const sb = walkFiles(root, { exts: ['.storyboard', '.xib'], maxFiles: 200 });
  if (sb.length) topo.parserNotes.push(`${sb.length} storyboard/xib file(s) present — scene graph not parsed (partial confidence)`);
}

// ---------------------------------------------------------------------------
// Flutter
// ---------------------------------------------------------------------------

function scanFlutter(root: string, topo: StaticTopology, result: StaticScanResult, dartFiles: string[]): void {
  topo.router = topo.router ?? 'flutter-routes';
  const pubspecText = readTextSafe(join(root, 'pubspec.yaml'));
  if (pubspecText) {
    try {
      const pub = parseYaml(pubspecText) as { name?: string; version?: string; dependencies?: Record<string, unknown> };
      result.packageName = result.packageName ?? pub.name ?? null;
      result.appIdentity.appName = result.appIdentity.appName ?? pub.name ?? null;
      result.appIdentity.version = result.appIdentity.version ?? (pub.version ? String(pub.version) : null);
      const deps = Object.keys(pub.dependencies ?? {});
      if (deps.includes('go_router')) topo.router = 'go_router';
      else if (deps.includes('auto_route')) topo.router = 'auto_route';
    } catch {
      topo.parserNotes.push('Failed to parse pubspec.yaml');
    }
  }
  for (const f of dartFiles) {
    const text = readTextSafe(f);
    if (!text) continue;
    const relPath = rel(root, f);
    // MaterialApp routes: { '/foo': (c) => FooPage() }
    for (const m of text.matchAll(/["']\/([A-Za-z0-9_\-/]*)["']\s*:\s*\(/g)) {
      const route = '/' + m[1];
      const id = `route:${slug(m[1] || 'home')}`;
      if (!topo.screens.some((s) => s.id === id))
        topo.screens.push({
          id,
          name: m[1] || 'home',
          route,
          kind: 'route',
          sourceFiles: [relPath],
          confidence: 0.75,
          reasons: ['flutter_named_route'],
        });
      topo.flutterRoutes.push(route);
    }
    // GoRoute(path: '/foo')
    for (const m of text.matchAll(/GoRoute\([^)]*path:\s*["']([^"']+)["']/g)) {
      const route = m[1];
      const id = `route:${slug(route.replace(/^\//, '') || 'home')}`;
      if (!topo.screens.some((s) => s.id === id))
        topo.screens.push({ id, name: route, route, kind: 'route', sourceFiles: [relPath], confidence: 0.8, reasons: ['go_router_route'] });
      topo.flutterRoutes.push(route);
    }
    if (/onGenerateRoute/.test(text)) topo.parserNotes.push(`onGenerateRoute in ${relPath} — dynamic routes not fully enumerated`);
  }
  // pages/screens under lib/screens, lib/pages, lib/features
  for (const f of dartFiles) {
    const relPath = rel(root, f);
    if (!/lib\/(screens|pages)\//.test(relPath) && !/lib\/features\/[^/]+\/(screens|pages|presentation)\//.test(relPath)) continue;
    const name = basename(f).replace(/\.dart$/, '');
    if (/^_/.test(name) || /_test$/.test(name)) continue;
    const id = `page:${slug(name)}`;
    if (!topo.screens.some((s) => s.id === id))
      topo.screens.push({ id, name, kind: 'page', sourceFiles: [relPath], confidence: 0.55, reasons: ['flutter_page_filename'] });
  }
  topo.flutterRoutes = uniq(topo.flutterRoutes);
}

// ---------------------------------------------------------------------------
// Cross-framework: auth / onboarding / paywalls from dependencies + screens
// ---------------------------------------------------------------------------

function detectFeatureModels(
  root: string,
  deps: Record<string, string>,
  topo: StaticTopology,
): { auth: AuthModel; onboarding: FlowModel | null; paywalls: FlowModel[] } {
  const depNames = Object.keys(deps);
  const authLibs = depNames.filter((d) => AUTH_LIB_RE.test(d));
  const paywallLibs = depNames.filter((d) => PAYWALL_LIB_RE.test(d));
  const authScreens = topo.screens
    .filter((s) => /login|signin|sign-in|auth|register|signup|sign-up|password/i.test(s.name) || /login|signin|auth/i.test(s.route ?? ''))
    .map((s) => s.id);
  const onboardingScreens = topo.screens.filter((s) => ONBOARDING_RE.test(s.name) || ONBOARDING_RE.test(s.route ?? '')).map((s) => s.id);
  const paywallScreens = topo.screens
    .filter((s) => /paywall|subscribe|subscription|premium|upgrade|pricing|plans?/i.test(s.name))
    .map((s) => s.id);

  const auth: AuthModel = {
    hasAuth: authLibs.length > 0 || authScreens.length > 0,
    signals: uniq([...authLibs, ...(authScreens.length ? ['auth_screen_detected'] : [])]),
    libraries: authLibs,
    screens: authScreens,
    confidence: Math.min(1, (authLibs.length ? 0.7 : 0) + (authScreens.length ? 0.5 : 0)),
  };
  const onboarding: FlowModel | null = onboardingScreens.length
    ? {
        id: 'flow:onboarding',
        kind: 'onboarding',
        present: true,
        signals: ['onboarding_screen_detected'],
        libraries: [],
        screens: onboardingScreens,
        confidence: 0.55,
      }
    : null;
  const paywalls: FlowModel[] =
    paywallLibs.length || paywallScreens.length
      ? [
          {
            id: 'flow:paywall',
            kind: 'paywall',
            present: true,
            signals: uniq([...paywallLibs.map((l) => `lib:${l}`), ...(paywallScreens.length ? ['paywall_screen_detected'] : [])]),
            libraries: paywallLibs,
            screens: paywallScreens,
            confidence: Math.min(1, (paywallLibs.length ? 0.7 : 0) + (paywallScreens.length ? 0.4 : 0)),
          },
        ]
      : [];
  return { auth, onboarding, paywalls };
}

// ---------------------------------------------------------------------------

/** Run the framework-appropriate static scanners. Always returns a result; never throws. */
export function staticScan(root: string, generatedAt: string): StaticScanResult {
  const fw = detectFramework(root);
  const topo: StaticTopology = {
    framework: fw,
    router: null,
    screens: [],
    edges: [],
    deepLinks: [],
    routeConstants: [],
    nativeActivities: [],
    viewControllers: [],
    flutterRoutes: [],
    permissions: [],
    parserNotes: [],
  };
  const deps = depsOf(root);
  const pkg = readJson(join(root, 'package.json'));
  const result: StaticScanResult = {
    staticTopology: topo,
    appIdentity: {},
    auth: { hasAuth: false, signals: [], libraries: [], screens: [], confidence: 0 },
    onboarding: null,
    paywalls: [],
    inputModels: [],
    sourceFingerprint: { generatedAt, files: [] },
    packageName: (pkg?.name as string) ?? null,
    collectedFiles: [],
  };

  try {
    if (fw === 'expo' || fw === 'bare-react-native') {
      const jsFiles = walkFiles(root, { exts: ['.ts', '.tsx', '.js', '.jsx'] });
      result.collectedFiles = jsFiles;
      scanExpoRn(root, fw, topo, result, jsFiles);
    } else if (fw === 'native-android') {
      result.collectedFiles = walkFiles(root, { exts: ['.kt', '.java', '.xml'], maxFiles: 3000 });
      scanNativeAndroid(root, topo, result);
    } else if (fw === 'native-ios') {
      const swift = walkFiles(root, { exts: ['.swift'], maxFiles: 3000 });
      result.collectedFiles = swift;
      scanNativeIos(root, topo, result, swift);
    } else if (fw === 'flutter') {
      const dart = walkFiles(root, { exts: ['.dart'], maxFiles: 3000 });
      result.collectedFiles = dart;
      scanFlutter(root, topo, result, dart);
    } else {
      topo.parserNotes.push(`Framework "${fw}" — no static scanner; map will rely on runtime observation`);
    }
  } catch (e) {
    topo.parserNotes.push(`Static scan error (non-fatal): ${String(e)}`);
  }

  // de-dupe deep links + permissions
  topo.deepLinks = uniq(topo.deepLinks);
  topo.permissions = uniq(topo.permissions);

  const models = detectFeatureModels(root, deps, topo);
  result.auth = models.auth;
  result.onboarding = models.onboarding;
  result.paywalls = models.paywalls;

  // Fingerprint structure-defining files: configs + the files that produced screens/edges.
  const structureFiles = uniq([
    ...['app.json', 'package.json', 'pubspec.yaml', 'app.config.js', 'app.config.ts'].map((n) => join(root, n)).filter(existsSync),
    ...topo.screens.flatMap((s) => s.sourceFiles.map((rp) => join(root, rp))),
  ]);
  result.sourceFingerprint = fingerprint(root, structureFiles, generatedAt);

  return result;
}

/** Detect form-library usage from deps (used by feature inference). */
export function hasFormLibrary(root: string): boolean {
  return Object.keys(depsOf(root)).some((d) => FORM_LIB_RE.test(d));
}
