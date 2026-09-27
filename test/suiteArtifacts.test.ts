// SWIP-07: qa_test_this generateSuite:true must advertise a FETCHABLE deliverable. Generated suite
// files are registered via sessions.saveArtifact so their swipium:// URIs resolve through
// qa_get_artifact / the MCP resource template — a bare `file://` path never appears in the job's
// artifacts array. Hermetic: HOME points at a temp dir BEFORE the store module is loaded.

import { describe, expect, it, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-test-home-'));
process.env.HOME = fakeHome;

const { SessionStore } = await import('../src/session/store.js');
const { registerSuiteArtifacts } = await import('../src/orchestration/testThis/pipeline.js');

const projectRoot = mkdtempSync(join(tmpdir(), 'swipium-test-proj-'));

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('suite artifact registration (SWIP-07)', () => {
  it('registers written suite files as swipium:// artifacts that round-trip through findArtifact', () => {
    const store = new SessionStore();
    const session = store.create(projectRoot);

    // Same basename in two different .swipium subdirs — names must not collide.
    const suitesDir = join(projectRoot, '.swipium', 'suites');
    const pagesDir = join(projectRoot, '.swipium', 'pages');
    mkdirSync(suitesDir, { recursive: true });
    mkdirSync(pagesDir, { recursive: true });
    const suiteYaml = join(suitesDir, 'smoke.yaml');
    const pageYaml = join(pagesDir, 'smoke.yaml');
    const manifest = join(suitesDir, 'smoke.manifest.json');
    writeFileSync(suiteYaml, 'name: smoke\n');
    writeFileSync(pageYaml, 'page: smoke\n');
    writeFileSync(manifest, '{"schema":"swipium.suite.manifest.v1"}\n');

    const artifacts: string[] = [];
    const uris = registerSuiteArtifacts(store, session, [suiteYaml, pageYaml, manifest], artifacts);

    expect(uris).toHaveLength(3);
    expect(new Set(uris).size).toBe(3);
    // (b) the job-artifacts array carries only the registered swipium:// URIs — never file://.
    expect(artifacts).toEqual(uris);
    expect(artifacts.some((u) => u.startsWith('file://'))).toBe(false);

    // (a) every returned URI round-trips through sessions.findArtifact.
    for (const uri of uris) {
      expect(uri.startsWith(`swipium://session/${session.id}/suite/`)).toBe(true);
      const found = store.findArtifact(uri);
      expect(found).toBeDefined();
      expect(found!.rec.kind).toBe('suite');
    }

    // Mime is derived from the extension; the label keeps the repo-relative on-disk path visible.
    const suiteRec = store.findArtifact(uris[0])!.rec;
    expect(suiteRec.mime).toBe('text/yaml');
    expect(suiteRec.label).toContain(join('.swipium', 'suites', 'smoke.yaml'));
    expect(readFileSync(suiteRec.path, 'utf8')).toBe('name: smoke\n');
    expect(store.findArtifact(uris[2])!.rec.mime).toBe('application/json');
  });
});
