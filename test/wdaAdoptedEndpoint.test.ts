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

const SIM_A = '11111111-2222-3333-4444-555555555555';
const SIM_B = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

const entry = (pid: number, sessionId: string, serverPid: number, endpoint: string, udid = SIM_A) => ({
  pid,
  kind: 'wda',
  serverPid,
  sessionId,
  startedAt: 1,
  endpoint,
  procStart: `start-${pid}`,
  command: `xcodebuild test-without-building -project WebDriverAgent.xcodeproj -destination id=${udid}`,
});

describe('registeredWdaForSession with an endpoint', () => {
  it('matches the session first, then a WDA this server owns at the endpoint for the same simulator, never another server', () => {
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
    // The endpoint alone never matches; the entry must be this session's simulator.
    expect(registeredWdaForSession('new-session', 'http://127.0.0.1:8100')).toBeUndefined();
    expect(registeredWdaForSession('new-session', 'http://127.0.0.1:8100', SIM_A)?.pid).toBe(201);
    expect(registeredWdaForSession('new-session', 'http://127.0.0.1:8100', SIM_A.toLowerCase())?.pid).toBe(201);
    expect(registeredWdaForSession('new-session', 'http://127.0.0.1:8100', SIM_B)).toBeUndefined();
    expect(registeredWdaForSession('mine', 'http://127.0.0.1:8100')?.pid).toBe(203);
    expect(registeredWdaForSession('new-session', 'http://127.0.0.1:8200', SIM_A)).toBeUndefined();
  });
});

describe('WDA adoption re-owns the start time too', () => {
  it('a second server does not steal (or reap) a WDA the first live server adopted', async () => {
    const { reapOrphanedProcesses } = await import('../src/session/processRegistry.js');
    const file = join(fakeHome, '.swipium', 'processes.json');
    const { readFileSync } = await import('node:fs');
    const DEAD = 777777;
    const orphan = entry(301, 'old', DEAD, 'http://127.0.0.1:8100');
    writeFileSync(file, JSON.stringify([{ ...orphan, serverStart: 'old-start' }]));
    const live: Record<number, string> = { 301: orphan.command, [process.pid]: 'node swipium' };
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
