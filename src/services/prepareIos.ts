// iOS prepare service (hardening P0.3) — the full simulator first-run path: pick + boot a
// simulator, install a simulator .app, launch its bundle, verify foreground, and report whether
// structured automation (WDA) is available or it is honestly visual-only. Refuses an .ipa on the
// simulator with the correct explanation. Shared by qa_prepare_ios_target + qa_test_this execute.

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SimctlDriver } from '../drivers/SimctlDriver.js';
import { WdaDriver } from '../drivers/WdaDriver.js';
import { checkWda, createWdaSession, wdaSessionUdidMismatch } from '../lib/wda.js';
import { loadWdaConfig } from '../lib/wdaConfig.js';
import { appBuildDestination } from '../ios/signing.js';
import * as sim from '../lib/simctl.js';
import type { Session, SessionStore } from '../session/store.js';

export type WdaMode = 'auto' | 'required' | 'skip';

export interface PrepareIosArgs {
  app?: string; // simulator .app path
  bundleId?: string;
  simulator?: string; // udid or name substring
  launch?: boolean;
  attachWda?: WdaMode;
  mutationConsent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string };
}

export interface PrepareIosResult {
  ok: boolean;
  failureCode?: string;
  error?: string;
  udid?: string;
  name?: string;
  bundleId?: string;
  installed?: boolean;
  launched?: boolean;
  mode?: 'structured' | 'visual-fallback';
  wda?: { reachable: boolean; url?: string };
  wdaSessionId?: string;
  requiresAttach?: boolean;
  resultText?: string;
}

export interface PrepareIosCtx {
  onProgress?: (text: string) => void;
}

