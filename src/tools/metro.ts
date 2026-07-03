// qa_metro — own the debug React Native / Expo Metro flow (review §4.2 / Rec 5).
// A debug RN/Expo APK needs a Metro dev server on :8081 + `adb reverse` to fetch its JS
// bundle. `status` reports whether that's ready; `start` (consent-gated) sets up the
// reverse and launches Metro, logging to a session artifact.

import { z } from 'zod';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { run } from '../lib/spawn.js';
import { detectFramework } from '../context/detect.js';
import { METRO_PORT, metroReadiness } from '../lib/metroState.js';
import { parseSnapshot } from '../snapshot/parse.js';
import { detectRedBox } from '../snapshot/overlays.js';
import { getDriver, resolveDevice, bindDevice } from '../session/attach.js';
import { registerManagedProcess, unregisterManagedProcess } from '../session/processRegistry.js';
import type { SessionStore } from '../session/store.js';

/** True if `pid` is a live process whose command looks like a Metro/Expo/RN bundler. Guards
 * against killing a recycled PID — e.g. a `metroPid` persisted before a machine or server
 * restart that now belongs to an unrelated process. Best-effort (POSIX `ps`); on any doubt
 * we report "not ours" so we never signal a stranger. */
function metroProcessLooksAlive(pid: number): boolean {
  try {
    const out = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (out.status !== 0 || !out.stdout) return false;
    return /metro|expo|react-native|node/i.test(out.stdout);
  } catch {
    return false;
  }
}

/** Kill a Metro process that was started detached (so it leads its own process group). We signal
 * the whole GROUP (negative pid) so the real `node` bundler holding :8081 dies, not just the
 * `npx` launcher that spawned it. Falls back to signalling the pid directly if it is not a group
 * leader. Returns true if a signal was delivered. */
function killMetroGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    /* not a group leader, or group already gone — fall through */
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** Stop every Metro server Swipium started, on server shutdown / client disconnect, so a
 * budget-stop or crash mid-run doesn't leave a `node` bundler holding :8081. Idempotent. */
export async function stopAllMetro(sessions: SessionStore): Promise<void> {
  for (const session of sessions.list()) {
    const pid = session.metroPid;
    if (!pid) continue;
    if (metroProcessLooksAlive(pid)) killMetroGroup(pid);
    unregisterManagedProcess(pid);
    session.metroPid = undefined;
    sessions.persist(session); // logs its own failures to stderr
  }
}

function metroCommand(framework: string): { cmd: string; args: string[] } {
  // Expo dev-client vs bare RN Metro.
  if (framework === 'expo') return { cmd: 'npx', args: ['expo', 'start', '--dev-client', '--port', String(METRO_PORT)] };
  return { cmd: 'npx', args: ['react-native', 'start', '--port', String(METRO_PORT)] };
}

