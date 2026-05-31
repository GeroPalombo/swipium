// Shared Metro/dev-server readiness checks used by target preparation.

import net from 'node:net';
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

/** Is Metro actually SERVING (not just a port open)? Hits the host-side packager status. */
export async function bundleServing(port = METRO_PORT): Promise<{ serving: boolean; detail: string }> {
  try {
    const res = await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.text()).trim();
    return { serving: res.ok && /packager-status:running/.test(body), detail: `${res.status} ${body.slice(0, 40)}` };
  } catch (e) {
    return { serving: false, detail: String(e) };
  }
}

export interface MetroReadiness {
  listening: boolean;
  reverseSet: boolean;
  serving: boolean;
  ready: boolean; // listening && reverseSet && serving
  detail: string;
}

export async function metroReadiness(serial: string | undefined, port = METRO_PORT): Promise<MetroReadiness> {
  const [listening, rev, srv] = await Promise.all([
    metroListening(port),
    serial ? reverseSet(serial, port) : Promise.resolve(false),
    bundleServing(port),
  ]);
  return { listening, reverseSet: rev, serving: srv.serving, ready: listening && rev && srv.serving, detail: srv.detail };
}
