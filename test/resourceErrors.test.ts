// F5 + I6: resources/read errors and size caps.
//  - an unknown artifact / app-map URI is a typed -32002 (resource not found, MCP spec
//    2025-11-25), not the SDK's generic -32603 for a plain Error;
//  - artifact reads are size-capped: big text returns head (or tail, for logs) + a marker, big
//    binaries are not inlined, non-text non-image files (recordings) go out as a blob.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-resource-errors-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer, RESOURCE_NOT_FOUND } = await import('../src/server.js');
const { readArtifactResource, chooseMode, RESOURCE_TEXT_MAX_BYTES } = await import('../src/tools/getArtifact.js');
type SessionStore = import('../src/session/store.js').SessionStore;

let client: Client;
let sessions: SessionStore;
let projectRoot: string;
let scratch: string;
beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'swipium-resource-errors-project-'));
  scratch = mkdtempSync(join(tmpdir(), 'swipium-resource-errors-files-'));
  const ctx = createServer();
  sessions = ctx.sessions;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'resource-errors-test', version: '0' });
  await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
});
afterAll(async () => {
  await client.close();
  for (const d of [fakeHome, projectRoot, scratch]) rmSync(d, { recursive: true, force: true });
});

async function readError(uri: string): Promise<McpError> {
  try {
    await client.readResource({ uri });
  } catch (e) {
    return e as McpError;
  }
  throw new Error(`expected resources/read of ${uri} to fail`);
}

describe('resources/read not found > -32002', () => {
  it('unknown artifact', async () => {
    const s = sessions.create(projectRoot);
    const e = await readError(`swipium://session/${s.id}/screenshot/nope.png`);
    expect(RESOURCE_NOT_FOUND).toBe(-32002);
    expect(e.code).toBe(-32002);
    expect(e.message).toMatch(/Resource not found: swipium:\/\/session\/.*nope\.png: unknown artifact/);
  });

  it('unknown project for the app-map templates', async () => {
    const section = await readError('swipium://project/deadbeef/app-map/features/login');
    expect(section.code).toBe(-32002);
    expect(section.message).toMatch(/unknown project deadbeef/);
    const full = await readError('swipium://project/deadbeef/app-map');
    expect(full.code).toBe(-32002);
  });

  it('a small artifact still reads normally (image as blob, text as text)', async () => {
    const s = sessions.create(projectRoot);
    const png = sessions.saveArtifact(s, 'screenshot', 'a.png', Buffer.from('fake-png'), 'image/png');
    const log = sessions.saveArtifact(s, 'log', 'a.log', 'hello', 'text/plain');
    const r1 = await client.readResource({ uri: png });
    expect(r1.contents[0]).toMatchObject({ mimeType: 'image/png', blob: Buffer.from('fake-png').toString('base64') });
    const r2 = await client.readResource({ uri: log });
    expect(r2.contents[0]).toMatchObject({ mimeType: 'text/plain', text: 'hello' });
  });
});

