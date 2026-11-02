// Every caller of generateSessionReport hands back report.html (absolute path + file:// URL):
// qa_report, the qa_test_this terminal envelope (and so qa_job_status), qa_test_feature and
// qa_mobile_audit. Jobs that report from inside themselves never mark their own report partial.
// qa_report's inline JSON leaves the step timeline out.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buttonScreen, FakeDriver, harness, structured } from './actFixFake.js';
import { createFinisher } from '../src/orchestration/testThis/terminal.js';
import type { ExecuteArgs } from '../src/orchestration/testThis/types.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('report-callers');
});
afterAll(async () => {
  await h.close();
});

const expectHtml = (r: Record<string, unknown>) => {
  expect(String(r.reportHtmlPath)).toMatch(/[\\/]report[\\/]report\.html$/);
  expect(String(r.reportHtmlUrl)).toMatch(/^file:\/\/.*report\.html$/);
  expect(existsSync(String(r.reportHtmlPath))).toBe(true);
};

async function waitForJob(id: string, jobId: string) {
  for (let i = 0; i < 60; i++) {
    const s = structured(await h.call('qa_job_status', { sessionId: id, jobId, waitMs: 2000 }));
    if (s.status !== 'running') return s;
  }
  throw new Error('job did not finish');
}

describe('qa_report', () => {
  it('returns reportHtmlPath and reportHtmlUrl', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    const s = structured(await h.call('qa_report', { sessionId: id }));
    expectHtml(s);
    expect(String(s.summary ?? '')).toContain('Open the report:');
  });

  it('format:"json" on a 500-step run leaves out steps, points at report.json, and stays under 40 KB', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    const session = h.sessions.get(id)!;
    for (let i = 0; i < 500; i++)
      h.sessions.addStep(session, { durationMs: 10, source: 'act', action: 'tap', target: `tap "Button number ${i}"`, result: 'ok' });
    expect(session.steps).toHaveLength(500);
    const res = await h.call('qa_report', { sessionId: id, format: 'json' });
    const s = structured(res);
    expect(s).not.toHaveProperty('steps');
    expect(s.stepsUri).toBe(s.reportUri);
    expect(s.schemaVersion).toBe(2);
    const inline =
      (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('') + JSON.stringify(res.structuredContent);
    expect(Buffer.byteLength(inline)).toBeLessThan(40 * 1024);
  });
});

describe('qa_test_this terminal envelope', () => {
  it('lands reportHtmlPath on job.result (qa_job_status passes it through) and the report is not partial', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    const session = h.sessions.get(id)!;
    h.sessions.milestone(session, 'app_launch_end');
    const job = h.sessions.createJob(session, 'test_this:execute');
    const finish = createFinisher({
      sessions: h.sessions,
      session,
      job,
      a: { requiredOutputs: ['reportUri'], releaseGate: false } as unknown as ExecuteArgs,
      attempted: [],
      artifacts: [],
      getSuiteForReport: () => undefined,
      upd: (patch) => h.sessions.updateJobIfRunning(session, job, patch),
    });
    await finish('completed', undefined, 'run completed');
    const result = session.jobs.get(job.jobId)!.result as Record<string, unknown>;
    expectHtml(result);
    const status = structured(await h.call('qa_job_status', { sessionId: id, jobId: job.jobId }));
    expect((status.result as Record<string, unknown>).reportHtmlPath).toBe(result.reportHtmlPath);
    const reportPath = h.sessions.findArtifact(String(result.reportUri))!.rec.path;
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).partial).toBeNull();
  });
});

describe('qa_mobile_audit execute', () => {
  it('returns reportHtmlPath and reportHtmlUrl', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    const s = structured(await h.call('qa_mobile_audit', { sessionId: id, profile: 'smoke', mode: 'execute' }));
    expectHtml(s);
  });
});

describe('qa_test_feature execute', () => {
  it('lands reportHtmlPath on the job result and its own job does not make the report partial', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Settings', 3)));
    const session = h.sessions.get(id)!;
    mkdirSync(join(session.root, 'src', 'screens'), { recursive: true });
    writeFileSync(join(session.root, 'src', 'screens', 'SettingsScreen.tsx'), 'export function SettingsScreen() { return null; }\n');
    const started = structured(
      await h.call('qa_test_feature', { sessionId: id, feature: 'settings', mode: 'execute', maxScreens: 1, maxActions: 1 }),
    );
    const jobId = String(started.jobId ?? '');
    expect(jobId).not.toBe('');
    const done = await waitForJob(id, jobId);
    const result = done.result as Record<string, unknown>;
    expectHtml(result);
    const { readFileSync } = await import('node:fs');
    const reportPath = h.sessions.findArtifact(String(result.reportUri))!.rec.path;
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).partial).toBeNull();
  });
});
