// Item 2: cancellation is carried per call (AsyncLocalStorage), never via a mutable slot on the
// shared driver. A background job and an interactive call on the SAME DirectDriver cancel
// independently, and a cancelled job's signal never leaks into later calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectDriver } from '../src/drivers/DirectDriver.js';
import { currentSignal, runWithSignal } from '../src/lib/abortScope.js';

let dir: string;
let oldPath: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'final2-abort-'));
  // Fake adb: `install` takes ~1 s, `shell pm list packages` ~0.4 s.
  const script = [
    '#!/bin/sh',
    'case "$*" in',
    '  *install*) exec sleep 1 ;;',
    '  *"pm list packages"*) sleep 0.4; echo "package:com.example.app" ;;',
    '  *) echo ok ;;',
    'esac',
  ].join('\n');
  writeFileSync(join(dir, 'adb'), script);
  chmodSync(join(dir, 'adb'), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${process.env.PATH}`;
});

afterAll(() => {
  process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('abortScope', () => {
  it('runWithSignal scopes the signal to the call and nested scopes replace the outer one', async () => {
    const a = new AbortController().signal;
    const b = new AbortController().signal;
    expect(currentSignal()).toBeUndefined();
    await runWithSignal(a, async () => {
      await Promise.resolve();
      expect(currentSignal()).toBe(a);
      await runWithSignal(b, async () => expect(currentSignal()).toBe(b));
      await runWithSignal(undefined, async () => expect(currentSignal()).toBeUndefined());
      expect(currentSignal()).toBe(a);
    });
    expect(currentSignal()).toBeUndefined();
  });
});

describe('DirectDriver cancellation is per call, not per driver', () => {
  it('cancelling a concurrent snapshot-style call does not kill the job’s in-flight adb install', async () => {
    const d = new DirectDriver('emulator-5554');
    const jobCtl = new AbortController();
    const snapCtl = new AbortController();
    const job = runWithSignal(jobCtl.signal, () => d.installApp('/tmp/app.apk'));
    const snap = runWithSignal(snapCtl.signal, () => d.isInstalled('com.example.app'));
    setTimeout(() => snapCtl.abort(), 100);
    await expect(snap).rejects.toBeTruthy();
    await expect(job).resolves.toBeUndefined();
  }, 10_000);

  it('cancelling the job stops its adb call while the concurrent interactive call completes', async () => {
    const d = new DirectDriver('emulator-5554');
    const jobCtl = new AbortController();
    const job = runWithSignal(jobCtl.signal, () => d.installApp('/tmp/app.apk'));
    // An interactive call starting AFTER the job (the old slot design would have swapped the
    // job's signal out here, so cancelling the job no longer reached its adb child).
    const snap = runWithSignal(new AbortController().signal, () => d.isInstalled('com.example.app'));
    setTimeout(() => jobCtl.abort(), 100);
    const started = Date.now();
    await expect(job).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(900); // killed, not waited out
    await expect(snap).resolves.toBe(true);
  }, 10_000);

  it('after a job is cancelled its aborted signal never leaks into later calls', async () => {
    const d = new DirectDriver('emulator-5554');
    const jobCtl = new AbortController();
    const job = runWithSignal(jobCtl.signal, () => d.installApp('/tmp/app.apk'));
    jobCtl.abort();
    await expect(job).rejects.toBeTruthy();
    // A later tool call (no scope, or its own fresh scope) works on the same driver.
    await expect(d.isInstalled('com.example.app')).resolves.toBe(true);
    await expect(runWithSignal(new AbortController().signal, () => d.isInstalled('com.example.app'))).resolves.toBe(true);
  }, 10_000);
});
