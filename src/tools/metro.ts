// qa_metro: own the debug React Native / Expo Metro flow (review §4.2 / Rec 5).
// A debug RN/Expo APK needs a Metro dev server on :8081 + `adb reverse` to fetch its JS
// bundle. `status` reports whether that's ready; `start` (consent-gated) sets up the
// reverse and launches Metro, logging to a session artifact.

import { z } from 'zod';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/server';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { run } from '../lib/spawn.js';
import { detectFramework } from '../context/detect.js';
import { METRO_PORT, metroReadiness, wrongProjectMetroMessage } from '../lib/metroState.js';
import { parseSnapshot } from '../snapshot/parse.js';
import { detectRedBox } from '../snapshot/overlays.js';
import { blockedDeviceResult, getDriver, resolveDevice, type DeviceResolution } from '../session/attach.js';
import { sessionDevicePlatform } from '../automationGen/platformResolve.js';
import { psEnv, registerManagedProcess, unregisterManagedProcess } from '../session/processRegistry.js';
import { artifactDirectoryName, type SessionStore } from '../session/store.js';
import { log } from '../lib/logger.js';

/** True if `pid` is a live process whose command looks like a Metro/Expo/RN bundler. Guards
 * against killing a recycled PID (e.g. a `metroPid` persisted before a machine or server
 * restart that now belongs to an unrelated process). Best-effort (POSIX `ps`); on any doubt
 * we report "not ours" so we never signal a stranger. */
