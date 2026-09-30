// MCP roots selection (P2 #8): a client exposing [$HOME, app] must resolve to the app, not $HOME
// (which then failed NOT_MOBILE_PROJECT). First root with a project marker wins; else the first
// root that is neither / nor $HOME; a $HOME-only root list falls through to the env/cwd chain.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pickMcpRoot, resolveProjectRoot } from '../src/context/projectRoot.js';

const base = mkdtempSync(join(tmpdir(), 'swipium-roots-'));
const home = join(base, 'home');
const app = join(base, 'work', 'app');
const plain = join(base, 'work', 'notes');
mkdirSync(home, { recursive: true });
mkdirSync(app, { recursive: true });
mkdirSync(plain, { recursive: true });
writeFileSync(join(app, 'package.json'), '{}');
const uri = (p: string) => pathToFileURL(p).href;

afterAll(() => rmSync(base, { recursive: true, force: true }));

function fakeServer(roots: string[]) {
  return {
    server: {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({ roots: roots.map((r) => ({ uri: r })) }),
    },
  } as never;
}

describe('pickMcpRoot', () => {
  it('skips $HOME and picks the root with a project marker', () => {
    expect(pickMcpRoot([uri(home), uri(app)], home)).toBe(app);
    expect(pickMcpRoot([uri(plain), uri(app)], home)).toBe(app);
  });
  it('falls back to the first non-$HOME, non-/ root when none has a marker', () => {
    expect(pickMcpRoot([uri(home), uri('/'), uri(plain)], home)).toBe(plain);
  });
  it('returns nothing for a $HOME-only (or non-file) list', () => {
    expect(pickMcpRoot([uri(home)], home)).toBeUndefined();
    expect(pickMcpRoot(['https://example.com', 42], home)).toBeUndefined();
  });
});

describe('resolveProjectRoot via MCP roots', () => {
  it('[$HOME, app] → app (source mcp-roots)', async () => {
    const r = await resolveProjectRoot(fakeServer([uri(home), uri(app)]), undefined, { env: {}, cwd: '/', home });
    expect(r).toMatchObject({ root: app, source: 'mcp-roots' });
  });
  it('[$HOME] alone does not resolve to $HOME', async () => {
    const r = await resolveProjectRoot(fakeServer([uri(home)]), undefined, { env: {}, cwd: '/', home });
    expect(r.root).toBeUndefined();
  });
});
