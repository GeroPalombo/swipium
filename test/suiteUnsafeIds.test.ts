// A test-suite.json with an unsafe stored case id (`../../x`, a hand
// edit or a cloned repo) never makes qa_suite_export write outside .swipium/test-suite-export/yaml,
// the id is renamed on read and reported (loadRepairs), and qa_suite_lint flags it (unsafe_id).
// Hermetic: in-memory server, temp HOME and project root.

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { harness, structured } from './actFixFake.js';

const h = await harness('round4-suite');
const roots: string[] = [];
afterAll(async () => {
  await h.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A project whose suite holds a traversal id, a duplicate and a good case. */
function poisonedProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-r4-suite-tool-')));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"r4suite"}');
  mkdirSync(join(root, '.swipium'), { recursive: true });
  const c = (id: string, title: string) => ({ id, functionality: 'Login', title, objective: title, steps: [{ action: 'open app' }] });
  writeFileSync(
    join(root, '.swipium', 'test-suite.json'),
    JSON.stringify({
      schemaVersion: 1,
      cases: [c('../../../../escaped', 'Escape'), c('TC-LOGIN-001', 'Good'), c('TC-LOGIN-001', 'Dup')],
    }),
  );
  return root;
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

describe('qa_suite_export / qa_suite_lint with unsafe stored ids', () => {
  it('export save:true writes only under test-suite-export/yaml and reports the renames', async () => {
    const root = poisonedProject();
    const res = structured(await h.call('qa_suite_export', { projectRoot: root, format: 'yaml', save: true }));
    expect(res.ok).toBe(true);
    const yamlBase = join(root, '.swipium', 'test-suite-export', 'yaml');
    const written = res.written as string[];
    expect(written).toHaveLength(3);
    for (const p of written) expect(relative(yamlBase, p).startsWith('..')).toBe(false);
    expect(walk(yamlBase)).toHaveLength(3);
    expect(existsSync(join(root, '..', '..', 'escaped.yaml'))).toBe(false);
    expect((res.loadRepairs as string[]).join('\n')).toMatch(/not a safe file name/);
    expect((res.loadRepairs as string[]).join('\n')).toMatch(/is a duplicate/);
  });

  it('qa_suite_lint reports each rename as an unsafe_id error', async () => {
    const root = poisonedProject();
    const res = structured(await h.call('qa_suite_lint', { projectRoot: root }));
    const findings = res.findings as Array<{ rule: string; severity: string }>;
    expect(findings.filter((f) => f.rule === 'unsafe_id')).toHaveLength(2);
    expect(findings.find((f) => f.rule === 'unsafe_id')?.severity).toBe('error');
  });
});
