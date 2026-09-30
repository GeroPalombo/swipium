// qa_app_control — app lifecycle so agents don't shell out to `adb` (Phase 2 CR1/CR3).
// force_stop / restart / background / foreground / launch (non-destructive) and
// clear_data / fresh_start (destructive → consent). Reports package, foreground, killed.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, invalidArgumentError, isInvalidArgumentError, unknownSessionError, cancelledResult } from '../lib/result.js';
import { isAbortError } from '../lib/abortScope.js';
import { assertAndroidAppId } from '../drivers/DirectDriver.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import { detectFramework } from '../context/detect.js';
import { metroReadiness } from '../lib/metroState.js';
import type { SessionStore } from '../session/store.js';
import type { Driver } from '../drivers/Driver.js';

const ACTIONS = ['launch', 'foreground', 'background', 'force_stop', 'restart', 'clear_data', 'fresh_start'] as const;
const DESTRUCTIVE = new Set(['clear_data', 'fresh_start']);
const APP_ID_NEXT_STEP = 'Re-run qa_prepare_target with a valid appId (e.g. com.example.app).';

async function relaunchAndVerify(d: Driver, pkg: string, onLaunched: () => void = () => {}): Promise<string> {
  await d.launchApp(pkg);
  onLaunched();
  await new Promise((r) => setTimeout(r, 2500));
  return d.foregroundOwner();
}

export function registerAppControl(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_app_control',
    {
      title: 'App lifecycle control',
      description:
        'Control the app under test: launch, foreground, background, force_stop, restart (force_stop + launch — for persistence ' +
        'checks), clear_data and fresh_start (wipe data; destructive, consent-gated; RN/Expo builds also need ' +
        'acknowledgeBundleRisk).',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(ACTIONS),
        acknowledgeBundleRisk: z
          .boolean()
          .optional()
          .describe('Accept that wiping an RN/Expo debug build may leave it unable to load its bundle.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, acknowledgeBundleRisk, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver: d, blocked } = await getDriver(session);
      if (!session || !d) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE',
            nextSteps: ['Call qa_prepare_target first.'],
          })
        );
      }
      const pkg = session.appId;
      if (!pkg) {
        return qaError({
          what: 'No appId on this session — nothing was run',
          changedState: false,
          retrySafe: true,
          failureCode: 'INVALID_ARGUMENT',
          nextSteps: ['Call qa_prepare_target (it sets the appId).'],
        });
      }
      // Reject a malformed Android app id up front (typed, before any consent/device work).
      if (d.kind === 'direct') {
        try {
          assertAndroidAppId(pkg);
        } catch (e) {
          if (isInvalidArgumentError(e)) return invalidArgumentError(e, [APP_ID_NEXT_STEP]);
          throw e;
        }
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
            sessions.addEnvChange(
              session,
              `GUARDRAIL bundle-risk: ${action} REFUSED (acknowledgeBundleRisk required; framework=${fw}, metroServing=${rd.serving})`,
            );
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
                failureCode: 'BUNDLE_LOSS_REFUSED', // deliberate guardrail (unsafe_refused) — not a tool error
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
          sessions.addEnvChange(
            session,
            `OVERRIDE acknowledgeBundleRisk: ${action} on RN/Expo (${fw}) — bundle-cache-loss risk accepted (metroServing=${rd.serving})`,
          );
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

      // changedState on failure reflects what actually ran: a driver call that failed before any
      // mutation (e.g. WDA homescreen 404 on `background`) changed nothing.
      let mutated = false;
      const mark = () => {
        mutated = true;
      };
      try {
        switch (action) {
          case 'launch':
          case 'foreground':
            foreground = await relaunchAndVerify(d, pkg, mark);
            break;
          case 'background':
            await d.pressKey('home');
            mark();
            // The home transition takes a moment (iOS reported the app as foreground 800 ms after
            // the press): poll until the foreground actually changes, bounded at ~3 s.
            foreground = pkg;
            for (let waited = 0; waited < 3000 && foreground.startsWith(pkg); waited += 300) {
              await new Promise((r) => setTimeout(r, 300));
              foreground = await d.foregroundOwner().catch(() => 'unknown');
            }
            break;
          case 'force_stop':
            await d.terminateApp(pkg);
            mark();
            processKilled = !(await d.isRunning(pkg));
            foreground = await d.foregroundOwner();
            break;
          case 'restart':
            await d.terminateApp(pkg);
            mark();
            processKilled = !(await d.isRunning(pkg));
            foreground = await relaunchAndVerify(d, pkg);
            break;
          case 'clear_data':
            await d.clearData(pkg);
            mark();
            sessions.addEnvChange(session, `clear_data ${pkg} (data/cache/permissions wiped)`);
            foreground = await d.foregroundOwner();
            break;
          case 'fresh_start':
            await d.terminateApp(pkg);
            mark();
            await d.clearData(pkg);
            sessions.addEnvChange(session, `fresh_start ${pkg} (wiped + relaunched)`);
            session.lastSnapshot = undefined; // state reset → refs invalid
            foreground = await relaunchAndVerify(d, pkg);
            break;
        }
      } catch (e) {
        const invalid = isInvalidArgumentError(e);
        const cancelled = isAbortError(e);
        sessions.recordMutation(session, {
          tool: 'qa_app_control',
          action: `app_${action}`,
          risk: DESTRUCTIVE.has(action) ? 'high' : 'low',
          target: { package: pkg },
          consent: DESTRUCTIVE.has(action) ? { required: true, consentId, approved: true } : { required: false, approved: true },
          status: 'blocked',
          detail: String(e),
        });
        if (invalid) return invalidArgumentError(e, [APP_ID_NEXT_STEP]);
        if (cancelled) return cancelledResult(`app_control "${action}" cancelled before it finished`, mutated);
        return qaError({
          what: `app_control "${action}" failed: ${String(e)}`,
          changedState: mutated,
          retrySafe: true,
          nextSteps: ['Confirm the device is online (qa_doctor).'],
        });
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
        { packageName: pkg, action, changedState: true, processKilled, foreground, foregroundIsApp: launchedOk },
        `${action} on ${pkg} → foreground=${foreground}${processKilled !== undefined ? ` processKilled=${processKilled}` : ''}`,
      );
    },
  );
}
