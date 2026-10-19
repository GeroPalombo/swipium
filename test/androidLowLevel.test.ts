// Low-level Android and process helpers, with child_process faked (no emulator, adb or ps runs):
//  - bootEmulator survives a spawn 'error' (missing `emulator`) and reports it via emulatorFailure
//  - build-tools versions sort numerically when picking aapt2; badging is read once per APK version
//  - synchronous ps / lsof probes carry a kill timeout, and a timed-out probe reads as unknown

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({
  spawned: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown>; child: unknown }>,
  syncCalls: [] as Array<{ cmd: string; opts: Record<string, unknown> }>,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: EE } = await import('node:events');
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
      const child = Object.assign(new EE(), { pid: undefined, unref: () => {}, kill: () => true });
      cp.spawned.push({ cmd, args, opts, child });
      return child;
    }),
    spawnSync: vi.fn((cmd: string, _args: string[], opts: Record<string, unknown>) => {
      cp.syncCalls.push({ cmd, opts });
      const error = Object.assign(new Error(`spawnSync ${cmd} ETIMEDOUT`), { code: 'ETIMEDOUT' });
      return { status: null, signal: 'SIGKILL', stdout: '1234 partial', stderr: '', error, pid: 0, output: [] };
    }),
  };
});
const runMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawn.js')>()),
  run: runMock,
}));

const android = await import('../src/lib/android.js');
const registry = await import('../src/session/processRegistry.js');

const saved = { ...process.env };
beforeEach(() => {
  cp.spawned.length = 0;
  cp.syncCalls.length = 0;
  runMock.mockReset();
});
afterEach(() => {
  process.env.ANDROID_HOME = saved.ANDROID_HOME;
  if (saved.ANDROID_HOME === undefined) delete process.env.ANDROID_HOME;
  delete process.env.SWIPIUM_TEST_PASSWORD;
});

describe('bootEmulator', () => {
  it('a spawn error (no emulator binary) is recorded, not thrown as an uncaught error', () => {
    const child = android.bootEmulator('Pixel_8') as unknown as EventEmitter;
    expect(android.emulatorFailure(child as never)).toBeUndefined();
    expect(() => child.emit('error', Object.assign(new Error('spawn emulator ENOENT'), { code: 'ENOENT' }))).not.toThrow();
    expect(android.emulatorFailure(child as never)).toMatch(/could not start the Android emulator: spawn emulator ENOENT/);
  });

  it('an early non-zero exit is a failure; a kill on cancel is not', () => {
    const bad = android.bootEmulator('Missing_AVD') as unknown as EventEmitter;
    bad.emit('exit', 1, null);
    expect(android.emulatorFailure(bad as never)).toMatch(/exited with code 1/);
    const cancelled = android.bootEmulator('Pixel_8') as unknown as EventEmitter;
    cancelled.emit('exit', null, 'SIGKILL');
    expect(android.emulatorFailure(cancelled as never)).toBeUndefined();
    expect(android.emulatorFailure(undefined)).toBeUndefined();
  });

  it('spawns without the test credentials in its environment', () => {
    process.env.SWIPIUM_TEST_PASSWORD = 'hunter2';
    android.bootEmulator('Pixel_8');
    const env = cp.spawned.at(-1)!.opts.env as NodeJS.ProcessEnv;
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.SWIPIUM_TEST_PASSWORD).toBeUndefined();
  });
});

describe('aapt2 lookup', () => {
  it('sorts build-tools versions numerically, release above its release candidate', () => {
    expect(android.sortBuildToolsVersions(['9.0.0', '34.0.0', '30.0.3', '35.0.0-rc1', '35.0.0', '4.4W'])).toEqual([
      '35.0.0',
      '35.0.0-rc1',
      '34.0.0',
      '30.0.3',
      '9.0.0',
      '4.4W',
    ]);
  });

  it('findAapt2 picks the numerically newest build-tools, and badging runs once per unchanged APK', async () => {
    const sdk = mkdtempSync(join(tmpdir(), 'swipium-sdk-'));
    for (const v of ['9.0.0', '34.0.0']) {
      mkdirSync(join(sdk, 'build-tools', v), { recursive: true });
      writeFileSync(join(sdk, 'build-tools', v, 'aapt2'), '');
    }
    process.env.ANDROID_HOME = sdk;
    expect(android.findAapt2()).toBe(join(sdk, 'build-tools', '34.0.0', 'aapt2'));

    const apk = join(sdk, 'app.apk');
    writeFileSync(apk, 'v1');
    runMock.mockResolvedValue({
      code: 0,
      stdout: "package: name='com.acme.app' versionCode='3'\nsdkVersion:'24'\nnative-code: 'arm64-v8a'\n",
      stderr: '',
      timedOut: false,
    });
    expect(await android.apkPackageId(apk)).toBe('com.acme.app');
    expect(await android.apkMinSdk(apk)).toBe(24);
    expect(await android.apkNativeAbis(apk)).toEqual(['arm64-v8a']);
    expect(runMock).toHaveBeenCalledTimes(1);
    // A rebuilt APK (new size / mtime) is read again.
    writeFileSync(apk, 'v2-longer');
    utimesSync(apk, new Date(), new Date(Date.now() + 5000));
    await android.apkBadging(apk);
    expect(runMock).toHaveBeenCalledTimes(2);
  });
});

describe('process registry probes', () => {
  it('every ps / lsof probe has a kill timeout, and a timed-out probe is unknown', () => {
    const fp = registry.captureFingerprint(4242);
    expect(fp).toEqual({ groupLeader: false });
    const found = registry.findManagedWdaProcesses({ projectPath: '/p/WebDriverAgent.xcodeproj', udid: 'SIM-1', port: 8100 });
    expect(found).toEqual([]);
    expect(cp.syncCalls.map((c) => c.cmd)).toEqual(expect.arrayContaining(['ps', 'lsof']));
    for (const c of cp.syncCalls) {
      expect(c.opts.timeout).toBeGreaterThanOrEqual(3000);
      expect(c.opts.timeout).toBeLessThanOrEqual(5000);
      expect(c.opts.killSignal).toBe('SIGKILL');
    }
  });
});
