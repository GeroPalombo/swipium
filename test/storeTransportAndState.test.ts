// Pre-launch findings on the session store:
//  - (MED) a brief WDA outage during rehydrate permanently downgraded an iOS session: attach.ts fell
//    back to SimctlDriver and writeState then persisted driverKind='simulator', so later restarts
//    never retried the WDA URL;
//  - (LOW) jobs / envChanges / mutations / fixtures skipped the state.json secret redaction, and
//    ~/.swipium/runs session dirs/files were world-readable;
//  - lastTestThisArgs (original qa_test_this args) is persisted + rehydrated.
// Hermetic: HOME points at a temp dir BEFORE the store module is loaded.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-store-transport-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { getDriver, setIosProbeForTests, WDA_RETRY_INTERVAL_MS } = await import('../src/session/attach.js');

const UDID = '8F3C2A10-1B2C-4D5E-8F90-ABCDEF123456';
const WDA_URL = 'http://127.0.0.1:8123';
const SECRET = 'Zq7!sEcr3t#Pw';
const root = mkdtempSync(join(tmpdir(), 'swipium-store-transport-proj-'));
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => setIosProbeForTests(undefined));

const booted = async () => [{ udid: UDID, name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' }];

function persistedWdaSession() {
  const store = new SessionStore();
  const s = store.create(root);
  s.device = UDID;
  s.driver = { kind: 'wda', baseUrl: WDA_URL } as never;
  store.persistNow(s);
  return s;
}

describe('WDA outage during rehydrate does not downgrade the session', () => {
  it('falls back to simctl with a note, keeps driverKind "wda" persisted, and retries WDA later', async () => {
    let up = false;
    setIosProbeForTests({ listSimulators: booted, wdaReachable: async () => up });
    const s0 = persistedWdaSession();

    const store2 = new SessionStore();
    const reloaded = store2.get(s0.id)!;
    const r = await getDriver(reloaded);
    expect(r.driver?.kind).toBe('simulator');
    expect(r.note).toMatch(/unreachable/);
    expect(reloaded.workarounds.some((w) => w.includes('simctl fallback'))).toBe(true);

    store2.persistNow(reloaded);
    const state = JSON.parse(readFileSync(join(reloaded.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
    expect(state.driverKind).toBe('wda');
    expect(state.wdaUrl).toBe(WDA_URL);

    // A third server run still tries WDA first.
    const again = new SessionStore().get(s0.id)!;
    expect(again.driverKind).toBe('wda');

    // Same process: once WDA is back (and the retry throttle has elapsed) the next getDriver upgrades.
    up = true;
    expect((await getDriver(reloaded)).driver?.kind).toBe('simulator'); // throttled
    reloaded.transportFallback!.lastProbeAt = Date.now() - WDA_RETRY_INTERVAL_MS - 1;
    const r2 = await getDriver(reloaded);
    expect(r2.driver?.kind).toBe('wda');
    expect(r2.note).toMatch(/back on its WDA transport/);
    expect(reloaded.transportFallback).toBeUndefined();
  });
});

describe('state.json redaction + permissions', () => {
  it('redacts jobs, envChanges, mutations and fixtures', () => {
    const store = new SessionStore();
    const s = store.create(root);
    s.secrets.add(SECRET);
    const job = store.createJob(s, 'build');
    store.updateJob(s, job, { status: 'failed', error: `argv had ${SECRET}`, result: { cmd: `login --pw ${SECRET}` } });
    store.addEnvChange(s, `typed ${SECRET}`);
    store.recordMutation(s, {
      tool: 'qa_app',
      action: 'seed',
      risk: 'low',
      target: { body: `pw=${SECRET}`, pkg: 'com.test.app' },
      status: 'executed',
    });
    s.fixtures.push({ name: 'acct', fields: { password: { value: SECRET, secret: true } } });
    store.persistNow(s);
    const raw = readFileSync(join(s.dir, 'state.json'), 'utf8');
    expect(raw).not.toContain(SECRET);
    const st = JSON.parse(raw) as { mutations: Array<{ target: { pkg: string } }> };
    expect(st.mutations[0].target.pkg).toBe('com.test.app');
    // In-memory state is untouched.
    expect(s.envChanges[0]).toContain(SECRET);
  });

  it.skipIf(process.platform === 'win32')('session dirs are 0700 and state.json / artifacts 0600', () => {
    const store = new SessionStore();
    const s = store.create(root);
    store.persistNow(s);
    store.saveArtifact(s, 'logs', 'x.txt', 'hello', 'text/plain');
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.dir, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.dir, 'logs', 'x.txt')).mode & 0o777).toBe(0o600);
  });
});

describe('lastTestThisArgs', () => {
  it('persists (secret values redacted) and rehydrates', () => {
    const store = new SessionStore();
    const s = store.create(root);
    s.secrets.add(SECRET);
    store.setLastTestThisArgs(s, { goal: 'login', goalText: `log in with ${SECRET}`, flags: { generateSuite: true } });
    store.flushAll();
    const reloaded = new SessionStore().get(s.id)!;
    expect(reloaded.lastTestThisArgs).toMatchObject({ goal: 'login', flags: { generateSuite: true } });
    expect(reloaded.lastTestThisArgs?.goalText).not.toContain(SECRET);
    expect(typeof reloaded.lastTestThisArgs?.at).toBe('number');
  });
});
