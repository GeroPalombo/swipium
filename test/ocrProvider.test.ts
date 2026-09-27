// Real-device smoke (2.0.0) regressions for the local OCR provider:
//  (1) the provider runs with cwd = project root, so the documented relative argv
//      [".swipium/ocr_tesseract.py"] resolves against the project, not the server cwd;
//  (2) a non-zero exit is a typed OCR_PROVIDER_FAILED (exit code + trimmed, redacted stderr),
//      never `ok:true, found:false`;
//  (3) the screenshot handed to the provider lives under the REAL (symlink-resolved) temp dir —
//      tesseract/leptonica on macOS cannot open /tmp/... when TMPDIR is unset.
// Also: qa_visual missing-argument errors carry INVALID_ARGUMENT (not UNKNOWN).
// No mocks of the provider seam: real `node` provider scripts are spawned.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-ocr-provider-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
delete process.env.SWIPIUM_OCR_CMD;

const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
const { runOcr } = await import('../src/visual/ocr.js');
const { providerTempDir, VisualProviderFailedError, trimProviderStderr } = await import('../src/visual/provider.js');
type Driver = import('../src/drivers/Driver.js').Driver;

function makePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Minimal driver: screenshot + size; no UI tree; every other call is a no-op. */
function fakeDriver(): Driver {
  const png = makePng(64, 64);
  const base: Record<string, unknown> = {
    kind: 'direct',
    currentDevice: () => undefined,
    useDevice: () => undefined,
    screenshot: async () => png,
    screenSize: async () => ({ width: 64, height: 64 }),
    screenDensity: async () => null,
    dumpXml: async () => {
      throw new Error('no UI tree');
    },
    listDevices: async () => ['emulator-5554'],
    foregroundOwner: async () => 'unknown',
  };
  return new Proxy(base, {
    get: (t, p) => (p in t ? t[p as string] : p === 'then' ? undefined : async () => undefined),
  }) as unknown as Driver;
}

/** A provider script that echoes its cwd + image path, so the test sees how it was run. */
const ECHO_PROVIDER = `const img = process.argv[2];
console.log(JSON.stringify({ text: process.cwd() + '\\n' + img, regions: [
  { text: 'Log in', confidence: 0.97, bbox: { x: 10, y: 10, width: 20, height: 10 } },
  { text: 'cwd:' + process.cwd(), confidence: 0.99, bbox: { x: 0, y: 0, width: 1, height: 1 } },
  { text: 'img:' + img, confidence: 0.99, bbox: { x: 0, y: 0, width: 1, height: 1 } },
] }));
`;
const FAILING_PROVIDER = `process.stderr.write('Traceback (most recent call last):\\n  File "ocr.py"\\nFileNotFoundError: tesseract hunter22secret\\n');
process.exit(3);
`;

function makeProject(provider: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-ocr-provider-project-')));
  mkdirSync(join(root, '.swipium'), { recursive: true });
  writeFileSync(join(root, '.swipium', 'ocr.js'), provider);
  writeFileSync(join(root, 'package.json'), '{"name":"ocr-fixture"}');
  writeFileSync(join(root, '.swipium', 'config.json'), JSON.stringify({ ocrCommand: ['node', '.swipium/ocr.js', '{image}'] }));
  return root;
}

