// Screen-recording lifecycle helpers retained so shutdown/report paths stay idempotent.

import type { ChildProcess } from 'node:child_process';
import { run } from '../lib/spawn.js';

type Backend = 'direct' | 'simulator' | 'wda_simulator';
interface Recording {
  child: ChildProcess;
  backend: Backend;
  serial: string;
  startedAt: number;
}
const active = new Map<string, Recording>();

/** Is a recording active for this session? Used by qa_report. */
export function activeRecording(sessionId: string): { backend: Backend; seconds: number } | undefined {
  const r = active.get(sessionId);
  return r ? { backend: r.backend, seconds: Math.round((Date.now() - r.startedAt) / 1000) } : undefined;
}

/** Best-effort: stop every active recorder so the server does not leave a device recording. */
export async function stopAllRecordings(): Promise<void> {
  for (const [, rec] of active) {
    try {
      if (rec.backend === 'direct') {
        await run('adb', ['-s', rec.serial, 'shell', 'pkill', '-INT', 'screenrecord'], { timeoutMs: 5000 }).catch(() => {});
      }
      rec.child.kill('SIGINT');
    } catch {
      /* best-effort */
    }
  }
  active.clear();
}
