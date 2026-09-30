// D9: `swipium scan` must not write .swipium/ on --help or when the project is BLOCKED; the
// help text documents --check/--dry-run. D2: no references to a nonexistent `swipium plan`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scanState = vi.hoisted(() => ({ readiness: 'blocked' as 'ready' | 'partial' | 'blocked' }));

vi.mock('../src/context/scan.js', () => ({
  scanProject: vi.fn(async (root: string) => ({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    framework: 'unknown',
    monorepo: false,
    appId: null,
    appIdSource: null,
    apks: [],
    ipas: [],
    appBundles: [],
    artifactHashes: [],
    metroNeed: 'no',
    freshStartSafe: true,
    likelyAuth: false,
    authSignals: [],
    installed: null,
    recommendedProfile: 'guardrail',
    readiness: scanState.readiness,
    missing: scanState.readiness === 'ready' ? [] : ['adb not on PATH'],
    devices: { androidOnline: [], avds: [] },
  })),
}));

const { runScan, SCAN_USAGE } = await import('../src/cli/scan.js');

function capture(): string[] {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('swipium scan', () => {
  it('--help prints usage (documents --check/--dry-run) and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swipium-scan-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const out = capture();
    await runScan(['--help']);
    cwd.mockRestore();
    expect(out.join('')).toBe(SCAN_USAGE);
    expect(SCAN_USAGE).toContain('--check');
    expect(SCAN_USAGE).toContain('--dry-run');
    expect(existsSync(join(dir, '.swipium'))).toBe(false);
  });

  it('BLOCKED writes no files', async () => {
    scanState.readiness = 'blocked';
    const dir = mkdtempSync(join(tmpdir(), 'swipium-scan-'));
    const out = capture();
    await runScan([dir]);
    expect(existsSync(join(dir, '.swipium'))).toBe(false);
    const text = out.join('');
    expect(text).toContain('BLOCKED');
    expect(text).toContain('no files written');
    expect(text).not.toContain('swipium plan');
  });

  it('--check writes no files even when ready', async () => {
    scanState.readiness = 'ready';
    const dir = mkdtempSync(join(tmpdir(), 'swipium-scan-'));
    capture();
    await runScan([dir, '--check']);
    expect(existsSync(join(dir, '.swipium'))).toBe(false);
  });

  it('READY scaffolds .swipium/ and points at real next steps', async () => {
    scanState.readiness = 'ready';
    const dir = mkdtempSync(join(tmpdir(), 'swipium-scan-'));
    const out = capture();
    await runScan([dir]);
    expect(existsSync(join(dir, '.swipium', 'config.json'))).toBe(true);
    expect(existsSync(join(dir, '.swipium', 'flows', 'README.md'))).toBe(true);
    const text = out.join('');
    expect(text).toContain('qa_start_session');
    expect(text).not.toContain('swipium plan');
  });

  it('describes .gitignore handling accurately (scan does not edit it; app map / issue ledger writes do)', async () => {
    scanState.readiness = 'ready';
    const dir = mkdtempSync(join(tmpdir(), 'swipium-scan-'));
    const out = capture();
    await runScan([dir]);
    const text = out.join('');
    expect(text).not.toContain('never edits .gitignore');
    expect(text).toContain('scan does not edit .gitignore');
    expect(text).toMatch(/adds \.swipium\/ .*first time it writes the app map or issue ledger/);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });
});
