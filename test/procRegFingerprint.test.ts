// Reaper PID-reuse safety: an orphan entry is only signalled/adopted when BOTH the recorded start
// time and full command line still match; process groups are only signalled for children Swipium
// spawned as group leaders; a recycled server pid is not a "live owner". Fake `ps` via ProcessOps.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-procreg-fp-'));
process.env.HOME = fakeHome;

const reg = await import('../src/session/processRegistry.js');
type Entry = import('../src/session/processRegistry.js').ManagedProcessEntry;
type Ops = import('../src/session/processRegistry.js').ProcessOps;

const FILE = join(fakeHome, '.swipium', 'processes.json');
const DEAD = 424242;
const NOW = 1_800_000_000_000;
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));
beforeEach(() => rmSync(join(fakeHome, '.swipium'), { recursive: true, force: true }));

function seed(entries: Entry[]): void {
  mkdirSync(join(fakeHome, '.swipium'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(entries));
}
const registry = (): Entry[] => JSON.parse(readFileSync(FILE, 'utf8')) as Entry[];

interface Proc {
  cmd: string;
  start: string;
  pgid?: number;
}
function fakeOps(procs: Record<number, Proc>): Ops & { killed: Array<[number, boolean]> } {
  const killed: Array<[number, boolean]> = [];
  return {
    killed,
    pidAlive: (pid) => pid in procs,
    psCommand: (pid) => procs[pid]?.cmd ?? null,
    psStartTime: (pid) => procs[pid]?.start ?? null,
    psPgid: (pid) => (procs[pid] ? (procs[pid].pgid ?? 1) : null),
    killTree: (pid, group) => (killed.push([pid, group]), true),
  };
}

const METRO = 'node /repo/node_modules/.bin/expo start --port 8081';
const T1 = 'Mon Sep 28 10:00:00 2026';
const T2 = 'Mon Sep 28 11:30:00 2026';
const metro = (pid: number, over: Partial<Entry> = {}): Entry => ({
  pid,
  kind: 'metro',
  serverPid: DEAD,
  startedAt: NOW,
  procStart: T1,
  command: METRO,
  groupLeader: true,
  ...over,
});

describe('reaper fingerprint checks', () => {
  it('does not kill a recycled pid now running another node process (e.g. the MCP client)', async () => {
    seed([metro(11)]);
    const ops = fakeOps({ 11: { cmd: 'node /usr/local/bin/claude --mcp', start: T2 } });
    await reg.reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => false });
    expect(ops.killed).toEqual([]);
    expect(registry()).toEqual([]);
  });

  it('does not kill when the command matches but the start time differs (pid reuse, same command)', async () => {
    seed([metro(12)]);
    const ops = fakeOps({ 12: { cmd: METRO, start: T2 } });
    await reg.reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => false });
    expect(ops.killed).toEqual([]);
  });

  it('does not kill the adb server that recycled a recorder pid', async () => {
    seed([
      {
        pid: 13,
        kind: 'recording',
        serverPid: DEAD,
        startedAt: NOW,
        procStart: T1,
        command: 'adb -s emu shell screenrecord /sdcard/x.mp4',
      },
    ]);
    const ops = fakeOps({ 13: { cmd: 'adb -L tcp:5037 fork-server server --reply-fd 4', start: T2 } });
    await reg.reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => false });
    expect(ops.killed).toEqual([]);
  });

  it('never signals a legacy entry without a fingerprint', async () => {
    seed([{ pid: 14, kind: 'metro', serverPid: DEAD, startedAt: NOW }]);
    const ops = fakeOps({ 14: { cmd: METRO, start: T1 } });
    await reg.reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => false });
    expect(ops.killed).toEqual([]);
    expect(registry()).toEqual([]);
  });

  it('kills a verified orphan; the group only when Swipium made it a group leader', async () => {
    seed([metro(15), metro(16, { groupLeader: false }), metro(17, { groupLeader: undefined })]);
    const ops = fakeOps({ 15: { cmd: METRO, start: T1 }, 16: { cmd: METRO, start: T1 }, 17: { cmd: `  ${METRO}  `, start: T1 } });
    await reg.reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => false });
    expect(ops.killed.sort()).toEqual([
      [15, true],
      [16, false],
      [17, false],
    ]);
  });

  it('a recycled SERVER pid (another node process, different start) is not a live owner', async () => {
    const SERVER = 5000;
    seed([metro(18, { serverPid: SERVER, serverStart: T1 })]);
    const ops = fakeOps({ 18: { cmd: METRO, start: T1 }, [SERVER]: { cmd: 'node some-other-app.js', start: T2 } });
    await reg.reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => false });
    expect(ops.killed).toEqual([[18, true]]);
  });

  it('a genuinely live owner (same start time) keeps its child untouched', async () => {
    const SERVER = 5001;
    seed([metro(19, { serverPid: SERVER, serverStart: T1 })]);
    const ops = fakeOps({ 19: { cmd: METRO, start: T1 }, [SERVER]: { cmd: 'node dist/index.js', start: T1 } });
    await reg.reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => false });
    expect(ops.killed).toEqual([]);
    expect(registry().map((e) => e.pid)).toEqual([19]);
  });

  it("never adopts a recycled pid running the user's own xcodebuild WDA on the same port", async () => {
    const OURS =
      'xcodebuild -project /Users/me/.swipium/WDA/WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination id=AAAA test-without-building';
    const USERS =
      'xcodebuild -project /Users/me/appium/WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination id=AAAA test-without-building';
    seed([
      {
        pid: 20,
        kind: 'wda',
        serverPid: DEAD,
        startedAt: NOW,
        endpoint: 'http://127.0.0.1:8100',
        procStart: T1,
        command: OURS,
        groupLeader: true,
      },
    ]);
    const ops = fakeOps({ 20: { cmd: USERS, start: T2 } });
    let probes = 0;
    await reg.reapOrphanedProcesses({ ops, now: NOW, wdaHealthy: async () => (probes++, true) });
    expect(probes).toBe(0);
    expect(ops.killed).toEqual([]);
    expect(registry()).toEqual([]);
  });

  it('reclaimPid with no registry entry (session-store metroPid path) never signals', () => {
    const ops = fakeOps({ 21: { cmd: METRO, start: T1 } });
    expect(reg.reclaimPid(21, 'metro', ops)).toBe('recycled');
    expect(ops.killed).toEqual([]);
  });

  it('registerManagedProcess records the fingerprint captured at spawn', () => {
    const ops = fakeOps({ 22: { cmd: METRO, start: T1, pgid: 22 }, [process.pid]: { cmd: 'node dist/index.js', start: T2 } });
    reg.registerManagedProcess(22, 'metro', 's1', { ops });
    expect(registry()[0]).toMatchObject({ pid: 22, procStart: T1, command: METRO, groupLeader: true, serverStart: T2 });
    // and the store-path reclaim now finds and verifies it
    expect(reg.reclaimPid(22, 'metro', ops)).toBe('killed');
    expect(ops.killed).toEqual([[22, true]]);
  });

  it.skipIf(process.platform === 'win32')('real ps: captures a start time and command for this process', () => {
    const fp = reg.captureFingerprint(process.pid);
    expect(fp.procStart).toBeTruthy();
    expect(fp.command).toMatch(/node|vitest/i);
  });
});
