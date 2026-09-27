// D9: qa_doctor's default platform follows the host (macOS → both, else android) and the node
// check is a real comparison against package.json engines (>=20), not always ok.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaultDoctorPlatform, MIN_NODE_MAJOR, nodeVersionCheck } from '../src/tools/doctor.js';

describe('qa_doctor defaults', () => {
  it('defaults to both on macOS and android elsewhere', () => {
    expect(defaultDoctorPlatform('darwin')).toBe('both');
    expect(defaultDoctorPlatform('linux')).toBe('android');
    expect(defaultDoctorPlatform('win32')).toBe('android');
  });

  it('MIN_NODE_MAJOR mirrors package.json engines.node', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });

  it('fails the node check below the minimum and passes at/above it', () => {
    expect(nodeVersionCheck('v18.19.0').ok).toBe(false);
    expect(nodeVersionCheck('v18.19.0').fix).toContain('20');
    expect(nodeVersionCheck('v20.0.0').ok).toBe(true);
    expect(nodeVersionCheck('v22.3.1').ok).toBe(true);
    expect(nodeVersionCheck('garbage').ok).toBe(false);
  });
});
