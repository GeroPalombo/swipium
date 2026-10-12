// Shared Metro/dev-server readiness checks used by target preparation.

import net from 'node:net';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { run } from './spawn.js';

export const METRO_PORT = 8081;

export function metroListening(port = METRO_PORT, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

export async function reverseSet(serial: string, port = METRO_PORT): Promise<boolean> {
  try {
    const r = await run('adb', ['-s', serial, 'reverse', '--list'], { timeoutMs: 5000 });
    return r.stdout.includes(`tcp:${port}`);
  } catch {
    return false;
  }
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Does the Metro project root (the `X-React-Native-Project-Root` header) belong to this project?
 * Lenient for monorepos: either root may contain the other. Only an unrelated root is a mismatch. */
export function sameMetroProject(metroRoot: string, projectRoot: string): boolean {
  const a = realOrResolved(metroRoot);
  const b = realOrResolved(projectRoot);
  const within = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  return within(a, b) || within(b, a);
}

/** Is Metro actually SERVING (not just a port open)? Hits the host-side packager status. When
 * `projectRoot` is given, a Metro that reports a different project root (another project's
 * bundler holding the port) is NOT serving for us: `wrongProject` is set and `serving` is false. */
export async function bundleServing(
  port = METRO_PORT,
  projectRoot?: string,
): Promise<{ serving: boolean; detail: string; metroProjectRoot: string | null; wrongProject: boolean }> {
  try {
    const res = await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.text()).trim();
    const running = res.ok && /packager-status:running/.test(body);
    const metroProjectRoot = res.headers.get('x-react-native-project-root');
    const wrongProject = !!(running && projectRoot && metroProjectRoot && !sameMetroProject(metroProjectRoot, projectRoot));
    return {
      serving: running && !wrongProject,
      detail: wrongProject
        ? `port ${port} is used by another project's Metro (${metroProjectRoot}), not ${projectRoot}`
        : `${res.status} ${body.slice(0, 40)}`,
      metroProjectRoot,
      wrongProject,
    };
  } catch (e) {
    return { serving: false, detail: String(e), metroProjectRoot: null, wrongProject: false };
  }
}

export interface MetroReadiness {
  listening: boolean;
  reverseSet: boolean;
  serving: boolean;
  ready: boolean; // listening && reverseSet && serving
  detail: string;
  /** Project root the Metro on the port reports (X-React-Native-Project-Root), when known. */
  metroProjectRoot?: string | null;
  /** True when the Metro on the port serves a DIFFERENT project than `projectRoot` (AND-8). */
  wrongProject?: boolean;
}

/** Pass `projectRoot` (the session root) so another project's Metro on the port is not taken as ours. */
export async function metroReadiness(serial: string | undefined, port = METRO_PORT, projectRoot?: string): Promise<MetroReadiness> {
  const [listening, rev, srv] = await Promise.all([
    metroListening(port),
    serial ? reverseSet(serial, port) : Promise.resolve(false),
    bundleServing(port, projectRoot),
  ]);
  return {
    listening,
    reverseSet: rev,
    serving: srv.serving,
    ready: listening && rev && srv.serving,
    detail: srv.detail,
    ...(srv.metroProjectRoot ? { metroProjectRoot: srv.metroProjectRoot } : {}),
    ...(srv.wrongProject ? { wrongProject: true } : {}),
  };
}

/** Coded error text for another project's Metro holding the port (shared by qa_wait / prepare / qa_metro). */
export function wrongProjectMetroMessage(rd: MetroReadiness, projectRoot: string, port = METRO_PORT): string {
  return `Port ${port} is used by another project's Metro (${rd.metroProjectRoot ?? 'unknown root'}), not this project (${projectRoot}). Launching against it would load the wrong JS bundle.`;
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** The project's own Android package (Expo app.json `expo.android.package`, else the app module's
 * gradle `applicationId`), or null when it can't be read statically (e.g. a dynamic app.config.js). */
export function projectAndroidAppId(root: string): string | null {
  const cfg = readJsonSafe(join(root, 'app.json'));
  const expo = (cfg?.expo ?? cfg) as { android?: { package?: unknown } } | undefined;
  if (typeof expo?.android?.package === 'string') return expo.android.package;
  for (const g of ['android/app/build.gradle', 'android/app/build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts']) {
    const p = join(root, g);
    if (!existsSync(p)) continue;
    try {
      const m = readFileSync(p, 'utf8').match(/applicationId\s*[=\s]\s*["']([^"']+)["']/);
      if (m) return m[1];
    } catch {
      /* unreadable */
    }
  }
  return null;
}

/** AND-15: is `appId` (an explicit launch target, no project APK involved) this RN/Expo project's
 * own app, i.e. one that loads its JS from this project's Metro? An applicationIdSuffix variant
 * (`<pkg>.debug`) counts. When the project package can't be read, only platform apps
 * (com.android.*, com.google.android.*) are treated as foreign, so the Metro gate stays on. */
export function isProjectAndroidApp(root: string, appId: string): boolean {
  const own = projectAndroidAppId(root);
  if (own) return appId === own || appId.startsWith(`${own}.`);
  return !/^(android$|com\.android\.|com\.google\.android\.)/.test(appId);
}
