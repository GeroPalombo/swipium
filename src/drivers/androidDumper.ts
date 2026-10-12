// Opt-in persistent Android UI dumper (SWIPIUM_ANDROID_DUMPER=agent).
//
// `adb exec-out uiautomator dump` starts a new app_process, connects UiAutomation and waits
// for a 1 s idle window on EVERY call (~2 s on an API 36 emulator). The agent
// (android-agent/, a ~6 KB dex jar run with app_process like scrcpy; no APK install) keeps ONE
// UiAutomation connection open and serves the same XML over localabstract:swipium-dumper,
// reached through `adb forward`, with a 250 ms quiet window counted from the request.
//
// Device write: the jar is pushed to /data/local/tmp. That is why it is opt-in by env. Server
// shutdown (shutdownAndroidDumpers) removes the adb forwards and the jar this process left.
// While the agent runs it holds the device's single UiAutomation slot, so `uiautomator dump`
// (and Appium UiAutomator2 / Maestro) cannot connect: callers must stopAndroidDumper() before
// falling back. The agent exits by itself after AGENT_IDLE_EXIT_MS without requests.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { log } from '../lib/logger.js';
import { run } from '../lib/spawn.js';

export const DEVICE_JAR = '/data/local/tmp/swipium-dumper.jar';
export const SOCKET_NAME = 'swipium-dumper';
const MAIN_CLASS = 'com.swipium.dumper.Main';
const AGENT_IDLE_EXIT_MS = 120_000;
const START_TIMEOUT_MS = 8_000;
/** Quiet window the agent waits for (from the request) before reading the tree. */
export const DUMP_IDLE_MS = 250;
/** Cap on that wait; on a never-idle screen the agent dumps anyway after this. */
const DUMP_IDLE_TIMEOUT_MS = 2_000;
/** After a failure, use exec-out for this long before trying the agent again. */
const FAILURE_COOLDOWN_MS = 60_000;

/** Is the agent dumper requested? Default off. */
export function androidDumperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SWIPIUM_ANDROID_DUMPER ?? '').trim().toLowerCase() === 'agent';
}

/** The prebuilt dex jar shipped in the package (src/ and dist/ are both two levels deep). */
export function agentJarPath(): string {
  return fileURLToPath(new URL('../../android-agent/prebuilt/swipium-dumper.jar', import.meta.url));
}

/** PURE: validate an agent DUMP response; returns the XML or throws with the agent's error. */
export function parseAgentResponse(body: string): string {
  if (body.startsWith('ERR')) throw new Error(`android dumper: ${body.trim()}`);
  const idx = body.indexOf('<?xml');
  if (idx < 0 || !body.includes('</hierarchy>')) throw new Error(`android dumper: incomplete response (${body.length} bytes)`);
  return body.slice(idx);
}

interface AgentState {
  port: number;
  child?: ChildProcess;
}

const agents = new Map<string, AgentState>();
const starting = new Map<string, Promise<AgentState>>();
const disabledUntil = new Map<string, number>();
// What this process left on each device (serial key): its adb forward ports and whether it pushed
// the jar. shutdownAndroidDumpers() removes them; stop/failure paths keep this in sync.
const leftovers = new Map<string, { serial?: string; ports: Set<number>; jar: boolean }>();

function leftoverFor(serial?: string): { serial?: string; ports: Set<number>; jar: boolean } {
  let l = leftovers.get(key(serial));
  if (!l) leftovers.set(key(serial), (l = { serial, ports: new Set(), jar: false }));
  return l;
}

function key(serial?: string): string {
  return serial ?? '';
}

function base(serial?: string): string[] {
  return serial ? ['-s', serial] : [];
}

/** One request per connection: write the line, read to EOF. */
export function agentRequest(port: number, line: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`${line}\n`));
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`android dumper: no answer to ${line.split(' ')[0]} in ${timeoutMs} ms`));
    }, timeoutMs);
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function forward(serial?: string): Promise<number> {
  const r = await run('adb', [...base(serial), 'forward', 'tcp:0', `localabstract:${SOCKET_NAME}`], {
    timeoutMs: 5000,
    rejectOnNonZero: true,
  });
  const port = Number(r.stdout.trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`android dumper: adb forward gave no port (${r.stdout.trim()})`);
  leftoverFor(serial).ports.add(port);
  return port;
}

async function ping(port: number): Promise<boolean> {
  try {
    return (await agentRequest(port, 'PING', 1500)).startsWith('PONG');
  } catch {
    return false;
  }
}

function removeForward(serial: string | undefined, port: number, timeoutMs = 5000): Promise<unknown> {
  leftovers.get(key(serial))?.ports.delete(port);
  return run('adb', [...base(serial), 'forward', '--remove', `tcp:${port}`], { timeoutMs }).catch(() => undefined);
}

function removeJar(serial: string | undefined, timeoutMs = 5000): Promise<unknown> {
  const l = leftovers.get(key(serial));
  if (l) l.jar = false;
  return run('adb', [...base(serial), 'shell', 'rm', '-f', DEVICE_JAR], { timeoutMs }).catch(() => undefined);
}

async function startAgent(serial?: string): Promise<AgentState> {
  const port = await forward(serial);
  try {
    return await launchAgent(serial, port);
  } catch (e) {
    await removeForward(serial, port); // a failed start must not leave its forward behind
    throw e;
  }
}

