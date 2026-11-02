// 2.3.0 results: lean qa_report structuredContent + report.md, error text complete and
// deduplicated, compact consent / needs-input prompts, qa_doctor trims, terminal
// results, inline images.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buttonScreen, FakeDriver, harness, structured, textOf } from './actFixFake.js';
import { ERROR_TEXT_MAX_CHARS, qaError, runWithResponseMode } from '../src/lib/result.js';
import { requireConsent } from '../src/consent/consent.js';
import { NeedsInput, qaNeedsInput } from '../src/lib/needsInput.js';
import { buildReportHead, REPORT_HEAD_MAX_CHARS } from '../src/report/head.js';
import { blockerFixAction, createFinisher } from '../src/orchestration/testThis/terminal.js';
import { typedBlockerFromCode } from '../src/orchestration/envelope.js';
import { INLINE_IMAGE_MAX_EDGE, prepareInlineImage } from '../src/lib/image.js';
import { sdkToolMajor } from '../src/tools/doctor.js';
import { SessionStore } from '../src/session/store.js';
import type { ExecuteArgs } from '../src/orchestration/testThis/types.js';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A valid (real CRCs) 8-bit RGB PNG, so sips accepts it. */
function realPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) raw[row + 1 + x * 3] = (x * 7) & 0xff;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('error text', () => {
  it('head carries the failure code, what, next steps; the fence carries only the rest (no repeats)', () => {
    const accepted = ['sessionId', 'action', 'target'];
    const r = qaError(
      {
        what: 'qa_act: invalid arguments',
        changedState: false,
        retrySafe: true,
        failureCode: 'INVALID_ARGUMENT',
        nextSteps: [`Fix it. Accepted parameters: ${accepted.map((a) => `"${a}"`).join(', ')}.`, 'Restart the client if stale.'],
      },
      { acceptedParameters: accepted, invalidArguments: [{ path: 'action', message: 'bad enum' }] },
    );
    const text = textOf(r);
    expect(text.startsWith('❌ INVALID_ARGUMENT: qa_act: invalid arguments')).toBe(true);
    expect(text).toContain('- Restart the client if stale.');
    const fence = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]) as Record<string, unknown>;
    expect(Object.keys(fence)).toEqual(['invalidArguments']); // what/nextSteps/acceptedParameters not repeated
    expect(text.match(/qa_act: invalid arguments/g)).toHaveLength(1);
    // structuredContent keeps every field.
    expect(r.structuredContent).toMatchObject({
      failureCode: 'INVALID_ARGUMENT',
      acceptedParameters: accepted,
      nextSteps: expect.any(Array),
    });
  });

  it('is complete in compact mode too, and bounded under the Claude Code truncation threshold', () => {
    const r = runWithResponseMode('compact', () =>
      qaError({ what: 'x', changedState: false, retrySafe: true, nextSteps: ['a'] }, { candidates: ['@e1 Pay'] }),
    );
    expect(textOf(r)).toContain('"candidates":["@e1 Pay"]');
    const big = qaError(
      { what: 'w'.repeat(5000), changedState: false, retrySafe: true, nextSteps: Array.from({ length: 20 }, () => 's'.repeat(2000)) },
      { blob: 'b'.repeat(8000), more: 'm'.repeat(8000) },
    );
    expect(textOf(big).length).toBeLessThanOrEqual(ERROR_TEXT_MAX_CHARS);
    expect(textOf(big).startsWith('❌ UNKNOWN: www')).toBe(true);
  });
});

describe('consent and needs-input prompts', () => {
  it('consent: exactCommand not repeated inside explain; compact fence; none in compact mode', () => {
    const cmd = 'adb install app.apk\nadb shell am start x';
    const r = requireConsent({
      action: 'test_this_plan',
      risk: 'medium',
      exactCommand: cmd,
      explain: `Needs these steps:\n${cmd}\nApprove to start.`,
    });
    const sc = r.structuredContent as Record<string, unknown>;
    // The intro points at exactCommand instead of ending in a dangling colon.
    expect(sc.explain).toBe('Needs these steps (listed in exactCommand).\nApprove to start.');
    expect(sc.exactCommand).toBe(cmd);
    const text = textOf(r);
    expect(text.split('adb install app.apk')).toHaveLength(2); // once, under "Will run:"
    expect(text).toContain('```json\n{"action":"test_this_plan"}\n```');
    const compact = runWithResponseMode('compact', () => requireConsent({ action: 'a', risk: 'low', explain: 'ok?' }));
    expect(textOf(compact)).not.toContain('```');
  });

  it('needs-input: compact fence without the fields the head shows', () => {
    const r = qaNeedsInput(NeedsInput.credentials(), { sessionId: 's1' });
    const text = textOf(r);
    const fence = text.match(/```json\n([\s\S]*?)\n```/)![1];
    expect(fence).not.toContain('\n');
    const parsed = JSON.parse(fence) as Record<string, unknown>;
    expect(parsed.question).toBeUndefined();
    expect(parsed.resume).toBeTruthy();
    expect(String((r.structuredContent as Record<string, unknown>).question)).toMatch(
      /Recommended: set SWIPIUM_TEST_EMAIL and SWIPIUM_TEST_PASSWORD/,
    );
  });
});

