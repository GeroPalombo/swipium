// D6: adb/emulator resolve from $ANDROID_HOME / $ANDROID_SDK_ROOT and the OS-default SDK dir
// before PATH (GUI MCP clients don't inherit the shell PATH).

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { androidSdkCandidates, defaultAndroidSdkDir, ensureAndroidToolsOnPath, resolveAndroidTool } from '../src/lib/android.js';

const onlyExists =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe('Android SDK tool resolution', () => {
  it('uses the OS-specific default SDK dir', () => {
    expect(defaultAndroidSdkDir('darwin', '/Users/me', {})).toBe(join('/Users/me', 'Library', 'Android', 'sdk'));
    expect(defaultAndroidSdkDir('linux', '/home/me', {})).toBe(join('/home/me', 'Android', 'Sdk'));
    expect(defaultAndroidSdkDir('win32', '/home/me', { LOCALAPPDATA: '/lad' })).toBe(join('/lad', 'Android', 'Sdk'));
  });

  it('orders ANDROID_HOME, ANDROID_SDK_ROOT, then the default (deduplicated)', () => {
    expect(androidSdkCandidates({ ANDROID_HOME: '/h', ANDROID_SDK_ROOT: '/r' }, 'linux', '/home/me')).toEqual([
      '/h',
      '/r',
      join('/home/me', 'Android', 'Sdk'),
    ]);
    expect(androidSdkCandidates({ ANDROID_HOME: '/h', ANDROID_SDK_ROOT: '/h' }, 'linux', '/home/me')).toHaveLength(2);
  });

  it('resolves platform-tools/adb and emulator/emulator before PATH', () => {
    const env = { ANDROID_SDK_ROOT: '/sdk' };
    const exists = onlyExists('/sdk/platform-tools/adb', '/sdk/emulator/emulator');
    expect(resolveAndroidTool('adb', env, 'linux', '/home/me', exists)).toBe('/sdk/platform-tools/adb');
    expect(resolveAndroidTool('emulator', env, 'linux', '/home/me', exists)).toBe('/sdk/emulator/emulator');
  });

  it('falls back to the Linux default SDK when no env var is set, and to PATH when nothing exists', () => {
    const exists = onlyExists(join('/home/me', 'Android', 'Sdk', 'platform-tools', 'adb'));
    expect(resolveAndroidTool('adb', {}, 'linux', '/home/me', exists)).toBe(join('/home/me', 'Android', 'Sdk', 'platform-tools', 'adb'));
    expect(resolveAndroidTool('adb', {}, 'linux', '/home/me', () => false)).toBe('adb');
  });

  it('uses .exe names on Windows', () => {
    const exists = (p: string) => p.endsWith(join('platform-tools', 'adb.exe'));
    expect(resolveAndroidTool('adb', { ANDROID_HOME: '/sdk' }, 'win32', '/home/me', exists)).toMatch(/adb\.exe$/);
  });

  it('appends SDK tool dirs to PATH once (idempotent) and leaves PATH alone when nothing is found', () => {
    const env: NodeJS.ProcessEnv = { ANDROID_HOME: '/sdk', PATH: '/usr/bin:/bin' };
    const exists = onlyExists('/sdk/platform-tools/adb', '/sdk/emulator/emulator');
    expect(ensureAndroidToolsOnPath(env, 'linux', '/home/me', exists)).toEqual(['/sdk/platform-tools', '/sdk/emulator']);
    expect(env.PATH).toBe('/usr/bin:/bin:/sdk/platform-tools:/sdk/emulator');
    expect(ensureAndroidToolsOnPath(env, 'linux', '/home/me', exists)).toEqual([]);
    expect(env.PATH).toBe('/usr/bin:/bin:/sdk/platform-tools:/sdk/emulator');

    const bare: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    expect(ensureAndroidToolsOnPath(bare, 'linux', '/home/me', () => false)).toEqual([]);
    expect(bare.PATH).toBe('/usr/bin');
  });

  it("never shadows the user's own adb/emulator already on PATH", () => {
    const env: NodeJS.ProcessEnv = { ANDROID_HOME: '/sdk', PATH: '/opt/homebrew/bin:/usr/bin' };
    const exists = onlyExists('/opt/homebrew/bin/adb', '/sdk/platform-tools/adb', '/sdk/emulator/emulator');
    // adb resolvable on PATH → only the emulator dir is added, and appended.
    expect(ensureAndroidToolsOnPath(env, 'linux', '/home/me', exists)).toEqual(['/sdk/emulator']);
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/sdk/emulator');

    const both: NodeJS.ProcessEnv = { ANDROID_HOME: '/sdk', PATH: '/a:/b' };
    const existsBoth = onlyExists('/a/adb', '/b/emulator', '/sdk/platform-tools/adb', '/sdk/emulator/emulator');
    expect(ensureAndroidToolsOnPath(both, 'linux', '/home/me', existsBoth)).toEqual([]);
    expect(both.PATH).toBe('/a:/b');
  });
});
