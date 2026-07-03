// qa_ios (PHASE3-PLAN Phase 11) — iOS Simulator control via simctl. Boots/selects a simulator,
// installs a .app, launches/terminates, opens deep links, resets privacy, erases, and captures
// screenshots. Booting/launching binds a SimctlDriver into the session so the shared visual tools
// (qa_screenshot, qa_assert_visual, qa_report) work on iOS unchanged. Structured
// interaction (tap/type/snapshot) is intentionally unsupported here and reported as such.

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { captureCoordinateSpace } from '../lib/coordSpace.js';
import { SimctlDriver } from '../drivers/SimctlDriver.js';
import { WdaDriver } from '../drivers/WdaDriver.js';
import { checkWda, classifyWdaConnectionFailure, createWdaSession, wdaSessionUdidMismatch } from '../lib/wda.js';
import { loadWdaConfig, wdaUrlAllowedByConfig } from '../lib/wdaConfig.js';
import { recordWdaTiming } from '../lib/wdaTune.js';
import * as sim from '../lib/simctl.js';
import type { Session, SessionStore } from '../session/store.js';

/** Ensure a SimctlDriver is bound for `udid` and recorded on the session. */
function bind(sessions: SessionStore, session: Session, udid: string): SimctlDriver {
  const driver = session.driver instanceof SimctlDriver ? session.driver : new SimctlDriver(udid);
  driver.useDevice(udid);
  session.driver = driver;
  session.device = udid;
  sessions.persist(session);
  return driver;
}

