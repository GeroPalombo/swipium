// On-disk stores under .swipium/ never write, append or delete through a symlink a cloned repo
// committed, retention cannot be dialed down to "delete everything", a torn JSONL line is not glued
// to the next event, a corrupt test-suite.json is never replaced, and the code-index walker does not
// follow links. Hermetic: temp dirs only.

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendFileNoFollow,
  assertNoSymlinkUnder,
  rmNoFollow,
  writeFileAtomicNoFollow,
  writeFileExclusiveContained,
} from '../src/lib/noFollowFs.js';
import {
  appendEvents,
  issuesArtifactsDir,
  issuesDir,
  issuesLogPath,
  pruneEvidence,
  saveIndex,
  withLedgerLock,
} from '../src/issues/store.js';
import { emptyIndex } from '../src/issues/schema.js';
import { appMapHistoryDir, pruneHistory, saveIndexes } from '../src/appMap/store.js';
import { ensureGitignored } from '../src/lib/gitignore.js';
import { upsertFeatureCoverage } from '../src/featureTesting/featureMap.js';
import { appendExploreMemory } from '../src/explore/memory.js';
import { writeCompiledFlow } from '../src/suite/compile.js';
import { initFlowTemplates } from '../src/flows/templates.js';
import { buildFeatureIndex } from '../src/appMap/featureIndex.js';
import { applyMerge, loadSuiteChecked, saveSuite, suiteJsonPath } from '../src/testSuite/store.js';
import { emptySuite } from '../src/testSuite/schema.js';
import { normalizeCase } from '../src/testSuite/generator.js';

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** An outside folder with an old file the attack would like to see deleted. */
function victimDir(): { dir: string; file: string } {
  const dir = tmp('swipium-victim-');
  const file = join(dir, 'precious.txt');
  writeFileSync(file, 'precious');
  const t = new Date(Date.now() - 400 * DAY);
  utimesSync(file, t, t);
  return { dir, file };
}

