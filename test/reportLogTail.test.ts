// Which log a "not tested" report shows, and reading its tail safely from an untrusted report.

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickNotTestedLog, readLogTail, resolveSessionFile, type LogPickInput } from '../src/report/logTail.js';

// Artifacts shaped like the ones the tools really save (kind, file name, label, relative path).
const S = 'swipium://session/abc123';
const BUILD = {
  uri: `${S}/logs/build-android.log`,
  kind: 'logs',
  path: 'logs/build-android.log',
  label: 'failed build log (BUILD_FAILED)',
  createdAt: 10,
};
const METRO = { uri: `${S}/metro/metro.log`, kind: 'metro', path: 'logs/metro.log', createdAt: 20 };
const CRASH_LOG = {
  uri: `${S}/logcat/crash-crash-30.txt`,
  kind: 'logcat',
  path: 'logs/crash-crash-30.txt',
  label: 'health: crash log excerpt',
  createdAt: 30,
};
const SIM_LOG = {
  uri: `${S}/logs/ios-simulator-40.log`,
  kind: 'logs',
  path: 'logs/ios-simulator-40.log',
  label: 'iOS simulator logs',
  createdAt: 40,
};
// Decoys: newer, and their names or labels mention build / metro / logcat.
const WDA_BUILD = {
  uri: `${S}/wda/wda-build-90.log`,
  kind: 'wda',
  path: 'logs/wda-build-90.log',
  label: 'WDA build failed',
  createdAt: 90,
};
const METRO_DIAG = { uri: `${S}/logcat/logcat-95.txt`, kind: 'logcat', path: 'logs/logcat-95.txt', label: 'metro diagnose', createdAt: 95 };
const NEWEST = {
  uri: `${S}/logs/bundletool-99.log`,
  kind: 'logs',
  path: 'logs/bundletool-99.log',
  label: 'bundletool conversion log',
  createdAt: 99,
};
const ALL = [BUILD, METRO, CRASH_LOG, SIM_LOG, WDA_BUILD, METRO_DIAG, NEWEST];
const crashFinding = (code: string) => ({ kind: code === 'ANR' ? 'anr' : 'crash', failureCode: code, logUri: CRASH_LOG.uri });

const ROWS: Array<{
  code?: string;
  artifacts: LogPickInput['artifacts'];
  findings?: LogPickInput['findings'];
  rule?: string;
  uri?: string;
}> = [
  { code: 'BUILD_FAILED', artifacts: ALL, rule: 'build', uri: BUILD.uri },
  { code: 'METRO_REQUIRED', artifacts: ALL, rule: 'metro', uri: METRO.uri },
  { code: 'METRO_WRONG_PROJECT', artifacts: ALL, rule: 'metro', uri: METRO.uri },
  { code: 'NATIVE_CRASH', artifacts: ALL, findings: [crashFinding('NATIVE_CRASH')], rule: 'crash', uri: CRASH_LOG.uri },
  { code: 'ANR', artifacts: ALL, findings: [crashFinding('ANR')], rule: 'crash', uri: CRASH_LOG.uri },
  {
    code: 'APP_LAUNCH_FAILED',
    artifacts: ALL,
    findings: [{ kind: 'launch', failureCode: 'APP_LAUNCH_FAILED', logUri: CRASH_LOG.uri }],
    rule: 'crash',
    uri: CRASH_LOG.uri,
  },
  { code: 'NO_DEVICE', artifacts: ALL, rule: 'newest', uri: NEWEST.uri },
  { code: 'BUILD_FAILED', artifacts: [] },
];

