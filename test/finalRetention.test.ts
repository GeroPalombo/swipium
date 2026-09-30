// Integration fix (2.0.0 final, LOW): an unreadable / corrupt ~/.swipium/registry.json counted as
// "nothing registered", so the retention prune failed OPEN and could delete registered sessions.
// It now fails CLOSED: the prune is skipped. A MISSING registry is still a genuine empty set.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'swipium-final-retention-'));
const { pruneSessionRuns } = await import('../src/session/retention.js');
const swipium = join(home, '.swipium');
afterAll(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => rmSync(swipium, { recursive: true, force: true }));

function oldSession(id: string): string {
  const dir = join(swipium, 'runs', 'proj', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{}');
  const t = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  utimesSync(join(dir, 'state.json'), t, t);
  utimesSync(dir, t, t);
  return dir;
}

describe('retention fails closed on an unreadable registry', () => {
  it.each([
    ['corrupt JSON', '{not json'],
    ['non-array JSON', '{"sessions": []}'],
  ])('%s → nothing deleted, prune reported skipped', async (_label, content) => {
    const dir = oldSession('registered');
    writeFileSync(join(swipium, 'registry.json'), content);
    const r = await pruneSessionRuns({ home, days: 30, keepPerProject: 0 });
    expect(r.deleted).toEqual([]);
    expect(r.skipped).toMatch(/fail closed/);
    expect(existsSync(dir)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('unreadable (EACCES) registry → nothing deleted', async () => {
    const dir = oldSession('registered');
    writeFileSync(join(swipium, 'registry.json'), '[]', { mode: 0o000 });
    const r = await pruneSessionRuns({ home, days: 30, keepPerProject: 0 });
    expect(r.deleted).toEqual([]);
    expect(r.skipped).toBeDefined();
    expect(existsSync(dir)).toBe(true);
  });

  it('a missing registry still allows pruning old unregistered dirs', async () => {
    const dir = oldSession('stale');
    const r = await pruneSessionRuns({ home, days: 30, keepPerProject: 0 });
    expect(r.skipped).toBeUndefined();
    expect(r.deleted).toEqual([dir]);
  });
});