describe('report head + blocked fix', () => {
  it('report head: verdicts, high findings first with evidence, failures, report.md pointer; capped', () => {
    const report = {
      executiveSummary: { risk: 'block', nextAction: 'Fix "checkout".' },
      appVerdict: { status: 'BLOCKED', summary: 'Pay does nothing' },
      coverageVerdict: { status: 'COVERED', summary: 'ok' },
      toolVerdict: { status: 'PASS', summary: 'ok' },
      highSeverityCount: 1,
      findings: [
        { severity: 'low', layer: 'app', kind: 'x', detail: 'minor' },
        {
          severity: 'high',
          layer: 'native',
          kind: 'crash',
          detail: 'boom',
          screenshotUri: 'swipium://session/s/screenshot/1.png',
          count: 3,
        },
      ],
      outcomeTally: { pass: 1, fail: 1 },
      testOutcomes: [
        { workflow: 'login', outcome: 'pass' },
        { workflow: 'checkout', outcome: 'fail', reason: 'Pay does nothing', artifactUris: ['swipium://session/s/screenshot/2.png'] },
      ],
    };
    const head = buildReportHead(report, {
      reportMdUri: 'swipium://session/s/report/r.md',
      reportUri: 'swipium://session/s/report/r.json',
    });
    const lines = head.split('\n');
    expect(lines[0]).toBe('RELEASE RISK: BLOCK: Fix "checkout".');
    expect(head.indexOf('native/crash')).toBeLessThan(head.indexOf('app/x'));
    expect(head).toContain('(x3) swipium://session/s/screenshot/1.png');
    expect(head).toContain('- FAIL checkout FAILED "Pay does nothing": swipium://session/s/screenshot/2.png');
    expect(lines[lines.length - 1]).toBe('report.md: swipium://session/s/report/r.md');
    const many = { ...report, findings: Array.from({ length: 50 }, () => ({ severity: 'high', detail: 'd'.repeat(400) })) };
    const capped = buildReportHead(many, { reportMdUri: 'swipium://x.md' });
    expect(capped.length).toBeLessThanOrEqual(REPORT_HEAD_MAX_CHARS);
    expect(capped.endsWith('report.md: swipium://x.md')).toBe(true);
  });

  it('blocked: nextRecommendedAction is the blocker fix tool when Swipium can fill it, else null', () => {
    expect(blockerFixAction(typedBlockerFromCode('EMULATOR_BOOT_FAILED'), 's1')).toMatchObject({ tool: 'qa_doctor', args: {} });
    expect(blockerFixAction(typedBlockerFromCode('INSTALL_FAILED'), 's1')).toBeNull();
    // "re-run qa_test_this" is the step after the fix, never the recommendation itself.
    expect(blockerFixAction(typedBlockerFromCode('ADB_NOT_FOUND'), 's1')).toBeNull();
    expect(typedBlockerFromCode('NOT_A_CODE').howToFix).not.toMatch(/qa_explain_blocker/);
  });

  it('finisher: completed inlines the report head (structured + text) and points at report.md; blocked carries the fix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swipium-results-'));
    try {
      const sessions = new SessionStore();
      const session = sessions.create(root);
      // The app was reached (a launch): a run with no evidence at all is BLOCK / NOT_RUN.
      sessions.milestone(session, 'app_launch_end');
      const run = async (state: 'completed' | 'blocked', code?: string) => {
        const job = sessions.createJob(session, 'test_this:execute');
        const finish = createFinisher({
          sessions,
          session,
          job,
          a: { requiredOutputs: ['reportUri'], releaseGate: false } as unknown as ExecuteArgs,
          attempted: ['install'],
          artifacts: [],
          getSuiteForReport: () => undefined,
          upd: (patch) => sessions.updateJobIfRunning(session, job, patch),
        });
        await finish(state, code, `run ${state}`);
        return session.jobs.get(job.jobId)!;
      };
      const done = await run('completed');
      const r = done.result as Record<string, unknown>;
      expect(String(r.reportMdUri)).toMatch(/report-\d+-summary\.md$/);
      expect(r.nextRecommendedAction).toMatchObject({ tool: 'qa_get_artifact', args: { uri: r.reportMdUri } });
      expect(String(r.reportHead)).toContain('Health: native');
      expect(String(r.reportHtmlPath)).toMatch(/report\/report\.html$/);
      expect(String(r.reportHead).length).toBeLessThanOrEqual(REPORT_HEAD_MAX_CHARS);
      expect(done.resultText).toContain(String(r.reportHead));

      const blocked = await run('blocked', 'INSTALL_FAILED');
      const b = blocked.result as Record<string, unknown>;
      expect(b.nextRecommendedAction).toBeNull();
      expect(b.reportHead).toBeUndefined();
      expect(blocked.resultText).toMatch(/fix \(INSTALL_FAILED\): Check the surfaced reason/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('doctor version parsing', () => {
  it('reads platform-tools / emulator majors', () => {
    expect(sdkToolMajor('Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458\nInstalled as /x')).toBe(35);
    expect(sdkToolMajor('INFO | Android emulator version 36.1.9.0 (build_id 1)')).toBe(36);
    expect(sdkToolMajor('Android Debug Bridge version 1.0.41')).toBeNull();
  });
});

describe('inline images', () => {
  it.runIf(process.platform === 'darwin')('downscales a large PNG to a 1568 px JPEG with the scale (macOS sips)', async () => {
    const img = await prepareInlineImage(realPng(1080, 2400), 'image/png');
    expect(img.resized).toBe(true);
    expect(img.mime).toBe('image/jpeg');
    expect(img.height).toBe(INLINE_IMAGE_MAX_EDGE);
    expect(img.scale).toBeCloseTo(INLINE_IMAGE_MAX_EDGE / 2400, 2);
  });

  it('keeps a small image as-is', async () => {
    const png = realPng(100, 200);
    const img = await prepareInlineImage(png, 'image/png');
    expect(img).toMatchObject({ resized: false, scale: 1, mime: 'image/png', width: 100, height: 200 });
    expect(img.data).toBe(png);
  });
});

describe('over MCP', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    h = await harness('results');
  });
  afterAll(async () => {
    await h.close();
  });

  class ShotDriver extends FakeDriver {
    override async screenshot() {
      return realPng(1080, 2400);
    }
  }

  it('qa_report structuredContent is the lean view + report.md; format:"json" returns the full report', async () => {
    const fake = new ShotDriver(buttonScreen('Home', 6));
    const id = await h.start(fake);
    await h.call('qa_note', { sessionId: id, workflow: 'checkout', outcome: 'fail', reason: 'Pay does nothing', category: 'app_bug' });
    const lean = structured(await h.call('qa_report', { sessionId: id }));
    expect(lean).toMatchObject({ ok: true, appVerdict: { status: 'BLOCKED' }, counts: { outcomes: { fail: 1 } } });
    expect(String(lean.summary)).toContain('RELEASE RISK');
    expect(String(lean.reportMdUri)).toMatch(/summary\.md$/);
    expect(lean.manifest).toBeUndefined();
    expect(lean.automationReadiness).toBeUndefined();
    const md = await h.call('qa_get_artifact', { uri: lean.reportMdUri });
    expect(textOf(md)).toContain('RELEASE RISK');
    const full = structured(await h.call('qa_report', { sessionId: id, format: 'json' }));
    expect(full.automationReadiness).toBeTruthy();
    expect(full.manifest).toBeTruthy();
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(full).length / 2);
  });

  it('qa_screenshot inline:true returns text + image (codex/imageDetail meta), never structuredContent', async () => {
    const id = await h.start(new ShotDriver(buttonScreen('Home', 3)));
    const res = await h.call('qa_screenshot', { sessionId: id, inline: true });
    expect(res.structuredContent).toBeUndefined();
    const [t, img] = res.content as Array<Record<string, unknown>>;
    expect(t.type).toBe('text');
    expect(String(t.text)).toMatch(/inline image: /);
    expect(img).toMatchObject({ type: 'image', _meta: { 'codex/imageDetail': 'auto' } });
    if (process.platform === 'darwin') {
      expect(img.mimeType).toBe('image/jpeg');
      expect(String(t.text)).toMatch(/divide inline image coordinates by 0\.65\d* to get screenshot pixels/);
    }
    const uri = String(t.text).match(/swipium:\/\/session\/\S+\.png/)![0];
    const got = await h.call('qa_get_artifact', { uri, mode: 'inline' });
    expect(got.structuredContent).toBeUndefined();
    expect((got.content as Array<Record<string, unknown>>)[1]).toMatchObject({ type: 'image', _meta: { 'codex/imageDetail': 'auto' } });
  });
});
