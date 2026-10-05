// docs/tools.md is the reference for the tool surface. These checks keep the parts of it that are
// pure data in step with the code: the tool index (group + annotation hints), one section per
// tool, and the failure-code catalog (every code, its bucket, and its owner).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_GROUPS } from '../src/core/capabilityGroups.js';
import { toolAnnotations } from '../src/lib/toolAnnotations.js';
import { FAILURES, failureOwner, type FailureCode } from '../src/oracle/failures.js';
import { TOOL_NAMES } from '../src/version.js';

const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'tools.md'), 'utf8');

describe('docs/tools.md tool index', () => {
  it('each row has the tool group and the annotation hint the server sends', () => {
    for (const name of TOOL_NAMES) {
      const row = doc.match(new RegExp(`^\\| \`${name}\` \\| ([^|]*)\\| ([^|]*)\\|`, 'm'));
      expect(row, `index row for ${name}`).not.toBeNull();
      const a = toolAnnotations(name);
      const hint = a.readOnlyHint ? 'RO' : a.destructiveHint ? 'D' : a.idempotentHint ? 'I' : '';
      expect(row![2].trim(), `${name} hint`).toBe(hint);
      const group = CAPABILITY_GROUPS.find((g) => g.tools.includes(name))?.group;
      expect(row![1].trim(), `${name} group`).toBe(group);
    }
  });

  it('every tool has its own section', () => {
    for (const name of TOOL_NAMES) expect(doc, `### ${name}`).toContain(`\n### ${name}\n`);
  });
});

describe('docs/tools.md failure codes', () => {
  // "### Bucket: <bucket>" tables; each row lists one or more codes, then the owner.
  const section = doc.slice(doc.indexOf('## Failure codes'), doc.indexOf('## Migrating from'));
  const documented = new Map<string, { bucket: string; owner: string }>();
  let bucket = '';
  for (const line of section.split('\n')) {
    const heading = line.match(/^### Bucket: (\w+)/);
    if (heading) {
      bucket = heading[1];
      continue;
    }
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').map((c) => c.trim());
    for (const m of cells[1].matchAll(/`([A-Z0-9_]+)`/g)) documented.set(m[1], { bucket, owner: cells[2] });
  }

  it('lists exactly the codes in src/oracle/failures.ts', () => {
    expect([...documented.keys()].sort()).toEqual(Object.keys(FAILURES).sort());
  });

  it('puts each code under its bucket with its owner', () => {
    for (const [code, info] of Object.entries(FAILURES)) {
      expect(documented.get(code)?.bucket, `${code} bucket`).toBe(info.bucket);
      expect(documented.get(code)?.owner, `${code} owner`).toBe(failureOwner(code as FailureCode));
    }
  });
});
