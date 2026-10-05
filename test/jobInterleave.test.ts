// R3: a device-driving tool (explicit allowlist, DEVICE_DRIVING_TOOLS) called while a background job
// is still driving the same session's device gets an advisory note (never a block). Tools that never
// touch the device (qa_note, qa_generate, qa_suite_*, qa_app_map_*, qa_build...), read-only tools,
// the job tools themselves, qa_report / qa_get_artifact and host-only jobs (build, bundletool) stay quiet.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-interleave-home-'));
const project = mkdtempSync(join(tmpdir(), 'swipium-interleave-proj-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { createServer, runningJobNote, DEVICE_DRIVING_TOOLS } = await import('../src/server.js');
const { TOOL_NAMES } = await import('../src/version.js');

const text = (r: CallToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('running job interleave note', () => {
  const ctx = createServer();
  const client = new Client({ name: 'interleave-test', version: '0' });
  let sessionId = '';
  let jobId = '';

  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([ctx.server.connect(a), client.connect(b)]);
    const s = ctx.sessions.create(project);
    sessionId = s.id;
    jobId = ctx.sessions.createJob(s, 'explore').jobId;
  });

  afterAll(async () => {
    await client.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('decides per the device-driving allowlist', () => {
    const note = runningJobNote(ctx.sessions, 'qa_act', sessionId);
    expect(note).toBe(`job ${jobId} is still driving this device; actions may interleave. Poll qa_job_status or qa_job_cancel first.`);
    for (const t of ['qa_app_control', 'qa_flow_run', 'qa_prepare_target', 'qa_ios', 'qa_network', 'qa_visual', 'qa_explore']) {
      expect(runningJobNote(ctx.sessions, t, sessionId), t).toBe(note);
    }
    // never touch the device (were annotated by the old readOnlyHint test)
    for (const t of [
      'qa_note',
      'qa_generate',
      'qa_suite_update',
      'qa_suite_generate',
      'qa_app_map_build',
      'qa_app_map_update',
      'qa_issue_log',
      'qa_build',
      'qa_bundletool',
      'qa_flow_compile',
      'qa_start_session',
    ]) {
      expect(runningJobNote(ctx.sessions, t, sessionId), t).toBeUndefined();
    }
    // read-only / observation-only tools
    for (const t of ['qa_snapshot', 'qa_status', 'qa_screenshot', 'qa_device_info']) {
      expect(runningJobNote(ctx.sessions, t, sessionId), t).toBeUndefined();
    }
    // how you react to a job, or only reading its output
    for (const t of ['qa_job_status', 'qa_job_cancel', 'qa_report', 'qa_get_artifact']) {
      expect(runningJobNote(ctx.sessions, t, sessionId)).toBeUndefined();
    }
    // the allowlist only names real tools
    for (const t of DEVICE_DRIVING_TOOLS) expect(TOOL_NAMES).toContain(t);
    // no session / unknown session / unknown tool
    expect(runningJobNote(ctx.sessions, 'qa_act', undefined)).toBeUndefined();
    expect(runningJobNote(ctx.sessions, 'qa_act', 'nope')).toBeUndefined();
    expect(runningJobNote(ctx.sessions, 'qa_nope', sessionId)).toBeUndefined();
  });

  it('annotates a device-driving call on the session through the server wrapper, without changing its verdict', async () => {
    // qa_network status needs a device; with none bound it errors, and the note still rides along.
    const r = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'status' } })) as CallToolResult;
    expect(text(r)).toContain(`job ${jobId} is still driving this device`);
    expect((r.structuredContent as { notes?: string[] }).notes).toContain(
      `job ${jobId} is still driving this device; actions may interleave. Poll qa_job_status or qa_job_cancel first.`,
    );
  });

  it('a call that never touches the device (qa_note) is not annotated', async () => {
    const r = (await client.callTool({
      name: 'qa_note',
      arguments: { sessionId, workflow: 'Login', outcome: 'pass' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain('still driving this device');
  });

  it('a read-only call on the same session is not annotated', async () => {
    const r = (await client.callTool({ name: 'qa_status', arguments: { sessionId } })) as CallToolResult;
    expect(text(r)).not.toContain('still driving this device');
  });

  it('host-only jobs and finished jobs do not trigger the note', async () => {
    const s = ctx.sessions.get(sessionId)!;
    expect(ctx.sessions.cancelJob(s, jobId)).toBe(true);
    expect(runningJobNote(ctx.sessions, 'qa_act', sessionId)).toBeUndefined();
    ctx.sessions.createJob(s, 'build:android');
    ctx.sessions.createJob(s, 'bundletool:convert');
    expect(runningJobNote(ctx.sessions, 'qa_act', sessionId)).toBeUndefined();
    const r = (await client.callTool({ name: 'qa_network', arguments: { sessionId, action: 'status' } })) as CallToolResult;
    expect(text(r)).not.toContain('still driving this device');
  });
});
