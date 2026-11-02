// `swipium report` CI CLI: find the persisted session report for a project under a synthetic
// ~/.swipium, render each export format, and map the release gate onto the exit code.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { findProjectSessions, REPORT_FORMATS, runReport, sessionDirForReport, type ReportCliIo } from '../src/cli/report.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-report-cli-home-'));
const prevHome = process.env.HOME;
let root: string;

function capture(): ReportCliIo & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (s: string) => {
      io.out += s;
    },
    stderr: (s: string) => {
      io.err += s;
    },
  };
  return io;
}

function report(sessionId: string, risk: 'ship' | 'block') {
  return {
    sessionId,
    appId: 'com.example.demo',
    device: 'emulator-5554',
    coverage: 'smoke',
    executiveSummary: { risk, reasons: [], nextAction: 'Fix the crash.' },
    nativeHealth: risk === 'block' ? 'error' : 'OK',
    appHealth: 'OK',
    findings:
      risk === 'block'
        ? [{ severity: 'high', layer: 'native', kind: 'crash', failureCode: 'NATIVE_CRASH', detail: 'FATAL EXCEPTION main' }]
        : [],
    highSeverityCount: risk === 'block' ? 1 : 0,
    testOutcomes: [{ workflow: 'login flow', outcome: 'pass' }],
    outcomeTally: { pass: 1 },
    environmentChanges: [],
    guardrailOverrides: [],
    finalNetwork: 'online',
    networkRestore: 'unchanged',
    authState: 'unknown',
    phaseTimings: { totalMs: 1000, setupMs: 0, activeMs: 1000, timeToLoginMs: null },
    artifacts: [],
  };
}

/** Write a session the way SessionStore persists it (default dir + state.json + report artifact). */
function persistSession(id: string, createdAt: number, body?: ReturnType<typeof report>): string {
  const hash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
  const dir = join(fakeHome, '.swipium', 'runs', hash, id);
  mkdirSync(join(dir, 'report'), { recursive: true });
  const artifacts: unknown[] = [];
  if (body) {
    const path = join(dir, 'report', `report-${createdAt}.json`);
    writeFileSync(path, JSON.stringify(body));
    // An export next to it must never be mistaken for the report JSON.
    writeFileSync(join(dir, 'report', `report-${createdAt + 1}.sarif.json`), '{}');
    artifacts.push({
      uri: `swipium://session/${id}/report/report-${createdAt}.json`,
      path,
      kind: 'report',
      mime: 'application/json',
      createdAt,
    });
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ id, root, dir, createdAt, artifacts }));
  return dir;
}

beforeAll(() => {
  process.env.HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'swipium-report-cli-proj-'));
  writeFileSync(join(root, 'app.json'), '{}');
  persistSession('old00001', 1000, report('old00001', 'ship'));
  persistSession('new00002', 2000, report('new00002', 'block'));
  persistSession('empty003', 3000); // newest, but no report yet → --latest must skip it
});