describe('no-follow helper', () => {
  it('refuses a symlinked component, a path outside the root, and allows the root itself to be a link', () => {
    const root = tmp('swipium-nf-root-');
    const { dir } = victimDir();
    symlinkSync(dir, join(root, '.swipium'));
    expect(() => assertNoSymlinkUnder(root, join(root, '.swipium', 'x.json'))).toThrow(expect.objectContaining({ code: 'ELOOP' }));
    expect(() => assertNoSymlinkUnder(root, join(root, '..', 'x'))).toThrow(/outside the project/);
    expect(() => assertNoSymlinkUnder(root, root)).toThrow(/outside the project/);

    const real = tmp('swipium-nf-real-');
    const linkParent = tmp('swipium-nf-linkparent-');
    const linkedRoot = join(linkParent, 'proj');
    symlinkSync(real, linkedRoot);
    writeFileAtomicNoFollow(linkedRoot, join(linkedRoot, '.swipium', 'a.json'), '{}');
    expect(readFileSync(join(real, '.swipium', 'a.json'), 'utf8')).toBe('{}');
    expect(readdirSync(join(real, '.swipium'))).toEqual(['a.json']); // no tmp residue
  });

  it('rmNoFollow deletes nothing through a symlinked folder', () => {
    const root = tmp('swipium-nf-root-');
    const { dir, file } = victimDir();
    symlinkSync(dir, join(root, '.swipium'));
    expect(rmNoFollow(root, join(root, '.swipium', 'precious.txt'))).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('appendFileNoFollow terminates a torn last line before appending', () => {
    const root = tmp('swipium-nf-root-');
    const p = join(root, '.swipium', 'log.jsonl');
    appendFileNoFollow(root, p, '{"a":1}\n', { ensureLeadingNewline: true });
    writeFileSync(p, readFileSync(p, 'utf8') + '{"torn":');
    appendFileNoFollow(root, p, '{"b":2}\n', { ensureLeadingNewline: true });
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}\n{"torn":\n{"b":2}\n');
  });

  it('writeFileExclusiveContained never overwrites, never follows a link, and stays inside the real root', () => {
    const root = tmp('swipium-nf-root-');
    const { dir, file } = victimDir();
    expect(writeFileExclusiveContained(root, join(root, 'e2e', 'a.ts'), 'new')).toBe('written');
    expect(readFileSync(join(root, 'e2e', 'a.ts'), 'utf8')).toBe('new');
    expect(writeFileExclusiveContained(root, join(root, 'e2e', 'a.ts'), 'other')).toBe('exists');
    expect(readFileSync(join(root, 'e2e', 'a.ts'), 'utf8')).toBe('new');
    // A symlink at the target is "exists" (wx does not follow it); the victim is untouched.
    symlinkSync(file, join(root, 'e2e', 'b.ts'));
    expect(writeFileExclusiveContained(root, join(root, 'e2e', 'b.ts'), 'x')).toBe('exists');
    expect(readFileSync(file, 'utf8')).toBe('precious');
    // A symlinked output folder that leaves the project is refused.
    symlinkSync(dir, join(root, 'tests'));
    expect(() => writeFileExclusiveContained(root, join(root, 'tests', 'e2e', 'c.ts'), 'x')).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
    expect(existsSync(join(dir, 'e2e'))).toBe(false);
  });
});

describe('issue ledger', () => {
  it('pruneEvidence never walks a symlinked artifacts dir (or a symlinked parent)', () => {
    // Each case links one folder on the way to artifacts/ to an outside tree laid out like the
    // rest of the path, holding an old file a prune would delete.
    const cases: Array<{ at: (root: string) => string; below: string[] }> = [
      { at: (r) => issuesArtifactsDir(r), below: [] },
      { at: (r) => issuesDir(r), below: ['artifacts'] },
      { at: (r) => join(r, '.swipium'), below: ['issues', 'artifacts'] },
    ];
    for (const c of cases) {
      const root = tmp('swipium-iss-root-');
      const { dir, file } = victimDir();
      const planted = join(dir, ...c.below, 'old.png');
      mkdirSync(join(planted, '..'), { recursive: true });
      writeFileSync(planted, 'x');
      const old = new Date(Date.now() - 400 * DAY);
      utimesSync(planted, old, old);
      mkdirSync(join(c.at(root), '..'), { recursive: true });
      symlinkSync(dir, c.at(root));
      expect(pruneEvidence(root, 1)).toBe(0);
      expect(existsSync(planted)).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
  });

  it('a symlinked entry inside artifacts/ is neither followed nor deleted', () => {
    const root = tmp('swipium-iss-root-');
    const { dir, file } = victimDir();
    mkdirSync(issuesArtifactsDir(root), { recursive: true });
    symlinkSync(dir, join(issuesArtifactsDir(root), 'linkdir'));
    symlinkSync(file, join(issuesArtifactsDir(root), 'linkfile.png'));
    expect(pruneEvidence(root, 1)).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  it('a tiny retention from a committed policy.json is raised to 1 day', () => {
    const root = tmp('swipium-iss-root-');
    mkdirSync(issuesArtifactsDir(root), { recursive: true });
    const recent = join(issuesArtifactsDir(root), 'recent.png');
    const stale = join(issuesArtifactsDir(root), 'stale.png');
    writeFileSync(recent, 'x');
    writeFileSync(stale, 'x');
    const halfDay = new Date(Date.now() - DAY / 2);
    const twoDays = new Date(Date.now() - 2 * DAY);
    utimesSync(recent, halfDay, halfDay);
    utimesSync(stale, twoDays, twoDays);
    writeFileSync(join(issuesDir(root), 'policy.json'), JSON.stringify({ retention: { pruneEvidenceAfterDays: 0.0001 } }));
    appendEvents(root, [{ issueId: 'ISS-1' } as never]);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('appendEvents, saveIndex and the ledger lock refuse a symlinked .swipium or log file', () => {
    const root = tmp('swipium-iss-root-');
    const { dir, file } = victimDir();
    mkdirSync(join(root, '.swipium'));
    symlinkSync(file, issuesLogPath(root));
    expect(() => appendEvents(root, [{ issueId: 'ISS-1' } as never])).toThrow(expect.objectContaining({ code: 'ELOOP' }));
    expect(readFileSync(file, 'utf8')).toBe('precious');

    const root2 = tmp('swipium-iss-root-');
    symlinkSync(dir, join(root2, '.swipium'));
    expect(() => saveIndex(root2, emptyIndex(new Date().toISOString()))).toThrow(/symlink/);
    expect(() => withLedgerLock(root2, () => 1)).toThrow(/symlink/);
    expect(readdirSync(dir)).toEqual(['precious.txt']);
  });

  it('a torn last line of issues-log.jsonl does not swallow the next event', () => {
    const root = tmp('swipium-iss-root-');
    mkdirSync(join(root, '.swipium'), { recursive: true });
    writeFileSync(issuesLogPath(root), '{"issueId":"ISS-0","torn');
    appendEvents(root, [{ issueId: 'ISS-1' } as never]);
    const lines = readFileSync(issuesLogPath(root), 'utf8').split('\n');
    expect(lines[0]).toBe('{"issueId":"ISS-0","torn');
    expect(JSON.parse(lines[1])).toEqual({ issueId: 'ISS-1' });
  });
});

describe('app map store', () => {
  it('pruneHistory deletes nothing through a symlinked history dir', () => {
    const root = tmp('swipium-map-root-');
    const { dir } = victimDir();
    for (let i = 0; i < 35; i++) writeFileSync(join(dir, `${String(i).padStart(2, '0')}.json`), '{}');
    mkdirSync(join(root, '.swipium'));
    symlinkSync(dir, appMapHistoryDir(root));
    pruneHistory(root);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(35);
  });

  it('pruneHistory still keeps the newest 30 regular snapshots', () => {
    const root = tmp('swipium-map-root-');
    mkdirSync(appMapHistoryDir(root), { recursive: true });
    for (let i = 0; i < 35; i++) writeFileSync(join(appMapHistoryDir(root), `${String(i).padStart(2, '0')}.json`), '{}');
    pruneHistory(root);
    const left = readdirSync(appMapHistoryDir(root)).sort();
    expect(left).toHaveLength(30);
    expect(left[0]).toBe('05.json');
  });

  it('saveIndexes does not write through a symlinked index dir', () => {
    const root = tmp('swipium-map-root-');
    const { dir } = victimDir();
    mkdirSync(join(root, '.swipium'));
    symlinkSync(dir, join(root, '.swipium', 'app-map.index'));
    saveIndexes(root, null, []); // best-effort: swallowed
    expect(readdirSync(dir)).toEqual(['precious.txt']);
  });
});

describe('other .swipium writers refuse symlinks', () => {
  it('.gitignore, feature coverage cache, explore memory, compiled flows and flow templates', () => {
    const { dir, file } = victimDir();

    const repo = tmp('swipium-w-root-');
    mkdirSync(join(repo, '.git'));
    symlinkSync(file, join(repo, '.gitignore'));
    ensureGitignored(repo);
    expect(readFileSync(file, 'utf8')).toBe('precious');

    const root = tmp('swipium-w-root-');
    symlinkSync(dir, join(root, '.swipium'));
    expect(() => upsertFeatureCoverage(root, 'com.x', { featureId: 'f' } as never)).toThrow(/symlink/);
    expect(() => appendExploreMemory(root, 'com.x', { appId: 'com.x', sessionId: 's', at: 'now' } as never)).toThrow(/symlink/);
    expect(() => writeCompiledFlow(root, 'smoke', 'name: smoke\nsteps: []\n')).toThrow(/symlink/);
    expect(() => initFlowTemplates(root)).toThrow(/symlink/);
    expect(readdirSync(dir)).toEqual(['precious.txt']);
  });
});

describe('persistent suite store', () => {
  const tc = (title: string) => normalizeCase({ functionality: 'Login', title }, new Date().toISOString());

  it('a corrupt test-suite.json is never replaced: applyMerge and saveSuite refuse, readers see it flagged', () => {
    const root = tmp('swipium-suite-root-');
    mkdirSync(join(root, '.swipium'));
    writeFileSync(suiteJsonPath(root), '{"cases": [ {"id": "TC-LOGIN-001",');
    const now = new Date().toISOString();
    expect(() => applyMerge(root, [tc('Sign in')], { source: 'report', mode: 'update', now, runId: 'r1' })).toThrow(
      /does not parse.*refusing to overwrite/,
    );
    expect(() => saveSuite(root, emptySuite('com.x'))).toThrow(/refusing to overwrite/);
    expect(readFileSync(suiteJsonPath(root), 'utf8')).toBe('{"cases": [ {"id": "TC-LOGIN-001",');
    expect(loadSuiteChecked(root).corrupt).toBeTruthy();
    // A JSON value that is not an object is just as unusable.
    writeFileSync(suiteJsonPath(root), 'null');
    expect(() => applyMerge(root, [tc('Sign in')], { source: 'report', mode: 'update', now, runId: 'r2' })).toThrow(/not a JSON object/);
  });

  it('merges normally, writes atomically (no tmp residue) and releases its lock', () => {
    const root = tmp('swipium-suite-root-');
    const now = new Date().toISOString();
    const a = applyMerge(root, [tc('Sign in')], { source: 'report', mode: 'update', now, runId: 'r1' });
    expect(a.result.created).toHaveLength(1);
    const b = applyMerge(root, [tc('Sign out')], { source: 'report', mode: 'update', now, runId: 'r2' });
    expect(b.result.suite.cases).toHaveLength(2);
    const entries = readdirSync(join(root, '.swipium'));
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
    expect(entries).not.toContain('test-suite.lock');
    expect(loadSuiteChecked(root).corrupt).toBeUndefined();
  });
});

describe('feature index walker', () => {
  it('does not follow a symlink cycle or a link out of the project', () => {
    const root = tmp('swipium-fi-root-');
    const { dir } = victimDir();
    writeFileSync(join(dir, 'Outside.ts'), 'export function outsideThing() {}\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'Login.ts'), 'export function LoginScreen() {}\n');
    symlinkSync(root, join(root, 'src', 'loop'));
    symlinkSync(dir, join(root, 'src', 'ext'));
    const idx = buildFeatureIndex(root);
    expect(idx.files.map((f) => f.file)).toEqual([join('src', 'Login.ts')]);
    expect(idx.truncated).toBe(false);
  });
});
