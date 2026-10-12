// qa_ios launch of a bundle other than the app under test is not evidence.
//  - no app_launch_end milestone, session.appId stays, the result names appUnderTest;
//  - a qa_note pass on top of it is an unbacked claim (BLOCK, gate fails NOT_TESTED);
//  - launching the app under test still sets the milestone (a pass note on it alone is CAUTION).
// Hermetic: temp HOME, simctl mocked.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const UDID = '5F0C1A2B-3C4D-4E5F-8A9B-0C1D2E3F4A5B';
const launched = vi.hoisted(() => [] as string[]);
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return {
    ...actual,
    simctlAvailable: async () => true,
    listSimulators: async () => [{ udid: UDID, name: 'iPhone 17', state: 'Booted', runtime: 'iOS 26.0' }],
    launchApp: async (_udid: string, bundleId: string) => {
      launched.push(bundleId);
    },
    isInstalled: async () => true,
  };
});

const { createServer } = await import('../src/server.js');
const { SimctlDriver } = await import('../src/drivers/SimctlDriver.js');
const { generateSessionReport } = await import('../src/services/report.js');
const { reportPolicyVerdicts } = await import('../src/report/export.js');
type SessionStore = import('../src/session/store.js').SessionStore;
type ReportData = import('../src/report/export.js').ReportData;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-r4-ioslaunch-')));
writeFileSync(join(root, 'package.json'), '{"name":"r4ioslaunch"}');

let client: Client;
let sessions: SessionStore;
beforeAll(async () => {
  const ctx = createServer();
  sessions = ctx.sessions;
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'r4ioslaunch', version: '0' });
  await Promise.all([ctx.server.connect(s), client.connect(c)]);
});
afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) =>
  ((await client.callTool({ name, arguments: args })) as CallToolResult).structuredContent as Record<string, unknown>;

async function iosSession(): Promise<string> {
  const sessionId = (await call('qa_start_session', { projectRoot: root })).sessionId as string;
  const s = sessions.get(sessionId)!;
  s.driver = new SimctlDriver(UDID);
  s.device = UDID;
  s.appId = 'com.example.app';
  return sessionId;
}

async function gate(sessionId: string) {
  const r = (await generateSessionReport(sessions, sessions.get(sessionId)!, { includeCurrentDump: false }))
    .report as unknown as ReportData;
  return { r, notTestedVerdict: reportPolicyVerdicts(r).find((v) => v.flow === 'swipium: not tested') };
}

describe('qa_ios launch of another bundle', () => {
  it('keeps the app under test, sets no launch milestone, and a pass note on it stays BLOCK / NOT_TESTED', async () => {
    const sessionId = await iosSession();
    const res = await call('qa_ios', { sessionId, action: 'launch', bundleId: 'com.apple.Preferences' });
    expect(res).toMatchObject({ ok: true, launched: true, bundleId: 'com.apple.Preferences', appUnderTest: 'com.example.app' });
    expect(launched.at(-1)).toBe('com.apple.Preferences');
    const s = sessions.get(sessionId)!;
    expect(s.appId).toBe('com.example.app');
    expect(s.milestones.app_launch_end).toBeUndefined();

    await call('qa_note', { sessionId, workflow: 'settings', outcome: 'pass' });
    const { r, notTestedVerdict } = await gate(sessionId);
    expect(r.executiveSummary.risk).toBe('block');
    expect(r.notTested).toMatchObject({ reachedApp: false, failureCode: 'NOT_TESTED' });
    expect(notTestedVerdict).toMatchObject({ passed: false, failureCode: 'NOT_TESTED' });
  });

  it('launching the app under test sets the milestone; a pass note on that alone is CAUTION and still fails the gate', async () => {
    const sessionId = await iosSession();
    const res = await call('qa_ios', { sessionId, action: 'launch' });
    expect(res).toMatchObject({ ok: true, bundleId: 'com.example.app' });
    expect(res.appUnderTest).toBeUndefined();
    expect(sessions.get(sessionId)!.milestones.app_launch_end).toBeTypeOf('number');

    await call('qa_note', { sessionId, workflow: 'home', outcome: 'pass' });
    const { r, notTestedVerdict } = await gate(sessionId);
    expect(r.executiveSummary.risk).toBe('caution');
    expect(r.appVerdict?.status).toBe('UNVERIFIED');
    expect(notTestedVerdict).toMatchObject({ passed: false, failureCode: 'NOT_TESTED' });
  });
});
