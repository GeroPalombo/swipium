// Issue ledger hygiene (pre-launch review):
//  - qa_issue_log never writes a registered session secret into the committed repo ledger;
//  - a failing qa_note without a category is an app-owned finding (app_bug / medium in the
//    ledger), not a low-severity Swipium mcp_limitation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-issue-redact-home-'));
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { registerIssues, redactIssueArgs } = await import('../src/tools/issues.js');
const { registerNote, defaultNoteCategory } = await import('../src/tools/note.js');
const { foldRunIntoLedger } = await import('../src/issues/reportBridge.js');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-issue-redact-proj-')));
const sessions = new SessionStore();
let client: Client;

beforeAll(async () => {
  const server = new McpServer({ name: 'issue-redact', version: '0' });
  registerIssues(server, sessions);
  registerNote(server, sessions);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'issue-redact-client', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
});
afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult & { structuredContent: Record<string, unknown> };

describe('qa_issue_log redaction', () => {
  it('scrubs session secrets from title/summary before they reach .swipium/issues-log.jsonl', async () => {
    const s = sessions.create(root);
    const secret = 'Pa55w0rd-Ledger!';
    sessions.setInput(s, 'SWIPIUM_TEST_PASSWORD', secret, true, 'test');
    const res = await call('qa_issue_log', {
      sessionId: s.id,
      mode: 'log',
      title: `Login rejects valid password ${secret} on checkout`,
      summary: `typed ${secret} into the password field and got an error`,
    });
    expect(res.structuredContent.ok).toBe(true);
    const ledger = readFileSync(join(root, '.swipium', 'issues-log.jsonl'), 'utf8');
    expect(ledger).not.toContain(secret);
    expect(ledger).toContain('«redacted»');
    expect(JSON.stringify(res)).not.toContain(secret);
  });

  it('redactIssueArgs covers every free-text field and leaves others alone', () => {
    const out = redactIssueArgs(
      { title: 'a hunter22 b', summary: 'hunter22', howFixed: 'rotated hunter22', suppressionReason: 'x hunter22', mode: 'log' },
      ['hunter22'],
    );
    expect(JSON.stringify(out)).not.toContain('hunter22');
    expect(out.mode).toBe('log');
  });
});

describe('qa_note default category for failures', () => {
  it('defaults a failing note to app_bug; other outcomes stay uncategorized', () => {
    expect(defaultNoteCategory('fail')).toBe('app_bug');
    expect(defaultNoteCategory('blocked')).toBeUndefined();
    expect(defaultNoteCategory('pass')).toBeUndefined();
  });

  it('an uncategorized failing qa_note lands in the ledger as app_bug / medium', async () => {
    const s = sessions.create(root);
    const res = await call('qa_note', { sessionId: s.id, workflow: 'Checkout total', outcome: 'fail', reason: 'total ignores coupon' });
    expect((res.structuredContent.recorded as Record<string, unknown>).category).toBe('app_bug');
    const note = s.notes.at(-1)!;
    expect(note.category).toBe('app_bug');
    const folded = foldRunIntoLedger(root, [], [note], '2026-09-28T00:00:00.000Z');
    expect(folded.recorded[0]).toMatchObject({ category: 'app_bug', severity: 'medium' });
  });

  it('an explicit mcp_limitation is kept', async () => {
    const s = sessions.create(root);
    await call('qa_note', { sessionId: s.id, workflow: 'Opaque canvas', outcome: 'fail', category: 'mcp_limitation', reason: 'no tree' });
    expect(s.notes.at(-1)!.category).toBe('mcp_limitation');
  });
});
