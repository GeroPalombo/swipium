// A crashed owner must not leave the device offline: airplane mode is restored on shutdown
// only by the server process that changed it (network.ownerPid), and a change left behind by a dead
// server is reported as orphaned. Fake drivers only (no adb); HOME is a temp dir (setupFakeHome).

import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { sessionsToRestoreOnShutdown, restoreAllNetwork, orphanedNetworkChanges, orphanedNetworkWarning } =
  await import('../src/tools/network.js');
type Driver = import('../src/drivers/Driver.js').Driver;

const root = mkdtempSync(join(tmpdir(), 'swipium-net-owner-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fakeDriver = (kind: Driver['kind']) =>
  ({ kind, setAirplane: vi.fn(async () => {}) }) as unknown as Driver & { setAirplane: ReturnType<typeof vi.fn> };
// A pid that has exited (spawnSync waits for the child).
const deadPid = spawnSync('true').pid!;

describe('shutdown restore only by the owning process', () => {
  it("restores the change this process made, leaves another live server's change and a legacy row alone", async () => {
    const store = new SessionStore();
    const mine = store.create(root);
    const theirs = store.create(root);
    const legacy = store.create(root);
    const dMine = fakeDriver('direct');
    const dTheirs = fakeDriver('direct');
    const dLegacy = fakeDriver('direct');
    mine.driver = dMine;
    theirs.driver = dTheirs;
    legacy.driver = dLegacy;
    mine.network = { changed: true, originalAirplane: false, ownerPid: process.pid };
    theirs.network = { changed: true, originalAirplane: false, ownerPid: process.ppid };
    legacy.network = { changed: true, originalAirplane: false };

    expect(sessionsToRestoreOnShutdown(store).map((s) => s.id)).toEqual([mine.id]);
    await restoreAllNetwork(store);
    expect(dMine.setAirplane).toHaveBeenCalledWith(false);
    expect(mine.network).toMatchObject({ changed: false });
    expect(dTheirs.setAirplane).not.toHaveBeenCalled();
    expect(theirs.network.changed).toBe(true);
    expect(dLegacy.setAirplane).not.toHaveBeenCalled();
    expect(legacy.network.changed).toBe(true);
  });

  it('an iOS driver only clears the flag (it cannot toggle the network)', async () => {
    const store = new SessionStore();
    const s = store.create(root);
    const d = fakeDriver('wda');
    s.driver = d;
    s.network = { changed: true, originalAirplane: false, ownerPid: process.pid };
    await restoreAllNetwork(store);
    expect(d.setAirplane).not.toHaveBeenCalled();
    expect(s.network.changed).toBe(false);
  });
});

describe('orphaned network changes', () => {
  it('reports a change on the same device whose owner is dead; not a live owner, another device or a legacy row', () => {
    const store = new SessionStore();
    const orphan = store.create(root);
    const live = store.create(root);
    const otherDevice = store.create(root);
    const legacy = store.create(root);
    for (const s of [orphan, live, legacy]) s.device = 'emulator-5554';
    otherDevice.device = 'emulator-5556';
    orphan.network = { changed: true, originalAirplane: false, ownerPid: deadPid };
    live.network = { changed: true, originalAirplane: false, ownerPid: process.ppid };
    otherDevice.network = { changed: true, originalAirplane: false, ownerPid: deadPid };
    legacy.network = { changed: true, originalAirplane: false };

    const found = orphanedNetworkChanges(store, 'emulator-5554');
    expect(found.map((s) => s.id)).toEqual([orphan.id]);
    expect(orphanedNetworkChanges(store, undefined)).toEqual([]);
    const warning = orphanedNetworkWarning(found, 'sess-now');
    expect(warning).toContain(orphan.id);
    expect(warning).toContain('qa_network {sessionId:"sess-now", action:"restore"}');
    expect(orphanedNetworkWarning([], 'x')).toBeUndefined();
  });
});
