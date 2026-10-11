// 2.3.0: an adopted WDA outlives its session (sessions expire after a server restart), so
// registeredWdaForSession also finds a WDA this server owns by its endpoint. Found on a real
// simulator: after a restart, no session could `qa_wda stop` the adopted WDA.
// Hermetic: HOME points at a temp dir before the registry module loads.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-wda-endpoint-home-'));
process.env.HOME = fakeHome;

const { registeredWdaForSession } = await import('../src/session/processRegistry.js');

afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

const entry = (pid: number, sessionId: string, serverPid: number, endpoint: string) => ({
  pid,
  kind: 'wda',
  serverPid,
  sessionId,
  startedAt: 1,
  endpoint,
  procStart: `start-${pid}`,
  command: 'xcodebuild test-without-building',
});

describe('registeredWdaForSession with an endpoint', () => {
  it('matches the session first, then a WDA this server owns at the endpoint, never another server', () => {
    mkdirSync(join(fakeHome, '.swipium'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.swipium', 'processes.json'),
      JSON.stringify([
        entry(201, 'expired', process.pid, 'http://127.0.0.1:8100'),
        entry(202, 'other-server', 999999, 'http://127.0.0.1:8200'),
        entry(203, 'mine', process.pid, 'http://127.0.0.1:8300'),
      ]),
    );
    expect(registeredWdaForSession('new-session')).toBeUndefined();
    expect(registeredWdaForSession('new-session', 'http://127.0.0.1:8100')?.pid).toBe(201);
    expect(registeredWdaForSession('mine', 'http://127.0.0.1:8100')?.pid).toBe(203);
    expect(registeredWdaForSession('new-session', 'http://127.0.0.1:8200')).toBeUndefined();
  });
});

describe('WDA adoption re-owns the start time too', () => {
  it('a second server does not steal (or reap) a WDA the first live server adopted', async () => {
    const { reapOrphanedProcesses } = await import('../src/session/processRegistry.js');
    const file = join(fakeHome, '.swipium', 'processes.json');
    const { readFileSync } = await import('node:fs');
    const DEAD = 777777;
    writeFileSync(file, JSON.stringify([{ ...entry(301, 'old', DEAD, 'http://127.0.0.1:8100'), serverStart: 'old-start' }]));
    const live: Record<number, string> = { 301: 'xcodebuild test-without-building', [process.pid]: 'node swipium' };
    const ops = {
      pidAlive: (pid: number) => pid in live,
      psCommand: (pid: number) => live[pid] ?? null,
      psStartTime: (pid: number) => (pid === 301 ? 'start-301' : pid === process.pid ? 'me-start' : null),
      psPgid: (pid: number) => pid,
      killTree: () => true,
    };
    await reapOrphanedProcesses({ ops, now: 2, wdaHealthy: async () => true });
    const [e] = JSON.parse(readFileSync(file, 'utf8')) as Array<{ serverPid: number; serverStart?: string }>;
    expect(e).toMatchObject({ serverPid: process.pid, serverStart: 'me-start' });
  });
});