async function launchAgent(serial: string | undefined, port: number): Promise<AgentState> {
  // An agent already running on the device (an earlier or parallel Swipium process): reuse it.
  if (await ping(port)) return { port };
  const jar = agentJarPath();
  if (!existsSync(jar)) throw new Error(`android dumper: jar missing at ${jar}`);
  leftoverFor(serial).jar = true; // set before the push: a push that fails midway can still leave a file
  await run('adb', [...base(serial), 'push', jar, DEVICE_JAR], { timeoutMs: 15000, rejectOnNonZero: true });
  const child = spawn(
    'adb',
    [...base(serial), 'shell', `CLASSPATH=${DEVICE_JAR} exec app_process / ${MAIN_CLASS} ${SOCKET_NAME} ${AGENT_IDLE_EXIT_MS}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.unref();
  child.on('error', () => undefined); // a spawn failure surfaces as "not ready"/exit below, never an uncaught 'error'
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(
      () => done(new Error(`android dumper: not ready in ${START_TIMEOUT_MS} ms: ${out.slice(-300)}`)),
      START_TIMEOUT_MS,
    );
    const done = (err?: Error) => {
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.removeListener('exit', onExit);
      if (err) {
        child.kill();
        reject(err);
      } else resolve();
    };
    const onExit = (code: number | null) => done(new Error(`android dumper: agent exited (${code}): ${out.slice(-300)}`));
    const onData = (c: Buffer) => {
      out += c.toString();
      if (out.includes('READY')) done();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
    child.once('exit', onExit);
  });
  // Keep the pipes drained but don't hold the event loop open for them.
  child.stdout?.resume();
  child.stderr?.resume();
  for (const s of [child.stdout, child.stderr]) (s as unknown as { unref?: () => void } | null)?.unref?.();
  return { port, child };
}

async function ensureAgent(serial?: string): Promise<AgentState> {
  const k = key(serial);
  const have = agents.get(k);
  if (have && (!have.child || (have.child.exitCode === null && have.child.signalCode === null))) return have;
  agents.delete(k);
  // The agent exited (idle timeout): drop its forward, a restart makes a new one.
  if (have) await removeForward(serial, have.port);
  let p = starting.get(k);
  if (!p) {
    p = startAgent(serial).finally(() => starting.delete(k));
    starting.set(k, p);
  }
  const st = await p;
  agents.set(k, st);
  return st;
}

/** True when the agent should be tried for this serial (enabled and not cooling down). */
export function androidDumperUsable(serial?: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!androidDumperEnabled(env)) return false;
  return Date.now() >= (disabledUntil.get(key(serial)) ?? 0);
}

/** Dump via the agent; throws on any failure (the caller falls back to exec-out). */
export async function agentDump(serial: string | undefined, timeoutMs = 10_000): Promise<string> {
  const st = await ensureAgent(serial);
  const idleTimeout = Math.max(0, Math.min(DUMP_IDLE_TIMEOUT_MS, timeoutMs - 1000));
  return parseAgentResponse(await agentRequest(st.port, `DUMP ${DUMP_IDLE_MS} ${idleTimeout}`, timeoutMs));
}

/** Stop the agent (frees the UiAutomation slot), drop the forward and the jar. Best-effort. */
export async function stopAndroidDumper(serial?: string): Promise<void> {
  const k = key(serial);
  const st = agents.get(k);
  agents.delete(k);
  let port = st?.port;
  try {
    if (port === undefined) port = await forward(serial);
    await agentRequest(port, 'QUIT', 1500);
  } catch {
    // not running
  }
  st?.child?.kill();
  if (port !== undefined) await removeForward(serial, port);
  await removeJar(serial);
}

/** Shutdown budget for shutdownAndroidDumpers (all devices together). */
export const DUMPER_SHUTDOWN_BUDGET_MS = 1000;

/**
 * Server shutdown: stop this process's agents and remove every adb forward it made and the jar it
 * pushed, on every serial (including an agent that already exited on idle). Best effort, in
 * parallel, and never longer than budgetMs: an unreachable device must not hold up the exit.
 */
export async function shutdownAndroidDumpers(budgetMs = DUMPER_SHUTDOWN_BUDGET_MS): Promise<void> {
  const work: Array<Promise<unknown>> = [];
  const step = Math.max(100, budgetMs - 100);
  for (const l of leftovers.values()) {
    const st = agents.get(key(l.serial));
    agents.delete(key(l.serial));
    work.push(
      (async () => {
        if (st?.child && st.child.exitCode === null && st.child.signalCode === null) {
          await agentRequest(st.port, 'QUIT', Math.min(400, step)).catch(() => undefined);
          st.child.kill();
        }
        await Promise.all([...[...l.ports].map((p) => removeForward(l.serial, p, step)), l.jar ? removeJar(l.serial, step) : undefined]);
      })(),
    );
  }
  if (!work.length) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.all(work), new Promise((r) => (timer = setTimeout(r, budgetMs)))]);
  clearTimeout(timer);
}

/** Agent failed: stop it so exec-out can connect, and use exec-out for a while. */
export async function noteAndroidDumperFailure(serial?: string, err?: unknown): Promise<void> {
  disabledUntil.set(key(serial), Date.now() + FAILURE_COOLDOWN_MS);
  log('warn', 'android dumper failed; using uiautomator dump for a while', {
    serial,
    cooldownMs: FAILURE_COOLDOWN_MS,
    err: String((err as Error)?.message ?? err),
  });
  await stopAndroidDumper(serial);
}

// Don't leave an agent holding the UiAutomation slot after Swipium exits (it would also exit
// on its own after AGENT_IDLE_EXIT_MS). Sync: only kills the local adb shell clients.
process.once('exit', () => {
  for (const st of agents.values()) st.child?.kill();
});