export function registerMetro(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_metro',
    {
      title: 'Metro dev server (debug RN/Expo)',
      description:
        'For debug React Native / Expo builds that need a Metro bundler on :8081. action="status" reports Metro/reverse/serving state; action="diagnose" adds RedBox detection + logcat evidence + a recovery roadmap (incl. whether reinstall/rebuild is required); action="start" (consent-gated) runs `adb reverse tcp:8081 tcp:8081` + launches Metro, logging to a session artifact + tracking its PID; action="stop" kills it + removes the reverse. After start, wait a few seconds then relaunch with qa_prepare_target.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['status', 'diagnose', 'start', 'stop']),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session)
        return qaError({
          what: `Unknown sessionId ${sessionId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session first.'],
        });
      // Centralized device resolution (P0.1/P0.3): use the session device, else the single
      // online one (bind it), else ask / guide — never a circular "no device" dead end.
      const dev = await resolveDevice(session);
      if (dev.needSelection && action !== 'status') {
        return qaError({
          what: 'Multiple devices online — choose one',
          changedState: false,
          retrySafe: true,
          nextSteps: [`Re-run qa_prepare_target with device="<serial>". Online: ${dev.available.join(', ')}`],
        });
      }
      const serial = dev.effective;
      if (serial && !session.device) bindDevice(session, serial); // self-bind single online device
      const fw = detectFramework(session.root);

      const rd = await metroReadiness(serial);
      const listening = rd.listening;
      const reverseSet = rd.reverseSet;

      if (action === 'status') {
        const deviceHint = serial
          ? ''
          : '\n⚠ No device bound — adb reverse needs one. Call qa_prepare_target first (it binds the device), then qa_metro.';
        return qaOk(
          {
            framework: fw,
            metroListening: listening,
            reverseSet,
            serving: rd.serving,
            ready: rd.ready,
            port: METRO_PORT,
            sessionDevice: dev.sessionDevice ?? null,
            availableDevices: dev.available,
            device: serial ?? null,
            metroPid: session.metroPid ?? null,
            needsDevice: !serial,
          },
          `framework=${fw} metro:${METRO_PORT}=${listening ? 'listening' : 'down'} serving=${rd.serving} adb-reverse=${serial ? (reverseSet ? 'set' : 'unset') : 'n/a (no device)'} device=${serial ?? 'none'} online=[${dev.available.join(',')}]${session.metroPid ? ` pid=${session.metroPid}` : ''}` +
            (rd.ready
              ? '\nReady — debug bundle can load.'
              : deviceHint || '\nNot fully ready — run qa_metro action="start" (or qa_metro diagnose).'),
        );
      }

      if (action === 'diagnose') {
        const { driver } = await getDriver(session);
        let redbox = { present: false, unableToLoadScript: false };
        let logUri: string | undefined;
        if (driver) {
          try {
            const parsed = parseSnapshot(await driver.dumpXml());
            redbox = detectRedBox(parsed.allNodes);
          } catch {
            /* dump may fail on redbox/animation */
          }
          const log = await driver.logcat(200, 'ReactNative|ReactNativeJS|Metro|bundle|Unable to load|loadJSBundle|DevServer');
          if (log) logUri = sessions.saveArtifact(session, 'logcat', `logcat-${Date.now()}.txt`, log, 'text/plain', 'metro diagnose');
        }
        const recovery: string[] = [];
        let requiresReinstall = false;
        if (!serial)
          recovery.push(
            dev.needSelection
              ? `Multiple devices online — re-run qa_prepare_target device="<serial>". Online: ${dev.available.join(', ')}`
              : 'No device online — boot one via qa_prepare_target (it boots + sets reverse), then retry.',
          );
        if (!listening) recovery.push('Start Metro: qa_metro action="start".');
        if (serial && listening && !reverseSet) recovery.push('Set reverse: qa_metro action="start" (sets adb reverse).');
        if (listening && !rd.serving)
          recovery.push('Metro is up but not serving the bundle yet — wait ~10s for the first transform, then retry.');
        if (redbox.unableToLoadScript) {
          requiresReinstall = true;
          recovery.push(
            'RedBox is "Unable to load script": the installed build cannot fetch the JS bundle. If Metro+reverse are ready and it still fails, the APK is bundle-less/asset-only — RECOVERY REQUIRES REINSTALL/REBUILD of a working debug or release APK (a data wipe alone will not fix it).',
          );
        } else if (redbox.present) {
          recovery.push('RedBox present (not load-script): tap RELOAD via qa_act, or fix the JS error shown.');
        }
        if (rd.ready && !redbox.present) recovery.push('Metro ready and no RedBox — the bundle should load.');

        return qaOk(
          {
            framework: fw,
            ...rd,
            sessionDevice: dev.sessionDevice ?? null,
            availableDevices: dev.available,
            device: serial ?? null,
            redBox: redbox,
            requiresReinstall,
            logcatUri: logUri ?? null,
            recovery,
          },
          `framework=${fw} | metro listening=${rd.listening} serving=${rd.serving} reverse=${reverseSet} ready=${rd.ready}\n` +
            `redbox=${redbox.present ? (redbox.unableToLoadScript ? 'UNABLE-TO-LOAD-SCRIPT' : 'present') : 'none'}${requiresReinstall ? ' ⚠ requires reinstall/rebuild' : ''}\n` +
            `recovery:\n - ${recovery.join('\n - ') || '(none — looks healthy)'}` +
            (logUri ? `\nlogcat evidence: ${logUri}` : ''),
        );
      }

      if (action === 'stop') {
        let killed = false;
        if (session.metroPid) {
          // Only signal a PID we can still confirm is a Metro/node bundler (guards against a
          // persisted PID that was recycled across a restart), and kill the whole process group
          // so the real bundler dies, not just the npx launcher.
          if (metroProcessLooksAlive(session.metroPid)) {
            killed = killMetroGroup(session.metroPid);
          }
        }
        if (serial) {
          try {
            await run('adb', ['-s', serial, 'reverse', '--remove', `tcp:${METRO_PORT}`], { timeoutMs: 5000 });
          } catch {
            /* ignore */
          }
        }
        const had = session.metroPid;
        unregisterManagedProcess(had);
        session.metroPid = undefined;
        sessions.persist(session);
        sessions.recordMutation(session, {
          tool: 'qa_metro',
          action: 'stop_metro',
          risk: 'low',
          target: { device: serial ?? null, port: METRO_PORT, pid: had ?? null, killed, reverseRemoved: !!serial },
          consent: { required: false, approved: true },
          status: 'restored',
        });
        return qaOk(
          { stopped: killed, pid: had ?? null, reverseRemoved: !!serial },
          had
            ? `Stopped Metro pid ${had}${killed ? '' : ' (was already gone)'}; removed adb reverse.`
            : 'No Swipium-started Metro to stop (it may have been started externally).',
        );
      }

      // action === 'start' — `serial` is the single online device (auto-bound) or a session
      // device. If none online, guide to prepare_target to BOOT (terminal, non-circular).
      if (!serial) {
        return qaError({
          what: dev.needSelection ? 'Multiple devices online — choose one' : 'No device online — Metro reverse needs a running device',
          changedState: false,
          retrySafe: true,
          nextSteps: dev.needSelection
            ? [`Re-run qa_prepare_target device="<serial>". Online: ${dev.available.join(', ')}`]
            : ['Boot a device first: qa_prepare_target { bindOnly:true } (boots an AVD + sets reverse), then qa_metro start.'],
        });
      }
      if (listening && reverseSet) {
        return qaOk(
          { framework: fw, metroListening: true, reverseSet: true, alreadyRunning: true },
          'Metro already listening and adb reverse already set — nothing to do.',
        );
      }
      const { cmd, args } = metroCommand(fw);
      const cmdStr = `adb -s ${serial} reverse tcp:${METRO_PORT} tcp:${METRO_PORT} && (cd ${session.root} && ${cmd} ${args.join(' ')})`;
      const gate = consumeConsent(consentId, approve, { action: 'start_metro', affects: { port: METRO_PORT, framework: fw } });
      if (!gate.approved) {
        sessions.recordMutation(session, {
          tool: 'qa_metro',
          action: 'start_metro',
          risk: 'low',
          target: { device: serial, port: METRO_PORT, framework: fw },
          consent: { required: true, approved: false },
          status: 'requested',
        });
        return requireConsent({
          action: 'start_metro',
          risk: 'low',
          exactCommand: cmdStr,
          affects: { port: METRO_PORT, framework: fw },
          explain: `This looks like a debug ${fw} build needing Metro on :${METRO_PORT}. Set adb reverse and start Metro?`,
        });
      }
      sessions.recordMutation(session, {
        tool: 'qa_metro',
        action: 'start_metro',
        risk: 'low',
        target: { device: serial, port: METRO_PORT, framework: fw },
        consent: { required: true, consentId, approved: true },
        status: 'approved',
      });

      // adb reverse, then spawn Metro detached with output to a session log artifact.
      try {
        await run('adb', ['-s', serial, 'reverse', `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`], { timeoutMs: 8000, rejectOnNonZero: true });
      } catch (e) {
        sessions.recordMutation(session, {
          tool: 'qa_metro',
          action: 'start_metro',
          risk: 'low',
          target: { device: serial, port: METRO_PORT, framework: fw },
          consent: { required: true, consentId, approved: true },
          status: 'blocked',
          detail: String(e),
        });
        return qaError({
          what: `adb reverse failed: ${String(e)}`,
          commandAttempted: `adb -s ${serial} reverse tcp:${METRO_PORT} tcp:${METRO_PORT}`,
          changedState: true,
          retrySafe: true,
          nextSteps: ['Check the device is online.'],
        });
      }
      // Register the artifact (creates the empty file) BEFORE opening the append fd, so we
      // don't truncate a live log. saveArtifact writes to <dir>/metro/metro.log.
      const logUri = sessions.saveArtifact(session, 'metro', 'metro.log', '', 'text/plain');
      const logPath = join(session.dir, 'metro', 'metro.log');
      const fd = openSync(logPath, 'a');
      const child = spawn(cmd, args, { cwd: session.root, detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
      closeSync(fd); // child inherited the fd; the parent must not keep it open (review #2)
      session.metroPid = child.pid;
      registerManagedProcess(child.pid, 'metro', session.id); // reapable if this server crashes
      sessions.persistNow(session); // the pid must hit disk before a crash for reload/reap to see it

      sessions.recordMutation(session, {
        tool: 'qa_metro',
        action: 'start_metro',
        risk: 'low',
        target: { device: serial, port: METRO_PORT, framework: fw, pid: child.pid ?? null },
        consent: { required: true, consentId, approved: true },
        status: 'executed',
        ledgerUri: logUri,
      });

      return qaOk(
        { framework: fw, started: true, port: METRO_PORT, reverseSet: true, pid: child.pid, logUri, logPath },
        `Started Metro (${fw}) on :${METRO_PORT} + adb reverse set. Log → ${logUri}\nWait ~5–10s for "Metro waiting", then relaunch the app with qa_prepare_target.`,
      );
    },
  );
}
