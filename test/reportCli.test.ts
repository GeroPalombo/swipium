// `swipium report` CI CLI: find the persisted session report for a project under a synthetic
// ~/.swipium, render each export format, and map the release gate onto the exit code.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { findProjectSessions, runReport, type ReportCliIo } from '../src/cli/report.js';

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
    expect(await runReport(['--root', root, '--format', 'github-summary', '--fail-on-gate'], capture())).toBe(1);
    mkdirSync(join(root, '.swipium'), { recursive: true });
    writeFileSync(join(root, '.swipium', 'policy.json'), JSON.stringify({ ignoreKnown: ['NATIVE_CRASH'] }));
    try {
      expect(await runReport(['--root', root, '--format', 'junit', '--fail-on-gate'], capture())).toBe(0);
    } finally {
      rmSync(join(root, '.swipium', 'policy.json'));
    }
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
});
