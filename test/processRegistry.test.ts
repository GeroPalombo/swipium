// Startup orphan sweep: a managed WDA left by a previous server run is ADOPTED (kept, re-owned)
// when it is < 12 h old and its endpoint answers /status healthy; otherwise it is reaped like any
// other orphan. Hermetic: HOME → temp dir BEFORE the registry module loads; pids / `ps` / signals
// are faked through the injectable ProcessOps, /status through a local HTTP server.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-procreg-home-'));
process.env.HOME = fakeHome;

const { reapOrphanedProcesses, registeredWdaForSession, WDA_ADOPT_MAX_AGE_MS } = await import('../src/session/processRegistry.js');
type Entry = import('../src/session/processRegistry.js').ManagedProcessEntry;
type Ops = import('../src/session/processRegistry.js').ProcessOps;

const FILE = join(fakeHome, '.swipium', 'processes.json');
const DEAD_SERVER = 424242;
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

function seed(entries: Entry[]): void {
  mkdirSync(join(fakeHome, '.swipium'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(entries));
}
const registry = (): Entry[] => JSON.parse(readFileSync(FILE, 'utf8')) as Entry[];

/** Fake OS: `commands` maps live pids to their `ps` command line; everything else is dead. */
function fakeOps(commands: Record<number, string>): Ops & { killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    pidAlive: (pid) => pid in commands,
    psCommand: (pid) => commands[pid] ?? null,
    killTree: (pid) => (killed.push(pid), true),
  };
}

const XCODEBUILD = 'xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner test-without-building';
const wda = (pid: number, over: Partial<Entry> = {}): Entry => ({
  pid,
  kind: 'wda',
  serverPid: DEAD_SERVER,
  sessionId: `sess-${pid}`,
  startedAt: NOW - HOUR,
  endpoint: `http://127.0.0.1:${8100 + (pid % 100)}`,
  ...over,
});

beforeEach(() => rmSync(join(fakeHome, '.swipium'), { recursive: true, force: true }));

describe('reapOrphanedProcesses — managed WDA adoption', () => {
  it('adopts a young WDA whose /status is healthy: entry kept and re-owned; not signalled', async () => {
    seed([wda(101)]);
    const ops = fakeOps({ 101: XCODEBUILD });
    const probed: string[] = [];
    await reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async (u) => (probed.push(u), true) });
    expect(ops.killed).toEqual([]);
    expect(probed).toEqual(['http://127.0.0.1:8101']);
    const [e] = registry();
    expect(e).toMatchObject({ pid: 101, kind: 'wda', serverPid: process.pid, startedAt: NOW - HOUR, sessionId: 'sess-101' });
    // …so `qa_wda stop` on that session can find (and stop) it.
    expect(registeredWdaForSession('sess-101')?.pid).toBe(101);
  });

  it('reaps a WDA whose /status is unhealthy / unreachable', async () => {
    seed([wda(102)]);
    const ops = fakeOps({ 102: XCODEBUILD });
    await reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => false });
    expect(ops.killed).toEqual([102]);
    expect(registry()).toEqual([]);
  });

  it('reaps a healthy WDA older than 12 h without probing it', async () => {
    seed([wda(103, { startedAt: NOW - WDA_ADOPT_MAX_AGE_MS - 1 })]);
    const ops = fakeOps({ 103: XCODEBUILD });
    let probes = 0;
    await reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => (probes++, true) });
    expect(probes).toBe(0);
    expect(ops.killed).toEqual([103]);
    expect(registry()).toEqual([]);
  });

  it('reaps a WDA entry with no recorded endpoint (cannot verify health)', async () => {
    seed([wda(104, { endpoint: undefined })]);
    const ops = fakeOps({ 104: XCODEBUILD });
    await reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => true });
    expect(ops.killed).toEqual([104]);
  });

  it('never adopts (or signals) a recycled pid, even if something healthy answers the endpoint', async () => {
    seed([wda(105)]);
    const ops = fakeOps({ 105: '/usr/bin/some-unrelated-daemon' });
    await reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => true });
    expect(ops.killed).toEqual([]);
    expect(registry()).toEqual([]);
  });

  it('keeps reaping other kinds as before; a live concurrent owner is untouched', async () => {
    const LIVE_SERVER = 515151;
    seed([
      { pid: 201, kind: 'metro', serverPid: DEAD_SERVER, startedAt: NOW - HOUR },
      { pid: 202, kind: 'recording', serverPid: DEAD_SERVER, startedAt: NOW - HOUR },
      { pid: 203, kind: 'emulator', serverPid: DEAD_SERVER, startedAt: NOW - HOUR },
      wda(204, { serverPid: LIVE_SERVER }),
    ]);
    const ops = fakeOps({
      201: 'node node_modules/.bin/react-native start',
      202: 'xcrun simctl io booted recordVideo out.mp4',
      203: 'qemu-system-aarch64 -avd Pixel',
      204: XCODEBUILD,
      [LIVE_SERVER]: 'node dist/index.js',
    });
    await reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => true });
    expect(ops.killed.sort()).toEqual([201, 202]);
    expect(registry().map((e) => [e.pid, e.serverPid])).toEqual([[204, LIVE_SERVER]]); // emulator adopted-and-dropped
  });

  it('default probe hits the real GET /status of the recorded endpoint', async () => {
    let ready = true;
    const srv: Server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/status' ? { value: { ready, state: ready ? 'success' : 'x' } } : {}));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      seed([wda(301, { endpoint: `http://127.0.0.1:${port}` })]);
      const ops = fakeOps({ 301: XCODEBUILD });
      await reapOrphanedProcesses({ ops, now: NOW });
      expect(ops.killed).toEqual([]);
      expect(registry()[0]?.serverPid).toBe(process.pid);

      ready = false;
      seed([wda(302, { endpoint: `http://127.0.0.1:${port}` })]);
      const ops2 = fakeOps({ 302: XCODEBUILD });
      await reapOrphanedProcesses({ ops: ops2, now: NOW });
      expect(ops2.killed).toEqual([302]);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
