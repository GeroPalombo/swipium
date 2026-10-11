// 2.3.0 iOS/WDA:
//  - P4: default WDA settings (waitForIdleTimeout / animationCoolOffTimeout / accessibilityDeadline)
//    applied via /appium/settings, /source?excluded_attributes=visible,accessible by default, user
//    overrides respected
//  - W1: an existing .xctestrun under derivedDataPath skips build-for-testing
//  - C4: qa_wda setup = reuse a ready WDA, else (build when needed +) start as one job, one consent
// Hermetic: a local fake WDA HTTP server for P4; xcodebuild, /status and the registry faked for C4.

import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = vi.hoisted(() => ({
  wdaReady: false,
  startWait: { ready: true, durationMs: 800 },
  childPid: 0,
  buildCalls: [] as string[][],
  spawnCalls: [] as string[][],
}));

vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return {
    ...actual,
    run: async (cmd: string, args: string[], opts?: { signal?: AbortSignal }) => {
      if (cmd !== 'xcodebuild') return actual.run(cmd, args, opts as never);
      fake.buildCalls.push(args);
      return { code: 0, stdout: '** TEST BUILD SUCCEEDED **', stderr: '', timedOut: false };
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, ...rest: unknown[]) => {
      if (cmd !== 'xcodebuild') return (actual.spawn as (...a: unknown[]) => unknown)(cmd, ...rest);
      fake.spawnCalls.push(rest[0] as string[]);
      const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = fake.childPid;
      child.unref = () => undefined;
      return child;
    },
  };
});

vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return {
    ...actual,
    xcodeAvailable: async () => ({ available: true, version: 'Xcode 26.6' }),
    checkWda: async (url: string, ...rest: unknown[]) =>
      url.includes(':8100')
        ? fake.wdaReady
          ? { reachable: true, ready: true }
          : { reachable: false, ready: false, error: 'ECONNREFUSED' }
        : actual.checkWda(url, ...(rest as [number])),
    waitForWdaReady: async () => ({ ...fake.startWait, status: { reachable: fake.startWait.ready, ready: fake.startWait.ready } }),
  };
});

vi.mock('../src/session/processRegistry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session/processRegistry.js')>();
  return { ...actual, registerManagedProcess: () => undefined, unregisterManagedProcess: () => undefined };
});

const wda = await import('../src/lib/wda.js');
const { FakeDriver, buttonScreen, harness, structured } = await import('./actFixFake.js');

const dir = mkdtempSync(join(tmpdir(), 'swipium-ios23-'));
const WDA_PROJECT = join(dir, 'WebDriverAgent.xcodeproj');
mkdirSync(WDA_PROJECT, { recursive: true });
const SIM = '6C1E1C1A-1B2C-4D3E-8F90-0123456789AB';
const DEVICE = '00008110-001A2C3E0C38802E';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('ios23-wda');
});
afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  fake.wdaReady = false;
  fake.startWait = { ready: true, durationMs: 800 };
  fake.childPid = process.pid; // alive
  fake.buildCalls.length = 0;
  fake.spawnCalls.length = 0;
});

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c as Buffer));
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

