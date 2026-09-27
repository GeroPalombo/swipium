// H6 follow-ups at the tool layer (spawn mocked, no device):
//  (a) target planners accept property-verified emulators (localhost:5555) consistently.
//  (b) getDriver callers surface the typed refusal (PHYSICAL_DEVICE_UNSUPPORTED /
//      DEVICE_NOT_READY) via blockedDeviceResult instead of a generic "No device attached".

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-callers-home-'));
process.env.HOME = fakeHome;
delete process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY;

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const runMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return { ...actual, run: runMock };
});

const { createServer } = await import('../src/server.js');
const { verifiedEmulatorSerials } = await import('../src/session/attach.js');

let online: string[] = [];
let props: Record<string, string> = {};
const out = (stdout: string, code = 0): Promise<RunResult> => Promise.resolve({ code, stdout, stderr: '', timedOut: false });
function answer(cmd: string, args: string[]): Promise<RunResult> {
  if (cmd === 'which' || cmd === 'where') return args[0] === 'adb' ? out('/usr/local/bin/adb\n') : out('', 1);
  if (cmd !== 'adb') return out('', 1); // xcrun/emulator/etc: absent
  if (args[0] === 'devices') return out(`List of devices attached\n${online.map((s) => `${s}\tdevice`).join('\n')}\n`);
  if (args.includes('getprop')) {
    const p = props[args[1]];
    return p == null ? out('', 1) : out(p);
  }
  return out('');
}

const EMU = '[ro.kernel.qemu]: [1]\n[sys.boot_completed]: [1]\n';
const PHONE = '[ro.hardware]: [qcom]\n[sys.boot_completed]: [1]\n';

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, JSON.stringify(res.content)).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

describe('device policy at the tool layer', () => {
  let client: Client;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-callers-proj-'));
    const { server } = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'attach-callers-test', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  beforeEach(() => {
    runMock.mockReset();
    runMock.mockImplementation(answer);
    online = [];
    props = {};
  });

  it('verifiedEmulatorSerials probes only non-pattern serials', async () => {
    online = ['emulator-5554', 'localhost:5555', 'R5CN30XXXX'];
    props = { 'localhost:5555': EMU, R5CN30XXXX: PHONE };
    expect(await verifiedEmulatorSerials(online)).toEqual(['emulator-5554', 'localhost:5555']);
    const probed = runMock.mock.calls.filter((c) => (c[1] as string[]).includes('getprop')).map((c) => (c[1] as string[])[1]);
    expect(probed.sort()).toEqual(['R5CN30XXXX', 'localhost:5555']);
  });

  it('(a) qa_resolve_target selects a localhost:5555 emulator instead of refusing it as physical', async () => {
    online = ['localhost:5555'];
    props = { 'localhost:5555': EMU };
    const s = structured(
      (await client.callTool({ name: 'qa_resolve_target', arguments: { projectRoot, platform: 'android' } })) as CallToolResult,
    );
    expect(s.ok).toBe(true);
    expect(s.selected).toBe('android-emulator');
    expect(s.device).toBe('localhost:5555');
  });

  it('(a) a real phone is still refused by qa_resolve_target', async () => {
    online = ['R5CN30XXXX'];
    props = { R5CN30XXXX: PHONE };
    const s = structured(
      (await client.callTool({ name: 'qa_resolve_target', arguments: { projectRoot, platform: 'android' } })) as CallToolResult,
    );
    expect(s.failureCode).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
  });

  it('(b) snapshot / screenshot / clear_overlay / health surface the typed refusal, not "No device attached"', async () => {
    online = ['R5CN30XXXX'];
    props = { R5CN30XXXX: PHONE };
    const started = structured((await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult);
    const sessionId = started.sessionId as string;
    for (const name of ['qa_snapshot', 'qa_screenshot', 'qa_clear_overlay', 'qa_check_health']) {
      const s = structured((await client.callTool({ name, arguments: { sessionId } })) as CallToolResult);
      expect(s.ok, name).toBe(false);
      expect(s.failureCode, name).toBe('PHYSICAL_DEVICE_UNSUPPORTED');
      expect(String(s.what), name).toContain('R5CN30XXXX');
    }
  });

  it('(b) a still-booting emulator answers DEVICE_NOT_READY (retry-safe)', async () => {
    online = ['emulator-5554'];
    props = { 'emulator-5554': '[ro.kernel.qemu]: [1]\n[sys.boot_completed]: [0]\n' };
    const started = structured((await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult);
    const s = structured(
      (await client.callTool({
        name: 'qa_act',
        arguments: { sessionId: started.sessionId, action: 'press', key: 'back' },
      })) as CallToolResult,
    );
    expect(s.failureCode).toBe('DEVICE_NOT_READY');
    expect(s.retrySafe).toBe(true);
  });
});
