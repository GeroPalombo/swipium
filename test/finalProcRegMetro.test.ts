// Integration fixes (2.0.0 final):
//  - (HIGH) an orphaned Metro was never reaped: it is spawned via `npx`, and npm retitles the
//    process (`node …/npx react-native start` → `npm exec react-native start`) right after spawn, so
//    the exact command-line fingerprint never matched again and the startup sweep / store reload
//    classified it as "recycled" and dropped it without signalling (Metro kept :8081). Identity is
//    now the exact START TIME (hard pid-recycling guard) + a per-kind command check that tolerates
//    the npx → `npm exec` retitle for Metro only.
//  - (LOW) `ps -o lstart=` is locale-dependent (`Mo. 28 Sep.` under de_DE): every ps we parse now
//    runs with LC_ALL=C / LANG=C.
// Hermetic: HOME points at a temp dir BEFORE the registry module is loaded. Real processes are
// spawned (detached, in their own group) and always killed in afterAll.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-final-procreg-'));
process.env.HOME = fakeHome;

const cp = await import('node:child_process');
const reg = await import('../src/session/processRegistry.js');
const { stopAllMetro } = await import('../src/tools/metro.js');
type Entry = import('../src/session/processRegistry.js').ManagedProcessEntry;
type Ops = import('../src/session/processRegistry.js').ProcessOps;

const FILE = join(fakeHome, '.swipium', 'processes.json');
const DEAD_SERVER = 424242;
const work = mkdtempSync(join(tmpdir(), 'swipium-final-npx-'));
const children: ChildProcess[] = [];

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}
afterAll(() => {
  for (const c of children) killGroup(c.pid);
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => rmSync(join(fakeHome, '.swipium'), { recursive: true, force: true }));

const registry = (): Entry[] => JSON.parse(readFileSync(FILE, 'utf8')) as Entry[];
const livePs = (pid: number): string =>
  (cp.spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim();

function spawnDetached(cmd: string, args: string[]): ChildProcess {
  const child = cp.spawn(cmd, args, { cwd: work, detached: true, stdio: 'ignore' });
  children.push(child);
  return child;
}
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}
/** Simulate a crash: the entry's owning server is a dead pid. */
function orphanAll(): void {
  writeFileSync(FILE, JSON.stringify(registry().map((e) => ({ ...e, serverPid: DEAD_SERVER, serverStart: 'Thu Jan  1 00:00:00 1970' }))));
}

describe.skipIf(process.platform === 'win32')('orphaned Metro spawned via npx is reaped despite the npm retitle', () => {
  it('real `npx <bin> start`: registered right after spawn, retitled to `npm exec …`, then reaped', async () => {
    // A local bin so npx resolves offline, exactly like `npx react-native start` in an RN repo.
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'npx-fixture', version: '1.0.0' }));
    mkdirSync(join(work, 'node_modules', '.bin'), { recursive: true });
    const bin = join(work, 'node_modules', '.bin', 'sleeper');
    writeFileSync(bin, '#!/usr/bin/env node\nsetTimeout(() => {}, 120000);\n');
    chmodSync(bin, 0o755);

    const child = spawnDetached('npx', ['sleeper', 'start', '--port', '8081']);
    reg.registerManagedProcess(child.pid, 'metro', 'sess-npx');
    const recorded = registry()[0];
    expect(recorded.procStart).toBeTruthy();
    expect(await waitFor(() => /npm exec sleeper start/.test(livePs(child.pid!)), 10_000)).toBe(true);

    orphanAll();
    await reg.reapOrphanedProcesses({ wdaHealthy: async () => false });
    expect(registry()).toEqual([]);
    // SIGTERM delivered to the npx group → the launcher exits.
    expect(await waitFor(() => child.exitCode != null || child.signalCode != null, 5000)).toBe(true);
  }, 20_000);

  it('node launcher named npx that retitles itself after registration is reaped (deterministic rewrite)', async () => {
    const fakeNpx = join(work, 'npx');
    writeFileSync(
      fakeNpx,
      "setTimeout(() => { process.title = 'npm exec react-native start --port 8081'; }, 400);\nsetTimeout(() => {}, 120000);\n",
    );
    const child = spawnDetached(process.execPath, [fakeNpx, 'react-native', 'start', '--port', '8081']);
    // Wait until node is running our script (not mid-exec), then register it.
    expect(await waitFor(() => livePs(child.pid!).includes(fakeNpx), 5000)).toBe(true);
    reg.registerManagedProcess(child.pid, 'metro', 'sess-title');
    expect(registry()[0].command).toContain(fakeNpx);
    expect(await waitFor(() => livePs(child.pid!).startsWith('npm exec react-native start'), 5000)).toBe(true);

    expect(reg.reclaimPid(child.pid!, 'metro')).toBe('killed');
    expect(await waitFor(() => child.signalCode != null, 5000)).toBe(true);
    expect(child.signalCode).toBe('SIGTERM');
  }, 15_000);
});

