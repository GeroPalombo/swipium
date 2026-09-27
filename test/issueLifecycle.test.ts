// qa_issue_log lifecycle modes (SWIP-16): drive the full issue-ledger loop hermetically through
// the in-memory MCP server against a temp project root — log → history → mark_fixed →
// verify_fixed → re-log (recurrence reopens) → suppress (hidden unless includeSuppressed) →
// metrics. No session, device, or real ~/.swipium involved.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Hermetic on-disk state: SessionStore persists under ~/.swipium, so point HOME at a temp
// dir BEFORE the store module is loaded (dynamic import below).
const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-issue-test-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer } = await import('../src/server.js');

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.structuredContent, `expected structuredContent, got: ${JSON.stringify(res.content)}`).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

// An observation that no built-in classifier rule matches, so the caller-supplied category wins
// and the fingerprint is stable across re-logs.
const OBSERVATION = {
  title: 'Profile avatar renders blank',
  summary: 'Avatar image renders blank on the profile screen after login',
  category: 'app_bug',
  severity: 'high',
  platform: 'android',
} as const;

describe('qa_issue_log lifecycle modes', () => {
  let client: Client;
  let projectRoot: string;
  let issueId: string;
  let fingerprint: string;

  const issueLog = async (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    structured((await client.callTool({ name: 'qa_issue_log', arguments: { projectRoot, ...args } })) as CallToolResult);

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-issue-test-project-'));
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'issue-lifecycle-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('mode "log" records a new observation in the ledger', async () => {
    const s = await issueLog({ mode: 'log', ...OBSERVATION, evidenceUris: ['swipium://session/x/screenshot/avatar.png'] });
    expect(s.ok).toBe(true);
    expect(s.isNew).toBe(true);
    expect(s.reopened).toBe(false);
    issueId = s.issueId as string;
    fingerprint = s.fingerprint as string;
    expect(issueId).toBeTruthy();
    expect(fingerprint).toBeTruthy();
    const issue = s.issue as Record<string, unknown>;
    expect(issue.state).toBe('open');
    expect(issue.category).toBe('app_bug');
    expect(issue.severity).toBe('high');
    expect(issue.observationCount).toBe(1);
    // The append-only ledger exists inside the temp project root, nowhere else.
    expect(existsSync(join(projectRoot, '.swipium', 'issues-log.jsonl'))).toBe(true);
  });

  it('default mode (history) lists the logged issue — existing callers are unaffected', async () => {
    const s = await issueLog({}); // no mode → history
    expect(s.ok).toBe(true);
    const counts = s.counts as { total: number; byState: Record<string, number> };
    expect(counts.total).toBe(1);
    expect(counts.byState.open).toBe(1);
    const issues = s.issues as Array<{ issueId: string; state: string }>;
    expect(issues[0].issueId).toBe(issueId);
  });

  it('mode "mark_fixed" transitions the issue to fixed with provenance', async () => {
    const s = await issueLog({ mode: 'mark_fixed', issueId, fixedInCommit: 'abc1234', howFixed: 'Guarded null avatar URL' });
    expect(s.ok).toBe(true);
    const issue = s.issue as Record<string, unknown>;
    expect(issue.state).toBe('fixed');
    expect(issue.fixedInCommit).toBe('abc1234');
    expect(issue.howFixed).toBe('Guarded null avatar URL');
  });

  it('mode "verify_fixed" records current-run evidence that the fix held', async () => {
    const s = await issueLog({
      mode: 'verify_fixed',
      issueId,
      testCaseId: 'avatar-regression',
      evidenceUris: ['swipium://session/x/report/r.json'],
    });
    expect(s.ok).toBe(true);
    const issue = s.issue as Record<string, unknown>;
    expect(issue.state).toBe('fixed');
    expect(issue.lastVerifiedFixedAt).toBeTruthy();
  });

  it('mode "verify_fixed" refuses without evidence (structured error, not a crash)', async () => {
    const res = (await client.callTool({
      name: 'qa_issue_log',
      arguments: { projectRoot, mode: 'verify_fixed', issueId },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const s = structured(res);
    expect(s.ok).toBe(false);
    expect(String(s.what)).toContain('evidence');
  });

  it('re-logging the same fingerprint reopens the fixed issue as a recurrence', async () => {
    const s = await issueLog({ mode: 'log', ...OBSERVATION });
    expect(s.ok).toBe(true);
    expect(s.isNew).toBe(false);
    expect(s.reopened).toBe(true);
    expect(s.fingerprint).toBe(fingerprint);
    expect(String(s.recurrenceMessage)).toContain('appeared again');
    expect(String(s.recurrenceMessage)).toContain('abc1234');
    const issue = s.issue as Record<string, unknown>;
    expect(issue.state).toBe('reopened');
    expect(issue.observationCount).toBe(2);

    // history reflects the reopened state and flags it as a recurrence candidate.
    const history = await issueLog({});
    expect((history.counts as { byState: Record<string, number> }).byState.reopened).toBe(1);
    expect(history.recurrenceCandidates).toEqual([issueId]);
  });

  it('mode "suppress" hides the issue from default history but not from includeSuppressed', async () => {
    const s = await issueLog({ mode: 'suppress', issueId, suppressionReason: 'Known flaky avatar CDN in the test environment' });
    expect(s.ok).toBe(true);
    const issue = s.issue as Record<string, unknown>;
    expect(issue.state).toBe('suppressed');
    expect(issue.suppressionReason).toBe('Known flaky avatar CDN in the test environment');

    const hidden = await issueLog({});
    expect((hidden.counts as { total: number }).total).toBe(0);

    const shown = await issueLog({ includeSuppressed: true });
    expect((shown.counts as { total: number }).total).toBe(1);
    expect((shown.issues as Array<{ state: string }>)[0].state).toBe('suppressed');
  });

  it('write modes need an issue key', async () => {
    const res = (await client.callTool({ name: 'qa_issue_log', arguments: { projectRoot, mode: 'mark_fixed' } })) as CallToolResult;
    expect(res.isError).toBe(true);
    const s = structured(res);
    expect(s.ok).toBe(false);
    expect(String(s.what)).toContain('issue key');
  });

  it('mode "metrics" computes lifecycle counts from the event log', async () => {
    const s = await issueLog({ mode: 'metrics' });
    expect(s.ok).toBe(true);
    const m = s.metrics as Record<string, unknown>;
    expect(m.opened).toBe(1);
    expect(m.fixed).toBe(1);
    expect(m.reopened).toBe(1);
    expect(m.verifiedFixed).toBe(1);
    expect(m.suppressed).toBe(1);
    expect(m.reopenRatePct).toBe(100);
    expect(m.fixVerificationRatePct).toBe(100);
    expect(Array.isArray(m.series)).toBe(true);
    expect((m.series as unknown[]).length).toBeGreaterThan(0);
  });
});

// B1 (1.6.0-RC): manual logs used to fingerprint only failureCode/platform, so every issue logged
// on one platform collapsed into one — a fixed "Login button unresponsive" came back as a false
// regression when "Checkout total shows NaN" was logged. Identity now includes the normalized title.
describe('qa_issue_log mode "log" identity (B1)', () => {
  let client: Client;
  let projectRoot: string;
  let sessions: ReturnType<typeof createServer>['sessions'];

  const call = async (args: Record<string, unknown>) =>
    (await client.callTool({ name: 'qa_issue_log', arguments: { projectRoot, ...args } })) as CallToolResult;
  const issueLog = async (args: Record<string, unknown>) => structured(await call(args));

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'swipium-issue-b1-'));
    const created = createServer();
    const { server } = created;
    sessions = created.sessions;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'issue-b1-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('two different titles on the same platform are two issues', async () => {
    const a = await issueLog({ mode: 'log', title: 'Login button unresponsive', platform: 'android', category: 'app_bug' });
    const b = await issueLog({ mode: 'log', title: 'Checkout total shows NaN', platform: 'android', category: 'app_bug' });
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
    expect(b.issueId).not.toBe(a.issueId);
    expect(b.reopened).toBe(false);
  });

  it('the same title twice is one issue (case/trailing punctuation normalized)', async () => {
    const again = await issueLog({ mode: 'log', title: 'login button unresponsive.', platform: 'android', category: 'app_bug' });
    expect(again.isNew).toBe(false);
    expect((again.issue as { observationCount: number }).observationCount).toBe(2);
  });

  it('log → mark_fixed → log an UNRELATED title does not reopen; the same title is a regression', async () => {
    const login = await issueLog({ mode: 'log', title: 'Login button unresponsive', platform: 'android', category: 'app_bug' });
    const fixed = await issueLog({ mode: 'mark_fixed', issueId: login.issueId, fixedInCommit: 'abc123' });
    expect((fixed.issue as { state: string }).state).toBe('fixed');

    const other = await issueLog({ mode: 'log', title: 'Profile photo upload hangs', platform: 'android', category: 'app_bug' });
    expect(other.reopened).toBe(false);
    expect(other.issueId).not.toBe(login.issueId);

    const regression = await issueLog({ mode: 'log', title: 'Login button unresponsive', platform: 'android', category: 'app_bug' });
    expect(regression.issueId).toBe(login.issueId);
    expect(regression.reopened).toBe(true);
    expect(String(regression.recurrenceMessage)).toContain('abc123');
  });

  it('the same title logged via sessionId (appId known) and via projectRoot is ONE issue', async () => {
    const started = structured((await client.callTool({ name: 'qa_start_session', arguments: { projectRoot } })) as CallToolResult);
    const session = sessions.get(started.sessionId as string)!;
    session.appId = 'com.example.app';
    const viaSession = structured(
      (await client.callTool({
        name: 'qa_issue_log',
        arguments: { sessionId: session.id, mode: 'log', title: 'Settings toggle does not persist', platform: 'android' },
      })) as CallToolResult,
    );
    const viaRoot = await issueLog({ mode: 'log', title: 'Settings toggle does not persist', platform: 'android' });
    expect(viaRoot.issueId).toBe(viaSession.issueId);
    expect(viaRoot.isNew).toBe(false);
    expect((viaRoot.issue as { observationCount: number }).observationCount).toBe(2);
  });

  it('refuses a title with no identifying words (typed ISSUE_LOG_TOO_VAGUE)', async () => {
    const res = await call({ mode: 'log', title: '500', platform: 'android' });
    expect(res.isError).toBe(true);
    expect(structured(res).failureCode).toBe('ISSUE_LOG_TOO_VAGUE');
  });

  it('mark_fixed on an already-fixed issue is a typed ISSUE_STATE_INVALID error', async () => {
    const s = await issueLog({ mode: 'log', title: 'Search results duplicated', platform: 'ios' });
    await issueLog({ mode: 'mark_fixed', issueId: s.issueId });
    const res = await call({ mode: 'mark_fixed', issueId: s.issueId });
    expect(res.isError).toBe(true);
    expect(structured(res).failureCode).toBe('ISSUE_STATE_INVALID');
  });

  it('suppress with suppressedUntil, then unsuppress:true restores the prior state', async () => {
    const s = await issueLog({ mode: 'log', title: 'Map tiles load slowly', platform: 'ios' });
    const bad = await call({ mode: 'suppress', issueId: s.issueId, suppressedUntil: 'next tuesday' });
    expect(structured(bad).failureCode).toBe('INVALID_ARGUMENT');
    const sup = await issueLog({ mode: 'suppress', issueId: s.issueId, suppressionReason: 'CDN', suppressedUntil: '2999-01-01T00:00:00Z' });
    expect((sup.issue as { state: string; suppressedUntil: string }).suppressedUntil).toBe('2999-01-01T00:00:00Z');
    const un = await issueLog({ mode: 'suppress', issueId: s.issueId, unsuppress: true });
    expect((un.issue as { state: string }).state).toBe('open');
    const again = await call({ mode: 'suppress', issueId: s.issueId, unsuppress: true });
    expect(structured(again).failureCode).toBe('ISSUE_STATE_INVALID');
  });
});
