// qa_screen_record (PHASE3-PLAN §4.2 / NEXT-PLAN Fix 5) — capture a screen video on Android
// (adb screenrecord) or the iOS Simulator (simctl io recordVideo). start spawns the recorder
// (consent-gated, sensitive-screen warning); status reports whether one is active; stop finalizes
// it gracefully (SIGINT so the mp4 isn't corrupted), saves an artifact, and cleans up. Active
// recordings are tracked in a module-level map (the child handle is live-only, like the driver);
// they are best-effort finalized on server shutdown and surfaced by qa_report.

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { run } from '../lib/spawn.js';
import { getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

type Backend = 'direct' | 'simulator' | 'wda_simulator';
type SaveMode = 'always' | 'on_failure';
interface Recording {
  child: ChildProcess;
  backend: Backend;
  serial: string;
  saveMode: SaveMode;
  remotePath?: string; // Android: on-device path
  hostPath?: string; // iOS: host path simctl writes directly
  startedAt: number;
  endedAt?: number; // set when the recorder process exits on its own (e.g. Android ~180s time-limit)
}
const active = new Map<string, Recording>();

export function shouldSaveRecording(saveMode: SaveMode, failed: boolean | undefined): boolean {
  return saveMode === 'always' || failed === true;
}

/** Is a recording active for this session? (used by qa_report). */
export function activeRecording(sessionId: string): { backend: Backend; seconds: number } | undefined {
  const r = active.get(sessionId);
  return r ? { backend: r.backend, seconds: Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000) } : undefined;
}

/** Best-effort: stop every active recorder so the server doesn't leave a device recording. */
export async function stopAllRecordings(): Promise<void> {
  for (const [, rec] of active) {
    try {
      if (rec.backend === 'direct') await run('adb', ['-s', rec.serial, 'shell', 'pkill', '-INT', 'screenrecord'], { timeoutMs: 5000 }).catch(() => {});
      rec.child.kill('SIGINT');
    } catch {
      /* best-effort */
    }
  }
  active.clear();
}