function metroProcessLooksAlive(pid: number): boolean {
  try {
    const out = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: psEnv() });
    if (out.status !== 0 || !out.stdout) return false;
    // `npm exec …`: npx retitles itself after spawn (the launcher we recorded as metroPid).
    return /metro|expo|react-native|node|npm exec/i.test(out.stdout);
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
    /* not a group leader, or group already gone, fall through */
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
        'Manage the Metro bundler for debug RN/Expo builds: status, diagnose (adds RedBox/logcat evidence and fixes), start ' +
        '(consent-gated: adb reverse + Metro), stop. After start, relaunch with qa_prepare_target.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['status', 'diagnose', 'start', 'stop']),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      // GOAL-4: an iOS-bound session never touches adb (no resolve/bind of an Android device, no
      // reverse, no logcat). A simulator reaches the host's Metro at localhost directly.
      const ios = sessionDevicePlatform(session) === 'ios';
      const iosDevice = ios ? session.device : undefined;
      // Centralized device resolution (P0.1/P0.3): use the session device, else the single
      // online one (bind it), else ask / guide. Never a circular "no device" dead end.
      const dev: DeviceResolution = ios
        ? { sessionDevice: iosDevice, available: [], effective: undefined, needSelection: false, source: 'session' }
        : await resolveDevice(session);
      if (dev.needSelection && action !== 'status') {
        return qaError({
          what: 'Multiple devices online, choose one',
          changedState: false,
          retrySafe: true,
          failureCode: 'MULTIPLE_DEVICES',
          nextSteps: [`Re-run qa_prepare_target with device="<serial>". Online: ${dev.available.join(', ')}`],
        });
      }
      let serial = dev.effective;
      if (serial && !session.device) {
        if (action === 'status') {
          // status is a read: never adopt (or probe) a device the user never chose; the pin is chosen.
          if (dev.source !== 'arg' && dev.source !== 'pin') serial = undefined;
        } else {
          // Same auto-bind guard as every device tool (operator pin, no bind while a simulator is booted).
          const { blocked } = await getDriver(session);
          if (blocked) return blockedDeviceResult(blocked)!;
          serial = session.device;
        }
      }
      const fw = detectFramework(session.root);

      const rd0 = await metroReadiness(serial, METRO_PORT, session.root);
      // iOS needs no reverse: ready = Metro up and serving this project's bundle.
      const rd = ios ? { ...rd0, ready: rd0.listening && rd0.serving } : rd0;
      const listening = rd.listening;
      const reverseSet = rd.reverseSet;
      const devId = serial ?? iosDevice ?? null;
      const relaunchTool = ios ? 'qa_prepare_ios_target' : 'qa_prepare_target';

      if (action === 'status') {
        const deviceHint =
          serial || ios
            ? ''
            : '\n⚠ No device bound; adb reverse needs one. Call qa_prepare_target first (it binds the device), then qa_metro.';
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
            device: devId,
            ...(ios ? { platform: 'ios', reverseNeeded: false } : {}),
            metroPid: session.metroPid ?? null,
            needsDevice: !serial && !ios,
            ...(rd.wrongProject ? { wrongProject: true, metroProjectRoot: rd.metroProjectRoot ?? null } : {}),
          },
          `framework=${fw} metro:${METRO_PORT}=${listening ? 'listening' : 'down'} serving=${rd.serving} adb-reverse=${ios ? 'n/a (iOS simulator reaches host localhost)' : serial ? (reverseSet ? 'set' : 'unset') : 'n/a (no device)'} device=${devId ?? 'none'} online=[${dev.available.join(',')}]${session.metroPid ? ` pid=${session.metroPid}` : ''}` +
            (rd.wrongProject
              ? `\n⚠ METRO_WRONG_PROJECT: ${wrongProjectMetroMessage(rd, session.root)}`
              : rd.ready
                ? '\nReady: debug bundle can load.'
                : deviceHint || '\nNot fully ready. Run qa_metro action="start" (or qa_metro diagnose).'),
        );
      }

      if (action === 'diagnose') {
        const { driver } = await getDriver(session);
        let redbox = { present: false, unableToLoadScript: false };
        let redboxChecked = false;
        let logUri: string | undefined;
        if (driver) {
          try {
            const parsed = parseSnapshot(await driver.dumpXml());
            redbox = detectRedBox(parsed.allNodes);
            redboxChecked = true;
          } catch {
            /* dump may fail on redbox/animation (or no UI tree: simctl-only iOS) */
          }
          // iOS: the driver's log is the simulator's unified log (simctl), never adb logcat.
          const log = await driver
            .logcat(200, 'ReactNative|ReactNativeJS|Metro|bundle|Unable to load|loadJSBundle|DevServer|No script URL|RCTRedBox')
            .catch(() => '');
          if (log)
            logUri = ios
              ? sessions.saveArtifact(session, 'logs', `simlog-${Date.now()}.txt`, log, 'text/plain', 'metro diagnose (simulator log)')
              : sessions.saveArtifact(session, 'logcat', `logcat-${Date.now()}.txt`, log, 'text/plain', 'metro diagnose');
        }
        const recovery: string[] = [];
        let requiresReinstall = false;
        if (!serial && !ios)
          recovery.push(
            dev.needSelection
              ? `Multiple devices online. Re-run qa_prepare_target device="<serial>". Online: ${dev.available.join(', ')}`
              : 'No device online. Boot one via qa_prepare_target (it boots + sets reverse), then retry.',
          );
        if (rd.wrongProject) recovery.push(`${wrongProjectMetroMessage(rd, session.root)} Stop that Metro, then qa_metro action="start".`);
        // GOAL NEW-R4-4: serving on localhost (::1) but not on 127.0.0.1 (`expo start --localhost`):
        // Metro runs, the app just can't reach it on 127.0.0.1.
        if (!listening && rd.serving)
          recovery.push(
            `This project's Metro serves on localhost (::1) but not on 127.0.0.1:${METRO_PORT}, where the app connects. Restart it listening on all interfaces (without --localhost).`,
          );
        else if (!listening) recovery.push('Start Metro: qa_metro action="start".');
        if (serial && listening && !reverseSet) recovery.push('Set reverse: qa_metro action="start" (sets adb reverse).');
        if (listening && !rd.serving && !rd.wrongProject)
          recovery.push('Metro is up but not serving the bundle yet. Wait ~10s for the first transform, then retry.');
        if (ios && !redboxChecked)
          recovery.push(
            'RedBox not checked: no UI tree on this iOS session. Attach WebDriverAgent (qa_wda action="setup", then "attach") or check qa_screenshot.',
          );
        if (redbox.unableToLoadScript && ios) {
          requiresReinstall = true;
          recovery.push(
            'RedBox says the app cannot load its JS bundle ("No script URL provided" / "Unable to load script"). Start Metro (qa_metro action="start"), then relaunch with qa_prepare_ios_target. If Metro is ready and it still fails, the .app is bundle-less: rebuild/reinstall a working debug or release build.',
          );
        } else if (redbox.unableToLoadScript) {
          requiresReinstall = true;
          recovery.push(
            'RedBox is "Unable to load script": the installed build cannot fetch the JS bundle. If Metro+reverse are ready and it still fails, the APK is bundle-less/asset-only. RECOVERY REQUIRES REINSTALL/REBUILD of a working debug or release APK (a data wipe alone will not fix it).',
          );
        } else if (redbox.present) {
          recovery.push('RedBox present (not load-script): tap RELOAD via qa_act, or fix the JS error shown.');
        }
        if (rd.ready && !redbox.present) recovery.push('Metro ready and no RedBox. The bundle should load.');

        return qaOk(
          {
            framework: fw,
            ...rd,
            sessionDevice: dev.sessionDevice ?? null,
            availableDevices: dev.available,
            device: devId,
            ...(ios ? { platform: 'ios', reverseNeeded: false, redBoxChecked: redboxChecked } : {}),
            redBox: redbox,
            requiresReinstall,
            logcatUri: logUri ?? null,
            recovery,
          },
          `framework=${fw} | metro listening=${rd.listening} serving=${rd.serving} reverse=${reverseSet} ready=${rd.ready}\n` +
            `redbox=${redbox.present ? (redbox.unableToLoadScript ? 'UNABLE-TO-LOAD-SCRIPT' : 'present') : 'none'}${requiresReinstall ? ' ⚠ requires reinstall/rebuild' : ''}\n` +
            `recovery:\n - ${recovery.join('\n - ') || '(none, looks healthy)'}` +
            (logUri ? `\n${ios ? 'simulator log' : 'logcat'} evidence: ${logUri}` : ''),
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
          target: { device: devId, port: METRO_PORT, pid: had ?? null, killed, reverseRemoved: !!serial },
          consent: { required: false, approved: true },
          status: 'restored',
        });
        return qaOk(
          { stopped: killed, pid: had ?? null, reverseRemoved: !!serial },
          had
            ? `Stopped Metro pid ${had}${killed ? '' : ' (was already gone)'}${serial ? '; removed adb reverse' : ''}.`
            : 'No Swipium-started Metro to stop (it may have been started externally).',
        );
      }

      // action === 'start': `serial` is the single online device (auto-bound) or a session
      // device. If none online, guide to prepare_target to BOOT (terminal, non-circular).
      if (!serial && !ios) {
        return qaError({
          what: dev.needSelection ? 'Multiple devices online, choose one' : 'No device online. Metro reverse needs a running device',
          changedState: false,
          retrySafe: true,
          failureCode: dev.needSelection ? 'MULTIPLE_DEVICES' : 'NO_DEVICE',
          nextSteps: dev.needSelection
            ? [`Re-run qa_prepare_target device="<serial>". Online: ${dev.available.join(', ')}`]
            : ['Boot a device first: qa_prepare_target { bindOnly:true } (boots an AVD + sets reverse), then qa_metro start.'],
        });
      }
      if (rd.wrongProject) {
        return qaError({
          what: wrongProjectMetroMessage(rd, session.root),
          changedState: false,
          retrySafe: true,
          failureCode: 'METRO_WRONG_PROJECT',
          nextSteps: [
            `Stop the Metro serving ${rd.metroProjectRoot ?? 'the other project'} (Swipium did not start it, so qa_metro stop will not kill it), then re-run qa_metro action="start".`,
          ],
        });
      }
      if (listening && (ios || reverseSet)) {
        return qaOk(
          ios
            ? { framework: fw, metroListening: true, platform: 'ios', reverseNeeded: false, alreadyRunning: true }
            : { framework: fw, metroListening: true, reverseSet: true, alreadyRunning: true },
          ios
            ? 'Metro already listening (iOS simulator needs no reverse), nothing to do.'
            : 'Metro already listening and adb reverse already set, nothing to do.',
        );
      }
      const { cmd, args } = metroCommand(fw);
      const cmdStr = ios
        ? `(cd ${session.root} && ${cmd} ${args.join(' ')})`
        : `adb -s ${serial} reverse tcp:${METRO_PORT} tcp:${METRO_PORT} && (cd ${session.root} && ${cmd} ${args.join(' ')})`;
      const gate = consumeConsent(consentId, approve, { action: 'start_metro', affects: { port: METRO_PORT, framework: fw } });
      if (!gate.approved) {
        sessions.recordMutation(session, {
          tool: 'qa_metro',
          action: 'start_metro',
          risk: 'medium',
          target: { device: devId, port: METRO_PORT, framework: fw },
          consent: { required: true, approved: false },
          status: 'requested',
        });
        return requireConsent({
          action: 'start_metro',
          risk: 'medium',
          exactCommand: cmdStr,
          affects: { port: METRO_PORT, framework: fw },
          explain: ios
            ? `This looks like a debug ${fw} build needing Metro on :${METRO_PORT}. Start Metro? (iOS simulator: no adb reverse.)`
            : `This looks like a debug ${fw} build needing Metro on :${METRO_PORT}. Set adb reverse and start Metro?`,
        });
      }
      sessions.recordMutation(session, {
        tool: 'qa_metro',
        action: 'start_metro',
        risk: 'medium',
        target: { device: devId, port: METRO_PORT, framework: fw },
        consent: { required: true, consentId, approved: true },
        status: 'approved',
      });

      // adb reverse (Android only), then spawn Metro detached with output to a session log artifact.
      if (serial) {
        try {
          await run('adb', ['-s', serial, 'reverse', `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`], { timeoutMs: 8000, rejectOnNonZero: true });
        } catch (e) {
          sessions.recordMutation(session, {
            tool: 'qa_metro',
            action: 'start_metro',
            risk: 'medium',
            target: { device: devId, port: METRO_PORT, framework: fw },
            consent: { required: true, consentId, approved: true },
            status: 'blocked',
            detail: String(e),
          });
          return qaError({
            what: `adb reverse failed: ${String(e)}`,
            commandAttempted: `adb -s ${serial} reverse tcp:${METRO_PORT} tcp:${METRO_PORT}`,
            changedState: true,
            retrySafe: true,
            failureCode: 'METRO_FAILED',
            nextSteps: ['Check the device is online.'],
          });
        }
      }
      // Register the artifact (creates the empty file) BEFORE opening the append fd, so we
      // don't truncate a live log. saveArtifact files kind 'metro' under <dir>/logs/ (see
      // artifactDirectoryName), so open the path it actually recorded, never a hand-built one
      // (AND-7 / GOAL-3: opening <dir>/metro/metro.log was a raw ENOENT on every platform).
      let logUri: string;
      let logPath: string;
      let child: ReturnType<typeof spawn>;
      try {
        logUri = sessions.saveArtifact(session, 'metro', 'metro.log', '', 'text/plain');
        logPath = session.artifacts.find((a) => a.uri === logUri)?.path ?? join(session.dir, artifactDirectoryName('metro'), 'metro.log');
        const fd = openSync(logPath, 'a');
        try {
          child = spawn(cmd, args, { cwd: session.root, detached: true, stdio: ['ignore', fd, fd] });
        } finally {
          closeSync(fd); // child inherited the fd; the parent must not keep it open (review #2)
        }
        // A missing `npx` surfaces as an async 'error' event; unhandled, it would crash the server.
        child.on('error', (err) => {
          log('warn', 'metro spawn failed', { err: String(err) });
          if (session.metroPid === child.pid) session.metroPid = undefined;
          unregisterManagedProcess(child.pid);
        });
        if (child.pid === undefined) throw new Error(`could not spawn ${cmd} (is Node/npx on PATH?)`);
        child.unref();
      } catch (e) {
        sessions.recordMutation(session, {
          tool: 'qa_metro',
          action: 'start_metro',
          risk: 'medium',
          target: { device: devId, port: METRO_PORT, framework: fw },
          consent: { required: true, consentId, approved: true },
          status: 'blocked',
          detail: String(e),
        });
        return qaError({
          what: `Could not start Metro: ${e instanceof Error ? e.message : String(e)}`,
          commandAttempted: `(cd ${session.root} && ${cmd} ${args.join(' ')})`,
          changedState: !!serial, // adb reverse is already set (Android)
          retrySafe: true,
          failureCode: 'METRO_FAILED',
          nextSteps: [
            `Start Metro manually in ${session.root} (${cmd} ${args.join(' ')}), then qa_wait {for:"metro_ready"}.`,
            'qa_metro action="diagnose" for evidence.',
          ],
        });
      }
      session.metroPid = child.pid;
      registerManagedProcess(child.pid, 'metro', session.id, { spawnCommand: [cmd, ...args].join(' ') }); // reapable if this server crashes
      sessions.persistNow(session); // the pid must hit disk before a crash for reload/reap to see it

      sessions.recordMutation(session, {
        tool: 'qa_metro',
        action: 'start_metro',
        risk: 'medium',
        target: { device: devId, port: METRO_PORT, framework: fw, pid: child.pid ?? null },
        consent: { required: true, consentId, approved: true },
        status: 'executed',
        ledgerUri: logUri,
      });

      return qaOk(
        {
          framework: fw,
          started: true,
          port: METRO_PORT,
          reverseSet: !!serial,
          ...(ios ? { platform: 'ios', reverseNeeded: false } : {}),
          pid: child.pid,
          logUri,
          logPath,
        },
        `Started Metro (${fw}) on :${METRO_PORT}${serial ? ' + adb reverse set' : ' (iOS simulator: no adb reverse needed)'}. Log: ${logUri}\nWait ~5-10s for "Metro waiting", then relaunch the app with ${relaunchTool}.`,
        { structuredSummary: 'full' }, // the wait-then-relaunch guidance is not in the payload
      );
    },
  );
}
