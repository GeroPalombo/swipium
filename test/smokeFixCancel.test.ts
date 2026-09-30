// Real-device smoke fix #1: cancelled work was recorded as real failures.
//  (a) a cancelled qa_snapshot ("uiautomator dump failed … AbortError") bumped snapshotFailures,
//      recorded a SNAPSHOT_FAILED tool error and flipped the report's TOOL status to DEGRADED;
//  (b) on iOS a cancelled qa_explore job recorded a HIGH `wda_unreachable` finding (→ RELEASE RISK:
//      BLOCK) because the aborted WDA /source looked like "WDA did not return a UI source".
// Cancellation is now detected centrally (lib/abortScope.ts isAbortError) and surfaces as a
// CANCELLED result that is never a tool error, snapshot failure, finding, health verdict or mode switch.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDriver, buttonScreen, harness } from './actFixFake.js';
import { CancelledError, currentSignal, isAbortError, runWithSignal } from '../src/lib/abortScope.js';
import { checkHealth } from '../src/oracle/health.js';
import { toolErrorFromResult, toolVerdictFor, isDegradingToolError } from '../src/report/toolHealth.js';
import { cancelledResult } from '../src/lib/result.js';
import { FAILURES } from '../src/oracle/failures.js';
import { classifyFlowDriverError } from '../src/flows/run.js';
import type { Driver } from '../src/drivers/Driver.js';

/** Resolves once the current call's signal aborts (or after `ms`). */
function untilAborted(ms = 5000): Promise<void> {
  const sig = currentSignal();
  return new Promise<void>((resolve) => {
    if (!sig || sig.aborted) return resolve();
    sig.addEventListener('abort', () => resolve(), { once: true });
    setTimeout(resolve, ms);
  });
}

/** Android fake whose dump hangs until the call is cancelled, then fails like DirectDriver does. */
class HangingDumpDriver extends FakeDriver {
  hangDump = false;
  finishedDumps = 0;
  async dumpXml(opts?: Parameters<FakeDriver['dumpXml']>[0]) {
    if (!this.hangDump) return super.dumpXml(opts);
    this.rec('dumpXml', opts);
    await untilAborted();
    this.finishedDumps++;
    throw new Error('uiautomator dump failed after 1 attempt(s): AbortError: The operation was aborted');
  }
}

describe('isAbortError', () => {
  it('recognises AbortError names, ABORT_ERR codes, cause chains and an aborted current signal', async () => {
    const abortErr = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(isAbortError(abortErr)).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' }))).toBe(true);
    expect(isAbortError(new Error('WDA GET /source aborted (cancelled)', { cause: abortErr }))).toBe(true);
    expect(isAbortError(new CancelledError())).toBe(true);
    expect(isAbortError(new Error('uiautomator dump failed: could not get idle state'))).toBe(false);
    const ctl = new AbortController();
    ctl.abort();
    await runWithSignal(ctl.signal, async () => expect(isAbortError(new Error('anything'))).toBe(true));
  });

  it('CANCELLED is a catalogued, non-degrading code that is never recorded as a tool error', () => {
    expect(FAILURES.CANCELLED).toBeTruthy();
    expect(isDegradingToolError('CANCELLED')).toBe(false);
    expect(toolErrorFromResult('qa_snapshot', cancelledResult())).toBeUndefined();
    expect(classifyFlowDriverError(Object.assign(new Error('WDA GET /source aborted'), { name: 'AbortError' }))).toBe('CANCELLED');
  });
});

