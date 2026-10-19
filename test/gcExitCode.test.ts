// `swipium gc` exits non-zero when some session dirs could not be processed, so scripts notice.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/session/retention.js', async (orig) => ({
  ...(await orig<typeof import('../src/session/retention.js')>()),
  pruneSessionRuns: vi.fn(async () => ({
    runsDir: '/tmp/runs',
    days: 30,
    keepPerProject: 20,
    dryRun: false,
    scanned: 3,
    deleted: [],
    bytesReclaimed: 0,
    errors: 2,
  })),
}));
vi.mock('../src/appMap/projectRegistry.js', async (orig) => ({
  ...(await orig<typeof import('../src/appMap/projectRegistry.js')>()),
  compactProjectRegistry: vi.fn(() => ({ before: 0, after: 0, removed: 0 })),
}));

const { runGc } = await import('../src/cli/gc.js');

describe('swipium gc exit code', () => {
  it('is 1 when entries could not be processed, and says so', async () => {
    let out = '';
    expect(await runGc([], (s) => void (out += s))).toBe(1);
    expect(out).toMatch(/2 entries could not be processed/);
  });
});