describe('pickNotTestedLog lookup table', () => {
  for (const row of ROWS) {
    const name = `${row.code ?? 'no code'} with ${row.artifacts?.length ? 'real logs and newer decoys' : 'no log'} picks ${row.rule ?? 'nothing'}`;
    it(name, () => {
      const picked = pickNotTestedLog({
        notTested: { failureCode: row.code },
        artifacts: row.artifacts,
        findings: row.findings,
      });
      expect(picked?.rule).toBe(row.rule);
      expect(picked?.uri).toBe(row.uri);
      if (row.uri) expect(picked?.path).toBe(row.artifacts!.find((a) => a.uri === row.uri)!.path);
    });
  }

  it('a crash without a finding log falls back to the crash excerpt, not the newer logcat', () => {
    const picked = pickNotTestedLog({ notTested: { failureCode: 'NATIVE_CRASH' }, artifacts: ALL });
    expect(picked).toMatchObject({ rule: 'crash', uri: CRASH_LOG.uri });
  });
});

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function session(): string {
  const d = mkdtempSync(join(tmpdir(), 'swipium-logtail-'));
  tmpDirs.push(d);
  mkdirSync(join(d, 'logs'));
  mkdirSync(join(d, 'screenshots'));
  return d;
}

describe('readLogTail', () => {
  it('reads only the tail of a log bigger than 256 KiB and returns the last 40 lines', () => {
    const dir = session();
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
    writeFileSync(join(dir, 'logs', 'big.log'), lines.join('\n') + '\n');
    const tail = readLogTail('logs/big.log', dir, 40);
    expect(tail).toEqual(lines.slice(-40));
  });

  it('drops the partial first line when the tail starts mid-line', () => {
    const dir = session();
    writeFileSync(join(dir, 'logs', 'one.log'), 'y'.repeat(300 * 1024) + '\nlast line');
    expect(readLogTail('logs/one.log', dir, 40)).toEqual(['last line']);
  });

  it('refuses dotfiles, .. and folders that are not artifact folders', () => {
    const dir = session();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), 'token=secret');
    writeFileSync(join(dir, 'logs', '.hidden'), 'secret');
    writeFileSync(join(dir, 'notes.txt'), 'secret');
    for (const p of ['.git/config', 'logs/../.git/config', 'logs/.hidden', 'notes.txt', '../x/logs/a.log', join(dir, '.git', 'config')]) {
      expect(readLogTail(p, dir), p).toBeUndefined();
      expect(resolveSessionFile(dir, p), p).toBeUndefined();
    }
  });

  it('refuses a symlink that points out of the session folder', () => {
    const dir = session();
    const outside = session();
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY');
    symlinkSync(join(outside, 'id_rsa'), join(dir, 'logs', 'build.log'));
    expect(readLogTail('logs/build.log', dir)).toBeUndefined();
  });

  it('refuses a symlink in an artifact folder that points at a non-artifact file in the session', () => {
    const dir = session();
    mkdirSync(join(dir, 'screenshots'), { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{"secrets":["hunter2secret"]}');
    symlinkSync(join(dir, 'state.json'), join(dir, 'screenshots', 'shot.png'));
    expect(resolveSessionFile(dir, 'screenshots/shot.png')).toBeUndefined();
    expect(readLogTail('screenshots/shot.png', dir)).toBeUndefined();
  });

  it('follows a symlink that stays inside the session folder', () => {
    const dir = session();
    writeFileSync(join(dir, 'logs', 'real.log'), 'a\nb');
    symlinkSync(join(dir, 'logs', 'real.log'), join(dir, 'logs', 'link.log'));
    expect(readLogTail('logs/link.log', dir)).toEqual(['a', 'b']);
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without hanging', () => {
    const dir = session();
    execFileSync('mkfifo', [join(dir, 'logs', 'pipe.log')]);
    expect(readLogTail('logs/pipe.log', dir)).toBeUndefined();
  });

  it('refuses a directory', () => {
    const dir = session();
    mkdirSync(join(dir, 'logs', 'sub.log'));
    expect(readLogTail('logs/sub.log', dir)).toBeUndefined();
  });

  it('accepts an absolute path inside the session folder (reports before 2.4.0)', () => {
    const dir = session();
    writeFileSync(join(dir, 'logs', 'old.log'), 'old');
    expect(readLogTail(join(dir, 'logs', 'old.log'), dir)).toEqual(['old']);
  });
});
