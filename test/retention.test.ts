// Pre-launch disk findings: ~/.swipium/runs session dirs were never deleted (registry.json caps
// ENTRIES at 200 but the dirs stay), ~/.swipium/projects.json grew unbounded with entries for
// deleted temp roots and was rewritten pretty-printed on every app-map call, and the issue ledger's
// `pruneEvidenceAfterDays` policy was declared but never applied.
// Hermetic: HOME points at a temp dir BEFORE any ~/.swipium module is loaded.

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-retention-home-'));
process.env.HOME = fakeHome;

const { pruneSessionRuns, retentionDaysFromEnv, retentionKeepFromEnv } = await import('../src/session/retention.js');
const { runGc, parseGcArgs } = await import('../src/cli/gc.js');
const { parseCommand, USAGE } = await import('../src/cli/main.js');
const { rememberProject, compactProjectRegistry, registryPath, reloadRegistry, MAX_PROJECT_ENTRIES } =
  await import('../src/appMap/projectRegistry.js');
const { pruneEvidence, issuesArtifactsDir, appendEvents } = await import('../src/issues/store.js');

const DAY = 24 * 60 * 60 * 1000;
const runs = join(fakeHome, '.swipium', 'runs');
const tmp: string[] = [];
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  for (const t of tmp) rmSync(t, { recursive: true, force: true });
});

/** Create a session dir with a state.json last touched `ageDays` ago. */
function sessionDir(project: string, id: string, ageDays: number): string {
  const dir = join(runs, project, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ id, pad: 'x'.repeat(1000) }));
  const t = new Date(Date.now() - ageDays * DAY);
  utimesSync(join(dir, 'state.json'), t, t);
  utimesSync(dir, t, t);
  return dir;
}

describe('session-dir retention', () => {
  it('deletes old unregistered dirs, keeps registered / live / the newest N per project', async () => {
    rmSync(runs, { recursive: true, force: true });
    const old = Array.from({ length: 6 }, (_, i) => sessionDir('projA', `old${i}`, 40 + i));
    const fresh = sessionDir('projA', 'fresh', 1);
    const registered = sessionDir('projB', 'reg', 90);
    const live = sessionDir('projB', 'live', 90);
    const lonely = sessionDir('projC', 'gone', 90);
    writeFileSync(join(fakeHome, '.swipium', 'registry.json'), JSON.stringify([{ id: 'reg', dir: registered }]));

    const dry = await pruneSessionRuns({ days: 30, keepPerProject: 2, dryRun: true, liveDirs: [live] });
    expect(dry.deleted.length).toBe(5); // old1..old5 (fresh + old0 are the newest 2)
    expect(existsSync(old[5])).toBe(true); // dry run deletes nothing
    expect(dry.bytesReclaimed).toBeGreaterThan(5 * 1000);

    const r = await pruneSessionRuns({ days: 30, keepPerProject: 2, liveDirs: [live] });
    expect(r.deleted.sort()).toEqual(old.slice(1).sort());
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old[0])).toBe(true); // newest-2 per project kept regardless of age
    expect(existsSync(registered)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(lonely)).toBe(true); // a project's only (old) session is within its newest N
  });

  it('env thresholds: SWIPIUM_RETENTION_DAYS (0/off disables) and SWIPIUM_RETENTION_KEEP', () => {
    expect(retentionDaysFromEnv({})).toBe(30);
    expect(retentionDaysFromEnv({ SWIPIUM_RETENTION_DAYS: '7' })).toBe(7);
    expect(retentionDaysFromEnv({ SWIPIUM_RETENTION_DAYS: 'off' })).toBeNull();
    expect(retentionDaysFromEnv({ SWIPIUM_RETENTION_DAYS: '0' })).toBeNull();
    expect(retentionKeepFromEnv({})).toBe(20);
    expect(retentionKeepFromEnv({ SWIPIUM_RETENTION_KEEP: '5' })).toBe(5);
  });
});

