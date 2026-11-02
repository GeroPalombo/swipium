// A report.html render failure never stops the report: report.json and summary.md are still
// written, and the summary says report.html was not written.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

vi.mock('../src/report/html.js', async (orig) => ({
  ...(await orig<typeof import('../src/report/html.js')>()),
  renderReportHtml: vi.fn(async () => {
    throw new Error('renderer exploded');
  }),
}));

const { SessionStore } = await import('../src/session/store.js');
const { generateSessionReport } = await import('../src/services/report.js');

const root = mkdtempSync(join(tmpdir(), 'swipium-html-fail-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('report.html render failure', () => {
  it('logs, keeps the JSON report and summary, and says so in the summary', async () => {
    const store = new SessionStore();
    const s = store.create(root);
    const res = await generateSessionReport(store, s, { includeCurrentDump: false });
    expect(res.reportHtmlError).toBe('renderer exploded');
    expect(existsSync(res.reportHtmlPath)).toBe(false);
    expect(store.findArtifact(res.reportUri)).toBeTruthy();
    const md = readFileSync(store.findArtifact(res.reportMdUri)!.rec.path, 'utf8');
    expect(md).toContain('report.html was not written (renderer exploded)');
    expect(md).not.toContain('Open the report');
    expect(s.artifacts.some((a) => a.uri.endsWith('/report/report.html'))).toBe(false);
  });
});