describe('OCR provider execution (runOcr)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('runs a relative provider path with cwd = project root and a realpath temp image', async () => {
    const root = makeProject(ECHO_PROVIDER);
    dirs.push(root);
    expect(process.cwd()).not.toBe(root);
    const res = await runOcr(fakeDriver(), root, ['node', '.swipium/ocr.js', '{image}']);
    const cwd = res.regions.find((r) => r.text.startsWith('cwd:'))!.text.slice(4);
    const img = res.regions.find((r) => r.text.startsWith('img:'))!.text.slice(4);
    expect(realpathSync(cwd)).toBe(root);
    expect(img.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(realpathSync(join(img, '..'))).toBe(join(img, '..')); // no symlinked component
    expect(res.regions.some((r) => r.text === 'Log in')).toBe(true);
  });

  it('a non-zero provider exit throws VisualProviderFailedError (OCR_PROVIDER_FAILED) with code + stderr', async () => {
    const root = makeProject(FAILING_PROVIDER);
    dirs.push(root);
    const err = await runOcr(fakeDriver(), root, ['node', '.swipium/ocr.js', '{image}']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VisualProviderFailedError);
    const e = err as InstanceType<typeof VisualProviderFailedError>;
    expect(e.code).toBe('OCR_PROVIDER_FAILED');
    expect(e.exitCode).toBe(3);
    expect(e.timedOut).toBe(false);
    expect(e.stderr).toContain('FileNotFoundError');
  });

  it('providerTempDir resolves symlinks (TMPDIR unset → /tmp → /private/tmp on macOS)', () => {
    const saved = process.env.TMPDIR;
    try {
      delete process.env.TMPDIR;
      expect(providerTempDir()).toBe(realpathSync(tmpdir()));
      if (process.platform === 'darwin') expect(providerTempDir()).toBe('/private/tmp');
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it('trims long stderr to its tail', () => {
    const t = trimProviderStderr('x'.repeat(5000) + 'LAST LINE', 100);
    expect(t.length).toBeLessThanOrEqual(101);
    expect(t.endsWith('LAST LINE')).toBe(true);
  });
});

describe('qa_visual find_text with a real provider', () => {
  let client: Client;
  const roots: string[] = [];

  beforeAll(async () => {
    setDriverFactoryForTests(() => fakeDriver());
    const ctx = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'ocr-provider-test', version: '0' });
    await Promise.all([ctx.server.connect(serverTransport), client.connect(clientTransport)]);
  });
  afterAll(async () => {
    setDriverFactoryForTests(undefined);
    await client.close();
    for (const d of [fakeHome, ...roots]) rmSync(d, { recursive: true, force: true });
  });

  const sc = (res: unknown): Record<string, unknown> => (res as CallToolResult).structuredContent as Record<string, unknown>;
  async function findText(provider: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projectRoot = makeProject(provider);
    roots.push(projectRoot);
    const sessionId = sc(await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })).sessionId as string;
    const call = async (extra: Record<string, unknown>) =>
      sc(await client.callTool({ name: 'qa_visual', arguments: { sessionId, mode: 'find_text', ...args, ...extra } }));
    const first = await call({});
    if (!first.requiresConsent) return first;
    return call({ consentId: first.consentId, approve: true });
  }

  it('the documented relative ocrCommand works (found:true), not "found:false" from a missing script', async () => {
    const res = await findText(ECHO_PROVIDER, { query: 'Log in' });
    expect(res.ok).toBe(true);
    expect(res.found).toBe(true);
  });

  it('a crashing provider → ok:false OCR_PROVIDER_FAILED with exitCode + redacted-bounded stderr', async () => {
    const res = await findText(FAILING_PROVIDER, { query: 'Log in' });
    expect(res.ok).toBe(false);
    expect(res.found).toBeUndefined();
    expect(res.failureCode).toBe('OCR_PROVIDER_FAILED');
    expect(res.exitCode).toBe(3);
    expect(String(res.stderr)).toContain('FileNotFoundError');
    expect(String(res.what)).toMatch(/exit code 3/);
  });

  it('missing query → INVALID_ARGUMENT', async () => {
    const res = await findText(ECHO_PROVIDER, {});
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('INVALID_ARGUMENT');
  });
});

describe('flow steps classify a provider crash', () => {
  it('classifyFlowDriverError maps VisualProviderFailedError to OCR_PROVIDER_FAILED', async () => {
    const { classifyFlowDriverError } = await import('../src/flows/run.js');
    expect(classifyFlowDriverError(new VisualProviderFailedError('ocr', 2, 'boom', false))).toBe('OCR_PROVIDER_FAILED');
  });
});

describe('sensitive-mode capture refusal is typed', () => {
  it('sensitiveRefusal carries SENSITIVE_MODE_REFUSED (catalogued), not UNKNOWN', async () => {
    const { sensitiveRefusal } = await import('../src/lib/sensitive.js');
    const { FAILURES } = await import('../src/oracle/failures.js');
    const sc = sensitiveRefusal('Screenshot').structuredContent as Record<string, unknown>;
    expect(sc.ok).toBe(false);
    expect(sc.failureCode).toBe('SENSITIVE_MODE_REFUSED');
    expect(FAILURES.SENSITIVE_MODE_REFUSED.bucket).toBe('unsafe_refused');
  });
});