describe('readArtifactResource size caps', () => {
  const file = (name: string, data: string | Buffer) => {
    const p = join(scratch, name);
    writeFileSync(p, data);
    return p;
  };

  it('text over the cap keeps the head with a trailing marker', () => {
    const path = file('report.json', 'A'.repeat(50) + 'B'.repeat(50));
    const r = readArtifactResource('swipium://x/report/r.json', { path, mime: 'application/json', kind: 'report' }, { textMax: 50 });
    const text = String((r.contents[0] as { text: string }).text);
    expect(text.startsWith('A'.repeat(50))).toBe(true);
    expect(text).not.toContain('B');
    expect(text).toMatch(/truncated, showing the first 50 of 100 bytes/);
    // The marker used to promise "qa_get_artifact returns the full text"; it applies the same cap.
    expect(text).not.toMatch(/full text/);
    expect(text).toMatch(/qa_get_artifact apply the same cap\). Read the local file for the rest: /);
  });

  it('*.log files keep the tail even when their kind is not a log kind (metro / wda logs)', () => {
    const path = file('metro-1.log', 'A'.repeat(50) + 'B'.repeat(50));
    const r = readArtifactResource('swipium://x/metro/metro-1.log', { path, mime: 'text/plain', kind: 'metro' }, { textMax: 50 });
    const text = String((r.contents[0] as { text: string }).text);
    expect(text).toMatch(/^\[swipium: truncated, showing the last 50/);
    expect(text.endsWith('B'.repeat(50))).toBe(true);
  });

  it('a cut never splits a UTF-8 multibyte character (head and tail)', () => {
    // 'é' is 2 bytes (0xC3 0xA9): 49 ASCII + é puts the head cut at 50 inside the character.
    const content = 'A'.repeat(49) + 'é'.repeat(30);
    const head = file('utf8.json', content);
    const h = String(
      (
        readArtifactResource('swipium://x/r/u.json', { path: head, mime: 'application/json', kind: 'report' }, { textMax: 50 })
          .contents[0] as {
          text: string;
        }
      ).text,
    );
    expect(h).not.toContain('\uFFFD');
    expect(h.startsWith('A'.repeat(49) + '\n[swipium')).toBe(true);
    // Tail: 59 bytes of 'é' (odd) starts on a continuation byte.
    const tail = file('utf8.log', 'A'.repeat(10) + 'é'.repeat(40));
    const t = String(
      (
        readArtifactResource('swipium://x/log/u.log', { path: tail, mime: 'text/plain', kind: 'log' }, { textMax: 59 }).contents[0] as {
          text: string;
        }
      ).text,
    );
    expect(t).not.toContain('\uFFFD');
    expect(t.endsWith('é'.repeat(29))).toBe(true);
  });

  it('logs keep the tail with a leading marker', () => {
    const path = file('device.log', 'A'.repeat(50) + 'B'.repeat(50));
    const r = readArtifactResource('swipium://x/log/d.log', { path, mime: 'text/plain', kind: 'log' }, { textMax: 50 });
    const text = String((r.contents[0] as { text: string }).text);
    expect(text).toMatch(/^\[swipium: truncated, showing the last 50 of 100 bytes/);
    expect(text.endsWith('B'.repeat(50))).toBe(true);
    // The marker names a random temp path, so only check the content after it.
    expect(text.slice(text.indexOf(']') + 1)).not.toContain('A');
  });

  it('binary over the cap is not inlined; under the cap it is a blob (recordings too)', () => {
    const big = file('big.png', Buffer.alloc(200));
    const r = readArtifactResource(
      'swipium://x/screenshot/big.png',
      { path: big, mime: 'image/png', kind: 'screenshot' },
      { binaryMax: 100 },
    );
    expect(r.contents[0]).toMatchObject({ mimeType: 'text/plain' });
    expect(String((r.contents[0] as { text: string }).text)).toMatch(/200 bytes, over the 100-byte resources\/read cap/);
    const mp4 = file('rec.mp4', Buffer.from([0, 1, 2, 255]));
    const v = readArtifactResource('swipium://x/recording/rec.mp4', { path: mp4, mime: 'video/mp4', kind: 'recording' });
    expect(v.contents[0]).toMatchObject({ mimeType: 'video/mp4', blob: Buffer.from([0, 1, 2, 255]).toString('base64') });
  });
});

describe('qa_get_artifact caps and modes', () => {
  const text = (r: { content?: unknown }) =>
    ((r.content as Array<{ type: string; text?: string }>) ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');

  it('non-text, non-image mimes default to metadata; inline is a blob resource, never UTF-8 text', async () => {
    expect(chooseMode('video/mp4')).toBe('metadata');
    expect(chooseMode('application/zip')).toBe('metadata');
    expect(chooseMode('image/png')).toBe('metadata');
    expect(chooseMode('text/plain')).toBe('inline');
    expect(chooseMode('application/json')).toBe('inline');
    const s = sessions.create(projectRoot);
    const bytes = Buffer.from([0, 1, 2, 0xff, 0xfe]);
    const uri = sessions.saveArtifact(s, 'recording', 'rec.mp4', bytes, 'video/mp4');
    const meta = await client.callTool({ name: 'qa_get_artifact', arguments: { uri } });
    expect(meta.structuredContent).toMatchObject({ mime: 'video/mp4', bytes: 5 });
    const inline = await client.callTool({ name: 'qa_get_artifact', arguments: { uri, mode: 'inline' } });
    expect((inline.content as unknown[])[0]).toMatchObject({
      type: 'resource',
      resource: { uri, mimeType: 'video/mp4', blob: bytes.toString('base64') },
    });
  });

  it('text over the cap returns the head (tail for logs) with a marker, not the whole file', async () => {
    const s = sessions.create(projectRoot);
    const big = 'A'.repeat(RESOURCE_TEXT_MAX_BYTES) + 'B'.repeat(100_000);
    const report = sessions.saveArtifact(s, 'report', 'big.json', big, 'application/json');
    const r = text(await client.callTool({ name: 'qa_get_artifact', arguments: { uri: report } }));
    expect(r.length).toBeLessThan(RESOURCE_TEXT_MAX_BYTES + 1000);
    expect(r).not.toContain('B');
    expect(r).toMatch(/truncated, showing the first \d+ of \d+ bytes \(qa_get_artifact cap/);
    const log = sessions.saveArtifact(s, 'wda', 'wda-start.log', big, 'text/plain');
    const l = text(await client.callTool({ name: 'qa_get_artifact', arguments: { uri: log } }));
    expect(l).toMatch(/^\[swipium: truncated, showing the last/);
    expect(l.endsWith('B'.repeat(100_000))).toBe(true);
  });
});
