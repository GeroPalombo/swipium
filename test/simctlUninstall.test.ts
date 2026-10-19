// simctl helpers, xcrun faked through lib/spawn.run:
//  - uninstallApp fails loudly, except when the app simply was not installed
//  - screenshot writes into a private mkdtemp dir, removed afterwards

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawn.js')>()),
  run: runMock,
}));
const sim = await import('../src/lib/simctl.js');

const result = (code: number, stderr = '', timedOut = false) => ({ code, stdout: '', stderr, timedOut });
beforeEach(() => runMock.mockReset());

describe('simctl uninstallApp', () => {
  it('resolves on success and when the app was not installed', async () => {
    runMock.mockResolvedValueOnce(result(0));
    await expect(sim.uninstallApp('SIM-1', 'com.acme.app')).resolves.toBeUndefined();
    runMock.mockResolvedValueOnce(result(1, 'An error was encountered processing the command: The app com.acme.app is not installed.'));
    await expect(sim.uninstallApp('SIM-1', 'com.acme.app')).resolves.toBeUndefined();
  });

  it('throws on any other failure, including a timeout', async () => {
    runMock.mockResolvedValueOnce(result(149, 'Unable to lookup in current state: Shutdown'));
    await expect(sim.uninstallApp('SIM-1', 'com.acme.app')).rejects.toThrow(
      /simctl uninstall SIM-1 com\.acme\.app.*failed: Unable to lookup in current state: Shutdown/,
    );
    runMock.mockResolvedValueOnce(result(null as never, '', true));
    await expect(sim.uninstallApp('SIM-1', 'com.acme.app')).rejects.toThrow(/\(timed out\)/);
  });
});

describe('simctl screenshot', () => {
  it('writes into a fresh private temp dir and removes it', async () => {
    let shotPath = '';
    runMock.mockImplementationOnce(async (_cmd: string, args: string[]) => {
      shotPath = args.at(-1)!;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(shotPath, Buffer.from('png'));
      return result(0);
    });
    expect((await sim.screenshot('SIM-1')).toString()).toBe('png');
    expect(dirname(dirname(shotPath))).toBe(tmpdir());
    expect(dirname(shotPath)).toMatch(/swipium-ios-shot-[A-Za-z0-9]{6}$/);
    expect(shotPath).not.toContain('SIM-1');
    expect(existsSync(dirname(shotPath))).toBe(false);
  });
});