function isLoopback(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function registerIos(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_ios',
    {
      title: 'iOS simulator control',
      description:
        'Control an iOS Simulator (macOS only) and attach an external WDA backend. actions: list (available simulators), boot (boot/select one — binds it to the session), install (a .app, consent-gated), launch (a bundle id), terminate, openurl (deep link), screenshot, logs, privacy_reset (consent-gated), erase (consent-gated, wipes the device), wda_status, wda_attach. After boot/launch, qa_screenshot / qa_assert_visual / qa_report work on the simulator. For structured iOS tap/type/snapshot, attach WDA with action:"wda_attach".',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum([
          'list',
          'boot',
          'install',
          'launch',
          'terminate',
          'openurl',
          'screenshot',
          'logs',
          'privacy_reset',
          'erase',
          'wda_status',
          'wda_attach',
        ]),
        device: z
          .string()
          .optional()
          .describe('Simulator udid or name substring (for boot/erase), or expected WDA device UDID for wda_attach.'),
        app: z.string().optional().describe('Path to a .app bundle (for install); absolute or relative to the project root.'),
        bundleId: z.string().optional().describe('App bundle id (for launch/terminate/privacy_reset/wda_attach).'),
        url: z.string().optional().describe('Deep link (for openurl).'),
        webDriverAgentUrl: z
          .string()
          .optional()
          .describe('External WebDriverAgent base URL for wda_status/wda_attach. Defaults to http://127.0.0.1:8100.'),
        allowNonLoopback: z.boolean().optional().describe('Required to use a non-loopback WDA URL.'),
        last: z.string().optional().describe('Time range for logs, e.g. 5m, 30m, 1h. Defaults to 5m.'),
        service: z.string().optional().describe('Privacy service for privacy_reset (e.g. location, photos, camera, all).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async (args) => {
      const { sessionId, action } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        return qaError({
          what: `Unknown sessionId ${sessionId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session first.'],
        });
      }

      if (action === 'wda_status' || action === 'wda_attach') {
        const wdaConfig = loadWdaConfig(session.root);
        const url = (args.webDriverAgentUrl ?? wdaConfig.url).replace(/\/+$/, '');
        const loopback = isLoopback(url);
        const configAllowed = !loopback && wdaUrlAllowedByConfig(wdaConfig, url);
        if (!loopback && !args.allowNonLoopback && !configAllowed) {
          return qaError({
            what: 'Refused non-loopback WDA URL',
            changedState: false,
            retrySafe: false,
            failureCode: 'DESTRUCTIVE_REFUSED',
            nextSteps: [
              'Use a localhost WDA URL, pass allowNonLoopback with explicit consent, or add this exact URL to ios.wda.allowNonLoopbackUrls for a trusted isolated automation network.',
            ],
          });
        }
        if (!loopback && !configAllowed) {
          const gate = consumeConsent(args.consentId, args.approve, { action: 'wda_non_loopback', affects: { url } });
          if (!gate.approved) {
            return requireConsent({
              action: 'wda_non_loopback',
              risk: 'medium',
              affects: { url },
              explain: `Use non-loopback WebDriverAgent URL ${url}? WDA is an automation server; only approve this on a trusted, isolated network.`,
            });
          }
        }
        const status = await checkWda(url);
        const targetUdid = args.device ?? session.device;
        const base = {
          webDriverAgentUrl: url,
          wda: status,
          device: targetUdid ?? null,
          sessionActive: session.driver instanceof WdaDriver,
          driverKind: session.driver?.kind ?? null,
        };
        if (action === 'wda_status') {
          return qaOk(
            base,
            `iOS WDA status: ${status.reachable ? 'reachable' : 'unreachable'} at ${url}${targetUdid ? ` device=${targetUdid}` : ''}`,
          );
        }
        if (!targetUdid) {
          return qaError(
            {
              what: 'Refused ambiguous WDA attach without a device UDID',
              changedState: false,
              retrySafe: true,
              failureCode: 'MULTIPLE_DEVICES',
              nextSteps: ['Pass device with the simulator/device UDID, or bind the session to a simulator first.'],
            },
            base,
          );
        }
        if (session.device && session.device !== targetUdid) {
          return qaError(
            {
              what: `Refused ambiguous WDA/device mapping: session is bound to ${session.device}, but qa_ios wda_attach was asked to use ${targetUdid}`,
              changedState: false,
              retrySafe: false,
              failureCode: 'STALE_WDA_DEVICE',
              nextSteps: ['Use the session-bound device, or start a new session for the other WDA/device pair.'],
            },
            base,
          );
        }
        if (!status.reachable) {
          return qaError(
            {
              what: `WDA server unavailable at ${url}`,
              changedState: false,
              retrySafe: true,
              failureCode: classifyWdaConnectionFailure(status.error ?? 'unreachable'),
              nextSteps: ['Start WebDriverAgent externally, confirm /status responds, then retry qa_ios wda_attach.'],
            },
            base,
          );
        }
        try {
          const bundleId = args.bundleId ?? session.appId ?? undefined;
          const sessionOptions = { bundleId, udid: targetUdid, capabilities: wdaConfig.capabilities, settings: wdaConfig.settings };
          const createStarted = Date.now();
          let created: Awaited<ReturnType<typeof createWdaSession>>;
          try {
            created = await createWdaSession(url, sessionOptions);
          } finally {
            recordWdaTiming(session, 'session_create', Date.now() - createStarted, sessions);
          }
          const mismatchedUdid = wdaSessionUdidMismatch(created.capabilities, targetUdid);
          if (mismatchedUdid) {
            sessions.recordMutation(session, {
              tool: 'qa_ios',
              action: 'wda_attach',
              risk: 'medium',
              target: { webDriverAgentUrl: url, device: targetUdid, bundleId: bundleId ?? null, reportedDevice: mismatchedUdid },
              consent: { required: !loopback && !configAllowed, approved: !!configAllowed || loopback || !!args.approve },
              status: 'blocked',
              detail: 'WDA reported a different device',
            });
            return qaError(
              {
                what: `Refused stale WDA session: WDA reported device ${mismatchedUdid}, but qa_ios wda_attach requested ${targetUdid}`,
                changedState: false,
                retrySafe: false,
                failureCode: 'STALE_WDA_DEVICE',
                nextSteps: ['Stop the stale WDA process or start a new WDA session for the intended UDID.'],
              },
              { ...base, capabilities: created.capabilities ?? null, wdaSessionId: created.sessionId },
            );
          }
          session.driver = new WdaDriver(url, {
            ...sessionOptions,
            sessionId: created.sessionId,
            onTiming: (kind, ms) => recordWdaTiming(session, kind, ms, sessions),
          });
          session.device = targetUdid;
          if (bundleId) session.appId = bundleId;
          sessions.persist(session);
          sessions.addEnvChange(session, `ios wda attach ${url} ${targetUdid}`);
          sessions.recordMutation(session, {
            tool: 'qa_ios',
            action: 'wda_attach',
            risk: 'medium',
            target: {
              webDriverAgentUrl: url,
              device: targetUdid,
              bundleId: bundleId ?? null,
              wdaSessionId: created.sessionId,
              capabilities: created.capabilities ?? null,
            },
            consent: { required: !loopback && !configAllowed, consentId: args.consentId, approved: true },
            status: 'executed',
          });
          return qaOk(
            { ...base, sessionActive: true, wdaSessionId: created.sessionId, capabilities: created.capabilities ?? null },
            `attached WDA structured iOS backend at ${url}\nNext: qa_snapshot / qa_act / qa_flow_run can use WDA-backed structured operations.`,
          );
        } catch (e) {
          const failureCode = classifyWdaConnectionFailure(String((e as Error).message ?? e));
          sessions.recordMutation(session, {
            tool: 'qa_ios',
            action: 'wda_attach',
            risk: 'medium',
            target: { webDriverAgentUrl: url, device: targetUdid, bundleId: args.bundleId ?? session.appId ?? null },
            consent: {
              required: !loopback && !configAllowed,
              consentId: args.consentId,
              approved: !!configAllowed || loopback || !!args.approve,
            },
            status: 'blocked',
            detail: String((e as Error).message ?? e),
          });
          return qaError(
            {
              what: `WDA session creation failed: ${String((e as Error).message ?? e)}`,
              changedState: false,
              retrySafe: true,
              failureCode,
              nextSteps: ['Confirm WDA is paired with the intended simulator/device and that the app bundle id is installed.'],
            },
            base,
          );
        }
      }

      if (!(await sim.simctlAvailable())) {
        return qaError({
          what: 'iOS Simulator tooling is unavailable',
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: [
            'iOS support needs a macOS host with the `xcrun simctl` command-line tools. On Linux/Windows use the Android backend.',
          ],
        });
      }

      // ---- read-only ----
      if (action === 'list') {
        const sims = await sim.listSimulators();
        const booted = sims.filter((s) => s.state === 'Booted');
        return qaOk(
          { simulators: sims, bootedCount: booted.length },
          `${sims.length} available simulators (${booted.length} booted):\n` +
            sims
              .slice(0, 25)
              .map((s) => `  ${s.state === 'Booted' ? '▶' : '·'} ${s.name} [${s.runtime}] ${s.udid}`)
              .join('\n'),
        );
      }

      const need = (v: string | undefined, what: string) =>
        v ? null : qaError({ what: `${action} requires ${what}`, changedState: false, retrySafe: true, nextSteps: [`Pass ${what}.`] });

      if (action === 'boot') {
        const sims = await sim.listSimulators();
        const pick =
          (args.device && sims.find((s) => s.udid === args.device || s.name.toLowerCase().includes(args.device!.toLowerCase()))) ||
          sims.find((s) => s.state === 'Booted') ||
          sims.find((s) => /iphone/i.test(s.name));
        if (!pick)
          return qaError({
            what: 'No matching simulator',
            changedState: false,
            retrySafe: true,
            failureCode: 'SIMULATOR_RUNTIME_MISSING',
            nextSteps: ['qa_ios { action: "list" } to see available simulators, or install an iOS simulator runtime in Xcode.'],
          });
        try {
          sessions.milestone(session, 'simulator_boot_start');
          await sim.boot(pick.udid);
          sessions.milestone(session, 'simulator_boot_end');
        } catch (e) {
          const msg = String(e);
          const failureCode = /timed out|timeout/i.test(msg) ? 'SIMULATOR_BOOT_TIMEOUT' : 'SIMULATOR_BOOT_FAILED';
          return qaError({
            what: `Boot failed: ${msg}`,
            changedState: false,
            retrySafe: true,
            failureCode,
            nextSteps: [
              'Try another simulator from qa_ios list, erase the simulator if policy allows it, or boot a known-good simulator from Xcode.',
            ],
          });
        }
        bind(sessions, session, pick.udid);
        sessions.addEnvChange(session, `ios boot ${pick.name} (${pick.udid})`);
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'ios_boot',
          risk: 'low',
          target: { udid: pick.udid, name: pick.name, runtime: pick.runtime },
          consent: { required: false, approved: true },
          status: 'executed',
        });
        return qaOk(
          { udid: pick.udid, name: pick.name, runtime: pick.runtime, bound: true },
          `booted + bound ${pick.name} [${pick.runtime}]\nNext: qa_ios install/launch, then qa_screenshot / qa_assert_visual.`,
        );
      }

      // everything below needs a bound simulator
      const udid = session.device;
      if (!udid || !(session.driver instanceof SimctlDriver)) {
        return qaError({
          what: 'No simulator bound to this session',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_ios { action: "boot" } first.'],
        });
      }

      if (action === 'install') {
        const e = need(args.app, 'app (a .app path)');
        if (e) return e;
        const appPath = isAbsolute(args.app!) ? args.app! : join(session.root, args.app!);
        if (!existsSync(appPath))
          return qaError({
            what: `.app not found: ${appPath}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Provide an existing .app bundle path.'],
          });
        const gate = consumeConsent(args.consentId, args.approve, { action: 'install_app', affects: { appPath } });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_ios',
            action: 'install_app',
            risk: 'medium',
            target: { udid, appPath },
            consent: { required: true, approved: false },
            status: 'requested',
          });
          return requireConsent({
            action: 'install_app',
            risk: 'medium',
            exactCommand: `xcrun simctl install ${udid} ${appPath}`,
            affects: { appPath },
            explain: `Install ${appPath} onto the simulator? It runs third-party app code.`,
          });
        }
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'install_app',
          risk: 'medium',
          target: { udid, appPath },
          consent: { required: true, consentId: args.consentId, approved: true },
          status: 'approved',
        });
        try {
          sessions.milestone(session, 'app_install_start');
          await sim.installApp(udid, appPath);
          sessions.milestone(session, 'app_install_end');
        } catch (err) {
          const failureCode = sim.classifyIosInstallFailure(String(err));
          sessions.recordMutation(session, {
            tool: 'qa_ios',
            action: 'install_app',
            risk: 'medium',
            target: { udid, appPath },
            consent: { required: true, consentId: args.consentId, approved: true },
            status: 'blocked',
            detail: `${failureCode}: ${String(err)}`,
          });
          return qaError({
            what: `Install failed: ${String(err)}`,
            changedState: false,
            retrySafe: true,
            failureCode,
            nextSteps: [
              failureCode === 'WRONG_ARCH'
                ? 'Rebuild the .app for the iOS Simulator SDK, not a physical device SDK.'
                : 'Confirm the .app is valid, signed as needed, and built for a simulator (not a device) SDK.',
            ],
          });
        }
        const bundleId = await sim.bundleIdFromApp(appPath);
        if (bundleId) session.appId = bundleId;
        sessions.addEnvChange(session, `ios install ${appPath}`);
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'install_app',
          risk: 'medium',
          target: { udid, appPath, bundleId: bundleId ?? null },
          consent: { required: true, consentId: args.consentId, approved: true },
          status: 'executed',
        });
        return qaOk(
          { installed: true, appPath, bundleId: bundleId ?? null },
          `installed${bundleId ? ` (${bundleId})` : ''}. Next: qa_ios { action: "launch" }.`,
        );
      }

      if (action === 'launch') {
        const bundleId = args.bundleId ?? session.appId;
        const e = need(bundleId ?? undefined, 'bundleId');
        if (e) return e;
        try {
          sessions.milestone(session, 'app_launch_start');
          await sim.launchApp(udid, bundleId!);
          sessions.milestone(session, 'app_launch_end');
        } catch (err) {
          return qaError({
            what: `Launch failed: ${String(err)}`,
            changedState: false,
            retrySafe: true,
            failureCode: 'BUNDLE_ID_NOT_FOUND',
            nextSteps: ['Confirm the app is installed (qa_ios install) and that bundleId is correct.'],
          });
        }
        session.appId = bundleId!;
        sessions.persist(session);
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'ios_launch',
          risk: 'low',
          target: { udid, bundleId },
          consent: { required: false, approved: true },
          status: 'executed',
        });
        return qaOk({ launched: true, bundleId }, `launched ${bundleId}. Use qa_screenshot / qa_assert_visual to verify.`);
      }

      if (action === 'terminate') {
        const bundleId = args.bundleId ?? session.appId;
        const e = need(bundleId ?? undefined, 'bundleId');
        if (e) return e;
        await sim.terminateApp(udid, bundleId!);
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'ios_terminate',
          risk: 'low',
          target: { udid, bundleId },
          consent: { required: false, approved: true },
          status: 'executed',
        });
        return qaOk({ terminated: true, bundleId }, `terminated ${bundleId}`);
      }

      if (action === 'openurl') {
        const e = need(args.url, 'url (a deep link)');
        if (e) return e;
        try {
          await sim.openUrl(udid, args.url!);
        } catch (err) {
          return qaError({
            what: `openurl failed: ${String(err)}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Check the deep-link scheme is registered by an installed app.'],
          });
        }
        sessions.addEnvChange(session, `ios openurl ${args.url}`);
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'ios_openurl',
          risk: 'low',
          target: { udid, url: args.url },
          consent: { required: false, approved: true },
          status: 'executed',
        });
        return qaOk({ opened: args.url }, `opened deep link ${args.url}`);
      }

      if (action === 'screenshot') {
        if (session.sensitive) return sensitiveRefusal('Screenshot');
        try {
          const png = await sim.screenshot(udid);
          const n = ++session.screenshotCount;
          const uri = sessions.saveArtifact(session, 'screenshot', `ios-${n}.png`, png, 'image/png', 'iOS simulator screenshot');
          sessions.bump(session, 'screenshots');
          const coordinateSpace = await captureCoordinateSpace(session.driver, png);
          return qaOk(
            { uri, bytes: png.length, coordinateSpace },
            `screenshot → ${uri} (${coordinateSpace.screenshot?.width}x${coordinateSpace.screenshot?.height})`,
          );
        } catch (err) {
          return qaError({
            what: `Screenshot failed: ${String(err)}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Confirm the simulator is booted (qa_ios list).'],
          });
        }
      }

      if (action === 'logs') {
        if (session.sensitive) return sensitiveRefusal('iOS simulator logs');
        const bundleId = args.bundleId ?? session.appId ?? undefined;
        try {
          const text = await sim.simulatorLogs(udid, { last: args.last, bundleId });
          const uri = sessions.saveArtifact(
            session,
            'logs',
            `ios-simulator-${Date.now()}.log`,
            text.slice(-120_000),
            'text/plain',
            `iOS simulator logs${bundleId ? ` for ${bundleId}` : ''}`,
          );
          return qaOk(
            { uri, bytes: text.length, last: args.last ?? '5m', bundleId: bundleId ?? null },
            `captured iOS simulator logs → ${uri}`,
          );
        } catch (err) {
          return qaError({
            what: `log capture failed: ${String(err)}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Confirm the simulator is booted and try a shorter last range such as last:"1m".'],
          });
        }
      }

      if (action === 'privacy_reset') {
        const e = need(args.service, 'service (e.g. location, photos, camera, all)');
        if (e) return e;
        const bundleId = args.bundleId ?? session.appId ?? undefined;
        const gate = consumeConsent(args.consentId, args.approve, {
          action: 'privacy_reset',
          affects: { service: args.service, bundleId },
        });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_ios',
            action: 'privacy_reset',
            risk: 'low',
            target: { udid, service: args.service, bundleId: bundleId ?? null },
            consent: { required: true, approved: false },
            status: 'requested',
          });
          return requireConsent({
            action: 'privacy_reset',
            risk: 'low',
            exactCommand: `xcrun simctl privacy ${udid} reset ${args.service}${bundleId ? ` ${bundleId}` : ''}`,
            affects: { service: args.service, bundleId },
            explain: `Reset the "${args.service}" privacy permission${bundleId ? ` for ${bundleId}` : ''} on the simulator?`,
          });
        }
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'privacy_reset',
          risk: 'low',
          target: { udid, service: args.service, bundleId: bundleId ?? null },
          consent: { required: true, consentId: args.consentId, approved: true },
          status: 'approved',
        });
        try {
          await sim.privacyReset(udid, args.service!, bundleId);
        } catch (err) {
          sessions.recordMutation(session, {
            tool: 'qa_ios',
            action: 'privacy_reset',
            risk: 'low',
            target: { udid, service: args.service, bundleId: bundleId ?? null },
            consent: { required: true, consentId: args.consentId, approved: true },
            status: 'blocked',
            detail: String(err),
          });
          return qaError({
            what: `privacy reset failed: ${String(err)}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Check the service name (location/photos/camera/contacts/all).'],
          });
        }
        sessions.addEnvChange(session, `ios privacy reset ${args.service}${bundleId ? ` ${bundleId}` : ''}`);
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'privacy_reset',
          risk: 'low',
          target: { udid, service: args.service, bundleId: bundleId ?? null },
          consent: { required: true, consentId: args.consentId, approved: true },
          status: 'executed',
        });
        return qaOk({ service: args.service, bundleId: bundleId ?? null, reset: true }, `reset privacy: ${args.service}`);
      }

      // action === 'erase'
      {
        const target = args.device ?? udid;
        const gate = consumeConsent(args.consentId, args.approve, { action: 'erase_device', affects: { udid: target } });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_ios',
            action: 'erase_device',
            risk: 'high',
            target: { udid: target },
            consent: { required: true, approved: false },
            status: 'requested',
          });
          return requireConsent({
            action: 'erase_device',
            risk: 'high',
            exactCommand: `xcrun simctl erase ${target}`,
            affects: { udid: target },
            explain: `Erase all content and settings on simulator ${target}? This wipes installed apps and data.`,
          });
        }
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'erase_device',
          risk: 'high',
          target: { udid: target },
          consent: { required: true, consentId: args.consentId, approved: true },
          status: 'approved',
        });
        try {
          await sim.erase(target);
        } catch (err) {
          sessions.recordMutation(session, {
            tool: 'qa_ios',
            action: 'erase_device',
            risk: 'high',
            target: { udid: target },
            consent: { required: true, consentId: args.consentId, approved: true },
            status: 'blocked',
            detail: String(err),
          });
          return qaError({
            what: `erase failed: ${String(err)}`,
            changedState: true,
            retrySafe: true,
            nextSteps: ['Shut the simulator down and retry.'],
          });
        }
        sessions.addEnvChange(session, `ios erase ${target}`);
        sessions.recordMutation(session, {
          tool: 'qa_ios',
          action: 'erase_device',
          risk: 'high',
          target: { udid: target },
          consent: { required: true, consentId: args.consentId, approved: true },
          status: 'executed',
        });
        return qaOk({ erased: target }, `erased simulator ${target} (it is now shut down — qa_ios boot to use it again).`);
      }
    },
  );
}
