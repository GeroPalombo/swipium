// B5 (store side): SessionStore.saveArtifact must never write outside the session directory,
// whatever `name`/`kind` a caller passes (e.g. qa_visual baseline names), and artifact URIs
// must match the swipium://session/{sessionId}/{kind}/{name} template (encoded segments).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-store-home-'));
process.env.HOME = fakeHome;

const { SessionStore, safeArtifactName, encodeUriSegment, decodeUriSegment } = await import('../src/session/store.js');

describe('saveArtifact path safety (B5)', () => {
  let root: string;
  let store: InstanceType<typeof SessionStore>;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'swipium-store-project-'));
    store = new SessionStore();
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it.each(['../../src/assets/logo.png', '..\\..\\evil.png', '/etc/passwd', '..', '.', '', 'a/../../b.png', 'nul\u0000byte.png'])(
    'keeps %j inside the session directory',
    (name) => {
      const s = store.create(root);
      const uri = store.saveArtifact(s, 'baseline', name, Buffer.from('png'), 'image/png');
      const rec = s.artifacts.at(-1)!;
      expect(resolve(rec.path).startsWith(resolve(s.dir) + sep)).toBe(true);
      expect(existsSync(rec.path)).toBe(true);
      // Nothing was created next to (or above) the session directory.
      expect(existsSync(join(root, 'src'))).toBe(false);
      expect(readdirSync(s.dir).sort()).toEqual(expect.arrayContaining(['baseline']));
      expect(store.findArtifact(uri)?.rec).toBe(rec);
    },
  );

  it('sanitizes a traversal kind too', () => {
    const s = store.create(root);
    store.saveArtifact(s, '../../escape', 'x.txt', 'hello', 'text/plain');
    const rec = s.artifacts.at(-1)!;
    expect(resolve(rec.path).startsWith(resolve(s.dir) + sep)).toBe(true);
  });

  it('safeArtifactName: no separators, no `..`, keeps ordinary names and the extension of long ones', () => {
    expect(safeArtifactName('shot-001.png')).toBe('shot-001.png');
    expect(safeArtifactName('../../x.png')).not.toMatch(/\.\.|[\\/]/);
    const long = safeArtifactName(`${'a'.repeat(400)}.png`);
    expect(long.length).toBeLessThanOrEqual(180);
    expect(long.endsWith('.png')).toBe(true);
  });

  it('encodes URI segments (spaces, commas, %) so they match the template, and findArtifact accepts either spelling', () => {
    const s = store.create(root);
    const uri = store.saveArtifact(s, 'screenshot', 'after login, 50%.png', Buffer.from('p'), 'image/png');
    expect(uri).toBe(`swipium://session/${s.id}/screenshot/after%20login%2C%2050%25.png`);
    expect(new URL(uri).href).toBe(uri); // stable under URL normalisation (what the SDK hands the read handler)
    expect(store.findArtifact(uri)).toBeTruthy();
    // A legacy raw-spelled URI still resolves.
    expect(store.findArtifact(`swipium://session/${s.id}/screenshot/after login, 50%.png`)).toBeTruthy();
    expect(encodeUriSegment('feature:login')).toBe('feature:login');
    expect(decodeUriSegment(encodeUriSegment('app/(tabs) ü'))).toBe('app/(tabs) ü');
  });

  it('activeRoots only reports roots of sessions created or used in this process', () => {
    const other = mkdtempSync(join(tmpdir(), 'swipium-store-other-'));
    try {
      const s = store.create(other);
      expect(store.activeRoots()).toContain(other);
      // A fresh store (≈ server restart) reloads the session from the registry but does not
      // consider it active until a tool looks it up.
      const fresh = new SessionStore();
      expect(fresh.list().some((x) => x.id === s.id)).toBe(true);
      expect(fresh.activeRoots()).not.toContain(other);
      fresh.get(s.id);
      expect(fresh.activeRoots()).toContain(other);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
