// Latency: the settle loop sleeps only `interval - lastDumpDuration` and bounds each dump by the
// remaining deadline (<= 2 attempts); checkHealth reuses parsed nodes and skips the heavy
// `dumpsys activity activities` when the dump root already is the app under test.
// The timing tests run on fake timers (Date and setTimeout), so the measured durations are the
// loop's own schedule, not the host's load.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settle, SETTLE_DUMP_ATTEMPTS } from '../src/snapshot/settle.js';
import { checkHealth } from '../src/oracle/health.js';
import { parseSnapshot } from '../src/snapshot/parse.js';
import { buttonScreen, dump, FakeDriver } from './actFixFake.js';
import type { DumpOptions } from '../src/drivers/Driver.js';

class SlowDump extends FakeDriver {
  constructor(
    xml: string,
    private readonly dumpMs: number,
    private readonly hang = false,
  ) {
    super(xml);
  }
  override async dumpXml(opts?: DumpOptions) {
    this.rec('dumpXml', opts);
    if (this.hang) {
      await new Promise((r) => setTimeout(r, opts?.timeoutMs ?? 30_000));
      throw new Error('uiautomator dump timed out');
    }
    await new Promise((r) => setTimeout(r, this.dumpMs));
    return this.xml;
  }
}

/** Run `fn` to completion on fake time; returns its result and the virtual ms it took. */
async function timed<T>(fn: () => Promise<T>): Promise<{ r: T; took: number }> {
  const t0 = Date.now();
  const p = fn();
  await vi.runAllTimersAsync();
  const r = await p;
  return { r, took: Date.now() - t0 };
}

describe('settle latency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adaptive interval: a 300 ms dump is followed by a ~100 ms sleep, not 400 ms', async () => {
    const d = new SlowDump(buttonScreen('Home', 3), 300);
    const { r, took } = await timed(() => settle(d, { timeoutMs: 8000 }));
    expect(r.settled).toBe(true);
    // 3 dumps x 300 + 2 x 100 sleep = about 1100 ms (fixed 400 ms sleeps: about 1700 ms)
    expect(d.got('dumpXml')).toHaveLength(3);
    expect(took).toBeGreaterThanOrEqual(1100);
    expect(took).toBeLessThan(1400);
    const opts = d.got('dumpXml').map((c) => c.a[0] as DumpOptions);
    expect(opts.every((o) => o.attempts === SETTLE_DUMP_ATTEMPTS && (o.timeoutMs ?? 0) <= 8000)).toBe(true);
  });

  it('a hanging dump is bounded by the settle deadline (not 5 x 20 s)', async () => {
    const d = new SlowDump('', 0, true);
    const { r, took } = await timed(() => settle(d, { timeoutMs: 1600 }));
    expect(r.settled).toBe(false);
    expect(took).toBeLessThan(2600);
  });

  it('a seed replaces the first dump', async () => {
    const xml = buttonScreen('Home', 3);
    const d = new SlowDump(xml, 0);
    const { r } = await timed(() => settle(d, { seed: { xml, at: Date.now() } }));
    expect(r.settled).toBe(true);
    expect(d.got('dumpXml')).toHaveLength(2); // was 3
  });
});

describe('checkHealth foreground shortcut', () => {
  it('root package == appId: no foregroundOwner (dumpsys) call, and passed nodes are used', async () => {
    const xml = buttonScreen('Home', 3);
    const d = new FakeDriver(xml);
    const nodes = parseSnapshot(xml).allNodes;
    const h = await checkHealth(d, 'com.example.app', xml, { nodes });
    expect(d.got('foregroundOwner')).toHaveLength(0);
    expect(h.foreground).toBe('com.example.app');
    expect(h.healthy).toBe(true);
  });

  it('still asks dumpsys when the root is another package, when crash copy is on screen, or with no xml', async () => {
    const other = buttonScreen('Perm', 2, 'com.google.android.permissioncontroller');
    const d1 = new FakeDriver(other);
    d1.foreground = 'com.google.android.permissioncontroller/.GrantPermissionsActivity';
    const h1 = await checkHealth(d1, 'com.example.app', other);
    expect(d1.got('foregroundOwner')).toHaveLength(1);
    expect(h1.findings.map((f) => f.kind)).toContain('permission_dialog');

    const crash = dump([{ cls: 'android.widget.TextView', text: 'Example keeps stopping', bounds: [0, 0, 100, 100] }]);
    const d2 = new FakeDriver(crash);
    await checkHealth(d2, 'com.example.app', crash);
    expect(d2.got('foregroundOwner')).toHaveLength(1);

    const d3 = new FakeDriver(buttonScreen('Home', 2));
    await checkHealth(d3, 'com.example.app');
    expect(d3.got('foregroundOwner')).toHaveLength(1);
  });
});