describe('cancelled qa_snapshot is not a snapshot failure (Android)', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness('smokefix-cancel');
  });
  afterAll(async () => {
    await h.close();
  });

  it('no toolError, no snapshotFailures bump, no visual-fallback, report tool status stays PASS', async () => {
    const fake = new HangingDumpDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const session = h.sessions.get(id)!;
    fake.hangDump = true;
    // Cancel more snapshots than maxSnapshotFailures: none may count.
    for (let i = 0; i < session.budget.maxSnapshotFailures + 1; i++) {
      const before = fake.finishedDumps;
      const ctl = new AbortController();
      const p = h.client.callTool({ name: 'qa_snapshot', arguments: { sessionId: id } }, undefined, { signal: ctl.signal });
      setTimeout(() => ctl.abort('user cancelled'), 50);
      await expect(p).rejects.toBeTruthy();
      for (let j = 0; j < 100 && fake.finishedDumps === before; j++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 30)); // let the handler + wrapper finish
    }
    expect(fake.finishedDumps).toBe(session.budget.maxSnapshotFailures + 1);
    expect(session.counters.snapshotFailures).toBe(0);
    expect(session.mode).toBe('structured');
    expect(session.toolErrors ?? []).toEqual([]);
    expect(toolVerdictFor([], session.toolErrors).status).toBe('PASS');

    // …and the next (uncancelled) snapshot works normally.
    fake.hangDump = false;
    const ok = (await h.call('qa_snapshot', { sessionId: id })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
  }, 30_000);

  it('a cancelled qa_act (driver call aborted) records no tool error', async () => {
    const fake = new FakeDriver(buttonScreen('Home', 3));
    const id = await h.start(fake);
    const session = h.sessions.get(id)!;
    fake.hangTap = true;
    const ctl = new AbortController();
    const p = h.client.callTool({ name: 'qa_act', arguments: { sessionId: id, action: 'tap', target: { x: 5, y: 5 } } }, undefined, {
      signal: ctl.signal,
    });
    setTimeout(() => ctl.abort('user cancelled'), 100);
    await expect(p).rejects.toBeTruthy();
    for (let i = 0; i < 100 && !fake.abortedDuringTap; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.abortedDuringTap).toBe(true);
    expect(session.toolErrors ?? []).toEqual([]);
    expect(session.findings).toEqual([]);
  }, 20_000);
});

/** iOS WDA-shaped fake: /source hangs until the job is cancelled, then fails like lib/wda.ts. */
function wdaDriver(): Driver & { dumps: number } {
  const d = {
    kind: 'wda' as const,
    dumps: 0,
    async dumpXml() {
      d.dumps++;
      await untilAborted();
      throw new Error('WDA GET /source aborted (cancelled)');
    },
    async foregroundOwner() {
      return 'com.apple.Preferences';
    },
    async screenshot() {
      return Buffer.alloc(0);
    },
    async screenSize() {
      return { width: 390, height: 844 };
    },
    async pressKey() {},
    async tapXY() {},
  };
  return d as unknown as Driver & { dumps: number };
}

describe('cancelled iOS work records no finding', () => {
  it('checkHealth on an aborted WDA dump is CANCELLED — no wda_unreachable finding', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const h = await runWithSignal(ctl.signal, () => checkHealth(wdaDriver(), 'com.apple.Preferences'));
    expect(h.cancelled).toBe(true);
    expect(h.findings).toEqual([]);
    expect(h.nativeStatus).toBe('ok');
  });

  it('control: an unreachable WDA without cancellation still reports wda_unreachable', async () => {
    const d = { ...wdaDriver(), kind: 'wda' as const, dumpXml: async () => Promise.reject(new Error('WDA GET /source ECONNREFUSED')) };
    const h = await checkHealth(d as unknown as Driver, 'com.apple.Preferences');
    expect(h.findings.map((f) => f.kind)).toContain('wda_unreachable');
  });

  it('a cancelled qa_explore run stops as "cancelled" with no finding and no visual-only note', async () => {
    const home = mkdtempSync(join(tmpdir(), 'smokefix-explore-home-'));
    const root = mkdtempSync(join(tmpdir(), 'smokefix-explore-root-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { SessionStore } = await import('../src/session/store.js');
      const { runExplore } = await import('../src/explore/runner.js');
      const sessions = new SessionStore();
      const session = sessions.create(root);
      session.appId = 'com.apple.Preferences';
      const driver = wdaDriver();
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 50);
      const res = await runWithSignal(ctl.signal, () => runExplore(sessions, session, driver, { maxActions: 3 }, { signal: ctl.signal }));
      expect(driver.dumps).toBeGreaterThan(0);
      expect(res.stoppedReason).toBe('cancelled');
      expect(session.findings).toEqual([]);
      expect(session.notes.filter((n) => /visual-only screen/.test(String(n.reason)))).toEqual([]);
      expect(res.summary.visualOnlyScreens).toBe(0);
    } finally {
      process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
