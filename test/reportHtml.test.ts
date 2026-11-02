// report.html: self-contained, escaped, failure-first, with thumbnails embedded under a size budget.

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCS_ORIGIN, HTML_CSP, HTML_IMAGE_BUDGET_BYTES, renderReportHtml } from '../src/report/html.js';
import type { ReportData, ReportStep } from '../src/report/export.js';
import { decodePng, encodePngRgb } from '../src/lib/png.js';

const PNG_DIR = join(__dirname, 'fixtures', 'png');
const ANDROID_PNG = join(PNG_DIR, 'android-screencap-redbox-1344x2992.png');
const IOS_PNG = join(PNG_DIR, 'ios-simctl-redbox-1206x2622.png');
const WDA_PNG = join(PNG_DIR, 'ios-wda-map-home-1206x2622.png');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function sessionDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swipium-html-'));
  tmpDirs.push(d);
  mkdirSync(join(d, 'screenshots'), { recursive: true });
  mkdirSync(join(d, 'logs'), { recursive: true });
  mkdirSync(join(d, 'report'), { recursive: true });
  return d;
}

function baseReport(over: Partial<ReportData> = {}): ReportData {
  return {
    sessionId: 's1',
    appId: 'com.example.demo',
    device: 'emulator-5554',
    coverage: 'smoke',
    executiveSummary: { risk: 'ship', reasons: ['all good'], nextAction: 'Ship it.' },
    nativeHealth: 'OK',
    appHealth: 'OK',
    findings: [],
    highSeverityCount: 0,
    testOutcomes: [],
    outcomeTally: {},
    environmentChanges: [],
    guardrailOverrides: [],
    finalNetwork: 'online',
    networkRestore: 'unchanged',
    authState: 'unknown',
    phaseTimings: { totalMs: 12_000, setupMs: 2000, activeMs: 10_000, timeToLoginMs: null },
    artifacts: [],
    schemaVersion: 2,
    steps: [],
    ...over,
  };
}

const shotUri = (name: string, kind = 'screenshot') => `swipium://session/s1/${kind}/${name}`;
function addShot(dir: string, name: string, src = ANDROID_PNG, kind = 'screenshot') {
  copyFileSync(src, join(dir, 'screenshots', name));
  return { uri: shotUri(name, kind), kind, path: `screenshots/${name}`, createdAt: 1, redaction: 'not-applied' };
}

function step(i: number, over: Partial<ReportStep> = {}): ReportStep {
  return { i, at: 1000 + i, durationMs: 120, source: 'act', action: 'tap', target: `tap "Button ${i}"`, result: 'ok', ...over };
}

/** Every href / src in the page, to check nothing points off the page. */
function attrs(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'gi'))].map((m) => m[1]);
}

