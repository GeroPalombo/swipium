// qa_visual find_text hardening (real local providers, no mocks of the provider seam):
//  - the consent discloses BOTH commands — a repo-configured visualMaskCommand used to run hidden
//    behind a harmless-looking ocrCommand — with argv + "configured by the repository" provenance;
//  - provider images live in a private per-call mkdtemp (0700) dir that is removed afterwards;
//  - the OCR "password/OTP screen" refusal carries failureCode CAPTURE_WITHHELD_SECURE.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-visualsec-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
delete process.env.SWIPIUM_OCR_CMD;
delete process.env.SWIPIUM_VISUAL_MASK_CMD;

const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
type Driver = import('../src/drivers/Driver.js').Driver;

function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 4), 40);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 4)] = 0;
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Minimal driver: explicit methods + async no-ops for everything else (never thenable).
const base: Record<string, unknown> = {
  kind: 'direct',
  screenshot: async () => png(32, 32),
  dumpXml: async () => {
    throw new Error('no UI tree');
  },
  screenSize: async () => ({ width: 32, height: 32 }),
  screenDensity: async () => null,
  listDevices: async () => ['emu-1'],
  currentDevice: () => 'emu-1',
  useDevice: () => undefined,
};
const driver = new Proxy(base, {
  get: (t, p) => (p in t ? t[p as string] : p === 'then' ? undefined : async () => undefined),
}) as unknown as Driver;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-visualsec-project-')));
mkdirSync(join(root, '.swipium'), { recursive: true });
writeFileSync(join(root, 'package.json'), '{"name":"visualsec"}');
writeFileSync(
  join(root, '.swipium', 'mask.js'),
  `const fs=require('fs'),path=require('path');const [img,out]=process.argv.slice(2);
fs.copyFileSync(img,out);
fs.writeFileSync(path.join(process.cwd(),'mask-record.json'),JSON.stringify({img,out,dirMode:fs.statSync(path.dirname(out)).mode&0o777,imgDirMode:fs.statSync(path.dirname(img)).mode&0o777}));
console.log(JSON.stringify({masksApplied:['status_bar']}));`,
);
writeFileSync(
  join(root, '.swipium', 'ocr.js'),
  `const fs=require('fs');const t=fs.readFileSync('ocr-text.txt','utf8');
fs.writeFileSync('ocr-record.json',JSON.stringify({img:process.argv[2]}));
console.log(JSON.stringify([{text:t,confidence:0.99,bbox:{x:1,y:1,width:10,height:5}}]));`,
);
writeFileSync(
  join(root, '.swipium', 'config.json'),
  JSON.stringify({
    ocrCommand: ['node', '.swipium/ocr.js', '{image}'],
    visualMaskCommand: ['node', '.swipium/mask.js', '{image}', '{output}'],
  }),
);

describe('qa_visual find_text: mask consent, temp dirs, withheld code', () => {
  let client: Client;
  beforeAll(async () => {
    setDriverFactoryForTests(() => driver);
    const ctx = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'visualsec', version: '0' });
    await Promise.all([ctx.server.connect(s), client.connect(c)]);
  });
  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    await client.close();
    for (const d of [fakeHome, root]) rmSync(d, { recursive: true, force: true });
  });

  const sc = (r: unknown) => (r as CallToolResult).structuredContent as Record<string, unknown>;
  const visual = async (sessionId: string, args: Record<string, unknown>) =>
    sc(await client.callTool({ name: 'qa_visual', arguments: { sessionId, mode: 'find_text', ...args } }));

  it('discloses the mask command (argv + repo provenance) in exactCommand and affects', async () => {
    writeFileSync(join(root, 'ocr-text.txt'), 'Log in');
    const sessionId = sc(await client.callTool({ name: 'qa_start_session', arguments: { projectRoot: root } })).sessionId as string;
    const env = await visual(sessionId, { query: 'Log in' });
    expect(env.requiresConsent).toBe(true);
    const cmd = String(env.exactCommand);
    expect(cmd).toContain('.swipium/mask.js');
    expect(cmd).toContain('.swipium/ocr.js');
    expect(cmd).toContain('configured by the repository (.swipium/config.json) — unreviewed');
    const affects = env.affects as Record<string, unknown>;
    expect(affects.maskArgv).toEqual(['node', '.swipium/mask.js', '<screenshot>', '<masked-screenshot>']);
    expect(String(affects.maskCommandSource)).toMatch(/repository/);

    const res = await visual(sessionId, { query: 'Log in', consentId: env.consentId, approve: true });
    expect(res.found).toBe(true);
    const mask = JSON.parse(readFileSync(join(root, 'mask-record.json'), 'utf8')) as Record<string, unknown>;
    expect(mask.dirMode).toBe(0o700);
    expect(mask.imgDirMode).toBe(0o700);
    expect(String(mask.out)).not.toMatch(/swipium-masked-\d+\.png$/);
    // both private dirs are gone after the call
    expect(existsSync(String(mask.out))).toBe(false);
    expect(existsSync(join(String(mask.out), '..'))).toBe(false);
    expect(existsSync(join(String(mask.img), '..'))).toBe(false);
  });

  it('OCR password-screen refusal is typed CAPTURE_WITHHELD_SECURE', async () => {
    writeFileSync(join(root, 'ocr-text.txt'), 'Enter your password');
    const sessionId = sc(await client.callTool({ name: 'qa_start_session', arguments: { projectRoot: root } })).sessionId as string;
    const env = await visual(sessionId, { query: 'password' });
    const res = await visual(sessionId, { query: 'password', consentId: env.consentId, approve: true });
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('CAPTURE_WITHHELD_SECURE');
  });
});
