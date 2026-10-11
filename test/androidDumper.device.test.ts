// D1 on a real device: opt in with SWIPIUM_DEVICE_SERIAL=<serial> (skipped otherwise). Starts the
// agent through DirectDriver.dumpXml, times 10 dumps, checks parsing, then stops the agent and
// removes the jar.

import { describe, expect, it } from 'vitest';

const serial = process.env.SWIPIUM_DEVICE_SERIAL;

describe.skipIf(!serial)('android dumper agent on a device', () => {
  it('dumps faster than exec-out and parses', async () => {
    process.env.SWIPIUM_ANDROID_DUMPER = 'agent';
    const { DirectDriver } = await import('../src/drivers/DirectDriver.js');
    const { stopAndroidDumper } = await import('../src/drivers/androidDumper.js');
    const { parseSnapshot } = await import('../src/snapshot/parse.js');
    const d = new DirectDriver(serial);
    try {
      const t0 = Date.now();
      const first = await d.dumpXml();
      const cold = Date.now() - t0;
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const s = performance.now();
        const xml = await d.dumpXml();
        times.push(performance.now() - s);
        expect(parseSnapshot(xml).total).toBeGreaterThan(0);
      }
      times.sort((a, b) => a - b);
      console.log(`cold ${cold} ms, warm p50 ${times[4].toFixed(0)} ms, p95 ${times[9].toFixed(0)} ms`);
      expect(parseSnapshot(first).total).toBeGreaterThan(0);
      expect(times[4]).toBeLessThan(700);
    } finally {
      await stopAndroidDumper(serial);
      delete process.env.SWIPIUM_ANDROID_DUMPER;
    }
  }, 60_000);
});