afterAll(() => {
  process.env.HOME = prevHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('swipium report', () => {
  it('--help prints usage and exits 0', async () => {
    const io = capture();
    expect(await runReport(['--help'], io)).toBe(0);
    expect(io.out).toContain('Usage: swipium report');
    expect(io.out).toContain('--fail-on-gate');
  });

  it('usage errors exit 2', async () => {
    expect(await runReport(['--root', root], capture())).toBe(2); // no --format
    expect(await runReport(['--format', 'pdf', '--root', root], capture())).toBe(2);
    expect(await runReport(['--format', 'junit', '--bogus'], capture())).toBe(2);
    expect(await runReport(['--format', 'junit', '--root'], capture())).toBe(2);
  });

  it('finds only this project’s sessions', () => {
    const other = mkdtempSync(join(tmpdir(), 'swipium-report-cli-other-'));
    try {
      expect(findProjectSessions(other)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    expect(findProjectSessions(root).map((s) => s.id)).toEqual(['old00001', 'new00002', 'empty003']);
  });

  it('--latest picks the newest session WITH a report and writes JUnit to --out', async () => {
    const io = capture();
    const out = join(root, 'out', 'junit.xml');
    expect(await runReport(['--root', root, '--latest', '--format', 'junit', '--out', out], io)).toBe(0);
    expect(existsSync(out)).toBe(true);
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(readFileSync(out, 'utf8'));
    expect(doc.testsuites['@_failures']).toBe('1'); // the NATIVE_CRASH finding from new00002
    expect(io.err).toContain('new00002');
    expect(io.err).toContain('Release gate: BLOCK');
  });

  it('--fail-on-gate returns 1 when the gate blocks, 0 when policy lets it through', async () => {
    // --max-age accepts new00002's recent report although the newer empty003 saved none.
    const gate = ['--root', root, '--max-age', '60', '--fail-on-gate'];
    expect(await runReport([...gate, '--format', 'github-summary'], capture())).toBe(1);
    mkdirSync(join(root, '.swipium'), { recursive: true });
    writeFileSync(join(root, '.swipium', 'policy.json'), JSON.stringify({ ignoreKnown: ['NATIVE_CRASH'] }));
    try {
      expect(await runReport([...gate, '--format', 'junit'], capture())).toBe(0);
    } finally {
      rmSync(join(root, '.swipium', 'policy.json'));
    }
  });

  it('--latest --fail-on-gate refuses (exit 2) when a newer session saved no report', async () => {
    const io = capture();
    expect(await runReport(['--root', root, '--latest', '--format', 'junit', '--fail-on-gate'], io)).toBe(2);
    expect(io.err).toContain('empty003');
    expect(io.err).toContain('new00002');
    expect(io.out).toBe('');
    // Without --fail-on-gate it still renders the older report, with a warning.
    const warn = capture();
    expect(await runReport(['--root', root, '--latest', '--format', 'junit'], warn)).toBe(0);
    expect(warn.err).toContain('Warning: 1 newer session(s) (empty003) saved no report');
  });

  it('boolean flags reject a value', async () => {
    const io = capture();
    expect(await runReport(['--root', root, '--format', 'junit', '--fail-on-gate=false'], io)).toBe(2);
    expect(io.err).toContain('--fail-on-gate takes no value');
    expect(await runReport(['--root', root, '--format', 'junit', '--latest=yes'], capture())).toBe(2);
  });

  it('a failed --out write exits 2, never 1 (gate blocked)', async () => {
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const io = capture();
    expect(
      await runReport(
        ['--root', root, '--session', 'new00002', '--format', 'junit', '--fail-on-gate', '--out', join(blocker, 'junit.xml')],
        io,
      ),
    ).toBe(2);
    expect(io.err).toContain('Could not write');
  });

  it('--session selects a specific session; SARIF goes to stdout anchored to the project manifest', async () => {
    const io = capture();
    expect(await runReport([`--root=${root}`, '--session', 'old00001', '--format', 'sarif', '--fail-on-gate'], io)).toBe(0);
    const sarif = JSON.parse(io.out);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].properties.sessionId).toBe('old00001');
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(true);
  });

  it('json and markdown formats render; json carries the gate decision', async () => {
    const io = capture();
    expect(await runReport(['--root', root, '--format', 'json'], io)).toBe(0);
    expect(JSON.parse(io.out).releaseGate.block).toBe(true);
    const md = capture();
    expect(await runReport(['--root', root, '--format', 'markdown'], md)).toBe(0);
    expect(md.out).toContain('# QA report: com.example.demo');
  });

  it('missing session / missing report exit 2 with guidance', async () => {
    const a = capture();
    expect(await runReport(['--root', root, '--session', 'nope', '--format', 'junit'], a)).toBe(2);
    expect(a.err).toContain('nope');
    const b = capture();
    expect(await runReport(['--root', root, '--session', 'empty003', '--format', 'junit'], b)).toBe(2);
    expect(b.err).toContain('qa_report');
    const empty = mkdtempSync(join(tmpdir(), 'swipium-report-cli-empty-'));
    try {
      const c = capture();
      expect(await runReport(['--root', empty, '--format', 'junit'], c)).toBe(2);
      expect(c.err).toContain('calls qa_report');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('--report renders an explicit report file', async () => {
    const file = join(root, 'r.json');
    writeFileSync(file, JSON.stringify(report('file0001', 'ship')));
    const io = capture();
    expect(await runReport(['--root', root, '--report', file, '--format', 'junit', '--fail-on-gate'], io)).toBe(0);
    expect(io.out).toContain('<testsuites');
    writeFileSync(file, '{"not":"a report"}');
    expect(await runReport(['--report', file, '--format', 'junit'], capture())).toBe(2);
  });

  it('--format html from a session folder embeds its screenshots', async () => {
    const dir = persistSession('html0004', 4000, {
      ...report('html0004', 'ship'),
      testOutcomes: [{ workflow: 'login flow', outcome: 'pass', evidence: ['swipium://session/html0004/checkpoint/cp.png'] }],
      artifacts: [{ uri: 'swipium://session/html0004/checkpoint/cp.png', kind: 'checkpoint', path: 'screenshots/cp.png' }],
    } as ReturnType<typeof report>);
    mkdirSync(join(dir, 'screenshots'), { recursive: true });
    copyFileSync(join(__dirname, 'fixtures', 'png', 'ios-simctl-redbox-1206x2622.png'), join(dir, 'screenshots', 'cp.png'));
    expect(sessionDirForReport(join(dir, 'report', 'report-4000.json'))).toBe(dir);
    const out = join(root, 'out', 'report.html');
    const io = capture();
    expect(await runReport(['--root', root, '--session', 'html0004', '--format', 'html', '--out', out, '--fail-on-gate'], io)).toBe(0);
    const html = readFileSync(out, 'utf8');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('Release gate: PASS');
    expect(html).toContain('src="data:image/png;base64,');
    expect(io.err).toContain('Wrote html for session html0004');
  });

  it('--format html with --report outside a session folder shows evidence not available', async () => {
    const file = join(root, 'loose.json');
    writeFileSync(
      file,
      JSON.stringify({
        ...report('loose001', 'block'),
        findings: [
          {
            severity: 'high',
            kind: 'crash',
            failureCode: 'NATIVE_CRASH',
            detail: 'boom',
            screenshotUri: 'swipium://session/loose001/screenshot/x.png',
          },
        ],
      }),
    );
    expect(sessionDirForReport(file)).toBeUndefined();
    const io = capture();
    expect(await runReport(['--root', root, '--report', file, '--format', 'html', '--fail-on-gate'], io)).toBe(1);
    expect(io.out).toContain('Release gate: BLOCK');
    expect(io.out).toContain('evidence not available');
    expect(io.out).not.toContain('<img ');
  });

  it('a 2.3.5 report (no schemaVersion, no steps) renders in every format', async () => {
    const file = join(__dirname, 'fixtures', 'reports', 'report-2.3.5-fail.json');
    expect(REPORT_FORMATS).toContain('html');
    for (const format of REPORT_FORMATS) {
      const io = capture();
      expect(await runReport(['--root', root, '--report', file, '--format', format], io)).toBe(0);
      expect(io.out.length).toBeGreaterThan(0);
    }
  });

  it('help lists the html format', async () => {
    const io = capture();
    await runReport(['--help'], io);
    expect(io.out).toContain('junit|sarif|github-summary|markdown|json|html');
  });
});
