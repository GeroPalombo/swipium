// qa_wait: non-shell synchronization for setup conditions, so agents don't shell out to
// `sleep`/poll. Waits for: device_online (adb), metro_ready (serving), wda_ready (WDA /status
// ready) or simulator_booted (the session's iOS Simulator finished booting, e.g. after qa_ios boot
// returned status:"booting").
// Jobs are waited on with qa_job_status waitMs. Returns timeout + current state + next steps.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { cancelledResult, qaAnnotate, qaError, qaOk, unknownSessionError } from '../lib/result.js';
import { isAbortError, sleepOrCancel, throwIfCancelled } from '../lib/abortScope.js';
import { DEVICE_PIN_ENV, onlineSerialForAvd, operatorDevicePin, pinMatches, resolveDevice, sessionAvdFor } from '../session/attach.js';
import { METRO_PORT, metroReadiness, wrongProjectMetroMessage } from '../lib/metroState.js';
import { sessionDevicePlatform } from '../automationGen/platformResolve.js';
import { checkWda, isLoopbackWdaUrl, remoteWdaAllowedByUser, REMOTE_WDA_ENV, type WdaStatus } from '../lib/wda.js';
import { wdaUrlForSession } from './wda.js';
import { resolveSimulatorWda, wdaDeviceOwnership } from '../lib/wdaDevice.js';
import { boundSimulatorUdid } from './ios.js';
import { listSimulators, simulatorBootState, type SimulatorBootState } from '../lib/simctl.js';
import type { SessionStore } from '../session/store.js';
import { maxWaitMs } from './jobs.js';

/** Default wait. Kept under common client tool timeouts (Codex: 60 s); the model can call again. */
export const DEFAULT_WAIT_TIMEOUT_MS = 45_000;
/** Effective upper bound for timeoutMs, same reasoning: one call must not outlive the client's
 *  timeout. Larger values (older docs said 60000/180000) are accepted and CLAMPED, with a note. */
export const MAX_WAIT_TIMEOUT_MS = 50_000;
const POLL_INTERVAL_MS = 1500;

