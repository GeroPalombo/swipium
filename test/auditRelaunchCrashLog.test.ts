// Relaunch audit and crash-log fixes, plus the `mobile_audit:` session note:
// - the release_gate relaunch audit waits for render before its health check, and a WDA timeout is
//    a tool / environment block (no issue, no BLOCK), not a high app bug.
// - a second crash inside the 30 s log-capture window links ITS OWN log excerpt, not the first's.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-r5-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { checkProcessRelaunch } = await import('../src/mobileAudit/checks.js');
const { auditReleaseImpact } = await import('../src/mobileAudit/results.js');
const { recordHealthFindings } = await import('../src/oracle/record.js');
const { SessionStore } = await import('../src/session/store.js');
const { createServer } = await import('../src/server.js');
const { setDriverFactoryForTests } = await import('../src/session/attach.js');
type Driver = import('../src/drivers/Driver.js').Driver;

const XML =
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
  `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
  `<node class="android.widget.TextView" text="Home" resource-id="" content-desc="" bounds="[40,100][1040,180]" clickable="false" enabled="true"/>` +
  `</node></hierarchy>`;

function fakeDriver(over: Record<string, unknown> = {}): Driver {
  return {
    kind: 'direct',
    listDevices: async () => ['fake'],
    useDevice() {},
    currentDevice: () => 'fake',
    installApp: async () => {},
    isInstalled: async () => true,
    isRunning: async () => true,
    launchApp: async () => {},
    terminateApp: async () => {},
    clearData: async () => {},
    imeShown: async () => false,
    logcat: async () => '',
    airplaneOn: async () => false,
    setAirplane: async () => {},
    foregroundOwner: async () => 'com.example.app/.Main',
    screenshot: async () => Buffer.alloc(0),
    dumpXml: async () => XML,
    tapXY: async () => {},
    pressXY: async () => {},
    inputText: async () => {},
    clearFocusedText: async () => {},
    pressKey: async () => {},
    swipe: async () => {},
    adbReverseMetro: async () => {},
    screenSize: async () => ({ width: 1080, height: 1920 }),
    screenDensity: async () => 420,
    openUrl: async () => {},
    disableAnimations: async () => {},
    ...over,
  } as unknown as Driver;
}

const roots: string[] = [fakeHome];
function session() {
  const root = mkdtempSync(join(tmpdir(), 'swipium-r5-proj-'));
  roots.push(root);
  const sessions = new SessionStore();
  const s = sessions.create(root);
  s.appId = 'com.example.app';
  return { sessions, s, root };
}
afterAll(() => {
  setDriverFactoryForTests(undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('release_gate process_relaunch', () => {
  it('waits for render: a WDA blip right after the relaunch is not judged', async () => {
    const { sessions, s } = session();
    let dumps = 0;
    const driver = fakeDriver({
      kind: 'wda',
      dumpXml: async () => {
        if (++dumps === 1) throw new Error('WDA request timed out after 10000 ms');
        return XML;
      },
    });
    const r = await checkProcessRelaunch({ sessions, session: s, driver, appId: 'com.example.app' });
    expect(r.status).toBe('pass');
    expect(r.category).toBeUndefined();
    // The render wait's tree feeds the health check: no extra dump after it.
    expect(dumps).toBe(2);
  });

  it('a WDA that stays unreachable is a tool/environment block: no category, release impact WARN', async () => {
    const { sessions, s } = session();
    // Visual-fallback session: the render wait reads screenshots, then health's dump times out.
    s.mode = 'visual-fallback';
    const driver = fakeDriver({
      kind: 'wda',
      dumpXml: async () => {
        throw new Error('WDA request timed out after 10000 ms');
      },
    });
    const r = await checkProcessRelaunch({ sessions, session: s, driver, appId: 'com.example.app' });
    expect(r.status).toBe('blocked');
    expect(r.category).toBeUndefined();
    expect(r.reason).toMatch(/WebDriverAgent.*not an app bug/);
    expect(auditReleaseImpact([{ id: 'process_relaunch', title: 't', profile: 'resilience', ...r }], false)).toBe('warn');
  });

  it('a relaunch command that times out is a tool block, not an app bug', async () => {
    const { sessions, s } = session();
    const driver = fakeDriver({
      kind: 'wda',
      launchApp: async () => {
        throw new Error('WDA request timed out');
      },
    });
    const r = await checkProcessRelaunch({ sessions, session: s, driver, appId: 'com.example.app' });
    expect(r.status).toBe('blocked');
    expect(r.category).toBeUndefined();
  });

  it('a real relaunch failure is still an app bug', async () => {
    const { sessions, s } = session();
    const driver = fakeDriver({
      launchApp: async () => {
        throw new Error('Activity class does not exist');
      },
    });
    const r = await checkProcessRelaunch({ sessions, session: s, driver, appId: 'com.example.app' });
    expect(r.status).toBe('fail');
    expect(r.category).toBe('app_bug');
  });
});

const fatal = (pid: number, time: string, msg: string) =>
  [
    `10-12 ${time}.000  ${pid}  ${pid} E AndroidRuntime: FATAL EXCEPTION: main`,
    `10-12 ${time}.001  ${pid}  ${pid} E AndroidRuntime: Process: com.example.app, PID: ${pid}`,
    `10-12 ${time}.002  ${pid}  ${pid} E AndroidRuntime: java.lang.RuntimeException: ${msg}`,
  ].join('\n');

describe('captureCrashLog cache', () => {
  const crashFinding = () => ({ severity: 'high' as const, layer: 'native' as const, kind: 'native_crash', detail: 'native crash dialog' });

  it('a second crash inside the window links its own excerpt; a repeat of the same crash reuses it', async () => {
    const { sessions, s } = session();
    let crashBuffer = fatal(1111, '10:00:00', 'first');
    const driver = fakeDriver({
      logcat: async (_n: number, _g?: string, o?: { buffer?: string }) => (o?.buffer === 'crash' ? crashBuffer : ''),
    });
    const saved: string[] = [];
    const orig = sessions.saveArtifact.bind(sessions);
    vi.spyOn(sessions, 'saveArtifact').mockImplementation((...a: Parameters<typeof orig>) => {
      saved.push(String(a[3]));
      return orig(...a);
    });

    const f1 = crashFinding();
    await recordHealthFindings(sessions, s, [f1], driver);
    // Same crash still on screen (qa_act re-runs health): cached, no new excerpt.
    const f1b = crashFinding();
    await recordHealthFindings(sessions, s, [f1b], driver);
    expect(f1b.logUri).toBe(f1.logUri);
    expect(saved).toHaveLength(1);

    // Relaunch, crash again within 30 s: a new FATAL block with a new pid.
    crashBuffer = `${crashBuffer}\n${fatal(2222, '10:00:10', 'second')}`;
    const f2 = crashFinding();
    await recordHealthFindings(sessions, s, [f2], driver);
    expect(saved).toHaveLength(2);
    expect(f2.logUri).toBeDefined();
    expect(f2.logUri).not.toBe(f1.logUri);
    expect(saved[1]).toContain('PID: 2222');
    expect(saved[1]).not.toContain('1111');
  });
});

describe('qa_mobile_audit execute records a `mobile_audit:` session note', () => {
  it('writes a pass note for a clean smoke, a fail note (app_bug) when launch fails', async () => {
    let launchFails = false;
    const driver = fakeDriver({
      launchApp: async () => {
        if (launchFails) throw new Error('Activity class does not exist');
      },
    });
    setDriverFactoryForTests(() => driver);
    const ctx = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'r5-audit-test', version: '0' });
    await Promise.all([ctx.server.connect(st), client.connect(ct)]);
    try {
      const projectRoot = mkdtempSync(join(tmpdir(), 'swipium-r5-tool-'));
      roots.push(projectRoot);
      const start = (await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult;
      const sessionId = (start.structuredContent as { sessionId: string }).sessionId;
      const s = ctx.sessions.get(sessionId)!;
      s.appId = 'com.example.app';

      await client.callTool({ name: 'qa_mobile_audit', arguments: { sessionId, profile: 'smoke', mode: 'execute' } });
      let note = s.notes.filter((n) => n.workflow === 'mobile_audit: smoke').at(-1);
      expect(note?.outcome).toBe('pass');
      expect(note?.reason).toMatch(/audit completed, release=pass/);

      launchFails = true;
      await client.callTool({ name: 'qa_mobile_audit', arguments: { sessionId, profile: 'smoke', mode: 'execute' } });
      note = s.notes.filter((n) => n.workflow === 'mobile_audit: smoke').at(-1);
      expect(note?.outcome).toBe('fail');
      expect(note?.category).toBe('app_bug');
      expect(note?.reason).toMatch(/failed: launch/);
    } finally {
      await client.close();
    }
  });
});
