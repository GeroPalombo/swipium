// WDA ownership / per-simulator resolution (CR-WDA, GOAL NEW-R3-1), with lsof / ps / WDA mocked:
//  - wdaDeviceOwnership: listener in this simulator = match, in another = other, lsof timed out =
//    unverified (never reusable), nothing inspectable = unknown;
//  - findOwnSimulatorWda / resolveSimulatorWda: a WDA that is not provably this simulator's is
//    replaced by the simulator's own managed WDA on its per-simulator port.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  /** port > simulator UDID whose process listens there (and answers /status). */
  wda: new Map<number, string>(),
  lsofTimeout: false,
  registered: [] as Array<{ endpoint?: string }>,
}));

vi.mock('../src/lib/spawn.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spawn.js')>()),
  run: vi.fn(async (bin: string, args: string[]) => {
    const none = { code: 1, stdout: '', stderr: '', timedOut: false };
    if (bin === 'lsof') {
      if (env.lsofTimeout) return { ...none, timedOut: true };
      const port = Number(args.find((a) => a.startsWith('-iTCP:'))?.slice(6));
      return env.wda.has(port) ? { code: 0, stdout: `7${port}\n`, stderr: '', timedOut: false } : none;
    }
    if (bin === 'ps') {
      const udid = env.wda.get(Number(args[args.length - 1]) - 70000);
      return udid
        ? {
            code: 0,
            stdout: `/x/Library/Developer/CoreSimulator/Devices/${udid}/data/WebDriverAgentRunner-Runner\n`,
            stderr: '',
            timedOut: false,
          }
        : none;
    }
    return none;
  }),
}));
vi.mock('../src/lib/wda.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/wda.js')>()),
  checkWda: vi.fn(async (url: string) =>
    env.wda.has(Number(new URL(url).port)) ? { reachable: true, ready: true } : { reachable: false, ready: false },
  ),
}));
vi.mock('../src/session/processRegistry.js', async (orig) => ({
  ...(await orig<typeof import('../src/session/processRegistry.js')>()),
  registeredWdasForDevice: vi.fn(() => env.registered),
}));

const { wdaDeviceOwnership, findOwnSimulatorWda, resolveSimulatorWda, preferredWdaPort, simulatorUdidFromCommand, mjpegPortFor } =
  await import('../src/lib/wdaDevice.js');

const A = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const B = '11111111-2222-3333-4444-555555555555';
const noRuntime = async () => undefined;
const realPlatform = process.platform;

beforeEach(() => {
  env.wda = new Map();
  env.lsofTimeout = false;
  env.registered = [];
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  return () => Object.defineProperty(process, 'platform', { value: realPlatform });
});

describe('pure helpers', () => {
  it('preferredWdaPort is stable, case-insensitive and in 8101-8900; the stream port is +1000', () => {
    const p = preferredWdaPort(A);
    expect(p).toBe(preferredWdaPort(A.toLowerCase()));
    expect(p).toBeGreaterThanOrEqual(8101);
    expect(p).toBeLessThanOrEqual(8900);
    expect(mjpegPortFor(p)).toBe(p + 1000);
  });

  it('simulatorUdidFromCommand reads the simulator from the executable path', () => {
    expect(simulatorUdidFromCommand(`/Users/x/Library/Developer/CoreSimulator/Devices/${A}/data/app`)).toBe(A);
    expect(simulatorUdidFromCommand('/usr/local/bin/appium')).toBeUndefined();
  });
});

describe('wdaDeviceOwnership', () => {
  it('match / other by the listening process, unverified when lsof times out, unknown when nothing is seen', async () => {
    env.wda.set(8100, A);
    expect((await wdaDeviceOwnership('http://127.0.0.1:8100', {}, A, noRuntime)).owner).toBe('match');
    expect((await wdaDeviceOwnership('http://127.0.0.1:8100', {}, B, noRuntime)).owner).toBe('other');
    env.lsofTimeout = true;
    expect((await wdaDeviceOwnership('http://127.0.0.1:8100', {}, A, noRuntime)).owner).toBe('unverified');
    env.lsofTimeout = false;
    env.wda = new Map();
    expect((await wdaDeviceOwnership('http://127.0.0.1:8100', {}, A, noRuntime)).owner).toBe('unknown');
  });

  it('a different iOS version proves another device even when lsof cannot tell', async () => {
    env.lsofTimeout = true;
    const own = await wdaDeviceOwnership('http://127.0.0.1:8100', { os: { version: '17.5' } } as never, A, async () => 'iOS 18.2');
    expect(own.owner).toBe('other');
  });
});

describe('per-simulator WDA resolution', () => {
  it('resolveSimulatorWda keeps the given URL when it runs in this simulator', async () => {
    env.wda.set(8100, A);
    const r = await resolveSimulatorWda('http://127.0.0.1:8100', A, 500, noRuntime);
    expect(r.url).toBe('http://127.0.0.1:8100');
    expect(r.owner?.owner).toBe('match');
  });

  it("falls back to the simulator's own WDA on its per-simulator port when :8100 is down", async () => {
    const own = preferredWdaPort(A);
    env.wda.set(own, A);
    const r = await resolveSimulatorWda('http://127.0.0.1:8100', A, 500, noRuntime);
    expect(r.url).toBe(`http://127.0.0.1:${own}`);
    expect(r.status.ready).toBe(true);
    expect(r.owner?.owner).toBe('match');
  });

  it("a :8100 WDA of another simulator is replaced by this simulator's own one", async () => {
    env.wda.set(8100, B);
    env.wda.set(preferredWdaPort(A), A);
    const r = await resolveSimulatorWda('http://127.0.0.1:8100', A, 500, noRuntime);
    expect(r.url).toBe(`http://127.0.0.1:${preferredWdaPort(A)}`);
  });

  it('an unverified :8100 WDA is reported unverified (not usable) when no own WDA exists', async () => {
    env.wda.set(8100, B);
    env.lsofTimeout = true;
    const r = await resolveSimulatorWda('http://127.0.0.1:8100', A, 500, noRuntime);
    expect(r.url).toBe('http://127.0.0.1:8100');
    expect(r.owner?.owner).toBe('unverified');
  });

  it('findOwnSimulatorWda also probes registered endpoints, and only accepts a WDA inside this simulator', async () => {
    env.registered = [{ endpoint: 'http://127.0.0.1:8555/' }];
    env.wda.set(8555, A);
    expect((await findOwnSimulatorWda('http://127.0.0.1:8100', A, noRuntime))?.url).toBe('http://127.0.0.1:8555');
    env.wda.set(8555, B);
    expect(await findOwnSimulatorWda('http://127.0.0.1:8100', A, noRuntime)).toBeUndefined();
    // Remote WDA URLs are never re-pointed at a local port.
    expect(await findOwnSimulatorWda('http://10.0.0.5:8100', A, noRuntime)).toBeUndefined();
  });
});
