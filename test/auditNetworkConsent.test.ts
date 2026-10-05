// qa_mobile_audit resilience (pre-launch review): the airplane-mode toggle is consent-gated like
// qa_network (network_change), and the device is restored to its RECORDED ORIGINAL state — not
// forced OFF (a device that started in airplane mode stays in airplane mode).

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-audit-home-'));
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { runMobileAudit, auditChangesNetwork, auditNetworkConsentRequest } = await import('../src/mobileAudit/runner.js');
const { SessionStore } = await import('../src/session/store.js');
type Driver = import('../src/drivers/Driver.js').Driver;

const XML =
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
  `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
  `<node class="android.widget.TextView" text="Home" resource-id="" content-desc="" bounds="[40,100][1040,180]" clickable="false" enabled="true"/>` +
  `</node></hierarchy>`;

function fakeDriver(startAirplane: boolean) {
  const state = { airplane: startAirplane, sets: [] as boolean[] };
  const d = {
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
    airplaneOn: async () => state.airplane,
    setAirplane: async (on: boolean) => {
      state.sets.push(on);
      state.airplane = on;
    },
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
  } as unknown as Driver;
  return { d, state };
}

const roots: string[] = [];
function session() {
  const root = mkdtempSync(join(tmpdir(), 'swipium-audit-proj-'));
  roots.push(root);
  const sessions = new SessionStore();
  const s = sessions.create(root);
  s.appId = 'com.example.app';
  return { sessions, s };
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const NOW = '2026-09-28T00:00:00.000Z';

describe('qa_mobile_audit resilience network consent', () => {
  it('without consent, never touches airplane mode and reports offline checks blocked', async () => {
    const { sessions, s } = session();
    const { d, state } = fakeDriver(false);
    const run = await runMobileAudit(sessions, s, d, { profile: 'resilience', now: NOW });
    expect(state.sets).toEqual([]);
    const offline = run.checks.find((c) => c.id === 'offline_entry');
    expect(offline?.status).toBe('blocked');
    expect(offline?.reason).toMatch(/consent/);
    expect(offline?.issueId).toBeUndefined(); // a missing consent is not an app issue
  });

  it('with consent, restores the ORIGINAL airplane state (device started offline stays offline)', async () => {
    const { sessions, s } = session();
    const { d, state } = fakeDriver(true);
    await runMobileAudit(sessions, s, d, { profile: 'resilience', now: NOW, networkChangeApproved: true });
    expect(state.sets[0]).toBe(true); // offline_entry
    expect(state.airplane).toBe(true); // restored to the recorded original, not forced OFF
    expect(s.network?.changed).toBe(false);
    expect(s.mutations.some((m) => m.tool === 'qa_mobile_audit' && m.action === 'network_change')).toBe(true);
  });

  it('with consent on an online device, ends online', async () => {
    const { sessions, s } = session();
    const { d, state } = fakeDriver(false);
    await runMobileAudit(sessions, s, d, { profile: 'resilience', now: NOW, networkChangeApproved: true });
    expect(state.sets).toContain(true);
    expect(state.airplane).toBe(false);
  });

  it('exposes the qa_network-equivalent consent request for callers', () => {
    expect(auditChangesNetwork('resilience')).toBe(true);
    expect(auditChangesNetwork('release_gate')).toBe(true);
    expect(auditChangesNetwork('smoke')).toBe(false);
    const req = auditNetworkConsentRequest('resilience');
    expect(req.action).toBe('network_change');
    expect(req.risk).toBe('medium');
  });
});

describe('qa_mobile_audit tool gates resilience with network_change consent', () => {
  it('asks for consent first, then runs the airplane toggle only after approval', async () => {
    const { McpServer } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const { InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { registerMobileAudit } = await import('../src/tools/mobileAudit.js');
    const { sessions, s } = session();
    const { d, state } = fakeDriver(false);
    s.driver = d;
    const server = new McpServer({ name: 'audit', version: '0' });
    registerMobileAudit(server, sessions);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'audit-client', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const args = { sessionId: s.id, profile: 'resilience', mode: 'execute' };
      const first = (await client.callTool({ name: 'qa_mobile_audit', arguments: args })) as {
        structuredContent: Record<string, unknown>;
      };
      expect(first.structuredContent.requiresConsent).toBe(true);
      expect(first.structuredContent.action).toBe('network_change');
      expect(state.sets).toEqual([]);
      const second = (await client.callTool({
        name: 'qa_mobile_audit',
        arguments: { ...args, consentId: first.structuredContent.consentId, approve: true },
      })) as { structuredContent: Record<string, unknown> };
      expect(second.structuredContent.ok).toBe(true);
      expect(state.sets).toContain(true);
      expect(state.airplane).toBe(false);
    } finally {
      await client.close();
    }
  }, 20_000);
});
