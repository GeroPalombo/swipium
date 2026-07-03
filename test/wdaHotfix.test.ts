import { describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WdaDriver } from '../src/drivers/WdaDriver.js';
import { buildPlan } from '../src/build/plan.js';

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c as Buffer));
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

async function startFakeWda(
  opts: {
    pointTap?: 'modern' | 'legacy' | 'modern-500';
    elementLookup?: 'ok' | 'not-found';
    focusPredicate?: 'modern' | 'none';
    clear?: 'ok' | 'error';
    keys?: 'ok' | 'error';
  } = {},
) {
  const calls: string[] = [];
  const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  async function record(req: IncomingMessage, method: string, url: string) {
    const body = await readJson(req);
    requests.push({ method, url, body });
    return body;
  }
  async function fail(req: IncomingMessage, res: ServerResponse, method: string, url: string, statusCode: number, message: string) {
    await record(req, method, url);
    res.statusCode = statusCode;
    res.end(JSON.stringify({ value: { message } }));
  }
  const server = createHttpServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    calls.push(`${method} ${url}`);
    res.setHeader('content-type', 'application/json');
    if (method === 'POST' && url === '/session') {
      await record(req, method, url);
      res.end(JSON.stringify({ value: { sessionId: 'wda-session-1', capabilities: { platformName: 'iOS', udid: 'SIM-1' } } }));
      return;
    }
    if (method === 'POST' && url === '/session/wda-session-1/element') {
      if (opts.elementLookup === 'not-found') return fail(req, res, method, url, 404, 'no such element');
      const body = await record(req, method, url);
      if (body.using === 'predicate string') {
        const value = String(body.value ?? '');
        if (opts.focusPredicate === 'none') {
          res.statusCode = 404;
          res.end(JSON.stringify({ value: { message: 'no focused element' } }));
          return;
        }
        if (opts.focusPredicate === 'modern' && !/^focused == 1$|^wdFocused == 1$/.test(value)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ value: { message: 'unknown attribute' } }));
          return;
        }
      }
      res.end(JSON.stringify({ value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-1' } }));
      return;
    }
    if (method === 'POST' && url === '/session/wda-session-1/element/element-1/value') {
      await record(req, method, url);
      res.end(JSON.stringify({ value: null }));
      return;
    }
    if (method === 'POST' && url === '/session/wda-session-1/element/element-1/clear') {
      if (opts.clear === 'error') return fail(req, res, method, url, 500, 'clear failed');
      await record(req, method, url);
      res.end(JSON.stringify({ value: null }));
      return;
    }
    if (method === 'POST' && url === '/session/wda-session-1/wda/tap') {
      if (opts.pointTap === 'legacy') return fail(req, res, method, url, 404, 'unhandled endpoint');
      if (opts.pointTap === 'modern-500') return fail(req, res, method, url, 500, 'tap failed');
      await record(req, method, url);
      res.end(JSON.stringify({ value: null }));
      return;
    }
    if (method === 'POST' && url === '/session/wda-session-1/wda/tap/0') {
      await record(req, method, url);
      res.end(JSON.stringify({ value: null }));
      return;
    }
    if (method === 'POST' && url === '/session/wda-session-1/wda/keys') {
      if (opts.keys === 'error') return fail(req, res, method, url, 500, 'keyboard not focused');
      await record(req, method, url);
      res.end(JSON.stringify({ value: null }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ value: { message: 'not found' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    calls,
    requests,
  };
}

describe('WDA v1 compatibility fixes', () => {
  it('uses modern point tap and falls back to legacy only for missing-route responses', async () => {
    const modern = await startFakeWda();
    try {
      await new WdaDriver(modern.url, { udid: 'SIM-1' }).tapXY(10, 20);
      expect(modern.calls).toContain('POST /session/wda-session-1/wda/tap');
      expect(modern.calls).not.toContain('POST /session/wda-session-1/wda/tap/0');
    } finally {
      await modern.close();
    }

    const legacy = await startFakeWda({ pointTap: 'legacy' });
    try {
      const driver = new WdaDriver(legacy.url, { udid: 'SIM-1' });
      await driver.tapXY(10, 20);
      await driver.tapXY(30, 40);
      expect(legacy.calls.filter((c) => c === 'POST /session/wda-session-1/wda/tap')).toHaveLength(1);
      expect(legacy.calls.filter((c) => c === 'POST /session/wda-session-1/wda/tap/0')).toHaveLength(2);
    } finally {
      await legacy.close();
    }
  });

  it('falls back to /wda/keys for focused typing and reports typed failures', async () => {
    const fake = await startFakeWda({ elementLookup: 'not-found' });
    try {
      await new WdaDriver(fake.url, { udid: 'SIM-1' }).inputText('hello@example.com');
      expect(fake.requests).toContainEqual(
        expect.objectContaining({
          url: '/session/wda-session-1/wda/keys',
          body: { value: [...'hello@example.com'], text: 'hello@example.com' },
        }),
      );
    } finally {
      await fake.close();
    }

    const failing = await startFakeWda({ elementLookup: 'not-found', keys: 'error' });
    try {
      await expect(new WdaDriver(failing.url, { udid: 'SIM-1' }).inputText('hello')).rejects.toThrow(/TEXT_INPUT_UNSUPPORTED/);
    } finally {
      await failing.close();
    }
  });

  it('uses modern focused-field predicates for iOS replace-mode clearing', async () => {
    const fake = await startFakeWda({ focusPredicate: 'modern' });
    try {
      const driver = new WdaDriver(fake.url, { udid: 'SIM-1' });
      await driver.clearFocusedText(8);
      await driver.inputText('QA Tester');

      const predicateValues = fake.requests
        .filter((r) => r.url === '/session/wda-session-1/element' && r.body.using === 'predicate string')
        .map((r) => r.body.value);
      expect(predicateValues).toEqual(['focused == 1', 'focused == 1']);
      expect(fake.calls).toContain('POST /session/wda-session-1/element/element-1/clear');
      expect(fake.requests).toContainEqual(
        expect.objectContaining({
          url: '/session/wda-session-1/element/element-1/value',
          body: { value: [...'QA Tester'], text: 'QA Tester' },
        }),
      );
    } finally {
      await fake.close();
    }
  });

  it('falls back to keyboard backspaces when focused clear is unavailable', async () => {
    const fake = await startFakeWda({ focusPredicate: 'none' });
    try {
      await new WdaDriver(fake.url, { udid: 'SIM-1' }).clearFocusedText(4);
      const keys = fake.requests.find((r) => r.url === '/session/wda-session-1/wda/keys');
      expect(keys?.body.text).toBe('\b'.repeat(6));
    } finally {
      await fake.close();
    }
  });
});

describe('Expo Android build planning', () => {
  it('names the Expo Android local run path explicitly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swipium-public-expo-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '50.0.0', 'react-native': '0.73.0' } }));
      const plan = await buildPlan({ projectRoot: root, platform: 'android' });
      expect(plan.build?.label).toBe('Expo Android local run');
      expect(plan.build?.command).toBe('npx expo run:android --variant debug');
      expect(plan.notes.join('\n')).toMatch(/installs the app, and starts Metro/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
