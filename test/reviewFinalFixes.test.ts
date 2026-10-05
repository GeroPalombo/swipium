// Final review round: qa_orientation drops the DirectDriver screen-size cache after rotating, and
// qa_get_artifact / qa_screenshot surface a PARTIAL redaction (short secrets left unscrubbed).

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-final-fixes-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../src/drivers/DirectDriver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/drivers/DirectDriver.js')>();
  return { ...actual, invalidateScreenSizeCache: invalidate };
});
vi.mock('../src/lib/device.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/device.js')>();
  return {
    ...actual,
    setOrientation: vi.fn(async () => {}),
    getOrientation: vi.fn(async () => ({ rotation: 1, auto: false })),
  };
});

const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
type Driver = import('../src/drivers/Driver.js').Driver;

/** Only what qa_orientation touches; everything else is an inert async no-op. */
function fakeDirectDriver(): Driver {
  const base: Record<string, unknown> = { kind: 'direct', currentDevice: () => 'emulator-5554', useDevice: () => {} };
  return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : async () => undefined) }) as unknown as Driver;
}

describe('final review fixes', () => {
  let client: Client;
  let projectRoot: string;
  let sessions: ReturnType<typeof createServer>['sessions'];

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-final-fixes-project-'));
    setDriverFactoryForTests(() => fakeDirectDriver());
    const created = createServer();
    sessions = created.sessions;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'final-fixes-test', version: '0' });
    await Promise.all([created.server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const start = async () =>
    (
      (await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult & {
        structuredContent: { sessionId: string };
      }
    ).structuredContent.sessionId;

  it('qa_orientation invalidates the screen-size cache for that device after rotating', async () => {
    const sessionId = await start();
    invalidate.mockClear();
    const res = (await client.callTool({ name: 'qa_orientation', arguments: { sessionId, orientation: 'landscape' } })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(invalidate).toHaveBeenCalledWith('emulator-5554');
  });

  it('qa_get_artifact surfaces redaction:"partial" and its note (metadata and inline)', async () => {
    const sessionId = await start();
    const session = sessions.get(sessionId)!;
    session.secrets.add('ab'); // too short to scrub safely → partial
    const uri = sessions.saveArtifact(session, 'log', 'notes.txt', 'user ab logged in', 'text/plain');
    const meta = (await client.callTool({ name: 'qa_get_artifact', arguments: { uri, mode: 'metadata' } })) as CallToolResult;
    const sc = meta.structuredContent as Record<string, unknown>;
    expect(sc.redaction).toBe('partial');
    expect(String(sc.redactionNote)).toMatch(/shorter than 3 characters/);
    expect((meta.content as Array<{ text: string }>)[0].text).toContain('redaction partial');

    const inline = (await client.callTool({ name: 'qa_get_artifact', arguments: { uri, mode: 'inline' } })) as CallToolResult;
    const blocks = inline.content as Array<{ type: string; text: string }>;
    expect(blocks[0].text).toBe('user ab logged in');
    expect(blocks[1].text).toMatch(/redaction partial/);
  });
});
