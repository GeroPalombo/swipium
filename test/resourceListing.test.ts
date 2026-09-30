// MCP resource LISTING (OPP-02): the three ResourceTemplate registrations in src/server.ts carry
// real `list` callbacks, so resource-aware clients can BROWSE session artifacts and app-map
// sections instead of mining swipium:// URIs out of tool text.
//
// Which surface exposes listed resources (investigated in @modelcontextprotocol/sdk 1.19 —
// dist/esm/server/mcp.js `ListResourcesRequestSchema` handler): the SDK aggregates every
// template's ListResourcesCallback into the ordinary `resources/list` response, alongside any
// fixed registered resources. `resources/templates/list` only returns the URI *templates*
// themselves. So all assertions below go through client.listResources().

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Hermetic on-disk state: SessionStore persists under ~/.swipium, so point HOME at a temp
// dir BEFORE the store module is loaded (dynamic imports below).
const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-test-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer } = await import('../src/server.js');
const { emptyAppMap } = await import('../src/appMap/schema.js');
const { saveAppMap, projectId } = await import('../src/appMap/store.js');
type SessionStore = import('../src/session/store.js').SessionStore;

describe('MCP resource listing (OPP-02)', () => {
  let client: Client;
  let sessions: SessionStore;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-test-project-'));
    const ctx = createServer();
    sessions = ctx.sessions;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'resource-listing-test', version: '0' });
    await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('lists nothing (not an error) with zero sessions and no app map', async () => {
    const res = await client.listResources();
    expect(res.resources).toEqual([]);
  });

  it('lists saved artifacts with URI, name, mime type, and kind/label description', async () => {
    const s = sessions.create(projectRoot);
    const pngUri = sessions.saveArtifact(s, 'screenshot', 'shot-001.png', Buffer.from('fake-png'), 'image/png', 'after login');
    const logUri = sessions.saveArtifact(s, 'log', 'device.log', 'hello world', 'text/plain');

    const res = await client.listResources();
    const byUri = new Map(res.resources.map((r) => [r.uri, r]));
    const png = byUri.get(pngUri);
    expect(png).toBeTruthy();
    expect(png!.name).toBe('shot-001.png');
    expect(png!.mimeType).toBe('image/png');
    expect(png!.description).toBe('screenshot: after login');
    const log = byUri.get(logUri);
    expect(log).toBeTruthy();
    expect(log!.name).toBe('device.log');
    expect(log!.mimeType).toBe('text/plain');
    expect(log!.description).toBe('log');
  });

  it('caps the artifact listing at 100 and DISCLOSES the truncation on the last entry', async () => {
    const s = sessions.create(projectRoot);
    for (let i = 0; i < 105; i++) sessions.saveArtifact(s, 'note', `note-${String(i).padStart(3, '0')}.txt`, `n${i}`, 'text/plain');

    const res = await client.listResources();
    const artifacts = res.resources.filter((r) => r.uri.startsWith('swipium://session/'));
    expect(artifacts).toHaveLength(100); // 105 + 2 from the previous test, capped
    // Newest first: the two artifacts from the previous test are older than the 105 notes.
    expect(artifacts.every((r) => String(r.name).startsWith('note-'))).toBe(true);
    expect(artifacts[99].description).toMatch(/listing capped: showing 100 of 107/);
    // The cap never hides anything unrecoverable — capped-out artifacts stay readable by URI.
    const oldest = sessions.list().flatMap((x) => x.artifacts)[0];
    const read = await client.readResource({ uri: oldest.uri });
    expect(read.contents[0].uri).toBe(oldest.uri);
  });

  it('lists app-map full/section URIs once a map exists, and they are readable', async () => {
    const now = new Date().toISOString();
    const map = emptyAppMap(
      { root: projectRoot, gitRemote: null, packageName: null, workspaceTarget: null, framework: 'expo', platforms: ['android'] },
      now,
    );
    map.staticTopology.screens.push({
      id: 'screen:home',
      name: 'Home',
      kind: 'screen',
      sourceFiles: [],
      confidence: 0.9,
      reasons: [],
    });
    // expo-router style id: contains `/`, `(`, `)` — must be listed ENCODED so it matches the
    // `{kind}/{id}` template, and the read handler must decode it.
    map.staticTopology.screens.push({
      id: 'app/(tabs)/index',
      name: 'Tabs index',
      kind: 'screen',
      sourceFiles: [],
      confidence: 0.9,
      reasons: [],
    });
    map.features.push({
      id: 'feature:login',
      title: 'Login',
      sourceFiles: [],
      staticScreens: ['screen:home'],
      runtimeScreens: [],
      actions: [],
      riskLevel: 'low',
      testCoverage: 'none',
      blockers: [],
      status: 'hypothesis',
      confidence: 0.5,
      reasons: [],
    });
    saveAppMap(projectRoot, map);

    // The projectRoot is known to the store via the sessions created above.
    const base = `swipium://project/${projectId(projectRoot)}/app-map`;
    const res = await client.listResources();
    const uris = res.resources.map((r) => r.uri);
    expect(uris).toContain(base); // full map (qa-app-map-full template)
    expect(uris).toContain(`${base}/feature/feature:login`);
    expect(uris).toContain(`${base}/screen/screen:home`);
    expect(uris).toContain(`${base}/test-suite/cases`);
    const encodedScreen = `${base}/screen/app%2F(tabs)%2Findex`;
    expect(uris).toContain(encodedScreen);
    expect(uris.some((u) => u.includes('/screen/app/'))).toBe(false);
    const screenRead = await client.readResource({ uri: encodedScreen });
    expect(JSON.parse(String((screenRead.contents[0] as { text?: string }).text)).id).toBe('app/(tabs)/index');
    const feature = res.resources.find((r) => r.uri === `${base}/feature/feature:login`);
    expect(feature!.name).toBe('Login');
    expect(feature!.mimeType).toBe('application/json');

    // Listed URIs must actually be readable — full map and a section round-trip.
    for (const uri of [base, `${base}/feature/feature:login`]) {
      const read = await client.readResource({ uri });
      const first = read.contents[0] as { uri: string; mimeType?: string; text?: string };
      expect(first.mimeType).toBe('application/json');
      expect(() => JSON.parse(String(first.text))).not.toThrow();
    }
  });

  it('never lists artifacts of a sensitive-mode session (still readable by exact URI)', async () => {
    const s = sessions.create(projectRoot, undefined, { sensitive: true });
    const uri = sessions.saveArtifact(s, 'dump', 'sensitive-dump.xml', '<x/>', 'application/xml');
    const res = await client.listResources();
    expect(res.resources.map((r) => r.uri)).not.toContain(uri);
    expect(res.resources.some((r) => r.name === 'sensitive-dump.xml')).toBe(false);
    const read = await client.readResource({ uri });
    expect(read.contents[0].uri).toBe(uri);
  });

  it('scopes listing to the current project root(s): MCP roots + sessions used in this process', async () => {
    sessions.flushAll(); // make the debounced state.json writes visible to a "restarted" server
    const otherRoot = mkdtempSync(join(tmpdir(), 'swipium-test-other-'));
    const listWithRoots = async (rootDir: string) => {
      const ctx2 = createServer(); // fresh store ≈ server restart: prior sessions are rehydrated, not active
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c2 = new Client({ name: 'roots-test', version: '0' }, { capabilities: { roots: {} } });
      c2.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(rootDir).href }] }));
      await Promise.all([ctx2.server.connect(st), c2.connect(ct)]);
      try {
        return (await c2.listResources()).resources.map((r) => r.uri);
      } finally {
        await c2.close();
      }
    };
    try {
      const otherUris = await listWithRoots(otherRoot);
      expect(otherUris.some((u) => u.startsWith('swipium://session/'))).toBe(false); // another project's sessions are hidden
      expect(otherUris.some((u) => u.includes(projectId(projectRoot)))).toBe(false);
      const sameUris = await listWithRoots(projectRoot);
      expect(sameUris.some((u) => u.startsWith('swipium://session/'))).toBe(true); // prior runs of THIS project are listed
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
