// D1: opt-in persistent Android dumper (SWIPIUM_ANDROID_DUMPER=agent). The adb seam (lib/spawn.run)
// is mocked; a local TCP server stands in for the forwarded on-device agent.

import { readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const res = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const runMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return { ...actual, run: runMock };
});

const dumper = await import('../src/drivers/androidDumper.js');
const { DirectDriver } = await import('../src/drivers/DirectDriver.js');
const { parseSnapshot } = await import('../src/snapshot/parse.js');

// Real agent output from emulator-5554 (API 36) on the Settings home screen. It was
// byte-identical to `adb exec-out uiautomator dump /dev/tty` on the same screen.
const AGENT_XML = readFileSync(new URL('./fixtures/android-agent-settings.xml', import.meta.url), 'utf8');
const EXEC_OUT_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="exec" resource-id="" class="android.widget.TextView" package="p" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" /></hierarchy>`;

let server: net.Server | undefined;
let requests: string[] = [];
async function fakeAgent(answer: (line: string) => string): Promise<number> {
  requests = [];
  server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      requests.push(line);
      sock.end(answer(line));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return (server!.address() as net.AddressInfo).port;
}

beforeEach(() => {
  runMock.mockReset();
  process.env.SWIPIUM_ANDROID_DUMPER = 'agent';
});
afterEach(async () => {
  delete process.env.SWIPIUM_ANDROID_DUMPER;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('android dumper helpers', () => {
  it('is opt-in by env only', () => {
    expect(dumper.androidDumperEnabled({})).toBe(false);
    expect(dumper.androidDumperEnabled({ SWIPIUM_ANDROID_DUMPER: 'exec-out' })).toBe(false);
    expect(dumper.androidDumperEnabled({ SWIPIUM_ANDROID_DUMPER: 'Agent' })).toBe(true);
  });

  it('ships the prebuilt dex jar where agentJarPath points', () => {
    expect(existsSync(dumper.agentJarPath())).toBe(true);
  });

  it('validates responses', () => {
    expect(dumper.parseAgentResponse(AGENT_XML)).toBe(AGENT_XML);
    expect(() => dumper.parseAgentResponse('ERR java.lang.IllegalStateException: null root node\n')).toThrow(/null root/);
    expect(() => dumper.parseAgentResponse('<?xml version="1.0"?><hierarchy rotation="0">')).toThrow(/incomplete/);
  });

  it('agent XML parses with the snapshot parser like a uiautomator dump', () => {
    const p = parseSnapshot(AGENT_XML);
    expect(p.total).toBeGreaterThan(20);
    expect(p.screen).toEqual([1080, 2400]);
    expect(p.elements.some((e) => /Battery/.test(JSON.stringify(e)))).toBe(true);
  });
});

describe('DirectDriver.dumpXml with SWIPIUM_ANDROID_DUMPER=agent', () => {
  it('serves the dump from a running agent (reused after PING)', async () => {
    const port = await fakeAgent((l) => (l === 'PING' ? 'PONG\n' : l.startsWith('DUMP') ? AGENT_XML : 'ERR\n'));
    runMock.mockImplementation((_c: string, args: string[]) => Promise.resolve(res(args.includes('forward') ? `${port}\n` : '')));
    const d = new DirectDriver('emulator-agent-ok');
    expect(await d.dumpXml()).toBe(AGENT_XML);
    expect(requests).toEqual(['PING', 'DUMP 250 2000']);
    // No uiautomator / exec-out call was made.
    expect(runMock.mock.calls.some(([, a]) => (a as string[]).includes('exec-out'))).toBe(false);
  });

  it('falls back to exec-out on agent failure, stops the agent, then cools down', async () => {
    const port = await fakeAgent((l) =>
      l === 'PING' ? 'PONG\n' : l === 'QUIT' ? 'BYE\n' : 'ERR java.lang.IllegalStateException: null root node\n',
    );
    runMock.mockImplementation((_c: string, args: string[]) => {
      if (args.includes('forward') && !args.includes('--remove')) return Promise.resolve(res(`${port}\n`));
      if (args.includes('exec-out')) return Promise.resolve(res(EXEC_OUT_XML));
      return Promise.resolve(res(''));
    });
    const d = new DirectDriver('emulator-agent-bad');
    expect(await d.dumpXml()).toBe(EXEC_OUT_XML);
    expect(requests).toEqual(['PING', 'DUMP 250 2000', 'QUIT']);
    const calls = runMock.mock.calls.map(([, a]) => (a as string[]).join(' '));
    expect(calls.some((c) => c.includes('forward --remove'))).toBe(true);
    expect(calls.some((c) => c.includes('rm -f /data/local/tmp/swipium-dumper.jar'))).toBe(true);
    // Cooldown: the next dump goes straight to exec-out.
    requests = [];
    expect(await d.dumpXml()).toBe(EXEC_OUT_XML);
    expect(requests).toEqual([]);
  });

  it('falls back when the agent cannot be started (push fails)', async () => {
    runMock.mockImplementation((_c: string, args: string[]) => {
      if (args.includes('forward') && !args.includes('--remove')) return Promise.resolve(res('1\n')); // nothing listens
      if (args.includes('push')) return Promise.reject(new Error('adb: error: failed to copy'));
      if (args.includes('exec-out')) return Promise.resolve(res(EXEC_OUT_XML));
      return Promise.resolve(res(''));
    });
    expect(await new DirectDriver('emulator-agent-nopush').dumpXml()).toBe(EXEC_OUT_XML);
    // The failed start removes the forward it created (no leaked `adb forward` entries).
    const calls = runMock.mock.calls.map(([, a]) => (a as string[]).join(' '));
    expect(calls).toContain('-s emulator-agent-nopush forward --remove tcp:1');
  });

  it('never touches the agent when the env is unset', async () => {
    delete process.env.SWIPIUM_ANDROID_DUMPER;
    runMock.mockImplementation(() => Promise.resolve(res(EXEC_OUT_XML)));
    expect(await new DirectDriver('emulator-agent-off').dumpXml()).toBe(EXEC_OUT_XML);
    expect(runMock.mock.calls.map(([, a]) => (a as string[]).join(' '))).toEqual([
      '-s emulator-agent-off exec-out uiautomator dump /dev/tty',
    ]);
  });
});

describe('shutdownAndroidDumpers (server exit)', () => {
  it("removes this process's forwards, leaves another process's jar, and never blocks past the budget", async () => {
    const port = await fakeAgent((l) => (l === 'PING' ? 'PONG\n' : l.startsWith('DUMP') ? AGENT_XML : 'BYE\n'));
    runMock.mockImplementation((_c: string, args: string[]) => Promise.resolve(res(args.includes('forward') ? `${port}\n` : '')));
    expect(await new DirectDriver('emulator-agent-exit').dumpXml()).toBe(AGENT_XML);
    runMock.mockClear();
    await dumper.shutdownAndroidDumpers();
    const calls = runMock.mock.calls.map(([, a]) => (a as string[]).join(' '));
    expect(calls).toContain(`-s emulator-agent-exit forward --remove tcp:${port}`);
    // The agent was reused (an earlier process pushed the jar): its jar is not ours to delete.
    expect(calls.some((c) => c.startsWith('-s emulator-agent-exit') && c.includes('rm -f'))).toBe(false);
    // Nothing left: a second shutdown makes no adb calls.
    runMock.mockClear();
    await dumper.shutdownAndroidDumpers();
    expect(runMock.mock.calls.filter(([, a]) => (a as string[]).includes('emulator-agent-exit'))).toEqual([]);

    // A hung adb (device gone) does not hold up the exit beyond the budget.
    runMock.mockImplementation((_c: string, args: string[]) => Promise.resolve(res(args.includes('forward') ? `${port}\n` : '')));
    expect(await new DirectDriver('emulator-agent-hang').dumpXml()).toBe(AGENT_XML);
    runMock.mockImplementation(() => new Promise(() => undefined));
    const t0 = Date.now();
    await dumper.shutdownAndroidDumpers(300);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
