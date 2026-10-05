// The orphan sweep must not delay server readiness: it runs AFTER the server starts serving stdio
// (serveStdio, which replaced server.connect() with the dual-era entry), in the background, and
// never rejects (a hung/failed sweep used to keep the server from connecting).
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-procreg-startup-'));
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
const { startOrphanSweep } = await import('../src/server.js');

describe('startup orphan sweep', () => {
  it('is started only after the stdio server is serving and is not awaited', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function startServer'));
    const connectAt = body.indexOf('serveStdio(');
    const sweepAt = body.indexOf('void startOrphanSweep()');
    expect(connectAt).toBeGreaterThan(0);
    expect(sweepAt).toBeGreaterThan(connectAt);
    expect(body).not.toMatch(/await reapOrphanedProcesses\(/);
  });

  it('swallows sweep failures', async () => {
    await expect(startOrphanSweep(async () => Promise.reject(new Error('boom')))).resolves.toBeUndefined();
  });
});