function assertSelfContained(html: string) {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/url\(/i);
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`);
  expect(HTML_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  for (const src of attrs(html, 'src')) expect(src.startsWith('data:image/png;base64,')).toBe(true);
  for (const href of attrs(html, 'href')) expect(href.startsWith(`${DOCS_ORIGIN}/`) || href.startsWith('#')).toBe(true);
  // No unquoted or single-quoted src/href slipped past the attribute scan.
  expect(html).not.toMatch(/<[^>]*\s(src|href)\s*=\s*[^"\s][^>]*>/i);
  // Every attribute is one we expect: no event handlers.
  expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
}

describe('report.html', () => {
  const XSS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'><b onmouseover=x>"];

  it('renders hostile text in names, details, screens and targets as plain text', async () => {
    const r = baseReport({
      executiveSummary: { risk: 'block', reasons: [XSS[0]], nextAction: XSS[1] },
      testOutcomes: [
        { workflow: XSS[0], outcome: 'fail', reason: XSS[1], stepRange: [1, 2] },
        { workflow: XSS[1], outcome: 'pass', evidence: [XSS[2]] },
      ],
      findings: [{ severity: 'high', kind: XSS[2], detail: XSS[0], screen: XSS[1], evidence: XSS[2], failureCode: XSS[0] }],
      steps: [step(1, { target: XSS[1], screen: XSS[0] }), step(2, { result: 'failed', target: XSS[0], failureCode: XSS[2] })],
      environmentChanges: [XSS[1]],
      artifacts: [{ uri: XSS[1], kind: 'screenshot', label: XSS[0] }],
      partial: { jobId: XSS[0], kind: XSS[1] },
    });
    const html = await renderReportHtml(r, {});
    assertSelfContained(html);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&#39;&gt;&lt;b onmouseover=x&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it('pass run: gate banner first, timeline closed, checkpoint thumbnails embedded', async () => {
    const dir = sessionDir();
    const cp = addShot(dir, 'checkpoint-1.png', IOS_PNG, 'checkpoint');
    const r = baseReport({
      testOutcomes: [{ workflow: 'Login', outcome: 'pass', origin: 'agent', evidence: [cp.uri], stepRange: [1, 2] }],
      steps: [step(1), step(2, { source: 'note', action: 'check', screenshotUri: cp.uri })],
      artifacts: [cp],
    });
    const html = await renderReportHtml(r, {
      sessionDir: dir,
      policy: { block: false, blocked: [], warned: [], suppressed: [], reason: 'all required flows passed' },
    });
    assertSelfContained(html);
    expect(html.indexOf('Release gate: PASS')).toBeGreaterThan(-1);
    expect(html.indexOf('Release gate: PASS')).toBeLessThan(html.indexOf('id="failures"'));
    expect(html).toContain('all required flows passed');
    expect(html).toContain('<details id="timeline">');
    expect(html).not.toContain('<details id="timeline" open>');
    expect(html.match(/<img /g)?.length).toBe(1); // the step reuses the outcome thumbnail
    expect(html).toContain('href="#ev-1"');
    expect(html).toContain('may contain sensitive pixels');
    expect(html).toContain('screenshots/checkpoint-1.png');
    // Section order: failures, outcomes, timeline, environment, artifacts.
    const order = ['id="failures"', 'id="outcomes"', 'id="timeline"', 'id="env"', 'id="artifacts"'].map((s) => html.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('fail run: failure card with screenshot, failing step, code and log tail; timeline open', async () => {
    const dir = sessionDir();
    const fail = addShot(dir, 'fail-2.png', ANDROID_PNG);
    writeFileSync(join(dir, 'logs', 'logcat.txt'), Array.from({ length: 100 }, (_, i) => `logcat line ${i}`).join('\n'));
    const logArt = { uri: 'swipium://session/s1/logcat/logcat.txt', kind: 'logcat', path: 'logs/logcat.txt' };
    const r = baseReport({
      executiveSummary: { risk: 'block', reasons: ['Checkout failed'], nextAction: 'Fix checkout.' },
      testOutcomes: [
        { workflow: 'Checkout', outcome: 'fail', origin: 'flow', stepRange: [1, 3], evidence: [fail.uri] },
        { workflow: 'Login', outcome: 'pass', origin: 'agent', stepRange: [4, 4] },
      ],
      findings: [{ severity: 'high', kind: 'crash', failureCode: 'NATIVE_CRASH', detail: 'FATAL EXCEPTION main', logUri: logArt.uri }],
      steps: [
        step(1),
        step(2, {
          source: 'flow',
          action: 'assertVisible',
          target: 'assertVisible "Pay"',
          result: 'failed',
          failureCode: 'ELEMENT_NOT_FOUND',
          screenshotUri: fail.uri,
        }),
        step(3),
        step(4),
      ],
      artifacts: [fail, logArt],
    });
    const html = await renderReportHtml(r, { sessionDir: dir });
    assertSelfContained(html);
    expect(html).toContain('Release gate: BLOCK');
    expect(html).toContain('Failing step:</strong> #2 assertVisible &quot;Pay&quot;');
    expect(html).toContain('<code>ELEMENT_NOT_FOUND</code>');
    expect(html).toContain('logcat line 99');
    expect(html).not.toContain('logcat line 59'); // last 40 lines only
    expect(html).toContain('<details id="timeline" open>');
    expect(html).toContain('(no evidence)');
    const failCard = html.indexOf('Failing step');
    expect(html.indexOf('<img ')).toBeLessThan(failCard); // screenshot inside the failure card
    expect(html.indexOf('<img ')).toBeLessThan(html.indexOf('<table'));
  });

  it('outcome flags: unverified, contradicted, flaky with attempts', async () => {
    const r = baseReport({
      testOutcomes: [
        { workflow: 'A', outcome: 'pass', unverified: true, origin: 'agent' },
        { workflow: 'B', outcome: 'pass', contradicted: true, origin: 'flow' },
        { workflow: 'C', outcome: 'fail', origin: 'flow' },
        { workflow: 'c ', outcome: 'pass', origin: 'flow' },
      ],
    });
    const html = await renderReportHtml(r, {});
    expect(html).toContain('>unverified<');
    expect(html).toContain('>contradicted<');
    expect(html).toContain('flaky (attempts: fail, pass)');
    // latest attempt wins: one row for C
    const outcomes = html.slice(html.indexOf('id="outcomes"'), html.indexOf('id="timeline"'));
    expect(outcomes.match(/<tr><td>/g)?.length).toBe(3);
  });

  it('blocked run: blocker, fix and log tail before any table, nothing else', async () => {
    const dir = sessionDir();
    writeFileSync(join(dir, 'logs', 'metro.log'), Array.from({ length: 60 }, (_, i) => `metro ${i}`).join('\n'));
    const r = baseReport({
      executiveSummary: { risk: 'block', reasons: ['Metro not running'], nextAction: 'Start Metro with npx expo start.' },
      notTested: { reachedApp: false, reason: 'Metro bundler is not running', failureCode: 'METRO_REQUIRED' },
      findings: [{ severity: 'high', kind: 'other', detail: 'should not render here' }],
      testOutcomes: [{ workflow: 'should not render', outcome: 'blocked' }],
      steps: [step(1, { source: 'smoke', action: 'launch', result: 'failed', failureCode: 'METRO_REQUIRED' })],
      artifacts: [{ uri: 'swipium://session/s1/metro/metro.log', kind: 'metro', createdAt: 5 }],
    });
    const html = await renderReportHtml(r, { sessionDir: dir });
    assertSelfContained(html);
    const firstTable = html.indexOf('<table');
    expect(firstTable).toBeGreaterThan(-1);
    for (const s of ['NOT TESTED', 'Metro bundler is not running', 'METRO_REQUIRED', 'Start Metro with npx expo start.', 'metro 59']) {
      expect(html.indexOf(s)).toBeGreaterThan(-1);
      expect(html.indexOf(s)).toBeLessThan(firstTable);
    }
    expect(html).not.toContain('metro 19');
    expect(html).not.toContain('should not render');
    expect(html).not.toContain('id="outcomes"');
    expect(html).not.toContain('id="artifacts"');
    expect(html).toContain('<details id="timeline" open>');
  });

  it('blocked run without a log says no log captured', async () => {
    const r = baseReport({ notTested: { reachedApp: false, reason: 'no device', failureCode: 'NO_DEVICE' } });
    const html = await renderReportHtml(r, {});
    expect(html).toContain('no log captured');
  });

  it('partial report banner names the running job', async () => {
    const html = await renderReportHtml(baseReport({ partial: { jobId: 'job-42', kind: 'explore' } }), {});
    expect(html).toContain('partial: job job-42 running');
    expect(html.indexOf('partial: job job-42 running')).toBeLessThan(html.indexOf('id="failures"'));
    const blocked = await renderReportHtml(
      baseReport({ partial: { jobId: 'job-7', kind: 'suite' }, notTested: { reachedApp: false, reason: 'x' } }),
      {},
    );
    expect(blocked).toContain('partial: job job-7 running');
    expect(await renderReportHtml(baseReport(), {})).not.toContain('partial:');
  });

  it('an undecodable PNG becomes a path, never a failure', async () => {
    const dir = sessionDir();
    // 16-bit PNG header: valid signature and IHDR, but a depth the decoder refuses.
    const bad = Buffer.from(readFileSync(IOS_PNG));
    bad[24] = 16;
    writeFileSync(join(dir, 'screenshots', 'bad.png'), bad);
    writeFileSync(join(dir, 'screenshots', 'junk.png'), 'not a png at all');
    const r = baseReport({
      testOutcomes: [
        { workflow: 'A', outcome: 'pass', evidence: [shotUri('bad.png')] },
        { workflow: 'B', outcome: 'pass', evidence: [shotUri('junk.png')] },
      ],
      artifacts: [
        { uri: shotUri('bad.png'), kind: 'screenshot', path: 'screenshots/bad.png' },
        { uri: shotUri('junk.png'), kind: 'screenshot', path: 'screenshots/junk.png' },
      ],
    });
    const html = await renderReportHtml(r, { sessionDir: dir });
    expect(html).not.toContain('<img ');
    expect(html).toContain('<code>screenshots/bad.png</code> (could not embed this image)');
    expect(html).toContain('<code>screenshots/junk.png</code> (could not embed this image)');
  });

  it('resolves a screenshot from its URI when the artifact has no path (older reports)', async () => {
    const dir = sessionDir();
    copyFileSync(IOS_PNG, join(dir, 'screenshots', 'old.png'));
    const r = baseReport({
      testOutcomes: [{ workflow: 'launch_smoke', outcome: 'pass', artifactUris: [shotUri('old.png')] }],
      artifacts: [{ uri: shotUri('old.png'), kind: 'screenshot' }],
    });
    expect(await renderReportHtml(r, { sessionDir: dir })).toContain('src="data:image/png;base64,');
    const noDir = await renderReportHtml(r, {});
    expect(noDir).toContain('evidence not available');
    expect(noDir).not.toContain('<img ');
  });

  it('refuses artifact paths that escape the session folder', async () => {
    const dir = sessionDir();
    const outside = sessionDir();
    copyFileSync(IOS_PNG, join(outside, 'secret.png'));
    const r = baseReport({
      testOutcomes: [{ workflow: 'A', outcome: 'pass', evidence: ['swipium://session/s1/screenshot/x.png'] }],
      artifacts: [{ uri: 'swipium://session/s1/screenshot/x.png', kind: 'screenshot', path: join(outside, 'secret.png') }],
    });
    const html = await renderReportHtml(r, { sessionDir: dir });
    expect(html).not.toContain('<img ');
    expect(html).toContain('evidence not available');
  });

  it('never reads dotfiles, .. paths, symlinks out of the folder or FIFOs named by the report', async () => {
    const dir = sessionDir();
    const outside = sessionDir();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), 'extraheader = AUTHORIZATION: basic SECRET-DOTFILE');
    writeFileSync(join(outside, 'id_rsa'), 'SECRET-OUTSIDE');
    symlinkSync(join(outside, 'id_rsa'), join(dir, 'logs', 'build.log'));
    copyFileSync(IOS_PNG, join(outside, 'secret.png'));
    symlinkSync(join(outside, 'secret.png'), join(dir, 'screenshots', 'linked.png'));
    const fifo = process.platform !== 'win32';
    if (fifo) execFileSync('mkfifo', [join(dir, 'logs', 'pipe.log')]);
    const logs = [
      { uri: 'swipium://session/s1/logs/a.log', kind: 'logs', path: '.git/config' },
      { uri: 'swipium://session/s1/logs/b.log', kind: 'logs', path: 'logs/../.git/config' },
      { uri: 'swipium://session/s1/logs/build.log', kind: 'logs', path: 'logs/build.log' },
      // URI-only fallback with a dot-prefixed kind.
      { uri: 'swipium://session/s1/.git/config', kind: 'log' },
      ...(fifo ? [{ uri: 'swipium://session/s1/logs/pipe.log', kind: 'logs', path: 'logs/pipe.log' }] : []),
    ];
    const linked = { uri: shotUri('linked.png'), kind: 'screenshot', path: 'screenshots/linked.png' };
    const r = baseReport({
      findings: logs.map((l) => ({ severity: 'high' as const, kind: 'crash', detail: 'x', logUri: l.uri })),
      testOutcomes: [{ workflow: 'A', outcome: 'pass', evidence: [linked.uri] }],
      artifacts: [...logs, linked],
    });
    const html = await renderReportHtml(r, { sessionDir: dir });
    expect(html).not.toContain('SECRET');
    expect(html).not.toContain('<img ');
    expect(html.match(/: not available<\/p>/g)?.length).toBe(logs.length);
    // The blocked layout goes through the same lookup.
    const blocked = await renderReportHtml(
      baseReport({ notTested: { reachedApp: false, reason: 'build', failureCode: 'BUILD_FAILED' }, artifacts: [logs[2]] }),
      { sessionDir: dir },
    );
    expect(blocked).not.toContain('SECRET');
    expect(blocked).toContain('not available');
  });

  it('failed outcome card shows the tail of a crash log captured during its steps', async () => {
    const dir = sessionDir();
    writeFileSync(join(dir, 'logs', 'crash.txt'), Array.from({ length: 50 }, (_, i) => `crash line ${i}`).join('\n'));
    const logArt = { uri: 'swipium://session/s1/logcat/crash.txt', kind: 'logcat', path: 'logs/crash.txt' };
    const r = baseReport({
      testOutcomes: [
        { workflow: 'Checkout', outcome: 'fail', stepRange: [1, 2] },
        { workflow: 'Profile', outcome: 'fail', stepRange: [3, 3] },
      ],
      steps: [step(1, { at: 1000 }), step(2, { at: 2000, result: 'failed', failureCode: 'ELEMENT_NOT_FOUND' }), step(3, { at: 9000 })],
      // Logged during Checkout's steps only, and not a crash code: Profile must not show it.
      findings: [{ severity: 'high', kind: 'crash', detail: 'FATAL', logUri: logArt.uri, at: 2050 }],
      artifacts: [logArt],
    });
    const html = await renderReportHtml(r, { sessionDir: dir });
    const cards = html.slice(html.indexOf('id="failures"'), html.indexOf('id="outcomes"')).split('<div class="card">');
    const checkout = cards.find((c) => c.includes('Checkout'))!;
    const profile = cards.find((c) => c.includes('Profile'))!;
    expect(checkout).toContain('last 20 lines of <code>logs/crash.txt</code>');
    expect(checkout).toContain('crash line 49');
    expect(checkout).not.toContain('crash line 29');
    expect(profile).not.toContain('crash line');
  });

  it('failed launch outcome shows the crash log even without timestamps', async () => {
    const dir = sessionDir();
    writeFileSync(join(dir, 'logs', 'crash.txt'), 'FATAL EXCEPTION: main');
    const logArt = { uri: 'swipium://session/s1/logcat/crash.txt', kind: 'logcat', path: 'logs/crash.txt' };
    const r = baseReport({
      testOutcomes: [{ workflow: 'launch_smoke', outcome: 'fail', category: 'APP_LAUNCH_FAILED' }],
      findings: [{ severity: 'high', kind: 'crash', detail: 'FATAL', logUri: logArt.uri }],
      artifacts: [logArt],
    });
    const html = await renderReportHtml(r, { sessionDir: dir });
    const card = html.slice(html.indexOf('id="failures"'), html.indexOf('id="outcomes"')).split('<div class="card">')[1];
    expect(card).toContain('launch_smoke');
    expect(card).toContain('FATAL EXCEPTION: main');
  });

  it('thumbnails are 480 px wide and keep the aspect ratio', async () => {
    const dir = sessionDir();
    const a = addShot(dir, 'a.png', ANDROID_PNG);
    const html = await renderReportHtml(
      baseReport({ testOutcomes: [{ workflow: 'A', outcome: 'pass', evidence: [a.uri] }], artifacts: [a] }),
      {
        sessionDir: dir,
      },
    );
    const b64 = /src="data:image\/png;base64,([^"]+)"/.exec(html)![1];
    const img = decodePng(Buffer.from(b64, 'base64'));
    expect(img.width).toBe(480);
    expect(Math.abs(img.height - Math.round((2992 * 480) / 1344))).toBeLessThanOrEqual(1);
  });

  it('200 steps and 40 real-size screenshots: all 40 embedded within 8 MB', { timeout: 120_000 }, async () => {
    const dir = sessionDir();
    const sources = [ANDROID_PNG, IOS_PNG, WDA_PNG];
    const arts = Array.from({ length: 40 }, (_, k) => addShot(dir, `s${k}.png`, sources[k % 3]));
    const steps = Array.from({ length: 200 }, (_, k) =>
      step(k + 1, k % 5 === 0 ? { screenshotUri: arts[k / 5].uri, ...(k === 0 ? { result: 'failed', failureCode: 'X' } : {}) } : {}),
    );
    const html = await renderReportHtml(baseReport({ steps, artifacts: arts }), { sessionDir: dir });
    const embedded = attrs(html, 'src');
    expect(embedded.length).toBe(40);
    const total = embedded.reduce((n, s) => n + s.length, 0);
    expect(total).toBeLessThanOrEqual(HTML_IMAGE_BUDGET_BYTES);
    expect(html).not.toContain('image budget');
    // The budget is for images; the markup on top of it stays small, so the whole file is under 9 MB.
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(9 * 1024 * 1024);
  });

  it('past the image budget, the rest become paths with a note; failures get the budget first', async () => {
    const dir = sessionDir();
    // A noisy 600x600 image that barely compresses, so two of them exceed a small budget.
    const rgb = new Uint8Array(600 * 600 * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 2654435761) >>> 24;
    const noisy = join(dir, 'noisy.png');
    writeFileSync(noisy, encodePngRgb(600, 600, rgb));
    const failShot = addShot(dir, 'fail.png', noisy);
    const passShot = addShot(dir, 'pass.png', noisy);
    const r = baseReport({
      testOutcomes: [
        { workflow: 'Pass first', outcome: 'pass', evidence: [passShot.uri] },
        { workflow: 'Broken', outcome: 'fail', evidence: [failShot.uri] },
      ],
      artifacts: [failShot, passShot],
    });
    const one = (await renderReportHtml(r, { sessionDir: dir })).match(/base64,([^"]+)"/)![1].length;
    const html = await renderReportHtml(r, { sessionDir: dir, imageBudgetBytes: one + 10 });
    expect(attrs(html, 'src').length).toBe(1);
    expect(html).toMatch(/alt="Broken failure"/);
    expect(html).toContain('screenshots/pass.png</code> (not embedded: report image budget');
    expect(html).toContain('were not embedded because the report reached its image budget');
  });

  it('renders a 2.3.5 report (no schemaVersion, no steps)', async () => {
    const r = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'reports', 'report-2.3.5-fail.json'), 'utf8')) as ReportData;
    const html = await renderReportHtml(r, {});
    assertSelfContained(html);
    expect(html).toContain('launch_smoke');
    expect(html).toContain('No step timeline in this report');
    expect(html).toContain('evidence not available');
  });
});

describe('release policy notice', () => {
  it('shows an ignored .swipium/policy.json in the banner, escaped', async () => {
    const r = { ...baseReport(), releasePolicyNotice: '.swipium/policy.json is not valid JSON: <b>ignored</b>' } as ReportData;
    const html = await renderReportHtml(r, { sessionDir: sessionDir() });
    expect(html).toContain('Policy: .swipium/policy.json is not valid JSON: &lt;b&gt;ignored&lt;/b&gt;');
  });
});
