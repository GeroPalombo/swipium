// qa_doctor probes against MOCKED binary lookups (v1-mvp-plan P1 §6): every environment
// probe funnels through lib/spawn.run(), so mocking that one seam simulates a machine with
// adb/Xcode present or missing — the test passes identically on hosts with or without them.
// WDA reachability (a fetch, not a spawn) is stubbed to "unreachable" for hermeticity.

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const env = vi.hoisted(() => ({ binariesPresent: true }));

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const ok = (stdout: string, stderr = ''): RunResult => ({ code: 0, stdout, stderr, timedOut: false });
const fail = (code = 1): RunResult => ({ code, stdout: '', stderr: '', timedOut: false });

function fakeRun(cmd: string, args: string[]): Promise<RunResult> {
  const line = [cmd, ...args].join(' ');
  if (!env.binariesPresent) {
    // `which`/`where` lookups resolve empty; direct binary invocations fail like a missing binary.
    if (cmd === 'which' || cmd === 'where') return Promise.resolve(fail());
    return Promise.reject(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
  }
  if (cmd === 'which' || cmd === 'where') return Promise.resolve(ok(`/usr/local/bin/${args[0]}`));
  if (line === 'adb version') return Promise.resolve(ok('Android Debug Bridge version 1.0.41'));
  if (line === 'adb devices') return Promise.resolve(ok('List of devices attached\nemulator-5554\tdevice\n'));
  if (line.includes('shell df /data')) {
    return Promise.resolve(
      ok('Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-5  6082944 1000000   5082944  17% /data'),
    );
  }
  if (line === 'emulator -list-avds') return Promise.resolve(ok('Pixel_7_API_34\n'));
  if (line === 'java -version') return Promise.resolve(ok('', 'openjdk version "17.0.2" 2022-01-18'));
  if (line === 'xcodebuild -version') return Promise.resolve(ok('Xcode 15.4\nBuild version 15F31d'));
  if (line === 'xcrun simctl help') return Promise.resolve(ok('usage: simctl ...'));
  if (line.startsWith('xcrun simctl list')) {
    return Promise.resolve(
      ok(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [{ udid: 'FAKE-UDID-1', name: 'iPhone 15', state: 'Booted', isAvailable: true }],
          },
        }),
      ),
    );
  }
  return Promise.resolve(ok(''));
}

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return { ...actual, run: vi.fn((cmd: string, args: string[]) => fakeRun(cmd, args)) };
});

const { createServer } = await import('../src/server.js');

interface Check {
  name: string;
  ok: boolean;
  optional?: boolean;
  detail: string;
  fix?: string;
}

interface DoctorPayload {
  ok: boolean;
  ready: boolean;
  platformReady: { android: boolean | null; ios: boolean | null };
  checks: Check[];
  checksByPlatform: { android: Check[]; ios: Check[] };
  devicesOnline: string[];
  avds: string[];
}

describe('qa_doctor against mocked binaries', () => {
  let client: Client;
  const isDarwin = process.platform === 'darwin';

  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('network disabled in tests'))),
    );
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'doctor-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await client.close();
  });

  async function doctor(platform: 'android' | 'ios' | 'both'): Promise<DoctorPayload> {
    const res = (await client.callTool({ name: 'qa_doctor', arguments: { platform } })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    return res.structuredContent as unknown as DoctorPayload;
  }

  function check(payload: DoctorPayload, name: string): Check {
    const c = payload.checks.find((x) => x.name === name);
    expect(c, `expected a "${name}" check row`).toBeTruthy();
    return c!;
  }

  it('reports a ready Android environment when adb/emulator are present', async () => {
    env.binariesPresent = true;
    const p = await doctor('android');

    expect(p.ready).toBe(true);
    expect(p.platformReady.android).toBe(true);
    const adb = check(p, 'adb');
    expect(adb.ok).toBe(true);
    expect(adb.detail).toContain('Android Debug Bridge');
    expect(adb.fix).toBeUndefined();
    expect(check(p, 'device-online').ok).toBe(true);
    expect(p.devicesOnline).toEqual(['emulator-5554']);
    expect(p.avds).toEqual(['Pixel_7_API_34']);
    expect(check(p, 'android-target').ok).toBe(true);
  });

  it('fails the Android checks with actionable fix hints when adb/emulator are missing', async () => {
    env.binariesPresent = false;
    const p = await doctor('android');

    expect(p.ready).toBe(false);
    expect(p.platformReady.android).toBe(false);
    const adb = check(p, 'adb');
    expect(adb.ok).toBe(false);
    expect(adb.detail).toBe('not on PATH');
    expect(adb.fix).toContain('platform-tools');
    const target = check(p, 'android-target');
    expect(target.ok).toBe(false);
    expect(target.fix).toContain('Android Emulator');
    expect(p.devicesOnline).toEqual([]);
    // Every failed required check must carry a fix hint — that's the actionable contract.
    for (const c of p.checks.filter((x) => !x.ok && !x.optional)) {
      expect(c.fix, `check "${c.name}" is failing without a fix hint`).toBeTruthy();
    }
  });

  it('reports iOS prerequisites when xcodebuild/simctl are present (macOS probe)', async () => {
    env.binariesPresent = true;
    const p = await doctor('ios');

    const xcode = check(p, 'xcodebuild');
    const simctl = check(p, 'simctl');
    if (isDarwin) {
      expect(xcode.ok).toBe(true);
      expect(xcode.detail).toContain('Xcode 15.4');
      expect(simctl.ok).toBe(true);
      expect(check(p, 'ios-simulator').ok).toBe(true);
      expect(p.platformReady.ios).toBe(true);
    } else {
      // Off macOS the platform gate itself reports not-available — still with fix hints.
      expect(xcode.ok).toBe(false);
      expect(xcode.fix).toBeTruthy();
    }
    // WDA fetch is stubbed to unreachable; the check is optional and must not flip readiness.
    const wda = check(p, 'wda-server');
    expect(wda.ok).toBe(false);
    expect(wda.optional).toBe(true);
  });

  it('fails the iOS checks with fix hints when Xcode tooling is missing', async () => {
    env.binariesPresent = false;
    const p = await doctor('both');

    expect(p.ready).toBe(false);
    expect(p.platformReady.ios).toBe(false);
    const xcode = check(p, 'xcodebuild');
    expect(xcode.ok).toBe(false);
    expect(xcode.fix).toContain('Xcode');
    const simctl = check(p, 'simctl');
    expect(simctl.ok).toBe(false);
    expect(simctl.fix).toContain('Xcode');
    // Both platform groups are present in the structured payload for platform:"both".
    expect(p.checksByPlatform.android.length).toBeGreaterThan(0);
    expect(p.checksByPlatform.ios.length).toBeGreaterThan(0);
  });
});
