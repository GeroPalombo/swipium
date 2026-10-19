// iOS prepare service (hardening P0.3): the full simulator first-run path: pick + boot a
// simulator, install a simulator .app, launch its bundle, verify foreground, and report whether
// structured automation (WDA) is available or it is honestly visual-only. Refuses an .ipa on the
// simulator with the correct explanation. Shared by qa_prepare_ios_target + qa_test_this execute.

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SimctlDriver } from '../drivers/SimctlDriver.js';
import { invalidateWdaPageSource, WdaDriver } from '../drivers/WdaDriver.js';
import {
  checkWda,
  createWdaSession,
  isLoopbackWdaUrl,
  remoteWdaAllowedByUser,
  REMOTE_WDA_ENV,
  WDA_SESSION_CREATE_MS,
  wdaSessionUdidMismatch,
  withWdaCall,
  type WdaStatus,
} from '../lib/wda.js';
import { loadWdaConfig } from '../lib/wdaConfig.js';
import { findOwnSimulatorWda, ownButUnresponsive, wdaDeviceOwnership, type WdaOwnership } from '../lib/wdaDevice.js';
import { appBuildDestination } from '../ios/signing.js';
import * as sim from '../lib/simctl.js';
import { isAbortError } from '../lib/abortScope.js';
import type { Session, SessionStore } from '../session/store.js';
import { noteScreenMutation } from '../snapshot/fresh.js';
import { bundleServing } from '../lib/metroState.js';
import {
  isSimulatorUdid,
  operatorDevicePin,
  otherLiveSessionsOn,
  pinAmbiguousMessage,
  pinFixStep,
  pinMatches,
  pinNoSimulatorMessage,
  simulatorsForPin,
} from '../session/attach.js';

export type WdaMode = 'auto' | 'required' | 'skip';

export interface PrepareIosArgs {
  app?: string; // simulator .app path
  bundleId?: string;
  simulator?: string; // udid or name substring
  launch?: boolean;
  attachWda?: WdaMode;
  mutationConsent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string };
  /** Tool-facing callers only: wait at most this long for a simulator boot. When it is still
   *  booting, the simulator is bound and the result is { ok:true, booting:true } (nothing else
   *  ran). Omitted (background jobs): wait for the full boot. */
  bootWaitMs?: number;
  /** Launch a debug RN/Expo .app (no embedded main.jsbundle) even though Metro is not serving. */
  allowLaunchWithoutMetro?: boolean;
}

export interface PrepareIosResult {
  ok: boolean;
  failureCode?: string;
  error?: string;
  /** Concrete recovery for this failure (else the failure catalog's generic recovery). */
  nextSteps?: string[];
  udid?: string;
  name?: string;
  bundleId?: string;
  installed?: boolean;
  launched?: boolean;
  mode?: 'structured' | 'visual-fallback';
  wda?: { reachable: boolean; url?: string };
  wdaSessionId?: string;
  requiresAttach?: boolean;
  /** WDA answered /status, then hung creating the session (POST /session timed out and
   *  /status stopped answering). What hung, for a WDA_UNREACHABLE verdict; mode is visual-fallback. */
  wdaHung?: string;
  resultText?: string;
  /** Set (with ok:true) when bootWaitMs elapsed before the boot finished; nothing past the boot ran. */
  booting?: boolean;
  bootElapsedMs?: number;
}

export interface PrepareIosCtx {
  onProgress?: (text: string) => void;
  /** A background job's signal: checked after the (uncancellable) boot wait and between the
   *  install, launch and WDA session steps so a cancelled job stops there; it also kills an
   *  in-flight simctl install. */
  signal?: AbortSignal;
}

