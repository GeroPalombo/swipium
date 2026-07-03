// Doc-version lockstep: THREAT_MODEL.md ships in the npm tarball and states a Swipium
// version. It once drifted to a version that never existed; this pins it to package.json
// so `release:check` (which runs the test suite) catches any future drift.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

describe('doc version lockstep', () => {
  it('THREAT_MODEL.md states the same version as package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const threatModel = readFileSync(join(root, 'THREAT_MODEL.md'), 'utf8');

    const match = threatModel.match(/\(Swipium ([0-9]+\.[0-9]+\.[0-9]+[^)]*)\)/);
    expect(match, 'THREAT_MODEL.md must contain a "(Swipium <version>)" marker').not.toBeNull();
    expect(match![1]).toBe(pkg.version);
  });
});
