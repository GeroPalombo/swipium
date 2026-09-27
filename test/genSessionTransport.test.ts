// The session's transport (driver kind + WDA base URL) persists in state.json as PLAIN fields and a
// rehydrated session re-binds that same transport — the persisted fields outrank the UDID-shape +
// mutation-ledger heuristics in rebindIosSimulator. The store never constructs a driver.
// Hermetic: HOME points at a temp dir BEFORE the store module is loaded.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-transport-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { getDriver, setIosProbeForTests } = await import('../src/session/attach.js');

const UDID = '8F3C2A10-1B2C-4D5E-8F90-ABCDEF123456';
const WDA_URL = 'http://127.0.0.1:8123';
const root = mkdtempSync(join(tmpdir(), 'swipium-transport-proj-'));
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => setIosProbeForTests(undefined));

const booted = async () => [{ udid: UDID, name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' }];

/** Create a session bound to a fake live driver, persist it, and reload it in a "restarted" store. */
function persistAndReload(driver: Record<string, unknown>, device = UDID) {
  const store = new SessionStore();
  const s = store.create(root);
  s.device = device;
  s.driver = driver as never;
  store.persistNow(s);
  const state = JSON.parse(readFileSync(join(s.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  const reloaded = new SessionStore().get(s.id)!;
  return { store, s, state, reloaded };
}

describe('state.json persists the transport as plain fields', () => {
  it('WDA: driverKind + wdaUrl written and restored; no driver object is constructed', () => {
    const { state, reloaded } = persistAndReload({ kind: 'wda', baseUrl: WDA_URL });
    expect(state.driverKind).toBe('wda');
    expect(state.wdaUrl).toBe(WDA_URL);
    expect(state.driver).toBeUndefined();
    expect(reloaded.driverKind).toBe('wda');
    expect(reloaded.wdaUrl).toBe(WDA_URL);
    expect(reloaded.driver).toBeUndefined();
  });

  it('direct (adb): driverKind only', () => {
    const { state } = persistAndReload({ kind: 'direct' }, 'emulator-5554');
    expect(state.driverKind).toBe('direct');
    expect(state.wdaUrl).toBeUndefined();
  });
});

describe('rehydrate prefers the persisted transport', () => {
  it('re-binds WDA at the persisted URL even with no wda_attach ledger row', async () => {
    const probed: string[] = [];
    setIosProbeForTests({
      listSimulators: booted,
      wdaReachable: async (url) => (probed.push(url), url === WDA_URL),
    });
    const { reloaded } = persistAndReload({ kind: 'wda', baseUrl: WDA_URL });
    expect(reloaded.mutations).toHaveLength(0);
    const r = await getDriver(reloaded);
    expect(r.driver?.kind).toBe('wda');
    expect((r.driver as unknown as { baseUrl: string }).baseUrl).toBe(WDA_URL);
    // Rebind never relaunches/terminates the app: every session it creates sends
    // forceAppLaunch:false + shouldTerminateApp:false (payload asserted in wdaHotfix.test.ts).
    expect((r.driver as unknown as { reuseRunningApp: boolean }).reuseRunningApp).toBe(true);
    expect(probed).toEqual([WDA_URL]);
  });

  it('a session persisted on simctl stays on simctl even if the ledger shows an old WDA attach', async () => {
    setIosProbeForTests({ listSimulators: booted, wdaReachable: async () => true });
    const { store, s } = persistAndReload({ kind: 'simulator' });
    store.recordMutation(s, {
      tool: 'qa_wda',
      action: 'wda_attach',
      risk: 'medium',
      target: { webDriverAgentUrl: 'http://127.0.0.1:8100', udid: UDID },
      consent: { required: false, approved: true },
      status: 'executed',
    });
    store.persistNow(s);
    const reloaded = new SessionStore().get(s.id)!;
    expect(reloaded.driverKind).toBe('simulator');
    const r = await getDriver(reloaded);
    expect(r.driver?.kind).toBe('simulator');
  });

  it('driverKind "direct" wins over a UUID-shaped device id (never routed to the iOS rebind)', async () => {
    let listed = false;
    setIosProbeForTests({ listSimulators: async () => ((listed = true), await booted()) });
    const { reloaded } = persistAndReload({ kind: 'direct' }, UDID);
    const r = await getDriver(reloaded);
    expect(listed).toBe(false);
    expect(r.driver?.kind).not.toBe('simulator');
    expect(r.driver?.kind).not.toBe('wda');
  });
});