export async function prepareIos(sessions: SessionStore, session: Session, args: PrepareIosArgs, ctx: PrepareIosCtx = {}): Promise<PrepareIosResult> {
  const progress = (t: string) => ctx.onProgress?.(t);

  if (!(await sim.simctlAvailable())) {
    return { ok: false, failureCode: 'SIMULATOR_RUNTIME_MISSING', error: 'simctl unavailable (macOS + Xcode required for iOS simulators).' };
  }

  // .ipa on the simulator is the classic mistake — refuse with the right explanation.
  if (args.app && /\.ipa$/i.test(args.app)) {
    return { ok: false, failureCode: 'IPA_NEEDS_REAL_DEVICE', error: 'A .ipa cannot be installed on the simulator; public v1 needs a simulator-SDK .app.' };
  }

  // ---- pick + boot simulator ----
  progress('selecting simulator');
  const sims = await sim.listSimulators();
  const pick =
    (args.simulator && sims.find((s) => s.udid === args.simulator || s.name.toLowerCase().includes(args.simulator!.toLowerCase()))) ||
    sims.find((s) => s.state === 'Booted') ||
    sims.find((s) => /iphone/i.test(s.name));
  if (!pick) return { ok: false, failureCode: 'SIMULATOR_RUNTIME_MISSING', error: 'No iOS simulator available — install a runtime / create one in Xcode.' };

  if (pick.state !== 'Booted') {
    progress(`booting ${pick.name}`);
    try {
      sessions.milestone(session, 'simulator_boot_start');
      await sim.boot(pick.udid);
      sessions.milestone(session, 'simulator_boot_end');
    } catch (e) {
      const msg = String(e);
      return { ok: false, failureCode: /timed out|timeout/i.test(msg) ? 'SIMULATOR_BOOT_TIMEOUT' : 'SIMULATOR_BOOT_FAILED', error: `Boot failed: ${msg}` };
    }
  }
  // bind a SimctlDriver
  const driver = session.driver instanceof SimctlDriver ? session.driver : new SimctlDriver(pick.udid);
  driver.useDevice(pick.udid);
  session.driver = driver;
  session.device = pick.udid;
  sessions.addEnvChange(session, `ios boot ${pick.name} (${pick.udid})`);
  sessions.recordMutation(session, {
    tool: 'qa_prepare_ios_target',
    action: 'ios_boot',
    risk: 'low',
    target: { udid: pick.udid, name: pick.name, runtime: pick.runtime },
    consent: { required: false, approved: true },
    status: 'executed',
  });
  sessions.persist(session);

  // ---- install .app (if provided) ----
  let bundleId = args.bundleId ?? session.appId ?? undefined;
  let installed = false;
  if (args.app) {
    const appPath = isAbsolute(args.app) ? args.app : join(session.root, args.app);
    if (!existsSync(appPath)) return { ok: false, failureCode: 'IOS_SIMULATOR_APP_MISSING', error: `.app not found: ${appPath}` };
    // A device-SDK (iphoneos) .app cannot run on the simulator — catch it before the opaque
    // simctl install error so the blocker is IOS_APP_WRONG_ARCH (build a simulator .app).
    if (appBuildDestination(appPath) === 'device') {
      return { ok: false, failureCode: 'IOS_APP_WRONG_ARCH', error: `${appPath} is a device build (iphoneos) — the simulator needs a simulator-SDK .app (iphonesimulator). Real-device workflows are outside the public v1 scope.`, udid: pick.udid, name: pick.name };
    }
    progress('installing .app');
    try {
      sessions.milestone(session, 'app_install_start');
      await sim.installApp(pick.udid, appPath);
      sessions.milestone(session, 'app_install_end');
      installed = true;
    } catch (err) {
      const failureCode = sim.classifyIosInstallFailure(String(err));
      sessions.recordMutation(session, {
        tool: 'qa_prepare_ios_target',
        action: 'install_app',
        risk: args.mutationConsent?.required ? 'medium' : 'low',
        target: { udid: pick.udid, appPath },
        consent: args.mutationConsent ?? { required: false, approved: true },
        status: 'blocked',
        detail: `${failureCode}: ${String(err)}`,
      });
      return { ok: false, failureCode, error: `Install failed: ${String(err)}`, udid: pick.udid, name: pick.name };
    }
    const fromApp = await sim.bundleIdFromApp(appPath);
    if (fromApp) {
      bundleId = fromApp;
      session.appId = fromApp;
    }
    sessions.addEnvChange(session, `ios install ${appPath}`);
    sessions.recordMutation(session, {
      tool: 'qa_prepare_ios_target',
      action: 'install_app',
      risk: args.mutationConsent?.required ? 'medium' : 'low',
      target: { udid: pick.udid, appPath, bundleId: fromApp ?? null },
      consent: args.mutationConsent ?? { required: false, approved: true },
      status: 'executed',
    });
  }

  // ---- launch ----
  let launched = false;
  if ((args.launch ?? true) && bundleId) {
    progress('launching');
    try {
      sessions.milestone(session, 'app_launch_start');
      await sim.launchApp(pick.udid, bundleId);
      sessions.milestone(session, 'app_launch_end');
      launched = true;
      session.appId = bundleId;
      sessions.persist(session);
    } catch (err) {
      sessions.recordMutation(session, {
        tool: 'qa_prepare_ios_target',
        action: 'ios_launch',
        risk: 'low',
        target: { udid: pick.udid, bundleId },
        consent: { required: false, approved: true },
        status: 'blocked',
        detail: String(err),
      });
      return { ok: false, failureCode: 'BUNDLE_ID_NOT_FOUND', error: `Launch failed: ${String(err)}`, udid: pick.udid, name: pick.name, bundleId };
    }
    sessions.recordMutation(session, {
      tool: 'qa_prepare_ios_target',
      action: 'ios_launch',
      risk: 'low',
      target: { udid: pick.udid, bundleId },
      consent: { required: false, approved: true },
      status: 'executed',
    });
  }

  // ---- WDA readiness (structured vs visual-only) ----
  const wdaCfg = loadWdaConfig(session.root);
  const wdaUrl = wdaCfg?.url ?? 'http://127.0.0.1:8100';
  const attach: WdaMode = args.attachWda ?? 'auto';
  let mode: 'structured' | 'visual-fallback' = 'visual-fallback';
  let wda: { reachable: boolean; url?: string } | undefined;
  let wdaSessionId: string | undefined;
  let requiresAttach = false;
  if (attach !== 'skip') {
    const status = await checkWda(wdaUrl, 1500).catch(() => ({ reachable: false }));
    wda = { reachable: !!status.reachable, url: wdaUrl };
    if (status.reachable) {
      try {
        const sessionOptions = { bundleId: bundleId ?? undefined, udid: pick.udid, capabilities: wdaCfg?.capabilities, settings: wdaCfg?.settings };
        const created = await createWdaSession(wdaUrl, sessionOptions);
        const mismatched = wdaSessionUdidMismatch(created.capabilities, pick.udid);
        if (mismatched) throw new Error(`WDA reported device ${mismatched}, but this session targets ${pick.udid}.`);
        session.driver = new WdaDriver(wdaUrl, { ...sessionOptions, sessionId: created.sessionId });
        session.device = pick.udid;
        sessions.addEnvChange(session, `wda attach ${wdaUrl} ${pick.udid}`);
        sessions.recordMutation(session, {
          tool: 'qa_prepare_ios_target',
          action: 'wda_attach',
          risk: 'low',
          target: { webDriverAgentUrl: wdaUrl, udid: pick.udid, bundleId: bundleId ?? null, wdaSessionId: created.sessionId },
          consent: { required: false, approved: true },
          status: 'executed',
        });
        mode = 'structured';
        wdaSessionId = created.sessionId;
      } catch (e) {
        if (attach === 'required') {
          return { ok: false, failureCode: 'WDA_SESSION_FAILED', error: `WDA is reachable at ${wdaUrl} but session creation failed: ${String(e)}. Confirm WDA is paired with ${pick.name} and the app bundle id is installed, then retry.`, udid: pick.udid, name: pick.name, bundleId, installed, launched, wda };
        }
        requiresAttach = true;
        sessions.addWorkaround(session, `WDA reachable but session attach failed (${String(e)}). iOS verification is visual-only until qa_wda attach succeeds`);
      }
    } else if (attach === 'required') {
      return { ok: false, failureCode: 'WDA_UNREACHABLE', error: `WDA required but unreachable at ${wdaUrl}. Start WebDriverAgent (qa_wda) then retry.`, udid: pick.udid, name: pick.name, bundleId, installed, launched };
    } else {
      sessions.addWorkaround(session, 'WDA not reachable — iOS verification is visual-only (screenshots), not structured');
    }
  }
  session.mode = mode === 'structured' ? 'structured' : 'visual-fallback';
  sessions.persist(session);

  const nextHint = requiresAttach ? ' (WDA reachable, run qa_wda attach to enable structured snapshot and action tools)' : '';
  return {
    ok: true, udid: pick.udid, name: pick.name, bundleId, installed, launched, mode, wda, wdaSessionId, requiresAttach,
    resultText: `${launched ? 'ready' : 'launched=false'} iOS ${pick.name}${bundleId ? ` / ${bundleId}` : ''}: ${mode === 'structured' ? 'WDA structured' : 'visual-only'}${installed ? ' (installed)' : ''}${nextHint}.`,
  };
}