export function registerWait(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_wait',
    {
      title: 'Wait for a setup condition',
      description:
        'Wait for a setup condition instead of shell sleep: device_online (adb), metro_ready, wda_ready (after qa_wda start returned ' +
        'status:"starting"), or simulator_booted (the bound iOS Simulator, after qa_ios boot returned status:"booting"). Returns ' +
        'satisfied, or timedOut:true (call again). Jobs: qa_job_status waitMs.',
      inputSchema: {
        sessionId: z.string(),
        for: z.enum(['device_online', 'metro_ready', 'wda_ready', 'simulator_booted']),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            `default ${DEFAULT_WAIT_TIMEOUT_MS}; values above SWIPIUM_MAX_WAIT_MS (default ${MAX_WAIT_TIMEOUT_MS}) are clamped. On timedOut, call again to keep waiting.`,
          ),
      },
    },
    async ({ sessionId, for: cond, timeoutMs }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      // One cap for every blocking wait: the operator's SWIPIUM_MAX_WAIT_MS (default 50000), as qa_job_status.
      const cap = maxWaitMs();
      const requested = timeoutMs ?? Math.min(DEFAULT_WAIT_TIMEOUT_MS, cap);
      const effectiveMs = Math.min(requested, cap);
      const notes =
        requested > cap
          ? [
              `timeoutMs ${requested} clamped to ${cap} (SWIPIUM_MAX_WAIT_MS): one call stays under client tool timeouts (Codex: 60 s). Call qa_wait again to keep waiting.`,
            ]
          : [];
      const done = (r: Parameters<typeof qaAnnotate>[0]) => qaAnnotate(r, notes);
      const deadline = Date.now() + effectiveMs;

      // wda_ready: the URL already used by this session (attached driver / last qa_wda start), else
      // the configured one, which must pass the same non-loopback gate as qa_wda.
      let wdaUrl: string | undefined;
      let configWdaUrl: string | undefined;
      if (cond === 'wda_ready') {
        const resolved = wdaUrlForSession(session);
        if (resolved.source === 'config' && !isLoopbackWdaUrl(resolved.url) && !remoteWdaAllowedByUser(resolved.url))
          return qaError({
            what: `Refused to poll non-loopback WDA URL ${resolved.url} from the repository config`,
            changedState: false,
            retrySafe: false,
            failureCode: 'DESTRUCTIVE_REFUSED',
            nextSteps: [
              `Attach it first with qa_wda { action:"attach", webDriverAgentUrl, allowNonLoopback:true } (consent-gated), or set ${REMOTE_WDA_ENV}=<exact url> in the MCP server environment.`,
            ],
          });
        wdaUrl = resolved.url;
        if (resolved.source === 'config' && isLoopbackWdaUrl(resolved.url)) configWdaUrl = resolved.url;
      }
      let lastWda: WdaStatus | undefined;

      // simulator_booted: the iOS Simulator bound to this session (qa_ios boot binds it even when
      // it returns status:"booting").
      let simUdid: string | undefined;
      if (cond === 'simulator_booted') {
        simUdid = boundSimulatorUdid(session);
        if (!simUdid)
          return qaError({
            what: 'No iOS Simulator bound to this session',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE',
            nextSteps: ['Call qa_ios { action:"boot" } first; it binds the simulator even while it is still booting.'],
          });
      }
      let lastSim: SimulatorBootState | undefined;

      // device_online on a session already bound to an Android device: only that device counts.
      const boundAndroid =
        cond === 'device_online' && session.device && sessionDevicePlatform(session) === 'android' ? session.device : undefined;
      const boundAvd = boundAndroid ? sessionAvdFor(session, boundAndroid) : undefined;
      // CR-PIN: an iOS-bound session waits for ITS simulator, and an unbound session under
      // SWIPIUM_DEVICE for the pinned device; neither is satisfied by a bystander emulator.
      const boundIos = cond === 'device_online' && session.device && sessionDevicePlatform(session) === 'ios' ? session.device : undefined;
      const pin = cond === 'device_online' && !session.device ? operatorDevicePin() : undefined;

      // Cancellation (notifications/cancelled): the call's signal is scoped by the tool wrapper
      // (abortScope), so every poll checks it and the pause between polls wakes on abort.
      try {
        while (Date.now() < deadline) {
          throwIfCancelled();
          if (cond === 'wda_ready') {
            const probeMs = Math.max(250, Math.min(1500, deadline - Date.now()));
            // No WDA of the session's own yet: the configured URL, else the bound simulator's own
            // managed WDA on its per-simulator port (GOAL NEW-R3-1), as qa_wda attach resolves it.
            const simUdidForWda = configWdaUrl ? boundSimulatorUdid(session) : undefined;
            let owner: Awaited<ReturnType<typeof wdaDeviceOwnership>> | undefined;
            if (simUdidForWda) {
              const r = await resolveSimulatorWda(configWdaUrl!, simUdidForWda, probeMs);
              wdaUrl = r.url;
              lastWda = r.status;
              owner = lastWda.ready ? r.owner : undefined;
            } else {
              lastWda = await checkWda(wdaUrl!, probeMs);
            }
            throwIfCancelled();
            // A ready WDA on a shared port may be another simulator's: never report it as ours.
            const boundUdid = lastWda.ready ? boundSimulatorUdid(session) : undefined;
            if (!simUdidForWda) owner = boundUdid ? await wdaDeviceOwnership(wdaUrl!, lastWda, boundUdid) : undefined;
            if (owner?.owner === 'other')
              return done(
                qaError(
                  {
                    what: `A WDA is ready at ${wdaUrl}, but it belongs to another device: ${owner.reason}`,
                    changedState: false,
                    retrySafe: false,
                    failureCode: 'STALE_WDA_DEVICE',
                    nextSteps: [
                      `Start a WDA for this simulator with qa_wda { action:"setup" } (it picks a free port when ${wdaUrl} is taken), then qa_wait { for:"wda_ready" } again.`,
                    ],
                  },
                  { satisfied: false, condition: cond, webDriverAgentUrl: wdaUrl, wdaDevice: owner.deviceUdid ?? null },
                ),
              );
            // unverified (lsof / ps timed out on a loaded host): not proven ours yet, keep polling.
            if (lastWda.ready && owner?.owner !== 'unverified')
              return done(
                qaOk(
                  { satisfied: true, condition: cond, webDriverAgentUrl: wdaUrl, wda: lastWda },
                  `WDA ready at ${wdaUrl}\nNext: qa_wda attach (if the session is not attached yet).`,
                ),
              );
            await sleepOrCancel(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
            continue;
          }
          if (cond === 'simulator_booted') {
            lastSim = await simulatorBootState(simUdid!, Math.max(250, Math.min(3000, deadline - Date.now())));
            throwIfCancelled();
            if (lastSim.state === 'booted') {
              sessions.milestone(session, 'simulator_boot_end');
              return done(
                qaOk(
                  { satisfied: true, condition: cond, udid: simUdid, simulator: lastSim },
                  `Simulator ${lastSim.name ?? simUdid} booted\nNext: qa_ios install/launch (or qa_wda start).`,
                ),
              );
            }
            if (lastSim.state === 'failed' || lastSim.state === 'shutdown' || lastSim.state === 'unknown')
              return done(
                qaError({
                  what:
                    lastSim.state === 'failed'
                      ? `Simulator ${simUdid} failed to boot: ${lastSim.error}`
                      : lastSim.state === 'shutdown'
                        ? `Simulator ${simUdid} is not booting (simctl state: ${lastSim.simctlState})`
                        : `Simulator ${simUdid} is not listed by simctl`,
                  changedState: false,
                  retrySafe: true,
                  failureCode:
                    lastSim.state === 'failed' && /timed out/i.test(lastSim.error) ? 'SIMULATOR_BOOT_TIMEOUT' : 'SIMULATOR_BOOT_FAILED',
                  nextSteps: ['Boot it again with qa_ios { action:"boot" }, or pick another simulator from qa_ios { action:"list" }.'],
                }),
              );
            await sleepOrCancel(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
            continue;
          }
          if (boundIos) {
            const st = await simulatorBootState(boundIos, Math.max(250, Math.min(3000, deadline - Date.now())));
            throwIfCancelled();
            if (st.state === 'booted')
              return done(qaOk({ satisfied: true, condition: cond, device: boundIos }, `device online: simulator ${st.name ?? boundIos}`));
            await sleepOrCancel(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
            continue;
          }
          const dev = await resolveDevice(session);
          throwIfCancelled();
          if (cond === 'device_online') {
            // A session bound to an Android device waits for THAT device (or its AVD re-booted under
            // another serial), never any other online one.
            if (pin) {
              // resolveDevice already picked the pinned serial / AVD (source 'pin'); else a booted pinned simulator.
              const sim = dev.effective
                ? undefined
                : (await listSimulators().catch(() => [])).find(
                    (s) => s.state === 'Booted' && (pinMatches(pin, s.udid) || pinMatches(pin, s.name)),
                  );
              const online = dev.effective ?? sim?.udid;
              if (online)
                return done(
                  qaOk(
                    { satisfied: true, condition: cond, device: online, availableDevices: dev.available },
                    `device online: ${online} (${DEVICE_PIN_ENV})`,
                  ),
                );
            } else if (boundAndroid) {
              if (dev.available.includes(boundAndroid))
                return done(
                  qaOk(
                    { satisfied: true, condition: cond, device: boundAndroid, availableDevices: dev.available },
                    `device online: ${boundAndroid}`,
                  ),
                );
              const reborn = boundAvd ? await onlineSerialForAvd(boundAvd, dev.available) : undefined;
              if (reborn)
                return done(
                  qaOk(
                    { satisfied: true, condition: cond, device: reborn, avd: boundAvd, availableDevices: dev.available },
                    `device online: this session's AVD ${boundAvd} now runs as ${reborn}\nNext: qa_prepare_target { sessionId, bindOnly:true } to re-bind it.`,
                  ),
                );
            } else if (dev.available.length > 0)
              return done(
                qaOk({ satisfied: true, condition: cond, availableDevices: dev.available }, `device online: ${dev.available.join(', ')}`),
              );
          } else if (dev.effective || sessionDevicePlatform(session) === 'ios') {
            // GOAL-4: an iOS simulator reaches the host's Metro at localhost (no adb device/reverse).
            const rd = await metroReadiness(dev.effective, METRO_PORT, session.root);
            // Another project's Metro holds the port: it will never become OUR bundle (AND-8).
            if (rd.wrongProject)
              return done(
                qaError({
                  what: wrongProjectMetroMessage(rd, session.root),
                  changedState: false,
                  retrySafe: true,
                  failureCode: 'METRO_WRONG_PROJECT',
                  nextSteps: [
                    `Stop the Metro serving ${rd.metroProjectRoot ?? 'the other project'}, then qa_metro action="start" and qa_wait {for:"metro_ready"} again.`,
                  ],
                }),
              );
            if (rd.serving)
              return done(
                qaOk(
                  { satisfied: true, condition: cond, metro: rd },
                  `Metro serving=${rd.serving} reverse=${rd.reverseSet} ready=${rd.ready}`,
                ),
              );
          }
          await sleepOrCancel(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
        }
      } catch (e) {
        if (isAbortError(e)) return cancelledResult(`qa_wait ${cond} cancelled: the call was aborted before the condition held`);
        throw e;
      }
      if (boundAndroid)
        return done(
          qaError(
            {
              what: `This session's device ${boundAndroid} did not come online${boundAvd ? ` (nor its AVD ${boundAvd} under another serial)` : ''}; other online devices are not used.`,
              changedState: false,
              retrySafe: true,
              failureCode: 'DEVICE_NOT_READY',
              nextSteps: [
                boundAvd
                  ? `Re-boot it: qa_prepare_target { sessionId:"${session.id}" } boots ${boundAvd} again.`
                  : `Start ${boundAndroid} again, or pick a device explicitly: qa_prepare_target { sessionId:"${session.id}", device:"<serial | AVD name>" }.`,
              ],
            },
            { satisfied: false, timedOut: true, condition: cond, device: boundAndroid },
          ),
        );
      const hint =
        cond === 'device_online'
          ? boundIos
            ? `boot this session's simulator ${boundIos} with qa_ios { action:"boot", device:"${boundIos}" }.`
            : pin
              ? `bring the pinned device ${pin} (${DEVICE_PIN_ENV}) online; no other device counts.`
              : 'boot one with qa_prepare_target { bindOnly:true }.'
          : cond === 'metro_ready'
            ? 'start Metro with qa_metro action="start", or qa_metro diagnose.'
            : cond === 'simulator_booted'
              ? 'check qa_ios { action:"list" } (a cold boot of a fresh runtime can take a few minutes).'
              : 'check qa_wda { action:"logs" } / { action:"diagnose" } (a managed WDA may have failed to launch).';
      return done(
        qaOk(
          {
            satisfied: false,
            timedOut: true,
            condition: cond,
            ...(cond === 'wda_ready' ? { webDriverAgentUrl: wdaUrl, wda: lastWda ?? null } : {}),
            ...(cond === 'simulator_booted' ? { udid: simUdid, simulator: lastSim ?? null } : {}),
          },
          `Timed out waiting for ${cond}. Call qa_wait again to keep waiting, or ${hint}`,
        ),
      );
    },
  );
}
