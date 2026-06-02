// qa_app_control — app lifecycle so agents don't shell out to `adb` (Phase 2 CR1/CR3).
// force_stop / restart / background / foreground / launch (non-destructive) and
// clear_data / fresh_start (destructive → consent). Reports package, foreground, killed.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { getDriver } from '../session/attach.js';
import { detectFramework } from '../context/detect.js';
import { metroReadiness } from '../lib/metroState.js';
import type { Session, SessionStore } from '../session/store.js';
import type { Driver } from '../drivers/Driver.js';

const ACTIONS = ['launch', 'foreground', 'background', 'force_stop', 'restart', 'clear_data', 'fresh_start'] as const;
const DESTRUCTIVE = new Set(['clear_data', 'fresh_start']);

async function relaunchAndVerify(d: Driver, pkg: string): Promise<string> {
  await d.launchApp(pkg);
  await new Promise((r) => setTimeout(r, 2500));
  return d.foregroundOwner();
}

export function registerAppControl(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_app_control',
    {
      title: 'App lifecycle control',
      description:
        'Control the app under test without raw adb. Actions: launch, foreground (relaunch), background (Home), force_stop (kill + verify), restart (force_stop+launch), clear_data (wipe data/cache/permissions — DESTRUCTIVE, consent), fresh_start (clear_data then launch — DESTRUCTIVE, consent). Use restart for "save → kill → relaunch → verify persistence". Returns package, foreground, and whether the process was killed.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(ACTIONS),
        acknowledgeBundleRisk: z.boolean().optional().describe('Proceed with clear_data/fresh_start on an RN/Expo build even though wiping may make a bundle-less debug build unloadable.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, acknowledgeBundleRisk, consentId, approve }) => {
      const session = sessions.get(sessionId);
      const { driver: d } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !d) {
        return qaError({ what: 'No device attached', changedState: false, retrySafe: true, nextSteps: ['Call qa_prepare_target first.'] });
      }
      const pkg = session.appId;
      if (!pkg) {
        return qaError({ what: 'No appId on this session', changedState: false, retrySafe: true, nextSteps: ['Call qa_prepare_target (it sets the appId).'] });
      }

      // Destructive-wipe BUNDLE-RISK PREFLIGHT (Phase 2.1 follow-up): a `pm clear` on an RN/Expo
      // *debug* build wipes the cached JS bundle. Even with Metro serving, a bundle-less /
      // asset-only debug APK won't refetch and comes back on an "Unable to load script" RedBox —
      // i.e. a data wipe can BRICK the build. This is a DISTINCT risk from generic data loss:
      // approving "wipe app data" is not approving "make my debug build unloadable". So for
      // RN/Expo we refuse by DEFAULT (regardless of Metro state) and require an explicit
      // acknowledgeBundleRisk:true IN ADDITION to the destructive consent below. Metro readiness
      // is reported as evidence (it lowers but does not eliminate the risk).
      if (DESTRUCTIVE.has(action)) {
        const fw = detectFramework(session.root);
        const isRn = fw === 'expo' || fw === 'bare-react-native';
        if (isRn) {
          const rd = await metroReadiness(session.device);
          if (!acknowledgeBundleRisk) {
            sessions.addEnvChange(session, `GUARDRAIL bundle-risk: ${action} REFUSED (acknowledgeBundleRisk required; framework=${fw}, metroServing=${rd.serving})`);
            sessions.recordMutation(session, {
              tool: 'qa_app_control',
              action: `app_${action}`,
              risk: 'high',
              target: { package: pkg, framework: fw, metroServing: rd.serving, bundleCacheRisk: true },
              consent: { required: true, approved: false },
              status: 'refused',
              detail: 'acknowledgeBundleRisk required before destructive wipe on RN/Expo',
            });
            return qaError(
              {
                what: `Refusing ${action}: ${fw} is an RN/Expo build, so a data wipe carries a bundle-cache-loss risk SEPARATE from the generic data loss. pm clear removes the cached JS bundle / dev-client state; a bundle-less or asset-only debug APK then comes back on an "Unable to load script" RedBox and cannot recover (Metro serving=${rd.serving} lowers but does not eliminate this — asset-only debug builds brick even with Metro up).`,
                changedState: false,
                retrySafe: true,
                nextSteps: [
                  'Run NON-DESTRUCTIVE workflows first; sequence destructive ones LAST for debug builds.',
                  'Use a RELEASE/staging APK with an embedded JS bundle for clean-state tests.',
                  'Confirm Metro is serving (qa_metro action="diagnose") and rebuild/reinstall if the bundle is stale.',
                  'If you understand the risk and want to proceed anyway, pass acknowledgeBundleRisk:true (required IN ADDITION to the destructive consent).',
                ],
              },
              {
                risk: 'bundle_cache_loss',
                reason: 'clear_data may remove cached JS / dev-server state, bricking a bundle-less debug build',
                evidence: { framework: fw, debugBuildAssumed: true, metro: rd },
              },
            );
          }
          // Override present: record it as a distinct guardrail override (honest reporting).
          sessions.addEnvChange(session, `OVERRIDE acknowledgeBundleRisk: ${action} on RN/Expo (${fw}) — bundle-cache-loss risk accepted (metroServing=${rd.serving})`);
        }
      }

      // Destructive actions are consent-gated with the exact package + data-loss warning.
      if (DESTRUCTIVE.has(action)) {
        const gate = consumeConsent(consentId, approve, { action: `app_${action}`, affects: { package: pkg } });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_app_control',
            action: `app_${action}`,
            risk: 'high',
            target: { package: pkg },
            consent: { required: true, approved: false },
            status: 'requested',
          });
          const exactCommand =
            action === 'fresh_start'
              ? `adb shell am force-stop ${pkg} && adb shell pm clear ${pkg} && adb shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`
              : `adb shell pm clear ${pkg}`;
          return requireConsent({
            action: `app_${action}`,
            risk: 'high',
            exactCommand,
            affects: { package: pkg },
            explain: `${action} WIPES all app data/cache and resets permissions for ${pkg} (you will be logged out). Proceed?`,
          });
        }
        sessions.recordMutation(session, {
          tool: 'qa_app_control',
          action: `app_${action}`,
          risk: 'high',
          target: { package: pkg },
          consent: { required: true, consentId, approved: true },
          status: 'approved',
        });
      }

      const before = await d.foregroundOwner().catch(() => 'unknown');
      let processKilled: boolean | undefined;
      let foreground = before;

      try {
        switch (action) {
          case 'launch':
          case 'foreground':
            foreground = await relaunchAndVerify(d, pkg);
            break;
          case 'background':
            await d.pressKey('home');
            await new Promise((r) => setTimeout(r, 800));
            foreground = await d.foregroundOwner();
            break;
          case 'force_stop':
            await d.terminateApp(pkg);
            processKilled = !(await d.isRunning(pkg));
            foreground = await d.foregroundOwner();
            break;
          case 'restart':
            await d.terminateApp(pkg);
            processKilled = !(await d.isRunning(pkg));
            foreground = await relaunchAndVerify(d, pkg);
            break;
          case 'clear_data':
            await d.clearData(pkg);
            sessions.addEnvChange(session, `clear_data ${pkg} (data/cache/permissions wiped)`);
            foreground = await d.foregroundOwner();
            break;
          case 'fresh_start':
            await d.terminateApp(pkg);
            await d.clearData(pkg);
            sessions.addEnvChange(session, `fresh_start ${pkg} (wiped + relaunched)`);
            session.lastSnapshot = undefined; // state reset → refs invalid
            foreground = await relaunchAndVerify(d, pkg);
            break;
        }
      } catch (e) {
        sessions.recordMutation(session, {
          tool: 'qa_app_control',
          action: `app_${action}`,
          risk: DESTRUCTIVE.has(action) ? 'high' : 'low',
          target: { package: pkg },
          consent: DESTRUCTIVE.has(action) ? { required: true, consentId, approved: true } : { required: false, approved: true },
          status: 'blocked',
          detail: String(e),
        });
        return qaError({ what: `app_control "${action}" failed: ${String(e)}`, changedState: true, retrySafe: true, nextSteps: ['Confirm the device is online (qa_doctor).'] });
      }

      const launchedOk = foreground.startsWith(pkg);
      sessions.recordMutation(session, {
        tool: 'qa_app_control',
        action: `app_${action}`,
        risk: DESTRUCTIVE.has(action) ? 'high' : 'low',
        target: { package: pkg, beforeForeground: before, foreground, processKilled },
        consent: DESTRUCTIVE.has(action) ? { required: true, consentId, approved: true } : { required: false, approved: true },
        status: 'executed',
      });
      return qaOk(
        { packageName: pkg, action, processKilled, foreground, foregroundIsApp: launchedOk },
        `${action} on ${pkg} → foreground=${foreground}${processKilled !== undefined ? ` processKilled=${processKilled}` : ''}`,
      );
    },
  );
}