async function fakeWda(opts: { settingsRoute?: boolean } = {}) {
  const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  let n = 0;
  const server = createHttpServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    requests.push({ method, url, body: await readJson(req) });
    res.setHeader('content-type', 'application/json');
    if (method === 'POST' && url === '/session') {
      res.end(JSON.stringify({ value: { sessionId: `s${++n}`, capabilities: {} } }));
    } else if (method === 'POST' && /\/appium\/settings$/.test(url) && opts.settingsRoute !== false) {
      res.end(JSON.stringify({ value: {} }));
    } else if (method === 'GET' && /\/source/.test(url)) {
      res.end(
        JSON.stringify({ value: '<XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="1" height="1"/>' }),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ value: { message: 'unhandled endpoint' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

describe('P4: WDA settings and lean page source', () => {
  it('applies the default settings and excludes visible,accessible from /source', async () => {
    const w = await fakeWda();
    try {
      const s = await wda.createWdaSession(w.url, { bundleId: 'com.example' });
      const create = w.requests.find((r) => r.url === '/session')!;
      const caps = (create.body.capabilities as { alwaysMatch: Record<string, unknown> }).alwaysMatch;
      expect(caps).toMatchObject({ waitForIdleTimeout: 1.5, accessibilityDeadline: 20, bundleId: 'com.example' });
      const settings = w.requests.find((r) => r.url === `/session/${s.sessionId}/appium/settings`)!;
      expect(settings.body).toEqual({ settings: { ...wda.WDA_DEFAULT_SETTINGS } });
      await wda.wdaSource(w.url, s.sessionId);
      expect(w.requests.at(-1)!.url).toBe(`/session/${s.sessionId}/source?excluded_attributes=visible,accessible`);
    } finally {
      await w.close();
    }
  });

  it('user settings win; pageSourceExcludedAttributes "" keeps every attribute and is not sent to WDA', async () => {
    const w = await fakeWda();
    try {
      const s = await wda.createWdaSession(w.url, { settings: { waitForIdleTimeout: 10, pageSourceExcludedAttributes: '' } });
      const caps = (w.requests[0].body.capabilities as { alwaysMatch: Record<string, unknown> }).alwaysMatch;
      expect(caps.waitForIdleTimeout).toBe(10);
      const settings = w.requests.find((r) => r.url.endsWith('/appium/settings'))!.body.settings as Record<string, unknown>;
      expect(settings).toEqual({ waitForIdleTimeout: 10, animationCoolOffTimeout: 0.5, accessibilityDeadline: 20 });
      await wda.wdaSource(w.url, s.sessionId);
      expect(w.requests.at(-1)!.url).toBe(`/session/${s.sessionId}/source`);

      const s2 = await wda.createWdaSession(w.url, { settings: { pageSourceExcludedAttributes: 'visible' } });
      await wda.wdaSource(w.url, s2.sessionId);
      expect(w.requests.at(-1)!.url).toBe(`/session/${s2.sessionId}/source?excluded_attributes=visible`);
    } finally {
      await w.close();
    }
  });

  it('an older WDA without the settings route still gets a session', async () => {
    const w = await fakeWda({ settingsRoute: false });
    try {
      await expect(wda.createWdaSession(w.url, {})).resolves.toMatchObject({ sessionId: 's1' });
    } finally {
      await w.close();
    }
  });

  it('a source without visible keeps on-screen nodes and the parser still drops off-screen ones', async () => {
    const { parseSnapshot } = await import('../src/snapshot/parse.js');
    const xml = wda.normalizeWdaSource(
      '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" x="0" y="0" width="393" height="852">' +
        '<XCUIElementTypeButton type="XCUIElementTypeButton" name="On" label="On" enabled="true" x="10" y="100" width="100" height="44"/>' +
        '<XCUIElementTypeButton type="XCUIElementTypeButton" name="Below" label="Below" enabled="true" x="10" y="1400" width="100" height="44"/>' +
        '</XCUIElementTypeApplication>',
    );
    const labels = parseSnapshot(xml).elements.map((e) => e.text);
    expect(labels).toContain('On');
    expect(labels).not.toContain('Below');
  });

  it('without visible, rows scrolled under the bars (or the status bar) are not clickable; bar buttons are', () => {
    const cell = (label: string, y: number) =>
      `<XCUIElementTypeCell type="XCUIElementTypeCell" name="${label}" label="${label}" enabled="true" x="16" y="${y}" width="370" height="52"/>`;
    const src = (visible: string) =>
      `<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" x="0" y="0" width="402" height="874"${visible}>` +
      '<XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="Settings" x="0" y="62" width="402" height="54">' +
      '<XCUIElementTypeButton type="XCUIElementTypeButton" name="Back" label="Back" enabled="true" x="8" y="70" width="44" height="44"/>' +
      '</XCUIElementTypeNavigationBar>' +
      cell('UnderStatusBar', 21) +
      cell('UnderNavBar', 73) +
      cell('Middle', 300) +
      cell('UnderToolbar', 800) +
      '<XCUIElementTypeToolbar type="XCUIElementTypeToolbar" name="Toolbar" x="0" y="788" width="402" height="86"/>' +
      '</XCUIElementTypeApplication>';
    const clickable = (xml: string) =>
      Object.fromEntries([...xml.matchAll(/content-desc="(\w+)"[^>]*? clickable="(\w+)"/g)].map((m) => [m[1], m[2] === 'true']));
    expect(clickable(wda.normalizeWdaSource(src('')))).toMatchObject({
      Back: true,
      UnderStatusBar: false,
      UnderNavBar: false,
      Middle: true,
      UnderToolbar: false,
    });
    // A full source (with visible) keeps WDA's own verdict.
    const full = src(' visible="true"').replace(/enabled="true"/g, 'enabled="true" visible="true"');
    expect(clickable(wda.normalizeWdaSource(full))).toMatchObject({ UnderStatusBar: true, UnderNavBar: true, UnderToolbar: true });
  });
});

describe('W1: findWdaXctestrun', () => {
  it('picks the newest xctestrun for the UDID platform', () => {
    const dd = mkdtempSync(join(dir, 'dd-'));
    const products = join(dd, 'Build', 'Products');
    mkdirSync(products, { recursive: true });
    const old = join(products, 'WebDriverAgentRunner_iphonesimulator18.0-arm64.xctestrun');
    const fresh = join(products, 'WebDriverAgentRunner_iphonesimulator26.0-arm64.xctestrun');
    const dev = join(products, 'WebDriverAgentRunner_iphoneos26.0-arm64.xctestrun');
    for (const f of [old, fresh, dev]) writeFileSync(f, '');
    utimesSync(old, new Date(1_000_000), new Date(1_000_000));
    expect(wda.findWdaXctestrun(dd, SIM)).toBe(fresh);
    expect(wda.findWdaXctestrun(dd, DEVICE)).toBe(dev);
    expect(wda.findWdaXctestrun(dd, SIM, 'Other')).toBeUndefined();
    expect(wda.findWdaXctestrun(join(dd, 'missing'), SIM)).toBeUndefined();
  });
});

const sc = async (tool: string, args: Record<string, unknown>) => structured(await h.call(tool, args));

function derivedData(withXctestrun: boolean): string {
  const dd = mkdtempSync(join(dir, 'dd-'));
  if (withXctestrun) {
    mkdirSync(join(dd, 'Build', 'Products'), { recursive: true });
    writeFileSync(join(dd, 'Build', 'Products', 'WebDriverAgentRunner_iphonesimulator26.0-arm64.xctestrun'), '');
  }
  return dd;
}

describe('W1: qa_wda build reuses an existing build', () => {
  it('skips build-for-testing (and consent) when an xctestrun exists; rebuild:true still builds', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const base = { sessionId, action: 'build', device: SIM, wdaProjectPath: WDA_PROJECT, derivedDataPath: derivedData(true) };
    const res = await sc('qa_wda', base);
    expect(res).toMatchObject({ ok: true, built: true, reused: true });
    expect(res.requiresConsent).toBeUndefined();
    expect(fake.buildCalls).toHaveLength(0);
    const gate = await sc('qa_wda', { ...base, rebuild: true });
    expect(gate.requiresConsent).toBe(true);
  });
});

describe('C4: qa_wda setup', () => {
  it('reuses a ready WDA without consent or xcodebuild', async () => {
    fake.wdaReady = true;
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const res = await sc('qa_wda', { sessionId, action: 'setup', device: SIM, wdaProjectPath: WDA_PROJECT });
    expect(res).toMatchObject({ ok: true, reused: true, ready: true });
    expect(fake.buildCalls).toHaveLength(0);
    expect(fake.spawnCalls).toHaveLength(0);
  });

  it('no build yet: one wda_build consent, then one job builds and starts', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const base = { sessionId, action: 'setup', device: SIM, wdaProjectPath: WDA_PROJECT, derivedDataPath: derivedData(false) };
    const gate = await sc('qa_wda', base);
    expect(gate.requiresConsent).toBe(true);
    expect(JSON.stringify(gate)).toContain('wda_build');
    expect(JSON.stringify(gate)).toMatch(/build-for-testing.*test-without-building/);
    const started = await sc('qa_wda', { ...base, consentId: gate.consentId, approve: true });
    expect(started).toMatchObject({ ok: true, status: 'running', kind: 'wda_setup', willBuild: true });
    const job = await sc('qa_job_status', { sessionId, jobId: started.jobId, waitMs: 5000 });
    expect(job.status).toBe('done');
    expect(fake.buildCalls).toHaveLength(1);
    expect(fake.buildCalls[0]).toContain('build-for-testing');
    expect(fake.spawnCalls).toHaveLength(1);
    expect(fake.spawnCalls[0]).toContain('test-without-building');
    const s = h.sessions.get(sessionId)!;
    expect(s.mutations.some((m) => m.action === 'wda_build' && m.status === 'executed')).toBe(true);
    expect(s.mutations.some((m) => m.action === 'wda_start' && m.status === 'executed')).toBe(true);
  });

  it('with only wda_build pre-approved, a build+start still prompts (under wda_start)', async () => {
    process.env.SWIPIUM_CONSENT_PREAPPROVE = 'wda_build';
    process.env.SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE = '1';
    try {
      const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
      const base = { sessionId, action: 'setup', device: SIM, wdaProjectPath: WDA_PROJECT, derivedDataPath: derivedData(false) };
      const gate = await sc('qa_wda', base);
      expect(gate).toMatchObject({ requiresConsent: true, action: 'wda_start' });
      expect(JSON.stringify(gate)).toMatch(/build-for-testing.*test-without-building/);
      expect(fake.buildCalls).toHaveLength(0);
      expect(fake.spawnCalls).toHaveLength(0);
    } finally {
      delete process.env.SWIPIUM_CONSENT_PREAPPROVE;
      delete process.env.SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE;
    }
  });

  it('existing build: wda_start consent, the job starts without building', async () => {
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const base = { sessionId, action: 'setup', device: SIM, wdaProjectPath: WDA_PROJECT, derivedDataPath: derivedData(true) };
    const gate = await sc('qa_wda', base);
    expect(JSON.stringify(gate)).toContain('wda_start');
    const started = await sc('qa_wda', { ...base, consentId: gate.consentId, approve: true });
    expect(started).toMatchObject({ willBuild: false });
    const job = await sc('qa_job_status', { sessionId, jobId: started.jobId, waitMs: 5000 });
    expect(job.status).toBe('done');
    expect(fake.buildCalls).toHaveLength(0);
    expect(fake.spawnCalls).toHaveLength(1);
  });

  it('a runner that exits before /status is ready fails the job with WDA_START_FAILED', async () => {
    fake.childPid = 2 ** 22 + 12345; // not a live pid
    fake.startWait = { ready: false, durationMs: 100 };
    const sessionId = await h.start(new FakeDriver(buttonScreen('A', 1)));
    const base = { sessionId, action: 'setup', device: SIM, wdaProjectPath: WDA_PROJECT, derivedDataPath: derivedData(true) };
    const gate = await sc('qa_wda', base);
    const started = await sc('qa_wda', { ...base, consentId: gate.consentId, approve: true });
    const job = await sc('qa_job_status', { sessionId, jobId: started.jobId, waitMs: 5000 });
    expect(job.status).toBe('failed');
    expect(h.sessions.get(sessionId)!.jobs.get(started.jobId as string)!.result).toMatchObject({ failureCode: 'WDA_START_FAILED' });
  });
});
