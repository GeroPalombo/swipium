// Real iOS smoke (2.0.0): `qa_wda start` spawns `xcodebuild -project …`, but Xcode's
// /usr/bin/xcodebuild shim re-execs the real tool under the SAME pid + start time, so `ps` later
// reads `/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project …`. The exact
// command match made a healthy WDA unadoptable ("PID recycled or fingerprint unverifiable"),
// unreapable, and unstoppable. Start time stays the hard guard; the program is compared by
// basename and the argument tail exactly. `qa_wda stop` can also locate its WDA by signature.
// Hermetic: HOME → temp dir before the registry loads; ps/lsof/signals are faked.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-smokeios-procreg-'));
process.env.HOME = fakeHome;

const reg = await import('../src/session/processRegistry.js');
const { lastManagedWdaStart } = await import('../src/tools/wda.js');
type Entry = import('../src/session/processRegistry.js').ManagedProcessEntry;
type Ops = import('../src/session/processRegistry.js').ProcessOps;

const FILE = join(fakeHome, '.swipium', 'processes.json');
const DEAD_SERVER = 424242;
const NOW = 1_800_000_000_000;
const T1 = 'Wed Sep 30 07:11:30 2026';
const T2 = 'Wed Sep 30 09:00:00 2026';
const UDID = '190EA878-5D54-416C-B858-E60588B0DAF9';
const PROJECT = '/Users/gp/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj';
const DD = '/proj/.swipium/cache/wda-derived-data';
const ARGS = `-project ${PROJECT} -scheme WebDriverAgentRunner -destination id=${UDID} -derivedDataPath ${DD} test-without-building`;
const SPAWNED = `xcodebuild ${ARGS}`; // captured right after spawn()
const SHIM = `/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild ${ARGS}`; // after the shim re-exec

afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));
beforeEach(() => rmSync(join(fakeHome, '.swipium'), { recursive: true, force: true }));

function seed(entries: Entry[]): void {
  mkdirSync(join(fakeHome, '.swipium'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(entries));
}
const registry = (): Entry[] => JSON.parse(readFileSync(FILE, 'utf8')) as Entry[];

function ops(procs: Record<number, { cmd: string; start: string }>): Ops & { killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    pidAlive: (pid) => pid in procs,
    psCommand: (pid) => procs[pid]?.cmd ?? null,
    psStartTime: (pid) => procs[pid]?.start ?? null,
    psPgid: (pid) => (pid in procs ? pid : null),
    killTree: (pid) => (killed.push(pid), true),
  };
}
const wdaEntry = (over: Partial<Entry> = {}): Entry => ({
  pid: 16824,
  kind: 'wda',
  serverPid: DEAD_SERVER,
  sessionId: '9fbfac63',
  startedAt: NOW - 60_000,
  endpoint: 'http://127.0.0.1:8100',
  procStart: T1,
  command: SPAWNED,
  groupLeader: true,
  ...over,
});

