// SWIP-05 / SWIP-06 durability + concurrency regressions: the canonical app-map.json must be
// written atomically (tmp + rename), a corrupt canonical file must recover from the newest
// parseable history snapshot instead of silently resetting, and the advisory file lock must be
// ownership-verified — a stalled holder whose lock was taken over must never delete the new
// owner's lock (which would let a third process acquire while the new owner still runs).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/lib/lockfile.js';
import { appMapHistoryDir, appMapPath, loadAppMap, saveAppMap } from '../src/appMap/store.js';
import { emptyAppMap, type ProjectIdentity } from '../src/appMap/schema.js';

const AT = '2026-07-04T00:00:00.000Z';

function project(root: string): ProjectIdentity {
  return { root, gitRemote: null, packageName: null, workspaceTarget: null, framework: 'unknown', platforms: [] };
}

let roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swipium-durability-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

describe('app map durability (SWIP-05)', () => {
  it('recovers the newest parseable history snapshot when app-map.json is corrupt', () => {
    const root = tempRoot();
    const p = project(root);
    const map = emptyAppMap(p, AT);
    map.appIdentity.environment = 'staging'; // marker to prove the SNAPSHOT (not a fresh map) came back
    map.updatedAt = AT;
    saveAppMap(root, map); // writes canonical + a history snapshot

    // A torn snapshot NEWER than the good one must be skipped, not break recovery.
    writeFileSync(join(appMapHistoryDir(root), 'z-newest-torn.json'), '{"schemaVersion": 1, "trunc');
    // Truncate the canonical file (crash mid-write of the old non-atomic writer).
    writeFileSync(appMapPath(root), '{"schemaVersion": 1, "project": {"root":');

    const loaded = loadAppMap(root, p, '2026-07-04T01:00:00.000Z');
    expect(loaded.existed).toBe(true);
    expect(loaded.map?.appIdentity.environment).toBe('staging');
    expect(loaded.migration?.recoveredFrom).toBe(`${AT.replace(/[:.]/g, '-')}.json`);
  });

  it('falls back to a fresh map when the canonical file is corrupt and no snapshot parses', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.swipium'), { recursive: true });
    writeFileSync(appMapPath(root), 'not json at all');

    const loaded = loadAppMap(root, project(root), AT);
    expect(loaded.existed).toBe(true);
    expect(loaded.map?.generatedAt).toBe(AT); // fresh map, not a recovered one
    expect(loaded.migration?.recoveredFrom).toBeUndefined();
    expect(loaded.migration?.applied).toContain('fresh (unparseable input)');
  });

  it('writes the canonical file atomically with no .tmp residue', () => {
    const root = tempRoot();
    const map = emptyAppMap(project(root), AT);
    map.updatedAt = AT;
    const save = saveAppMap(root, map);

    const parsed = JSON.parse(readFileSync(save.path, 'utf8')) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(map.schemaVersion);
    expect(readdirSync(join(root, '.swipium')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('file lock ownership (SWIP-06)', () => {
  it('takes over a stale lock left by a dead holder and releases it after fn', () => {
    const lock = join(tempRoot(), 'x.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), '99999:dead-holder');
    const old = new Date(Date.now() - 11_000); // past STALE_LOCK_MS
    utimesSync(lock, old, old);

    const out = withFileLock(lock, () => 'ran');
    expect(out).toBe('ran');
    expect(existsSync(lock)).toBe(false); // we owned it, so release removed it
  });

  it('does not delete a lock whose ownership changed mid-fn (stolen lock stays with the thief)', () => {
    const lock = join(tempRoot(), 'y.lock');
    withFileLock(lock, () => {
      // Simulate a stale takeover happening while this holder is stalled inside fn().
      writeFileSync(join(lock, 'owner'), '424242:thief');
    });
    expect(existsSync(lock)).toBe(true); // release was a no-op — the thief owns it now
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('424242:thief');
  });
});
