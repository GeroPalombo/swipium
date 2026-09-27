// H6: getDriver's lazy auto-bind must apply the same physical-device policy as planTarget
// (PHYSICAL_DEVICE_UNSUPPORTED), accept emulators whose serial isn't `emulator-N`
// (ro.kernel.qemu / ro.boot.qemu / Genymotion), and refuse a still-booting emulator.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-attach-home-'));
delete process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const runMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return { ...actual, run: runMock };
});

const { getDriver, classifyAndroidProps, parseGetprop, classifyAndroidSerials } = await import('../src/session/attach.js');
const { SessionStore } = await import('../src/session/store.js');
const { planTarget } = await import('../src/core/targetPlan.js');

let online: string[] = [];
let props: Record<string, string> = {};
function answer(_cmd: string, args: string[]): Promise<RunResult> {
  if (args[0] === 'devices') {
    return Promise.resolve({
      code: 0,
      stdout: `List of devices attached\n${online.map((s) => `${s}\tdevice`).join('\n')}\n`,
      stderr: '',
      timedOut: false,
    });
  }
  if (args.includes('getprop')) {
    const serial = args[1];
    const p = props[serial];
    return Promise.resolve({ code: p == null ? 1 : 0, stdout: p ?? '', stderr: '', timedOut: false });
  }
  return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
}

const EMU_PROPS = '[ro.kernel.qemu]: [1]\n[sys.boot_completed]: [1]\n[ro.hardware]: [ranchu]\n';
const PHONE_PROPS = '[ro.hardware]: [qcom]\n[sys.boot_completed]: [1]\n[ro.product.manufacturer]: [samsung]\n';

beforeEach(() => {
  runMock.mockReset();
  runMock.mockImplementation(answer);
  online = [];
  props = {};
});

function newSession() {
  const store = new SessionStore();
  return store.create(mkdtempSync(join(tmpdir(), 'swipium-attach-proj-')));
}

describe('getDriver device policy (H6)', () => {
  it('refuses to auto-bind a single online physical phone', async () => {
    online = ['R5CN30XXXX'];
    props = { R5CN30XXXX: PHONE_PROPS };
    const s = newSession();
    const r = await getDriver(s);
    expect(r.driver).toBeUndefined();
    expect(r.blocked?.failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
    expect(s.device).toBeUndefined();
  });

  it('accepts a localhost:5555 emulator identified by ro.kernel.qemu', async () => {
    online = ['localhost:5555'];
    props = { 'localhost:5555': EMU_PROPS };
    const r = await getDriver(newSession());
    expect(r.driver).toBeDefined();
    expect(r.blocked).toBeUndefined();
  });

  it('refuses a still-booting emulator with DEVICE_NOT_READY', async () => {
    online = ['emulator-5554'];
    props = { 'emulator-5554': '[ro.kernel.qemu]: [1]\n[sys.boot_completed]: []\n' };
    const r = await getDriver(newSession());
    expect(r.driver).toBeUndefined();
    expect(r.blocked?.failureCode).toBe('DEVICE_NOT_READY');
    expect(r.blocked?.detail).toMatch(/booting/);
  });

  it('classifies Genymotion / ro.boot.qemu as emulators and parses getprop', () => {
    expect(parseGetprop('[a.b]: [1]\n[c]: []\n')).toEqual({ 'a.b': '1', c: '' });
    expect(classifyAndroidProps('192.168.56.101:5555', { 'ro.genymotion.version': '3.5' }).emulator).toBe(true);
    expect(classifyAndroidProps('127.0.0.1:6555', { 'ro.boot.qemu': '1' }).emulator).toBe(true);
    expect(classifyAndroidProps('R5CN30XXXX', { 'ro.hardware': 'qcom' }).emulator).toBe(false);
  });

  it('planTarget honours property-verified emulators (same policy)', async () => {
    online = ['localhost:5555', 'R5CN30XXXX'];
    props = { 'localhost:5555': EMU_PROPS, R5CN30XXXX: PHONE_PROPS };
    const { emulators } = await classifyAndroidSerials(online);
    const plan = planTarget({
      android: { online, avds: [], emulators },
      ios: { bootedSimulators: [], availableSimulators: [] },
    });
    expect(plan.selected).toBe('android-emulator');
    expect(plan.device).toBe('localhost:5555');
    // Without the verified list the same serial is (wrongly) treated as physical.
    const legacy = planTarget({
      android: { online: ['localhost:5555'], avds: [] },
      ios: { bootedSimulators: [], availableSimulators: [] },
    });
    expect(legacy.blocked?.failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
  });
});