describe('swipium gc', () => {
  it('is a known subcommand with a help line', () => {
    expect(parseCommand(['gc', '--dry-run'])).toEqual({ kind: 'sub', cmd: 'gc', rest: ['--dry-run'] });
    expect(USAGE).toContain('swipium gc');
    expect(parseGcArgs(['--days', '10', '--keep=3', '--dry-run'], {})).toMatchObject({ days: 10, keep: 3, dryRun: true });
    expect(parseGcArgs(['--days', 'x'], {}).error).toMatch(/--days/);
  });

  it('reports reclaimed space; --dry-run deletes nothing', async () => {
    rmSync(runs, { recursive: true, force: true });
    const dir = sessionDir('projD', 'ancient', 100);
    let out = '';
    expect(await runGc(['--dry-run', '--days', '30', '--keep', '0'], (s) => void (out += s))).toBe(0);
    expect(out).toMatch(/would delete 1 session dir/);
    expect(out).toMatch(/reclaimable: \d/);
    expect(existsSync(dir)).toBe(true);
    out = '';
    expect(await runGc(['--days', '30', '--keep', '0'], (s) => void (out += s))).toBe(0);
    expect(out).toMatch(/deleted 1 session dir/);
    expect(out).toMatch(/reclaimed: [\d.]+ (B|KB)/);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(runs, 'projD'))).toBe(false); // emptied project dir removed
  });
});

describe('projects.json', () => {
  it('prunes entries whose root is gone, caps to 200, writes compact JSON under a lock, skips no-op rewrites', () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'swipium-retention-proj-'));
    tmp.push(liveRoot);
    const projects: Record<string, unknown> = {};
    for (let i = 0; i < 250; i++) {
      projects[`dead${i}`] = {
        projectId: `dead${i}`,
        root: join(tmpdir(), `swipium-deleted-${i}-${Date.now()}`),
        lastSeenAt: new Date(2020, 0, 1).toISOString(),
        appMapPath: 'x',
      };
    }
    mkdirSync(join(fakeHome, '.swipium'), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify({ schemaVersion: 1, projects }, null, 2));
    reloadRegistry();

    rememberProject(liveRoot, { framework: 'expo' });
    const raw = readFileSync(registryPath(), 'utf8');
    expect(raw).not.toContain('\n'); // compact
    const reg = JSON.parse(raw) as { projects: Record<string, { root: string }> };
    expect(Object.values(reg.projects).map((e) => e.root)).toEqual([liveRoot]);

    // A second call with nothing new does not rewrite the file.
    writeFileSync(registryPath(), raw + ' ');
    rememberProject(liveRoot, { framework: 'expo' });
    expect(readFileSync(registryPath(), 'utf8')).toBe(raw + ' ');

    // Cap: > MAX live entries → only the most recent MAX kept.
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PROJECT_ENTRIES + 20; i++)
      many[`p${i}`] = { projectId: `p${i}`, root: liveRoot, lastSeenAt: new Date(2024, 0, 1, 0, i).toISOString(), appMapPath: 'x' };
    writeFileSync(registryPath(), JSON.stringify({ schemaVersion: 1, projects: many }));
    const c = compactProjectRegistry();
    expect(c).toEqual({ before: MAX_PROJECT_ENTRIES + 20, after: MAX_PROJECT_ENTRIES, removed: 20 });
    const kept = JSON.parse(readFileSync(registryPath(), 'utf8')) as { projects: Record<string, unknown> };
    expect(Object.keys(kept.projects)).not.toContain('p0'); // oldest dropped
  });
});

describe('issue ledger evidence retention (pruneEvidenceAfterDays)', () => {
  it('prunes evidence files older than N days on ledger write; keeps recent ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'swipium-retention-issues-'));
    tmp.push(root);
    const dir = join(issuesArtifactsDir(root), 'ISS-1');
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, 'old.png');
    const newFile = join(issuesArtifactsDir(root), 'new.png');
    writeFileSync(oldFile, 'x');
    writeFileSync(newFile, 'y');
    const t = new Date(Date.now() - 120 * DAY);
    utimesSync(oldFile, t, t);
    expect(pruneEvidence(root, 0)).toBe(0); // disabled
    // Default policy (90 days) applies on a ledger write.
    appendEvents(root, [{ issueId: 'ISS-1' } as never]);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(dir)).toBe(false); // emptied sub-dir removed
    expect(existsSync(newFile)).toBe(true);
  });
});
