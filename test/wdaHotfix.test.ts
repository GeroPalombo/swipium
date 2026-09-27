import { describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WdaDriver } from '../src/drivers/WdaDriver.js';
import { TYPING_TIMEOUT_CAP_MS, wdaRequestTimeoutMs, withWdaCall } from '../src/lib/wda.js';
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
    windowSize?: 'ok' | 'missing';
    attributeType?: string;
    keyboard?: boolean;
    /** Mutable: GET /orientation answers this; /window/size swaps axes for LANDSCAPE. */
    orientation?: { value: string };
    hangSource?: boolean;
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
    if (url.startsWith('/session/stale-session/')) {
      await record(req, method, url);
      res.statusCode = 404;
      res.end(JSON.stringify({ value: { error: 'invalid session id', message: 'Session does not exist' } }));
      return;
    }
    if (method === 'POST' && url === '/session/wda-session-1/elements') {
      await record(req, method, url);
      res.end(JSON.stringify({ value: opts.keyboard ? [{ 'element-6066-11e4-a52e-4f735466cecf': 'kb-1' }] : [] }));
      return;
    }
    if (method === 'GET' && url === '/session/wda-session-1/element/kb-1/rect') {
      await record(req, method, url);
      res.end(JSON.stringify({ value: { x: 0, y: 516, width: 393, height: 336 } }));
      return;
    }
    if (method === 'POST' && url === '/session/wda-session-1/wda/keyboard/dismiss') {
      await record(req, method, url);
      res.end(JSON.stringify({ value: null }));
      return;
    }
    if (method === 'GET' && url === '/session/wda-session-1/orientation' && opts.orientation) {
      await record(req, method, url);
      res.end(JSON.stringify({ value: opts.orientation.value }));
      return;
    }
    if (method === 'GET' && url === '/session/wda-session-1/source' && opts.hangSource) {
      return; // never answers — exercises the HTTP timeout / cancellation
    }
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
    if (method === 'GET' && url === '/session/wda-session-1/window/size') {
      if (opts.windowSize === 'missing') return fail(req, res, method, url, 404, 'unhandled endpoint');
      await record(req, method, url);
      const landscape = opts.orientation?.value === 'LANDSCAPE';
      res.end(JSON.stringify({ value: landscape ? { width: 852, height: 393 } : { width: 393, height: 852 } }));
      return;
    }
    if (method === 'GET' && url === '/session/wda-session-1/source') {
      await record(req, method, url);
      res.end(
        JSON.stringify({
          value: '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" x="0" y="0" width="393" height="852"/>',
        }),
      );
      return;
    }
    if (method === 'GET' && url === '/session/wda-session-1/element/element-1/attribute/type') {
      await record(req, method, url);
      res.end(JSON.stringify({ value: opts.attributeType ?? 'XCUIElementTypeSecureTextField' }));
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
  server.keepAliveTimeout = 1;
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
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

describe('WDA screen size via /window/size (SWIP-17)', () => {
  it('uses GET /window/size (no page-source dump) and caches per session', async () => {
    const fake = await startFakeWda();
    try {
      const driver = new WdaDriver(fake.url, { udid: 'SIM-1' });
      expect(await driver.screenSize()).toEqual({ width: 393, height: 852 });
      expect(await driver.screenSize()).toEqual({ width: 393, height: 852 });
      expect(fake.calls.filter((c) => c === 'GET /session/wda-session-1/window/size')).toHaveLength(1); // cached
      expect(fake.calls.some((c) => c.includes('/source'))).toBe(false); // never dumps the page source
    } finally {
      await fake.close();
    }
  });

  it('falls back to page-source root bounds on older WDA builds without /window/size', async () => {
    const fake = await startFakeWda({ windowSize: 'missing' });
    try {
      expect(await new WdaDriver(fake.url, { udid: 'SIM-1' }).screenSize()).toEqual({ width: 393, height: 852 });
      expect(fake.calls).toContain('GET /session/wda-session-1/source');
    } finally {
      await fake.close();
    }
  });
});

describe('WDA secure-field probe (SWIP-03)', () => {
  it('flags XCUIElementTypeSecureTextField via the element type attribute', async () => {
    const fake = await startFakeWda();
    try {
      expect(await new WdaDriver(fake.url, { udid: 'SIM-1' }).isSecureBySelector('accessibility id', 'password')).toBe(true);
      expect(fake.calls).toContain('GET /session/wda-session-1/element/element-1/attribute/type');
    } finally {
      await fake.close();
    }
  });

  it('treats a plain text field as non-secure (missing `secure` attribute tolerated)', async () => {
    const fake = await startFakeWda({ attributeType: 'XCUIElementTypeTextField' });
    try {
      expect(await new WdaDriver(fake.url, { udid: 'SIM-1' }).isSecureBySelector('accessibility id', 'email')).toBe(false);
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

describe('WDA keyboard, orientation, timeouts and session recovery', () => {
  it('imeShown() finds XCUIElementTypeKeyboard by class name (no page source); hideKeyboard dismisses it', async () => {
    const shown = await startFakeWda({ keyboard: true });
    try {
      const d = new WdaDriver(shown.url, { udid: 'SIM-1' });
      expect(await d.imeShown()).toBe(true);
      expect(shown.requests).toContainEqual(
        expect.objectContaining({
          url: '/session/wda-session-1/elements',
          body: { using: 'class name', value: 'XCUIElementTypeKeyboard' },
        }),
      );
      expect(await d.imeFrame()).toEqual([0, 516, 393, 852]);
      expect(await d.hideKeyboard()).toBe(true);
      expect(shown.calls).toContain('POST /session/wda-session-1/wda/keyboard/dismiss');
      expect(shown.calls.some((c) => c.includes('/source'))).toBe(false);
    } finally {
      await shown.close();
    }
    const hidden = await startFakeWda();
    try {
      const d = new WdaDriver(hidden.url, { udid: 'SIM-1' });
      expect(await d.imeShown()).toBe(false);
      expect(await d.hideKeyboard()).toBe(false);
      expect(hidden.calls).not.toContain('POST /session/wda-session-1/wda/keyboard/dismiss');
    } finally {
      await hidden.close();
    }
  });

  it('screen size cache is keyed by orientation (rotation re-reads /window/size)', async () => {
    const orientation = { value: 'PORTRAIT' };
    const fake = await startFakeWda({ orientation });
    try {
      const d = new WdaDriver(fake.url, { udid: 'SIM-1' });
      expect(await d.screenSize()).toEqual({ width: 393, height: 852 });
      expect(await d.screenSize()).toEqual({ width: 393, height: 852 });
      orientation.value = 'LANDSCAPE';
      expect(await d.screenSize()).toEqual({ width: 852, height: 393 });
      expect(fake.calls.filter((c) => c === 'GET /session/wda-session-1/window/size')).toHaveLength(2);
    } finally {
      await fake.close();
    }
  });

  it('recovers from "invalid session id" by recreating the session and retrying once', async () => {
    const fake = await startFakeWda();
    try {
      const d = new WdaDriver(fake.url, { udid: 'SIM-1', sessionId: 'stale-session' });
      await d.tapXY(5, 6);
      expect(fake.calls).toContain('POST /session/stale-session/wda/tap');
      expect(fake.calls).toContain('POST /session');
      expect(fake.calls).toContain('POST /session/wda-session-1/wda/tap');
      expect(d.currentSession()).toBe('wda-session-1');
    } finally {
      await fake.close();
    }
  });

  it('re-creates the session with forceAppLaunch:false (no app relaunch) and flags sessionRecovered', async () => {
    const fake = await startFakeWda();
    try {
      const d = new WdaDriver(fake.url, {
        udid: 'SIM-1',
        sessionId: 'stale-session',
        bundleId: 'com.example.app',
        capabilities: { foo: 1 },
      });
      await d.tapXY(5, 6);
      const create = fake.requests.find((r) => r.method === 'POST' && r.url === '/session');
      const alwaysMatch = (create?.body.capabilities as { alwaysMatch: Record<string, unknown> }).alwaysMatch;
      expect(alwaysMatch).toMatchObject({
        bundleId: 'com.example.app',
        forceAppLaunch: false,
        shouldTerminateApp: false,
        foo: 1,
        udid: 'SIM-1',
      });
      expect(create?.body.desiredCapabilities).toBeUndefined(); // WDA reads W3C capabilities only
      expect(d.consumeSessionRecovered()).toBe(true);
      expect(d.consumeSessionRecovered()).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it('a first-time session create keeps the caller capabilities untouched (no forceAppLaunch override)', async () => {
    const fake = await startFakeWda();
    try {
      const d = new WdaDriver(fake.url, { udid: 'SIM-1', bundleId: 'com.example.app' });
      await d.tapXY(1, 2);
      const create = fake.requests.find((r) => r.method === 'POST' && r.url === '/session');
      const alwaysMatch = (create?.body.capabilities as { alwaysMatch: Record<string, unknown> }).alwaysMatch;
      expect(alwaysMatch.forceAppLaunch).toBeUndefined(); // fresh attach still launches the app
      // …but its later replacement must not kill the app: WDA tears the OLD session down with the
      // OLD session's shouldTerminateApp before it applies the new request's caps.
      expect(alwaysMatch.shouldTerminateApp).toBe(false);
      expect(d.consumeSessionRecovered()).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it('a rebind driver (reuseRunningApp) sends forceAppLaunch:false + shouldTerminateApp:false, overriding config caps', async () => {
    const fake = await startFakeWda();
    try {
      const d = new WdaDriver(fake.url, {
        udid: 'SIM-1',
        bundleId: 'com.example.app',
        capabilities: { forceAppLaunch: true, shouldTerminateApp: true, foo: 1 },
        reuseRunningApp: true,
      });
      await d.tapXY(1, 2);
      const create = fake.requests.find((r) => r.method === 'POST' && r.url === '/session');
      expect((create?.body.capabilities as { alwaysMatch: Record<string, unknown> }).alwaysMatch).toMatchObject({
        bundleId: 'com.example.app',
        forceAppLaunch: false,
        shouldTerminateApp: false,
        foo: 1,
      });
    } finally {
      await fake.close();
    }
  });

  it('a fresh attach honours a configured shouldTerminateApp, and a bundle-less session gets no app caps', async () => {
    const fake = await startFakeWda();
    try {
      await new WdaDriver(fake.url, { udid: 'SIM-1', bundleId: 'com.example.app', capabilities: { shouldTerminateApp: true } }).tapXY(1, 2);
      await new WdaDriver(fake.url, { udid: 'SIM-1', reuseRunningApp: true }).tapXY(1, 2);
      const creates = fake.requests.filter((r) => r.method === 'POST' && r.url === '/session');
      const am = creates.map((c) => (c.body.capabilities as { alwaysMatch: Record<string, unknown> }).alwaysMatch);
      expect(am[0].shouldTerminateApp).toBe(true);
      expect(am[1]).not.toHaveProperty('forceAppLaunch');
      expect(am[1]).not.toHaveProperty('shouldTerminateApp');
    } finally {
      await fake.close();
    }
  });

  it('scales the typing timeout with text length (15 s + 50 ms/char, capped at 5 min)', () => {
    const body = (t: string) => JSON.stringify({ value: [...t], text: t });
    expect(wdaRequestTimeoutMs('POST', '/session/s/element/e/value', body('abc'))).toBe(15_150);
    expect(wdaRequestTimeoutMs('POST', '/session/s/wda/keys', body('x'.repeat(2000)))).toBe(115_000);
    expect(wdaRequestTimeoutMs('POST', '/session/s/wda/keys', body('x'.repeat(100_000)))).toBe(TYPING_TIMEOUT_CAP_MS);
    expect(wdaRequestTimeoutMs('POST', '/session/s/wda/tap', body('x'.repeat(2000)))).toBe(15_000);
    expect(wdaRequestTimeoutMs('GET', '/session/s/source')).toBe(30_000);
  });

  it('times out a hung /source request instead of hanging forever', async () => {
    const fake = await startFakeWda({ hangSource: true });
    try {
      const d = new WdaDriver(fake.url, { udid: 'SIM-1' });
      await expect(withWdaCall({ timeoutMs: 150 }, () => d.dumpXml())).rejects.toThrow(/timed out after 150ms/);
    } finally {
      await fake.close();
    }
  });

  it('aborts in-flight WDA requests when the bound job signal is cancelled', async () => {
    const fake = await startFakeWda({ hangSource: true });
    try {
      const d = new WdaDriver(fake.url, { udid: 'SIM-1' });
      const ctl = new AbortController();
      d.setSignal(ctl.signal);
      setTimeout(() => ctl.abort(), 50);
      await expect(d.dumpXml()).rejects.toThrow(/aborted/);
    } finally {
      await fake.close();
    }
  });
});
