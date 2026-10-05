// qa_ios: iOS Simulator control via simctl. Boots/selects a simulator,
// installs a .app, launches/terminates, opens deep links, resets privacy, and erases. Booting/
// launching binds a SimctlDriver into the session so the shared visual tools (qa_screenshot,
// qa_visual, qa_report) work on iOS unchanged. Screenshots go through qa_screenshot (secure-field
// guard + budget) and WebDriverAgent through qa_wda. qa_ios no longer duplicates either.

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { SimctlDriver } from '../drivers/SimctlDriver.js';
import * as sim from '../lib/simctl.js';
import { WdaDriver, invalidateWdaPageSource } from '../drivers/WdaDriver.js';
import { isSimulatorUdid } from '../session/attach.js';
import type { Session, SessionStore } from '../session/store.js';

/** The simulator UDID this session drives, whatever the iOS backend (SimctlDriver, or WdaDriver
 *  after qa_wda attach): session.device, else the driver's own device. Undefined when nothing is
 *  bound, or the bound device is not a simulator (an adb serial / a physical iOS device; simctl
 *  cannot drive either). Exported for tests. */
export function boundSimulatorUdid(session: Pick<Session, 'device' | 'driver'>): string | undefined {
  const driver = session.driver;
  const iosDriver = driver instanceof SimctlDriver || driver instanceof WdaDriver;
  const udid = session.device ?? (iosDriver ? driver.currentDevice() : undefined);
  if (!udid) return undefined;
  return isSimulatorUdid(udid) ? udid : undefined;
}

/** Ensure a SimctlDriver is bound for `udid` and recorded on the session. */
function bind(sessions: SessionStore, session: Session, udid: string): SimctlDriver {
  const driver = session.driver instanceof SimctlDriver ? session.driver : new SimctlDriver(udid);
  driver.useDevice(udid);
  session.driver = driver;
  session.device = udid;
  sessions.persist(session);
  return driver;
}

export function registerIos(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_ios',
    {
      title: 'iOS simulator control',
      description:
        'Control an iOS Simulator (macOS): list, boot (binds it to the session), install (.app), launch, terminate, openurl, ' +
        'logs, privacy_reset, erase (wipes it). install, privacy_reset, and erase are consent-gated. Structured automation: qa_wda.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['list', 'boot', 'install', 'launch', 'terminate', 'openurl', 'logs', 'privacy_reset', 'erase']),
        device: z.string().optional().describe('boot/erase: simulator udid or name substring.'),
        app: z.string().optional().describe('install: .app path (absolute or project-relative).'),
        bundleId: z.string().optional().describe('launch/terminate/privacy_reset: bundle id.'),
        url: z.string().optional().describe('openurl: deep link.'),
        last: z.string().optional().describe('logs: time range, e.g. 30m (default 5m).'),
        service: z.string().optional().describe('privacy_reset: service, e.g. location, photos, all.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async (args) => {
      const { sessionId, action } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        return unknownSessionError(sessionId);
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
          invalidateWdaPageSource(pick.udid); // the screen changes outside WDA: drop cached page sources
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
          `booted + bound ${pick.name} [${pick.runtime}]\nNext: qa_ios install/launch, then qa_screenshot / qa_visual.`,
        );
      }

      // everything below needs a bound simulator
      // Any iOS backend works here: simctl drives the SIMULATOR, not the automation backend, so a
      // session attached to WebDriverAgent (qa_wda attach) keeps launch/terminate/openurl/…
      const udid = boundSimulatorUdid(session);
      if (!udid) {
        return qaError({
          what: 'No simulator bound to this session',
          changedState: false,
          retrySafe: true,
          failureCode: 'NO_DEVICE',
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
          invalidateWdaPageSource(udid); // the screen changes outside WDA: drop cached page sources
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
          invalidateWdaPageSource(udid); // the screen changes outside WDA: drop cached page sources
          await sim.launchApp(udid, bundleId!);
          invalidateWdaPageSource(udid); // …and anything a concurrent read cached mid-launch
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
        return qaOk({ launched: true, bundleId }, `launched ${bundleId}. Use qa_screenshot / qa_visual to verify.`);
      }

      if (action === 'terminate') {
        const bundleId = args.bundleId ?? session.appId;
        const e = need(bundleId ?? undefined, 'bundleId');
        if (e) return e;
        invalidateWdaPageSource(udid); // the screen changes outside WDA: drop cached page sources
        await sim.terminateApp(udid, bundleId!);
        invalidateWdaPageSource(udid);
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
          invalidateWdaPageSource(udid); // the screen changes outside WDA: drop cached page sources
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
            `captured iOS simulator logs > ${uri}`,
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
          invalidateWdaPageSource(udid); // the screen changes outside WDA: drop cached page sources
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
          invalidateWdaPageSource(); // the screen changes outside WDA: drop cached page sources
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
        return qaOk({ erased: target }, `erased simulator ${target} (it is now shut down; qa_ios boot to use it again).`);
      }
    },
  );
}
