// B10: project root resolution falls back past MCP roots to SWIPIUM_PROJECT_ROOT,
// CLAUDE_PROJECT_DIR, then a meaningful cwd (never `/` or $HOME); unresolved roots carry the
// typed PROJECT_ROOT_UNRESOLVED failure code.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  hasProjectMarker,
  isUsableCwd,
  resolveProjectRoot,
  unresolvedProjectRootError,
  PROJECT_ROOT_UNRESOLVED,
} from '../src/context/projectRoot.js';
import { FAILURES } from '../src/oracle/failures.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-root-')));
const a = mkdtempSync(join(tmp, 'a-'));
const b = mkdtempSync(join(tmp, 'b-'));
const c = mkdtempSync(join(tmp, 'c-'));
writeFileSync(join(c, 'package.json'), '{}'); // cwd fallback requires a project marker
const fsRoot = parse(tmp).root;

function fakeServer(roots?: string[]): McpServer {
  return {
    server: {
      getClientCapabilities: () => (roots ? { roots: {} } : {}),
      listRoots: async () => ({ roots: (roots ?? []).map((p) => ({ uri: `file://${p}` })) }),
    },
  } as unknown as McpServer;
}

const noEnv = { env: {}, cwd: fsRoot, home: '/nonexistent-home' };

describe('resolveProjectRoot fallback chain', () => {
  it('explicit arg wins, and an invalid explicit arg is an error (no silent fallback)', async () => {
    expect(await resolveProjectRoot(fakeServer([b]), a, noEnv)).toEqual({ root: a, source: 'arg' });
    const bad = await resolveProjectRoot(fakeServer([b]), 'relative/path', { ...noEnv, cwd: c });
    expect(bad.root).toBeUndefined();
  });

  it('MCP roots beat env and cwd', async () => {
    const r = await resolveProjectRoot(fakeServer([b]), undefined, { env: { SWIPIUM_PROJECT_ROOT: a }, cwd: c });
    expect(r).toEqual({ root: b, source: 'mcp-roots' });
  });

  it('SWIPIUM_PROJECT_ROOT, then CLAUDE_PROJECT_DIR, then cwd', async () => {
    expect(await resolveProjectRoot(fakeServer(), undefined, { env: { SWIPIUM_PROJECT_ROOT: a, CLAUDE_PROJECT_DIR: b }, cwd: c })).toEqual({
      root: a,
      source: 'env:SWIPIUM_PROJECT_ROOT',
    });
    expect(await resolveProjectRoot(fakeServer(), undefined, { env: { CLAUDE_PROJECT_DIR: b }, cwd: c })).toEqual({
      root: b,
      source: 'env:CLAUDE_PROJECT_DIR',
    });
    expect(await resolveProjectRoot(fakeServer(), undefined, { env: {}, cwd: c, home: '/nonexistent-home' })).toEqual({
      root: c,
      source: 'cwd',
    });
  });

  it('ignores env values that are relative or missing directories', async () => {
    const r = await resolveProjectRoot(fakeServer(), undefined, {
      env: { SWIPIUM_PROJECT_ROOT: 'rel', CLAUDE_PROJECT_DIR: join(tmp, 'missing') },
      cwd: c,
      home: '/nonexistent-home',
    });
    expect(r.source).toBe('cwd');
  });

  it('never uses the filesystem root or $HOME as the cwd fallback', async () => {
    expect(isUsableCwd(fsRoot, '/nonexistent-home')).toBe(false);
    expect(isUsableCwd(c, c)).toBe(false);
    expect(isUsableCwd(c, '/nonexistent-home')).toBe(true);
    const r = await resolveProjectRoot(fakeServer(), undefined, { env: {}, cwd: c, home: c });
    expect(r.source).toBe('none');
    expect(r.hint).toContain('SWIPIUM_PROJECT_ROOT');
  });

  it('cwd without a project marker is not guessed; each marker kind is accepted', async () => {
    const plain = mkdtempSync(join(tmp, 'plain-'));
    expect(isUsableCwd(plain, '/nonexistent-home')).toBe(false);
    const r = await resolveProjectRoot(fakeServer(), undefined, { env: {}, cwd: plain, home: '/nonexistent-home' });
    expect(r.source).toBe('none');
    expect(r.hint).toContain('package.json');
    for (const marker of ['app.json', 'pubspec.yaml', 'build.gradle.kts', 'settings.gradle', 'Podfile']) {
      const d = mkdtempSync(join(tmp, 'm-'));
      writeFileSync(join(d, marker), '');
      expect(hasProjectMarker(d), marker).toBe(true);
    }
    for (const dir of ['android', 'ios', 'App.xcodeproj', 'App.xcworkspace']) {
      const d = mkdtempSync(join(tmp, 'm-'));
      mkdirSync(join(d, dir));
      expect(hasProjectMarker(d), dir).toBe(true);
    }
    // CLAUDE_PROJECT_DIR is explicit client config: accepted without a marker.
    expect((await resolveProjectRoot(fakeServer(), undefined, { env: { CLAUDE_PROJECT_DIR: plain }, cwd: fsRoot })).source).toBe(
      'env:CLAUDE_PROJECT_DIR',
    );
  });

  it('unresolved roots produce a typed PROJECT_ROOT_UNRESOLVED error', async () => {
    const r = await resolveProjectRoot(fakeServer(), undefined, noEnv);
    const res = unresolvedProjectRootError(r);
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { failureCode: string; clientHint?: string; retrySafe: boolean };
    expect(sc.failureCode).toBe(PROJECT_ROOT_UNRESOLVED);
    expect(sc.retrySafe).toBe(true);
    expect(sc.clientHint).toContain('projectRoot');
    expect(FAILURES[PROJECT_ROOT_UNRESOLVED].bucket).toBe('environment');
  });
});