describe('fingerprint identity: exact start time + per-kind command', () => {
  const T1 = 'Mon Sep 28 10:00:00 2026';
  const T2 = 'Mon Sep 28 11:30:00 2026';
  function ops(procs: Record<number, { cmd: string; start: string }>): Ops & { killed: number[] } {
    const killed: number[] = [];
    return {
      killed,
      pidAlive: (pid) => pid in procs,
      psCommand: (pid) => procs[pid]?.cmd ?? null,
      psStartTime: (pid) => procs[pid]?.start ?? null,
      psPgid: () => 1,
      killTree: (pid) => (killed.push(pid), true),
    };
  }
  const entry = (kind: Entry['kind'], command: string): Entry => ({
    pid: 7001,
    kind,
    serverPid: DEAD_SERVER,
    startedAt: Date.now(),
    procStart: T1,
    command,
    groupLeader: true,
  });

  it('commandTail strips node/npx/npm launchers', () => {
    expect(reg.commandTail('node /opt/homebrew/bin/npx expo start --port 8081')).toBe('expo start --port 8081');
    expect(reg.commandTail('npm exec expo start --port 8081')).toBe('expo start --port 8081');
    expect(reg.commandTail('node /usr/lib/node_modules/npm/bin/npx-cli.js react-native start')).toBe('react-native start');
  });

  it('metro: retitled command + SAME start time → killed', () => {
    const o = ops({ 7001: { cmd: 'npm exec react-native start --port 8081', start: T1 } });
    expect(reg.reclaimPid(7001, 'metro', o, entry('metro', 'node /usr/local/bin/npx react-native start --port 8081'))).toBe('killed');
    expect(o.killed).toEqual([7001]);
  });

  it('metro: same retitled command but a DIFFERENT start time (recycled pid) → never signalled', () => {
    const o = ops({ 7001: { cmd: 'npm exec react-native start --port 8081', start: T2 } });
    expect(reg.reclaimPid(7001, 'metro', o, entry('metro', 'node /usr/local/bin/npx react-native start --port 8081'))).toBe('recycled');
    expect(o.killed).toEqual([]);
  });

  it('metro: same start time but a different program → never signalled', () => {
    const o = ops({ 7001: { cmd: 'npm exec some-other-tool serve', start: T1 } });
    expect(reg.reclaimPid(7001, 'metro', o, entry('metro', 'node /usr/local/bin/npx react-native start --port 8081'))).toBe('recycled');
    expect(o.killed).toEqual([]);
  });

  it('non-metro kinds still require the exact command', () => {
    const cmd = 'xcodebuild test-without-building -project /p/WDA.xcodeproj -destination id=ABC';
    const o = ops({ 7001: { cmd: `${cmd} -extra`, start: T1 } });
    expect(reg.reclaimPid(7001, 'wda', o, entry('wda', cmd))).toBe('recycled');
    expect(o.killed).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('ps runs in the C locale', () => {
  it('every ps spawn (registry + metro) passes LC_ALL=C / LANG=C', async () => {
    const spy = vi.mocked(cp.spawnSync);
    spy.mockClear();
    reg.captureFingerprint(process.pid);
    await stopAllMetro({ list: () => [{ metroPid: 999_999 }], persist: () => undefined } as never);
    const psCalls = spy.mock.calls.filter((c) => c[0] === 'ps');
    expect(psCalls.length).toBeGreaterThanOrEqual(4);
    for (const c of psCalls) {
      const env = (c[2] as { env?: NodeJS.ProcessEnv }).env;
      expect(env?.LC_ALL).toBe('C');
      expect(env?.LANG).toBe('C');
    }
  });

  it('lstart stays in the C format even when the server runs under de_DE', () => {
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    process.env.LC_ALL = 'de_DE.UTF-8';
    process.env.LANG = 'de_DE.UTF-8';
    try {
      const fp = reg.captureFingerprint(process.pid);
      expect(fp.procStart).toMatch(
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d\d:\d\d:\d\d \d{4}$/,
      );
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v == null) delete process.env[k];
        else process.env[k] = v;
    }
  });
});