describe('WDA fingerprint survives the xcodebuild shim re-exec', () => {
  it('healthy WDA recorded as `xcodebuild …` but live as `/Applications/Xcode.app/…/xcodebuild …` is ADOPTED', async () => {
    seed([wdaEntry()]);
    const o = ops({ 16824: { cmd: SHIM, start: T1 } });
    await reg.reapOrphanedProcesses({ ops: o, now: NOW, wdaHealthy: async () => true });
    expect(o.killed).toEqual([]);
    expect(registry()).toEqual([expect.objectContaining({ pid: 16824, serverPid: process.pid })]);
    expect(reg.registeredWdaForSession('9fbfac63')?.pid).toBe(16824);
  });

  it('an unhealthy orphan with the shim path is REAPED (not dropped as recycled)', async () => {
    seed([wdaEntry()]);
    const o = ops({ 16824: { cmd: SHIM, start: T1 } });
    await reg.reapOrphanedProcesses({ ops: o, now: NOW, wdaHealthy: async () => false });
    expect(o.killed).toEqual([16824]);
    expect(registry()).toEqual([]);
  });

  it('reclaimPid (qa_wda stop of an adopted WDA) kills the shim-path process', () => {
    const o = ops({ 16824: { cmd: SHIM, start: T1 } });
    expect(reg.reclaimPid(16824, 'wda', o, wdaEntry())).toBe('killed');
    expect(o.killed).toEqual([16824]);
  });

  it('an Xcode path with spaces (Xcode 16.app) still matches', () => {
    const o = ops({ 16824: { cmd: `/Applications/Xcode 16.app/Contents/Developer/usr/bin/xcodebuild ${ARGS}`, start: T1 } });
    expect(reg.reclaimPid(16824, 'wda', o, wdaEntry())).toBe('killed');
  });

  it('start time stays the hard guard: same shim command, different start → never signalled', () => {
    const o = ops({ 16824: { cmd: SHIM, start: T2 } });
    expect(reg.reclaimPid(16824, 'wda', o, wdaEntry())).toBe('recycled');
    expect(o.killed).toEqual([]);
  });

  it('a different argument tail (another project / simulator) is never signalled', () => {
    const other = SHIM.replace(UDID, 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
    const o = ops({ 16824: { cmd: other, start: T1 } });
    expect(reg.reclaimPid(16824, 'wda', o, wdaEntry())).toBe('recycled');
    expect(o.killed).toEqual([]);
  });

  it('flags or another program before xcodebuild do not anchor', () => {
    expect(reg.programTail(`/bin/sh -c xcodebuild ${ARGS}`, /^xcodebuild$/)).toBeNull();
    expect(reg.programTail(`/usr/bin/ruby wrapper.rb /x/xcodebuild ${ARGS}`, /^xcodebuild$/)).toBeNull();
    expect(reg.programTail(SHIM, /^xcodebuild$/)).toBe(SPAWNED);
  });

  it('xcrun simctl recordings match their re-exec`d simctl path', () => {
    const rec: Entry = { ...wdaEntry(), kind: 'recording', command: `xcrun simctl io ${UDID} recordVideo --codec h264 /tmp/a.mp4` };
    const o = ops({
      16824: { cmd: `/Applications/Xcode.app/Contents/Developer/usr/bin/simctl io ${UDID} recordVideo --codec h264 /tmp/a.mp4`, start: T1 },
    });
    expect(reg.reclaimPid(16824, 'recording', o, rec)).toBe('killed');
  });
});

describe('qa_wda stop without a registry entry: locate the managed WDA by signature', () => {
  const sig = { projectPath: PROJECT, udid: UDID, derivedDataPath: DD, port: 8100 };
  const scan = (listeners: Record<number, number[]>, procs: Array<{ pid: number; command: string }>) => ({
    listeners: (port: number) => listeners[port] ?? [],
    listProcesses: () => procs,
    psCommand: (pid: number) => procs.find((p) => p.pid === pid)?.command ?? null,
  });

  it('the xcodebuild LISTENing on the managed port is returned', () => {
    expect(reg.findManagedWdaProcesses(sig, scan({ 8100: [16824] }, [{ pid: 16824, command: SHIM }]))).toEqual([16824]);
  });

  it('listener is the XCTest runner (simulator) → ps scan finds the matching xcodebuild only', () => {
    const procs = [
      { pid: 20001, command: '/Users/gp/Library/Developer/CoreSimulator/…/WebDriverAgentRunner-Runner' },
      { pid: 16824, command: SHIM },
      { pid: 16900, command: SHIM.replace(UDID, 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE') }, // another simulator
      { pid: 16901, command: SHIM.replace(DD, '/Users/gp/Library/Developer/Xcode/DerivedData/appium') }, // Appium's own WDA
      { pid: 16902, command: `/usr/bin/grep xcodebuild ${ARGS}` },
    ];
    expect(reg.findManagedWdaProcesses(sig, scan({ 8100: [20001] }, procs))).toEqual([16824]);
  });

  it('nothing matching → nothing returned (never signal by port alone)', () => {
    expect(
      reg.findManagedWdaProcesses(sig, scan({ 8100: [16824] }, [{ pid: 16824, command: '/usr/bin/python3 -m http.server 8100' }])),
    ).toEqual([]);
  });

  it('killManagedWda signals the group when the process leads one', () => {
    const calls: Array<[number, boolean]> = [];
    reg.killManagedWda(16824, { psPgid: () => 16824, killTree: (pid, group) => (calls.push([pid, group]), true) });
    reg.killManagedWda(16825, { psPgid: () => 1, killTree: (pid, group) => (calls.push([pid, group]), true) });
    expect(calls).toEqual([
      [16824, true],
      [16825, false],
    ]);
  });

  it('lastManagedWdaStart reads the session mutation ledger (survives a restart)', () => {
    const mutations = [
      {
        id: 'm1',
        at: 1,
        tool: 'qa_wda',
        action: 'wda_start',
        risk: 'medium' as const,
        target: { udid: UDID, projectPath: PROJECT, derivedDataPath: DD, pid: 16824, webDriverAgentUrl: 'http://127.0.0.1:8100' },
        status: 'executed' as const,
      },
      {
        id: 'm2',
        at: 2,
        tool: 'qa_wda',
        action: 'wda_start',
        risk: 'medium' as const,
        target: { udid: UDID, projectPath: '/x' },
        status: 'requested' as const,
      },
    ];
    expect(lastManagedWdaStart({ mutations })).toEqual({ projectPath: PROJECT, udid: UDID, derivedDataPath: DD, port: 8100 });
    expect(lastManagedWdaStart({ mutations: [] })).toBeUndefined();
  });
});