export async function prepareIos(
  sessions: SessionStore,
  session: Session,
  args: PrepareIosArgs,
  ctx: PrepareIosCtx = {},
): Promise<PrepareIosResult> {
  const progress = (t: string) => ctx.onProgress?.(t);

  if (!(await sim.simctlAvailable())) {
    return {
      ok: false,
      failureCode: 'SIMULATOR_RUNTIME_MISSING',
      error: 'simctl unavailable (macOS + Xcode required for iOS simulators).',
    };
  }

  // .ipa on the simulator is the classic mistake. Refuse with the right explanation.
  if (args.app && /\.ipa$/i.test(args.app)) {
    return {
      ok: false,
      failureCode: 'IPA_NEEDS_REAL_DEVICE',
      error: 'A .ipa cannot be installed on the simulator; public v1 needs a simulator-SDK .app.',
    };
  }

  // ---- pick + boot simulator ----
  progress('selecting simulator');
  const sims = await sim.listSimulators();
  // A requested simulator (explicit arg > the session's own simulator > the operator pin) is never
  // swapped for whatever else is booted: it is booted itself, or the call fails.
  const pin = operatorDevicePin();
  const explicit = args.simulator ?? (isSimulatorUdid(session.device) ? session.device : undefined);
  const wanted = explicit ?? pin;
  // A pin whose exact name several simulators share is ambiguous, never "the first one".
  const pinnedSims = !explicit && pin ? simulatorsForPin(pin, sims) : [];
  if (pinnedSims.length > 1)
    return { ok: false, failureCode: 'MULTIPLE_DEVICES', error: pinAmbiguousMessage(pin!, pinnedSims), nextSteps: [pinFixStep()] };
  // A requested simulator (pin or explicit) matches a UDID or an exact name (ignoring case), never a
  // substring; an exact name several simulators share is ambiguous.
  const explicitSims = explicit && !sims.some((s) => pinMatches(explicit, s.udid)) ? sims.filter((s) => pinMatches(explicit, s.name)) : [];
  if (explicitSims.length > 1)
    return {
      ok: false,
      failureCode: 'MULTIPLE_DEVICES',
      error: `Requested simulator "${explicit}" matches ${explicitSims.length} simulators (${explicitSims.map((s) => `${s.name} ${s.udid}`).join(', ')}); nothing was done. Pass the UDID.`,
    };
  const pick = wanted
    ? sims.find((s) => pinMatches(wanted, s.udid)) || sims.find((s) => pinMatches(wanted, s.name))
    : sims.find((s) => s.state === 'Booted') || sims.find((s) => /iphone/i.test(s.name));
  if (!pick && wanted)
    return {
      ok: false,
      failureCode: 'NO_DEVICE',
      error: explicit
        ? `Requested simulator "${wanted}" was not found among available simulators; no other simulator was used. List them with qa_ios { action:"list" }.`
        : pinNoSimulatorMessage(wanted),
      ...(explicit ? {} : { nextSteps: [pinFixStep()] }),
    };
  if (pick && pin && !pinMatches(pin, pick.udid) && !pinMatches(pin, pick.name))
    return {
      ok: false,
      failureCode: 'DEVICE_PINNED',
      error: `SWIPIUM_DEVICE=${pin} pins this server to that device; simulator "${pick.name}" (${pick.udid}) is a different device, so nothing was done on it.`,
    };
  if (!pick)
    return {
      ok: false,
      failureCode: 'SIMULATOR_RUNTIME_MISSING',
      error: 'No iOS simulator available. Install a runtime or create one in Xcode.',
    };

  // A simulator this process is still booting lists as Booted before bootstatus says it is done:
  // join that boot instead of installing onto a half-booted device.
  let stillBooting: sim.BoundedBootResult | undefined;
  // Only a boot Swipium actually started is an environment change; an already-booted
  // simulator is reused, and the report must not claim Swipium booted it.
  const bootedHere = pick.state !== 'Booted' || sim.bootInFlight(pick.udid);
  if (bootedHere) {
    progress(`booting ${pick.name}`);
    try {
      sessions.milestone(session, 'simulator_boot_start');
      if (args.bootWaitMs !== undefined) {
        const r = await sim.bootWithin(pick.udid, args.bootWaitMs);
        if (!r.booted) stillBooting = r;
      } else {
        await sim.boot(pick.udid);
      }
      if (!stillBooting) sessions.milestone(session, 'simulator_boot_end');
    } catch (e) {
      if (isAbortError(e)) throw e;
      const msg = String(e);
      return {
        ok: false,
        failureCode: /timed out|timeout/i.test(msg) ? 'SIMULATOR_BOOT_TIMEOUT' : 'SIMULATOR_BOOT_FAILED',
        error: `Boot failed: ${msg}`,
      };
    }
  }
  // Another live session on the same simulator fights over the foreground app and the WDA session.
  const sharedWith = otherLiveSessionsOn(sessions.list(), session, pick.udid);
  const sharedNote = sharedWith.length
    ? ` Warning: simulator ${pick.udid} is also bound to session(s) ${sharedWith.join(', ')}; they will compete for the foreground app and WDA.`
    : '';
  if (sharedNote) sessions.addWorkaround(session, sharedNote.trim());
  // bind a SimctlDriver (also while still booting: follow-up polls and calls use the binding)
  const driver = session.driver instanceof SimctlDriver ? session.driver : new SimctlDriver(pick.udid);
  driver.useDevice(pick.udid);
  session.driver = driver;
  session.device = pick.udid;
  if (bootedHere) {
    sessions.addEnvChange(session, `ios boot ${pick.name} (${pick.udid})`);
    sessions.recordMutation(session, {
      tool: 'qa_prepare_ios_target',
      action: 'ios_boot',
      risk: 'low',
      target: { udid: pick.udid, name: pick.name, runtime: pick.runtime },
      consent: { required: false, approved: true },
      status: 'executed',
      ...(stillBooting ? { detail: 'boot started; still booting when the call returned' } : {}),
    });
  }
  sessions.persist(session);
  if (ctx.signal?.aborted) return { ok: false, failureCode: 'CANCELLED', error: 'cancelled', udid: pick.udid, name: pick.name };
  if (stillBooting) {
    return {
      ok: true,
      booting: true,
      bootElapsedMs: stillBooting.elapsedMs,
      udid: pick.udid,
      name: pick.name,
      resultText: `iOS ${pick.name} still booting after ${Math.round(stillBooting.elapsedMs / 1000)} s.`,
    };
  }

  // ---- install .app (if provided) ----
  let bundleId = args.bundleId ?? session.appId ?? undefined;
  let installed = false;
  let launched = false;
  // Checked between steps: a cancelled job never goes on to the next install / launch / WDA step.
  const cancelled = (): PrepareIosResult | undefined =>
    ctx.signal?.aborted
      ? { ok: false, failureCode: 'CANCELLED', error: 'cancelled', udid: pick.udid, name: pick.name, bundleId, installed, launched }
      : undefined;
  let bundleIdNote = '';
  const gateMetro = (args.launch ?? true) && !args.allowLaunchWithoutMetro;
  if (args.app) {
    const appPath = isAbsolute(args.app) ? args.app : join(session.root, args.app);
    if (!existsSync(appPath)) return { ok: false, failureCode: 'IOS_SIMULATOR_APP_MISSING', error: `.app not found: ${appPath}` };
    // Metro gate BEFORE the install: a blocked run must not have changed the simulator.
    const gate = gateMetro ? await metroGate(appPath, session.root) : undefined;
    if (gate) return { ok: false, ...gate, udid: pick.udid, name: pick.name, bundleId, installed: false };
    // A device-SDK (iphoneos) .app cannot run on the simulator. Catch it before the opaque
    // simctl install error so the blocker is IOS_APP_WRONG_ARCH (build a simulator .app).
    if (appBuildDestination(appPath) === 'device') {
      return {
        ok: false,
        failureCode: 'IOS_APP_WRONG_ARCH',
        error: `${appPath} is a device build (iphoneos). The simulator needs a simulator-SDK .app (iphonesimulator). Real-device workflows are outside the public v1 scope.`,
        udid: pick.udid,
        name: pick.name,
      };
    }
    progress('installing .app');
    try {
      sessions.milestone(session, 'app_install_start');
      invalidateWdaPageSource(pick.udid); // screen changes outside WDA
      await sim.installApp(pick.udid, appPath, { signal: ctx.signal });
      sessions.milestone(session, 'app_install_end');
      installed = true;
    } catch (err) {
      // Killed by the job's cancel: not an install failure (no blocked ledger row).
      if (ctx.signal?.aborted || isAbortError(err))
        return { ok: false, failureCode: 'CANCELLED', error: 'cancelled', udid: pick.udid, name: pick.name };
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
    if (fromApp && args.bundleId && args.bundleId !== fromApp) {
      bundleIdNote = ` Note: the .app's bundle id is ${fromApp}; the requested bundleId ${args.bundleId} was ignored.`;
      sessions.addWorkaround(session, bundleIdNote.trim());
    }
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

  // ---- Metro gate for an already-installed app (bundleId only): read its .app from the simulator,
  // or a debug RN build launches straight into the "No script URL provided" RedBox as "ready".
  if (gateMetro && bundleId && !args.app) {
    let container: string | null = null;
    try {
      container = await sim.appContainer(pick.udid, bundleId);
    } catch {
      container = null; // unknown: launch as before
    }
    const gate = container ? await metroGate(container, session.root) : undefined;
    if (gate) return { ok: false, ...gate, udid: pick.udid, name: pick.name, bundleId, installed: false };
  }

  // ---- launch ----
  const beforeLaunch = cancelled();
  if (beforeLaunch) return beforeLaunch;
  if ((args.launch ?? true) && bundleId) {
    progress('launching');
    try {
      sessions.milestone(session, 'app_launch_start');
      invalidateWdaPageSource(pick.udid); // screen changes outside WDA
      await sim.launchApp(pick.udid, bundleId);
      noteScreenMutation(session); // a snapshot from before the launch is no longer fresh
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
      // A timeout (wedged launch service), a shut-down simulator or an installed app that refuses
      // to launch is not BUNDLE_ID_NOT_FOUND; only a confirmed-missing bundle is.
      const why = await sim.classifyIosLaunchFailure(pick.udid, bundleId, err);
      return {
        ok: false,
        failureCode: why.failureCode,
        error: why.what,
        nextSteps: why.nextSteps,
        udid: pick.udid,
        name: pick.name,
        bundleId,
      };
    }
    sessions.recordMutation(session, {
      tool: 'qa_prepare_ios_target',
      action: 'ios_launch',
      risk: 'low',
      target: { udid: pick.udid, bundleId },
      consent: { required: false, approved: true },
      status: 'executed',
    });
  } else if (bundleId && args.bundleId && session.appId !== bundleId) {
    // launch:false with an explicit bundleId still names the app under test: without
    // it the app shows up as a foreign_app overlay and press home can't tell it left.
    session.appId = bundleId;
    sessions.persist(session);
  }

  // ---- WDA readiness (structured vs visual-only) ----
  const beforeWda = cancelled();
  if (beforeWda) return beforeWda;
  const wdaCfg = loadWdaConfig(session.root);
  const configuredWdaUrl = wdaCfg?.url ?? 'http://127.0.0.1:8100';
  // The WDA this session already started / reused / attached FOR THIS simulator (a managed WDA may
  // run on its own per-simulator port), else the configured URL.
  const ownWda = [...(session.mutations ?? [])]
    .reverse()
    .find(
      (r) =>
        (r.tool === 'qa_wda' || r.tool === 'qa_prepare_ios_target') &&
        ['wda_start', 'wda_reuse', 'wda_attach'].includes(r.action) &&
        r.status === 'executed' &&
        typeof r.target?.webDriverAgentUrl === 'string' &&
        String(r.target?.udid ?? '').toUpperCase() === pick.udid.toUpperCase(),
    );
  let wdaUrl = ownWda ? String(ownWda.target!.webDriverAgentUrl) : configuredWdaUrl;
  // A new session starts in mode 'structured' by default (and session.driver was just replaced
  // above), so only this session's own WDA for the simulator counts (otherwise a brand-new
  // session reads as "dropped from structured").
  const wasStructured = !!ownWda;
  const attach: WdaMode = args.attachWda ?? 'auto';
  let wdaHint = '';
  let mode: 'structured' | 'visual-fallback' = 'visual-fallback';
  let wda: { reachable: boolean; url?: string } | undefined;
  let wdaSessionId: string | undefined;
  let requiresAttach = false;
  let wdaHung: string | undefined;
  // WDA hung (session create timed out, or this simulator's own WDA listens but does not
  // answer /status): never a visual-only launch pass. 'required' fails; else blocked + ledger entry.
  const markHung = (hung: string): PrepareIosResult | undefined => {
    if (attach === 'required')
      return {
        ok: false,
        failureCode: 'WDA_UNREACHABLE',
        error: `${hung}. Restart it (qa_wda { action:"stop" }, then qa_wda { action:"setup" } and qa_wda attach), then retry.`,
        udid: pick.udid,
        name: pick.name,
        bundleId,
        installed,
        launched,
        wda,
      };
    wdaHung = hung;
    wda = { reachable: false, url: wdaUrl };
    // Ledger: later visual-only tool calls name this WDA as the cause (lostWdaResult).
    sessions.recordMutation(session, {
      tool: 'qa_prepare_ios_target',
      action: 'wda_attach',
      risk: 'low',
      target: { webDriverAgentUrl: wdaUrl, udid: pick.udid, bundleId: bundleId ?? null },
      consent: { required: false, approved: true },
      status: 'blocked',
      detail: hung,
    });
    wdaHint = ` (${hung}: restart it with qa_wda { action:"stop" }, then qa_wda { action:"setup" } and qa_wda attach)`;
    sessions.addWorkaround(session, `${hung}. iOS verification is NOT possible until WDA is restarted (qa_wda stop, setup, attach)`);
    return undefined;
  };
  // Same rule as qa_wda: a non-loopback WDA URL (e.g. ios.wda.url from the repository's
  // .swipium/config.json) is never contacted automatically: screens and typed text would go to
  // another machine. Only the user's SWIPIUM_ALLOW_REMOTE_WDA pre-approves it; otherwise the
  // consent path is an explicit `qa_wda attach { webDriverAgentUrl, allowNonLoopback:true }`.
  if (attach !== 'skip' && !isLoopbackWdaUrl(wdaUrl) && !remoteWdaAllowedByUser(wdaUrl)) {
    const why =
      `WDA URL ${wdaUrl} is not loopback, refused to connect automatically (set in the repository's .swipium/config.json, unreviewed). ` +
      `Attach it explicitly with qa_wda { action:"attach", webDriverAgentUrl, allowNonLoopback:true } (consent-gated), or set ${REMOTE_WDA_ENV}=<exact url> in the user environment.`;
    if (attach === 'required') {
      return { ok: false, failureCode: 'DESTRUCTIVE_REFUSED', error: why, udid: pick.udid, name: pick.name, bundleId, installed, launched };
    }
    wda = { reachable: false, url: wdaUrl };
    sessions.addWorkaround(session, `${why} iOS verification is visual-only until then`);
  } else if (attach !== 'skip') {
    let status: WdaStatus = await checkWda(wdaUrl, 1500).catch(() => ({ reachable: false, ready: false }));
    // WDA defaults to one port for every simulator: a WDA there may drive ANOTHER simulator.
    // Never create a session on it (that launches the app there and tears down its owner's
    // session); look for this simulator's own WDA on its per-simulator port instead. That lookup
    // also runs when the WDA there is down, too busy to answer in time, or unidentifiable (without it,
    // a new session never found its own WDA on its port when the foreign one missed the probe).
    let foreign: WdaOwnership | undefined;
    const owner = status.reachable ? await wdaDeviceOwnership(wdaUrl, status, pick.udid, async () => pick.runtime) : undefined;
    // unverified (lsof / ps timed out on a loaded host): may be another simulator's WDA on the same
    // runtime, so it is not attached unless it is this session's own WDA for the simulator.
    if (owner?.owner === 'other' || (owner?.owner === 'unverified' && !ownWda)) foreign = owner;
    // This simulator's own WDA that listens but did not answer /status (already hung
    // before prepare): the same hang detection qa_test_this's plan uses.
    const unresponsive: string[] = [];
    if (!status.reachable && (await ownButUnresponsive(wdaUrl, status, pick.udid).catch(() => false)))
      unresponsive.push(wdaUrl.replace(/\/+$/, ''));
    if (owner?.owner !== 'match') {
      const own = await findOwnSimulatorWda(wdaUrl, pick.udid, async () => pick.runtime, unresponsive);
      if (own) {
        wdaUrl = own.url;
        status = own.status;
        foreign = undefined;
      }
    }
    let hungOwn: string | undefined;
    if (!status.reachable && !foreign && unresponsive.length) {
      // One short re-probe: a WDA that was only busy for a moment is attached normally.
      const again = await checkWda(unresponsive[0]!, 1500).catch((): WdaStatus => ({ reachable: false, ready: false }));
      wdaUrl = unresponsive[0]!;
      if (again.reachable) status = again;
      else hungOwn = `this simulator's own WDA at ${wdaUrl} is listening but did not answer /status within 1.5 s (hung)`;
    }
    wda = { reachable: !!status.reachable && !foreign, url: wdaUrl };
    if (foreign) {
      const why = `${foreign.reason}; not attaching to it.`;
      if (attach === 'required') {
        return {
          ok: false,
          failureCode: 'STALE_WDA_DEVICE',
          error: `WDA required, but ${why}`,
          nextSteps: [
            `Run qa_wda { action:"setup", device:"${pick.udid}" } to start a WDA for this simulator on its own port, then retry.`,
          ],
          udid: pick.udid,
          name: pick.name,
          bundleId,
          installed,
          launched,
        };
      }
      wdaHint = ` (${why} Run qa_wda { action:"setup" } to start one for this simulator, then qa_wda attach)`;
      sessions.addWorkaround(session, `${why} iOS verification is visual-only until qa_wda setup + attach`);
    } else if (hungOwn) {
      const failed = markHung(hungOwn);
      if (failed) return failed;
    } else if (status.reachable) {
      const beforeSession = cancelled();
      if (beforeSession) return beforeSession;
      try {
        const sessionOptions = {
          bundleId: bundleId ?? undefined,
          udid: pick.udid,
          capabilities: wdaCfg?.capabilities,
          settings: wdaCfg?.settings,
        };
        // Capped (WDA's default is 60 s); a timeout is checked against /status below.
        const created = await withWdaCall({ timeoutMs: WDA_SESSION_CREATE_MS }, () => createWdaSession(wdaUrl, sessionOptions));
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
        // A session request that timed out while /status stops answering too: WDA itself is hung
        // (it can hang on the splash after a cold simulator boot), not a session / pairing problem.
        const hung =
          /WDA POST \/session timed out/.test(String(e)) && !(await checkWda(wdaUrl, 1500).catch(() => undefined))?.reachable
            ? `WebDriverAgent at ${wdaUrl} hung: it did not create a session within ${WDA_SESSION_CREATE_MS / 1000} s and stopped answering /status`
            : undefined;
        if (hung) {
          const failed = markHung(hung);
          if (failed) return failed;
        } else if (attach === 'required') {
          return {
            ok: false,
            failureCode: 'WDA_SESSION_FAILED',
            error: `WDA is reachable at ${wdaUrl} but session creation failed: ${String(e)}. Confirm WDA is paired with ${pick.name} and the app bundle id is installed, then retry.`,
            udid: pick.udid,
            name: pick.name,
            bundleId,
            installed,
            launched,
            wda,
          };
        }
        if (!hung) {
          requiresAttach = true;
          sessions.addWorkaround(
            session,
            `WDA reachable but session attach failed (${String(e)}). iOS verification is visual-only until qa_wda attach succeeds`,
          );
        }
      }
    } else if (attach === 'required') {
      return {
        ok: false,
        failureCode: 'WDA_UNREACHABLE',
        error: `WDA required but unreachable at ${wdaUrl}. Start WebDriverAgent (qa_wda) then retry.`,
        udid: pick.udid,
        name: pick.name,
        bundleId,
        installed,
        launched,
      };
    } else {
      // A session that was structured (e.g. its managed WDA died with a simulator shutdown)
      // must not drop to visual-only silently.
      wdaHint = wasStructured
        ? ` (WebDriverAgent is no longer reachable at ${wdaUrl}, so this session dropped from structured to visual-only: run qa_wda { action:"setup" }, then qa_wda attach)`
        : ` (no WebDriverAgent at ${wdaUrl}: run qa_wda { action:"setup" }, then qa_wda attach, for structured automation)`;
      sessions.addWorkaround(session, 'WDA not reachable: iOS verification is visual-only (screenshots), not structured');
    }
  }
  session.mode = mode === 'structured' ? 'structured' : 'visual-fallback';
  sessions.persist(session);

  const nextHint = requiresAttach ? ' (WDA reachable, run qa_wda attach to enable structured snapshot and action tools)' : wdaHint;
  return {
    ok: true,
    udid: pick.udid,
    name: pick.name,
    bundleId,
    installed,
    launched,
    mode,
    wda,
    wdaSessionId,
    requiresAttach,
    ...(wdaHung ? { wdaHung } : {}),
    resultText: `${launched ? 'ready' : 'launched=false'} iOS ${pick.name}${bundleId ? ` / ${bundleId}` : ''}: ${mode === 'structured' ? 'WDA structured' : 'visual-only'}${installed ? ' (installed)' : ''}${nextHint}.${bundleIdNote}${sharedNote}`,
  };
}

/** Metro gate (same rule as Android's prepare): a debug RN/Expo .app with no embedded JS bundle
 *  needs THIS project's Metro serving. Another project's Metro on the port is METRO_WRONG_PROJECT
 *  (qa_metro start would refuse it too), anything else not serving is METRO_REQUIRED. */
async function metroGate(
  appPath: string,
  root: string,
): Promise<{ failureCode: 'METRO_REQUIRED' | 'METRO_WRONG_PROJECT'; error: string; nextSteps?: string[] } | undefined> {
  if (!rnDebugAppWithoutBundle(appPath)) return undefined;
  const srv = await bundleServing(undefined, root);
  if (srv.serving) return undefined;
  const what = `Debug RN/Expo build (${appPath} has no embedded main.jsbundle)`;
  if (srv.wrongProject)
    return {
      failureCode: 'METRO_WRONG_PROJECT',
      error: `${what}; ${srv.detail}. Launching now would load the wrong JS bundle.`,
      nextSteps: [
        `Stop the other project's Metro (${srv.metroProjectRoot ?? 'unknown root'}); Swipium did not start it, so it will not stop it for you.`,
        "Then start this project's Metro, wait until it is serving, and retry.",
      ],
    };
  return {
    failureCode: 'METRO_REQUIRED',
    error: `${what}; Metro is not serving (${srv.detail}). Launching now would show the "No script URL provided" RedBox. Start Metro for this project (qa_metro { action:"start" } or \`npx expo start\`), wait until it is serving, then retry.`,
  };
}

/** A React Native / Expo simulator .app that fetches its JS from Metro at launch: it ships the RN
 *  runtime (React/Hermes frameworks, RN or Expo resource bundles) but no embedded main.jsbundle.
 *  Release builds embed main.jsbundle and are never gated. */
export function rnDebugAppWithoutBundle(appPath: string): boolean {
  if (existsSync(join(appPath, 'main.jsbundle'))) return false;
  const markers = [
    'Frameworks/React.framework',
    'Frameworks/hermes.framework',
    'Frameworks/React_RCTAppDelegate.framework',
    'Frameworks/ReactNativeDependencies.framework',
    'RCTI18nStrings.bundle',
    'EXConstants.bundle',
    'Expo.plist',
    'EXDevLauncher.bundle',
  ];
  return markers.some((m) => existsSync(join(appPath, m)));
}