export function registerScreenRecord(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_screen_record',
    {
      title: 'Record the screen',
      description:
        'Record a screen video (Android emulator/device, iOS Simulator, or WDA-backed iOS Simulator). action:"start" begins recording (consent-gated — it captures whatever is on screen, including anything sensitive; avoid password/OTP screens); action:"status" reports whether one is active; action:"stop" finalizes it and saves an mp4 artifact. Use save:"on_failure" on start plus failed:false on stop to discard passing-run videos in CI. Android recordings auto-stop after ~3 minutes. One recording per session at a time.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['start', 'status', 'stop']),
        save: z.enum(['always', 'on_failure']).optional().describe('Recording retention mode for action:"start". Defaults to always. Use on_failure in CI to discard videos when stop is called with failed:false.'),
        failed: z.boolean().optional().describe('For action:"stop" with save:"on_failure": true saves the video, false discards it.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, save, failed, consentId, approve }) => {
      const session = sessions.get(sessionId);
      const { driver } = session ? await getDriver(session) : { driver: undefined };
      const serial = driver?.currentDevice();
      if (!session || !driver || !serial) {
        return qaError({ what: 'No device attached to this session', changedState: false, retrySafe: true, nextSteps: ['Call qa_prepare_target / qa_ios boot first.'] });
      }
      const backend: Backend | null = driver.kind === 'direct' ? 'direct' : driver.kind === 'simulator' ? 'simulator' : driver.kind === 'wda' ? 'wda_simulator' : null;
      if (!backend) {
        return qaError({ what: 'Screen recording is not supported on this backend', changedState: false, retrySafe: false, failureCode: 'BACKEND_UNSUPPORTED', nextSteps: ['Use the Android, iOS-simulator, or WDA-backed iOS simulator backend.'] });
      }

      // ---- status ----
      if (action === 'status') {
        const r = active.get(sessionId);
        // The recorder process may have ended on its own (the Android `--time-limit 180` cap)
        // while the entry is still held so `stop` can pull and save the file. Report that
        // honestly instead of implying it's still capturing.
        const ended = !!r?.endedAt;
        const seconds = r ? Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000) : 0;
        return qaOk(
          { recording: !!r, capturing: !!r && !ended, autoStopped: ended, backend: r?.backend ?? null, saveMode: r?.saveMode ?? null, seconds },
          r
            ? ended
              ? `recording auto-stopped (${r.backend}, ${r.saveMode}, ~${seconds}s; Android time-limit reached) — qa_screen_record { action: "stop", failed:<bool> } to save the mp4.`
              : `recording active (${r.backend}, ${r.saveMode}, ~${seconds}s) — qa_screen_record { action: "stop", failed:<bool> } to finalize.`
            : 'no active recording.',
        );
      }

      // ---- start ----
      if (action === 'start') {
        if (session.sensitive) return sensitiveRefusal('Screen recording');
        if (active.has(sessionId)) {
          return qaError({ what: 'A recording is already in progress for this session', changedState: false, retrySafe: true, nextSteps: ['Call qa_screen_record { action: "stop" } first (or "status").'] });
        }
        const saveMode = save ?? 'always';
        const gate = consumeConsent(consentId, approve, { action: 'screen_record', affects: { device: serial } });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_screen_record',
            action: 'screen_record',
            risk: 'medium',
            target: { device: serial, backend, saveMode },
            consent: { required: true, approved: false },
            status: 'requested',
          });
          const cmd = backend === 'direct' ? `adb -s ${serial} shell screenrecord --time-limit 180 /sdcard/…mp4` : `xcrun simctl io ${serial} recordVideo …mp4`;
          return requireConsent({ action: 'screen_record', risk: 'medium', exactCommand: cmd, affects: { device: serial }, explain: 'Record the device screen to a video? It captures everything shown — do NOT record password/OTP/payment screens.' });
        }
        sessions.recordMutation(session, {
          tool: 'qa_screen_record',
          action: 'screen_record',
          risk: 'medium',
          target: { device: serial, backend, saveMode },
          consent: { required: true, consentId, approved: true },
          status: 'approved',
        });
        let rec: Recording;
        if (backend === 'direct') {
          const remotePath = `/sdcard/swipium-rec-${Date.now()}.mp4`;
          const child = spawn('adb', ['-s', serial, 'shell', 'screenrecord', '--time-limit', '180', remotePath], { stdio: 'ignore' });
          child.unref();
          rec = { child, backend, serial, saveMode, remotePath, startedAt: Date.now() };
        } else {
          const hostPath = join(tmpdir(), `swipium-iosrec-${Date.now()}.mp4`);
          const child = spawn('xcrun', ['simctl', 'io', serial, 'recordVideo', '--codec', 'h264', hostPath], { stdio: 'ignore' });
          child.unref();
          rec = { child, backend, serial, saveMode, hostPath, startedAt: Date.now() };
        }
        active.set(sessionId, rec);
        // Mark when the recorder exits on its own (Android `--time-limit 180`) so `status`
        // stops claiming it's still capturing. The entry stays so `stop` can still save the file.
        rec.child.once('exit', () => {
          if (!rec.endedAt) rec.endedAt = Date.now();
        });
        sessions.addEnvChange(session, `screen_record started (${backend}, ${saveMode})`);
        sessions.recordMutation(session, {
          tool: 'qa_screen_record',
          action: 'screen_record',
          risk: 'medium',
          target: { device: serial, backend, saveMode },
          consent: { required: true, consentId, approved: true },
          status: 'executed',
          detail: 'recording started',
        });
        return qaOk({ recording: true, backend, saveMode }, `recording started (${backend}, ${saveMode})${backend === 'direct' ? ' (auto-stops after ~3 min)' : ''} — call qa_screen_record { action: "stop", failed:<bool> } to finalize${saveMode === 'on_failure' ? ' and keep only on failure' : ' and save the video'}.`);
      }

      // ---- stop ----
      const rec = active.get(sessionId);
      if (!rec) {
        return qaError({ what: 'No active recording for this session', changedState: false, retrySafe: true, nextSteps: ['Start one with qa_screen_record { action: "start" } (or check "status").'] });
      }
      active.delete(sessionId);
      const localTmp = join(tmpdir(), `swipium-recpull-${Date.now()}.mp4`);
      try {
        const keep = shouldSaveRecording(rec.saveMode, failed);
        if (!keep) {
          if (rec.backend === 'direct') {
            await run('adb', ['-s', rec.serial, 'shell', 'pkill', '-INT', 'screenrecord'], { timeoutMs: 8000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 1500));
            try {
              rec.child.kill();
            } catch {
              /* already gone */
            }
            await run('adb', ['-s', rec.serial, 'shell', 'rm', rec.remotePath!], { timeoutMs: 8000 }).catch(() => {});
          } else {
            rec.child.kill('SIGINT');
            await new Promise((r) => setTimeout(r, 2000));
          }
          sessions.addEnvChange(session, 'screen_record discarded (passed, on_failure)');
          sessions.recordMutation(session, {
            tool: 'qa_screen_record',
            action: 'screen_record_stop',
            risk: 'low',
            target: { device: rec.serial, backend: rec.backend, saveMode: rec.saveMode, failed: failed ?? null },
            consent: { required: false, approved: true },
            status: 'restored',
            detail: 'discarded recording',
          });
          return qaOk({ recording: false, saved: false, discarded: true, seconds: Math.round((Date.now() - rec.startedAt) / 1000), backend: rec.backend, saveMode: rec.saveMode }, 'discarded recording because save mode is on_failure and failed:false');
        }
        let buf: Buffer;
        if (rec.backend === 'direct') {
          await run('adb', ['-s', rec.serial, 'shell', 'pkill', '-INT', 'screenrecord'], { timeoutMs: 8000 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
          try {
            rec.child.kill();
          } catch {
            /* already gone */
          }
          await run('adb', ['-s', rec.serial, 'pull', rec.remotePath!, localTmp], { timeoutMs: 30000, rejectOnNonZero: true });
          buf = readFileSync(localTmp);
          await run('adb', ['-s', rec.serial, 'shell', 'rm', rec.remotePath!], { timeoutMs: 8000 }).catch(() => {});
        } else {
          // iOS: SIGINT the recorder so it finalizes the file it's writing on the host, then read it.
          rec.child.kill('SIGINT');
          await new Promise((r) => setTimeout(r, 2000));
          buf = readFileSync(rec.hostPath!);
        }
        const uri = sessions.saveArtifact(session, 'recording', `recording-${Date.now()}.mp4`, buf, 'video/mp4', `screen recording (${rec.backend}, ${Math.round((Date.now() - rec.startedAt) / 1000)}s)`);
        sessions.addEnvChange(session, 'screen_record stopped');
        sessions.recordMutation(session, {
          tool: 'qa_screen_record',
          action: 'screen_record_stop',
          risk: 'low',
          target: { device: rec.serial, backend: rec.backend, saveMode: rec.saveMode, failed: failed ?? null },
          consent: { required: false, approved: true },
          status: 'restored',
          ledgerUri: uri,
          detail: 'saved recording',
        });
        return qaOk({ recording: false, saved: true, uri, bytes: buf.length, seconds: Math.round((Date.now() - rec.startedAt) / 1000), backend: rec.backend, saveMode: rec.saveMode }, `saved recording (${buf.length} bytes) → ${uri}`);
      } catch (e) {
        sessions.recordMutation(session, {
          tool: 'qa_screen_record',
          action: 'screen_record_stop',
          risk: 'low',
          target: { device: rec.serial, backend: rec.backend, saveMode: rec.saveMode, failed: failed ?? null },
          consent: { required: false, approved: true },
          status: 'blocked',
          detail: String(e),
        });
        return qaError({ what: `Could not finalize the recording: ${String(e)}`, changedState: true, retrySafe: false, nextSteps: ['The backend may not support screen recording, or it stopped early. Try a shorter clip.'] });
      } finally {
        try {
          rmSync(localTmp, { force: true });
          if (rec.hostPath) rmSync(rec.hostPath, { force: true });
        } catch {
          /* best-effort */
        }
      }
    },
  );
}
