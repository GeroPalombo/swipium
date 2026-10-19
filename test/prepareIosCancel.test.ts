// Cancelling an iOS prepare stops it between steps: a job cancelled during the install never
// launches, one cancelled during the launch never contacts WDA, and the install itself gets the
// job's signal (so simctl install is killed). Hermetic: simctl and WDA are faked.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-prepios-cancel-home-'));
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const fake = vi.hoisted(() => ({
  onInstall: (() => {}) as () => void,
  onLaunch: (() => {}) as () => void,
  installSignal: undefined as AbortSignal | undefined,
  launches: 0,
  wdaChecks: 0,
}));

vi.mock('../src/lib/simctl.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/simctl.js')>()),
  simctlAvailable: vi.fn(async () => true),
  listSimulators: vi.fn(async () => [{ udid: UDID, name: 'iPhone 16', state: 'Booted', runtime: 'iOS-18-0' }]),
  bootInFlight: vi.fn(() => false),
  installApp: vi.fn(async (_udid: string, _app: string, opts?: { signal?: AbortSignal }) => {
    fake.installSignal = opts?.signal;
    fake.onInstall();
  }),
  bundleIdFromApp: vi.fn(async () => 'com.example.app'),
  launchApp: vi.fn(async () => {
    fake.launches++;
    fake.onLaunch();
  }),
}));
vi.mock('../src/lib/wda.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/wda.js')>()),
  checkWda: vi.fn(async () => {
    fake.wdaChecks++;
    return { reachable: false, ready: false };
  }),
}));

const { prepareIos } = await import('../src/services/prepareIos.js');
const { SessionStore } = await import('../src/session/store.js');

const root = mkdtempSync(join(tmpdir(), 'swipium-prepios-cancel-'));
const app = join(root, 'Demo.app');
mkdirSync(app, { recursive: true });
const sessions = new SessionStore();

beforeEach(() => {
  fake.onInstall = () => {};
  fake.onLaunch = () => {};
  fake.installSignal = undefined;
  fake.launches = 0;
  fake.wdaChecks = 0;
});

const prepare = (ctl: AbortController) =>
  prepareIos(sessions, sessions.create(root), { app, simulator: UDID, allowLaunchWithoutMetro: true }, { signal: ctl.signal });

describe('prepareIos cancellation', () => {
  it('a cancel during the install never launches, and the install got the signal', async () => {
    const ctl = new AbortController();
    fake.onInstall = () => ctl.abort();
    const res = await prepare(ctl);
    expect(res).toMatchObject({ ok: false, failureCode: 'CANCELLED' });
    expect(fake.installSignal).toBe(ctl.signal);
    expect(fake.launches).toBe(0);
    expect(fake.wdaChecks).toBe(0);
  });

  it('an install killed by the cancel is CANCELLED, not an install failure', async () => {
    const ctl = new AbortController();
    fake.onInstall = () => {
      ctl.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    };
    const s = sessions.create(root);
    const res = await prepareIos(sessions, s, { app, simulator: UDID, allowLaunchWithoutMetro: true }, { signal: ctl.signal });
    expect(res).toMatchObject({ ok: false, failureCode: 'CANCELLED' });
    expect(s.mutations.some((m) => m.action === 'install_app' && m.status === 'blocked')).toBe(false);
    expect(fake.launches).toBe(0);
  });

  it('a cancel during the launch never contacts WDA', async () => {
    const ctl = new AbortController();
    fake.onLaunch = () => ctl.abort();
    const res = await prepare(ctl);
    expect(res).toMatchObject({ ok: false, failureCode: 'CANCELLED', installed: true, launched: true });
    expect(fake.wdaChecks).toBe(0);
  });

  it('without a cancel the steps all run', async () => {
    const res = await prepare(new AbortController());
    expect(res.ok).toBe(true);
    expect(fake.launches).toBe(1);
    expect(fake.wdaChecks).toBeGreaterThan(0);
  });
});
